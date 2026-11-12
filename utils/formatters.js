'use strict';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const ORDINALS = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];

const ITEM_NOUNS = {
  CREDIT_CARD: 'credit card',
  DEBIT_CARD: 'debit card',
  PREPAID_CARD: 'prepaid card',
  SIM_CARD: 'SIM card',
  SIM: 'SIM card',
};

const STATUS_LABELS = {
  DISPATCHED: 'Dispatched',
  IN_TRANSIT: 'In Transit',
  OUT_FOR_DELIVERY: 'Out for Delivery',
  DELIVERY_ATTEMPTED: 'Delivery Attempted',
  DELIVERED: 'Delivered',
};

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function last10Digits(phone) {
  return digitsOnly(phone).slice(-10);
}

/** "+919800000001" -> "+91******0001" */
function maskPhone(phone) {
  const raw = String(phone || '');
  if (raw.length < 6) return raw;
  return raw.slice(0, 3) + '*'.repeat(Math.max(raw.length - 7, 2)) + raw.slice(-4);
}

function last4(maskedNumber) {
  return digitsOnly(maskedNumber).slice(-4);
}

/** "4821" -> "4 8 2 1" so Polly reads digits individually. */
function spellDigits(value) {
  return String(value || '').split('').join(' ');
}

function itemNoun(itemType) {
  const key = String(itemType || '').toUpperCase().replace(/[\s-]+/g, '_');
  if (ITEM_NOUNS[key]) return ITEM_NOUNS[key];
  if (key.includes('SIM')) return 'SIM card';
  return String(itemType || 'card').toLowerCase().replace(/_/g, ' ');
}

function itemKind(itemType) {
  return /SIM/i.test(String(itemType)) ? 'SIM' : 'CARD';
}

function describeItem(consignment) {
  return `${consignment.issuer} ${itemNoun(consignment.item_type)}`;
}

function statusLabel(status) {
  return STATUS_LABELS[status] || String(status || 'Unknown').replace(/_/g, ' ');
}

function ordinal(n) {
  return ORDINALS[n] || `number ${n}`;
}

/** Parses "YYYY-MM-DD" or "YYYY-MM-DD HH:MM[:SS]" into a local Date (no TZ shift). */
function parseLocalDateTime(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dayDiffFromToday(value) {
  const date = parseLocalDateTime(value);
  if (!date) return null;
  return Math.round((startOfDay(date) - startOfDay(new Date())) / 86400000);
}

/** "today" | "tomorrow" | "yesterday" | "on Friday, 14 November" */
function dayPhrase(value) {
  const date = parseLocalDateTime(value);
  if (!date) return null;
  const diff = dayDiffFromToday(value);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  return `on ${WEEKDAYS[date.getDay()]}, ${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/** Same as dayPhrase but without the leading "on" (for "scheduled for ..."). */
function dayName(value) {
  const phrase = dayPhrase(value);
  return phrase ? phrase.replace(/^on /, '') : null;
}

/** "2026-11-11 14:30:00" -> "2:30 PM" */
function timePhrase(value) {
  const date = parseLocalDateTime(value);
  if (!date) return null;
  const h = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${minutes} ${h < 12 ? 'AM' : 'PM'}`;
}

function joinOptions(parts, conjunction = 'or') {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')}, ${conjunction} ${parts[parts.length - 1]}`;
}

module.exports = {
  STATUS_LABELS,
  digitsOnly,
  last10Digits,
  maskPhone,
  last4,
  spellDigits,
  itemNoun,
  itemKind,
  describeItem,
  statusLabel,
  ordinal,
  parseLocalDateTime,
  dayDiffFromToday,
  dayPhrase,
  dayName,
  timePhrase,
  joinOptions,
};
