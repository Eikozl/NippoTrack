const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';
process.env.POSTGRES_HOST = process.env.POSTGRES_HOST || '127.0.0.1';
process.env.POSTGRES_PORT = process.env.POSTGRES_PORT || '5432';
process.env.POSTGRES_USER = process.env.POSTGRES_USER || 'jlt_test';
process.env.POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD ?? 'test-only';
process.env.POSTGRES_DB = process.env.POSTGRES_DB || 'jlt';

const reviewController = require('../src/controllers/reviewController');
const pool = require('../src/config/db');
const app = require('../src/app');

const USER_ID = '00000000-0000-4000-8000-000000000001';

function mockRes() {
  let statusCode = 200;
  let body;
  const res = {
    status(code) { statusCode = code; return res; },
    json(value) { body = value; return res; }
  };
  return { res, status: () => statusCode, body: () => body };
}

function daysAgo(n) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// Most recent Sep 05 on or before today, with a valid 9-day window around it.
// Guarantees the "Reviewed ... Sep D" label without ever using a future date.
function recentSeptemberWindow() {
  const todayStr = new Date().toISOString().slice(0, 10);
  const year = Number(todayStr.slice(0, 4));
  const cand = `${year}-09-05`;
  if (cand <= todayStr) {
    const to = `${year}-09-10` <= todayStr ? `${year}-09-10` : todayStr;
    return { evidence: cand, from: `${year}-09-01`, to };
  }
  const prev = year - 1;
  return { evidence: `${prev}-09-05`, from: `${prev}-09-01`, to: `${prev}-09-10` };
}

function reviewRow({ type = 'kanji', id = 1, display = '日', reading = null, meaning = 'day', jlpt = 'N5', date = '2026-09-05', result = 'Good' } = {}) {
  return { entity_type: type, entity_id: id, display, reading, meaning, jlpt, source_date: date, source_ts: date, source_result: result };
}

function sessionRow({ type = 'kanji', id = 1, display = '日', reading = null, meaning = 'day', jlpt = 'N5', date = '2026-09-05', category = 'Reading', duration = 30 } = {}) {
  return { entity_type: type, entity_id: id, display, reading, meaning, jlpt, source_date: date, source_ts: date, source_category: category, source_duration: duration };
}

function encounterRow({ id = 1, display = '日', reading = null, meaning = 'day', jlpt = 'N5', date = '2026-09-05', sourceType = 'session_writing', vocabWord = null, writingTitle = 'Session writing' } = {}) {
  return { entity_type: 'kanji', entity_id: id, display, reading, meaning, jlpt, source_date: date, source_ts: date, source_type: sourceType, source_id: 61, vocab_word: vocabWord, writing_title: writingTitle };
}

function addedRow({ type = 'kanji', id = 1, display = '日', reading = null, meaning = 'day', jlpt = 'N5', date = '2026-09-05' } = {}) {
  return { entity_type: type, entity_id: id, display, reading, meaning, jlpt, source_date: date, source_ts: date };
}

function stubCandidatesExecute({ reviewRows = [], sessionRows = [], encounterRows = [], addedRows = [], seen = [] }) {
  return async (sql, params) => {
    seen.push({ sql, params });
    if (/kanji_encounters/i.test(sql)) return [encounterRows];
    if (/review_events/i.test(sql)) return [reviewRows];
    if (/study_sessions/i.test(sql)) return [sessionRows];
    if (/created_at/i.test(sql)) return [addedRows];
    return [[]];
  };
}

async function withPoolStubs(stubs, callback) {
  const originals = {};
  for (const [method, replacement] of Object.entries(stubs)) {
    originals[method] = pool[method];
    pool[method] = replacement;
  }
  try {
    await callback();
  } finally {
    for (const [method, original] of Object.entries(originals)) pool[method] = original;
  }
}

async function startServer() {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return server;
}

async function stopServer(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test.after(async () => {
  try { await pool.end(); } catch { /* already ended */ }
});

// ------------------------------------------------------- evidence strengths
test('kanji review evidence in range is strong with review kind and Sep label', async () => {
  const { evidence, from, to } = recentSeptemberWindow();
  const seen = [];
  await withPoolStubs({ execute: stubCandidatesExecute({ reviewRows: [reviewRow({ type: 'kanji', id: 1, display: '日', jlpt: 'N5', date: evidence })], seen }) }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.listCandidates({ user: { id: USER_ID }, query: { from, to } }, res);
    assert.equal(status(), 200);
    const item = body().groups.kanji.items.find((entry) => entry.entityId === 1);
    assert.ok(item, 'expected kanji candidate');
    assert.equal(item.evidenceStrength, 'strong');
    assert.equal(item.sources[0].kind, 'review');
    assert.match(item.sources[0].label, /Reviewed.*Sep \d{1,2}/);
  });
  assert.ok(seen.length > 0);
});

test('legacy session-kanji evidence is strong with session context', async () => {
  const from = daysAgo(10);
  const to = daysAgo(1);
  const date = daysAgo(5);
  const seen = [];
  await withPoolStubs({ execute: stubCandidatesExecute({ sessionRows: [sessionRow({ type: 'kanji', id: 2, display: '本', jlpt: 'N5', date, category: 'Reading', duration: 30 })], seen }) }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.listCandidates({ user: { id: USER_ID }, query: { from, to } }, res);
    assert.equal(status(), 200);
    const item = body().groups.kanji.items.find((entry) => entry.entityId === 2);
    assert.ok(item);
    assert.equal(item.evidenceStrength, 'strong');
    const source = item.sources.find((entry) => entry.kind === 'session');
    assert.ok(source, 'expected session source');
    assert.match(source.label, /Study session/);
    assert.match(source.context, /Reading/);
  });
});

test('kanji encounter evidence is moderate Seen in session writing', async () => {
  const from = daysAgo(10);
  const to = daysAgo(1);
  const date = daysAgo(5);
  await withPoolStubs({ execute: stubCandidatesExecute({ encounterRows: [encounterRow({ id: 3, display: '書', date, sourceType: 'session_writing', writingTitle: 'Session writing' })] }) }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.listCandidates({ user: { id: USER_ID }, query: { from, to } }, res);
    assert.equal(status(), 200);
    const item = body().groups.kanji.items.find((entry) => entry.entityId === 3);
    assert.ok(item);
    assert.equal(item.evidenceStrength, 'moderate');
    const source = item.sources.find((entry) => entry.kind === 'encounter');
    assert.ok(source);
    assert.match(source.label, /Seen in session writing/);
    assert.match(source.context, /Session writing/);
  });
});

test('vocabulary review and session evidence are strong', async () => {
  const from = daysAgo(10);
  const to = daysAgo(1);
  const date = daysAgo(5);
  await withPoolStubs({
    execute: stubCandidatesExecute({
      reviewRows: [reviewRow({ type: 'vocabulary', id: 11, display: '水', reading: 'みず', meaning: 'water', jlpt: 'N5', date })],
      sessionRows: [sessionRow({ type: 'vocabulary', id: 12, display: '火', reading: 'ひ', meaning: 'fire', jlpt: 'N5', date })]
    })
  }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.listCandidates({ user: { id: USER_ID }, query: { from, to, types: 'vocabulary' } }, res);
    assert.equal(status(), 200);
    const reviewed = body().groups.vocabulary.items.find((entry) => entry.entityId === 11);
    const studied = body().groups.vocabulary.items.find((entry) => entry.entityId === 12);
    assert.ok(reviewed && studied);
    assert.equal(reviewed.evidenceStrength, 'strong');
    assert.equal(reviewed.sources[0].kind, 'review');
    assert.equal(studied.evidenceStrength, 'strong');
    assert.equal(studied.sources[0].kind, 'session');
  });
});

test('grammar review and session evidence are strong', async () => {
  const from = daysAgo(10);
  const to = daysAgo(1);
  const date = daysAgo(5);
  await withPoolStubs({
    execute: stubCandidatesExecute({
      reviewRows: [reviewRow({ type: 'grammar', id: 21, display: '〜ても', meaning: 'even if', jlpt: 'N5', date })],
      sessionRows: [sessionRow({ type: 'grammar', id: 22, display: '〜ば', meaning: 'if', jlpt: 'N5', date })]
    })
  }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.listCandidates({ user: { id: USER_ID }, query: { from, to, types: 'grammar' } }, res);
    assert.equal(status(), 200);
    const reviewed = body().groups.grammar.items.find((entry) => entry.entityId === 21);
    const studied = body().groups.grammar.items.find((entry) => entry.entityId === 22);
    assert.ok(reviewed && studied);
    assert.equal(reviewed.evidenceStrength, 'strong');
    assert.equal(studied.evidenceStrength, 'strong');
  });
});

test('added-only entity is weak with added kind and Added label', async () => {
  const from = daysAgo(10);
  const to = daysAgo(1);
  const date = daysAgo(5);
  await withPoolStubs({ execute: stubCandidatesExecute({ addedRows: [addedRow({ type: 'kanji', id: 9, display: '語', jlpt: 'N5', date })] }) }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.listCandidates({ user: { id: USER_ID }, query: { from, to } }, res);
    assert.equal(status(), 200);
    const item = body().groups.kanji.items.find((entry) => entry.entityId === 9);
    assert.ok(item);
    assert.equal(item.evidenceStrength, 'weak');
    assert.equal(item.sources[0].kind, 'added');
    assert.match(item.sources[0].label, /Added /);
    // Added-only context is the truthful provenance disclaimer from the
    // approved contract (R-A7): never a study claim.
    assert.match(item.sources[0].context, /Not linked to a study session/);
    assert.notEqual(item.evidenceStrength, 'strong');
  });
});

test('weak added-only evidence is never labeled strong', async () => {
  const from = daysAgo(10);
  const to = daysAgo(1);
  const date = daysAgo(5);
  await withPoolStubs({ execute: stubCandidatesExecute({ addedRows: [addedRow({ type: 'vocabulary', id: 31, display: '単語', jlpt: 'N5', date })] }) }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.listCandidates({ user: { id: USER_ID }, query: { from, to, types: 'vocabulary' } }, res);
    assert.equal(status(), 200);
    for (const item of body().groups.vocabulary.items) {
      if (item.sources.every((source) => source.kind === 'added')) {
        assert.notEqual(item.evidenceStrength, 'strong');
        assert.equal(item.evidenceStrength, 'weak');
      }
    }
    assert.ok(body().groups.vocabulary.items.length > 0);
  });
});

// ------------------------------------------------------------------ filters
test('jlpt N5 filter returns only band-matching candidates', async () => {
  const from = daysAgo(10);
  const to = daysAgo(1);
  const date = daysAgo(5);
  const seen = [];
  await withPoolStubs({
    execute: stubCandidatesExecute({
      reviewRows: [
        reviewRow({ type: 'kanji', id: 1, display: '日', jlpt: 'N5', date }),
        reviewRow({ type: 'kanji', id: 2, display: '鬱', jlpt: 'N1', date })
      ],
      seen
    })
  }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.listCandidates({ user: { id: USER_ID }, query: { from, to, jlpt: 'N5' } }, res);
    assert.equal(status(), 200);
    const ids = body().groups.kanji.items.map((entry) => entry.entityId);
    assert.ok(ids.includes(1), 'N5 must be kept');
    assert.ok(!ids.includes(2), 'N1 must be filtered when jlpt=N5');
    for (const item of body().groups.kanji.items) assert.equal(item.jlpt, 'N5');
  });
  const jlptSql = seen.find((entry) => /jlpt_level/i.test(entry.sql));
  assert.ok(jlptSql, 'SQL should carry JLPT band filter');
  assert.ok(jlptSql.params.includes('N5'));
});

test('types filter limits groups to requested types', async () => {
  const from = daysAgo(10);
  const to = daysAgo(1);
  const date = daysAgo(5);
  await withPoolStubs({
    execute: stubCandidatesExecute({
      reviewRows: [
        reviewRow({ type: 'kanji', id: 1, display: '日', jlpt: 'N5', date }),
        reviewRow({ type: 'vocabulary', id: 11, display: '水', jlpt: 'N5', date }),
        reviewRow({ type: 'grammar', id: 21, display: '〜ても', jlpt: 'N5', date })
      ]
    })
  }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.listCandidates({ user: { id: USER_ID }, query: { from, to, types: 'kanji' } }, res);
    assert.equal(status(), 200);
    assert.ok(body().groups.kanji.items.length > 0);
    assert.deepEqual(body().groups.vocabulary.items, []);
    assert.deepEqual(body().groups.grammar.items, []);
    assert.equal(body().groups.vocabulary.total, 0);
    assert.equal(body().groups.grammar.total, 0);
  });
});

test('date range excludes out-of-range evidence', async () => {
  const from = daysAgo(10);
  const to = daysAgo(1);
  const inside = daysAgo(5);
  const outside = daysAgo(60);
  await withPoolStubs({
    execute: stubCandidatesExecute({
      reviewRows: [
        reviewRow({ type: 'kanji', id: 1, display: '日', jlpt: 'N5', date: inside }),
        reviewRow({ type: 'kanji', id: 2, display: '月', jlpt: 'N5', date: outside })
      ]
    })
  }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.listCandidates({ user: { id: USER_ID }, query: { from, to } }, res);
    assert.equal(status(), 200);
    const ids = body().groups.kanji.items.map((entry) => entry.entityId);
    assert.ok(ids.includes(1));
    assert.ok(!ids.includes(2), 'evidence outside from/to must be excluded');
  });
});

test('per-type cap truncates at 500 with truncated flag', async () => {
  const from = daysAgo(30);
  const to = daysAgo(1);
  const date = daysAgo(5);
  const many = Array.from({ length: 501 }, (_, index) => reviewRow({ type: 'kanji', id: index + 1, display: `字${index + 1}`, jlpt: 'N5', date }));
  await withPoolStubs({ execute: stubCandidatesExecute({ reviewRows: many }) }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.listCandidates({ user: { id: USER_ID }, query: { from, to, types: 'kanji' } }, res);
    assert.equal(status(), 200);
    assert.equal(body().groups.kanji.truncated, true);
    assert.ok(body().groups.kanji.items.length <= 500);
    assert.equal(body().groups.kanji.items.length, 500);
  });
});

test('user isolation every executed SQL carries requesting user id', async () => {
  const from = daysAgo(10);
  const to = daysAgo(1);
  const date = daysAgo(5);
  const seen = [];
  await withPoolStubs({
    execute: stubCandidatesExecute({
      reviewRows: [reviewRow({ date })],
      sessionRows: [sessionRow({ date })],
      encounterRows: [encounterRow({ date })],
      addedRows: [addedRow({ date })],
      seen
    })
  }, async () => {
    const { res, status } = mockRes();
    await reviewController.listCandidates({ user: { id: USER_ID }, query: { from, to } }, res);
    assert.equal(status(), 200);
    assert.ok(seen.length >= 4, `expected 4 evidence queries, got ${seen.length}`);
    for (const entry of seen) {
      assert.ok(entry.params.includes(USER_ID), `params ${JSON.stringify(entry.params)} must include requesting user id`);
    }
  });
});

test('candidates endpoint is read-only with no writes', async () => {
  const from = daysAgo(10);
  const to = daysAgo(1);
  const date = daysAgo(5);
  const seen = [];
  await withPoolStubs({
    execute: stubCandidatesExecute({
      reviewRows: [reviewRow({ date })],
      sessionRows: [sessionRow({ date })],
      encounterRows: [encounterRow({ date })],
      addedRows: [addedRow({ date })],
      seen
    })
  }, async () => {
    const { res, status } = mockRes();
    await reviewController.listCandidates({ user: { id: USER_ID }, query: { from, to } }, res);
    assert.equal(status(), 200);
    assert.ok(seen.length > 0);
    for (const entry of seen) {
      assert.doesNotMatch(entry.sql, /^\s*(INSERT|UPDATE|DELETE)/i);
    }
  });
});

// --------------------------------------------------------------- validation
test('candidates from after to returns 400', async () => {
  await withPoolStubs({ execute: async () => { throw new Error('DB must not be hit'); } }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.listCandidates({ user: { id: USER_ID }, query: { from: daysAgo(1), to: daysAgo(10) } }, res);
    assert.equal(status(), 400);
    assert.match(body().error, /must not be after/);
  });
});

test('candidates future to returns 400', async () => {
  await withPoolStubs({ execute: async () => { throw new Error('DB must not be hit'); } }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.listCandidates({ user: { id: USER_ID }, query: { from: daysAgo(10), to: '2999-01-01' } }, res);
    assert.equal(status(), 400);
    assert.match(body().error, /must not be in the future/);
  });
});

test('candidates range over 366 days returns 400', async () => {
  await withPoolStubs({ execute: async () => { throw new Error('DB must not be hit'); } }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.listCandidates({ user: { id: USER_ID }, query: { from: daysAgo(500), to: daysAgo(1) } }, res);
    assert.equal(status(), 400);
    assert.match(body().error, /must not exceed 366/);
  });
});

test('candidates bad jlpt returns 400', async () => {
  await withPoolStubs({ execute: async () => { throw new Error('DB must not be hit'); } }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.listCandidates({ user: { id: USER_ID }, query: { from: daysAgo(10), to: daysAgo(1), jlpt: 'N9' } }, res);
    assert.equal(status(), 400);
    assert.match(body().error, /jlpt/i);
  });
});

test('candidates bad types returns 400', async () => {
  await withPoolStubs({ execute: async () => { throw new Error('DB must not be hit'); } }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.listCandidates({ user: { id: USER_ID }, query: { from: daysAgo(10), to: daysAgo(1), types: 'kanji,bogus' } }, res);
    assert.equal(status(), 400);
    assert.match(body().error, /types/i);
  });
});

test('HTTP GET /api/review/candidates returns groups payload and validates jlpt', async () => {
  const from = daysAgo(10);
  const to = daysAgo(1);
  const date = daysAgo(5);
  const previous = process.env.JLT_TEST_USER_ID;
  process.env.JLT_TEST_USER_ID = USER_ID;
  try {
    const seen = [];
    await withPoolStubs({ execute: stubCandidatesExecute({ reviewRows: [reviewRow({ date })], seen }) }, async () => {
      const server = await startServer();
      try {
        const ok = await fetch(`http://127.0.0.1:${server.address().port}/api/review/candidates?from=${from}&to=${to}`);
        assert.equal(ok.status, 200);
        const data = await ok.json();
        assert.equal(data.from, from);
        assert.equal(data.to, to);
        assert.ok(data.groups && data.groups.kanji && data.groups.vocabulary && data.groups.grammar);
        assert.ok(seen.every((entry) => entry.params.includes(USER_ID)));
        for (const entry of seen) assert.doesNotMatch(entry.sql, /^\s*(INSERT|UPDATE|DELETE)/i);

        const bad = await fetch(`http://127.0.0.1:${server.address().port}/api/review/candidates?from=${from}&to=${to}&jlpt=N9`);
        assert.equal(bad.status, 400);
      } finally { await stopServer(server); }
    });
  } finally {
    if (previous === undefined) delete process.env.JLT_TEST_USER_ID;
    else process.env.JLT_TEST_USER_ID = previous;
  }
});
