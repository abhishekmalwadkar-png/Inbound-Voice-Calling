'use strict';

const { Pool, types } = require('pg');
const config = require('../config');
const { last10Digits } = require('../utils/formatters');

// Keep TIMESTAMP (1114) and DATE (1082) as raw strings so spoken times are not
// shifted by the Node process timezone.
types.setTypeParser(1114, (value) => value);
types.setTypeParser(1082, (value) => value);

const pool = new Pool({
  ...config.db.connection,
  max: config.db.poolMax,
  idleTimeoutMillis: config.db.idleTimeoutMs,
  connectionTimeoutMillis: config.db.connectionTimeoutMs,
  application_name: 'ccd-voice-automation',
});

pool.on('error', (err) => {
  console.error('[db] Idle client error:', err.message);
});

const CONSIGNMENT_COLUMNS = `
  consignment_id, customer_phone, issuer, item_type, masked_number, status,
  expected_delivery_date, last_location, failure_reason, dob, is_active, created_at`;

const PHONE_DIGITS_SQL = `RIGHT(regexp_replace(customer_phone, '[^0-9]', '', 'g'), 10)`;

const VERIFICATION_STATUSES = ['VERIFIED', 'NOT_VERIFIED', 'PENDING'];
/**
 * Effective verification status of an audit row. Uses the stored column, and derives it
 * from validation_method for rows written by other systems (e.g. 'ANI_MATCH') without it.
 */
const VERIFICATION_SQL = `COALESCE(verification_status, CASE
    WHEN validation_method IN ('ANI', 'ANI_MATCH', 'ANI_MULTI', 'CONSIGNMENT', 'CONSIGNMENT_NUMBER', 'DOB') THEN 'VERIFIED'
    WHEN validation_method = 'FAILED' THEN 'NOT_VERIFIED'
    WHEN disposition = 'IN_PROGRESS' THEN 'PENDING'
    ELSE 'NOT_VERIFIED' END)`;

async function query(text, params = []) {
  const started = Date.now();
  const result = await pool.query(text, params);
  if (config.debug) {
    const firstLine = text.trim().split('\n')[0].slice(0, 80);
    console.log(`[db] ${result.rowCount ?? 0} row(s) in ${Date.now() - started}ms :: ${firstLine}`);
  }
  return result;
}

function normalizeConsignmentNumber(input) {
  const compact = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return { compact, digitsOnly: /^\d+$/.test(compact) ? compact : null };
}

/** Normalizes DDMMYYYY / DD-MM-YYYY / YYYY-MM-DD into ISO YYYY-MM-DD. */
function normalizeDob(dobString) {
  const raw = String(dobString || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return isValidIso(raw) ? raw : null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length !== 8) return null;
  const iso = `${digits.slice(4, 8)}-${digits.slice(2, 4)}-${digits.slice(0, 2)}`;
  return isValidIso(iso) ? iso : null;
}

function isValidIso(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    y > 1900 &&
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d &&
    date.getTime() <= Date.now()
  );
}

// -----------------------------------------------------------------------------
// Consignment lookups
// -----------------------------------------------------------------------------

/** All active consignments linked to the caller's phone (matched on last 10 digits). */
async function lookupByPhone(phoneNumber) {
  const digits = last10Digits(phoneNumber);
  if (digits.length < 10) return [];
  const { rows } = await query(
    `SELECT ${CONSIGNMENT_COLUMNS}
       FROM consignments
      WHERE is_active = TRUE AND ${PHONE_DIGITS_SQL} = $1
      ORDER BY created_at ASC, consignment_id ASC`,
    [digits]
  );
  return rows;
}

/**
 * Fetch a consignment by tracking number. Accepts "CCD1001", "ccd-1001" or the
 * numeric part only ("1001") so that DTMF keypad entry works.
 */
async function lookupByConsignmentNumber(consignmentNumber, { activeOnly = true } = {}) {
  const { compact, digitsOnly } = normalizeConsignmentNumber(consignmentNumber);
  if (!compact) return null;
  const { rows } = await query(
    `SELECT ${CONSIGNMENT_COLUMNS}
       FROM consignments
      WHERE (UPPER(consignment_id) = $1
             OR ($2::text IS NOT NULL AND regexp_replace(consignment_id, '[^0-9]', '', 'g') = $2))
        AND ($3::boolean = FALSE OR is_active = TRUE)
      ORDER BY is_active DESC, created_at DESC
      LIMIT 2`,
    [compact, digitsOnly, activeOnly]
  );
  // A purely numeric entry that matches more than one record is ambiguous.
  if (rows.length > 1 && digitsOnly && rows[0].consignment_id.toUpperCase() !== compact) return null;
  return rows[0] || null;
}

/**
 * Validate a Date of Birth. When `identifier` (phone or consignment number) is
 * supplied, the DOB must belong to that record; otherwise matches on DOB alone.
 * Returns the matching active consignments (caller decides if the match is unique).
 */
async function verifyByDob(identifier, dobString) {
  const dob = normalizeDob(dobString);
  if (!dob) return [];

  if (identifier) {
    const phoneDigits = last10Digits(identifier);
    const { compact } = normalizeConsignmentNumber(identifier);
    const { rows } = await query(
      `SELECT ${CONSIGNMENT_COLUMNS}
         FROM consignments
        WHERE is_active = TRUE
          AND dob = $1
          AND ((LENGTH($2) = 10 AND ${PHONE_DIGITS_SQL} = $2) OR UPPER(consignment_id) = $3)
        ORDER BY created_at ASC, consignment_id ASC`,
      [dob, phoneDigits, compact]
    );
    return rows;
  }

  const { rows } = await query(
    `SELECT ${CONSIGNMENT_COLUMNS}
       FROM consignments
      WHERE is_active = TRUE AND dob = $1
      ORDER BY created_at ASC, consignment_id ASC
      LIMIT 10`,
    [dob]
  );
  return rows;
}

/** Delivery attempt log, newest first. */
async function getAttemptHistory(consignmentId) {
  const { rows } = await query(
    `SELECT id, consignment_id, attempt_timestamp, failure_reason, courier_notes, next_attempt_date
       FROM delivery_attempts
      WHERE consignment_id = $1
      ORDER BY attempt_timestamp DESC, id DESC`,
    [consignmentId]
  );
  return rows;
}

// -----------------------------------------------------------------------------
// Audit trail
// -----------------------------------------------------------------------------

/** Insert-or-merge the audit row for a call. Undefined/null fields keep their stored value. */
async function upsertCallAudit(callSid, fields = {}) {
  if (!callSid) return;
  const v = (x) => (x === undefined ? null : x);
  await query(
    `INSERT INTO call_audit_logs
        (call_sid, caller_phone, consignment_id, validation_method, intent_detected,
         duration_seconds, disposition, escalation_reason, verification_status, verification_attempts, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::varchar, 'IN_PROGRESS'), $8, $9, COALESCE($10::int, 0), CURRENT_TIMESTAMP)
     ON CONFLICT (call_sid) DO UPDATE SET
        caller_phone      = COALESCE(EXCLUDED.caller_phone, call_audit_logs.caller_phone),
        consignment_id    = COALESCE(EXCLUDED.consignment_id, call_audit_logs.consignment_id),
        validation_method = COALESCE(EXCLUDED.validation_method, call_audit_logs.validation_method),
        intent_detected   = COALESCE(EXCLUDED.intent_detected, call_audit_logs.intent_detected),
        duration_seconds  = COALESCE(EXCLUDED.duration_seconds, call_audit_logs.duration_seconds),
        -- $7 (not EXCLUDED) so the 'IN_PROGRESS' insert default never overwrites a final disposition.
        disposition       = COALESCE($7::varchar, call_audit_logs.disposition),
        escalation_reason = COALESCE(EXCLUDED.escalation_reason, call_audit_logs.escalation_reason),
        verification_status   = COALESCE(EXCLUDED.verification_status, call_audit_logs.verification_status),
        verification_attempts = GREATEST(COALESCE(call_audit_logs.verification_attempts, 0), COALESCE($10::int, 0)),
        updated_at        = CURRENT_TIMESTAMP`,
    [
      callSid,
      v(fields.callerPhone),
      v(fields.consignmentId),
      v(fields.validationMethod),
      v(fields.intentDetected),
      Number.isFinite(fields.durationSeconds) ? Math.round(fields.durationSeconds) : null,
      v(fields.disposition),
      v(fields.escalationReason),
      v(fields.verificationStatus),
      Number.isFinite(fields.verificationAttempts) ? fields.verificationAttempts : null,
    ]
  );
}

/** Called from Twilio's call status callback once the call is over. */
async function finalizeCallAudit(callSid, { durationSeconds, callerPhone }) {
  await query(
    `INSERT INTO call_audit_logs (call_sid, caller_phone, duration_seconds, disposition, verification_status, updated_at)
     VALUES ($1, $2, $3, 'ABANDONED', 'NOT_VERIFIED', CURRENT_TIMESTAMP)
     ON CONFLICT (call_sid) DO UPDATE SET
        duration_seconds = COALESCE(EXCLUDED.duration_seconds, call_audit_logs.duration_seconds),
        -- A call that ended while verification was still pending was never verified.
        verification_status = CASE
            WHEN call_audit_logs.verification_status IS NULL OR call_audit_logs.verification_status = 'PENDING'
            THEN 'NOT_VERIFIED' ELSE call_audit_logs.verification_status END,
        disposition = CASE
            WHEN call_audit_logs.disposition IS NULL OR call_audit_logs.disposition = 'IN_PROGRESS'
            THEN 'ABANDONED' ELSE call_audit_logs.disposition END,
        updated_at = CURRENT_TIMESTAMP`,
    [callSid, callerPhone || null, Number.isFinite(durationSeconds) ? Math.round(durationSeconds) : null]
  );
}

async function logCallEvent(callSid, eventType, detail = {}) {
  if (!callSid) return;
  await query(`INSERT INTO call_events (call_sid, event_type, detail) VALUES ($1, $2, $3)`, [
    callSid,
    eventType,
    JSON.stringify(detail),
  ]);
}

// -----------------------------------------------------------------------------
// Dashboard analytics
// -----------------------------------------------------------------------------

async function getCallMetrics() {
  const { rows } = await query(
    `SELECT
        COUNT(*)::int                                                                   AS total_calls,
        COUNT(*) FILTER (WHERE disposition IS DISTINCT FROM 'IN_PROGRESS')::int         AS completed_calls,
        COUNT(*) FILTER (WHERE disposition = 'IN_PROGRESS')::int                        AS active_calls,
        COUNT(*) FILTER (WHERE disposition IN ('BOT_RESOLVED','CALLER_ENDED'))::int     AS bot_resolved,
        COUNT(*) FILTER (WHERE disposition IN ('AGENT_TRANSFERRED','AGENT_UNAVAILABLE'))::int AS escalated,
        COUNT(*) FILTER (WHERE disposition = 'ABANDONED')::int                          AS abandoned,
        COALESCE(ROUND(AVG(duration_seconds) FILTER (WHERE duration_seconds IS NOT NULL)), 0)::int AS aht_seconds,
        COUNT(*) FILTER (WHERE ${VERIFICATION_SQL} = 'VERIFIED')::int                   AS validated,
        COUNT(*) FILTER (WHERE ${VERIFICATION_SQL} IN ('VERIFIED','NOT_VERIFIED'))::int AS validation_attempts,
        COUNT(*) FILTER (WHERE ${VERIFICATION_SQL} = 'NOT_VERIFIED')::int               AS not_verified,
        COUNT(*) FILTER (WHERE ${VERIFICATION_SQL} = 'PENDING')::int                    AS verification_pending
       FROM call_audit_logs`
  );
  return rows[0];
}

async function getIntentDistribution() {
  const { rows } = await query(
    `SELECT detail->>'intent' AS intent, COUNT(*)::int AS count
       FROM call_events
      WHERE event_type = 'INTENT' AND detail ? 'intent'
      GROUP BY 1
      ORDER BY 2 DESC`
  );
  return rows;
}

async function getConsignmentStatusBreakdown() {
  const { rows } = await query(
    `SELECT status, COUNT(*)::int AS count
       FROM consignments
      WHERE is_active = TRUE
      GROUP BY status
      ORDER BY status`
  );
  return rows;
}

async function getEscalationReasons() {
  const { rows } = await query(
    `SELECT escalation_reason AS reason, COUNT(*)::int AS count
       FROM call_audit_logs
      WHERE escalation_reason IS NOT NULL
      GROUP BY 1
      ORDER BY 2 DESC`
  );
  return rows;
}

const DISPOSITIONS = ['BOT_RESOLVED', 'CALLER_ENDED', 'AGENT_TRANSFERRED', 'AGENT_UNAVAILABLE', 'ABANDONED', 'IN_PROGRESS'];

/** Builds a parameterised WHERE clause from dashboard filters. */
function auditFilterClause({ from, to, disposition, validation, verification, search } = {}) {
  const where = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (/^\d{4}-\d{2}-\d{2}$/.test(from || '')) add('created_at >= ?::date', from);
  if (/^\d{4}-\d{2}-\d{2}$/.test(to || '')) add(`created_at < (?::date + INTERVAL '1 day')`, to);
  if (DISPOSITIONS.includes(disposition)) add('disposition = ?', disposition);
  if (validation === 'ANI') where.push(`validation_method IN ('ANI', 'ANI_MATCH')`);
  else if (/^[A-Z_]{2,30}$/.test(validation || '')) add('validation_method = ?', validation);
  if (VERIFICATION_STATUSES.includes(verification)) add(`${VERIFICATION_SQL} = ?`, verification);
  if (search && String(search).trim()) {
    params.push(`%${String(search).trim().slice(0, 60).replace(/[%_\\]/g, '\\$&')}%`);
    const p = `$${params.length}`;
    where.push(
      `(call_sid ILIKE ${p} OR consignment_id ILIKE ${p} OR caller_phone ILIKE ${p}
        OR intent_detected ILIKE ${p} OR escalation_reason ILIKE ${p})`
    );
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

// Sortable audit columns (whitelist -> SQL expression). Never interpolate user input directly.
const AUDIT_SORT_COLUMNS = {
  createdAt: 'created_at',
  updatedAt: 'COALESCE(updated_at, created_at)',
  callSid: 'call_sid',
  callerPhone: 'caller_phone',
  consignmentId: 'consignment_id',
  validationMethod: 'validation_method',
  intentDetected: 'intent_detected',
  durationSeconds: 'duration_seconds',
  disposition: 'disposition',
  escalationReason: 'escalation_reason',
  verificationStatus: VERIFICATION_SQL,
  verificationAttempts: 'COALESCE(verification_attempts, 0)',
};

function auditOrderClause(sort, dir) {
  const column = AUDIT_SORT_COLUMNS[sort] || AUDIT_SORT_COLUMNS.updatedAt;
  const direction = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY ${column} ${direction} NULLS LAST, call_sid ${direction}`;
}

/** Filtered, sorted, paginated audit log with total count. */
async function getAuditLogs({ limit = 25, offset = 0, sort, dir, ...filters } = {}, { maxLimit = 200 } = {}) {
  const { sql, params } = auditFilterClause(filters);
  const lim = Math.min(Math.max(parseInt(limit, 10) || 25, 1), maxLimit);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const [list, count] = await Promise.all([
    query(
      `SELECT call_sid, caller_phone, consignment_id, validation_method, intent_detected,
              duration_seconds, disposition, escalation_reason, created_at, updated_at,
              ${VERIFICATION_SQL} AS verification_status, COALESCE(verification_attempts, 0)::int AS verification_attempts
         FROM call_audit_logs
         ${sql}
        ${auditOrderClause(sort, dir)}
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, lim, off]
    ),
    query(`SELECT COUNT(*)::int AS total FROM call_audit_logs ${sql}`, params),
  ]);
  return { rows: list.rows, total: count.rows[0].total, limit: lim, offset: off };
}

async function getRecentAuditLogs(limit = 25) {
  return (await getAuditLogs({ limit })).rows;
}

async function getCallEvents(callSid) {
  const { rows } = await query(
    `SELECT event_type, detail, created_at FROM call_events WHERE call_sid = $1 ORDER BY id ASC`,
    [callSid]
  );
  return rows;
}

// -----------------------------------------------------------------------------
// Deliveries (consignment tracking view for the dashboard)
// -----------------------------------------------------------------------------

const CONSIGNMENT_STATUSES = ['DISPATCHED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERY_ATTEMPTED', 'DELIVERED'];
const STATUS_ORDER_SQL = `CASE c.status ${CONSIGNMENT_STATUSES.map((s, i) => `WHEN '${s}' THEN ${i}`).join(' ')} ELSE 99 END`;

const CONSIGNMENT_SORT_COLUMNS = {
  consignmentId: 'c.consignment_id',
  issuer: 'c.issuer',
  itemType: 'c.item_type',
  status: STATUS_ORDER_SQL,
  expectedDeliveryDate: 'c.expected_delivery_date',
  lastLocation: 'c.last_location',
  attemptCount: 'attempt_count',
  lastAttemptAt: 'a.last_attempt_at',
  createdAt: 'c.created_at',
};

/** Parameterised WHERE for the deliveries view. `skipStatus` is used for the status tiles. */
function consignmentFilterClause({ search, status, kind, issuer, active = 'active' } = {}, { skipStatus = false } = {}) {
  const where = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace(/\?/g, `$${params.length}`));
  };
  if (!skipStatus && CONSIGNMENT_STATUSES.includes(status)) add('c.status = ?', status);
  if (kind === 'SIM') where.push(`c.item_type ILIKE '%SIM%'`);
  if (kind === 'CARD') where.push(`c.item_type NOT ILIKE '%SIM%'`);
  if (issuer && String(issuer).length <= 50) add('c.issuer = ?', String(issuer));
  if (active === 'active') where.push('c.is_active = TRUE');
  if (active === 'inactive') where.push('c.is_active = FALSE');
  if (search && String(search).trim()) {
    add(
      `(c.consignment_id ILIKE ? OR c.issuer ILIKE ? OR c.item_type ILIKE ? OR c.last_location ILIKE ? OR c.status ILIKE ?)`,
      `%${String(search).trim().slice(0, 60).replace(/[%_\\]/g, '\\$&')}%`
    );
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/** Paginated consignments with their latest delivery attempt and attempt count. */
async function getConsignments({ limit = 25, offset = 0, sort, dir, ...filters } = {}, { maxLimit = 200 } = {}) {
  const { sql, params } = consignmentFilterClause(filters);
  const lim = Math.min(Math.max(parseInt(limit, 10) || 25, 1), maxLimit);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const column = CONSIGNMENT_SORT_COLUMNS[sort] || CONSIGNMENT_SORT_COLUMNS.status;
  const direction = String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';

  const [list, count] = await Promise.all([
    query(
      `SELECT c.consignment_id, c.customer_phone, c.issuer, c.item_type, c.masked_number, c.status,
              c.expected_delivery_date, c.last_location, c.failure_reason, c.is_active, c.created_at,
              COALESCE(a.attempt_count, 0)::int AS attempt_count,
              a.last_attempt_at, a.last_failure_reason, a.next_attempt_date
         FROM consignments c
         LEFT JOIN LATERAL (
              SELECT COUNT(*) OVER () AS attempt_count,
                     d.attempt_timestamp AS last_attempt_at,
                     d.failure_reason    AS last_failure_reason,
                     d.next_attempt_date
                FROM delivery_attempts d
               WHERE d.consignment_id = c.consignment_id
               ORDER BY d.attempt_timestamp DESC
               LIMIT 1
         ) a ON TRUE
         ${sql}
        ORDER BY ${column} ${direction} NULLS LAST, c.expected_delivery_date ASC NULLS LAST, c.consignment_id ASC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, lim, off]
    ),
    query(`SELECT COUNT(*)::int AS total FROM consignments c ${sql}`, params),
  ]);
  return { rows: list.rows, total: count.rows[0].total, limit: lim, offset: off };
}

/** Status tile counts (ignoring the status filter) + issuer list for the filter dropdown. */
async function getConsignmentSummary(filters = {}) {
  const { sql, params } = consignmentFilterClause(filters, { skipStatus: true });
  const [statuses, issuers, kinds] = await Promise.all([
    query(`SELECT c.status, COUNT(*)::int AS count FROM consignments c ${sql} GROUP BY c.status`, params),
    query(
      `SELECT DISTINCT issuer FROM consignments
        WHERE ($1::text IS NULL)
           OR ($1 = 'SIM' AND item_type ILIKE '%SIM%')
           OR ($1 = 'CARD' AND item_type NOT ILIKE '%SIM%')
        ORDER BY issuer`,
      [['SIM', 'CARD'].includes(filters.kind) ? filters.kind : null]
    ),
    query(
      `SELECT CASE WHEN item_type ILIKE '%SIM%' THEN 'SIM' ELSE 'CARD' END AS kind, COUNT(*)::int AS count
         FROM consignments WHERE is_active = TRUE GROUP BY 1`
    ),
  ]);
  return { statuses: statuses.rows, issuers: issuers.rows.map((r) => r.issuer), activeByKind: kinds.rows };
}

/** One consignment with its full attempt history and the calls made about it. */
async function getConsignmentDetail(consignmentId) {
  const { rows } = await query(
    `SELECT consignment_id, customer_phone, issuer, item_type, masked_number, status, expected_delivery_date,
            last_location, failure_reason, is_active, created_at
       FROM consignments WHERE consignment_id = $1`,
    [consignmentId]
  );
  if (!rows.length) return null;
  const [attempts, calls] = await Promise.all([
    getAttemptHistory(consignmentId),
    query(
      `SELECT call_sid, caller_phone, validation_method, intent_detected, duration_seconds, disposition,
              escalation_reason, created_at, updated_at,
              ${VERIFICATION_SQL} AS verification_status, COALESCE(verification_attempts, 0)::int AS verification_attempts
         FROM call_audit_logs WHERE consignment_id = $1
        ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 25`,
      [consignmentId]
    ),
  ]);
  return { consignment: rows[0], attempts, calls: calls.rows };
}

/** Applies db/app_extensions.sql (idempotent): call_events, updated_at, lookup indexes. */
async function ensureAppSchema() {
  const sql = require('fs').readFileSync(require('path').join(__dirname, '..', 'db', 'app_extensions.sql'), 'utf8');
  await query(sql);
}

async function ping() {
  const { rows } = await query('SELECT current_database() AS database, NOW() AS server_time');
  return rows[0];
}

async function close() {
  await pool.end();
}

module.exports = {
  pool,
  query,
  normalizeDob,
  lookupByPhone,
  lookupByConsignmentNumber,
  verifyByDob,
  getAttemptHistory,
  upsertCallAudit,
  finalizeCallAudit,
  logCallEvent,
  getCallMetrics,
  getIntentDistribution,
  getConsignmentStatusBreakdown,
  getEscalationReasons,
  DISPOSITIONS,
  VERIFICATION_STATUSES,
  getAuditLogs,
  getRecentAuditLogs,
  getCallEvents,
  CONSIGNMENT_STATUSES,
  getConsignments,
  getConsignmentSummary,
  getConsignmentDetail,
  ensureAppSchema,
  ping,
  close,
};
