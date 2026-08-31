const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'production';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'false';
process.env.JLT_AUTH_PASSWORD = 'test-owner-password';
process.env.JLT_SESSION_SECRET = 'test-session-secret-that-is-long-enough';
process.env.POSTGRES_RUNTIME_HOST = '127.0.0.1';
process.env.POSTGRES_RUNTIME_PORT = '5432';
process.env.POSTGRES_RUNTIME_USER = 'jlt_runtime';
process.env.POSTGRES_RUNTIME_PASSWORD = 'test-runtime-password';
process.env.POSTGRES_RUNTIME_DB = 'jlt_postgres';

const app = require('../src/app');

async function startServer() {
  const instance = app.listen(0);
  await new Promise((resolve) => instance.once('listening', resolve));
  return instance;
}

async function request(instance, path, options) {
  return fetch(`http://127.0.0.1:${instance.address().port}${path}`, options);
}

test('private API routes require a signed session and login sets an HttpOnly cookie', async () => {
  const instance = await startServer();
  try {
    const unauthenticated = await request(instance, '/api');
    assert.equal(unauthenticated.status, 401);
    const privateDashboard = await request(instance, '/api/dashboard');
    assert.equal(privateDashboard.status, 401);
    const privateExport = await request(instance, '/api/export');
    assert.equal(privateExport.status, 401);

    const rejectedLogin = await request(instance, '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong-password' }) });
    assert.equal(rejectedLogin.status, 401);

    const login = await request(instance, '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-owner-password' }) });
    assert.equal(login.status, 204);
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);

    const authenticated = await request(instance, '/api', { headers: { Cookie: cookie.split(';', 1)[0] } });
    assert.equal(authenticated.status, 200);

    const logout = await request(instance, '/api/auth/logout', { method: 'POST', headers: { Cookie: cookie.split(';', 1)[0] } });
    assert.equal(logout.status, 204);
    const afterLogout = await request(instance, '/api');
    assert.equal(afterLogout.status, 401);
  } finally {
    await new Promise((resolve, reject) => instance.close((error) => error ? reject(error) : resolve()));
  }
});
