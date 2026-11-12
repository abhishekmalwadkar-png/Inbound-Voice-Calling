'use strict';

/**
 * Workflow utility endpoints for AutomationEdge Process Studio (or any other
 * orchestrator). Each endpoint returns structured JSON for branching plus a
 * ready-to-return `twiml` string.
 */

const crypto = require('crypto');
const express = require('express');
const db = require('../services/databaseService');
const conversation = require('../services/conversationService');
const rb = require('../services/responseBuilder');
const tw = require('../utils/twilioHelper');
const ctx = require('../utils/requestContext');
const sessions = require('../services/sessionManager');

const router = express.Router();

const STATUS_INTENTS = new Set(['STATUS', 'EDD', 'EXCEPTION', 'ACTION']);

function badRequest(res, message) {
  return res.status(400).json({ success: false, error: message });
}

function workflowCallSid() {
  return `WF${crypto.randomBytes(16).toString('hex')}`;
}

/**
 * Runs a workflow handler with the per-request settings found in the JSON body
 * (voice, language, agentNumber, callerId, timeouts, baseUrl, action URLs...).
 * Settings already stored for the callSid apply first; values in this body win.
 * The merged settings are saved on the call session for later Twilio callbacks.
 */
function asyncRoute(handler) {
  return async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const { overrides, errors } = ctx.parseOverrides(body);
    if (errors.length) return res.status(400).json({ success: false, error: errors.join(' '), errors });

    // Remember whether the caller supplied a callSid: pure lookups (status / exception) without one
    // are not calls and must not create audit rows.
    req.callSidProvided = Boolean(body.callSid);
    if (!body.callSid) body.callSid = workflowCallSid();
    req.body = body;
    const existing = sessions.get(body.callSid);
    const merged = { ...((existing && existing.overrides) || {}), ...overrides };

    try {
      await ctx.run(merged, async () => {
        await handler(req, res);
        const session = sessions.get(body.callSid);
        if (session) session.overrides = merged;
      });
    } catch (err) {
      if (err.status === 400) return res.status(400).json({ success: false, error: err.message });
      console.error(`[workflow] ${req.method} ${req.originalUrl} failed: ${err.stack || err.message}`);
      res.status(500).json({
        success: false,
        error: 'Internal error while processing the workflow request.',
        twiml: conversation.errorTwiml(),
      });
    }
  };
}

async function findConsignmentOr404(res, consignmentId) {
  const row = await db.lookupByConsignmentNumber(consignmentId, { activeOnly: false });
  if (!row) {
    res.status(404).json({
      success: false,
      error: `Consignment ${consignmentId} not found.`,
      twiml: tw.gather({
        prompts: ['Sorry, we could not find that consignment.', conversation.PROMPTS.askConsignment],
        action: conversation.ROUTES.verify,
        finishOnKey: '#',
      }),
    });
  }
  return row;
}

// 1. ANI match ------------------------------------------------------------------
router.post(
  '/validate-caller',
  asyncRoute(async (req, res) => {
    const { callerPhone } = req.body || {};
    if (!callerPhone) return badRequest(res, '"callerPhone" is required.');
    const { callSid } = req.body;

    const result = await conversation.startCall({ callSid, callerPhone });
    res.json({
      success: true,
      callSid,
      matchType: result.matchType,
      callerVerified: result.callerVerified,
      consignmentCount: result.consignments.length,
      consignments: result.consignments,
      nextAction: result.nextAction,
      twiml: result.twiml,
    });
  })
);

// 2. Secondary verification ----------------------------------------------------
router.post(
  '/verify-secondary',
  asyncRoute(async (req, res) => {
    const { identifier, callerPhone } = req.body || {};
    const type = String(req.body.type || 'AUTO').toUpperCase();
    if (!identifier) return badRequest(res, '"identifier" (consignment number or DOB DDMMYYYY) is required.');
    if (!['AUTO', 'CONSIGNMENT', 'DOB'].includes(type)) return badRequest(res, '"type" must be CONSIGNMENT, DOB or AUTO.');

    const { callSid } = req.body;
    const attemptCount = parseInt(req.body.attemptCount, 10);

    const result = await conversation.processVerification({
      callSid,
      callerPhone,
      input: String(identifier),
      type,
      attemptCount: Number.isFinite(attemptCount) ? attemptCount : undefined,
    });

    res.json({ success: true, callSid, type, ...result });
  })
);

// 3. Status / expected delivery date ------------------------------------------
router.post(
  '/status',
  asyncRoute(async (req, res) => {
    const { consignmentId, callSid } = req.body;
    const intent = String(req.body.intent || 'STATUS').toUpperCase();
    if (!consignmentId) return badRequest(res, '"consignmentId" is required.');
    if (!STATUS_INTENTS.has(intent)) return badRequest(res, '"intent" must be STATUS, EDD, EXCEPTION or ACTION.');

    const row = await findConsignmentOr404(res, consignmentId);
    if (!row) return;

    const attempts = await db.getAttemptHistory(row.consignment_id);
    const spokenText = rb.buildAnswer(intent, row, attempts);
    if (req.callSidProvided) await conversation.attachConsignmentToCall(callSid, row, intent);

    const view = rb.toPublicConsignment(row);
    res.json({
      success: true,
      consignmentId: view.consignmentId,
      issuer: view.issuer,
      itemType: view.itemType,
      itemLabel: view.itemLabel,
      maskedNumber: view.maskedNumber,
      last4: view.last4,
      status: view.status,
      statusLabel: view.statusLabel,
      expectedDeliveryDate: view.expectedDeliveryDate,
      lastLocation: view.lastLocation,
      intent,
      spokenText,
      twiml: conversation.followUpGather([spokenText]),
    });
  })
);

// 4. Delivery exception ---------------------------------------------------------
router.post(
  '/exception',
  asyncRoute(async (req, res) => {
    const { consignmentId, callSid } = req.body || {};
    if (!consignmentId) return badRequest(res, '"consignmentId" is required.');

    const row = await findConsignmentOr404(res, consignmentId);
    if (!row) return;

    const attempts = await db.getAttemptHistory(row.consignment_id);
    const details = rb.buildExceptionDetails(row, attempts);
    if (req.callSidProvided) await conversation.attachConsignmentToCall(callSid, row, 'EXCEPTION');

    res.json({
      success: true,
      ...details,
      issuer: row.issuer,
      itemLabel: rb.toPublicConsignment(row).itemLabel,
      twiml: conversation.followUpGather([details.spokenText]),
    });
  })
);

// 5. Live agent escalation -------------------------------------------------------
router.post(
  '/agent-transfer',
  asyncRoute(async (req, res) => {
    const { callerPhone } = req.body || {};
    // Any reason code is accepted (letters, digits, _ - . space), stored upper-cased in the audit trail.
    const reason = String(req.body.reason || 'CUSTOMER_REQUEST').trim().toUpperCase().replace(/\s+/g, '_');
    if (!/^[A-Z0-9_.\-]{1,100}$/.test(reason)) {
      return badRequest(res, '"reason" must be 1-100 characters: letters, digits, underscore, dot or hyphen.');
    }
    const s = ctx.settings();
    const { callSid } = req.body;
    // PPT slide 18: with no agent configured the TwiML apologises and ends the call (action END_CALL).
    const connected = conversation.agentConfigured();
    const twiml = await conversation.workflowTransfer({ callSid, callerPhone, reason, message: req.body.message });

    res.json({
      success: true,
      callSid,
      action: connected ? 'DIAL_AGENT' : 'END_CALL',
      destination: connected ? s.agentNumber : null,
      callerId: tw.isE164(s.callerId) ? s.callerId : null,
      reason,
      dialTimeoutSeconds: s.dialTimeoutSeconds,
      twiml,
    });
  })
);

module.exports = router;
