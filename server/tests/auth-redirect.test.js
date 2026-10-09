const test = require('node:test');
const assert = require('node:assert/strict');

const { authRedirectUrl } = require('../src/auth/supabase');

function request(host) {
  return { get(name) { return name.toLowerCase() === 'host' ? host : ''; } };
}

test('auth redirects canonical Production and its stable alias to NippoTrack', () => {
  delete process.env.SUPABASE_AUTH_REDIRECT_URL;
  assert.equal(authRedirectUrl(request('nippotrack.vercel.app')), 'https://nippotrack.vercel.app/app', 'email links land in the app, not the landing');
  assert.equal(authRedirectUrl(request('nippotrack-yeferson-sena.vercel.app')), 'https://nippotrack.vercel.app/app');
});

test('auth redirects follow the requesting preview host (F correctness)', () => {
  delete process.env.SUPABASE_AUTH_REDIRECT_URL;
  assert.equal(
    authRedirectUrl(request('nippotrack-git-dev-abc123.vercel.app')),
    'https://nippotrack-git-dev-abc123.vercel.app/app'
  );
});

test('auth redirects keep local and configured local behavior compatible', () => {
  delete process.env.SUPABASE_AUTH_REDIRECT_URL;
  assert.equal(authRedirectUrl(request('localhost:5173')), 'http://localhost:5173/app');
  process.env.SUPABASE_AUTH_REDIRECT_URL = 'http://localhost:3000/';
  try {
    assert.equal(authRedirectUrl(request('localhost:5173')), 'http://localhost:3000/');
  } finally {
    delete process.env.SUPABASE_AUTH_REDIRECT_URL;
  }
});

test('auth redirects use configured fallback for malformed or untrusted hosts', () => {
  process.env.SUPABASE_AUTH_REDIRECT_URL = 'https://nippotrack.vercel.app/app';
  try {
    assert.equal(authRedirectUrl(request('nippotrack..vercel.app')), 'https://nippotrack.vercel.app/app');
    assert.equal(authRedirectUrl(request('evil.com')), 'https://nippotrack.vercel.app/app');
    assert.equal(authRedirectUrl(request('foo.vercel.app.evil.com')), 'https://nippotrack.vercel.app/app');
    assert.equal(authRedirectUrl(request('not a host!!')), 'https://nippotrack.vercel.app/app');
  } finally {
    delete process.env.SUPABASE_AUTH_REDIRECT_URL;
  }
});

test('auth redirects never echo untrusted hosts without configured fallback', () => {
  delete process.env.SUPABASE_AUTH_REDIRECT_URL;
  assert.equal(authRedirectUrl(request('evil.com')), 'http://localhost:5173/app');
  assert.equal(authRedirectUrl(request('foo.vercel.app.evil.com')), 'http://localhost:5173/app');
  assert.equal(authRedirectUrl(request('not a host!!')), 'http://localhost:5173/app');
});

test('explicit redirect configuration still wins (F correctness)', () => {
  process.env.SUPABASE_AUTH_REDIRECT_URL = 'https://example.com/auth/callback';
  try {
    assert.equal(authRedirectUrl(request('anything-else.example')), 'https://example.com/auth/callback');
  } finally {
    delete process.env.SUPABASE_AUTH_REDIRECT_URL;
  }
});
