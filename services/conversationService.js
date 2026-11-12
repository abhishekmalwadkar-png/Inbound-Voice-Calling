'use strict';

/**
 * Conversation engine for the CCD inbound voice bot. Shared by the Twilio
 * webhook routes and the workflow REST routes so both produce identical
 * behaviour, audit records and TwiML.
 */

const { settings } = require('../utils/requestContext');
const db = require('./databaseService');
const sessions = require('./sessionManager');
const rb = require('./responseBuilder');
const tw = require('../utils/twilioHelper');
const sp = require('../utils/speech');
const f = require('../utils/formatters');

const { STAGES } = sessions;
const { INTENTS } = sp;

/** Gather / Dial callback URLs; each can be overridden per request. */
const ROUTES = {
  get menu() {
    return settings().menuActionUrl;
  },
  get verify() {
    return settings().verifyActionUrl;
  },
  get dialStatus() {
    return settings().dialStatusUrl;
  },
};

const ESCALATION_REASONS = Object.freeze({
  CUSTOMER_REQUEST: 'CUSTOMER_REQUEST',
  RESCHEDULE_REQUEST: 'RESCHEDULE_REQUEST',
  VERIFICATION_FAILURE: '2X_VERIFICATION_FAILURE',
  LOW_CONFIDENCE: 'LOW_CONFIDENCE_OR_OUT_OF_SCOPE',
  NO_INPUT: 'NO_INPUT_TWICE',
  SYSTEM_ERROR: 'SYSTEM_ERROR',
});

const VERIFIED_METHODS = new Set(['ANI', 'ANI_MULTI', 'CONSIGNMENT', 'DOB']);

const PROMPTS = Object.freeze({
  menu:
    'You can ask for current status, expected delivery date, past attempt history, or press 9 to speak with an agent. ' +
    'You can also press 1 for status, 2 for delivery date, 3 for attempt history, or 4 for documents required at delivery.',
  verify:
    'Please enter or speak your consignment tracking number, or your 8-digit date of birth in day, month, year format, followed by the hash key.',
  followUp: 'Is there anything else I can help you with today? You can ask another question, or say no, or press 0, to end the call.',
  transfer: 'Transferring your call to a customer care representative. Please stay on the line.',
  goodbye: 'Thank you for calling CCD Delivery Helpline. Have a great day. Goodbye.',
  agentBusy: 'All agents are currently busy. A representative will contact you shortly. Thank you for calling CCD. Goodbye.',
  verifyFailed: 'We are sorry, but we were unable to verify your details for security reasons.',
  verifyRetry: 'Sorry, we could not match those details with our records. Please try again.',
  verified: 'Thank you, your details have been verified.',
  notUnderstood: 'Sorry, I did not quite understand that.',
  noInput: 'Sorry, I did not hear anything.',
  stillThere: 'Are you still there?',
  systemError: 'We are sorry, we are having trouble retrieving your delivery details right now.',
  unknownCaller: 'Welcome to CCD Delivery Helpline. We could not find a delivery linked to the number you are calling from.',
});

// -----------------------------------------------------------------------------
// Audit helpers (never allowed to break the call flow)
// -----------------------------------------------------------------------------

async function audit(callSid, fields) {
  try {
    await db.upsertCallAudit(callSid, fields);
  } catch (err) {
    console.error(`[audit] Failed to write audit for ${callSid}: ${err.message}`);
  }
}

async function event(callSid, type, detail) {
  try {
    await db.logCallEvent(callSid, type, detail);
  } catch (err) {
    console.error(`[audit] Failed to log event ${type} for ${callSid}: ${err.message}`);
  }
}

// -----------------------------------------------------------------------------
// Prompt helpers
// -----------------------------------------------------------------------------

function menuGather(prefix = []) {
  return tw.gather({ prompts: [...prefix, PROMPTS.menu], action: ROUTES.menu, numDigits: 1 });
}

function followUpGather(prefix = []) {
  return tw.gather({ prompts: [...prefix, PROMPTS.followUp], action: ROUTES.menu, numDigits: 1 });
}

function verifyGather(prefix = []) {
  return tw.gather({
    prompts: [...prefix, PROMPTS.verify],
    action: ROUTES.verify,
    finishOnKey: '#',
    timeout: settings().verifyTimeoutSeconds,
    hints: 'C C D, consignment number, date of birth, January, February, March, April, May, June, July, August, September, October, November, December',
  });
}

function disambiguationGather(candidates, prefix = []) {
  return tw.gather({ prompts: [...prefix, rb.disambiguationMenu(candidates)], action: ROUTES.menu, numDigits: 1 });
}

/** Re-asks whatever the caller was last asked. */
function stagePrompt(session, prefix = []) {
  switch (session.stage) {
    case STAGES.VERIFY:
      return verifyGather(prefix);
    case STAGES.DISAMBIGUATE:
      return disambiguationGather(session.candidates, prefix);
    case STAGES.FOLLOW_UP:
      return followUpGather(prefix);
    case STAGES.MAIN_MENU:
    default:
      return menuGather(prefix);
  }
}

// -----------------------------------------------------------------------------
// State transitions
// -----------------------------------------------------------------------------

function resetCounters(session) {
  session.unclearCount = 0;
  session.silenceCount = 0;
}

async function selectConsignment(session, consignment, validationMethod) {
  session.consignment = consignment;
  session.candidates = [];
  session.validationMethod = validationMethod;
  session.stage = STAGES.MAIN_MENU;
  resetCounters(session);
  await audit(session.callSid, {
    callerPhone: session.callerPhone,
    consignmentId: consignment.consignment_id,
    validationMethod,
    disposition: 'IN_PROGRESS',
  });
  await event(session.callSid, 'VALIDATED', { method: validationMethod, consignmentId: consignment.consignment_id });
}

async function enterDisambiguation(session, candidates, validationMethod) {
  session.stage = STAGES.DISAMBIGUATE;
  session.candidates = candidates.slice(0, 8);
  session.pendingValidationMethod = validationMethod;
  resetCounters(session);
  await event(session.callSid, 'DISAMBIGUATION_OFFERED', {
    options: session.candidates.map((c) => c.consignment_id),
    method: validationMethod,
  });
}

async function transfer(session, reason, prefix = []) {
  session.stage = STAGES.TRANSFERRED;
  session.escalationReason = reason;
  await audit(session.callSid, {
    callerPhone: session.callerPhone,
    consignmentId: session.consignment ? session.consignment.consignment_id : null,
    intentDetected: reason === ESCALATION_REASONS.CUSTOMER_REQUEST ? 'AGENT_REQUEST' : undefined,
    disposition: 'AGENT_TRANSFERRED',
    escalationReason: reason,
  });
  await event(session.callSid, 'ESCALATION', { reason });
  return tw.transferToAgent({ prompts: [...prefix, PROMPTS.transfer], action: ROUTES.dialStatus });
}

async function endCall(session, prefix = []) {
  const disposition = session.intents.length ? 'BOT_RESOLVED' : 'CALLER_ENDED';
  session.stage = STAGES.ENDED;
  await audit(session.callSid, { disposition, durationSeconds: sessions.durationSeconds(session) });
  await event(session.callSid, 'CALL_ENDED', { disposition });
  return tw.hangup([...prefix, PROMPTS.goodbye]);
}

async function systemFailure(session, err) {
  console.error(`[call ${session.callSid}] System failure: ${err.stack || err.message}`);
  return transfer(session, ESCALATION_REASONS.SYSTEM_ERROR, [PROMPTS.systemError]);
}

// -----------------------------------------------------------------------------
// Scenario 1 & 2 entry point: inbound call / ANI match
// -----------------------------------------------------------------------------

async function startCall({ callSid, callerPhone }) {
  const session = sessions.create(callSid, { callerPhone });
  await audit(callSid, { callerPhone, disposition: 'IN_PROGRESS' });

  let rows;
  try {
    rows = await db.lookupByPhone(callerPhone);
  } catch (err) {
    return { matchType: 'ERROR', callerVerified: false, consignments: [], nextAction: 'AGENT_TRANSFER', twiml: await systemFailure(session, err) };
  }
  await event(callSid, 'CALL_STARTED', { ani: f.maskPhone(callerPhone), matches: rows.length });

  if (rows.length === 1) {
    await selectConsignment(session, rows[0], 'ANI');
    return {
      matchType: 'SINGLE',
      callerVerified: true,
      consignments: rows.map(rb.toPublicConsignment),
      nextAction: 'MAIN_MENU',
      twiml: menuGather([rb.welcomeSingle(rows[0])]),
    };
  }

  if (rows.length > 1) {
    await enterDisambiguation(session, rows, 'ANI_MULTI');
    return {
      matchType: 'MULTIPLE',
      callerVerified: true,
      consignments: rows.map(rb.toPublicConsignment),
      nextAction: 'DISAMBIGUATE',
      twiml: disambiguationGather(session.candidates, ['Welcome to CCD Delivery Helpline.']),
    };
  }

  session.stage = STAGES.VERIFY;
  return {
    matchType: 'NONE',
    callerVerified: false,
    consignments: [],
    nextAction: 'SECONDARY_VERIFICATION',
    twiml: verifyGather([PROMPTS.unknownCaller]),
  };
}

// -----------------------------------------------------------------------------
// Input handlers
// -----------------------------------------------------------------------------

async function handleSilence(session) {
  session.silenceCount += 1;
  await event(session.callSid, 'NO_INPUT', { stage: session.stage, count: session.silenceCount });

  if (session.stage === STAGES.FOLLOW_UP && session.silenceCount >= 2) return endCall(session);
  if (session.silenceCount >= 2) return transfer(session, ESCALATION_REASONS.NO_INPUT);
  return stagePrompt(session, [session.stage === STAGES.FOLLOW_UP ? PROMPTS.stillThere : PROMPTS.noInput]);
}

async function handleUnclear(session, detail) {
  session.unclearCount += 1;
  await event(session.callSid, 'UNCLEAR_INPUT', { stage: session.stage, count: session.unclearCount, ...detail });
  if (session.unclearCount >= 2) return transfer(session, ESCALATION_REASONS.LOW_CONFIDENCE);
  return stagePrompt(session, [PROMPTS.notUnderstood]);
}

/** Answer STATUS / EDD / EXCEPTION / ACTION for the selected consignment. */
async function answerIntent(session, intent) {
  const c = session.consignment;
  const attempts = await db.getAttemptHistory(c.consignment_id);
  const spokenText = rb.buildAnswer(intent, c, attempts);

  session.intents.push(intent);
  session.stage = STAGES.FOLLOW_UP;
  resetCounters(session);

  await audit(session.callSid, { intentDetected: intent, consignmentId: c.consignment_id });
  await event(session.callSid, 'INTENT', { intent, consignmentId: c.consignment_id, status: c.status });

  return { intent, spokenText, twiml: followUpGather([spokenText]) };
}

async function handleDisambiguation(session, input) {
  let index = -1;
  if (input.kind === 'DTMF') {
    const n = parseInt(input.value.charAt(0), 10);
    if (n === 9 && session.candidates.length < 9) return transfer(session, ESCALATION_REASONS.CUSTOMER_REQUEST);
    if (n >= 1 && n <= session.candidates.length) index = n - 1;
  } else {
    const intent = sp.detectIntent(input.value);
    if (intent === INTENTS.AGENT) return transfer(session, ESCALATION_REASONS.CUSTOMER_REQUEST);
    index = sp.matchDisambiguation(input.value, session.candidates, f.describeItem);
  }

  if (index < 0) return handleUnclear(session, { reason: 'INVALID_SELECTION' });

  const chosen = session.candidates[index];
  await selectConsignment(session, chosen, session.pendingValidationMethod || 'ANI_MULTI');
  return menuGather([`Thank you. You selected your ${rb.itemSentence(chosen)}.`]);
}

/**
 * POST /api/telephony/menu-selection — main menu, follow-up and disambiguation.
 */
async function handleMenuSelection({ callSid, callerPhone, digits, speech, confidence }) {
  const session = sessions.get(callSid);
  if (!session) {
    // Session expired or server restarted mid-call: restart the journey gracefully.
    return (await startCall({ callSid, callerPhone })).twiml;
  }
  if (session.stage === STAGES.VERIFY) {
    return handleVerifyInput({ callSid, callerPhone, digits, speech });
  }

  try {
    const input = sp.classifyInput({ digits, speech, confidence }, settings().confidenceThreshold);
    if (input.kind === 'SILENCE') return await handleSilence(session);
    if (input.kind === 'LOW_CONFIDENCE') return await handleUnclear(session, { reason: 'LOW_CONFIDENCE', confidence: input.confidence });

    await event(callSid, 'CALLER_INPUT', {
      stage: session.stage,
      kind: input.kind,
      value: input.value.slice(0, 200),
      confidence: input.confidence,
    });

    if (session.stage === STAGES.DISAMBIGUATE) return await handleDisambiguation(session, input);
    if (!session.consignment) return (await startCall({ callSid, callerPhone: session.callerPhone || callerPhone })).twiml;

    const intent = input.kind === 'DTMF' ? sp.intentFromDigit(input.value) : sp.detectIntent(input.value);

    switch (intent) {
      case INTENTS.AGENT:
        return await transfer(session, ESCALATION_REASONS.CUSTOMER_REQUEST);
      case INTENTS.RESCHEDULE:
        await event(callSid, 'INTENT', { intent: INTENTS.RESCHEDULE, consignmentId: session.consignment.consignment_id });
        return await transfer(session, ESCALATION_REASONS.RESCHEDULE_REQUEST, [
          'Rescheduling a secure delivery needs a representative to confirm a few details.',
        ]);
      case INTENTS.STATUS:
      case INTENTS.EDD:
      case INTENTS.EXCEPTION:
      case INTENTS.ACTION:
        return (await answerIntent(session, intent)).twiml;
      case INTENTS.NO:
        if (session.stage === STAGES.FOLLOW_UP || session.intents.length) return await endCall(session);
        return await handleUnclear(session, { reason: 'NO_AT_MAIN_MENU' });
      case INTENTS.YES:
      case INTENTS.MENU:
        session.stage = STAGES.MAIN_MENU;
        resetCounters(session);
        return menuGather(intent === INTENTS.YES ? ['Sure.'] : []);
      default:
        return await handleUnclear(session, { reason: 'OUT_OF_SCOPE' });
    }
  } catch (err) {
    return systemFailure(session, err);
  }
}

// -----------------------------------------------------------------------------
// Scenario 2: secondary identity verification
// -----------------------------------------------------------------------------

/** Validates a consignment number or DOB against PostgreSQL. */
async function verifyIdentity({ input, type = 'AUTO', callerPhone }) {
  const parsed = sp.parseVerificationInput(input, type);

  if (parsed.consignmentNumber) {
    const row = await db.lookupByConsignmentNumber(parsed.consignmentNumber);
    if (row) return { verified: true, method: 'CONSIGNMENT', matches: [row] };
  }

  if (parsed.dob) {
    let rows = callerPhone ? await db.verifyByDob(callerPhone, parsed.dob) : [];
    if (!rows.length) rows = await db.verifyByDob(null, parsed.dob);
    // A DOB alone is only accepted when it resolves to exactly one customer.
    const owners = new Set(rows.map((r) => f.last10Digits(r.customer_phone)));
    if (rows.length && owners.size === 1) return { verified: true, method: 'DOB', matches: rows };
  }

  return {
    verified: false,
    method: parsed.dob && !parsed.consignmentNumber ? 'DOB' : 'CONSIGNMENT',
    matches: [],
    parsed: { consignmentNumber: Boolean(parsed.consignmentNumber), dob: Boolean(parsed.dob) },
  };
}

/**
 * Applies a verification attempt to the call session and returns the next TwiML.
 * Used by both the Twilio Gather action and POST /api/workflow/verify-secondary.
 */
async function processVerification({ callSid, callerPhone, input, type = 'AUTO', attemptCount }) {
  const session = sessions.getOrCreate(callSid, { callerPhone, stage: STAGES.VERIFY });
  if (callerPhone && !session.callerPhone) session.callerPhone = callerPhone;
  session.stage = STAGES.VERIFY;

  const attempt = Number.isFinite(attemptCount) && attemptCount > 0 ? attemptCount : session.verifyAttempts + 1;
  session.verifyAttempts = attempt;

  await audit(callSid, { callerPhone: session.callerPhone, disposition: 'IN_PROGRESS' });

  const result = await verifyIdentity({ input, type, callerPhone: session.callerPhone });
  await event(callSid, result.verified ? 'VERIFICATION_PASSED' : 'VERIFICATION_FAILED', {
    method: result.method,
    attempt,
    inputType: String(type).toUpperCase(),
  });

  if (result.verified) {
    session.verifyAttempts = 0;
    if (result.matches.length === 1) {
      const c = result.matches[0];
      await selectConsignment(session, c, result.method);
      return {
        verified: true,
        attemptCount: attempt,
        escalateToAgent: false,
        validationMethod: result.method,
        consignment: rb.toPublicConsignment(c),
        consignments: [rb.toPublicConsignment(c)],
        nextAction: 'MAIN_MENU',
        twiml: menuGather([PROMPTS.verified, `We found your ${rb.itemSentence(c)}.`]),
      };
    }
    await enterDisambiguation(session, result.matches, result.method);
    return {
      verified: true,
      attemptCount: attempt,
      escalateToAgent: false,
      validationMethod: result.method,
      consignment: null,
      consignments: result.matches.map(rb.toPublicConsignment),
      nextAction: 'DISAMBIGUATE',
      twiml: disambiguationGather(session.candidates, [PROMPTS.verified]),
    };
  }

  if (attempt >= 2) {
    await audit(callSid, { validationMethod: 'FAILED' });
    return {
      verified: false,
      attemptCount: attempt,
      escalateToAgent: true,
      validationMethod: 'FAILED',
      consignment: null,
      consignments: [],
      nextAction: 'AGENT_TRANSFER',
      twiml: await transfer(session, ESCALATION_REASONS.VERIFICATION_FAILURE, [PROMPTS.verifyFailed]),
    };
  }

  return {
    verified: false,
    attemptCount: attempt,
    escalateToAgent: false,
    validationMethod: null,
    consignment: null,
    consignments: [],
    nextAction: 'RETRY_VERIFICATION',
    twiml: verifyGather([PROMPTS.verifyRetry]),
  };
}

/** POST /api/telephony/verify-input */
async function handleVerifyInput({ callSid, callerPhone, digits, speech }) {
  const session = sessions.getOrCreate(callSid, { callerPhone, stage: STAGES.VERIFY });
  session.stage = STAGES.VERIFY;

  try {
    const input = sp.classifyInput({ digits, speech }, 0);
    if (input.kind === 'SILENCE') return await handleSilence(session);
    if (input.kind === 'SPEECH' && sp.detectIntent(input.value) === INTENTS.AGENT) {
      return await transfer(session, ESCALATION_REASONS.CUSTOMER_REQUEST);
    }
    return (await processVerification({ callSid, callerPhone: session.callerPhone || callerPhone, input: input.value })).twiml;
  } catch (err) {
    return systemFailure(session, err);
  }
}

// -----------------------------------------------------------------------------
// Scenario 4: agent dial outcome + call completion
// -----------------------------------------------------------------------------

async function handleDialStatus({ callSid, dialStatus, dialDuration }) {
  const status = String(dialStatus || '').toLowerCase();
  await event(callSid, 'AGENT_DIAL_RESULT', { status, durationSeconds: Number(dialDuration) || 0 });

  if (status === 'completed' || status === 'answered') {
    return tw.hangup([]);
  }
  await audit(callSid, { disposition: 'AGENT_UNAVAILABLE' });
  return tw.hangup([PROMPTS.agentBusy]);
}

async function handleStatusCallback({ callSid, callStatus, callDuration, callerPhone }) {
  const terminal = ['completed', 'busy', 'failed', 'no-answer', 'canceled'];
  if (!terminal.includes(String(callStatus || '').toLowerCase())) return;

  const session = sessions.get(callSid);
  const duration = Number.isFinite(parseInt(callDuration, 10)) ? parseInt(callDuration, 10) : sessions.durationSeconds(session);
  try {
    await db.finalizeCallAudit(callSid, { durationSeconds: duration, callerPhone: callerPhone || (session && session.callerPhone) });
    await event(callSid, 'CALL_COMPLETED', { callStatus, durationSeconds: duration });
  } catch (err) {
    console.error(`[audit] Failed to finalize ${callSid}: ${err.message}`);
  }
  sessions.delete(callSid);
}

// -----------------------------------------------------------------------------
// Workflow helpers
// -----------------------------------------------------------------------------

/** Binds a consignment to a live call session when a workflow supplies callSid. */
async function attachConsignmentToCall(callSid, consignment, intent) {
  if (!callSid) return;
  const session = sessions.getOrCreate(callSid, {});
  if (!session.consignment || session.consignment.consignment_id !== consignment.consignment_id) {
    session.consignment = consignment;
    if (!session.validationMethod) session.validationMethod = 'WORKFLOW';
  }
  session.stage = STAGES.FOLLOW_UP;
  if (intent) session.intents.push(intent);
  resetCounters(session);
  await audit(callSid, { consignmentId: consignment.consignment_id, intentDetected: intent, disposition: 'IN_PROGRESS' });
  if (intent) await event(callSid, 'INTENT', { intent, consignmentId: consignment.consignment_id, status: consignment.status, source: 'WORKFLOW' });
}

async function workflowTransfer({ callSid, callerPhone, reason, message }) {
  const session = sessions.getOrCreate(callSid, { callerPhone });
  if (callerPhone && !session.callerPhone) session.callerPhone = callerPhone;
  // Optional caller-supplied announcement spoken before the standard transfer prompt.
  const custom = typeof message === 'string' && message.trim() ? [message.trim().slice(0, 500)] : null;
  const prefix = custom || (reason === ESCALATION_REASONS.VERIFICATION_FAILURE ? [PROMPTS.verifyFailed] : []);
  return transfer(session, reason || ESCALATION_REASONS.CUSTOMER_REQUEST, prefix);
}

module.exports = {
  ROUTES,
  PROMPTS,
  ESCALATION_REASONS,
  VERIFIED_METHODS,
  startCall,
  handleMenuSelection,
  handleVerifyInput,
  processVerification,
  verifyIdentity,
  handleDialStatus,
  handleStatusCallback,
  attachConsignmentToCall,
  workflowTransfer,
  followUpGather,
};
