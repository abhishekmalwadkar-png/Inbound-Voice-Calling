-- =============================================================================
-- CCD Voice Automation - UAT / test-scenario seed data
-- Covers the 13 mandatory test scenarios (PPT slides 13 & 14).
-- Dates are relative to CURRENT_DATE so the scenarios stay valid every day.
-- Re-running refreshes the seed rows in place (idempotent).
--
--   Phone            Consignment  Scenario
--   +919800000001    CCD1001      1  Recognized caller - Dispatched
--   +919800000002    CCD1002      4/9/10  Delivery attempted (failed) - exception & next steps
--   +919800000003    CCD1003      2  Recognized caller - In Transit
--   +919800000004    CCD1004      3  Recognized caller - Out for Delivery
--   +919800000005    CCD1005      5  Recognized caller - Delivered
--   +919800000006    CCD1006/7    8  Multiple consignments - disambiguation
--   (any unknown)    CCD1008      6  Verify via consignment number CCD1008 / 1008
--   (any unknown)    CCD1008      7  Verify via DOB 15081990
--   +919800000010    CCD1010      9  Two failed attempts - attempt history
--   +919800000001    CCD1009      (inactive - must never be offered)
-- =============================================================================

INSERT INTO consignments
    (consignment_id, customer_phone, issuer, item_type, masked_number, status,
     expected_delivery_date, last_location, failure_reason, dob, is_active)
VALUES
    ('CCD1001', '+919800000001', 'HDFC Bank',      'CREDIT_CARD', '4821', 'DISPATCHED',
     to_char(CURRENT_DATE + 3, 'YYYY-MM-DD'), 'Mumbai Central Sorting Hub', NULL, '1985-03-12', TRUE),
    ('CCD1002', '+919800000002', 'ICICI Bank',     'DEBIT_CARD',  '7734', 'DELIVERY_ATTEMPTED',
     to_char(CURRENT_DATE + 1, 'YYYY-MM-DD'), 'Andheri East Delivery Centre', 'PREMISES_LOCKED', '1992-11-03', TRUE),
    ('CCD1003', '+919800000003', 'Airtel',         'SIM_CARD',    '5590', 'IN_TRANSIT',
     to_char(CURRENT_DATE + 2, 'YYYY-MM-DD'), 'Pune Regional Hub', NULL, '1988-07-21', TRUE),
    ('CCD1004', '+919800000004', 'State Bank of India', 'DEBIT_CARD', '3307', 'OUT_FOR_DELIVERY',
     to_char(CURRENT_DATE, 'YYYY-MM-DD'), 'Thane West Delivery Centre', NULL, '1979-01-30', TRUE),
    ('CCD1005', '+919800000005', 'Jio',            'SIM_CARD',    '9012', 'DELIVERED',
     to_char(CURRENT_DATE - 1, 'YYYY-MM-DD'), 'Delivered - Bandra West', NULL, '1995-05-18', TRUE),
    ('CCD1006', '+919800000006', 'Axis Bank',      'CREDIT_CARD', '6648', 'IN_TRANSIT',
     to_char(CURRENT_DATE + 2, 'YYYY-MM-DD'), 'Navi Mumbai Sorting Hub', NULL, '1990-09-09', TRUE),
    ('CCD1007', '+919800000006', 'Vodafone Idea',  'SIM_CARD',    '1175', 'OUT_FOR_DELIVERY',
     to_char(CURRENT_DATE, 'YYYY-MM-DD'), 'Vashi Delivery Centre', NULL, '1990-09-09', TRUE),
    ('CCD1008', '+919811111108', 'Kotak Mahindra Bank', 'CREDIT_CARD', '2468', 'IN_TRANSIT',
     to_char(CURRENT_DATE + 2, 'YYYY-MM-DD'), 'Bengaluru Central Hub', NULL, '1990-08-15', TRUE),
    ('CCD1009', '+919800000001', 'HDFC Bank',      'DEBIT_CARD',  '1357', 'DELIVERED',
     to_char(CURRENT_DATE - 120, 'YYYY-MM-DD'), 'Delivered - Dadar', NULL, '1985-03-12', FALSE),
    ('CCD1010', '+919800000010', 'Yes Bank',       'CREDIT_CARD', '8080', 'DELIVERY_ATTEMPTED',
     to_char(CURRENT_DATE + 1, 'YYYY-MM-DD'), 'Powai Delivery Centre', 'ID_PROOF_UNAVAILABLE', '1983-12-25', TRUE)
ON CONFLICT (consignment_id) DO UPDATE SET
    customer_phone = EXCLUDED.customer_phone,
    issuer = EXCLUDED.issuer,
    item_type = EXCLUDED.item_type,
    masked_number = EXCLUDED.masked_number,
    status = EXCLUDED.status,
    expected_delivery_date = EXCLUDED.expected_delivery_date,
    last_location = EXCLUDED.last_location,
    failure_reason = EXCLUDED.failure_reason,
    dob = EXCLUDED.dob,
    is_active = EXCLUDED.is_active;

DELETE FROM delivery_attempts
WHERE consignment_id IN ('CCD1001','CCD1002','CCD1003','CCD1004','CCD1005',
                         'CCD1006','CCD1007','CCD1008','CCD1009','CCD1010');

INSERT INTO delivery_attempts (consignment_id, attempt_timestamp, failure_reason, courier_notes, next_attempt_date)
VALUES
    ('CCD1002', (CURRENT_DATE - 1) + TIME '14:30', 'PREMISES_LOCKED',
     'Door locked, no response on intercom. Neighbour unavailable.', to_char(CURRENT_DATE + 1, 'YYYY-MM-DD')),
    ('CCD1005', (CURRENT_DATE - 3) + TIME '11:10', 'CUSTOMER_UNAVAILABLE',
     'Customer not at home, delivered on reattempt.', to_char(CURRENT_DATE - 1, 'YYYY-MM-DD')),
    ('CCD1010', (CURRENT_DATE - 3) + TIME '11:15', 'CUSTOMER_UNAVAILABLE',
     'No one available at address.', to_char(CURRENT_DATE - 1, 'YYYY-MM-DD')),
    ('CCD1010', (CURRENT_DATE - 1) + TIME '16:45', 'ID_PROOF_UNAVAILABLE',
     'Recipient present but could not produce photo ID.', to_char(CURRENT_DATE + 1, 'YYYY-MM-DD'));
