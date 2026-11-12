'use strict';

const express = require('express');
const config = require('../config');
const db = require('../services/databaseService');
const sessions = require('../services/sessionManager');
const realtime = require('../services/realtimeService');
const rb = require('../services/responseBuilder');
const { maskPhone, statusLabel } = require('../utils/formatters');

const router = express.Router();

const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

router.get('/metrics', async (req, res) => {
  try {
    const [m, intents, statuses, reasons] = await Promise.all([
      db.getCallMetrics(),
      db.getIntentDistribution(),
      db.getConsignmentStatusBreakdown(),
      db.getEscalationReasons(),
    ]);

    const contained = Math.max(m.completed_calls - m.escalated, 0);
    const savingPerCall = config.business.costPerAgentCallInr - config.business.costPerBotCallInr;

    res.json({
      generatedAt: new Date().toISOString(),
      kpis: {
        totalCalls: m.total_calls,
        completedCalls: m.completed_calls,
        activeCalls: m.active_calls,
        containmentRate: pct(contained, m.completed_calls),
        averageHandlingTimeSeconds: m.aht_seconds,
        validationAccuracy: pct(m.validated, m.validation_attempts),
        verifiedCalls: m.validated,
        notVerifiedCalls: m.not_verified,
        pendingVerification: m.verification_pending,
        escalationRate: pct(m.escalated, m.completed_calls),
        estimatedCostSavingsInr: Math.round(contained * savingPerCall),
        costAssumptions: {
          costPerAgentCallInr: config.business.costPerAgentCallInr,
          costPerBotCallInr: config.business.costPerBotCallInr,
        },
      },
      resolution: {
        botResolved: m.bot_resolved,
        agentTransferred: m.escalated,
        abandoned: m.abandoned,
        inProgress: m.active_calls,
      },
      intents: intents.map((r) => ({ intent: r.intent, count: r.count })),
      consignmentStatuses: statuses.map((r) => ({ status: r.status, label: statusLabel(r.status), count: r.count })),
      escalationReasons: reasons,
      liveSessions: sessions.size(),
    });
  } catch (err) {
    console.error(`[dashboard] metrics failed: ${err.message}`);
    res.status(503).json({ error: 'Database unavailable', detail: err.message });
  }
});

function presentAudit(r) {
  return {
    callSid: r.call_sid,
    callerPhone: maskPhone(r.caller_phone),
    consignmentId: r.consignment_id,
    // 'ANI_MATCH' (written by some external tools) is the same as the app's 'ANI'.
    validationMethod: r.validation_method === 'ANI_MATCH' ? 'ANI' : r.validation_method,
    verificationStatus: r.verification_status || null,
    verificationAttempts: r.verification_attempts !== undefined && r.verification_attempts !== null ? r.verification_attempts : null,
    intentDetected: r.intent_detected,
    durationSeconds: r.duration_seconds,
    disposition: r.disposition,
    escalationReason: r.escalation_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function filtersFrom(q) {
  return { from: q.from, to: q.to, disposition: q.disposition, validation: q.validation, verification: q.verification, search: q.q, sort: q.sort, dir: q.dir };
}

// GET /api/dashboard/audit-logs?limit=25&offset=0&from=YYYY-MM-DD&to=YYYY-MM-DD&disposition=&validation=&q=
router.get('/audit-logs', async (req, res) => {
  try {
    const page = await db.getAuditLogs({ limit: req.query.limit, offset: req.query.offset, ...filtersFrom(req.query) });
    res.json({ total: page.total, limit: page.limit, offset: page.offset, rows: page.rows.map(presentAudit) });
  } catch (err) {
    res.status(503).json({ error: 'Database unavailable', detail: err.message });
  }
});

const CSV_COLUMNS = [
  ['Created At', 'createdAt'],
  ['Last Updated', 'updatedAt'],
  ['Call SID', 'callSid'],
  ['Caller Phone (masked)', 'callerPhone'],
  ['Consignment ID', 'consignmentId'],
  ['Verification', 'verificationStatus'],
  ['Verification Attempts', 'verificationAttempts'],
  ['Validation Method', 'validationMethod'],
  ['Intent Detected', 'intentDetected'],
  ['Duration (s)', 'durationSeconds'],
  ['Disposition', 'disposition'],
  ['Escalation Reason', 'escalationReason'],
];

/** RFC 4180 quoting + spreadsheet formula-injection guard. */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// GET /api/dashboard/audit-logs/export.csv  (same filters as /audit-logs, up to 50,000 rows)
router.get('/audit-logs/export.csv', async (req, res) => {
  try {
    const page = await db.getAuditLogs({ limit: 50000, offset: 0, ...filtersFrom(req.query) }, { maxLimit: 50000 });
    const lines = [CSV_COLUMNS.map(([h]) => csvCell(h)).join(',')];
    page.rows.map(presentAudit).forEach((r) => {
      // Masked numbers ("+91******0001") are safe text; drop the "+" so Excel shows them as-is.
      const row = { ...r, callerPhone: r.callerPhone ? String(r.callerPhone).replace(/^\+(?=[\d*]+$)/, '') : r.callerPhone };
      lines.push(CSV_COLUMNS.map(([, key]) => csvCell(row[key])).join(','));
    });

    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="ccd-call-audit-${stamp}.csv"`);
    res.send(`﻿${lines.join('\r\n')}\r\n`); // BOM so Excel opens UTF-8 correctly
  } catch (err) {
    res.status(503).json({ error: 'Database unavailable', detail: err.message });
  }
});

// -----------------------------------------------------------------------------
// Deliveries (consignments + delivery attempts)
// -----------------------------------------------------------------------------

function consignmentFilters(q) {
  return {
    search: q.q,
    status: q.status,
    kind: ['SIM', 'CARD'].includes(q.kind) ? q.kind : undefined,
    issuer: q.issuer,
    active: ['active', 'inactive', 'all'].includes(q.active) ? q.active : 'active',
    sort: q.sort,
    dir: q.dir,
  };
}

/** Masked, customer-safe view. Never includes DOB; phone masked; card/SIM number last 4 only. */
function presentConsignment(r) {
  const view = rb.toPublicConsignment(r);
  return {
    ...view,
    customerPhone: maskPhone(r.customer_phone),
    attemptCount: r.attempt_count !== undefined ? r.attempt_count : undefined,
    lastAttemptAt: r.last_attempt_at || null,
    lastFailureReasonCode: r.last_failure_reason || null,
    lastFailureReason: r.last_failure_reason ? rb.plainFailureReason(r.last_failure_reason) : null,
    nextAttemptDate: r.next_attempt_date || null,
    createdAt: r.created_at,
  };
}

// GET /api/dashboard/consignments/summary?kind=&issuer=&active=&q=
router.get('/consignments/summary', async (req, res) => {
  try {
    const s = await db.getConsignmentSummary(consignmentFilters(req.query));
    const counts = Object.fromEntries(s.statuses.map((r) => [r.status, r.count]));
    res.json({
      total: s.statuses.reduce((n, r) => n + r.count, 0),
      statuses: db.CONSIGNMENT_STATUSES.map((status) => ({ status, label: statusLabel(status), count: counts[status] || 0 })),
      issuers: s.issuers,
      activeByKind: Object.fromEntries(s.activeByKind.map((r) => [r.kind, r.count])),
    });
  } catch (err) {
    res.status(503).json({ error: 'Database unavailable', detail: err.message });
  }
});

// GET /api/dashboard/consignments?limit&offset&q&status&kind=CARD|SIM&issuer&active=active|inactive|all&sort&dir
router.get('/consignments', async (req, res) => {
  try {
    const page = await db.getConsignments({ limit: req.query.limit, offset: req.query.offset, ...consignmentFilters(req.query) });
    res.json({ total: page.total, limit: page.limit, offset: page.offset, rows: page.rows.map(presentConsignment) });
  } catch (err) {
    res.status(503).json({ error: 'Database unavailable', detail: err.message });
  }
});

const CONSIGNMENT_CSV_COLUMNS = [
  ['Consignment ID', 'consignmentId'],
  ['Issuer', 'issuer'],
  ['Item', 'itemLabel'],
  ['Number (last 4)', 'last4'],
  ['Customer Phone (masked)', 'customerPhone'],
  ['Status', 'statusLabel'],
  ['Expected Delivery', 'expectedDeliveryDate'],
  ['Last Location', 'lastLocation'],
  ['Attempts', 'attemptCount'],
  ['Last Attempt', 'lastAttemptAt'],
  ['Last Failure Reason', 'lastFailureReason'],
  ['Next Attempt', 'nextAttemptDate'],
  ['Active', 'isActive'],
  ['Created At', 'createdAt'],
];

// GET /api/dashboard/consignments/export.csv  (same filters, up to 50,000 rows)
router.get('/consignments/export.csv', async (req, res) => {
  try {
    const page = await db.getConsignments({ limit: 50000, offset: 0, ...consignmentFilters(req.query) }, { maxLimit: 50000 });
    const lines = [CONSIGNMENT_CSV_COLUMNS.map(([h]) => csvCell(h)).join(',')];
    page.rows.map(presentConsignment).forEach((r) => {
      const row = { ...r, customerPhone: r.customerPhone ? String(r.customerPhone).replace(/^\+(?=[\d*]+$)/, '') : r.customerPhone, isActive: r.isActive ? 'Yes' : 'No' };
      lines.push(CONSIGNMENT_CSV_COLUMNS.map(([, key]) => csvCell(row[key])).join(','));
    });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="ccd-${req.query.kind === 'SIM' ? 'sim-' : ''}deliveries-${stamp}.csv"`);
    res.send(`﻿${lines.join('\r\n')}\r\n`);
  } catch (err) {
    res.status(503).json({ error: 'Database unavailable', detail: err.message });
  }
});

// GET /api/dashboard/consignments/:id  -> consignment + attempt history + calls about it
router.get('/consignments/:id', async (req, res) => {
  try {
    const detail = await db.getConsignmentDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: `Consignment ${req.params.id} not found` });
    res.json({
      consignment: presentConsignment(detail.consignment),
      attempts: detail.attempts.map((a) => ({
        attemptTimestamp: a.attempt_timestamp,
        failureReasonCode: a.failure_reason,
        failureReason: rb.plainFailureReason(a.failure_reason),
        courierNotes: a.courier_notes || null,
        nextAttemptDate: a.next_attempt_date || null,
      })),
      calls: detail.calls.map(presentAudit),
    });
  } catch (err) {
    res.status(503).json({ error: 'Database unavailable', detail: err.message });
  }
});

/**
 * GET /api/dashboard/stream  (Server-Sent Events)
 *   event: status  -> { connected, error }   database connectivity
 *   event: change  -> { tables[], at }       rows changed in PostgreSQL (any writer)
 * Comment heartbeats every 20 s keep proxies from closing the stream.
 */
router.get('/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable Nginx buffering for this response
  });
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.write('retry: 3000\n\n');
  send('status', realtime.status());

  const onChange = (payload) => send('change', payload);
  const onStatus = (payload) => send('status', payload);
  realtime.on('change', onChange);
  realtime.on('status', onStatus);
  const heartbeat = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    realtime.off('change', onChange);
    realtime.off('status', onStatus);
  });
});

router.get('/calls/:callSid/events', async (req, res) => {
  try {
    res.json(await db.getCallEvents(req.params.callSid));
  } catch (err) {
    res.status(503).json({ error: 'Database unavailable', detail: err.message });
  }
});

module.exports = router;
