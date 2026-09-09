const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const TEST_USER = '00000000-0000-4000-8000-000000000001';
const OTHER_USER = '00000000-0000-4000-8000-000000000002';

// NippoTrack v5.1-A.2 — first-experience API (GET /api/first-experience,
// PUT /api/first-experience/onboarding). Ownership always derives from the
// auth bypass user (req.user.id); body user ids are never read. The pool is
// stubbed in-memory (same boot/auth-bypass conventions as jlpt-target.test.js)
// with transaction snapshot semantics so atomicity/rollback is verifiable.

function freshState(overrides = {}) {
  return { targets: {}, firstExp: {}, failFirstExperienceWrite: false, ...overrides };
}

function seedRow(overrides = {}) {
  return {
    onboarding_completed_at: '2026-09-01T00:00:00.000Z',
    study_sources: ['manga'],
    placement_status: 'not_started',
    placement_estimate: null,
    ...overrides
  };
}

function installFirstExperienceStub(state) {
  const pool = require('../src/config/db');
  const originalExecute = pool.execute;
  const originalGetConnection = pool.getConnection;
  const seen = [];

  async function handleExecute(sql, params = []) {
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
    if (/user_first_experience/i.test(sql)) {
      if (/^\s*SELECT/i.test(sql)) {
        const row = state.firstExp[params[0]];
        return row ? [[{ ...row, study_sources: [...row.study_sources] }]] : [[]];
      }
      if (/^\s*INSERT/i.test(sql)) {
        if (state.failFirstExperienceWrite) {
          throw new Error('simulated first-experience write failure');
        }
        // A.2 onboarding upserts mirror the real SQL: the CASE guard preserves
        // a completed placement, and all other placement columns survive.
        const userId = params[0];
        const existing = state.firstExp[userId];
        const priorStatus = existing ? existing.placement_status : 'not_started';
        state.firstExp[userId] = {
          ...(existing || {}),
          onboarding_completed_at: '2026-09-09T00:00:00.000Z',
          study_sources: [...params[1]],
          placement_status: /'skipped'/i.test(sql) && priorStatus !== 'completed' ? 'skipped' : priorStatus,
          placement_estimate: existing ? existing.placement_estimate : null,
          placement_completed_at: existing ? (existing.placement_completed_at ?? null) : null,
          placement_total_correct: existing ? (existing.placement_total_correct ?? null) : null,
          placement_correct_n5: existing ? (existing.placement_correct_n5 ?? null) : null,
          placement_correct_n4: existing ? (existing.placement_correct_n4 ?? null) : null,
          placement_correct_n3: existing ? (existing.placement_correct_n3 ?? null) : null,
          placement_correct_n2: existing ? (existing.placement_correct_n2 ?? null) : null,
          placement_correct_n1: existing ? (existing.placement_correct_n1 ?? null) : null
        };
        return [{ affectedRows: 1 }];
      }
    }
    return [[]];
  }

  pool.execute = handleExecute;
  pool.getConnection = async () => {
    let snapshot = null;
    return {
      execute: handleExecute,
      query: handleExecute,
      beginTransaction: async () => {
        snapshot = JSON.parse(JSON.stringify({ targets: state.targets, firstExp: state.firstExp }));
      },
      commit: async () => { snapshot = null; },
      rollback: async () => {
        if (snapshot) {
          state.targets = snapshot.targets;
          state.firstExp = snapshot.firstExp;
          snapshot = null;
        }
      },
      release: () => {}
    };
  };

  return { seen, restore() { pool.execute = originalExecute; pool.getConnection = originalGetConnection; } };
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

const NEVER_ONBOARDED = {
  onboarding: { completed: false, studySources: [] },
  placement: { status: 'not_started', estimate: null, source: null, completedAt: null, result: null },
  targetLevel: null
};

test('A.2: absent row returns the never-onboarded shape', async () => {
  const stub = installFirstExperienceStub(freshState());
  try {
    await withServer(async (base) => {
      const { status, body } = await requestJson(base, '/api/first-experience');
      assert.equal(status, 200);
      assert.deepEqual(body, NEVER_ONBOARDED);
    });
  } finally {
    stub.restore();
  }
});

test('A.2: absent row still surfaces the stored target level', async () => {
  const stub = installFirstExperienceStub(freshState({ targets: { [TEST_USER]: 'N3' } }));
  try {
    await withServer(async (base) => {
      const { status, body } = await requestJson(base, '/api/first-experience');
      assert.equal(status, 200);
      assert.deepEqual(body, { ...NEVER_ONBOARDED, targetLevel: 'N3' });
    });
  } finally {
    stub.restore();
  }
});

test('A.2: existing placement state is surfaced read-only', async () => {
  const stub = installFirstExperienceStub(freshState({
    firstExp: { [TEST_USER]: seedRow({ placement_status: 'completed', placement_estimate: 'N2' }) },
    targets: { [TEST_USER]: 'N2' }
  }));
  try {
    await withServer(async (base) => {
      const { status, body } = await requestJson(base, '/api/first-experience');
      assert.equal(status, 200);
      assert.deepEqual(body, {
        onboarding: { completed: true, studySources: ['manga'] },
        placement: { status: 'completed', estimate: 'N2', source: null, completedAt: null, result: null },
        targetLevel: 'N2'
      });
    });
    assert.ok(!stub.seen.some((entry) => /INSERT|UPDATE|DELETE/i.test(entry.sql)), 'GET must be read-only');
  } finally {
    stub.restore();
  }
});

test('A.2: invalid targetLevel values are rejected with 400', async () => {
  const stub = installFirstExperienceStub(freshState());
  const invalidBodies = [
    { targetLevel: 'N6', studySources: [] },
    { targetLevel: 'n3', studySources: [] },
    { targetLevel: '', studySources: [] },
    { targetLevel: 3, studySources: [] },
    { targetLevel: ['N3'], studySources: [] },
    { studySources: [] }
  ];
  try {
    await withServer(async (base) => {
      for (const body of invalidBodies) {
        const { status } = await requestJson(base, '/api/first-experience/onboarding', { method: 'PUT', body });
        assert.equal(status, 400, `expected 400 for ${JSON.stringify(body)}`);
      }
      const noBody = await requestJson(base, '/api/first-experience/onboarding', { method: 'PUT' });
      assert.equal(noBody.status, 400);
      const got = await requestJson(base, '/api/first-experience');
      assert.deepEqual(got.body, NEVER_ONBOARDED);
    });
  } finally {
    stub.restore();
  }
});

test('A.2: invalid studySources values are rejected with 400', async () => {
  const stub = installFirstExperienceStub(freshState());
  const invalidSources = [
    ['telepathy'],
    ['manga', 'manga'],
    ['apps', 'apps', 'apps'],
    'anime-drama',
    null,
    [3],
    [null],
    ['Manga'],
    ['N5'],
    ['']
  ];
  try {
    await withServer(async (base) => {
      for (const studySources of invalidSources) {
        const { status } = await requestJson(base, '/api/first-experience/onboarding', {
          method: 'PUT',
          body: { targetLevel: 'N3', studySources }
        });
        assert.equal(status, 400, `expected 400 for ${JSON.stringify(studySources)}`);
      }
      const missing = await requestJson(base, '/api/first-experience/onboarding', {
        method: 'PUT',
        body: { targetLevel: 'N3' }
      });
      assert.equal(missing.status, 400);
      const got = await requestJson(base, '/api/first-experience');
      assert.deepEqual(got.body, NEVER_ONBOARDED);
    });
  } finally {
    stub.restore();
  }
});

test('A.2: body user ids are ignored; rows are isolated per user', async () => {
  const stub = installFirstExperienceStub(freshState());
  try {
    await withServer(async (base) => {
      const put = await requestJson(base, '/api/first-experience/onboarding', {
        method: 'PUT',
        body: { targetLevel: 'N4', studySources: ['apps'], user_id: OTHER_USER, userId: OTHER_USER }
      });
      assert.equal(put.status, 200);
      assert.deepEqual(put.body, {
        onboarding: { completed: true, studySources: ['apps'] },
        placement: { status: 'not_started', estimate: null, source: null, completedAt: null, result: null },
        targetLevel: 'N4'
      });
      const other = await requestJson(base, '/api/first-experience', { user: OTHER_USER });
      assert.deepEqual(other.body, NEVER_ONBOARDED);
      await requestJson(base, '/api/first-experience/onboarding', {
        method: 'PUT',
        body: { targetLevel: 'N1', studySources: ['manga'] },
        user: OTHER_USER
      });
      const first = await requestJson(base, '/api/first-experience', { user: TEST_USER });
      assert.deepEqual(first.body.targetLevel, 'N4');
      assert.deepEqual(first.body.onboarding.studySources, ['apps']);
      const second = await requestJson(base, '/api/first-experience', { user: OTHER_USER });
      assert.deepEqual(second.body.targetLevel, 'N1');
      assert.deepEqual(second.body.onboarding.studySources, ['manga']);
    });
  } finally {
    stub.restore();
  }
});

test('A.2: invalid sources leave target and row unchanged', async () => {
  const state = freshState({
    targets: { [TEST_USER]: 'N2' },
    firstExp: { [TEST_USER]: seedRow() }
  });
  const stub = installFirstExperienceStub(state);
  try {
    await withServer(async (base) => {
      const { status } = await requestJson(base, '/api/first-experience/onboarding', {
        method: 'PUT',
        body: { targetLevel: 'N1', studySources: ['bogus-source'] }
      });
      assert.equal(status, 400);
      const got = await requestJson(base, '/api/first-experience');
      assert.deepEqual(got.body, {
        onboarding: { completed: true, studySources: ['manga'] },
        placement: { status: 'not_started', estimate: null, source: null, completedAt: null, result: null },
        targetLevel: 'N2'
      });
    });
  } finally {
    stub.restore();
  }
});

test('A.2: mid-transaction write failure rolls back the target write', async () => {
  const state = freshState({
    targets: { [TEST_USER]: 'N2' },
    firstExp: { [TEST_USER]: seedRow() },
    failFirstExperienceWrite: true
  });
  const stub = installFirstExperienceStub(state);
  try {
    await withServer(async (base) => {
      const { status } = await requestJson(base, '/api/first-experience/onboarding', {
        method: 'PUT',
        body: { targetLevel: 'N1', studySources: ['apps'] }
      });
      assert.equal(status, 503);
      state.failFirstExperienceWrite = false;
      const got = await requestJson(base, '/api/first-experience');
      assert.deepEqual(got.body, {
        onboarding: { completed: true, studySources: ['manga'] },
        placement: { status: 'not_started', estimate: null, source: null, completedAt: null, result: null },
        targetLevel: 'N2'
      });
    });
  } finally {
    stub.restore();
  }
});

test('A.2: skip-setup completes onboarding with skipped placement and invents nothing', async () => {
  const stub = installFirstExperienceStub(freshState());
  try {
    await withServer(async (base) => {
      const { status, body } = await requestJson(base, '/api/first-experience/onboarding', {
        method: 'PUT',
        body: { targetLevel: null, studySources: [], placementStatus: 'skipped' }
      });
      assert.equal(status, 200);
      assert.deepEqual(body, {
        onboarding: { completed: true, studySources: [] },
        placement: { status: 'skipped', estimate: null, source: null, completedAt: null, result: null },
        targetLevel: null
      });
      const got = await requestJson(base, '/api/first-experience');
      assert.deepEqual(got.body, body);
    });
  } finally {
    stub.restore();
  }
});

test('A.2: non-skipped placementStatus values are rejected with 400', async () => {
  const stub = installFirstExperienceStub(freshState());
  const invalidStatuses = ['not_started', 'completed', null, 'SKIPPED', '', 3];
  try {
    await withServer(async (base) => {
      for (const placementStatus of invalidStatuses) {
        const { status } = await requestJson(base, '/api/first-experience/onboarding', {
          method: 'PUT',
          body: { targetLevel: 'N5', studySources: [], placementStatus }
        });
        assert.equal(status, 400, `expected 400 for ${JSON.stringify(placementStatus)}`);
      }
      const got = await requestJson(base, '/api/first-experience');
      assert.deepEqual(got.body, NEVER_ONBOARDED);
    });
  } finally {
    stub.restore();
  }
});

test('A.2: completed onboarding persists across reloads', async () => {
  const stub = installFirstExperienceStub(freshState());
  const expected = {
    onboarding: { completed: true, studySources: ['textbooks', 'apps'] },
    placement: { status: 'not_started', estimate: null, source: null, completedAt: null, result: null },
    targetLevel: 'N4'
  };
  try {
    await withServer(async (base) => {
      const put = await requestJson(base, '/api/first-experience/onboarding', {
        method: 'PUT',
        body: { targetLevel: 'N4', studySources: ['textbooks', 'apps'] }
      });
      assert.equal(put.status, 200);
      assert.deepEqual(put.body, expected);
    });
    await withServer(async (base) => {
      const got = await requestJson(base, '/api/first-experience');
      assert.deepEqual(got.body, expected);
    });
  } finally {
    stub.restore();
  }
});

test('A.2: existing target endpoint is untouched', async () => {
  const stub = installFirstExperienceStub(freshState());
  try {
    await withServer(async (base) => {
      const put = await requestJson(base, '/api/level/target', { method: 'PUT', body: { target_level: 'N3' } });
      assert.equal(put.status, 200);
      assert.deepEqual(put.body, { targetLevel: 'N3' });
      const got = await requestJson(base, '/api/level/target');
      assert.deepEqual(got.body, { targetLevel: 'N3' });
      const first = await requestJson(base, '/api/first-experience');
      assert.deepEqual(first.body, { ...NEVER_ONBOARDED, targetLevel: 'N3' });
    });
    const writes = stub.seen.filter((entry) => /INSERT|UPDATE|DELETE/i.test(entry.sql));
    assert.ok(writes.length > 0, 'expected target writes to be recorded');
    assert.ok(writes.every((entry) => /user_jlpt_target/i.test(entry.sql)), 'target writes must stay inside user_jlpt_target');
  } finally {
    stub.restore();
  }
});

test('GET placement surfaces the persisted breakdown when present', async () => {
  const stub = installFirstExperienceStub(freshState({
    firstExp: {
      [TEST_USER]: seedRow({
        placement_status: 'completed',
        placement_estimate: 'N2',
        placement_completed_at: '2026-09-02T00:00:00.000Z',
        placement_total_correct: 7,
        placement_correct_n5: 2,
        placement_correct_n4: 2,
        placement_correct_n3: 2,
        placement_correct_n2: 1,
        placement_correct_n1: 0
      })
    },
    targets: { [TEST_USER]: 'N2' }
  }));
  try {
    await withServer(async (base) => {
      const { status, body } = await requestJson(base, '/api/first-experience');
      assert.equal(status, 200);
      assert.deepEqual(body, {
        onboarding: { completed: true, studySources: ['manga'] },
        placement: {
          status: 'completed',
          estimate: 'N2',
          source: null,
          completedAt: '2026-09-02T00:00:00.000Z',
          // Legacy 5-band row: the fixed contract surfaces only N5/N4/N3.
          result: { totalCorrect: 7, byBand: { N5: 2, N4: 2, N3: 2 } }
        },
        targetLevel: 'N2'
      });
    });
    assert.ok(!stub.seen.some((entry) => /INSERT|UPDATE|DELETE/i.test(entry.sql)), 'GET must be read-only');
  } finally {
    stub.restore();
  }
});

test('GET placement returns result:null for pre-breakdown completed rows (015 NULLs)', async () => {
  const stub = installFirstExperienceStub(freshState({
    firstExp: {
      [TEST_USER]: seedRow({
        placement_status: 'completed',
        placement_estimate: 'N3',
        placement_completed_at: '2026-09-02T00:00:00.000Z'
      })
    }
  }));
  try {
    await withServer(async (base) => {
      const { status, body } = await requestJson(base, '/api/first-experience');
      assert.equal(status, 200);
      assert.deepEqual(body.placement, {
        status: 'completed',
        estimate: 'N3',
        source: null,
        completedAt: '2026-09-02T00:00:00.000Z',
        result: null
      });
    });
  } finally {
    stub.restore();
  }
});

test('Onboarding PUT skip after completion never downgrades to skipped', async () => {
  const stub = installFirstExperienceStub(freshState({
    firstExp: {
      [TEST_USER]: seedRow({
        placement_status: 'completed',
        placement_estimate: 'N5',
        placement_completed_at: '2026-09-02T00:00:00.000Z',
        placement_total_correct: 0,
        placement_correct_n5: 0,
        placement_correct_n4: 0,
        placement_correct_n3: 0,
        placement_correct_n2: 0,
        placement_correct_n1: 0
      })
    }
  }));
  try {
    await withServer(async (base) => {
      const { status, body } = await requestJson(base, '/api/first-experience/onboarding', {
        method: 'PUT',
        body: { targetLevel: 'N5', studySources: ['apps'], placementStatus: 'skipped' }
      });
      assert.equal(status, 200);
      assert.deepEqual(body, {
        onboarding: { completed: true, studySources: ['apps'] },
        placement: {
          status: 'completed',
          estimate: 'N5',
          source: null,
          completedAt: '2026-09-02T00:00:00.000Z',
          result: { totalCorrect: 0, byBand: { N5: 0, N4: 0, N3: 0 } }
        },
        targetLevel: 'N5'
      });
    });
  } finally {
    stub.restore();
  }
});
