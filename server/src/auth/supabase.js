const { createClient } = require('@supabase/supabase-js');
const { createHash } = require('node:crypto');

const verifiedUsers = new Map();
const verificationTtlMs = 15_000;
const verificationTimeoutMs = 5_000;
const productionAuthRedirectUrl = 'https://nippotrack.vercel.app/app';
const defaultSupabaseUrl = 'https://milayuvlajmgrcxmrxdg.supabase.co';
const defaultSupabasePublishableKey = 'sb_publishable_UJQwQKZge3SKbj-j-BfVkg_2QmvbX4O';
const localDevelopmentToken = 'jlt-local-development';
const localAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isTestBypass() {
  return process.env.NODE_ENV === 'test' && process.env.JLT_AUTH_BYPASS_FOR_TESTS === 'true';
}

function localBypassUserFromRequest(req) {
  if (process.env.JLT_LOCAL_AUTH_BYPASS !== 'true' || process.env.NODE_ENV === 'production' || process.env.VERCEL === '1') return null;
  if (!localAddresses.has(req.socket?.remoteAddress || '')) return null;

  const authorization = req.get('authorization') || '';
  if (authorization !== `Bearer ${localDevelopmentToken}`) return null;

  const source = req.get('origin') || `http://${req.get('host') || ''}`;
  let hostname;
  try { hostname = new URL(source).hostname; } catch { return null; }
  if (hostname !== 'localhost' && !localAddresses.has(hostname)) return null;

  const id = process.env.JLT_LOCAL_AUTH_USER_ID || '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return null;
  return { id, email: 'local-development@jlt.invalid', email_confirmed_at: 'local-development' };
}

function configured(name, fallback) {
  const value = process.env[name];
  return value?.trim() || fallback;
}

let client;
function authClient() {
  if (!client) {
    client = createClient(
      configured('SUPABASE_URL', defaultSupabaseUrl),
      configured('SUPABASE_PUBLISHABLE_KEY', defaultSupabasePublishableKey),
      { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } }
    );
  }
  return client;
}

function authRedirectUrl(req) {
  // Derive redirects from the public host rather than VERCEL_ENV so a verified
  // Preview deployment can be promoted without rebuilding it for Production.
  const host = (req?.get?.('host') || '').toLowerCase().split(':')[0];
  if (host === 'nippotrack.vercel.app' || host === 'nippotrack-yeferson-sena.vercel.app') {
    return productionAuthRedirectUrl;
  }
  if (host.endsWith('.vercel.app')) {
    // Branch previews share one build: prefer the requesting preview host so
    // email confirm/recovery links return to the preview that sent them. Only
    // well-formed hostnames are echoed; anything else uses the safe fallback.
    if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.vercel\.app$/.test(host)) return `https://${host}/app`;
  }

  const configuredRedirect = process.env.SUPABASE_AUTH_REDIRECT_URL;
  if (configuredRedirect?.trim()) return configuredRedirect.trim();

  return 'http://localhost:5173/app';
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Supabase authentication timed out.')), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function verifiedUserFromRequest(req) {
  if (isTestBypass()) return { id: process.env.JLT_TEST_USER_ID || '00000000-0000-4000-8000-000000000001', email: 'test@jlt.local', email_confirmed_at: new Date().toISOString() };
  const localUser = localBypassUserFromRequest(req);
  if (localUser) return localUser;
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1];
  const key = createHash('sha256').update(token).digest('base64url');
  const cached = verifiedUsers.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.user;
  const { data, error } = await withTimeout(authClient().auth.getUser(token), verificationTimeoutMs);
  if (error || !data.user) return null;
  if (verifiedUsers.size >= 500) {
    for (const [cacheKey, entry] of verifiedUsers) {
      if (entry.expiresAt <= Date.now()) verifiedUsers.delete(cacheKey);
      if (verifiedUsers.size < 500) break;
    }
    if (verifiedUsers.size >= 500) verifiedUsers.delete(verifiedUsers.keys().next().value);
  }
  verifiedUsers.set(key, { user: data.user, expiresAt: Date.now() + verificationTtlMs });
  return data.user;
}

module.exports = { authClient, authRedirectUrl, isTestBypass, localBypassUserFromRequest, verifiedUserFromRequest };
