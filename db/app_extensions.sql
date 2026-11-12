-- =============================================================================
-- CCD Voice Automation - application extensions to db/schema.sql
-- Idempotent. Applied by `npm run db:init` and automatically at server start.
-- Adds only what the utility service needs on top of the base schema.
-- =============================================================================

-- Turn-by-turn interaction trail (intent distribution KPI, per-call drill-down).
-- Verification inputs are never stored here in clear text.
CREATE TABLE IF NOT EXISTS call_events (
    id BIGSERIAL PRIMARY KEY,
    call_sid VARCHAR(100) NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    detail JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_call_events_sid ON call_events (call_sid, created_at);
CREATE INDEX IF NOT EXISTS idx_call_events_type ON call_events (event_type);

-- Last-activity timestamp used to order the live audit log and CSV export.
ALTER TABLE call_audit_logs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Caller identity verification outcome per call:
--   VERIFIED      phone matched (ANI / ANI_MULTI) or consignment number / DOB accepted
--   NOT_VERIFIED  failed twice, or the call ended / was transferred before verifying
--   PENDING       verification asked, call still in progress
ALTER TABLE call_audit_logs ADD COLUMN IF NOT EXISTS verification_status VARCHAR(20);
ALTER TABLE call_audit_logs ADD COLUMN IF NOT EXISTS verification_attempts INTEGER DEFAULT 0;

-- One-time backfill for rows written before these columns existed (or by other systems).
UPDATE call_audit_logs
   SET verification_status = CASE
         WHEN validation_method IN ('ANI', 'ANI_MATCH', 'ANI_MULTI', 'CONSIGNMENT', 'CONSIGNMENT_NUMBER', 'DOB') THEN 'VERIFIED'
         WHEN validation_method = 'FAILED' THEN 'NOT_VERIFIED'
         WHEN disposition = 'IN_PROGRESS' THEN 'PENDING'
         ELSE 'NOT_VERIFIED'
       END
 WHERE verification_status IS NULL;
CREATE INDEX IF NOT EXISTS idx_call_audit_verification ON call_audit_logs (verification_status);
CREATE INDEX IF NOT EXISTS idx_call_audit_created ON call_audit_logs (created_at DESC);

-- Caller lookup matches on the last 10 digits so +91 / 0 / bare formats all match.
CREATE INDEX IF NOT EXISTS idx_consignments_phone_digits
    ON consignments (RIGHT(regexp_replace(customer_phone, '[^0-9]', '', 'g'), 10));
CREATE INDEX IF NOT EXISTS idx_delivery_attempts_consignment_ts
    ON delivery_attempts (consignment_id, attempt_timestamp DESC);

-- -----------------------------------------------------------------------------
-- Real-time change notifications for the dashboard.
-- Any INSERT / UPDATE / DELETE / TRUNCATE on these tables (from the app, psql,
-- pgAdmin, an ETL job...) sends NOTIFY ccd_changes '{"table": "..."}'.
-- Statement-level triggers: one notification per statement, not per row.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ccd_notify_change() RETURNS trigger AS $$
BEGIN
    PERFORM pg_notify('ccd_changes', json_build_object('table', TG_TABLE_NAME, 'op', TG_OP)::text);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ccd_notify_audit ON call_audit_logs;
CREATE TRIGGER trg_ccd_notify_audit
    AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON call_audit_logs
    FOR EACH STATEMENT EXECUTE FUNCTION ccd_notify_change();

DROP TRIGGER IF EXISTS trg_ccd_notify_events ON call_events;
CREATE TRIGGER trg_ccd_notify_events
    AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON call_events
    FOR EACH STATEMENT EXECUTE FUNCTION ccd_notify_change();

DROP TRIGGER IF EXISTS trg_ccd_notify_consignments ON consignments;
CREATE TRIGGER trg_ccd_notify_consignments
    AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON consignments
    FOR EACH STATEMENT EXECUTE FUNCTION ccd_notify_change();

DROP TRIGGER IF EXISTS trg_ccd_notify_attempts ON delivery_attempts;
CREATE TRIGGER trg_ccd_notify_attempts
    AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON delivery_attempts
    FOR EACH STATEMENT EXECUTE FUNCTION ccd_notify_change();
