const test = require('node:test');
const assert = require('node:assert/strict');

const { localBypassUserFromRequest } = require('../src/auth/supabase');

const developmentUserId = '11111111-1111-4111-8111-111111111111';

function request({ address = '127.0.0.1', origin = 'http://localhost:5173', token = 'jlt-local-development' } = {}) {
  return {
    socket: { remoteAddress: address },
    get(name) {
      if (name.toLowerCase() === 'origin') return origin;
      if (name.toLowerCase() === 'authorization') return `Bearer ${token}`;
      return '';
    }
  };
}

function configureLocalBypass() {
  process.env.JLT_LOCAL_AUTH_BYPASS = 'true';
  process.env.JLT_LOCAL_AUTH_USER_ID = developmentUserId;
  process.env.NODE_ENV = 'development';
  delete process.env.VERCEL;
}

test('local auth bypass accepts only its explicit token from localhost', () => {
  configureLocalBypass();

  assert.deepEqual(localBypassUserFromRequest(request()), {
    id: developmentUserId,
    email: 'local-development@jlt.invalid',
    email_confirmed_at: 'local-development'
  });
  assert.equal(localBypassUserFromRequest(request({ token: 'wrong' })), null);
  assert.equal(localBypassUserFromRequest(request({ address: '192.168.1.10' })), null);
  assert.equal(localBypassUserFromRequest(request({ origin: 'https://example.com' })), null);
});

test('local auth bypass stays disabled in Production and Vercel', () => {
  configureLocalBypass();
  process.env.NODE_ENV = 'production';
  assert.equal(localBypassUserFromRequest(request()), null);

  process.env.NODE_ENV = 'development';
  process.env.VERCEL = '1';
  assert.equal(localBypassUserFromRequest(request()), null);
});
