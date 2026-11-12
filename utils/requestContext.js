'use strict';

/**
 * Per-request runtime settings. Every value below can be supplied by the
 * caller (workflow JSON body, or query string on a Twilio webhook URL); .env
 * values are used only when a field is not passed. Settings passed for a
 * CallSid are remembered on that call's session, so later Twilio <Gather>
 * callbacks in the same call keep using them.
 */

const { AsyncLocalStorage } = require('async_hooks');
const config = require('../config');

const storage = new AsyncLocalStorage();

const E164 = /^\+[1-9]\d{6,14}$/;
const SIP = /^sip:[^\s@]+@[^\s]+$/i;
const URL_RE = /^https?:\/\/[^\s]+$/i;
const PATH_RE = /^\/[^\s]*$/;

/**
 * Field name -> { aliases, validate, normalize }. Field names are what you pass
 * in the request body (or query string).
 */
const FIELDS = {
  voice: { aliases: ['voiceName'], test: (v) => /^[\w.\-]{2,60}$/.test(v), hint: 'e.g. Polly.Kajal-Neural' },
  language: { aliases: ['voiceLanguage'], test: (v) => /^[a-z]{2,3}-[A-Z]{2}$/.test(v), hint: 'e.g. en-IN' },
  agentNumber: {
    aliases: ['destination', 'liveAgentNumber', 'liveAgentPhoneNumber'],
    test: (v) => E164.test(v) || SIP.test(v),
    hint: 'E.164 number (+919876543210) or sip: URI',
  },
  callerId: { aliases: ['twilioPhoneNumber'], test: (v) => E164.test(v), hint: 'E.164 number' },
  dialTimeout: { aliases: ['dialTimeoutSeconds', 'agentDialTimeout'], int: [5, 600], hint: '5-600 seconds' },
  gatherTimeout: { aliases: ['gatherTimeoutSeconds'], int: [1, 60], hint: '1-60 seconds' },
  verifyTimeout: { aliases: ['verifyTimeoutSeconds'], int: [1, 60], hint: '1-60 seconds' },
  confidenceThreshold: { aliases: ['speechConfidenceThreshold'], float: [0, 1], hint: '0-1' },
  deliveryWindow: { aliases: [], test: (v) => v.length >= 3 && v.length <= 80, hint: 'e.g. 10:00 AM and 6:00 PM' },
  baseUrl: { aliases: ['publicBaseUrl'], test: (v) => URL_RE.test(v), hint: 'https://your-public-host' },
  menuActionUrl: { aliases: [], test: (v) => URL_RE.test(v) || PATH_RE.test(v), hint: 'absolute URL or /path' },
  verifyActionUrl: { aliases: [], test: (v) => URL_RE.test(v) || PATH_RE.test(v), hint: 'absolute URL or /path' },
  dialStatusUrl: { aliases: [], test: (v) => URL_RE.test(v) || PATH_RE.test(v), hint: 'absolute URL or /path' },
};

/**
 * Extracts and validates override fields from a body / query object.
 * @returns {{ overrides: object, errors: string[] }}
 */
function parseOverrides(source = {}) {
  const overrides = {};
  const errors = [];
  if (!source || typeof source !== 'object') return { overrides, errors };

  for (const [name, spec] of Object.entries(FIELDS)) {
    const key = [name, ...spec.aliases].find((k) => source[k] !== undefined && source[k] !== null && source[k] !== '');
    if (!key) continue;
    const raw = typeof source[key] === 'string' ? source[key].trim() : source[key];

    if (spec.int || spec.float) {
      const n = spec.int ? parseInt(raw, 10) : parseFloat(raw);
      const [min, max] = spec.int || spec.float;
      if (!Number.isFinite(n) || n < min || n > max) errors.push(`"${key}" must be ${spec.hint}.`);
      else overrides[name] = n;
      continue;
    }
    const value = String(raw);
    if (!spec.test(value)) errors.push(`"${key}" is invalid (${spec.hint}).`);
    else overrides[name] = name === 'baseUrl' ? value.replace(/\/+$/, '') : value;
  }
  return { overrides, errors };
}

function run(overrides, fn) {
  return storage.run({ ...(overrides || {}) }, fn);
}

function current() {
  return storage.getStore() || {};
}

/** Effective settings for the current request: overrides first, then .env. */
function settings() {
  const o = current();
  return {
    voiceName: o.voice || config.voice.name,
    language: o.language || config.voice.language,
    agentNumber: o.agentNumber || config.liveAgentNumber,
    callerId: o.callerId || config.twilio.phoneNumber,
    dialTimeoutSeconds: o.dialTimeout || config.agent.dialTimeoutSeconds,
    gatherTimeoutSeconds: o.gatherTimeout || config.speech.gatherTimeoutSeconds,
    verifyTimeoutSeconds: o.verifyTimeout || config.speech.verifyTimeoutSeconds,
    confidenceThreshold: o.confidenceThreshold !== undefined ? o.confidenceThreshold : config.speech.confidenceThreshold,
    deliveryWindow: o.deliveryWindow || config.business.deliveryWindow,
    baseUrl: o.baseUrl || config.baseUrl,
    menuActionUrl: o.menuActionUrl || '/api/telephony/menu-selection',
    verifyActionUrl: o.verifyActionUrl || '/api/telephony/verify-input',
    dialStatusUrl: o.dialStatusUrl || '/api/telephony/agent-dial-status',
  };
}

module.exports = { FIELDS, parseOverrides, run, current, settings };
