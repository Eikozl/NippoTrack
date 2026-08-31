const { createClient } = require('@supabase/supabase-js');
const { createHash } = require('node:crypto');

const verifiedUsers = new Map();
const verificationTtlMs = 15_000;
const verificationTimeoutMs = 5_000;
const productionAuthRedirectUrl = 'https://japanese-learning-tracker.vercel.app/';
const previewAuthRedirectUrl = 'https://japanese-learning-tracker-git-master-yeferson-sena.vercel.app/';

function isTestBypass() {
  return process.env.NODE_ENV === 'test' && process.env.JLT_AUTH_BYPASS_FOR_TESTS === 'true';
}

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

let client;
function authClient() {
  if (!client) {
    client = createClient(required('SUPABASE_URL'), required('SUPABASE_PUBLISHABLE_KEY'), {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
    });
  }
  return client;
}

function authRedirectUrl() {
  // Vercel exposes VERCEL_ENV automatically. Prefer stable aliases so auth links
  // survive new deployments and no per-environment redirect variable is required.
  if (process.env.VERCEL_ENV === 'production') return productionAuthRedirectUrl;
  if (process.env.VERCEL_ENV === 'preview') return previewAuthRedirectUrl;

  const configured = process.env.SUPABASE_AUTH_REDIRECT_URL;
  if (configured?.trim()) return configured.trim();

  return 'http://localhost:5173/';
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

module.exports = { authClient, authRedirectUrl, isTestBypass, verifiedUserFromRequest };
