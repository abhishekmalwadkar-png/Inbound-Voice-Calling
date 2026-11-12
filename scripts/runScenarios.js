'use strict';

/**
 * End-to-end runner for the 13 mandatory test scenarios (PPT slides 13 & 14).
 * Drives the running server exactly like Twilio would (form-encoded webhooks)
 * and asserts on the TwiML returned at each turn, then exercises the workflow
 * REST endpoints.
 *
 *   npm start                    # in one terminal
 *   npm run test:scenarios       # in another (expects db:init seed data)
 *
 * Optional: SCENARIO_BASE_URL=http://localhost:8001
 */

const crypto = require('crypto');
const config = require('../config');

const BASE = (process.env.SCENARIO_BASE_URL || `http://localhost:${config.port}`).replace(/\/+$/, '');
const PREFIX = 'CATEST';

const results = [];

function sid() {
  return `${PREFIX}${crypto.randomBytes(14).toString('hex')}`;
}

async function webhook(path, fields) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(Object.entries(fields).filter(([, v]) => v !== undefined)),
  });
  return { status: res.status, body: await res.text() };
}

async function api(path, payload) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, json: await res.json() };
}

function expect(cond, message) {
  if (!cond) throw new Error(message);
}

function expectXml(xml, patterns) {
  for (const p of [].concat(patterns)) {
    expect(p.test(xml), `expected TwiML to match ${p}\n--- got ---\n${xml}`);
  }
}

/** Places a simulated call and runs each turn: [endpoint, fields, expectedPatterns]. */
async function callFlow(from, turns) {
  const callSid = sid();
  const base = { CallSid: callSid, From: from, To: '+10000000000', Direction: 'inbound' };
  const transcript = [];
  for (const [endpoint, fields, patterns] of turns) {
    const { body } = await webhook(`/api/telephony/${endpoint}`, { ...base, ...fields });
    transcript.push(body);
    expectXml(body, patterns);
  }
  await webhook('/api/telephony/status-callback', { ...base, CallStatus: 'completed', CallDuration: '42' });
  return { callSid, transcript };
}

async function scenario(id, name, fn) {
  try {
    await fn();
    results.push({ id, name, ok: true });
    console.log(`  PASS  ${String(id).padStart(2)}. ${name}`);
  } catch (err) {
    results.push({ id, name, ok: false, error: err.message });
    console.log(`  FAIL  ${String(id).padStart(2)}. ${name}\n        ${err.message.split('\n').join('\n        ')}`);
  }
}

const GATHER = /<Gather[^>]*input="dtmf speech"[^>]*bargeIn="true"/;
const POLLY = new RegExp(`<Say voice="${config.voice.name.replace('.', '\\.')}"`);
const FOLLOW_UP = /anything else I can help you with today/;
const DIAL = /<Dial[^>]*timeout="\d+"[^>]*>.*<\/Dial>/s;

async function main() {
  console.log(`\nCCD scenario runner -> ${BASE}\n`);
  const health = await fetch(`${BASE}/health`).then((r) => r.json()).catch((e) => ({ status: e.message }));
  if (health.status !== 'ok') {
    console.error(`Server/database not healthy: ${JSON.stringify(health)}`);
    process.exit(1);
  }

  await scenario(1, 'Recognized caller -> Dispatched', () =>
    callFlow('+919800000001', [
      ['inbound-call', {}, [GATHER, POLLY, /We found your HDFC Bank credit card delivery ending in 4 8 2 1/, /press 9 to speak with an agent/]],
      ['menu-selection', { Digits: '1' }, [/has been dispatched/, FOLLOW_UP]],
      ['menu-selection', { SpeechResult: 'No thanks', Confidence: '0.9' }, [/Goodbye/, /<Hangup\/>/]],
    ])
  );

  await scenario(2, 'Recognized caller -> In Transit', () =>
    callFlow('+919800000003', [
      ['inbound-call', {}, [/Airtel SIM card delivery ending in 5 5 9 0/]],
      ['menu-selection', { SpeechResult: 'where is my sim', Confidence: '0.88' }, [/is in transit/, FOLLOW_UP]],
      ['menu-selection', { Digits: '2' }, [/expected to be delivered/]],
    ])
  );

  await scenario(3, 'Recognized caller -> Out for Delivery', () =>
    callFlow('+919800000004', [
      ['inbound-call', {}, [/State Bank of India debit card/]],
      ['menu-selection', { Digits: '1' }, [/out for delivery today/, /photo ID/]],
    ])
  );

  await scenario(4, 'Recognized caller -> Delivery Attempted (Failed)', () =>
    callFlow('+919800000002', [
      ['inbound-call', {}, [/ICICI Bank debit card/]],
      ['menu-selection', { Digits: '1' }, [/could not be completed/, /yesterday at 2:30 PM/, /locked and unavailable/]],
    ])
  );

  await scenario(5, 'Recognized caller -> Delivered', () =>
    callFlow('+919800000005', [
      ['inbound-call', {}, [/Jio SIM card/]],
      ['menu-selection', { Digits: '1' }, [/has been delivered yesterday/]],
      ['menu-selection', { Digits: '0' }, [/<Hangup\/>/]],
    ])
  );

  await scenario(6, 'Unknown caller -> consignment number -> verified & resolved', () =>
    callFlow('+919999900006', [
      ['inbound-call', {}, [/could not find a delivery/, /consignment tracking number/, /verify-input/]],
      ['verify-input', { Digits: '1008' }, [/details have been verified/, /Kotak Mahindra Bank credit card ending in 2 4 6 8/]],
      ['menu-selection', { Digits: '1' }, [/in transit/]],
    ])
  );

  await scenario(7, 'Unknown caller -> DOB -> verified & resolved', () =>
    callFlow('+919999900007', [
      ['inbound-call', {}, [/date of birth/]],
      ['verify-input', { SpeechResult: '15th August 1990' }, [/details have been verified/, /Kotak Mahindra Bank/]],
      ['menu-selection', { Digits: '2' }, [/expected to be delivered/]],
    ])
  );

  await scenario(8, 'Multiple consignments -> selection menu -> resolved', () =>
    callFlow('+919800000006', [
      ['inbound-call', {}, [/multiple deliveries/, /Press 1 for your Axis Bank credit card/, /press 2 for your Vodafone Idea SIM card/]],
      ['menu-selection', { SpeechResult: 'the SIM card please', Confidence: '0.9' }, [/You selected your Vodafone Idea SIM card/]],
      ['menu-selection', { Digits: '1' }, [/out for delivery/]],
    ])
  );

  await scenario(9, 'Delivery exception query -> attempt history spoken', () =>
    callFlow('+919800000010', [
      ['inbound-call', {}, [/Yes Bank credit card/]],
      ['menu-selection', { SpeechResult: "Why wasn't my card delivered yesterday?", Confidence: '0.91' }, [
        /attempted delivery yesterday at 4:45 PM/,
        /photo ID could not be produced/,
        /second attempt|earlier attempt/,
        /third attempt is scheduled for tomorrow between 10:00 AM and 6:00 PM/,
        /press 9/,
      ]],
    ])
  );

  await scenario(10, 'Action required query -> next steps & photo ID', () =>
    callFlow('+919800000002', [
      ['inbound-call', {}, [GATHER]],
      ['menu-selection', { SpeechResult: 'What documents do I need?', Confidence: '0.9' }, [/valid government photo ID/, /scheduled for tomorrow/, /reschedule/]],
    ])
  );

  await scenario(11, 'Direct agent request -> Twilio Dial (with busy fallback)', async () => {
    await callFlow('+919800000001', [
      ['inbound-call', {}, [GATHER]],
      ['menu-selection', { SpeechResult: 'I want to talk to a representative', Confidence: '0.93' }, [/Transferring your call/, DIAL]],
      ['agent-dial-status', { DialCallStatus: 'busy' }, [/All agents are currently busy/, /<Hangup\/>/]],
    ]);
    await callFlow('+919800000003', [
      ['inbound-call', {}, [GATHER]],
      ['menu-selection', { Digits: '9' }, [/Transferring your call/, DIAL]],
    ]);
  });

  await scenario(12, 'Security fallback -> 2x failed verification -> agent', () =>
    callFlow('+919999900012', [
      ['inbound-call', {}, [/consignment tracking number/]],
      ['verify-input', { Digits: '5555' }, [/could not match those details/, /verify-input/]],
      ['verify-input', { Digits: '01011901' }, [/unable to verify your details for security reasons/, /Transferring your call/, DIAL]],
    ])
  );

  await scenario(13, 'Silence / unclear input -> reprompt -> barge-in recovery', async () => {
    await callFlow('+919800000003', [
      ['inbound-call', {}, [GATHER]],
      ['menu-selection', {}, [/did not hear anything/, GATHER]],
      ['menu-selection', { SpeechResult: 'banana weather', Confidence: '0.9' }, [/did not quite understand/, GATHER]],
      ['menu-selection', { SpeechResult: 'when will it arrive', Confidence: '0.9' }, [/expected to be delivered/]],
    ]);
    await callFlow('+919800000003', [
      ['inbound-call', {}, [GATHER]],
      ['menu-selection', { SpeechResult: 'mumble', Confidence: '0.12' }, [/did not quite understand/]],
      ['menu-selection', { SpeechResult: 'gibberish words', Confidence: '0.9' }, [/Transferring your call/, DIAL]],
    ]);
  });

  // Workflow REST API ---------------------------------------------------------
  await scenario('W1', 'Workflow: validate-caller / verify-secondary / status / exception / agent-transfer', async () => {
    const v = await api('/api/workflow/validate-caller', { callerPhone: '+919800000001', callSid: sid() });
    expect(v.status === 200 && v.json.matchType === 'SINGLE' && v.json.callerVerified === true, `validate-caller: ${JSON.stringify(v.json)}`);
    expect(!JSON.stringify(v.json).includes('1985-03-12'), 'validate-caller leaked DOB');
    expect(/<Response>/.test(v.json.twiml), 'validate-caller missing twiml');

    const s1 = await api('/api/workflow/verify-secondary', { callSid: sid(), identifier: '15081990', type: 'DOB', attemptCount: 1 });
    expect(s1.json.verified === true && s1.json.consignment.consignmentId === 'CCD1008', `verify DOB: ${JSON.stringify(s1.json)}`);
    const s2 = await api('/api/workflow/verify-secondary', { callSid: sid(), identifier: 'CCD9999', type: 'CONSIGNMENT', attemptCount: 2 });
    expect(s2.json.verified === false && s2.json.escalateToAgent === true && /<Dial/.test(s2.json.twiml), `verify fail x2: ${JSON.stringify(s2.json)}`);

    const st = await api('/api/workflow/status', { consignmentId: 'CCD1001', intent: 'EDD' });
    expect(st.json.status === 'DISPATCHED' && /expected to be delivered/.test(st.json.spokenText), `status: ${JSON.stringify(st.json)}`);

    const ex = await api('/api/workflow/exception', { consignmentId: 'CCD1002' });
    expect(ex.json.status === 'DELIVERY_ATTEMPTED' && ex.json.nextAttemptDate && /photo ID/.test(ex.json.actionRequired), `exception: ${JSON.stringify(ex.json)}`);

    const at = await api('/api/workflow/agent-transfer', { callSid: sid(), callerPhone: '+919800000001', reason: '2X_VERIFICATION_FAILURE' });
    expect(at.json.action === 'DIAL_AGENT' && /<Dial/.test(at.json.twiml), `agent-transfer: ${JSON.stringify(at.json)}`);

    const nf = await api('/api/workflow/status', { consignmentId: 'NOPE404' });
    expect(nf.status === 404, 'status for unknown consignment should 404');
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);

  if (process.env.KEEP_TEST_DATA !== 'true') {
    const db = require('../services/databaseService');
    const a = await db.query(`DELETE FROM call_audit_logs WHERE call_sid LIKE $1`, [`${PREFIX}%`]);
    await db.query(`DELETE FROM call_events WHERE call_sid LIKE $1`, [`${PREFIX}%`]);
    await db.close();
    console.log(`Removed ${a.rowCount} test audit row(s) (set KEEP_TEST_DATA=true to keep them on the dashboard)\n`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
