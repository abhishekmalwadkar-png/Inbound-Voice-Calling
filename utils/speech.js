'use strict';

/**
 * Caller input interpretation: DTMF / speech normalisation, intent detection,
 * and parsing of secondary verification input (consignment number or DOB).
 */

const INTENTS = Object.freeze({
  STATUS: 'STATUS',
  EDD: 'EDD',
  EXCEPTION: 'EXCEPTION',
  ACTION: 'ACTION',
  AGENT: 'AGENT',
  RESCHEDULE: 'RESCHEDULE',
  MENU: 'MENU',
  YES: 'YES',
  NO: 'NO',
  UNKNOWN: 'UNKNOWN',
});

const DTMF_INTENTS = {
  1: INTENTS.STATUS,
  2: INTENTS.EDD,
  3: INTENTS.EXCEPTION,
  4: INTENTS.ACTION,
  9: INTENTS.AGENT,
  0: INTENTS.NO,
  '*': INTENTS.MENU,
};

// Ordered: the first matching pattern wins.
const INTENT_PATTERNS = [
  [INTENTS.AGENT, /\b(agent|representative|human|operator|executive|customer (care|service|support)|real person|speak to (someone|a person)|talk to (someone|a person))\b/],
  [INTENTS.RESCHEDULE, /\b(reschedul\w*|change (the )?(delivery )?(date|time|address)|different (date|day|time)|deliver (it )?(later|another day))\b/],
  [INTENTS.EXCEPTION, /\b(why|fail\w*|not (been )?delivered|wasn'?t delivered|was not delivered|didn'?t (get|receive|come|arrive)|missed|attempt\w*|history|tried|undelivered|returned|problem|issue)\b/],
  [INTENTS.ACTION, /\b(next steps?|what (should|do) i (do|need)|what do i have to|documents?|id proof|identity|photo id|proof|requirements?|required|need to (keep|show|have)|collect)\b/],
  [INTENTS.EDD, /\b(when|date|expected|expect|arriv\w*|eta|how long|by when|reach|time|days?)\b/],
  [INTENTS.STATUS, /\b(status|where|track\w*|update|current|progress|delivered|delivery|consignment|parcel|package|card|sim)\b/],
  [INTENTS.MENU, /\b(menu|options|repeat|again|start over)\b/],
];

const NO_PATTERN = /^(no|nope|nah|nothing|no thanks?|no thank you|that'?s (all|it)|that is (all|it)|bye|good ?bye|i'?m (done|good|fine)|nothing else|all good|not now)\b/;
const YES_PATTERN = /^(yes|yeah|yep|yup|sure|ok|okay|haan|ha|please)\b/;

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Classifies a Twilio Gather result.
 * @returns {{kind: 'SILENCE'|'DTMF'|'SPEECH'|'LOW_CONFIDENCE', value: string, confidence: number|null}}
 */
function classifyInput({ digits, speech, confidence }, threshold = 0.4) {
  const d = String(digits || '').trim();
  const s = String(speech || '').trim();
  const conf = confidence === undefined || confidence === null || confidence === '' ? null : Number(confidence);

  if (d) return { kind: 'DTMF', value: d, confidence: null };
  if (!s) return { kind: 'SILENCE', value: '', confidence: conf };
  // Twilio reports 0 for some models when no score is available; only act on real low scores.
  if (Number.isFinite(conf) && conf > 0 && conf < threshold) return { kind: 'LOW_CONFIDENCE', value: s, confidence: conf };
  return { kind: 'SPEECH', value: s, confidence: conf };
}

function intentFromDigit(digit) {
  return DTMF_INTENTS[String(digit).charAt(0)] || INTENTS.UNKNOWN;
}

function detectIntent(text) {
  const t = normalizeText(text);
  if (!t) return INTENTS.UNKNOWN;
  const words = t.split(' ').length;

  // Short closing answers ("no thanks", "that's all") take priority over keyword hits.
  if (words <= 5 && NO_PATTERN.test(t)) return INTENTS.NO;
  for (const [intent, pattern] of INTENT_PATTERNS) {
    if (pattern.test(t)) return intent;
  }
  if (words <= 3 && YES_PATTERN.test(t)) return INTENTS.YES;
  return INTENTS.UNKNOWN;
}

// -----------------------------------------------------------------------------
// Verification input parsing
// -----------------------------------------------------------------------------

const WORD_DIGITS = {
  zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};

const MONTH_LOOKUP = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function wordsToDigits(text) {
  return normalizeText(text)
    .split(' ')
    .map((w) => (WORD_DIGITS[w] !== undefined ? WORD_DIGITS[w] : w))
    .join(' ');
}

function toIsoDate(day, month, year) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1900 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getTime() > Date.now()
  ) {
    return null;
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** "15081990", "15/08/1990", "15th August 1990", "August 15 1990" -> "1990-08-15" */
function parseDob(raw) {
  const text = wordsToDigits(raw);
  const tokens = text.split(' ');
  const monthToken = tokens.find((t) => MONTH_LOOKUP[t]);

  if (monthToken) {
    const month = MONTH_LOOKUP[monthToken];
    const numbers = tokens.map((t) => t.replace(/(st|nd|rd|th)$/, '')).filter((t) => /^\d+$/.test(t));
    const year = numbers.find((n) => n.length === 4);
    const day = numbers.find((n) => n.length <= 2 && +n >= 1 && +n <= 31);
    return year && day ? toIsoDate(+day, month, +year) : null;
  }

  const digits = text.replace(/\D/g, '');
  if (digits.length !== 8) return null;
  return toIsoDate(+digits.slice(0, 2), +digits.slice(2, 4), +digits.slice(4, 8));
}

/** "C C D 1 0 0 1", "ccd-1001", "one zero zero one" -> "CCD1001" / "1001" */
function parseConsignmentNumber(raw) {
  const compact = wordsToDigits(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (/^[A-Z]{2,5}\d{3,15}$/.test(compact) || /^\d{3,15}$/.test(compact)) return compact;
  return null;
}

/**
 * @param {string} raw caller input (digits or transcript)
 * @param {'AUTO'|'CONSIGNMENT'|'DOB'} type
 */
function parseVerificationInput(raw, type = 'AUTO') {
  const kind = String(type || 'AUTO').toUpperCase();
  return {
    consignmentNumber: kind === 'DOB' ? null : parseConsignmentNumber(raw),
    dob: kind === 'CONSIGNMENT' ? null : parseDob(raw),
  };
}

/** Index of the option the caller picked in a disambiguation menu, or -1. */
function matchDisambiguation(text, options, describe) {
  const t = normalizeText(wordsToDigits(text));
  const ordinalWords = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];

  const numeric = t.match(/\b([1-8])\b/);
  if (numeric && +numeric[1] <= options.length) return +numeric[1] - 1;
  const ord = ordinalWords.findIndex((w) => t.includes(w));
  if (ord >= 0 && ord < options.length) return ord;

  const scores = options.map((option) => {
    const words = normalizeText(describe(option)).split(' ').filter((w) => w.length > 2 && w !== 'card' && w !== 'bank');
    let score = words.reduce((acc, w) => acc + (t.includes(w) ? 2 : 0), 0);
    if (/\bsim\b/.test(t) && /SIM/i.test(option.item_type)) score += 3;
    if (/\b(card|credit|debit)\b/.test(t) && !/SIM/i.test(option.item_type)) score += 1;
    if (option.masked_number && t.replace(/\s/g, '').includes(String(option.masked_number))) score += 5;
    return score;
  });
  const best = Math.max(...scores);
  if (best <= 0) return -1;
  return scores.filter((s) => s === best).length === 1 ? scores.indexOf(best) : -1;
}

module.exports = {
  INTENTS,
  classifyInput,
  intentFromDigit,
  detectIntent,
  parseDob,
  parseConsignmentNumber,
  parseVerificationInput,
  matchDisambiguation,
  normalizeText,
};
