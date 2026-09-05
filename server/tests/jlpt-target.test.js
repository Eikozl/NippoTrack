const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const TEST_USER = '00000000-0000-4000-8000-000000000001';
const OTHER_USER = '00000000-0000-4000-8000-000000000002';

// Phase 11 — Target JLPT level (GET/PUT /api/level/target).
// A user goal / study intention, persisted per user in user_jlpt_target.
// Absent row = valid "no target" (null). Only exact N5..N1 accepted.
// Changing the target must never mutate review evidence, progress, goals,
// sessions, or encounters — only user_jlpt_target is ever written.

const DEFAULT_REFERENCE = { N5: 80, N4: 170, N3: 370, N2: 380, N1: 1000 };

function installTargetStub(state) {
  const pool = require('../src/config/db');
  const originalExecute = pool.execute;
  const seen = [];
  pool.execute = async (sql, params) => {
    seen.push({ sql, params });
    if (/user_jlpt_target/i.test(sql)) {
      const userId = params[0];
      if (/^\s*SELECT/i.test(sql)) {
        const level = state.targets[userId];
        return level ? [[{ target_level: level }]] : [[]];
      }
      if (/^\s*INSERT/i.test(sql)) {
        state.targets[userId] = params[1];
        return [[{ target_level: params[1] }]];
      }
      if (/^\s*DELETE/i.test(sql)) {
        delete state.targets[userId];
        return [[]];
      }
    }
    // Minimal evidence shapes so estimate/progress stay callable: proves a
    // target change leaves them untouched.
    if (/FROM kanji_reference/i.test(sql) && /GROUP BY jlpt_level/i.test(sql)) {
      return [Object.entries(state.reference || DEFAULT_REFERENCE).map(([band, total]) => ({ band, total }))];
    }
    if (/AS evidence/i.test(sql)) {
      const kanji = state.kanjiByUser[params[0]] || [];
      const groups = new Map();
      for (const entry of kanji) {
        const band = entry.refBand ?? entry.ownBand ?? null;
        const key = band || '__unclassified__';
        if (!groups.has(key)) groups.set(key, { band, collected: 0, reviewed: 0, repeated: 0 });
        const group = groups.get(key);
        group.collected += 1;
        if (entry.events >= 1) group.reviewed += 1;
        if (entry.events >= 2) group.repeated += 1;
      }
      return [[...groups.values()].map((group) => (/AS collected/i.test(sql)
        ? { band: group.band, collected: group.collected, reviewed: group.reviewed, repeated: group.repeated }
        : { band: group.band, eligible: group.reviewed, retained: group.repeated }))];
    }
    if (/SELECT \(SELECT COUNT\(\*\) FROM kanji/i.test(sql)) {
      const kanji = state.kanjiByUser[params[0]] || [];
      return [[{ collected: kanji.length, reviewed: kanji.filter((e) => e.events >= 1).length, exposure: 0 }]];
    }
    return [[]];
  };
  return { originalExecute, seen };
}

function restoreStub(stub) {
  require('../src/config/db').execute = stub.originalExecute;
}

test.after(async () => {
  try {
    await require('../src/config/db').end();
  } catch {
    // Pool may already be ended; ignore.
  }
});

async function withServer(fn) {
  const app = require('../src/app');
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function requestJson(base, path, { method = 'GET', body, user = TEST_USER } = {}) {
  const stubUser = process.env.JLT_TEST_USER_ID;
  process.env.JLT_TEST_USER_ID = user;
  try {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    let payload = null;
    try { payload = await response.json(); } catch { /* non-JSON error shape */ }
    return { status: response.status, body: payload };
  } finally {
    if (stubUser === undefined) delete process.env.JLT_TEST_USER_ID;
    else process.env.JLT_TEST_USER_ID = stubUser;
  }
}

function freshState(overrides = {}) {
  return { targets: {}, kanjiByUser: {}, reference: { ...DEFAULT_REFERENCE }, ...overrides };
}

const kanji = (band, events) => ({ refBand: band, ownBand: band, events });
const many = (count, band, events) => Array.from({ length: count }, () => kanji(band, events));

test('Phase 11: new user has no target', async () => {
  const stub = installTargetStub(freshState());
  try {
    await withServer(async (base) => {
      const { status, body } = await requestJson(base, '/api/level/target');
      assert.equal(status, 200);
      assert.deepEqual(body, { targetLevel: null });
    });
  } finally {
    restoreStub(stub);
  }
});

test('Phase 11: set N3 persists across reloads', async () => {
  const stub = installTargetStub(freshState());
  try {
    await withServer(async (base) => {
      const put = await requestJson(base, '/api/level/target', { method: 'PUT', body: { target_level: 'N3' } });
      assert.equal(put.status, 200);
      assert.deepEqual(put.body, { targetLevel: 'N3' });
    });
    await withServer(async (base) => {
      const got = await requestJson(base, '/api/level/target');
      assert.deepEqual(got.body, { targetLevel: 'N3' });
    });
  } finally {
    restoreStub(stub);
  }
});

test('Phase 11: change N3 to N2 persists correctly', async () => {
  const stub = installTargetStub(freshState({ targets: { [TEST_USER]: 'N3' } }));
  try {
    await withServer(async (base) => {
      const put = await requestJson(base, '/api/level/target', { method: 'PUT', body: { target_level: 'N2' } });
      assert.deepEqual(put.body, { targetLevel: 'N2' });
      const got = await requestJson(base, '/api/level/target');
      assert.deepEqual(got.body, { targetLevel: 'N2' });
    });
  } finally {
    restoreStub(stub);
  }
});

test('Phase 11: clearing the target returns the no-target state', async () => {
  const stub = installTargetStub(freshState({ targets: { [TEST_USER]: 'N3' } }));
  try {
    await withServer(async (base) => {
      const put = await requestJson(base, '/api/level/target', { method: 'PUT', body: { target_level: null } });
      assert.equal(put.status, 200);
      assert.deepEqual(put.body, { targetLevel: null });
      const got = await requestJson(base, '/api/level/target');
      assert.deepEqual(got.body, { targetLevel: null });
    });
  } finally {
    restoreStub(stub);
  }
});

test('Phase 11: invalid targets are rejected with 400', async () => {
  const stub = installTargetStub(freshState());
  const invalidBodies = [
    { target_level: 'N6' },
    { target_level: 'n3' },
    { target_level: '' },
    { target_level: 3 },
    { target_level: ['N3'] },
    {}
  ];
  try {
    await withServer(async (base) => {
      for (const body of invalidBodies) {
        const { status } = await requestJson(base, '/api/level/target', { method: 'PUT', body });
        assert.equal(status, 400, `expected 400 for ${JSON.stringify(body)}`);
      }
      const got = await requestJson(base, '/api/level/target');
      assert.deepEqual(got.body, { targetLevel: null });
    });
  } finally {
    restoreStub(stub);
  }
});

test('Phase 11: targets are isolated per user', async () => {
  const stub = installTargetStub(freshState());
  try {
    await withServer(async (base) => {
      await requestJson(base, '/api/level/target', { method: 'PUT', body: { target_level: 'N3' }, user: TEST_USER });
      const other = await requestJson(base, '/api/level/target', { user: OTHER_USER });
      assert.deepEqual(other.body, { targetLevel: null });
      await requestJson(base, '/api/level/target', { method: 'PUT', body: { target_level: 'N5' }, user: OTHER_USER });
      const first = await requestJson(base, '/api/level/target', { user: TEST_USER });
      assert.deepEqual(first.body, { targetLevel: 'N3' });
    });
  } finally {
    restoreStub(stub);
  }
});

test('Phase 11: setting a target does not modify estimate or progress evidence', async () => {
  const kanjiFixture = [...many(8, 'N5', 1), ...many(3, 'N4', 0)];
  const stub = installTargetStub(freshState({ kanjiByUser: { [TEST_USER]: kanjiFixture } }));
  try {
    await withServer(async (base) => {
      const beforeEstimate = await requestJson(base, '/api/level/estimate');
      const beforeProgress = await requestJson(base, '/api/level/progress');
      await requestJson(base, '/api/level/target', { method: 'PUT', body: { target_level: 'N3' } });
      const afterEstimate = await requestJson(base, '/api/level/estimate');
      const afterProgress = await requestJson(base, '/api/level/progress');
      assert.deepEqual(afterEstimate.body, beforeEstimate.body);
      assert.deepEqual(afterProgress.body, beforeProgress.body);
      assert.equal(afterEstimate.body.estimate.level, 'N5');
      assert.equal(afterProgress.body.bands.N5.reviewed, 8);
    });
  } finally {
    restoreStub(stub);
  }
});

test('Phase 11: target writes touch only user_jlpt_target, never goals', async () => {
  const stub = installTargetStub(freshState());
  try {
    await withServer(async (base) => {
      await requestJson(base, '/api/level/target', { method: 'PUT', body: { target_level: 'N2' } });
      await requestJson(base, '/api/level/target', { method: 'PUT', body: { target_level: null } });
    });
    const writes = stub.seen.filter((entry) => /INSERT|UPDATE|DELETE/i.test(entry.sql));
    assert.ok(writes.length > 0, 'expected target writes to be recorded');
    assert.ok(writes.every((entry) => /user_jlpt_target/i.test(entry.sql)), 'writes must stay inside user_jlpt_target');
    assert.ok(!stub.seen.some((entry) => /goals/i.test(entry.sql)), 'target must never create or touch goals');
  } finally {
    restoreStub(stub);
  }
});

test('Phase 11: repeated PUT and clear are idempotent', async () => {
  const stub = installTargetStub(freshState());
  try {
    await withServer(async (base) => {
      await requestJson(base, '/api/level/target', { method: 'PUT', body: { target_level: 'N3' } });
      const repeat = await requestJson(base, '/api/level/target', { method: 'PUT', body: { target_level: 'N3' } });
      assert.deepEqual(repeat.body, { targetLevel: 'N3' });
      await requestJson(base, '/api/level/target', { method: 'PUT', body: { target_level: null } });
      const clearAgain = await requestJson(base, '/api/level/target', { method: 'PUT', body: { target_level: null } });
      assert.equal(clearAgain.status, 200);
      assert.deepEqual(clearAgain.body, { targetLevel: null });
    });
  } finally {
    restoreStub(stub);
  }
});

test('Phase 11: missing body is rejected without side effects', async () => {
  const stub = installTargetStub(freshState());
  try {
    await withServer(async (base) => {
      const { status } = await requestJson(base, '/api/level/target', { method: 'PUT' });
      assert.equal(status, 400);
      const got = await requestJson(base, '/api/level/target');
      assert.deepEqual(got.body, { targetLevel: null });
    });
  } finally {
    restoreStub(stub);
  }
});

test('Phase 11: corrupted stored value degrades to no-target', async () => {
  const stub = installTargetStub(freshState({ targets: { [TEST_USER]: 'N9' } }));
  try {
    await withServer(async (base) => {
      const { status, body } = await requestJson(base, '/api/level/target');
      assert.equal(status, 200);
      assert.deepEqual(body, { targetLevel: null });
    });
  } finally {
    restoreStub(stub);
  }
});

test('Phase 11: target GET is read-only and returns the exact band string', async () => {
  const stub = installTargetStub(freshState({ targets: { [TEST_USER]: 'N1' } }));
  try {
    await withServer(async (base) => {
      const { status, body } = await requestJson(base, '/api/level/target');
      assert.equal(status, 200);
      assert.equal(body.targetLevel, 'N1');
    });
    assert.ok(!stub.seen.some((entry) => /INSERT|UPDATE|DELETE/i.test(entry.sql)));
  } finally {
    restoreStub(stub);
  }
});
