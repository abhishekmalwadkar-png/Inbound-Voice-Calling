'use strict';

const express = require('express');
const twilio = require('twilio');
const config = require('../config');
const conversation = require('../services/conversationService');
const tw = require('../utils/twilioHelper');
const ctx = require('../utils/requestContext');
const sessions = require('../services/sessionManager');
const { maskPhone } = require('../utils/formatters');

const router = express.Router();

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function sendTwiml(res, xml) {
  res.type('text/xml').send(xml);
}

/** For outbound calls placed via make-call, the customer is the "To" party. */
function customerNumber(body) {
  return /^outbound/i.test(body.Direction || '') ? body.To : body.From;
}

function logWebhook(name, body) {
  if (!config.debug) return;
  const fields = {
    CallSid: body.CallSid,
    From: maskPhone(body.From),
    Digits: body.Digits ? '*'.repeat(String(body.Digits).length) : undefined,
    SpeechResult: body.SpeechResult ? `${String(body.SpeechResult).length} chars` : undefined,
    Confidence: body.Confidence,
    CallStatus: body.CallStatus,
    DialCallStatus: body.DialCallStatus,
  };
  Object.keys(fields).forEach((k) => fields[k] === undefined && delete fields[k]);
  console.log(`[twilio] ${name}`, JSON.stringify(fields));
}

/** Optional X-Twilio-Signature validation (TWILIO_VALIDATE_SIGNATURE=true). */
function validateTwilioSignature(req, res, next) {
  if (!config.twilio.validateSignature) return next();
  const signature = req.header('X-Twilio-Signature') || '';
  const url = `${config.baseUrl}${req.originalUrl}`;
  if (twilio.validateRequest(config.twilio.authToken, signature, url, req.body || {})) return next();
  console.warn(`[twilio] Rejected request with invalid signature: ${req.originalUrl}`);
  return res.status(403).type('text/plain').send('Invalid Twilio signature');
}

/**
 * Wraps a Twilio webhook. Settings (voice, agentNumber, timeouts, ...) come from
 * the call's session (set by an earlier workflow call or make-call) and from
 * the webhook URL query string, e.g.
 *   /api/telephony/inbound-call?voice=Polly.Aditi&agentNumber=%2B919876543210
 * Any unexpected failure still returns valid TwiML that routes the caller to an agent.
 */
function twimlHandler(name, handler) {
  return async (req, res) => {
    const body = req.body || {};
    logWebhook(name, body);

    const { overrides, errors } = ctx.parseOverrides(req.query || {});
    if (errors.length) console.warn(`[twilio] ${name}: ignoring invalid query settings: ${errors.join(' ')}`);
    const existing = sessions.get(body.CallSid);
    const merged = { ...((existing && existing.overrides) || {}), ...overrides };

    await ctx.run(merged, async () => {
      try {
        const xml = await handler(body, req);
        const session = sessions.get(body.CallSid);
        if (session) session.overrides = merged;
        sendTwiml(res, xml);
      } catch (err) {
        console.error(`[twilio] ${name} failed: ${err.stack || err.message}`);
        sendTwiml(res, conversation.errorTwiml());
      }
    });
  };
}

let restClient = null;
function getTwilioClient() {
  const { accountSid, authToken } = config.twilio;
  if (!/^AC[0-9a-fA-F]{32}$/.test(accountSid) || !authToken || /your_/i.test(authToken)) {
    const err = new Error('Twilio credentials are not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in .env.');
    err.status = 503;
    throw err;
  }
  if (!restClient) restClient = twilio(accountSid, authToken);
  return restClient;
}

function sendApiError(res, err) {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 502;
  res.status(status).json({ success: false, error: err.message, code: err.code || undefined, moreInfo: err.moreInfo || undefined });
}

function presentCall(call) {
  return {
    callSid: call.sid,
    status: call.status,
    direction: call.direction,
    from: call.from,
    to: call.to,
    durationSeconds: call.duration !== null && call.duration !== undefined ? Number(call.duration) : null,
    startTime: call.startTime,
    endTime: call.endTime,
    dateCreated: call.dateCreated,
    answeredBy: call.answeredBy || null,
  };
}

// -----------------------------------------------------------------------------
// A. Twilio inbound webhooks
// -----------------------------------------------------------------------------

router.post(
  '/inbound-call',
  validateTwilioSignature,
  twimlHandler('inbound-call', async (body) => {
    const result = await conversation.startCall({ callSid: body.CallSid, callerPhone: customerNumber(body) });
    return result.twiml;
  })
);

router.post(
  '/menu-selection',
  validateTwilioSignature,
  twimlHandler('menu-selection', (body) =>
    conversation.handleMenuSelection({
      callSid: body.CallSid,
      callerPhone: customerNumber(body),
      digits: body.Digits,
      speech: body.SpeechResult,
      confidence: body.Confidence,
    })
  )
);

router.post(
  '/verify-input',
  validateTwilioSignature,
  twimlHandler('verify-input', (body) =>
    conversation.handleVerifyInput({
      callSid: body.CallSid,
      callerPhone: customerNumber(body),
      digits: body.Digits,
      speech: body.SpeechResult,
    })
  )
);

// <Dial action> callback: fallback when the agent line is busy / unanswered.
router.post(
  '/agent-dial-status',
  validateTwilioSignature,
  twimlHandler('agent-dial-status', (body) =>
    conversation.handleDialStatus({
      callSid: body.CallSid,
      dialStatus: body.DialCallStatus,
      dialDuration: body.DialCallDuration,
    })
  )
);

// Number-level "Call Status Changes" callback: records final duration / abandoned calls.
router.post('/status-callback', validateTwilioSignature, async (req, res) => {
  const body = req.body || {};
  logWebhook('status-callback', body);
  await conversation.handleStatusCallback({
    callSid: body.CallSid,
    callStatus: body.CallStatus,
    callDuration: body.CallDuration,
    callerPhone: customerNumber(body),
  });
  res.status(204).end();
});

// -----------------------------------------------------------------------------
// B. Programmatic call management (Twilio REST API)
// -----------------------------------------------------------------------------

/**
 * POST /api/telephony/make-call
 * Body (all optional except "to"; .env is the fallback):
 *   to, from | callerId, actionUrl, method, statusCallback, statusCallbackMethod,
 *   statusCallbackEvent[], timeout (ring seconds), record, machineDetection,
 *   plus any call setting (voice, language, agentNumber, dialTimeout, gatherTimeout,
 *   verifyTimeout, confidenceThreshold, deliveryWindow, baseUrl, *ActionUrl) which
 *   is forwarded to the call's inbound-call webhook.
 */
router.post('/make-call', async (req, res) => {
  const body = req.body || {};
  const { overrides, errors } = ctx.parseOverrides(body);
  if (errors.length) return res.status(400).json({ success: false, error: errors.join(' '), errors });

  const { to } = body;
  if (!tw.isE164(to)) {
    return res.status(400).json({ success: false, error: '"to" must be an E.164 phone number, e.g. +919800000001' });
  }

  await ctx.run(overrides, async () => {
    const s = ctx.settings();
    const callerId = body.from || s.callerId;
    if (!tw.isE164(callerId)) {
      return res.status(400).json({ success: false, error: 'Pass "from" (E.164) in the body or set TWILIO_PHONE_NUMBER in .env.' });
    }

    const method = String(body.method || 'POST').toUpperCase();
    const statusCallbackMethod = String(body.statusCallbackMethod || 'POST').toUpperCase();
    if (!['GET', 'POST'].includes(method) || !['GET', 'POST'].includes(statusCallbackMethod)) {
      return res.status(400).json({ success: false, error: '"method" and "statusCallbackMethod" must be GET or POST.' });
    }
    const ringTimeout = body.timeout !== undefined ? parseInt(body.timeout, 10) : undefined;
    if (ringTimeout !== undefined && !(ringTimeout >= 5 && ringTimeout <= 600)) {
      return res.status(400).json({ success: false, error: '"timeout" must be 5-600 seconds.' });
    }
    const events = Array.isArray(body.statusCallbackEvent)
      ? body.statusCallbackEvent
      : body.statusCallbackEvent
        ? String(body.statusCallbackEvent).split(/[\s,]+/)
        : ['initiated', 'ringing', 'answered', 'completed'];

    // When the call is answered by this service, carry the call settings to its webhook.
    let url = tw.absoluteUrl(body.actionUrl || '/api/telephony/inbound-call');
    if (!body.actionUrl && Object.keys(overrides).length) {
      url += `?${new URLSearchParams(Object.entries(overrides).map(([k, v]) => [k, String(v)]))}`;
    }

    try {
      const params = {
        to,
        from: callerId,
        url,
        method,
        statusCallback: tw.absoluteUrl(body.statusCallback || '/api/telephony/status-callback'),
        statusCallbackMethod,
        statusCallbackEvent: events.filter(Boolean),
      };
      if (ringTimeout !== undefined) params.timeout = ringTimeout;
      if (body.record !== undefined) params.record = body.record === true || body.record === 'true';
      if (body.machineDetection) params.machineDetection = String(body.machineDetection);

      const call = await getTwilioClient().calls.create(params);
      res.status(201).json({ success: true, webhookUrl: url, ...presentCall(call) });
    } catch (err) {
      sendApiError(res, err);
    }
  });
});

router.get('/call-status/:callSid', async (req, res) => {
  const { callSid } = req.params;
  if (!/^CA[0-9a-fA-F]{32}$/.test(callSid)) {
    return res.status(400).json({ success: false, error: 'Invalid CallSid. Expected CA followed by 32 hex characters.' });
  }
  try {
    const call = await getTwilioClient().calls(callSid).fetch();
    res.json({ success: true, ...presentCall(call) });
  } catch (err) {
    sendApiError(res, err);
  }
});

router.post('/terminate-call', async (req, res) => {
  const { callSid } = req.body || {};
  if (!/^CA[0-9a-fA-F]{32}$/.test(String(callSid || ''))) {
    return res.status(400).json({ success: false, error: 'Body must include a valid "callSid".' });
  }
  try {
    const call = await getTwilioClient().calls(callSid).update({ status: 'completed' });
    res.json({ success: true, terminated: true, ...presentCall(call) });
  } catch (err) {
    sendApiError(res, err);
  }
});

module.exports = router;
