'use strict';

/**
 * Creates the database (if missing), applies db/schema.sql and, unless
 * --no-seed is passed, loads the UAT test-scenario data from db/seed.sql.
 *
 *   npm run db:init       # schema + seed
 *   npm run db:schema     # schema only
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const config = require('../config');

const withSeed = !process.argv.includes('--no-seed');

function maintenanceConnection() {
  const conn = config.db.connection;
  if (conn.connectionString) {
    const url = new URL(conn.connectionString);
    const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
    url.pathname = '/postgres';
    return { target: database, admin: { connectionString: url.toString(), ssl: conn.ssl } };
  }
  return { target: conn.database, admin: { ...conn, database: 'postgres' } };
}

async function ensureDatabase() {
  const { target, admin } = maintenanceConnection();
  const client = new Client(admin);
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [target]);
    if (rowCount === 0) {
      await client.query(`CREATE DATABASE "${target.replace(/"/g, '""')}"`);
      console.log(`[db:init] Created database "${target}"`);
    } else {
      console.log(`[db:init] Database "${target}" already exists`);
    }
  } finally {
    await client.end();
  }
}

async function runSqlFile(client, file) {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', file), 'utf8');
  await client.query(sql);
  console.log(`[db:init] Applied db/${file}`);
}

async function main() {
  await ensureDatabase();
  const client = new Client(config.db.connection);
  await client.connect();
  try {
    await client.query('BEGIN');
    await runSqlFile(client, 'schema.sql');
    await runSqlFile(client, 'app_extensions.sql');
    if (withSeed) await runSqlFile(client, 'seed.sql');
    await client.query('COMMIT');

    const { rows } = await client.query(
      `SELECT status, COUNT(*)::int AS count FROM consignments GROUP BY status ORDER BY status`
    );
    console.log('[db:init] Consignments by status:');
    rows.forEach((r) => console.log(`           ${r.status.padEnd(20)} ${r.count}`));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`[db:init] Failed: ${err.message}`);
  process.exit(1);
});
