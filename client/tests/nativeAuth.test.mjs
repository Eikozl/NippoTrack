import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NATIVE_AUTH_SCHEME,
  handleNativeAuthUrl,
  initNativeAuth,
  isNativeAuthUrl
} from '../src/nativeAuth.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');

function fakeSupabase(calls) {
  return {
    auth: {
      async exchangeCodeForSession(code) { calls.push(['exchange', code]); return {}; },
      async setSession(session) { calls.push(['session', session]); return {}; },
      async verifyOtp(payload) { calls.push(['verify', payload]); return {}; }
    }
  };
}

test('only the app callback scheme is recognized', () => {
  assert.equal(isNativeAuthUrl('nippotrack://auth/callback?code=abc'), true);
  assert.equal(isNativeAuthUrl('NIPPOTRACK://auth/callback#access_token=x'), true);
  assert.equal(isNativeAuthUrl('https://nippotrack.vercel.app/app?code=abc'), false);
  assert.equal(isNativeAuthUrl('nippotrack://evil'), false);
  assert.equal(isNativeAuthUrl('not a url'), false);
  assert.equal(NATIVE_AUTH_SCHEME, 'nippotrack://auth/callback');
});

test('code exchange establishes the session', async () => {
  const calls = [];
  const result = await handleNativeAuthUrl('nippotrack://auth/callback?code=abc123', fakeSupabase(calls));
  assert.deepEqual(result, { handled: true });
  assert.deepEqual(calls, [['exchange', 'abc123']]);
});

test('implicit tokens and verify links establish the session', async () => {
  const first = [];
  const access = await handleNativeAuthUrl('nippotrack://auth/callback#access_token=at&refresh_token=rt', fakeSupabase(first));
  assert.deepEqual(access, { handled: true });
  assert.deepEqual(first, [['session', { access_token: 'at', refresh_token: 'rt' }]]);
  const second = [];
  const verify = await handleNativeAuthUrl('nippotrack://auth/callback?token_hash=h&type=signup', fakeSupabase(second));
  assert.deepEqual(verify, { handled: true });
  assert.deepEqual(second, [[ 'verify', { type: 'signup', token_hash: 'h' }]]);
});

test('non-callback and error payloads never touch auth', async () => {
  const calls = [];
  const supabase = fakeSupabase(calls);
  assert.deepEqual(await handleNativeAuthUrl('https://example.com/?code=x', supabase), { handled: false, reason: 'not-an-auth-callback' });
  assert.deepEqual(await handleNativeAuthUrl('nippotrack://auth/callback', supabase), { handled: false, reason: 'no-auth-payload' });
  const failure = await handleNativeAuthUrl('nippotrack://auth/callback?error=access_denied&error_description=nope', supabase);
  assert.equal(failure.handled, false);
  assert.deepEqual(calls, []);
});

test('backend failures surface as unhandled, never throw', async () => {
  const failing = { auth: { async exchangeCodeForSession() { return { error: new Error('expired') }; } } };
  const result = await handleNativeAuthUrl('nippotrack://auth/callback?code=old', failing);
  assert.equal(result.handled, false);
  assert.equal(await handleNativeAuthUrl('nippotrack://auth/callback?code=x', null).then((r) => r.handled), false);
});

test('init is a no-op without the Capacitor plugin', () => {
  assert.equal(initNativeAuth({ supabase: null, onAuthenticated: null }), false);
});

test('sign-up and recovery request the native callback only in the shell', () => {
  const source = readSource('src/authModal.js');
  assert.ok(source.includes('window.Capacitor'), 'native shell detected on the client');
  assert.ok(source.includes('nativeApp: true'), 'opt-in flag sent with auth emails');
  assert.ok(source.includes('come back here and sign in'), 'copy tells shell users where to finish');
});
