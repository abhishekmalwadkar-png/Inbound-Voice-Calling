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
  // Verification order per PPT slide 16: consignment number first; date of birth only when
  // the consignment is not linked to the calling number.
  askConsignment: 'Please enter or speak your consignment tracking number, followed by the hash key.',
  askDob: 'For security, please enter or speak your 8-digit date of birth in day, month, year format, followed by the hash key.',
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
  // PPT slide 18: with no agent configured, the bot apologises and ends the call.
  noAgent: 'We are sorry, we are unable to connect you to a customer care representative at the moment. Thank you for calling CCD. Goodbye.',
  unknownCaller: 'Welcome to CCD Delivery Helpline. We could not automatically match your phone number.',
  multipleMatches: 'Welcome to CCD Delivery Helpline. We found more than one delivery linked to your number.',
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

/** Verification <Gather>: step 'CONSIGNMENT' asks for the consignment number, 'DOB' for the date of birth. */
function verifyGather(step, prefix = []) {
  const dob = step === 'DOB';
  return tw.gather({
    prompts: [...prefix, dob ? PROMPTS.askDob : PROMPTS.askConsignment],
    action: ROUTES.verify,
    finishOnKey: '#',
    timeout: settings().verifyTimeoutSeconds,
    hints: dob
      ? 'January, February, March, April, May, June, July, August, September, October, November, December'
      : 'C C D, consignment number',
  });
}

/** Re-asks whatever the caller was last asked. */
function stagePrompt(session, prefix = []) {
  switch (session.stage) {
    case STAGES.VERIFY:
      return verifyGather(session.verifyStep || 'CONSIGNMENT', prefix);
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
  session.verified = true;
  session.stage = STAGES.MAIN_MENU;
  resetCounters(session);
  await audit(session.callSid, {
    callerPhone: session.callerPhone,
    consignmentId: consignment.consignment_id,
    validationMethod,
    verificationStatus: 'VERIFIED',
    disposition: 'IN_PROGRESS',
  });
  await event(session.callSid, 'VALIDATED', { method: validationMethod, consignmentId: consignment.consignment_id });
}

/** True when a live agent destination (E.164 number or sip: URI) is configured for this request. */
function agentConfigured() {
  const destination = String(settings().agentNumber || '').trim();
  return tw.isE164(destination) || /^sip:[^\s@]+@\S+$/i.test(destination);
}

/** TwiML for unexpected failures: transfer to an agent, or apologise and end the call if none is configured. */
function errorTwiml() {
  return agentConfigured()
    ? tw.transferToAgent({ prompts: [PROMPTS.systemError, PROMPTS.transfer] })
    : tw.hangup([PROMPTS.systemError, PROMPTS.noAgent]);
}

async function transfer(session, reason, prefix = []) {
  session.escalationReason = reason;
  if (!agentConfigured()) {
    // PPT slide 18: no agent configured -> apologise and end the call.
    session.stage = STAGES.ENDED;
    await audit(session.callSid, {
      callerPhone: session.callerPhone,
      consignmentId: session.consignment ? session.consignment.consignment_id : null,
      intentDetected: reason === ESCALATION_REASONS.CUSTOMER_REQUEST ? 'AGENT_REQUEST' : undefined,
      disposition: 'AGENT_UNAVAILABLE',
      escalationReason: reason,
      durationSeconds: sessions.durationSeconds(session),
      verificationStatus: session.verified ? undefined : 'NOT_VERIFIED',
    });
    await event(session.callSid, 'ESCALATION', { reason, agentConfigured: false });
    return tw.hangup([...prefix, PROMPTS.noAgent]);
  }
  session.stage = STAGES.TRANSFERRED;
  await audit(session.callSid, {
    callerPhone: session.callerPhone,
    consignmentId: session.consignment ? session.consignment.consignment_id : null,
    intentDetected: reason === ESCALATION_REASONS.CUSTOMER_REQUEST ? 'AGENT_REQUEST' : undefined,
    disposition: 'AGENT_TRANSFERRED',
    escalationReason: reason,
    verificationStatus: session.verified ? undefined : 'NOT_VERIFIED',
  });
  await event(session.callSid, 'ESCALATION', { reason });
  return tw.transferToAgent({ prompts: [...prefix, PROMPTS.transfer], action: ROUTES.dialStatus });
}

async function endCall(session, prefix = []) {
  const disposition = session.intents.length ? 'BOT_RESOLVED' : 'CALLER_ENDED';
  session.stage = STAGES.ENDED;
  await audit(session.callSid, {
    disposition,
    durationSeconds: sessions.durationSeconds(session),
    verificationStatus: session.verified ? undefined : 'NOT_VERIFIED',
  });
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
  await audit(callSid, { callerPhone, disposition: 'IN_PROGRESS', verificationStatus: 'PENDING' });

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

  // Unknown number, or one linked to several consignments: secondary verification (PPT slide 16).
  session.stage = STAGES.VERIFY;
  session.verifyStep = 'CONSIGNMENT';
  if (rows.length > 1) {
    return {
      matchType: 'MULTIPLE',
      callerVerified: false,
      consignments: rows.map(rb.toPublicConsignment),
      nextAction: 'SECONDARY_VERIFICATION',
      twiml: verifyGather('CONSIGNMENT', [PROMPTS.multipleMatches]),
    };
  }
  return {
    matchType: 'NONE',
    callerVerified: false,
    consignments: [],
    nextAction: 'SECONDARY_VERIFICATION',
    twiml: verifyGather('CONSIGNMENT', [PROMPTS.unknownCaller]),
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

/**
 * POST /api/telephony/menu-selection — main menu and follow-up.
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

function linkedToCaller(row, callerPhone) {
  const caller = f.last10Digits(callerPhone);
  return caller.length === 10 && f.last10Digits(row.customer_phone) === caller;
}

async function verificationPassed(session, row, method) {
  session.verifyStep = null;
  session.pendingConsignment = null;
  session.verifyFailures = 0;
  await event(session.callSid, 'VERIFICATION_PASSED', { method, consignmentId: row.consignment_id });
  await selectConsignment(session, row, method);
  return {
    verified: true,
    attemptCount: session.verifyEntries,
    escalateToAgent: false,
    validationMethod: method,
    consignment: rb.toPublicConsignment(row),
    consignments: [rb.toPublicConsignment(row)],
    nextAction: 'MAIN_MENU',
    twiml: menuGather([PROMPTS.verified, `We found your ${rb.itemSentence(row)}.`]),
  };
}

/** A failed check. Two failures escalate to a live agent (PPT slide 16). */
async function verificationFailed(session, step, attemptCount) {
  const failures = Number.isFinite(attemptCount) && attemptCount > 0 ? attemptCount : (session.verifyFailures || 0) + 1;
  session.verifyFailures = failures;
  await event(session.callSid, 'VERIFICATION_FAILED', { step, failures });

  if (failures >= 2) {
    await audit(session.callSid, { validationMethod: 'FAILED', verificationStatus: 'NOT_VERIFIED', verificationAttempts: session.verifyEntries });
    return {
      verified: false,
      attemptCount: failures,
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
    attemptCount: failures,
    escalateToAgent: false,
    validationMethod: null,
    consignment: null,
    consignments: [],
    nextAction: session.verifyStep === 'DOB' ? 'RETRY_DOB' : 'RETRY_CONSIGNMENT',
    twiml: verifyGather(session.verifyStep || 'CONSIGNMENT', [PROMPTS.verifyRetry]),
  };
}

/**
 * Secondary verification (PPT slide 16): the caller is asked for the consignment number;
 * if it does not match the caller's number, a date-of-birth check follows. Two failures escalate.
 * Used by both the Twilio Gather action and POST /api/workflow/verify-secondary.
 */
async function processVerification({ callSid, callerPhone, input, type = 'AUTO', attemptCount }) {
  const session = sessions.getOrCreate(callSid, { callerPhone, stage: STAGES.VERIFY });
  if (callerPhone && !session.callerPhone) session.callerPhone = callerPhone;
  session.stage = STAGES.VERIFY;

  const requested = String(type || 'AUTO').toUpperCase();
  let step = session.verifyStep || 'CONSIGNMENT';
  if (requested === 'CONSIGNMENT' || requested === 'DOB') step = requested;
  if (step === 'DOB' && !session.pendingConsignment) {
    const err = new Error('The date-of-birth check follows the consignment number. Submit the consignment number for this callSid first.');
    err.status = 400;
    throw err;
  }
  session.verifyStep = step;

  session.verifyEntries = (session.verifyEntries || 0) + 1;
  await audit(callSid, {
    callerPhone: session.callerPhone,
    disposition: 'IN_PROGRESS',
    verificationAttempts: session.verifyEntries,
    verificationStatus: session.verified ? undefined : 'PENDING',
  });

  if (step === 'CONSIGNMENT') {
    const number = sp.parseConsignmentNumber(input);
    const row = number ? await db.lookupByConsignmentNumber(number) : null;
    if (!row) return verificationFailed(session, 'CONSIGNMENT', attemptCount);
    if (linkedToCaller(row, session.callerPhone)) return verificationPassed(session, row, 'CONSIGNMENT');

    // Valid consignment, but not linked to the calling number: date-of-birth check follows.
    session.pendingConsignment = row;
    session.verifyStep = 'DOB';
    await event(callSid, 'DOB_CHECK_REQUIRED', { consignmentId: row.consignment_id });
    return {
      verified: false,
      attemptCount: (session.verifyFailures || 0) + 1,
      escalateToAgent: false,
      validationMethod: null,
      consignment: null,
      consignments: [],
      nextAction: 'DOB_REQUIRED',
      twiml: verifyGather('DOB', ['Thank you.']),
    };
  }

  // step === 'DOB': must match the date of birth on the consignment given in the previous step.
  const row = session.pendingConsignment;
  const dob = sp.parseDob(input);
  const matches = dob ? await db.verifyByDob(row.consignment_id, dob) : [];
  if (matches.length) return verificationPassed(session, row, 'DOB');
  return verificationFailed(session, 'DOB', attemptCount);
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
  agentConfigured,
  errorTwiml,
  handleDialStatus,
  handleStatusCallback,
  attachConsignmentToCall,
  workflowTransfer,
  followUpGather,
};
