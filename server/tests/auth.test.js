const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'production';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'false';
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

test('private API routes reject unauthenticated requests and obsolete single-password login is unavailable', async () => {
  const instance = await startServer();
  try {
    const unauthenticated = await request(instance, '/api');
    assert.equal(unauthenticated.status, 401);
    const privateDashboard = await request(instance, '/api/dashboard');
    assert.equal(privateDashboard.status, 401);
    const privateExport = await request(instance, '/api/export');
    assert.equal(privateExport.status, 401);

    const obsoleteLogin = await request(instance, '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'not-used' }) });
    assert.equal(obsoleteLogin.status, 401);
    const session = await request(instance, '/api/auth/session');
    assert.equal(session.status, 200);
    assert.deepEqual(await session.json(), { authenticated: false, emailVerified: false, user: null });
  } finally {
    await new Promise((resolve, reject) => instance.close((error) => error ? reject(error) : resolve()));
  }
});
