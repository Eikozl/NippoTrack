// V5.3a immersion pipeline: analyze validation, transactional create-session,
// ownership-scoped history, and the deterministic level heuristic. The real
// kuromoji parser runs on tiny texts; every DB interaction is stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const USER_ID = '00000000-0000-4000-8000-000000000001';

const pool = require('../src/config/db');
const immersionController = require('../src/controllers/immersionController');
const immersionPipeline = require('../src/services/immersionPipeline');

const KANJI_REFERENCE_STUB = [
  { id_kanji_reference: 1, character: '学', jlpt_level: 'N5', onyomi: ['ガク'], kunyomi: ['まな.ぶ'], meanings: ['study', 'learning'], stroke_count: 8 },
  { id_kanji_reference: 2, character: '生', jlpt_level: 'N5', onyomi: ['セイ', 'ショウ'], kunyomi: ['い.きる'], meanings: ['life', 'birth'], stroke_count: 5 }
];

function mockRes() {
  let statusCode = 200;
  let body;
  const res = {
    status(code) { statusCode = code; return res; },
    json(value) { body = value; return res; }
  };
  return { res, status: () => statusCode, body: () => body };
}

// Analysis-phase stub: every read is scoped/emptied except kanji_reference.
async function stubPoolExecute(sql) {
  if (/FROM kanji_reference WHERE character IN/i.test(sql)) return [KANJI_REFERENCE_STUB];
  return [[]];
}

function makeConnection(behavior = {}) {
  const seen = [];
  let kanjiInsertSeq = 100;
  let vocabularyInsertSeq = 90;
  const connection = {
    seen,
    released: false,
    async beginTransaction() { seen.push({ phase: 'BEGIN' }); },
    async commit() { seen.push({ phase: 'COMMIT' }); },
    async rollback() { seen.push({ phase: 'ROLLBACK' }); },
    release() { connection.released = true; },
    async execute(sql, params = []) {
      seen.push({ sql, params });
      if (behavior.failOn && behavior.failOn.test(sql)) throw new Error('simulated mid-transaction failure');
      if (/SELECT id_vocabulary, word FROM vocabulary/i.test(sql)) return [[]];
      if (/INSERT INTO vocabulary/i.test(sql)) return [{ insertId: ++vocabularyInsertSeq }];
      if (/SELECT id_kanji, character_kanji FROM kanji WHERE user_id = \? AND character_kanji IN/i.test(sql)) return [[]];
      if (/INSERT INTO kanji /i.test(sql)) return [{ insertId: ++kanjiInsertSeq }];
      if (/SELECT id_grammar, grammar_point FROM grammar_points/i.test(sql)) return [[]];
      if (/INSERT INTO grammar_points/i.test(sql)) return [{ insertId: 80 }];
      if (/INSERT INTO review_sessions/i.test(sql)) return [{ insertId: 55 }];
      if (/INSERT INTO review_items/i.test(sql)) return [{ affectedRows: 1 }];
    if (/INSERT INTO review_session_items/i.test(sql)) return [{ affectedRows: 8 }];
      if (/INSERT INTO immersion_sessions/i.test(sql)) return [{ insertId: 77 }];
      if (/INSERT INTO immersion_session_items/i.test(sql)) return [{ affectedRows: 2 }];
      if (/character_kanji = ANY\(\?\)/i.test(sql)) {
        return [[{ id_kanji: 101, character_kanji: '学' }, { id_kanji: 102, character_kanji: '生' }]];
      }
      if (/INSERT INTO kanji_encounters/i.test(sql)) return [{ affectedRows: 2 }];
      throw new Error(`Unexpected transactional SQL: ${sql}`);
    }
  };
  return connection;
}

async function withStubs(connection, callback) {
  const originalExecute = pool.execute;
  const originalGetConnection = pool.getConnection;
  pool.execute = stubPoolExecute;
  pool.getConnection = async () => connection;
  try {
    await callback();
  } finally {
    pool.execute = originalExecute;
    pool.getConnection = originalGetConnection;
  }
}

test('analyze rejects a missing or non-string text with 400 and never queries', async () => {
  const originalExecute = pool.execute;
  pool.execute = async () => { throw new Error('must not query'); };
  try {
    for (const body of [{}, { text: 42 }, { text: '   ' }]) {
      const { res, status, body: payload } = mockRes();
      await immersionController.analyzeImmersionText({ body, user: { id: USER_ID } }, res);
      assert.equal(status(), 400);
      assert.match(payload().error, /text (is required|must be a string)/);
    }
  } finally {
    pool.execute = originalExecute;
  }
});

test('analyze reports candidates, level estimate and stats for a tiny text', async () => {
  const connection = makeConnection(); // unused: analyze must not write
  await withStubs(connection, async () => {
    const { res, status, body } = mockRes();
    await immersionController.analyzeImmersionText(
      { body: { text: '学生', options: { autoCreateSession: true } }, user: { id: USER_ID } },
      res
    );
    assert.equal(status(), 200);
    assert.deepEqual(body().candidates.kanji.map((entry) => entry.id), ['kanji::学', 'kanji::生']);
    assert.equal(body().candidates.kanji[0].known, false);
    assert.equal(body().candidates.kanji[0].jlpt, 'N5');
    assert.equal(body().estimatedLevel.level, 'N5');
    assert.equal(body().estimatedLevel.stats.kanjiTotal, 2);
    assert.equal(body().estimatedLevel.stats.byLevel.N5, 2);
    assert.ok(body().estimatedLevel.confidence > 0 && body().estimatedLevel.confidence <= 1);
    assert.equal(body().stats.uniqueKanji, 2);
    assert.equal(body().stats.candidateCount, body().candidates.vocabulary.length + body().candidates.kanji.length + body().candidates.grammar.length);
    // autoCreateSession is accepted but analyze is strictly read-only.
    assert.equal(connection.seen.length, 0);
  });
});

test('create-session persists session, review items and encounters in one transaction', async () => {
  const connection = makeConnection();
  await withStubs(connection, async () => {
    const analysis = await immersionPipeline.analyzeTextForImmersion(pool, USER_ID, '学生');
    const kanjiIds = analysis.candidates.kanji.map((candidate) => candidate.id);
    const vocabularyIds = analysis.candidates.vocabulary.map((candidate) => candidate.id);
    assert.deepEqual(kanjiIds, ['kanji::学', 'kanji::生']);

    const { res, status, body } = mockRes();
    await immersionController.createSession(
      { body: { text: '学生', selectedItems: { kanjiIds, vocabularyIds } }, user: { id: USER_ID } },
      res
    );
    assert.equal(status(), 201);
    assert.equal(body().sessionId, 77);
    assert.equal(body().reviewSessionId, 55);
    assert.equal(body().reviewSessionUrl, '/review?reviewSessionId=55');
    assert.equal(body().createdCounts.kanji, 2);
    assert.equal(body().createdCounts.reviewItems, body().createdCounts.kanji + body().createdCounts.vocabulary + body().createdCounts.grammar);

    // V5.3a hand-off queue: resolved entities (server-assigned ids) so the
    // Review page can start REVIEWING against the open session.
    const queue = body().items;
    assert.ok(Array.isArray(queue) && queue.length >= 2, 'hand-off queue returned');
    assert.ok(queue.every((entry) => ['vocabulary', 'kanji', 'grammar'].includes(entry.entityType)
      && Number.isInteger(entry.entityId) && typeof entry.display === 'string'));
    assert.ok(new Set(queue.map((entry) => entry.entityId)).size === queue.length, 'queue entity ids are unique');

    const sqls = connection.seen.map((entry) => entry.sql).filter(Boolean);
    assert.ok(sqls.some((sql) => /INSERT INTO review_sessions/i.test(sql) && /RETURNING id_review_session AS insertId/i.test(sql)));
    const reviewItemInserts = sqls.filter((sql) => /INSERT INTO review_items/i.test(sql));
    assert.ok(reviewItemInserts.length >= 2);
    for (const sql of reviewItemInserts) assert.match(sql, /ON CONFLICT \((id_kanji|id_vocabulary|id_grammar)\) DO NOTHING/i);
    // Retake queue persisted against the same review session, in order.
    const queueInsert = connection.seen.find((entry) => entry.sql && /INSERT INTO review_session_items/i.test(entry.sql));
    assert.ok(queueInsert, 'review_session_items insert recorded');
    assert.equal(queueInsert.params[0], 55);
    const positions = queueInsert.params.filter((_, index) => index % 4 === 3);
    assert.deepEqual(positions, positions.map((_, index) => index), 'positions are sequential from 0');
    assert.ok(sqls.some((sql) => /INSERT INTO immersion_sessions/i.test(sql) && /RETURNING id_immersion_session AS insertId/i.test(sql)));
    const itemInsert = connection.seen.find((entry) => entry.sql && /INSERT INTO immersion_session_items/i.test(entry.sql));
    assert.ok(itemInsert);
    assert.equal(itemInsert.params[0], 77);
    assert.ok(itemInsert.params.includes('kanji'));
    const encounterInsert = connection.seen.find((entry) => entry.sql && /INSERT INTO kanji_encounters/i.test(entry.sql));
    assert.ok(encounterInsert);
    assert.match(encounterInsert.sql, /ON CONFLICT \(user_id, dedupe_key\) DO NOTHING/i);
    assert.ok(encounterInsert.params.includes('immersion_session'));
    assert.ok(encounterInsert.params.includes(77));

    const phases = connection.seen.filter((entry) => entry.phase).map((entry) => entry.phase);
    assert.deepEqual(phases, ['BEGIN', 'COMMIT']);
    assert.equal(connection.released, true);
  });
});

test('create-session rolls back and responds 500 on a mid-transaction failure', async () => {
  const connection = makeConnection({ failOn: /INSERT INTO immersion_sessions/i });
  await withStubs(connection, async () => {
    const { res, status, body } = mockRes();
    await immersionController.createSession(
      { body: { text: '学生', selectedItems: { kanjiIds: ['kanji::学'] } }, user: { id: USER_ID } },
      res
    );
    assert.equal(status(), 500);
    assert.equal(body().error, 'Unable to create immersion session.');
    const phases = connection.seen.filter((entry) => entry.phase).map((entry) => entry.phase);
    assert.deepEqual(phases, ['BEGIN', 'ROLLBACK']);
    assert.equal(connection.released, true);
    assert.ok(!connection.seen.some((entry) => entry.sql && /INSERT INTO kanji_encounters/i.test(entry.sql)));
  });
});

test('create-session rejects a non-array selectedItems field and missing text', async () => {
  const originalExecute = pool.execute;
  const originalGetConnection = pool.getConnection;
  pool.execute = async () => { throw new Error('must not query'); };
  pool.getConnection = async () => { throw new Error('must not connect'); };
  try {
    const badShapes = [
      { text: '学生', selectedItems: 'kanji::学' },
      { text: '学生', selectedItems: { kanjiIds: 'kanji::学' } },
      { text: '学生', selectedItems: { kanjiIds: ['kanji::学', 7] } },
      { selectedItems: { kanjiIds: ['kanji::学'] } }
    ];
    for (const body of badShapes) {
      const { res, status, body: payload } = mockRes();
      await immersionController.createSession({ body, user: { id: USER_ID } }, res);
      assert.equal(status(), 400, JSON.stringify(body));
      assert.ok(payload().error);
    }
  } finally {
    pool.execute = originalExecute;
    pool.getConnection = originalGetConnection;
  }
});

test('history is scoped by req.user.id, validates filters, and paginates', async () => {
  const originalExecute = pool.execute;
  const seen = [];
  pool.execute = async (sql, params) => {
    seen.push({ sql, params });
    if (/SELECT COUNT\(\*\) AS total FROM immersion_sessions/i.test(sql)) {
      assert.deepEqual(params, [USER_ID, '2026-09-01', '2026-09-30', 'N5']);
      return [[{ total: '1' }]];
    }
    if (/FROM immersion_sessions s\s+LEFT JOIN immersion_session_items/i.test(sql)) {
      // Entity-type FILTER literals are inlined (no placeholders), so the
      // parameter order is exactly [filters..., limit, offset].
      assert.match(sql, /FILTER \(WHERE i\.entity_type = 'vocabulary'\)/i);
      assert.match(sql, /FILTER \(WHERE i\.entity_type = 'kanji'\)/i);
      assert.match(sql, /FILTER \(WHERE i\.entity_type = 'grammar'\)/i);
      assert.deepEqual(params, [USER_ID, '2026-09-01', '2026-09-30', 'N5', 10, 0]);
      return [[{
        id: '7',
        estimatedLevel: 'N5',
        confidence: '0.5',
        createdAt: '2026-09-05T10:00:00.000Z',
        items: '3',
        vocabulary: '1',
        kanji: '2',
        grammar: '0'
      }]];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  try {
    const { res, status, body } = mockRes();
    await immersionController.listHistory(
      { query: { from: '2026-09-01', to: '2026-09-30', level: 'N5', limit: '10' }, user: { id: USER_ID } },
      res
    );
    assert.equal(status(), 200);
    assert.equal(body().pagination.total, 1);
    assert.deepEqual(body().items[0], {
      id: 7,
      estimatedLevel: 'N5',
      confidence: 0.5,
      createdAt: '2026-09-05T10:00:00.000Z',
      items: { total: 3, vocabulary: 1, kanji: 2, grammar: 0 }
    });
  } finally {
    pool.execute = originalExecute;
  }
  assert.equal(seen.length, 2);

  // Invalid filters are rejected before any query runs.
  const neverCalled = [];
  const failingStub = async () => { neverCalled.push(1); throw new Error('must not query'); };
  pool.execute = failingStub;
  try {
    for (const query of [{ level: 'N0' }, { from: '2026/09/01' }, { to: 'not-a-date' }]) {
      const { res, status } = mockRes();
      await immersionController.listHistory({ query, user: { id: USER_ID } }, res);
      assert.equal(status(), 400);
    }
  } finally {
    pool.execute = originalExecute;
  }
  assert.equal(neverCalled.length, 0);
});

test('estimated level heuristic is deterministic over kanji_reference distributions', () => {
  const refs = (levels) => levels.map((jlpt_level, index) => ({ character: `漢${index}`, jlpt_level }));
  const chars = (levels) => levels.map((_, index) => `漢${index}`);

  // Unclassified share 1/4 = 25% > 20% threshold → no level.
  const mixed = immersionPipeline.estimateDifficultyLevel(chars(['N5', 'N5', 'N4', null]), refs(['N5', 'N5', 'N4', null]), []);
  assert.equal(mixed.level, null);
  assert.equal(mixed.stats.byLevel.unclassified, 1);

  // Fully classified: hardest band present wins.
  const classified = immersionPipeline.estimateDifficultyLevel(chars(['N5', 'N5', 'N4', 'N5']), refs(['N5', 'N5', 'N4', 'N5']), []);
  assert.equal(classified.level, 'N4');
  assert.equal(classified.confidence, 0.2); // 1 * min(1, 4/20)
  assert.equal(classified.stats.kanjiTotal, 4);

  // A single N1 kanji among N5s estimates N1 (simplest documented rule).
  const withN1 = immersionPipeline.estimateDifficultyLevel(chars(['N5', 'N1']), refs(['N5', 'N1']), []);
  assert.equal(withN1.level, 'N1');

  // Known percentage reflects the owned set.
  const owned = immersionPipeline.estimateDifficultyLevel(chars(['N5', 'N5']), refs(['N5', 'N5']), new Set(['漢0']));
  assert.equal(owned.stats.kanjiKnownPct, 50);
  assert.equal(owned.level, 'N5');

  // No kanji: level null, confidence 0 (counts only).
  const none = immersionPipeline.estimateDifficultyLevel([], [], []);
  assert.equal(none.level, null);
  assert.equal(none.confidence, 0);
  assert.equal(none.stats.kanjiKnownPct, 0);
});
