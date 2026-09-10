const test = require('node:test');
const assert = require('node:assert/strict');

const { authRedirectUrl } = require('../src/auth/supabase');

function request(host) {
  return { get(name) { return name.toLowerCase() === 'host' ? host : ''; } };
}

test('auth redirects keep the pinned production hosts (F correctness)', () => {
  delete process.env.SUPABASE_AUTH_REDIRECT_URL;
  assert.equal(authRedirectUrl(request('japanese-learning-tracker.vercel.app')), 'https://japanese-learning-tracker.vercel.app/');
  assert.equal(authRedirectUrl(request('japanese-learning-tracker-yeferson-sena.vercel.app')), 'https://japanese-learning-tracker.vercel.app/');
});

test('auth redirects follow the requesting preview host (F correctness)', () => {
  delete process.env.SUPABASE_AUTH_REDIRECT_URL;
  assert.equal(
    authRedirectUrl(request('japanese-learning-tracker-git-phase0-openjlpt-integration-abc123.vercel.app')),
    'https://japanese-learning-tracker-git-phase0-openjlpt-integration-abc123.vercel.app/'
  );
});

test('auth redirects never echo untrusted hosts (F correctness)', () => {
  delete process.env.SUPABASE_AUTH_REDIRECT_URL;
  assert.equal(authRedirectUrl(request('evil.com')), 'http://localhost:5173/');
  assert.equal(authRedirectUrl(request('foo.vercel.app.evil.com')), 'http://localhost:5173/');
  assert.equal(authRedirectUrl(request('not a host!!')), 'http://localhost:5173/');
});

test('explicit redirect configuration still wins (F correctness)', () => {
  process.env.SUPABASE_AUTH_REDIRECT_URL = 'https://example.com/auth/callback';
  try {
    assert.equal(authRedirectUrl(request('anything-else.example')), 'https://example.com/auth/callback');
  } finally {
    delete process.env.SUPABASE_AUTH_REDIRECT_URL;
  }
});
