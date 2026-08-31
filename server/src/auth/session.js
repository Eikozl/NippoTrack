const crypto = require('node:crypto');

const COOKIE_NAME = 'jlt_session';
const MAX_SESSION_HOURS = 24 * 30;

function isTestBypass() {
  return process.env.NODE_ENV === 'test' && process.env.JLT_AUTH_BYPASS_FOR_TESTS === 'true';
}

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function config() {
  if (isTestBypass()) return { bypass: true };

  const password = process.env.JLT_AUTH_PASSWORD;
  const passwordHash = process.env.JLT_AUTH_PASSWORD_HASH;
  if (!password && !passwordHash) throw new Error('Configure JLT_AUTH_PASSWORD or JLT_AUTH_PASSWORD_HASH before starting JLT.');

  const secret = process.env.JLT_SESSION_SECRET || (process.env.NODE_ENV === 'production' ? required('JLT_SESSION_SECRET') : crypto.createHash('sha512').update(`jlt-local-session:${password}`).digest('base64url'));
  const requestedHours = Number(process.env.JLT_SESSION_TTL_HOURS || 168);
  const sessionHours = Number.isFinite(requestedHours) ? Math.min(Math.max(requestedHours, 1), MAX_SESSION_HOURS) : 168;
  return { password, passwordHash, secret, sessionHours };
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function passwordMatches(candidate) {
  const settings = config();
  if (settings.bypass) return true;
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  if (settings.passwordHash) {
    const [algorithm, salt, expected] = settings.passwordHash.split('$');
    if (algorithm !== 'scrypt' || !salt || !expected) return false;
    const derived = crypto.scryptSync(candidate, salt, 64).toString('base64url');
    return safeEqual(derived, expected);
  }
  return safeEqual(candidate, settings.password);
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function createSession() {
  const settings = config();
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ sub: 'jlt-owner', iat: now, exp: now + (settings.sessionHours * 60 * 60), nonce: crypto.randomBytes(16).toString('base64url') })).toString('base64url');
  return `${payload}.${sign(payload, settings.secret)}`;
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => part.trim().split(/=(.*)/s, 2)).filter(([name]) => name));
}

function readSession(req) {
  const settings = config();
  if (settings.bypass) return { sub: 'jlt-test' };
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token || !token.includes('.')) return null;
  const [payload, signature] = token.split('.', 2);
  if (!safeEqual(signature, sign(payload, settings.secret))) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return decoded?.sub === 'jlt-owner' && Number(decoded.exp) > Math.floor(Date.now() / 1000) ? decoded : null;
  } catch {
    return null;
  }
}

function cookieOptions() {
  const settings = config();
  return { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: settings.sessionHours * 60 * 60 * 1000 };
}

module.exports = { COOKIE_NAME, cookieOptions, createSession, isTestBypass, passwordMatches, readSession };
