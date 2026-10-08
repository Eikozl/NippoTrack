const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const TEST_USER = '00000000-0000-4000-8000-000000000001';
const OTHER_USER = '00000000-0000-4000-8000-000000000002';

const pool = require('../src/config/db');
const app = require('../src/app');

test.after(async () => {
  await pool.end();
});

function installProfileStub(initial = {}) {
  const state = new Map(Object.entries(initial));
  const originalExecute = pool.execute;
  const seen = [];
  pool.execute = async (sql, params = []) => {
    seen.push({ sql, params });
    if (!/user_profile/i.test(sql)) return [[]];
    const userId = params[0];
    if (/^\s*SELECT/i.test(sql)) {
      const displayName = state.get(userId);
      return [displayName === undefined ? [] : [{ display_name: displayName, updated_at: '2026-09-09T00:00:00.000Z' }]];
    }
    if (/^\s*INSERT/i.test(sql)) {
      state.set(userId, params[1]);
      return [{ affectedRows: 1 }];
    }
    throw new Error(`Unexpected profile SQL: ${sql}`);
  };
  return { state, seen, restore() { pool.execute = originalExecute; } };
}

async function withServer(fn) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function requestJson(base, path, { method = 'GET', body, user = TEST_USER } = {}) {
  const prior = process.env.JLT_TEST_USER_ID;
  process.env.JLT_TEST_USER_ID = user;
  try {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let payload = null;
    try { payload = await response.json(); } catch { /* empty response */ }
    return { status: response.status, body: payload };
  } finally {
    if (prior === undefined) delete process.env.JLT_TEST_USER_ID;
    else process.env.JLT_TEST_USER_ID = prior;
  }
}

test('GET /api/profile returns a neutral empty profile and the authenticated email', async () => {
  const stub = installProfileStub();
  try {
    await withServer(async (base) => {
      const result = await requestJson(base, '/api/profile');
      assert.equal(result.status, 200);
      // avatarUrl is part of the shape (nav/settings read the photo here).
      assert.deepEqual(result.body, { displayName: null, avatarUrl: null, updatedAt: null, email: 'test@jlt.local' });
    });
  } finally {
    stub.restore();
  }
});

test('PUT /api/profile trims and persists Unicode display names', async () => {
  const stub = installProfileStub();
  try {
    await withServer(async (base) => {
      const result = await requestJson(base, '/api/profile', { method: 'PUT', body: { display_name: '  山田 太郎  ' } });
      assert.equal(result.status, 200);
      assert.equal(result.body.displayName, '山田 太郎');
      assert.equal(stub.state.get(TEST_USER), '山田 太郎');
    });
  } finally {
    stub.restore();
  }
});

test('PUT /api/profile accepts null or empty display names without inventing identity', async () => {
  const stub = installProfileStub({ [TEST_USER]: 'Luis' });
  try {
    await withServer(async (base) => {
      const cleared = await requestJson(base, '/api/profile', { method: 'PUT', body: { display_name: '   ' } });
      assert.equal(cleared.status, 200);
      assert.equal(cleared.body.displayName, null);
      assert.equal(stub.state.get(TEST_USER), null);
      const explicitNull = await requestJson(base, '/api/profile', { method: 'PUT', body: { display_name: null } });
      assert.equal(explicitNull.status, 200);
      assert.equal(explicitNull.body.displayName, null);
    });
  } finally {
    stub.restore();
  }
});

test('PUT /api/profile rejects non-string and overlong values before writing', async () => {
  const stub = installProfileStub();
  try {
    await withServer(async (base) => {
      for (const display_name of [42, {}, 'x'.repeat(51)]) {
        const result = await requestJson(base, '/api/profile', { method: 'PUT', body: { display_name } });
        assert.equal(result.status, 400);
      }
      assert.equal(stub.seen.filter(({ sql }) => /^\s*INSERT/i.test(sql)).length, 0);
    });
  } finally {
    stub.restore();
  }
});

test('profile reads and writes are isolated by the authenticated user id', async () => {
  const stub = installProfileStub({ [TEST_USER]: 'Luis' });
  try {
    await withServer(async (base) => {
      const otherRead = await requestJson(base, '/api/profile', { user: OTHER_USER });
      assert.equal(otherRead.body.displayName, null);
      await requestJson(base, '/api/profile', { method: 'PUT', body: { display_name: 'Other User' }, user: OTHER_USER });
      const firstRead = await requestJson(base, '/api/profile', { user: TEST_USER });
      assert.equal(firstRead.body.displayName, 'Luis');
      assert.equal(stub.state.get(OTHER_USER), 'Other User');
      const writes = stub.seen.filter(({ sql }) => /^\s*INSERT/i.test(sql));
      assert.ok(writes.every(({ params }) => [TEST_USER, OTHER_USER].includes(params[0])));
    });
  } finally {
    stub.restore();
  }
});
