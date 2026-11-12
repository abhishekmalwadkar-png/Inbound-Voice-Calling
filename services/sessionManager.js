'use strict';

/**
 * In-memory call session store keyed by Twilio CallSid. Sessions expire after
 * SESSION_TIMEOUT_SECONDS of inactivity. For multi-instance deployments behind
 * Nginx, enable sticky routing on CallSid or swap this class for a shared store
 * that implements the same interface (create/get/update/delete).
 */

const config = require('../config');

const STAGES = Object.freeze({
  NEW: 'NEW',
  DISAMBIGUATE: 'DISAMBIGUATE',
  VERIFY: 'VERIFY',
  MAIN_MENU: 'MAIN_MENU',
  FOLLOW_UP: 'FOLLOW_UP',
  TRANSFERRED: 'TRANSFERRED',
  ENDED: 'ENDED',
});

class SessionManager {
  constructor({ ttlSeconds = 600, sweepIntervalMs = 60000 } = {}) {
    this.ttlMs = ttlSeconds * 1000;
    this.store = new Map();
    this.sweeper = setInterval(() => this.sweep(), sweepIntervalMs);
    this.sweeper.unref();
  }

  create(callSid, initial = {}) {
    const now = Date.now();
    const session = {
      callSid,
      callerPhone: null,
      stage: STAGES.NEW,
      consignment: null,
      candidates: [],
      pendingValidationMethod: null,
      validationMethod: null,
      verifyAttempts: 0,
      unclearCount: 0,
      silenceCount: 0,
      intents: [],
      escalationReason: null,
      startedAt: now,
      updatedAt: now,
      ...initial,
    };
    this.store.set(callSid, session);
    return session;
  }

  get(callSid) {
    if (!callSid) return null;
    const session = this.store.get(callSid);
    if (!session) return null;
    if (Date.now() - session.updatedAt > this.ttlMs) {
      this.store.delete(callSid);
      return null;
    }
    session.updatedAt = Date.now();
    return session;
  }

  getOrCreate(callSid, initial = {}) {
    return this.get(callSid) || this.create(callSid, initial);
  }

  update(callSid, patch = {}) {
    const session = this.get(callSid);
    if (!session) return null;
    Object.assign(session, patch, { updatedAt: Date.now() });
    return session;
  }

  delete(callSid) {
    return this.store.delete(callSid);
  }

  durationSeconds(session) {
    return session ? Math.max(0, Math.round((Date.now() - session.startedAt) / 1000)) : null;
  }

  size() {
    return this.store.size;
  }

  sweep() {
    const now = Date.now();
    for (const [callSid, session] of this.store) {
      if (now - session.updatedAt > this.ttlMs) this.store.delete(callSid);
    }
  }
}

const sessionManager = new SessionManager({ ttlSeconds: config.session.timeoutSeconds });

module.exports = sessionManager;
module.exports.SessionManager = SessionManager;
module.exports.STAGES = STAGES;
