'use strict';

/**
 * Modular TwiML builder. All prompts are spoken with Amazon Polly via Twilio
 * <Say voice="Polly.*">, and every prompt that expects a reply is placed inside
 * a barge-in enabled <Gather> so the caller can interrupt at any time.
 */

const twilio = require('twilio');
const { settings } = require('./requestContext');

const { VoiceResponse } = twilio.twiml;

const SPEECH_HINTS =
  'status, delivery status, expected delivery date, when will it arrive, attempt history, why was it not delivered, ' +
  'documents required, next steps, agent, representative, human, reschedule, yes, no, credit card, debit card, SIM card';

function absoluteUrl(pathOrUrl) {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${settings().baseUrl}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
}

function sayAttributes() {
  const s = settings();
  return { voice: s.voiceName, language: s.language };
}

function toList(prompts) {
  return (Array.isArray(prompts) ? prompts : [prompts]).filter((p) => typeof p === 'string' && p.trim());
}

function addSay(node, prompts) {
  toList(prompts).forEach((text) => node.say(sayAttributes(), text.trim()));
}

function isE164(value) {
  return /^\+[1-9]\d{6,14}$/.test(String(value || '').trim());
}

/**
 * <Gather input="dtmf speech" bargeIn="true"> with the prompts nested inside.
 * actionOnEmptyResult makes Twilio call the action on silence, so the
 * application decides how to reprompt.
 */
function gather({ prompts, action, numDigits, timeout, finishOnKey, hints = SPEECH_HINTS }) {
  const response = new VoiceResponse();
  const attrs = {
    input: 'dtmf speech',
    bargeIn: true,
    timeout: timeout || settings().gatherTimeoutSeconds,
    speechTimeout: 'auto',
    language: settings().language,
    action: absoluteUrl(action),
    method: 'POST',
    actionOnEmptyResult: true,
    profanityFilter: true,
  };
  if (numDigits) attrs.numDigits = numDigits;
  if (finishOnKey) attrs.finishOnKey = finishOnKey;
  if (hints) attrs.hints = hints;

  const node = response.gather(attrs);
  addSay(node, prompts);
  return response.toString();
}

/** Announcement followed by <Dial> to the live agent queue. */
function transferToAgent({ prompts, action }) {
  const s = settings();
  const response = new VoiceResponse();
  addSay(response, prompts);

  const dialAttrs = {
    timeout: s.dialTimeoutSeconds,
    action: absoluteUrl(action || s.dialStatusUrl),
    method: 'POST',
  };
  if (isE164(s.callerId)) dialAttrs.callerId = s.callerId;

  const dial = response.dial(dialAttrs);
  const destination = String(s.agentNumber || '').trim();
  if (/^sip:/i.test(destination)) dial.sip(destination);
  else dial.number(destination);

  return response.toString();
}

/** Speak and end the call. */
function hangup(prompts) {
  const response = new VoiceResponse();
  addSay(response, prompts);
  response.hangup();
  return response.toString();
}

/** Speak only (used inside workflow responses that append their own verbs). */
function say(prompts) {
  const response = new VoiceResponse();
  addSay(response, prompts);
  return response.toString();
}

module.exports = {
  absoluteUrl,
  gather,
  transferToAgent,
  hangup,
  say,
  isE164,
};
