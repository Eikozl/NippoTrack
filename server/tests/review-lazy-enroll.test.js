const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';
process.env.POSTGRES_HOST = process.env.POSTGRES_HOST || '127.0.0.1';
process.env.POSTGRES_PORT = process.env.POSTGRES_PORT || '5432';
process.env.POSTGRES_USER = process.env.POSTGRES_USER || 'jlt_test';
process.env.POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD ?? 'test-only';
process.env.POSTGRES_DB = process.env.POSTGRES_DB || 'jlt';

const pool = require('../src/config/db');
const vocabularyController = require('../src/controllers/vocabularyController');
const kanjiController = require('../src/controllers/kanjiController');
const grammarController = require('../src/controllers/grammarController');
const reviewController = require('../src/controllers/reviewController');

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

test.after(async () => {
  try { await pool.end(); } catch { /* already ended */ }
});

test('R-B: create vocabulary issues zero review_items INSERTs, entity shape unchanged', async () => {
  const seenPool = [];
  const seenConn = [];
  const connection = {
    async beginTransaction() {},
    async execute(sql, params = []) {
      seenConn.push({ sql, params });
      if (/^INSERT INTO vocabulary /i.test(sql)) return [{ insertId: 51 }];
      return [{ affectedRows: 1 }];
    },
    async commit() {},
    async rollback() { throw new Error('rollback should not be called'); },
    release() {}
  };
  const originalExecute = pool.execute;
  const originalGetConnection = pool.getConnection;
  pool.getConnection = async () => connection;
  pool.execute = async (sql, params = []) => {
    seenPool.push({ sql, params });
    if (/FROM vocabulary WHERE id_vocabulary = \? AND user_id = \?/i.test(sql)) {
      return [[{ id_vocabulary: 51, word: '食べ物', reading: 'たべもの', meaning: 'food', jlpt_level: 'N5', status: 'New', notes: null }]];
    }
    if (/FROM kanji WHERE user_id = \? AND character_kanji = ANY\(\?\)/i.test(sql)) return [[]];
    return [[]];
  };
  try {
    const { res, status, body } = mockRes();
    await vocabularyController.createVocabulary(
      { user: { id: USER_ID }, body: { word: '食べ物', reading: 'たべもの', meaning: 'food' } },
      res
    );
    assert.equal(status(), 201);
    assert.equal(body().word, '食べ物');
    assert.equal(body().meaning, 'food');
    const all = [...seenPool, ...seenConn];
    assert.equal(all.filter((c) => /INSERT INTO review_items/i.test(c.sql)).length, 0, 'zero review_items writes on vocabulary create');
    assert.ok(seenConn.some((c) => /^INSERT INTO vocabulary /i.test(c.sql)), 'entity insert still happens');
  } finally {
    pool.execute = originalExecute;
    pool.getConnection = originalGetConnection;
  }
});

test('R-B: create kanji issues zero review_items INSERTs, entity shape unchanged', async () => {
  const seenPool = [];
  const seenConn = [];
  const connection = {
    async beginTransaction() {},
    async execute(sql, params = []) {
      seenConn.push({ sql, params });
      if (/^INSERT INTO kanji /i.test(sql)) return [{ insertId: 77 }];
      return [{ affectedRows: 1 }];
    },
    async commit() {},
    async rollback() { throw new Error('rollback should not be called'); },
    release() {}
  };
  const originalExecute = pool.execute;
  const originalGetConnection = pool.getConnection;
  pool.getConnection = async () => connection;
  pool.execute = async (sql, params = []) => {
    seenPool.push({ sql, params });
    if (/FROM kanji WHERE user_id = \? AND character_kanji = \?/i.test(sql)) return [[]];
    if (/FROM kanji_reference WHERE character = \?/i.test(sql)) return [[]];
    if (/FROM kanji WHERE id_kanji = \? AND user_id = \?/i.test(sql)) {
      return [[{ id_kanji: 77, character_kanji: '食', meaning: 'eat', reference_id: null }]];
    }
    return [[]];
  };
  try {
    const { res, status, body } = mockRes();
    await kanjiController.createKanji(
      { user: { id: USER_ID }, body: { character_kanji: '食', meaning: 'eat' } },
      res
    );
    assert.equal(status(), 201);
    assert.equal(body().character_kanji, '食');
    assert.equal(body().meaning, 'eat');
    const all = [...seenPool, ...seenConn];
    assert.equal(all.filter((c) => /INSERT INTO review_items/i.test(c.sql)).length, 0, 'zero review_items writes on kanji create');
  } finally {
    pool.execute = originalExecute;
    pool.getConnection = originalGetConnection;
  }
});

test('R-B: create grammar issues zero review_items INSERTs, entity shape unchanged', async () => {
  const seen = [];
  const originalExecute = pool.execute;
  pool.execute = async (sql, params = []) => {
    seen.push({ sql, params });
    if (/^INSERT INTO grammar_points/i.test(sql)) return [{ insertId: 61 }];
    if (/FROM grammar_points WHERE id_grammar = \? AND user_id = \?/i.test(sql)) {
      return [[{ id_grammar: 61, grammar_point: '〜ても', meaning: 'even if', jlpt_level: 'N5', status: 'New' }]];
    }
    return [[]];
  };
  try {
    const { res, status, body } = mockRes();
    await grammarController.createGrammar(
      { user: { id: USER_ID }, body: { grammar_point: '〜ても', meaning: 'even if' } },
      res
    );
    assert.equal(status(), 201);
    assert.equal(body().grammar_point, '〜ても');
    assert.equal(seen.filter((c) => /INSERT INTO review_items/i.test(c.sql)).length, 0, 'zero review_items writes on grammar create');
  } finally {
    pool.execute = originalExecute;
  }
});

function makeLazyGradeConnection({ calls, entityTable, entityPk, entityId, sessionId = 9, reviewItemId = 55, intervalDays = 0, fkColumn }) {
  let step = 0;
  return {
    async beginTransaction() {},
    async execute(sql, params = []) {
      calls.push({ sql, params });
      step += 1;
      if (step === 1) {
        assert.match(sql, new RegExp(`FROM ${entityTable} WHERE`));
        return [[{ 1: 1 }]];
      }
      if (step === 2) {
        assert.match(sql, /FROM review_sessions WHERE/);
        return [[{ id_review_session: sessionId, completed_at: null }]];
      }
      if (step === 3) {
        assert.match(sql, /INSERT INTO review_items/i);
        return [{ affectedRows: 1 }];
      }
      if (step === 4) {
        assert.match(sql, /FROM review_items WHERE/);
        return [[{ id_review_item: reviewItemId }]];
      }
      if (step === 5) {
        assert.match(sql, /FROM review_items ri/);
        const row = { id_review_item: reviewItemId, interval_days: intervalDays, id_vocabulary: null, id_kanji: null, id_grammar: null };
        row[fkColumn] = entityId;
        return [[row]];
      }
      if (step === 6) {
        assert.match(sql, /AND user_id = \?/);
        return [[{ 1: 1 }]];
      }
      if (step === 7) {
        assert.match(sql, /INSERT INTO review_events/i);
        return [{ affectedRows: 1 }];
      }
      if (step === 8) {
        assert.match(sql, /UPDATE review_items/i);
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected grade step ${step}: ${sql}`);
    },
    async commit() {},
    async rollback() {},
    release() {}
  };
}

for (const { entityType, table, fk, id } of [
  { entityType: 'kanji', table: 'kanji', fk: 'id_kanji', id: 5 },
  { entityType: 'vocabulary', table: 'vocabulary', fk: 'id_vocabulary', id: 6 },
  { entityType: 'grammar', table: 'grammar_points', fk: 'id_grammar', id: 7 }
]) {
  test(`R-B: gradeEntity on new ${entityType} performs exactly one lazy enroll + one event`, async () => {
    const calls = [];
    const connection = makeLazyGradeConnection({ calls, entityTable: table, entityPk: fk, entityId: id, fkColumn: fk });
    const original = pool.getConnection;
    pool.getConnection = async () => connection;
    try {
      const { res, status, body } = mockRes();
      await reviewController.gradeEntity(
        { user: { id: USER_ID }, body: { entityType, entityId: id, result: 'Good', reviewSessionId: 9 } },
        res
      );
      assert.equal(status(), 200);
      assert.equal(body().idReviewItem, 55);
      assert.equal(body().idReviewSession, 9);
      const enrolls = calls.filter((c) => /INSERT INTO review_items/i.test(c.sql));
      assert.equal(enrolls.length, 1, 'exactly one lazy enroll INSERT');
      assert.match(enrolls[0].sql, /ON CONFLICT/);
      const events = calls.filter((c) => /INSERT INTO review_events/i.test(c.sql));
      assert.equal(events.length, 1, 'exactly one review event INSERT');
      assert.equal(events[0].params[4], 9);
    } finally {
      pool.getConnection = original;
    }
  });
}

test('R-B: discovery + session-open issue zero review_items writes', async () => {
  const seen = [];
  const originalExecute = pool.execute;
  pool.execute = async (sql, params = []) => {
    seen.push({ sql, params });
    if (/INSERT INTO review_sessions/i.test(sql)) return [[{ insertId: 99 }]];
    if (/SELECT id_review_session, completed_at FROM review_sessions/i.test(sql)) {
      return [[{ id_review_session: 99, completed_at: null }]];
    }
    if (/SELECT completed_at FROM review_sessions/i.test(sql)) {
      return [[{ completed_at: '2026-09-06T10:00:00.000Z' }]];
    }
    if (/FROM review_events re/i.test(sql)) {
      return [[{ total: '0', kanji: '0', vocabulary: '0', grammar: '0', again: '0', hard: '0', good: '0' }]];
    }
    // Candidate evidence queries: bounded read-only SELECTs.
    return [[]];
  };
  try {
    // Discovery: candidates endpoint is read-only.
    {
      const { res, status, body } = mockRes();
      await reviewController.listCandidates(
        { user: { id: USER_ID }, query: { from: daysAgo(3), to: daysAgo(0), jlpt: 'all', types: 'kanji,vocabulary,grammar' } },
        res
      );
      assert.equal(status(), 200);
      assert.ok(body().groups, 'candidates return groups');
    }
    // Session open: creates ONLY review_sessions.
    {
      const { res, status, body } = mockRes();
      await reviewController.createReviewSession(
        { user: { id: USER_ID }, body: { sourceFrom: daysAgo(3), sourceTo: daysAgo(0) } },
        res
      );
      assert.equal(status(), 201);
      assert.equal(body().id, 99);
    }
    assert.equal(seen.filter((c) => /INSERT INTO review_items/i.test(c.sql)).length, 0, 'discovery + session-open must not enroll review items');
    assert.ok(seen.some((c) => /INSERT INTO review_sessions/i.test(c.sql)), 'session-open creates review_sessions row');
  } finally {
    pool.execute = originalExecute;
  }
});
