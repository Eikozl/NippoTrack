const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';
process.env.POSTGRES_HOST = process.env.POSTGRES_HOST || '127.0.0.1';
process.env.POSTGRES_PORT = process.env.POSTGRES_PORT || '5432';
process.env.POSTGRES_USER = process.env.POSTGRES_USER || 'jlt_test';
process.env.POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD ?? 'test-only';
process.env.POSTGRES_DB = process.env.POSTGRES_DB || 'jlt';

const app = require('../src/app');
const pool = require('../src/config/db');
const { ENCOUNTER_SOURCE_TYPES, getKanjiEncounterSummary, recordKanjiEncounters } = require('../src/services/kanjiEncounters');

const USER_ID = '00000000-0000-4000-8000-000000000001';

function encounterSummaryRow({ count = '0', first = null, last = null, bySource = [], recent = [] } = {}) {
  return [[{ summary: { count, first_encountered_at: first, last_encountered_at: last }, by_source: bySource, recent }]];
}

function kanjiReferenceRow() {
  return [[{ reference_id: 1, character: '食', jlpt_level: 'N5', onyomi: ['ショク'], kunyomi: ['た', 'く'], meanings: ['eat', 'food'], stroke_count: 9 }]];
}

async function startServer() {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return server;
}

async function stopServer(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
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

async function requestJson(server, route, body, method = 'POST') {
  return fetch(`http://127.0.0.1:${server.address().port}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

test.after(async () => {
  await pool.end();
});

test('recordKanjiEncounters stores one stable event per owned kanji and source', async () => {
  const statements = [];
  const executor = {
    async execute(sql, params = []) {
      statements.push({ sql, params });
      if (/FROM kanji WHERE user_id = \? AND character_kanji = ANY\(\?\)/i.test(sql)) {
        return [[{ id_kanji: 11, character_kanji: '食' }, { id_kanji: 12, character_kanji: '物' }]];
      }
      return [{ affectedRows: 2 }];
    }
  };

  const recorded = await recordKanjiEncounters(executor, USER_ID, '食べ物食', {
    type: ENCOUNTER_SOURCE_TYPES.VOCABULARY,
    sourceId: 41
  });

  assert.deepEqual(recorded, [{ idKanji: 11, character: '食' }, { idKanji: 12, character: '物' }]);
  assert.equal(statements.length, 2);
  assert.deepEqual(statements[0].params, [USER_ID, ['食', '物']]);
  assert.match(statements[1].sql, /INSERT INTO kanji_encounters/i);
  assert.match(statements[1].sql, /ON CONFLICT \(user_id, dedupe_key\) DO NOTHING/i);
  assert.deepEqual(statements[1].params, [
    USER_ID, 11, 'vocabulary', 41, 'v1:vocabulary:41:11',
    USER_ID, 12, 'vocabulary', 41, 'v1:vocabulary:41:12'
  ]);
});

test('recordKanjiEncounters ignores kanji the user does not own', async () => {
  const statements = [];
  const executor = {
    async execute(sql, params = []) {
      statements.push({ sql, params });
      return [[]];
    }
  };

  const recorded = await recordKanjiEncounters(executor, USER_ID, '食', {
    type: ENCOUNTER_SOURCE_TYPES.VOCABULARY,
    sourceId: 42
  });

  assert.deepEqual(recorded, []);
  assert.equal(statements.length, 1);
  assert.match(statements[0].sql, /user_id = \?/i);
});

test('getKanjiEncounterSummary returns bounded aggregate data scoped to one user', async () => {
  const executor = {
    async execute(sql, params) {
      assert.deepEqual(params, [USER_ID, 11, USER_ID, USER_ID]);
      assert.match(sql, /WITH scoped AS/i);
      return encounterSummaryRow({
        count: '3',
        first: '2026-09-01T10:00:00.000Z',
        last: '2026-09-02T10:00:00.000Z',
        bySource: [{ source_type: 'session_writing', count: '2' }, { source_type: 'vocabulary', count: '1' }],
        recent: []
      });
    }
  };

  assert.deepEqual(await getKanjiEncounterSummary(executor, USER_ID, 11), {
    count: 3,
    firstEncounteredAt: '2026-09-01T10:00:00.000Z',
    lastEncounteredAt: '2026-09-02T10:00:00.000Z',
    bySource: [
      { sourceType: 'session_writing', count: 2 },
      { sourceType: 'vocabulary', count: 1 }
    ],
    recent: []
  });
});

test('getKanjiEncounterSummary gates session_writing titles through owned study_sessions', async () => {
  let calls = 0;
  const executor = {
    async execute(sql, params) {
      calls += 1;
      assert.deepEqual(params, [USER_ID, 11, USER_ID, USER_ID]);
      // What the fixed SQL returns for a poisoned row (A-encounter -> B-session):
      // ss misses on user_id, sw is NULL, COALESCE falls back to 'Session writing'.
      return encounterSummaryRow({
        count: '1',
        first: '2026-09-02T12:00:00.000Z',
        last: '2026-09-02T12:00:00.000Z',
        bySource: [{ source_type: 'session_writing', count: '1' }],
        recent: [{ id_kanji_encounter: 901, source_type: 'session_writing', source_id: 999, encountered_at: '2026-09-02T12:00:00.000Z', source_title: 'Session writing' }]
      });
    }
  };

  const summary = await getKanjiEncounterSummary(executor, USER_ID, 11);
  assert.equal(calls, 1);
  assert.equal(summary.recent.length, 1);
  assert.equal(summary.recent[0].sourceType, 'session_writing');
  assert.equal(summary.recent[0].sourceTitle, 'Session writing');
  assert.notEqual(summary.recent[0].sourceTitle, 'B Private Title');
});

test('getKanjiEncounterSummary still returns own session_writing title', async () => {
  const executor = {
    async execute(sql, params) {
      assert.deepEqual(params, [USER_ID, 11, USER_ID, USER_ID]);
      return encounterSummaryRow({
        count: '1',
        first: '2026-09-02T12:00:00.000Z',
        last: '2026-09-02T12:00:00.000Z',
        bySource: [{ source_type: 'session_writing', count: '1' }],
        recent: [{ id_kanji_encounter: 902, source_type: 'session_writing', source_id: 61, encountered_at: '2026-09-02T12:00:00.000Z', source_title: '朝の書く練習' }]
      });
    }
  };

  const summary = await getKanjiEncounterSummary(executor, USER_ID, 11);
  assert.equal(summary.recent[0].sourceTitle, '朝の書く練習');
});

test('POST /api/vocabulary records encounters transactionally for the saved word', async () => {
  const statements = [];
  let committed = false;
  const connection = {
    async beginTransaction() {},
    async execute(sql, params = []) {
      statements.push({ sql, params });
      if (/^INSERT INTO vocabulary /i.test(sql)) return [{ insertId: 51 }];
      if (/FROM kanji WHERE user_id = \? AND character_kanji = ANY\(\?\)/i.test(sql)) return [[{ id_kanji: 11, character_kanji: '食' }]];
      return [{ affectedRows: 1 }];
    },
    async commit() { committed = true; },
    async rollback() { throw new Error('rollback should not be called'); },
    release() {}
  };

  await withPoolStubs({
    getConnection: async () => connection,
    execute: async () => [[{ id_vocabulary: 51, word: '食べ物', reading: 'たべもの', meaning: 'food', jlpt_level: null, status: 'New', notes: null }]]
  }, async () => {
    const server = await startServer();
    try {
      const response = await requestJson(server, '/api/vocabulary', { word: '食べ物', meaning: 'food' });
      assert.equal(response.status, 201);
      assert.equal(committed, true);
      const encounterWrite = statements.find(({ sql }) => /INSERT INTO kanji_encounters/i.test(sql));
      assert.ok(encounterWrite);
      assert.deepEqual(encounterWrite.params, [USER_ID, 11, 'vocabulary', 51, 'v1:vocabulary:51:11']);
    } finally {
      await stopServer(server);
    }
  });
});

test('POST /api/sessions records writing encounters using the session as a stable source', async () => {
  const statements = [];
  const connection = {
    async beginTransaction() {},
    async execute(sql, params = []) {
      statements.push({ sql, params });
      if (/^INSERT INTO study_sessions/i.test(sql)) return [{ insertId: 61 }];
      if (/FROM kanji WHERE user_id = \? AND character_kanji = ANY\(\?\)/i.test(sql)) return [[{ id_kanji: 12, character_kanji: '書' }]];
      return [{ affectedRows: 1 }];
    },
    async commit() {},
    async rollback() { throw new Error('rollback should not be called'); },
    release() {}
  };

  await withPoolStubs({
    getConnection: async () => connection,
    execute: async () => [[{ id_session: 61, session_date: '2026-09-01', duration_minutes: 30, category: 'Writing', resource: null, notes: null }]]
  }, async () => {
    const server = await startServer();
    try {
      const response = await requestJson(server, '/api/sessions', {
        session_date: '2026-09-01', duration_minutes: 30, category: 'Writing', writing_content: '日本語を書きます。'
      });
      assert.equal(response.status, 201);
      const encounterWrite = statements.find(({ sql }) => /INSERT INTO kanji_encounters/i.test(sql));
      assert.ok(encounterWrite);
      assert.deepEqual(encounterWrite.params, [USER_ID, 12, 'session_writing', 61, 'v1:session_writing:61:12']);
    } finally {
      await stopServer(server);
    }
  });
});

test('GET /api/kanji/:id includes the authenticated user encounter summary only', async () => {
  let summaryQueryCount = 0;
  await withPoolStubs({
    execute: async (sql, params) => {
      if (/FROM kanji WHERE id_kanji = \? AND user_id = \?/i.test(sql)) return [[{ id_kanji: 11, character_kanji: '食', meaning: 'eat', onyomi: null, kunyomi: null, jlpt_level: 'N5', status: 'Learning', notes: null, reference_id: 1 }]];
      if (/FROM kanji_vocabulary/i.test(sql)) return [[]];
      if (/FROM kanji_encounters/i.test(sql)) {
        summaryQueryCount += 1;
        assert.deepEqual(params, [USER_ID, 11, USER_ID, USER_ID]);
        return encounterSummaryRow({
          count: '1',
          first: '2026-09-01T10:00:00.000Z',
          last: '2026-09-01T10:00:00.000Z',
          bySource: [{ source_type: 'vocabulary', count: '1' }],
          recent: []
        });
      }
      if (/FROM review_items ri\s+JOIN kanji k ON k.id_kanji = ri.id_kanji/i.test(sql)) {
        return [[]];
      }
      if (/FROM kanji_reference WHERE id_kanji_reference = \?/i.test(sql)) {
        return kanjiReferenceRow();
      }
      if (/FROM kanji_reference WHERE character = \?/i.test(sql)) {
        return [[{ reference_id: 1, character: '食', jlpt_level: 'N5', onyomi: ['ショク'], kunyomi: ['た', 'く'], meanings: ['eat', 'food'], stroke_count: 9 }]];
      }
      if (/FROM kanji_vocabulary kv JOIN vocabulary v ON kv.id_vocabulary = v.id_vocabulary JOIN usage_examples ue ON ue.id_vocabulary = v.id_vocabulary/i.test(sql)) {
        return [[]];
      }
      if (/FROM note_kanji nk\s+JOIN notes n ON n.id_note = nk.id_note/i.test(sql)) {
        return [[]];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  }, async () => {
    const server = await startServer();
    try {
      const response = await requestJson(server, '/api/kanji/11', undefined, 'GET');
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).encounters, {
        count: 1,
        firstEncounteredAt: '2026-09-01T10:00:00.000Z',
        lastEncounteredAt: '2026-09-01T10:00:00.000Z',
        bySource: [{ sourceType: 'vocabulary', count: 1 }],
        recent: []
      });
      assert.equal(summaryQueryCount, 1);
    } finally {
      await stopServer(server);
    }
  });
});

test('GET /api/kanji/:id returns null reference when lookup fails', async () => {
  await withPoolStubs({
    execute: async (sql, params) => {
      if (/FROM kanji WHERE id_kanji = \? AND user_id = \?/i.test(sql)) return [[{ id_kanji: 11, character_kanji: '💩', meaning: 'poop', onyomi: null, kunyomi: null, jlpt_level: null, status: 'New', notes: null, reference_id: null }]];
      if (/FROM kanji_vocabulary/i.test(sql)) return [[]];
      if (/FROM kanji_encounters/i.test(sql)) {
        return encounterSummaryRow();
      }
      if (/FROM review_items ri\s+JOIN kanji k ON k.id_kanji = ri.id_kanji/i.test(sql)) return [[]];
      if (/FROM kanji_reference WHERE character = \?/i.test(sql)) throw new Error('Reference lookup failed');
      if (/FROM kanji_vocabulary kv JOIN vocabulary v ON kv.id_vocabulary = v.id_vocabulary JOIN usage_examples ue ON ue.id_vocabulary = v.id_vocabulary/i.test(sql)) return [[]];
      if (/FROM note_kanji nk\s+JOIN notes n ON n.id_note = nk.id_note/i.test(sql)) return [[]];
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  }, async () => {
    const server = await startServer();
    try {
      const response = await requestJson(server, '/api/kanji/11', undefined, 'GET');
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.reference, null);
      assert.equal(data.review, null);
      assert.deepEqual(data.vocabulary, []);
      assert.deepEqual(data.usageExamples, []);
      assert.deepEqual(data.encounters, { count: 0, firstEncounteredAt: null, lastEncounteredAt: null, bySource: [], recent: [] });
      assert.equal(data.notes, null);
    } finally {
      await stopServer(server);
    }
  });
});

test('GET /api/kanji/:id returns null review when no review item exists', async () => {
  await withPoolStubs({
    execute: async (sql, params) => {
      if (/FROM kanji WHERE id_kanji = \? AND user_id = \?/i.test(sql)) return [[{ id_kanji: 11, character_kanji: '食', meaning: 'eat', onyomi: 'ショク', kunyomi: 'た', jlpt_level: 'N5', status: 'Learning', notes: 'my note', reference_id: 1 }]];
      if (/FROM kanji_vocabulary/i.test(sql)) return [[]];
      if (/FROM kanji_encounters/i.test(sql)) {
        return encounterSummaryRow();
      }
      if (/FROM review_items ri\s+JOIN kanji k ON k.id_kanji = ri.id_kanji/i.test(sql)) return [[]];
      if (/FROM kanji_reference WHERE id_kanji_reference = \?/i.test(sql)) return kanjiReferenceRow();
      if (/FROM kanji_reference WHERE character = \?/i.test(sql)) return [[{ reference_id: 1, character: '食', jlpt_level: 'N5', onyomi: ['ショク'], kunyomi: ['た', 'く'], meanings: ['eat', 'food'], stroke_count: 9 }]];
      if (/FROM kanji_vocabulary kv JOIN vocabulary v ON kv.id_vocabulary = v.id_vocabulary JOIN usage_examples ue ON ue.id_vocabulary = v.id_vocabulary/i.test(sql)) return [[]];
      if (/FROM note_kanji nk\s+JOIN notes n ON n.id_note = nk.id_note/i.test(sql)) return [[]];
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  }, async () => {
    const server = await startServer();
    try {
      const response = await requestJson(server, '/api/kanji/11', undefined, 'GET');
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.review, null);
      assert.equal(data.notes, 'my note');
    } finally {
      await stopServer(server);
    }
  });
});

test('GET /api/kanji/:id returns empty vocabulary array when no links exist', async () => {
  await withPoolStubs({
    execute: async (sql, params) => {
      if (/FROM kanji WHERE id_kanji = \? AND user_id = \?/i.test(sql)) return [[{ id_kanji: 11, character_kanji: '食', meaning: 'eat', onyomi: 'ショク', kunyomi: 'た', jlpt_level: 'N5', status: 'Learning', notes: null, reference_id: 1 }]];
      if (/FROM kanji_vocabulary/i.test(sql)) return [[]];
      if (/FROM kanji_encounters/i.test(sql)) {
        return encounterSummaryRow();
      }
      if (/FROM review_items ri\s+JOIN kanji k ON k.id_kanji = ri.id_kanji/i.test(sql)) return [[]];
      if (/FROM kanji_reference WHERE id_kanji_reference = \?/i.test(sql)) return kanjiReferenceRow();
      if (/FROM kanji_reference WHERE character = \?/i.test(sql)) return [[{ reference_id: 1, character: '食', jlpt_level: 'N5', onyomi: ['ショク'], kunyomi: ['た', 'く'], meanings: ['eat', 'food'], stroke_count: 9 }]];
      if (/FROM kanji_vocabulary kv JOIN vocabulary v ON kv.id_vocabulary = v.id_vocabulary JOIN usage_examples ue ON ue.id_vocabulary = v.id_vocabulary/i.test(sql)) return [[]];
      if (/FROM note_kanji nk\s+JOIN notes n ON n.id_note = nk.id_note/i.test(sql)) return [[]];
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  }, async () => {
    const server = await startServer();
    try {
      const response = await requestJson(server, '/api/kanji/11', undefined, 'GET');
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.deepEqual(data.vocabulary, []);
      assert.deepEqual(data.usageExamples, []);
    } finally {
      await stopServer(server);
    }
  });
});

test('GET /api/kanji/:id returns notes null when column is null', async () => {
  await withPoolStubs({
    execute: async (sql, params) => {
      if (/FROM kanji WHERE id_kanji = \? AND user_id = \?/i.test(sql)) return [[{ id_kanji: 11, character_kanji: '食', meaning: 'eat', onyomi: 'ショク', kunyomi: 'た', jlpt_level: 'N5', status: 'Learning', notes: null, reference_id: 1 }]];
      if (/FROM kanji_vocabulary/i.test(sql)) return [[]];
      if (/FROM kanji_encounters/i.test(sql)) {
        return encounterSummaryRow();
      }
      if (/FROM review_items ri\s+JOIN kanji k ON k.id_kanji = ri.id_kanji/i.test(sql)) return [[]];
      if (/FROM kanji_reference WHERE id_kanji_reference = \?/i.test(sql)) return kanjiReferenceRow();
      if (/FROM kanji_reference WHERE character = \?/i.test(sql)) return [[{ reference_id: 1, character: '食', jlpt_level: 'N5', onyomi: ['ショク'], kunyomi: ['た', 'く'], meanings: ['eat', 'food'], stroke_count: 9 }]];
      if (/FROM kanji_vocabulary kv JOIN vocabulary v ON kv.id_vocabulary = v.id_vocabulary JOIN usage_examples ue ON ue.id_vocabulary = v.id_vocabulary/i.test(sql)) return [[]];
      if (/FROM note_kanji nk\s+JOIN notes n ON n.id_note = nk.id_note/i.test(sql)) return [[]];
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  }, async () => {
    const server = await startServer();
    try {
      const response = await requestJson(server, '/api/kanji/11', undefined, 'GET');
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.notes, null);
    } finally {
      await stopServer(server);
    }
  });
});

test('GET /api/kanji/:id review isolation - another user review never leaks', async () => {
  const OTHER_USER = '00000000-0000-4000-8000-000000000002';
  await withPoolStubs({
    execute: async (sql, params) => {
      if (/FROM kanji WHERE id_kanji = \? AND user_id = \?/i.test(sql)) {
        assert.deepEqual(params, [11, USER_ID]);
        return [[{ id_kanji: 11, character_kanji: '食', meaning: 'eat', onyomi: 'ショク', kunyomi: 'た', jlpt_level: 'N5', status: 'Learning', notes: null, reference_id: 1 }]];
      }
      if (/FROM kanji_vocabulary/i.test(sql)) return [[]];
      if (/FROM kanji_encounters/i.test(sql)) {
        return encounterSummaryRow();
      }
      if (/FROM review_items ri\s+JOIN kanji k ON k.id_kanji = ri.id_kanji/i.test(sql)) {
        assert.deepEqual(params, [11, USER_ID]);
        return [[{ id_review_item: 99, due_on: '2026-09-10', interval_days: 5, last_reviewed_at: '2026-09-01T10:00:00.000Z', last_result: 'again' }]];
      }
      if (/FROM kanji_reference WHERE id_kanji_reference = \?/i.test(sql)) return kanjiReferenceRow();
      if (/FROM kanji_reference WHERE character = \?/i.test(sql)) return [[{ reference_id: 1, character: '食', jlpt_level: 'N5', onyomi: ['ショク'], kunyomi: ['た', 'く'], meanings: ['eat', 'food'], stroke_count: 9 }]];
      if (/FROM kanji_vocabulary kv JOIN vocabulary v ON kv.id_vocabulary = v.id_vocabulary JOIN usage_examples ue ON ue.id_vocabulary = v.id_vocabulary/i.test(sql)) return [[]];
      if (/FROM note_kanji nk\s+JOIN notes n ON n.id_note = nk.id_note/i.test(sql)) return [[]];
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  }, async () => {
    const server = await startServer();
    try {
      const response = await requestJson(server, '/api/kanji/11', undefined, 'GET');
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.ok(data.review);
      assert.equal(data.review.idReviewItem, 99);
      assert.equal(data.review.dueOn, '2026-09-10');
    } finally {
      await stopServer(server);
    }
  });
});

test('GET /api/kanji/:id consolidated response - all sections populated', async () => {
  await withPoolStubs({
    execute: async (sql, params) => {
      if (/FROM kanji WHERE id_kanji = \? AND user_id = \?/i.test(sql)) return [[{ id_kanji: 11, character_kanji: '食', meaning: 'eat', onyomi: 'ショク', kunyomi: 'た', jlpt_level: 'N5', status: 'Learning', notes: 'personal note', reference_id: 1 }]];
      if (/FROM kanji_vocabulary kv/i.test(sql)) return [[{ id_vocabulary: 21, word: '食べ物', reading: 'たべもの', meaning: 'food', jlpt_level: 'N5', status: 'Learning', id_usage_example: 1, sentence: '食べ物が美味しい。', translation: 'The food is delicious.' }]];
      if (/FROM kanji_encounters/i.test(sql)) {
        return encounterSummaryRow({
          count: '3',
          first: '2026-09-01T10:00:00.000Z',
          last: '2026-09-02T12:00:00.000Z',
          bySource: [{ source_type: 'vocabulary', count: '3' }],
          recent: [{ id_kanji_encounter: 101, source_type: 'vocabulary', source_id: 21, encountered_at: '2026-09-02T12:00:00.000Z', source_title: '食べ物' }]
        });
      }
      if (/FROM review_items ri\s+JOIN kanji k ON k.id_kanji = ri.id_kanji/i.test(sql)) return [[{ id_review_item: 5, due_on: '2026-09-10', interval_days: 3, last_reviewed_at: '2026-09-01T10:00:00.000Z', last_result: 'good' }]];
      if (/FROM kanji_reference WHERE id_kanji_reference = \?/i.test(sql)) return kanjiReferenceRow();
      if (/FROM kanji_reference WHERE character = \?/i.test(sql)) return kanjiReferenceRow();
      if (/FROM note_kanji nk\s+JOIN notes n ON n.id_note = nk.id_note/i.test(sql)) return [[]];
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  }, async () => {
    const server = await startServer();
    try {
      const response = await requestJson(server, '/api/kanji/11', undefined, 'GET');
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.ok(data.reference);
      assert.equal(data.reference.meanings.length, 2);
      assert.ok(data.review);
      assert.equal(data.review.intervalDays, 3);
      assert.equal(data.vocabulary.length, 1);
      assert.equal(data.vocabulary[0].word, '食べ物');
      assert.equal(data.usageExamples.length, 1);
      assert.equal(data.usageExamples[0].sentence, '食べ物が美味しい。');
      assert.equal(data.encounters.count, 3);
      assert.equal(data.encounters.recent.length, 1);
      assert.equal(data.encounters.recent[0].sourceTitle, '食べ物');
      assert.equal(data.notes, 'personal note');
    } finally {
      await stopServer(server);
    }
  });
});

test('GET /api/kanji/:id consolidated response - missing reference', async () => {
  await withPoolStubs({
    execute: async (sql, params) => {
      if (/FROM kanji WHERE id_kanji = \? AND user_id = \?/i.test(sql)) return [[{ id_kanji: 11, character_kanji: '💩', meaning: 'poop', onyomi: null, kunyomi: null, jlpt_level: null, status: 'New', notes: null, reference_id: null }]];
      if (/FROM kanji_vocabulary/i.test(sql)) return [[]];
      if (/FROM kanji_encounters/i.test(sql)) {
        return encounterSummaryRow();
      }
      if (/FROM review_items ri\s+JOIN kanji k ON k.id_kanji = ri.id_kanji/i.test(sql)) return [[]];
      if (/FROM kanji_reference WHERE character = \?/i.test(sql)) throw new Error('Not found');
      if (/FROM kanji_vocabulary kv JOIN vocabulary v ON kv.id_vocabulary = v.id_vocabulary JOIN usage_examples ue ON ue.id_vocabulary = v.id_vocabulary/i.test(sql)) return [[]];
      if (/FROM note_kanji nk\s+JOIN notes n ON n.id_note = nk.id_note/i.test(sql)) return [[]];
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  }, async () => {
    const server = await startServer();
    try {
      const response = await requestJson(server, '/api/kanji/11', undefined, 'GET');
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.reference, null);
      assert.equal(data.review, null);
      assert.deepEqual(data.vocabulary, []);
      assert.deepEqual(data.usageExamples, []);
      assert.deepEqual(data.encounters, { count: 0, firstEncounteredAt: null, lastEncounteredAt: null, bySource: [], recent: [] });
    } finally {
      await stopServer(server);
    }
  });
});

test('GET /api/kanji/:id consolidated response - linked vocabulary with nested usage examples', async () => {
  await withPoolStubs({
    execute: async (sql, params) => {
      if (/FROM kanji WHERE id_kanji = \? AND user_id = \?/i.test(sql)) return [[{ id_kanji: 11, character_kanji: '食', meaning: 'eat', onyomi: 'ショク', kunyomi: 'た', jlpt_level: 'N5', status: 'Learning', notes: null, reference_id: 1 }]];
      if (/FROM kanji_vocabulary kv/i.test(sql)) return [[
        { id_vocabulary: 21, word: '食べ物', reading: 'たべもの', meaning: 'food', jlpt_level: 'N5', status: 'Learning', id_usage_example: 2, sentence: '朝食を食べる。', translation: 'Eat breakfast.' },
        { id_vocabulary: 21, word: '食べ物', reading: 'たべもの', meaning: 'food', jlpt_level: 'N5', status: 'Learning', id_usage_example: 1, sentence: '食べ物が美味しい。', translation: 'The food is delicious.' },
        { id_vocabulary: 22, word: '食事', reading: 'しょくじ', meaning: 'meal', jlpt_level: 'N4', status: 'Familiar', id_usage_example: 3, sentence: '夕食の準備。', translation: 'Preparing dinner.' }
      ]];
      if (/FROM kanji_encounters/i.test(sql)) {
        return encounterSummaryRow({
          count: '2',
          first: '2026-09-01T10:00:00.000Z',
          last: '2026-09-02T12:00:00.000Z',
          bySource: [{ source_type: 'vocabulary', count: '2' }],
          recent: [
            { id_kanji_encounter: 101, source_type: 'vocabulary', source_id: 21, encountered_at: '2026-09-02T12:00:00.000Z', source_title: '食べ物' },
            { id_kanji_encounter: 102, source_type: 'vocabulary', source_id: 22, encountered_at: '2026-09-02T11:00:00.000Z', source_title: '食事' }
          ]
        });
      }
      if (/FROM review_items ri\s+JOIN kanji k ON k.id_kanji = ri.id_kanji/i.test(sql)) return [[]];
      if (/FROM kanji_reference WHERE id_kanji_reference = \?/i.test(sql)) return kanjiReferenceRow();
      if (/FROM kanji_reference WHERE character = \?/i.test(sql)) return kanjiReferenceRow();
      if (/FROM note_kanji nk\s+JOIN notes n ON n.id_note = nk.id_note/i.test(sql)) return [[]];
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  }, async () => {
    const server = await startServer();
    try {
      const response = await requestJson(server, '/api/kanji/11', undefined, 'GET');
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.vocabulary.length, 2);
      assert.equal(data.usageExamples.length, 3);
      const vocab21Examples = data.usageExamples.filter(e => e.id_vocabulary === 21);
      const vocab22Examples = data.usageExamples.filter(e => e.id_vocabulary === 22);
      assert.equal(vocab21Examples.length, 2);
      assert.equal(vocab22Examples.length, 1);
    } finally {
      await stopServer(server);
    }
  });
});

test('GET /api/kanji/:id consolidated response - recent encounters bounded to 5', async () => {
  const manyRecent = Array.from({ length: 7 }, (_, i) => ({
    id_kanji_encounter: 200 + i,
    source_type: 'vocabulary',
    source_id: 100 + i,
    encountered_at: `2026-09-0${2 + i}T10:00:00.000Z`,
    source_title: `Word ${100 + i}`
  }));
  const limitedRecent = manyRecent.slice(-5).reverse();
  await withPoolStubs({
    execute: async (sql, params) => {
      if (/FROM kanji WHERE id_kanji = \? AND user_id = \?/i.test(sql)) return [[{ id_kanji: 11, character_kanji: '食', meaning: 'eat', onyomi: 'ショク', kunyomi: 'た', jlpt_level: 'N5', status: 'Learning', notes: null, reference_id: 1 }]];
      if (/FROM kanji_vocabulary/i.test(sql)) return [[]];
      if (/FROM kanji_encounters/i.test(sql)) {
        return encounterSummaryRow({
          count: '7',
          first: '2026-09-01T10:00:00.000Z',
          last: '2026-09-08T10:00:00.000Z',
          bySource: [{ source_type: 'vocabulary', count: '7' }],
          recent: limitedRecent
        });
      }
      if (/FROM review_items ri\s+JOIN kanji k ON k.id_kanji = ri.id_kanji/i.test(sql)) return [[]];
      if (/FROM kanji_reference WHERE id_kanji_reference = \?/i.test(sql)) return kanjiReferenceRow();
      if (/FROM kanji_reference WHERE character = \?/i.test(sql)) return [[{ reference_id: 1, character: '食', jlpt_level: 'N5', onyomi: ['ショク'], kunyomi: ['た', 'く'], meanings: ['eat', 'food'], stroke_count: 9 }]];
      if (/FROM kanji_vocabulary kv JOIN vocabulary v ON kv.id_vocabulary = v.id_vocabulary JOIN usage_examples ue ON ue.id_vocabulary = v.id_vocabulary/i.test(sql)) return [[]];
      if (/FROM note_kanji nk\s+JOIN notes n ON n.id_note = nk.id_note/i.test(sql)) return [[]];
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  }, async () => {
    const server = await startServer();
    try {
      const response = await requestJson(server, '/api/kanji/11', undefined, 'GET');
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.encounters.count, 7);
      assert.equal(data.encounters.recent.length, 5);
      assert.equal(data.encounters.recent[0].sourceTitle, 'Word 106');
      assert.equal(data.encounters.recent[4].sourceTitle, 'Word 102');
    } finally {
      await stopServer(server);
    }
  });
});

test('POST /api/review/:id records kanji review result', async () => {
  const statements = [];
  let queryStep = 0;
  const connection = {
    async beginTransaction() {},
    async execute(sql, params = []) {
      statements.push({ sql, params });
      queryStep++;
      if (queryStep === 1) {
        // V5.3a interval resolution: preferences read (empty -> fixed mode).
        return [[]];
      }
      if (queryStep === 2) {
        // SELECT FOR UPDATE
        return [[{ id_review_item: 99, interval_days: 3, id_vocabulary: null, id_kanji: 11, id_grammar: null }]];
      }
      if (queryStep === 3) {
        // ownership check
        return [[{ 1: 1 }]];
      }
      if (queryStep === 4) {
        // INSERT review_events
        return [{ affectedRows: 1 }];
      }
      if (queryStep === 5) {
        // UPDATE review_items
        return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 1 }];
    },
    async commit() {},
    async rollback() { throw new Error('rollback should not be called'); },
    release() {}
  };

  await withPoolStubs({
    getConnection: async () => connection,
    execute: async () => [[{ id_kanji: 11, character_kanji: '食' }]]
  }, async () => {
    const server = await startServer();
    try {
      const response = await requestJson(server, '/api/review/99', { result: 'Good' });
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.success, true);
      assert.equal(data.result, 'Good');
      assert.equal(data.nextIntervalDays, 7);
    } finally {
      await stopServer(server);
    }
  });
});

test('POST /api/review/:id rejects invalid result', async () => {
  await withPoolStubs({
    getConnection: async () => ({ async beginTransaction() {}, async execute() { return [[]]; }, async commit() {}, async rollback() {}, release() {} }),
    execute: async () => [[{ id_kanji: 11 }]]
  }, async () => {
    const server = await startServer();
    try {
      const response = await requestJson(server, '/api/review/99', { result: 'Invalid' });
      assert.equal(response.status, 400);
    } finally {
      await stopServer(server);
    }
  });
});

test('POST /api/review/:id returns 404 for another user review', async () => {
  let queryStep = 0;
  let rollbackCalled = false;
  const connection = {
    async beginTransaction() {},
    async execute(sql, params = []) {
      queryStep++;
      if (queryStep === 1) {
        return [[{ id_review_item: 99, interval_days: 3, id_vocabulary: null, id_kanji: 11, id_grammar: null }]];
      }
      if (queryStep === 2) {
        return [[]];
      }
      return [{ affectedRows: 1 }];
    },
    async commit() {},
    async rollback() { rollbackCalled = true; },
    release() {}
  };

  await withPoolStubs({
    getConnection: async () => connection,
    execute: async () => [[{ id_kanji: 11 }]]
  }, async () => {
    const server = await startServer();
    try {
      const response = await requestJson(server, '/api/review/99', { result: 'Good' });
      assert.equal(response.status, 404);
      assert.equal(rollbackCalled, true);
    } finally {
      await stopServer(server);
    }
  });
});

test('Phase 3 migration keeps encounters append-only and runtime-only', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../db/migrations-postgres/007_kanji_encounters.sql'), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS kanji_encounters/i);
  assert.match(migration, /UNIQUE \(user_id, dedupe_key\)/i);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/i);
  assert.match(migration, /GRANT SELECT, INSERT ON TABLE kanji_encounters TO jlt_runtime/i);
  assert.match(migration, /FOR INSERT/i);
  assert.doesNotMatch(migration, /GRANT UPDATE|GRANT DELETE/i);
});
