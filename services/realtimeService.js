'use strict';

/**
 * Real-time bridge: PostgreSQL LISTEN/NOTIFY -> Server-Sent Events.
 *
 * A dedicated pg connection LISTENs on the `ccd_changes` channel (fired by the
 * triggers in db/app_extensions.sql for every write to the dashboard tables,
 * whoever makes it). Changes are coalesced for a short window and broadcast to
 * every open dashboard. The same connection doubles as a database health probe:
 * if it drops, dashboards are told the database is disconnected and it
 * reconnects with backoff.
 */

const { EventEmitter } = require('events');
const { Client } = require('pg');
const config = require('../config');

const CHANNEL = 'ccd_changes';
const COALESCE_MS = 250;
const HEALTH_INTERVAL_MS = 10000;
const MAX_BACKOFF_MS = 30000;

class RealtimeService extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.client = null;
    this.connected = false;
    this.lastError = null;
    this.pendingTables = new Set();
    this.flushTimer = null;
    this.healthTimer = null;
    this.retryTimer = null;
    this.backoff = 1000;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  async connect() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    const client = new Client({ ...config.db.connection, application_name: 'ccd-voice-realtime' });
    this.client = client;

    client.on('notification', (msg) => {
      if (msg.channel !== CHANNEL) return;
      let table = 'unknown';
      try {
        table = JSON.parse(msg.payload).table || table;
      } catch (e) {
        /* malformed payload: still refresh */
      }
      this.queue(table);
    });
    client.on('error', (err) => this.handleDisconnect(err));
    client.on('end', () => this.handleDisconnect(new Error('connection closed')));

    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      this.backoff = 1000;
      this.lastError = null;
      this.setConnected(true);
      if (config.debug) console.log(`[realtime] Listening on PostgreSQL channel "${CHANNEL}"`);

      clearInterval(this.healthTimer);
      this.healthTimer = setInterval(() => {
        client.query('SELECT 1').catch((err) => this.handleDisconnect(err));
      }, HEALTH_INTERVAL_MS);
      this.healthTimer.unref();
    } catch (err) {
      this.handleDisconnect(err);
    }
  }

  handleDisconnect(err) {
    if (this.client) {
      this.client.removeAllListeners();
      this.client.on('error', () => {}); // swallow late errors from the dead socket
      this.client.end().catch(() => {});
      this.client = null;
    }
    clearInterval(this.healthTimer);
    this.lastError = err ? err.message : null;
    if (this.connected) console.warn(`[realtime] Lost database connection: ${this.lastError}`);
    this.setConnected(false);

    if (this.stopped || this.retryTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
    this.retryTimer.unref();
  }

  setConnected(value) {
    if (this.connected === value) return;
    this.connected = value;
    this.emit('status', this.status());
    // Coming back online: everything may have changed while we were away.
    if (value) this.queue('*');
  }

  status() {
    return { connected: this.connected, error: this.connected ? null : this.lastError };
  }

  queue(table) {
    this.pendingTables.add(table);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      const tables = [...this.pendingTables];
      this.pendingTables.clear();
      this.flushTimer = null;
      this.emit('change', { tables, at: new Date().toISOString() });
    }, COALESCE_MS);
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.healthTimer);
    clearTimeout(this.flushTimer);
    if (this.client) await this.client.end().catch(() => {});
  }
}

module.exports = new RealtimeService();
