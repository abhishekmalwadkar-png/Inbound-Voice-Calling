'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const env = process.env;

const toBool = (value, fallback = false) =>
  value === undefined || value === '' ? fallback : /^(1|true|yes|on)$/i.test(String(value).trim());

const toInt = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

const toFloat = (value, fallback) => {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
};

const port = toInt(env.PORT, 8001);
const dbSsl = toBool(env.DB_SSL, false) ? { rejectUnauthorized: false } : false;

const dbConnection = env.DATABASE_URL
  ? { connectionString: env.DATABASE_URL, ssl: dbSsl }
  : {
      host: env.DB_HOST || 'localhost',
      port: toInt(env.DB_PORT, 5432),
      database: env.DB_NAME || 'ccd_logistics_db',
      user: env.DB_USER || 'postgres',
      password: env.DB_PASSWORD || '',
      ssl: dbSsl,
    };

module.exports = {
  appEnv: env.APP_ENV || 'development',
  host: env.APP_HOST || '0.0.0.0',
  port,
  baseUrl: (env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
  debug: toBool(env.DEBUG, false),

  twilio: {
    accountSid: env.TWILIO_ACCOUNT_SID || '',
    authToken: env.TWILIO_AUTH_TOKEN || '',
    phoneNumber: env.TWILIO_PHONE_NUMBER || '',
    validateSignature: toBool(env.TWILIO_VALIDATE_SIGNATURE, false),
  },

  liveAgentNumber: env.LIVE_AGENT_PHONE_NUMBER || '',

  dashboard: {
    username: env.DASHBOARD_USERNAME || '',
    password: env.DASHBOARD_PASSWORD || '',
    secretKey: env.SECRET_KEY || '',
    sessionHours: toFloat(env.DASHBOARD_SESSION_HOURS, 8),
  },

  voice: {
    name: env.VOICE_NAME || 'Polly.Kajal',
    language: env.VOICE_LANGUAGE || 'en-IN',
  },

  session: {
    timeoutSeconds: toInt(env.SESSION_TIMEOUT_SECONDS, 600),
  },

  speech: {
    confidenceThreshold: toFloat(env.SPEECH_CONFIDENCE_THRESHOLD, 0.4),
    gatherTimeoutSeconds: toInt(env.GATHER_TIMEOUT_SECONDS, 4),
    verifyTimeoutSeconds: toInt(env.VERIFY_TIMEOUT_SECONDS, 6),
  },

  agent: {
    dialTimeoutSeconds: toInt(env.AGENT_DIAL_TIMEOUT_SECONDS, 25),
  },

  business: {
    deliveryWindow: env.DELIVERY_WINDOW || '10:00 AM and 6:00 PM',
    costPerAgentCallInr: toFloat(env.COST_PER_AGENT_CALL_INR, 45),
    costPerBotCallInr: toFloat(env.COST_PER_BOT_CALL_INR, 6),
  },

  db: {
    connection: dbConnection,
    poolMax: toInt(env.DB_POOL_MAX, 10),
    idleTimeoutMs: toInt(env.DB_IDLE_TIMEOUT_MS, 30000),
    connectionTimeoutMs: toInt(env.DB_CONNECTION_TIMEOUT_MS, 5000),
  },
};
