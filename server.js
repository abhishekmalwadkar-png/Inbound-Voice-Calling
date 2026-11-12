'use strict';

const path = require('path');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const config = require('./config');
const db = require('./services/databaseService');
const telephonyRoutes = require('./routes/telephony');
const workflowRoutes = require('./routes/workflow');
const dashboardRoutes = require('./routes/dashboard');
const auth = require('./utils/auth');
const swaggerUi = require('swagger-ui-express');
const { buildSpec } = require('./docs/openapi');
const realtime = require('./services/realtimeService');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', true); // behind Nginx: honour X-Forwarded-* headers

app.use(cors());
app.use(bodyParser.urlencoded({ extended: false, limit: '100kb' })); // Twilio webhooks
app.use(bodyParser.json({ limit: '100kb' })); // workflow REST calls

if (config.debug) {
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      if (!req.path.startsWith('/api/dashboard')) {
        console.log(`[http] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - started}ms)`);
      }
    });
    next();
  });
}

app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.use('/api/telephony', telephonyRoutes);
app.use('/api/workflow', workflowRoutes);
app.post('/api/auth/login', auth.login);
app.post('/api/auth/logout', auth.logout);
app.get('/logout', auth.logout);
app.get('/api/auth/me', auth.me);
app.use('/api/dashboard', auth.requireApiAuth, dashboardRoutes);

app.get('/health', async (req, res) => {
  try {
    const info = await db.ping();
    res.json({ status: 'ok', database: info.database, serverTime: info.server_time, uptimeSeconds: Math.round(process.uptime()) });
  } catch (err) {
    res.status(503).json({ status: 'degraded', database: 'unreachable', error: err.message });
  }
});

// API documentation (OpenAPI 3 + Swagger UI)
app.get('/api-docs.json', (req, res) => res.json(buildSpec()));
app.use(
  '/api-docs',
  swaggerUi.serve,
  swaggerUi.setup(null, {
    customSiteTitle: 'CCD Voice API Docs',
    swaggerOptions: { url: '/api-docs.json', persistAuthorization: true, displayRequestDuration: true, docExpansion: 'none', tryItOutEnabled: false },
  })
);

// Login page: public, but skip it when already signed in.
const PUBLIC_ASSETS = new Set(['/login.html', '/login.css', '/favicon.ico']);
app.get('/login.html', (req, res, next) => (auth.currentUser(req) ? res.redirect(302, '/') : next()));

// Dashboard page + assets require login; /api/* (Twilio, workflows) and /health stay open.
app.use((req, res, next) =>
  req.path.startsWith('/api/') || req.path === '/health' || PUBLIC_ASSETS.has(req.path) ? next() : auth.requirePageAuth(req, res, next)
);
app.use(express.static(path.join(__dirname, 'public'), { maxAge: config.appEnv === 'production' ? '1h' : 0 }));

app.use('/api', (req, res) => res.status(404).json({ success: false, error: `No route for ${req.method} ${req.originalUrl}` }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[http] Unhandled error on ${req.method} ${req.originalUrl}: ${err.stack || err.message}`);
  if (err.type === 'entity.parse.failed') return res.status(400).json({ success: false, error: 'Malformed JSON body.' });
  res.status(500).json({ success: false, error: 'Internal server error' });
});

/** Endpoint catalogue printed at startup, grouped and in a fixed order. */
const ENDPOINT_GROUPS = [
  {
    title: 'TWILIO WEBHOOKS  (Twilio Console > Phone Number > Voice)',
    items: [
      ['POST', '/api/telephony/inbound-call', 'A call comes in'],
      ['POST', '/api/telephony/status-callback', 'Call status changes'],
      ['POST', '/api/telephony/menu-selection', 'Menu <Gather> action (automatic)'],
      ['POST', '/api/telephony/verify-input', 'Verify <Gather> action (automatic)'],
      ['POST', '/api/telephony/agent-dial-status', 'Agent <Dial> action (automatic)'],
    ],
  },
  {
    title: 'WORKFLOW APIs  (AutomationEdge steps)',
    items: [
      ['POST', '/api/workflow/validate-caller', 'Validate caller (ANI match)'],
      ['POST', '/api/workflow/verify-secondary', 'Verify secondary ID (consignment / DOB)'],
      ['POST', '/api/workflow/status', 'Consignment status / delivery date'],
      ['POST', '/api/workflow/exception', 'Delivery exception details'],
      ['POST', '/api/workflow/agent-transfer', 'Live agent escalation TwiML'],
    ],
  },
  {
    title: 'CALL MANAGEMENT  (Twilio REST API)',
    items: [
      ['POST', '/api/telephony/make-call', 'Place a call'],
      ['GET', '/api/telephony/call-status/:callSid', 'Live call status'],
      ['POST', '/api/telephony/terminate-call', 'Hang up a call'],
    ],
  },
  {
    title: 'DASHBOARD  (login required)',
    items: [
      ['GET', '/', 'Dashboard (simulator & KPIs)'],
      ['GET', '/login.html', 'Login page'],
      ['GET', '/api/dashboard/metrics', 'KPI metrics'],
      ['GET', '/api/dashboard/audit-logs', 'Audit logs (paginated)'],
      ['GET', '/api/dashboard/audit-logs/export.csv', 'Audit logs CSV download'],
      ['GET', '/api/dashboard/calls/:callSid/events', 'Per-call event trail'],
      ['GET', '/api/dashboard/stream', 'Live updates stream (SSE)'],
    ],
  },
  {
    title: 'DOCS & HEALTH',
    items: [
      ['GET', '/api-docs', 'Swagger UI'],
      ['GET', '/api-docs.json', 'OpenAPI 3 JSON'],
      ['GET', '/health', 'Health check'],
    ],
  },
];

function printBanner(dbStatus) {
  const b = config.baseUrl;
  const width = 96;
  const heavy = '='.repeat(width);
  const light = '-'.repeat(width - 4);
  const local = /localhost|127\.0\.0\.1/.test(b) ? '   (set BASE_URL to your public https URL for Twilio)' : '';
  const descWidth = Math.max(...ENDPOINT_GROUPS.flatMap((g) => g.items.map(([, , d]) => d.length))) + 2;

  const lines = [
    '',
    heavy,
    '  CCD VOICE AUTOMATION - UTILITY SERVICE RUNNING',
    heavy,
    `  Port      : ${config.port}`,
    `  Base URL  : ${b}${local}`,
    `  Database  : ${dbStatus}`,
    `  Voice     : ${config.voice.name} (${config.voice.language})`,
  ];

  let n = 0;
  ENDPOINT_GROUPS.forEach((group, gi) => {
    lines.push('', `  [${gi + 1}] ${group.title}`, `  ${light}`);
    group.items.forEach(([method, path, desc]) => {
      n += 1;
      lines.push(`  ${String(n).padStart(2)}. ${desc.padEnd(descWidth)}${method.padEnd(5)} ${b}${path}`);
    });
  });

  lines.push('', heavy, '');
  console.log(lines.join('\n'));
}

async function start() {
  let dbStatus;
  let schemaApplied = false;
  try {
    const info = await db.ping();
    dbStatus = `connected (${info.database})`;
    try {
      await db.ensureAppSchema();
      schemaApplied = true;
    } catch (err) {
      dbStatus += ` - app tables NOT applied: ${err.message} (run "npm run db:init")`;
    }
  } catch (err) {
    dbStatus = `UNREACHABLE - ${err.message} (run "npm run db:init" once PostgreSQL is up)`;
  }

  const server = app.listen(config.port, config.host, () => {
    printBanner(dbStatus);
    // Real-time dashboard feed (PostgreSQL LISTEN/NOTIFY -> SSE).
    realtime.on('status', async ({ connected }) => {
      console.log(connected ? '[realtime] Database connected - live dashboard updates on' : '[realtime] Database disconnected - dashboard cleared until it reconnects');
      // If PostgreSQL was down at startup, install app tables/triggers once it is reachable.
      if (connected && !schemaApplied) {
        try {
          await db.ensureAppSchema();
          schemaApplied = true;
          console.log('[realtime] App tables and change triggers applied');
        } catch (err) {
          console.warn(`[realtime] Could not apply app tables: ${err.message}`);
        }
      }
    });
    realtime.start();
  });

  server.on('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `\n[server] Port ${config.port} is already in use - another copy of the utility (or another app) is running.\n` +
        `         Close that window, or stop it with:\n` +
        `           PowerShell: Get-NetTCPConnection -LocalPort ${config.port} -State Listen | Select OwningProcess\n` +
        `                       Stop-Process -Id <OwningProcess>\n` +
        `         or set a different PORT (and BASE_URL) in .env.\n`
      );
    } else if (err.code === 'EACCES') {
      console.error(`\n[server] Not allowed to listen on port ${config.port}. Choose a port above 1024 in .env.\n`);
    } else {
      console.error(`\n[server] Failed to start: ${err.message}\n`);
    }
    await db.close().catch(() => {});
    process.exit(1);
  });

  const shutdown = (signal) => {
    console.log(`\n[server] ${signal} received, shutting down...`);
    server.close(async () => {
      await realtime.stop();
      await db.close().catch(() => {});
      process.exit(0);
    });
    // Live dashboard streams never end on their own; close them so shutdown is immediate.
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  start();
}

module.exports = app;
