'use strict';

/**
 * Dashboard login: form-based sign-in that issues an HMAC-signed, HttpOnly
 * session cookie. Credentials come from DASHBOARD_USERNAME / DASHBOARD_PASSWORD
 * and the signing key from SECRET_KEY in .env.
 */

const crypto = require('crypto');
const config = require('../config');

const COOKIE_NAME = 'ccd_session';
const MAX_FAILURES = 5;
const LOCKOUT_MS = 5 * 60 * 1000;

// Without SECRET_KEY, sessions are signed with a per-process key (all users are
// logged out on restart) rather than a guessable default.
const signingKey = config.dashboard.secretKey || crypto.randomBytes(32).toString('hex');
const failures = new Map(); // ip -> { count, until }

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function sign(payload) {
  return crypto.createHmac('sha256', signingKey).update(payload).digest('base64url');
}

function createToken(username) {
  const payload = Buffer.from(
    JSON.stringify({ u: username, exp: Date.now() + config.dashboard.sessionHours * 3600 * 1000 })
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  const expected = sign(payload);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Date.now() || data.u !== config.dashboard.username) return null;
    return { username: data.u, expiresAt: data.exp };
  } catch (e) {
    return null;
  }
}

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '')
    .split(';')
    .forEach((part) => {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    });
  return out;
}

function currentUser(req) {
  return verifyToken(parseCookies(req)[COOKIE_NAME]);
}

function cookieAttributes(req, maxAgeSeconds) {
  const attrs = [`Path=/`, `HttpOnly`, `SameSite=Lax`, `Max-Age=${maxAgeSeconds}`];
  if (req.secure) attrs.push('Secure');
  return attrs.join('; ');
}

function isConfigured() {
  return Boolean(config.dashboard.username && config.dashboard.password);
}

/** Only allow same-site relative redirects after login. */
function safeNext(next) {
  return typeof next === 'string' && /^\/(?!\/)[\w\-./?=&#%]*$/.test(next) && !next.startsWith('/login') ? next : '/';
}

// -----------------------------------------------------------------------------
// Middleware
// -----------------------------------------------------------------------------

/** For pages: redirect to the login page when not signed in. */
function requirePageAuth(req, res, next) {
  if (currentUser(req)) return next();
  const target = req.originalUrl && req.originalUrl !== '/' ? `?next=${encodeURIComponent(req.originalUrl)}` : '';
  return res.redirect(302, `/login.html${target}`);
}

/** For JSON APIs: 401 when not signed in. */
function requireApiAuth(req, res, next) {
  const user = currentUser(req);
  if (user) {
    req.user = user;
    return next();
  }
  return res.status(401).json({ success: false, error: 'Not signed in.', login: '/login.html' });
}

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------

function login(req, res) {
  if (!isConfigured()) {
    return res.status(503).json({ success: false, error: 'Dashboard login is not configured. Set DASHBOARD_USERNAME and DASHBOARD_PASSWORD in .env.' });
  }

  const ip = req.ip || 'unknown';
  const record = failures.get(ip);
  if (record && record.until > Date.now()) {
    const wait = Math.ceil((record.until - Date.now()) / 1000);
    return res.status(429).json({ success: false, error: `Too many failed attempts. Try again in ${wait} seconds.` });
  }

  const { username = '', password = '' } = req.body || {};
  // Evaluate both comparisons so timing does not reveal which field was wrong.
  const userOk = safeEqual(username, config.dashboard.username);
  const passOk = safeEqual(password, config.dashboard.password);

  if (!(userOk && passOk)) {
    // Start a fresh count only after a previous lockout has expired.
    const lockoutExpired = record && record.until > 0 && record.until <= Date.now();
    const count = (record && !lockoutExpired ? record.count : 0) + 1;
    failures.set(ip, { count, until: count >= MAX_FAILURES ? Date.now() + LOCKOUT_MS : 0 });
    console.warn(`[auth] Failed dashboard login from ${ip} (${count}/${MAX_FAILURES})`);
    return res.status(401).json({ success: false, error: 'Invalid username or password.' });
  }

  failures.delete(ip);
  res.set('Set-Cookie', `${COOKIE_NAME}=${createToken(config.dashboard.username)}; ${cookieAttributes(req, config.dashboard.sessionHours * 3600)}`);
  return res.json({ success: true, username: config.dashboard.username, redirect: safeNext(req.body && req.body.next) });
}

function logout(req, res) {
  res.set('Set-Cookie', `${COOKIE_NAME}=; ${cookieAttributes(req, 0)}`);
  if (req.method === 'GET') return res.redirect(302, '/login.html');
  return res.json({ success: true });
}

function me(req, res) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ success: false, error: 'Not signed in.' });
  return res.json({ success: true, username: user.username, expiresAt: new Date(user.expiresAt).toISOString() });
}

module.exports = {
  currentUser,
  requirePageAuth,
  requireApiAuth,
  login,
  logout,
  me,
};
