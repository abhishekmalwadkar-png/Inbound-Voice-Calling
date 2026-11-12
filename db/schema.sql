-- ==============================================================================
-- CCD Card & SIM Delivery Logistics Database Schema
-- Database: ccd_logistics_db
-- ==============================================================================

-- 1. Consignments Table
CREATE TABLE IF NOT EXISTS consignments (
    consignment_id VARCHAR(50) PRIMARY KEY,
    customer_phone VARCHAR(20) NOT NULL,
    issuer VARCHAR(50) NOT NULL,
    item_type VARCHAR(50) NOT NULL,              -- 'Credit Card', 'Debit Card', 'SIM Card'
    masked_number VARCHAR(10) NOT NULL,          -- e.g., '4821'
    status VARCHAR(50) NOT NULL,                 -- 'DISPATCHED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERY_ATTEMPTED', 'DELIVERED'
    expected_delivery_date VARCHAR(50),
    last_location VARCHAR(100),
    failure_reason TEXT,
    dob VARCHAR(20),                             -- Format: YYYY-MM-DD or DDMMYYYY
    courier_name VARCHAR(100),
    recipient_name VARCHAR(100),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_consignments_phone ON consignments(customer_phone);
CREATE INDEX IF NOT EXISTS idx_consignments_status ON consignments(status);

-- 2. Delivery Attempts Table (History of delivery attempts for exceptions)
CREATE TABLE IF NOT EXISTS delivery_attempts (
    id SERIAL PRIMARY KEY,
    consignment_id VARCHAR(50) REFERENCES consignments(consignment_id) ON DELETE CASCADE,
    attempt_timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    attempt_number INTEGER DEFAULT 1,
    failure_reason TEXT NOT NULL,
    courier_notes TEXT,
    next_attempt_date VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_attempts_consignment_id ON delivery_attempts(consignment_id);

-- 3. Call Audit Logs Table (Logging all Inbound / Outbound interactions)
CREATE TABLE IF NOT EXISTS call_audit_logs (
    call_sid VARCHAR(100) PRIMARY KEY,
    caller_phone VARCHAR(20),
    consignment_id VARCHAR(50),
    validation_method VARCHAR(50),               -- 'ANI_MATCH', 'CONSIGNMENT_NUMBER', 'DOB'
    intent_detected VARCHAR(50),                 -- 'STATUS', 'EDD', 'ATTEMPTS', 'AGENT_TRANSFER'
    duration_seconds INTEGER DEFAULT 0,
    disposition VARCHAR(50) NOT NULL,            -- 'RESOLVED', 'ESCALATED', 'ABANDONED'
    escalation_reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_caller_phone ON call_audit_logs(caller_phone);
CREATE INDEX IF NOT EXISTS idx_audit_disposition ON call_audit_logs(disposition);
