'use strict';

/**
 * OpenAPI 3.0 specification for the CCD Voice Automation utility service.
 * Served as Swagger UI at /api-docs and as raw JSON at /api-docs.json.
 */

const config = require('../config');

// -----------------------------------------------------------------------------
// Reusable fragments
// -----------------------------------------------------------------------------

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const jsonBody = (schemaName, examples) => ({
  required: true,
  content: { 'application/json': { schema: ref(schemaName), ...(examples ? { examples } : {}) } },
});
const jsonResponse = (description, schemaName, example) => ({
  description,
  content: { 'application/json': { schema: ref(schemaName), ...(example ? { example } : {}) } },
});
const twimlResponse = (description, example) => ({
  description,
  content: { 'text/xml': { schema: { type: 'string', description: 'TwiML document' }, example } },
});
const formBody = (schemaName, example) => ({
  required: true,
  content: { 'application/x-www-form-urlencoded': { schema: ref(schemaName), ...(example ? { example } : {}) } },
});

const R400 = { $ref: '#/components/responses/BadRequest' };
const R401 = { $ref: '#/components/responses/Unauthorized' };
const R500 = { $ref: '#/components/responses/WorkflowError' };
const R503DB = { $ref: '#/components/responses/DatabaseUnavailable' };

/** Call settings accepted as query parameters on Twilio webhooks. */
const SETTINGS_QUERY = [
  ['voice', 'string', 'Polly.Kajal-Neural', 'Twilio <Say> voice.'],
  ['language', 'string', 'en-IN', 'Voice and speech-recognition language.'],
  ['agentNumber', 'string', '+919876543210', 'Live agent number (E.164) or sip: URI.'],
  ['callerId', 'string', '+15550001111', 'Caller ID used when dialling the agent.'],
  ['dialTimeout', 'integer', 25, 'Agent ring timeout, 5-600 s.'],
  ['gatherTimeout', 'integer', 4, 'Menu silence timeout, 1-60 s.'],
  ['verifyTimeout', 'integer', 6, 'Verification silence timeout, 1-60 s.'],
  ['confidenceThreshold', 'number', 0.4, 'Speech below this confidence is treated as unclear (0-1).'],
  ['deliveryWindow', 'string', '10:00 AM and 6:00 PM', 'Delivery window spoken to the caller.'],
  ['baseUrl', 'string', 'https://xxxx.ngrok-free.app', 'Public host used in TwiML callback URLs.'],
  ['menuActionUrl', 'string', '/api/telephony/menu-selection', 'Where Twilio posts menu <Gather> results.'],
  ['verifyActionUrl', 'string', '/api/telephony/verify-input', 'Where Twilio posts verification <Gather> results.'],
  ['dialStatusUrl', 'string', '/api/telephony/agent-dial-status', 'Where Twilio posts the <Dial> outcome.'],
].map(([name, type, example, description]) => ({ name, in: 'query', required: false, description, schema: { type }, example }));

const SETTINGS_NOTE =
  'All **call settings** (`voice`, `language`, `agentNumber`, `callerId`, timeouts, `deliveryWindow`, `baseUrl`, action URLs) are optional; ' +
  '`.env` is the fallback. Settings sent with a `callSid` are remembered for the rest of that call.';

const SAMPLE_TWIML_MENU =
  '<?xml version="1.0" encoding="UTF-8"?><Response><Gather input="dtmf speech" bargeIn="true" timeout="4" speechTimeout="auto" ' +
  'language="en-IN" action="https://host/api/telephony/menu-selection" method="POST" actionOnEmptyResult="true" numDigits="1">' +
  '<Say voice="Polly.Kajal" language="en-IN">Welcome to CCD Delivery Helpline. We found your HDFC Bank credit card delivery ending in 4 8 2 1.</Say>' +
  '<Say voice="Polly.Kajal" language="en-IN">You can ask for current status, expected delivery date, past attempt history, or press 9 to speak with an agent.</Say>' +
  '</Gather></Response>';

const SAMPLE_TWIML_DIAL =
  '<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Kajal" language="en-IN">Transferring your call to a customer care representative. ' +
  'Please stay on the line.</Say><Dial timeout="25" action="https://host/api/telephony/agent-dial-status" method="POST" callerId="+15550001111">' +
  '<Number>+919876543210</Number></Dial></Response>';

const SAMPLE_CONSIGNMENT = {
  consignmentId: 'CCD1001',
  issuer: 'HDFC Bank',
  itemType: 'CREDIT_CARD',
  itemLabel: 'credit card',
  itemKind: 'CARD',
  last4: '4821',
  maskedNumber: 'XXXX XXXX XXXX 4821',
  status: 'DISPATCHED',
  statusLabel: 'Dispatched',
  expectedDeliveryDate: '2026-11-15',
  lastLocation: 'Mumbai Central Sorting Hub',
  isActive: true,
};

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

const schemas = {
  CallSettings: {
    type: 'object',
    description: `Optional per-request call settings. ${SETTINGS_NOTE}`,
    properties: {
      voice: { type: 'string', example: 'Polly.Kajal-Neural', description: 'Alias: `voiceName`.' },
      language: { type: 'string', pattern: '^[a-z]{2,3}-[A-Z]{2}$', example: 'en-IN', description: 'Alias: `voiceLanguage`.' },
      agentNumber: { type: 'string', example: '+919876543210', description: 'E.164 number or `sip:` URI. Aliases: `destination`, `liveAgentNumber`.' },
      callerId: { type: 'string', pattern: '^\\+[1-9]\\d{6,14}$', example: '+15550001111', description: 'Alias: `twilioPhoneNumber`.' },
      dialTimeout: { type: 'integer', minimum: 5, maximum: 600, example: 25 },
      gatherTimeout: { type: 'integer', minimum: 1, maximum: 60, example: 4 },
      verifyTimeout: { type: 'integer', minimum: 1, maximum: 60, example: 6 },
      confidenceThreshold: { type: 'number', minimum: 0, maximum: 1, example: 0.4 },
      deliveryWindow: { type: 'string', example: '10:00 AM and 6:00 PM' },
      baseUrl: { type: 'string', format: 'uri', example: 'https://xxxx.ngrok-free.app' },
      menuActionUrl: { type: 'string', example: '/api/telephony/menu-selection' },
      verifyActionUrl: { type: 'string', example: '/api/telephony/verify-input' },
      dialStatusUrl: { type: 'string', example: '/api/telephony/agent-dial-status' },
    },
  },
  Consignment: {
    type: 'object',
    description: 'Customer-safe consignment view. Only the last 4 digits of a card/SIM are ever returned; DOB and full phone are never returned.',
    properties: {
      consignmentId: { type: 'string', example: 'CCD1001' },
      issuer: { type: 'string', example: 'HDFC Bank' },
      itemType: { type: 'string', example: 'CREDIT_CARD' },
      itemLabel: { type: 'string', example: 'credit card' },
      itemKind: { type: 'string', enum: ['CARD', 'SIM'] },
      last4: { type: 'string', example: '4821' },
      maskedNumber: { type: 'string', example: 'XXXX XXXX XXXX 4821' },
      status: { $ref: '#/components/schemas/ConsignmentStatus' },
      statusLabel: { type: 'string', example: 'Dispatched' },
      expectedDeliveryDate: { type: 'string', nullable: true, example: '2026-11-15' },
      lastLocation: { type: 'string', nullable: true, example: 'Mumbai Central Sorting Hub' },
      isActive: { type: 'boolean' },
    },
  },
  ConsignmentStatus: {
    type: 'string',
    enum: ['DISPATCHED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERY_ATTEMPTED', 'DELIVERED'],
  },
  Error: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: false },
      error: { type: 'string', example: '"consignmentId" is required.' },
      errors: { type: 'array', items: { type: 'string' }, description: 'Present when several call settings are invalid.' },
      twiml: { type: 'string', description: 'Fallback TwiML (where applicable).' },
    },
  },

  // --- Workflow ---------------------------------------------------------------
  ValidateCallerRequest: {
    allOf: [
      {
        type: 'object',
        required: ['callerPhone'],
        properties: {
          callerPhone: { type: 'string', example: '+919800000001', description: 'Caller ANI (E.164). Matched on the last 10 digits.' },
          callSid: { type: 'string', example: 'CA0123456789abcdef0123456789abcdef', description: 'Live Twilio CallSid. Generated (WF…) when omitted.' },
        },
      },
      ref('CallSettings'),
    ],
  },
  ValidateCallerResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      callSid: { type: 'string' },
      matchType: { type: 'string', enum: ['SINGLE', 'MULTIPLE', 'NONE', 'ERROR'] },
      callerVerified: { type: 'boolean' },
      consignmentCount: { type: 'integer' },
      consignments: { type: 'array', items: ref('Consignment') },
      nextAction: { type: 'string', enum: ['MAIN_MENU', 'DISAMBIGUATE', 'SECONDARY_VERIFICATION', 'AGENT_TRANSFER'] },
      twiml: { type: 'string' },
    },
  },
  VerifySecondaryRequest: {
    allOf: [
      {
        type: 'object',
        required: ['identifier'],
        properties: {
          callSid: { type: 'string', example: 'CA0123456789abcdef0123456789abcdef' },
          identifier: { type: 'string', example: '15081990', description: 'Consignment number (`CCD1008` or `1008`) or DOB (`DDMMYYYY`, `15/08/1990`, `15th August 1990`).' },
          type: { type: 'string', enum: ['CONSIGNMENT', 'DOB', 'AUTO'], default: 'AUTO' },
          attemptCount: { type: 'integer', minimum: 1, example: 1, description: 'Which attempt this is. Attempt 2 failing escalates to an agent. Defaults to the session counter + 1.' },
          callerPhone: { type: 'string', example: '+919999900006', description: 'Used to scope a DOB check to the caller.' },
        },
      },
      ref('CallSettings'),
    ],
  },
  VerifySecondaryResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      callSid: { type: 'string' },
      type: { type: 'string' },
      verified: { type: 'boolean' },
      attemptCount: { type: 'integer' },
      escalateToAgent: { type: 'boolean' },
      validationMethod: { type: 'string', nullable: true, enum: ['CONSIGNMENT', 'DOB', 'FAILED', null] },
      consignment: { type: 'object', allOf: [ref('Consignment')], nullable: true },
      consignments: { type: 'array', items: ref('Consignment') },
      nextAction: { type: 'string', enum: ['MAIN_MENU', 'DISAMBIGUATE', 'RETRY_VERIFICATION', 'AGENT_TRANSFER'] },
      twiml: { type: 'string' },
    },
  },
  StatusRequest: {
    allOf: [
      {
        type: 'object',
        required: ['consignmentId'],
        properties: {
          consignmentId: { type: 'string', example: 'CCD1001' },
          intent: { type: 'string', enum: ['STATUS', 'EDD', 'EXCEPTION', 'ACTION'], default: 'STATUS' },
          callSid: { type: 'string', description: 'Binds the consignment to the live call so the next Twilio <Gather> continues the conversation.' },
        },
      },
      ref('CallSettings'),
    ],
  },
  StatusResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      consignmentId: { type: 'string' },
      issuer: { type: 'string' },
      itemType: { type: 'string' },
      itemLabel: { type: 'string' },
      maskedNumber: { type: 'string' },
      last4: { type: 'string' },
      status: ref('ConsignmentStatus'),
      statusLabel: { type: 'string' },
      expectedDeliveryDate: { type: 'string', nullable: true },
      lastLocation: { type: 'string', nullable: true },
      intent: { type: 'string' },
      spokenText: { type: 'string', example: 'Your HDFC Bank credit card has been dispatched from our Mumbai Central Sorting Hub and is on its way to you.' },
      twiml: { type: 'string' },
    },
  },
  ExceptionRequest: {
    allOf: [
      {
        type: 'object',
        required: ['consignmentId'],
        properties: { consignmentId: { type: 'string', example: 'CCD1002' }, callSid: { type: 'string' } },
      },
      ref('CallSettings'),
    ],
  },
  AttemptHistoryItem: {
    type: 'object',
    properties: {
      attemptTimestamp: { type: 'string', example: '2026-11-11 14:30:00' },
      failureReasonCode: { type: 'string', example: 'PREMISES_LOCKED' },
      failureReason: { type: 'string', example: 'the customer premises was locked and unavailable' },
      nextAttemptDate: { type: 'string', nullable: true, example: '2026-11-13' },
    },
  },
  ExceptionResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      consignmentId: { type: 'string' },
      status: ref('ConsignmentStatus'),
      statusLabel: { type: 'string' },
      attemptCount: { type: 'integer' },
      attemptTimestamp: { type: 'string', nullable: true },
      failureReasonCode: { type: 'string', nullable: true },
      failureReason: { type: 'string', nullable: true },
      nextAttemptDate: { type: 'string', nullable: true },
      deliveryWindow: { type: 'string' },
      actionRequired: { type: 'string', nullable: true },
      attemptHistory: { type: 'array', items: ref('AttemptHistoryItem') },
      issuer: { type: 'string' },
      itemLabel: { type: 'string' },
      spokenText: { type: 'string' },
      twiml: { type: 'string' },
    },
  },
  AgentTransferRequest: {
    allOf: [
      {
        type: 'object',
        properties: {
          callSid: { type: 'string' },
          callerPhone: { type: 'string', example: '+919800000001' },
          reason: { type: 'string', example: 'CUSTOMER_REQUEST', description: 'Any code (letters, digits, `_ . -`, max 100). Spaces become `_`; stored upper-case. Common: `CUSTOMER_REQUEST`, `2X_VERIFICATION_FAILURE`, `LOW_CONFIDENCE_OR_OUT_OF_SCOPE`, `RESCHEDULE_REQUEST`.' },
          message: { type: 'string', maxLength: 500, example: 'Connecting you to our priority desk.', description: 'Optional announcement spoken before the transfer prompt.' },
        },
      },
      ref('CallSettings'),
    ],
  },
  AgentTransferResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      callSid: { type: 'string' },
      action: { type: 'string', example: 'DIAL_AGENT' },
      destination: { type: 'string', example: '+919876543210' },
      callerId: { type: 'string', nullable: true },
      reason: { type: 'string' },
      dialTimeoutSeconds: { type: 'integer' },
      twiml: { type: 'string' },
    },
  },

  // --- Twilio webhooks ------------------------------------------------------------
  TwilioVoiceWebhook: {
    type: 'object',
    description: 'Standard Twilio voice webhook fields (subset used by this service).',
    required: ['CallSid'],
    properties: {
      CallSid: { type: 'string', example: 'CA0123456789abcdef0123456789abcdef' },
      From: { type: 'string', example: '+919800000001' },
      To: { type: 'string', example: '+15550001111' },
      Direction: { type: 'string', example: 'inbound', description: 'For `outbound-api` calls the customer is `To`.' },
      CallStatus: { type: 'string', example: 'ringing' },
    },
  },
  TwilioGatherWebhook: {
    allOf: [
      ref('TwilioVoiceWebhook'),
      {
        type: 'object',
        properties: {
          Digits: { type: 'string', example: '1', description: 'Keypad input.' },
          SpeechResult: { type: 'string', example: "Why wasn't my card delivered yesterday?", description: 'Speech transcript.' },
          Confidence: { type: 'number', example: 0.92, description: 'Speech confidence (0-1).' },
        },
      },
    ],
  },
  TwilioDialWebhook: {
    allOf: [
      ref('TwilioVoiceWebhook'),
      {
        type: 'object',
        properties: {
          DialCallStatus: { type: 'string', enum: ['completed', 'answered', 'busy', 'no-answer', 'failed', 'canceled'] },
          DialCallDuration: { type: 'integer', example: 0 },
        },
      },
    ],
  },
  TwilioStatusCallback: {
    allOf: [
      ref('TwilioVoiceWebhook'),
      { type: 'object', properties: { CallDuration: { type: 'integer', example: 64 } } },
    ],
  },

  // --- Call management -------------------------------------------------------------
  MakeCallRequest: {
    allOf: [
      {
        type: 'object',
        required: ['to'],
        properties: {
          to: { type: 'string', example: '+919800000001' },
          from: { type: 'string', example: '+15550001111', description: 'Defaults to `callerId` / TWILIO_PHONE_NUMBER.' },
          actionUrl: { type: 'string', description: 'TwiML URL Twilio fetches when answered. Default: this service\'s inbound-call webhook (call settings appended as query parameters).' },
          method: { type: 'string', enum: ['GET', 'POST'], default: 'POST' },
          statusCallback: { type: 'string', description: 'Default: /api/telephony/status-callback.' },
          statusCallbackMethod: { type: 'string', enum: ['GET', 'POST'], default: 'POST' },
          statusCallbackEvent: { type: 'array', items: { type: 'string', enum: ['initiated', 'ringing', 'answered', 'completed'] } },
          timeout: { type: 'integer', minimum: 5, maximum: 600, description: 'Ring time in seconds.' },
          record: { type: 'boolean' },
          machineDetection: { type: 'string', enum: ['Enable', 'DetectMessageEnd'] },
        },
      },
      ref('CallSettings'),
    ],
  },
  CallInfo: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      callSid: { type: 'string' },
      status: { type: 'string', example: 'in-progress' },
      direction: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      durationSeconds: { type: 'integer', nullable: true },
      startTime: { type: 'string', nullable: true },
      endTime: { type: 'string', nullable: true },
      dateCreated: { type: 'string', nullable: true },
      answeredBy: { type: 'string', nullable: true },
      webhookUrl: { type: 'string', description: 'make-call only' },
      terminated: { type: 'boolean', description: 'terminate-call only' },
    },
  },
  TerminateCallRequest: {
    type: 'object',
    required: ['callSid'],
    properties: { callSid: { type: 'string', pattern: '^CA[0-9a-fA-F]{32}$', example: 'CA0123456789abcdef0123456789abcdef' } },
  },

  // --- Auth & dashboard -------------------------------------------------------------
  LoginRequest: {
    type: 'object',
    required: ['username', 'password'],
    properties: {
      username: { type: 'string', example: 'admin' },
      password: { type: 'string', format: 'password' },
      next: { type: 'string', example: '/#logs', description: 'Same-site path to return to after login.' },
    },
  },
  LoginResponse: {
    type: 'object',
    properties: { success: { type: 'boolean' }, username: { type: 'string' }, redirect: { type: 'string' } },
  },
  MeResponse: {
    type: 'object',
    properties: { success: { type: 'boolean' }, username: { type: 'string' }, expiresAt: { type: 'string', format: 'date-time' } },
  },
  Metrics: {
    type: 'object',
    properties: {
      generatedAt: { type: 'string', format: 'date-time' },
      kpis: {
        type: 'object',
        properties: {
          totalCalls: { type: 'integer' },
          completedCalls: { type: 'integer' },
          activeCalls: { type: 'integer' },
          containmentRate: { type: 'number', description: '%' },
          averageHandlingTimeSeconds: { type: 'integer' },
          validationAccuracy: { type: 'number', description: '%' },
          escalationRate: { type: 'number', description: '%' },
          estimatedCostSavingsInr: { type: 'integer' },
          costAssumptions: { type: 'object', properties: { costPerAgentCallInr: { type: 'number' }, costPerBotCallInr: { type: 'number' } } },
        },
      },
      resolution: {
        type: 'object',
        properties: { botResolved: { type: 'integer' }, agentTransferred: { type: 'integer' }, abandoned: { type: 'integer' }, inProgress: { type: 'integer' } },
      },
      intents: { type: 'array', items: { type: 'object', properties: { intent: { type: 'string' }, count: { type: 'integer' } } } },
      consignmentStatuses: {
        type: 'array',
        items: { type: 'object', properties: { status: { type: 'string' }, label: { type: 'string' }, count: { type: 'integer' } } },
      },
      escalationReasons: { type: 'array', items: { type: 'object', properties: { reason: { type: 'string' }, count: { type: 'integer' } } } },
      liveSessions: { type: 'integer' },
    },
  },
  AuditLog: {
    type: 'object',
    properties: {
      callSid: { type: 'string' },
      callerPhone: { type: 'string', description: 'Masked, e.g. +91******0001' },
      consignmentId: { type: 'string', nullable: true },
      validationMethod: { type: 'string', nullable: true },
      intentDetected: { type: 'string', nullable: true },
      durationSeconds: { type: 'integer', nullable: true },
      disposition: { type: 'string', enum: ['BOT_RESOLVED', 'CALLER_ENDED', 'AGENT_TRANSFERRED', 'AGENT_UNAVAILABLE', 'ABANDONED', 'IN_PROGRESS'] },
      escalationReason: { type: 'string', nullable: true },
      createdAt: { type: 'string' },
      updatedAt: { type: 'string', nullable: true },
    },
  },
  AuditLogPage: {
    type: 'object',
    properties: {
      total: { type: 'integer' },
      limit: { type: 'integer' },
      offset: { type: 'integer' },
      rows: { type: 'array', items: ref('AuditLog') },
    },
  },
  CallEvent: {
    type: 'object',
    properties: {
      event_type: { type: 'string', example: 'INTENT' },
      detail: { type: 'object', additionalProperties: true, example: { intent: 'STATUS', consignmentId: 'CCD1001' } },
      created_at: { type: 'string' },
    },
  },
  Health: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['ok', 'degraded'] },
      database: { type: 'string' },
      serverTime: { type: 'string' },
      uptimeSeconds: { type: 'integer' },
      error: { type: 'string' },
    },
  },
};

const AUDIT_FILTERS = [
  { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Search call SID, consignment, caller phone, intent or escalation reason.' },
  { name: 'from', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Created on or after (YYYY-MM-DD).' },
  { name: 'to', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Created on or before (YYYY-MM-DD).' },
  { name: 'disposition', in: 'query', schema: { type: 'string', enum: ['BOT_RESOLVED', 'CALLER_ENDED', 'AGENT_TRANSFERRED', 'AGENT_UNAVAILABLE', 'ABANDONED', 'IN_PROGRESS'] } },
  { name: 'validation', in: 'query', schema: { type: 'string', enum: ['ANI', 'ANI_MULTI', 'CONSIGNMENT', 'DOB', 'FAILED', 'WORKFLOW'] } },
  {
    name: 'sort',
    in: 'query',
    description: 'Sort column. Unknown values fall back to `updatedAt`.',
    schema: {
      type: 'string',
      default: 'updatedAt',
      enum: ['createdAt', 'updatedAt', 'callSid', 'callerPhone', 'consignmentId', 'validationMethod', 'intentDetected', 'durationSeconds', 'disposition', 'escalationReason'],
    },
  },
  { name: 'dir', in: 'query', description: 'Sort direction (empty values last).', schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' } },
];

// -----------------------------------------------------------------------------
// Paths
// -----------------------------------------------------------------------------

const paths = {
  '/health': {
    get: {
      tags: ['System'],
      summary: 'Service and database health',
      operationId: 'health',
      responses: {
        200: jsonResponse('Service and PostgreSQL reachable', 'Health'),
        503: jsonResponse('Database unreachable', 'Health'),
      },
    },
  },

  // --- Auth -----------------------------------------------------------------------
  '/api/auth/login': {
    post: {
      tags: ['Dashboard Auth'],
      summary: 'Sign in to the dashboard',
      description: 'Sets the HttpOnly `ccd_session` cookie (lifetime `DASHBOARD_SESSION_HOURS`, default 8 h). Five failed attempts from one IP lock sign-in for 5 minutes.',
      operationId: 'login',
      requestBody: jsonBody('LoginRequest'),
      responses: {
        200: {
          description: 'Signed in',
          headers: { 'Set-Cookie': { schema: { type: 'string' }, description: '`ccd_session=…; HttpOnly; SameSite=Lax`' } },
          content: { 'application/json': { schema: ref('LoginResponse') } },
        },
        401: jsonResponse('Invalid username or password', 'Error'),
        429: jsonResponse('Too many failed attempts', 'Error'),
        503: jsonResponse('Dashboard login not configured', 'Error'),
      },
    },
  },
  '/api/auth/logout': {
    post: {
      tags: ['Dashboard Auth'],
      summary: 'Sign out (clears the session cookie)',
      operationId: 'logout',
      responses: { 200: { description: 'Signed out', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' } } } } } } },
    },
  },
  '/api/auth/me': {
    get: {
      tags: ['Dashboard Auth'],
      summary: 'Current dashboard user',
      operationId: 'me',
      security: [{ cookieAuth: [] }],
      responses: { 200: jsonResponse('Signed-in user', 'MeResponse'), 401: R401 },
    },
  },
  '/logout': {
    get: {
      tags: ['Dashboard Auth'],
      summary: 'Sign out and redirect to the login page (browser link)',
      operationId: 'logoutRedirect',
      responses: { 302: { description: 'Redirect to /login.html' } },
    },
  },

  // --- Workflow ---------------------------------------------------------------------
  '/api/workflow/validate-caller': {
    post: {
      tags: ['Workflow APIs'],
      summary: 'Validate caller by ANI (Scenario 1 / 2)',
      description: `Matches the caller's number against active consignments.\n\n- \`SINGLE\` → welcome + main menu\n- \`MULTIPLE\` → "Press 1 / Press 2" disambiguation\n- \`NONE\` → ask for consignment number or DOB\n\n${SETTINGS_NOTE}`,
      operationId: 'validateCaller',
      requestBody: jsonBody('ValidateCallerRequest', {
        single: { summary: 'Recognised caller', value: { callerPhone: '+919800000001', callSid: 'CA0123456789abcdef0123456789abcdef' } },
        multiple: { summary: 'Multiple consignments', value: { callerPhone: '+919800000006' } },
        unknown: { summary: 'Unknown caller', value: { callerPhone: '+919999900006' } },
        customSettings: {
          summary: 'With call settings',
          value: { callerPhone: '+919800000001', callSid: 'CA0123456789abcdef0123456789abcdef', voice: 'Polly.Aditi', language: 'en-IN', agentNumber: '+919876543210', gatherTimeout: 5, baseUrl: 'https://xxxx.ngrok-free.app' },
        },
      }),
      responses: {
        200: jsonResponse('Match result + TwiML', 'ValidateCallerResponse', {
          success: true, callSid: 'CA0123456789abcdef0123456789abcdef', matchType: 'SINGLE', callerVerified: true, consignmentCount: 1,
          consignments: [SAMPLE_CONSIGNMENT], nextAction: 'MAIN_MENU', twiml: SAMPLE_TWIML_MENU,
        }),
        400: R400,
        500: R500,
      },
    },
  },
  '/api/workflow/verify-secondary': {
    post: {
      tags: ['Workflow APIs'],
      summary: 'Secondary identity verification (Scenario 2)',
      description: `Validates a consignment number or date of birth. A failed **attempt 2** returns \`escalateToAgent: true\` with agent-transfer TwiML (Scenario 4). A DOB alone is accepted only if it matches exactly one customer.\n\n${SETTINGS_NOTE}`,
      operationId: 'verifySecondary',
      requestBody: jsonBody('VerifySecondaryRequest', {
        consignment: { summary: 'By consignment number', value: { callSid: 'CA0123456789abcdef0123456789abcdef', identifier: 'CCD1008', type: 'CONSIGNMENT', attemptCount: 1 } },
        dob: { summary: 'By date of birth', value: { callSid: 'CA0123456789abcdef0123456789abcdef', identifier: '15081990', type: 'DOB', attemptCount: 1 } },
        secondFailure: { summary: 'Second failed attempt', value: { callSid: 'CA0123456789abcdef0123456789abcdef', identifier: 'CCD9999999', type: 'AUTO', attemptCount: 2 } },
      }),
      responses: {
        200: jsonResponse('Verification outcome + TwiML', 'VerifySecondaryResponse', {
          success: true, callSid: 'CA0123456789abcdef0123456789abcdef', type: 'DOB', verified: true, attemptCount: 1, escalateToAgent: false,
          validationMethod: 'DOB', consignment: { ...SAMPLE_CONSIGNMENT, consignmentId: 'CCD1008', issuer: 'Kotak Mahindra Bank', last4: '2468', maskedNumber: 'XXXX XXXX XXXX 2468', status: 'IN_TRANSIT', statusLabel: 'In Transit' },
          nextAction: 'MAIN_MENU', twiml: SAMPLE_TWIML_MENU,
        }),
        400: R400,
        500: R500,
      },
    },
  },
  '/api/workflow/status': {
    post: {
      tags: ['Workflow APIs'],
      summary: 'Consignment status / expected delivery date (Scenario 1)',
      description: `Returns plain-language \`spokenText\` (never internal codes) and follow-up TwiML ("Is there anything else…").\n\n\`intent\`: \`STATUS\` · \`EDD\` · \`EXCEPTION\` · \`ACTION\`\n\n${SETTINGS_NOTE}`,
      operationId: 'consignmentStatus',
      requestBody: jsonBody('StatusRequest', {
        status: { summary: 'Current status', value: { consignmentId: 'CCD1001', intent: 'STATUS' } },
        edd: { summary: 'Expected delivery date', value: { consignmentId: 'CCD1001', intent: 'EDD' } },
        action: { summary: 'Next steps / photo ID', value: { consignmentId: 'CCD1002', intent: 'ACTION' } },
      }),
      responses: {
        200: jsonResponse('Status + spoken text + TwiML', 'StatusResponse'),
        400: R400,
        404: jsonResponse('Consignment not found (TwiML re-prompts for the number)', 'Error'),
        500: R500,
      },
    },
  },
  '/api/workflow/exception': {
    post: {
      tags: ['Workflow APIs'],
      summary: 'Delivery exception details (Scenario 3)',
      description: `Attempt history (newest first), plain-language failure reason, next attempt date, delivery window and photo-ID requirement.\n\n${SETTINGS_NOTE}`,
      operationId: 'deliveryException',
      requestBody: jsonBody('ExceptionRequest', { attempted: { summary: 'Failed delivery', value: { consignmentId: 'CCD1002' } } }),
      responses: {
        200: jsonResponse('Exception details + TwiML', 'ExceptionResponse', {
          success: true, consignmentId: 'CCD1002', status: 'DELIVERY_ATTEMPTED', statusLabel: 'Delivery Attempted', attemptCount: 1,
          attemptTimestamp: '2026-11-11 14:30:00', failureReasonCode: 'PREMISES_LOCKED', failureReason: 'the customer premises was locked and unavailable',
          nextAttemptDate: '2026-11-13', deliveryWindow: '10:00 AM and 6:00 PM',
          actionRequired: 'An adult with valid government photo ID must be present to receive the delivery.',
          attemptHistory: [{ attemptTimestamp: '2026-11-11 14:30:00', failureReasonCode: 'PREMISES_LOCKED', failureReason: 'the customer premises was locked and unavailable', nextAttemptDate: '2026-11-13' }],
          issuer: 'ICICI Bank', itemLabel: 'debit card',
          spokenText: 'Our delivery agent attempted delivery yesterday at 2:30 PM, but the customer premises was locked and unavailable. A second attempt is scheduled for tomorrow between 10:00 AM and 6:00 PM. Please ensure an adult with valid government photo ID is present to receive it. To reschedule delivery or speak with a representative, press 9.',
          twiml: '<?xml version="1.0" encoding="UTF-8"?><Response><Gather …>…</Gather></Response>',
        }),
        400: R400,
        404: jsonResponse('Consignment not found', 'Error'),
        500: R500,
      },
    },
  },
  '/api/workflow/agent-transfer': {
    post: {
      tags: ['Workflow APIs'],
      summary: 'Live agent escalation TwiML (Scenario 4)',
      description: `Logs the escalation reason to the audit trail and returns \`<Say>\` + \`<Dial>\` TwiML. If the agent line is busy or unanswered, Twilio calls \`dialStatusUrl\`, which plays "All agents are currently busy" and hangs up.\n\n${SETTINGS_NOTE}`,
      operationId: 'agentTransfer',
      requestBody: jsonBody('AgentTransferRequest', {
        customerRequest: { summary: 'Caller asked for an agent', value: { callSid: 'CA0123456789abcdef0123456789abcdef', callerPhone: '+919800000001', reason: 'CUSTOMER_REQUEST' } },
        custom: {
          summary: 'Custom agent, caller ID and message',
          value: { callSid: 'CA0123456789abcdef0123456789abcdef', callerPhone: '+919800000001', reason: '2X_VERIFICATION_FAILURE', agentNumber: 'sip:agent@pbx.example.com', dialTimeout: 20, message: 'Connecting you to our priority desk.' },
        },
      }),
      responses: {
        200: jsonResponse('Dial instruction + TwiML', 'AgentTransferResponse', {
          success: true, callSid: 'CA0123456789abcdef0123456789abcdef', action: 'DIAL_AGENT', destination: '+919876543210', callerId: '+15550001111',
          reason: 'CUSTOMER_REQUEST', dialTimeoutSeconds: 25, twiml: SAMPLE_TWIML_DIAL,
        }),
        400: R400,
        500: R500,
      },
    },
  },

  // --- Twilio webhooks ------------------------------------------------------------------
  '/api/telephony/inbound-call': {
    post: {
      tags: ['Twilio Webhooks'],
      summary: 'A Call Comes In (Twilio number webhook)',
      description: 'Configure in the Twilio Console under **A Call Comes In (POST)**. Looks the caller up by `From` and returns the greeting TwiML. Call settings may be added as query parameters.',
      operationId: 'inboundCall',
      parameters: SETTINGS_QUERY,
      requestBody: formBody('TwilioVoiceWebhook', { CallSid: 'CA0123456789abcdef0123456789abcdef', From: '+919800000001', To: '+15550001111', Direction: 'inbound', CallStatus: 'ringing' }),
      responses: { 200: twimlResponse('Greeting TwiML (barge-in <Gather>)', SAMPLE_TWIML_MENU), 403: { description: 'Invalid X-Twilio-Signature (when TWILIO_VALIDATE_SIGNATURE=true)' } },
    },
  },
  '/api/telephony/menu-selection': {
    post: {
      tags: ['Twilio Webhooks'],
      summary: 'Menu / follow-up / disambiguation <Gather> action',
      description:
        'Keypad: `1` status · `2` delivery date · `3` attempt history · `4` documents / next steps · `9` agent · `0` end call · `*` repeat menu.\n\n' +
        'Speech is classified into STATUS / EDD / EXCEPTION / ACTION / AGENT / RESCHEDULE / NO / YES. An empty body (silence) re-prompts once; ' +
        'two silent or two unclear / low-confidence turns escalate to an agent.',
      operationId: 'menuSelection',
      parameters: SETTINGS_QUERY,
      requestBody: formBody('TwilioGatherWebhook', { CallSid: 'CA0123456789abcdef0123456789abcdef', From: '+919800000001', SpeechResult: "Why wasn't my card delivered yesterday?", Confidence: 0.92 }),
      responses: { 200: twimlResponse('Answer / re-prompt / transfer / hang-up TwiML'), 403: { description: 'Invalid signature' } },
    },
  },
  '/api/telephony/verify-input': {
    post: {
      tags: ['Twilio Webhooks'],
      summary: 'Secondary verification <Gather> action',
      description: 'Accepts a consignment number or DOB as `Digits` or `SpeechResult`. First failure re-prompts; second failure escalates. Saying "agent" transfers immediately.',
      operationId: 'verifyInput',
      parameters: SETTINGS_QUERY,
      requestBody: formBody('TwilioGatherWebhook', { CallSid: 'CA0123456789abcdef0123456789abcdef', From: '+919999900006', Digits: '1008' }),
      responses: { 200: twimlResponse('Verified menu / retry / transfer TwiML'), 403: { description: 'Invalid signature' } },
    },
  },
  '/api/telephony/agent-dial-status': {
    post: {
      tags: ['Twilio Webhooks'],
      summary: '<Dial action> callback - agent busy fallback',
      description: '`busy`, `no-answer`, `failed`, `canceled` → "All agents are currently busy. A representative will contact you shortly." + hang up. `completed` → hang up.',
      operationId: 'agentDialStatus',
      parameters: SETTINGS_QUERY,
      requestBody: formBody('TwilioDialWebhook', { CallSid: 'CA0123456789abcdef0123456789abcdef', DialCallStatus: 'busy', DialCallDuration: 0 }),
      responses: { 200: twimlResponse('Busy message + <Hangup/>') },
    },
  },
  '/api/telephony/status-callback': {
    post: {
      tags: ['Twilio Webhooks'],
      summary: 'Call Status Changes callback',
      description: 'Configure under **Call Status Changes (POST)**. On a terminal status records the final duration and marks unfinished calls as `ABANDONED`.',
      operationId: 'statusCallback',
      requestBody: formBody('TwilioStatusCallback', { CallSid: 'CA0123456789abcdef0123456789abcdef', From: '+919800000001', CallStatus: 'completed', CallDuration: 64 }),
      responses: { 204: { description: 'Recorded' } },
    },
  },

  // --- Call management -------------------------------------------------------------------
  '/api/telephony/make-call': {
    post: {
      tags: ['Call Management'],
      summary: 'Place a call via the Twilio REST API',
      description: `Calls \`client.calls.create\`. Needs TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN in .env.\n\n${SETTINGS_NOTE}`,
      operationId: 'makeCall',
      requestBody: jsonBody('MakeCallRequest', {
        basic: { summary: 'Minimal', value: { to: '+919800000001' } },
        full: {
          summary: 'All options',
          value: { to: '+919800000001', from: '+15550001111', method: 'POST', statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'], timeout: 30, record: false, voice: 'Polly.Kajal-Neural', language: 'en-IN', agentNumber: '+919876543210' },
        },
      }),
      responses: {
        201: jsonResponse('Call queued', 'CallInfo'),
        400: R400,
        503: jsonResponse('Twilio credentials not configured', 'Error'),
        502: jsonResponse('Twilio API error', 'Error'),
      },
    },
  },
  '/api/telephony/call-status/{callSid}': {
    get: {
      tags: ['Call Management'],
      summary: 'Live call status',
      operationId: 'callStatus',
      parameters: [{ name: 'callSid', in: 'path', required: true, schema: { type: 'string', pattern: '^CA[0-9a-fA-F]{32}$' }, example: 'CA0123456789abcdef0123456789abcdef' }],
      responses: {
        200: jsonResponse('queued / ringing / in-progress / completed …', 'CallInfo'),
        400: R400,
        404: jsonResponse('Call not found at Twilio', 'Error'),
        503: jsonResponse('Twilio credentials not configured', 'Error'),
      },
    },
  },
  '/api/telephony/terminate-call': {
    post: {
      tags: ['Call Management'],
      summary: 'Hang up an active call',
      description: 'Calls `client.calls(callSid).update({ status: "completed" })`.',
      operationId: 'terminateCall',
      requestBody: jsonBody('TerminateCallRequest'),
      responses: {
        200: jsonResponse('Call ended', 'CallInfo'),
        400: R400,
        404: jsonResponse('Call not found at Twilio', 'Error'),
        503: jsonResponse('Twilio credentials not configured', 'Error'),
      },
    },
  },

  // --- Dashboard ----------------------------------------------------------------------------
  '/api/dashboard/metrics': {
    get: {
      tags: ['Dashboard'],
      summary: 'KPIs and chart data',
      operationId: 'dashboardMetrics',
      security: [{ cookieAuth: [] }],
      responses: { 200: jsonResponse('KPIs, resolution, intents, consignment statuses', 'Metrics'), 401: R401, 503: R503DB },
    },
  },
  '/api/dashboard/audit-logs': {
    get: {
      tags: ['Dashboard'],
      summary: 'Call audit log (filtered, paginated)',
      operationId: 'auditLogs',
      security: [{ cookieAuth: [] }],
      parameters: [
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 25 } },
        { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
        ...AUDIT_FILTERS,
      ],
      responses: { 200: jsonResponse('Page of audit rows (caller numbers masked)', 'AuditLogPage'), 401: R401, 503: R503DB },
    },
  },
  '/api/dashboard/audit-logs/export.csv': {
    get: {
      tags: ['Dashboard'],
      summary: 'Download audit log as CSV',
      description: 'Same filters as the audit log; up to 50,000 rows. Caller numbers masked. UTF-8 with BOM for Excel.',
      operationId: 'auditLogsCsv',
      security: [{ cookieAuth: [] }],
      parameters: AUDIT_FILTERS,
      responses: {
        200: {
          description: 'CSV file',
          headers: { 'Content-Disposition': { schema: { type: 'string' }, description: 'attachment; filename="ccd-call-audit-YYYYMMDD-HHMM.csv"' } },
          content: { 'text/csv': { schema: { type: 'string', format: 'binary' } } },
        },
        401: R401,
        503: R503DB,
      },
    },
  },
  '/api/dashboard/calls/{callSid}/events': {
    get: {
      tags: ['Dashboard'],
      summary: 'Turn-by-turn events for one call',
      operationId: 'callEvents',
      security: [{ cookieAuth: [] }],
      parameters: [{ name: 'callSid', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Events', content: { 'application/json': { schema: { type: 'array', items: ref('CallEvent') } } } }, 401: R401, 503: R503DB },
    },
  },
};

// -----------------------------------------------------------------------------
// Document
// -----------------------------------------------------------------------------

function buildSpec() {
  const servers = [{ url: config.baseUrl, description: 'Configured BASE_URL' }];
  const local = `http://localhost:${config.port}`;
  if (config.baseUrl !== local) servers.push({ url: local, description: 'Local' });

  return {
    openapi: '3.0.3',
    info: {
      title: 'CCD Voice Automation - Utility Service',
      version: require('../package.json').version,
      description: [
        'Inbound voice bot backend for **CCD (Card & Consignment Delivery)**: Twilio voice webhooks and workflow REST endpoints for AutomationEdge.',
        '',
        '- **Workflow APIs** return structured JSON plus a ready-to-return `twiml` string.',
        '- **Twilio Webhooks** receive Twilio form posts and return TwiML (Amazon Polly voice, barge-in enabled).',
        '- **Dashboard** endpoints need a signed-in session: call `POST /api/auth/login` first (the browser keeps the cookie, so **Try it out** works after login).',
        '',
        SETTINGS_NOTE,
        '',
        'Card numbers are always masked to the last 4 digits; DOB and full phone numbers are never returned.',
      ].join('\n'),
    },
    servers,
    // Public by default; Dashboard operations declare cookieAuth individually.
    security: [],
    tags: [
      { name: 'Workflow APIs', description: 'For AutomationEdge / external workflow steps. JSON in, JSON + TwiML out.' },
      { name: 'Twilio Webhooks', description: 'URLs Twilio calls during a live call. Form-encoded in, TwiML out.' },
      { name: 'Call Management', description: 'Twilio REST API wrappers.' },
      { name: 'Dashboard', description: 'Analytics and audit log (login required).' },
      { name: 'Dashboard Auth', description: 'Dashboard sign-in / sign-out.' },
      { name: 'System', description: 'Health.' },
    ],
    paths,
    components: {
      schemas,
      securitySchemes: {
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'ccd_session', description: 'Set by POST /api/auth/login.' },
      },
      responses: {
        BadRequest: jsonResponse('Invalid request (missing field or invalid call setting)', 'Error'),
        Unauthorized: jsonResponse('Not signed in', 'Error'),
        WorkflowError: jsonResponse('Internal error; `twiml` routes the caller to an agent', 'Error'),
        DatabaseUnavailable: { description: 'Database unavailable', content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' }, detail: { type: 'string' } } } } } },
      },
    },
  };
}

module.exports = { buildSpec };
