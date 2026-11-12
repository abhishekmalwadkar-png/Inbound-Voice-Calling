'use strict';

/**
 * Converts consignment records into plain, reassuring customer language and
 * masked JSON views. Internal status / failure codes are never spoken.
 */

const { settings } = require('../utils/requestContext');
const f = require('../utils/formatters');

const FAILURE_REASONS = {
  PREMISES_LOCKED: 'the customer premises was locked and unavailable',
  CUSTOMER_UNAVAILABLE: 'no one was available at the delivery address to receive it',
  CUSTOMER_NOT_AVAILABLE: 'no one was available at the delivery address to receive it',
  ID_PROOF_UNAVAILABLE: 'a valid government photo ID could not be produced at the time of delivery',
  RECIPIENT_MISMATCH: 'the person available was not authorised to receive this delivery',
  ADDRESS_INCOMPLETE: 'the delivery address was incomplete and our agent could not locate the premises',
  ADDRESS_NOT_FOUND: 'our agent could not locate the delivery address',
  CUSTOMER_REFUSED: 'the delivery was declined at the address',
  PHONE_UNREACHABLE: 'our agent could not reach you on your registered phone number',
  OFFICE_CLOSED: 'the office address was closed at the time of delivery',
  ACCESS_RESTRICTED: 'our agent was not permitted entry to the premises',
  WEATHER_DELAY: 'severe weather conditions prevented the delivery',
};

const ACTION_REQUIRED =
  'An adult must be present with a valid government photo ID, such as an Aadhaar card, passport, voter ID, or driving licence, to receive it.';

function plainFailureReason(code) {
  if (!code) return 'the delivery could not be completed';
  const key = String(code).trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (FAILURE_REASONS[key]) return FAILURE_REASONS[key];
  // Free-text reasons entered by operations are already plain language.
  if (/\s/.test(String(code).trim())) return String(code).trim().replace(/\.$/, '');
  return `of an issue at the delivery address`;
}

function windowText() {
  return `between ${settings().deliveryWindow}`;
}

/** Masked, customer-safe JSON representation. Never includes DOB or full phone. */
function toPublicConsignment(c) {
  if (!c) return null;
  const digits = f.last4(c.masked_number);
  return {
    consignmentId: c.consignment_id,
    issuer: c.issuer,
    itemType: c.item_type,
    itemLabel: f.itemNoun(c.item_type),
    itemKind: f.itemKind(c.item_type),
    last4: digits,
    maskedNumber: f.itemKind(c.item_type) === 'SIM' ? `XXXXXXXXXXXXXXX${digits}` : `XXXX XXXX XXXX ${digits}`,
    status: c.status,
    statusLabel: f.statusLabel(c.status),
    expectedDeliveryDate: c.expected_delivery_date || null,
    lastLocation: c.last_location || null,
    isActive: c.is_active !== false,
  };
}

function itemSentence(c) {
  return `${c.issuer} ${f.itemNoun(c.item_type)} ending in ${f.spellDigits(f.last4(c.masked_number))}`;
}

function welcomeSingle(c) {
  return `Welcome to CCD Delivery Helpline. We found your ${c.issuer} ${f.itemNoun(c.item_type)} delivery ending in ${f.spellDigits(
    f.last4(c.masked_number)
  )}.`;
}

function disambiguationMenu(candidates) {
  const options = candidates.map((c, i) => `press ${i + 1} for your ${itemSentence(c)}`);
  const sentence = f.joinOptions(options);
  return `We found multiple deliveries for this number. ${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

function nextAttemptSentence(dateValue, ordinalNumber) {
  const when = f.dayName(dateValue);
  if (!when) return 'Our team will schedule another delivery attempt shortly.';
  const label = ordinalNumber ? `A ${f.ordinal(ordinalNumber)} attempt` : 'The next delivery attempt';
  return `${label} is scheduled for ${when} ${windowText()}.`;
}

function failedAttemptSentence(attempt) {
  const day = f.dayPhrase(attempt.attempt_timestamp);
  const time = f.timePhrase(attempt.attempt_timestamp);
  return `Our delivery agent attempted delivery ${day} at ${time}, but ${plainFailureReason(attempt.failure_reason)}.`;
}

// -----------------------------------------------------------------------------
// Intent answers
// -----------------------------------------------------------------------------

function buildStatusText(c, attempts = []) {
  const item = `${c.issuer} ${f.itemNoun(c.item_type)}`;
  const when = f.dayPhrase(c.expected_delivery_date);
  const location = c.last_location ? ` from our ${c.last_location}` : '';

  switch (c.status) {
    case 'DISPATCHED':
      return `Your ${item} has been dispatched${location} and is on its way to you.${when ? ` It is expected to be delivered ${when}.` : ''}`;
    case 'IN_TRANSIT':
      return `Your ${item} is in transit and moving through our network${c.last_location ? `. It was last scanned at our ${c.last_location}` : ''}.${
        when ? ` It is expected to be delivered ${when}.` : ''
      }`;
    case 'OUT_FOR_DELIVERY':
      return `Good news. Your ${item} is out for delivery today and our delivery agent will reach you ${windowText()}. ${ACTION_REQUIRED}`;
    case 'DELIVERY_ATTEMPTED': {
      const latest = attempts[0];
      const intro = `We tried to deliver your ${item}, but the delivery could not be completed.`;
      if (!latest) return `${intro} ${nextAttemptSentence(c.expected_delivery_date)} ${ACTION_REQUIRED}`;
      return `${intro} ${failedAttemptSentence(latest)} ${nextAttemptSentence(
        latest.next_attempt_date || c.expected_delivery_date,
        attempts.length + 1
      )} ${ACTION_REQUIRED}`;
    }
    case 'DELIVERED':
      return `Your ${item} has been delivered${when ? ` ${when}` : ''}. If you have not received it, press 9 to speak with a representative.`;
    default:
      return `Your ${item} is being processed by our team.${when ? ` It is expected to be delivered ${when}.` : ''}`;
  }
}

function buildEddText(c, attempts = []) {
  const item = `${c.issuer} ${f.itemNoun(c.item_type)}`;
  const when = f.dayPhrase(c.expected_delivery_date);

  switch (c.status) {
    case 'DELIVERED':
      return `Your ${item} has already been delivered${when ? ` ${when}` : ''}.`;
    case 'OUT_FOR_DELIVERY':
      return `Your ${item} is out for delivery and is expected to reach you today, ${windowText()}.`;
    case 'DELIVERY_ATTEMPTED': {
      const latest = attempts[0];
      return nextAttemptSentence(latest ? latest.next_attempt_date || c.expected_delivery_date : c.expected_delivery_date, attempts.length + 1);
    }
    default:
      return when
        ? `Your ${item} is expected to be delivered ${when}, ${windowText()}.`
        : `Your ${item} is on its way. We will share the delivery date as soon as it is confirmed.`;
  }
}

function buildExceptionDetails(c, attempts = []) {
  const item = `${c.issuer} ${f.itemNoun(c.item_type)}`;
  const latest = attempts[0] || null;
  const nextAttemptDate =
    c.status === 'DELIVERED' ? null : (latest && latest.next_attempt_date) || (c.status === 'DELIVERY_ATTEMPTED' ? c.expected_delivery_date : null);

  let spokenText;
  if (!latest) {
    spokenText = `There have been no unsuccessful delivery attempts for your ${item}. ${buildStatusText(c, attempts)}`;
  } else {
    const parts = [failedAttemptSentence(latest)];
    if (attempts.length > 1) {
      const earlier = attempts[1];
      parts.push(
        `This was the ${f.ordinal(attempts.length)} attempt. An earlier attempt ${f.dayPhrase(earlier.attempt_timestamp)} at ${f.timePhrase(
          earlier.attempt_timestamp
        )} was also unsuccessful because ${plainFailureReason(earlier.failure_reason)}.`
      );
    }
    if (c.status === 'DELIVERED') {
      parts.push(`Your ${item} was subsequently delivered${f.dayPhrase(c.expected_delivery_date) ? ` ${f.dayPhrase(c.expected_delivery_date)}` : ''}.`);
    } else {
      parts.push(nextAttemptSentence(nextAttemptDate, attempts.length + 1));
      parts.push('Please ensure an adult with valid government photo ID is present to receive it.');
      parts.push('To reschedule delivery or speak with a representative, press 9.');
    }
    spokenText = parts.join(' ');
  }

  return {
    consignmentId: c.consignment_id,
    status: c.status,
    statusLabel: f.statusLabel(c.status),
    attemptCount: attempts.length,
    attemptTimestamp: latest ? latest.attempt_timestamp : null,
    failureReasonCode: latest ? latest.failure_reason : c.failure_reason || null,
    failureReason: latest ? plainFailureReason(latest.failure_reason) : null,
    nextAttemptDate,
    deliveryWindow: settings().deliveryWindow,
    actionRequired: c.status === 'DELIVERED' ? null : 'An adult with valid government photo ID must be present to receive the delivery.',
    attemptHistory: attempts.map((a) => ({
      attemptTimestamp: a.attempt_timestamp,
      failureReasonCode: a.failure_reason,
      failureReason: plainFailureReason(a.failure_reason),
      nextAttemptDate: a.next_attempt_date,
    })),
    spokenText,
  };
}

function buildExceptionText(c, attempts = []) {
  return buildExceptionDetails(c, attempts).spokenText;
}

function buildActionText(c, attempts = []) {
  const item = `${c.issuer} ${f.itemNoun(c.item_type)}`;
  if (c.status === 'DELIVERED') {
    return `Your ${item} has already been delivered, so no action is needed. If you have not received it, press 9 to speak with a representative.`;
  }
  let schedule;
  if (c.status === 'DELIVERY_ATTEMPTED') {
    const latest = attempts[0];
    schedule = nextAttemptSentence(latest ? latest.next_attempt_date || c.expected_delivery_date : c.expected_delivery_date, attempts.length + 1);
  } else if (c.status === 'OUT_FOR_DELIVERY') {
    schedule = `Your ${item} is out for delivery today, ${windowText()}.`;
  } else {
    const when = f.dayPhrase(c.expected_delivery_date);
    schedule = when ? `Your ${item} is expected ${when}, ${windowText()}.` : '';
  }
  return `${ACTION_REQUIRED} Since this is a secure financial or telecom delivery, it cannot be left with a neighbour or security guard. ${schedule} To reschedule delivery or speak with a representative, press 9.`
    .replace(/\s+/g, ' ')
    .trim();
}

function buildAnswer(intent, c, attempts) {
  switch (intent) {
    case 'EDD':
      return buildEddText(c, attempts);
    case 'EXCEPTION':
      return buildExceptionText(c, attempts);
    case 'ACTION':
      return buildActionText(c, attempts);
    case 'STATUS':
    default:
      return buildStatusText(c, attempts);
  }
}

module.exports = {
  ACTION_REQUIRED,
  plainFailureReason,
  toPublicConsignment,
  itemSentence,
  welcomeSingle,
  disambiguationMenu,
  buildStatusText,
  buildEddText,
  buildExceptionDetails,
  buildExceptionText,
  buildActionText,
  buildAnswer,
};
