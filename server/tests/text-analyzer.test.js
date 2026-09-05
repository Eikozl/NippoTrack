const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const TEST_USER = '00000000-0000-4000-8000-000000000001';
const OTHER_USER = '00000000-0000-4000-8000-000000000002';

// Phase 8 — Smart Text Analyzer (POST /api/analyze/text). Deterministic
// Unicode/reference/collection analysis: occurrences, first-occurrence
// order, per-user collection states, reference metadata, JLPT reference
// distribution. Read-only by contract — these tests also prove no writes,
// bounded queries, isolation, and input limits.

function installAnalyzerStub({ ownedByUser, references }) {
  const pool = require('../src/config/db');
  const originalExecute = pool.execute;
  const originalGetConnection = pool.getConnection;
  const seen = [];
  let nextId = 500;
  pool.execute = async (sql, params) => {
    seen.push({ sql, params });
    if (/FROM kanji k WHERE k\.user_id/i.test(sql)) {
      // Bounded batched lookup: requester's kanji for the IN characters.
      const owned = ownedByUser[params[0]] || new Map();
      return [params.slice(1).filter((ch) => owned.has(ch)).map((ch) => owned.get(ch))];
    }
    if (/FROM kanji_reference WHERE character IN \(/i.test(sql)) {
      // Bounded batched lookup: shared reference rows for IN characters.
      return [params.filter((ch) => references.has(ch)).map((ch) => references.get(ch))];
    }
    if (/FROM kanji WHERE user_id = \? AND character_kanji = \?/i.test(sql)) {
      const owned = ownedByUser[params[0]] || new Map();
      const row = owned.get(params[1]);
      return [row ? [row] : []];
    }
    if (/FROM kanji_reference WHERE character = \?/i.test(sql)) {
      return [references.has(params[0]) ? [{ reference_id: 1 }] : []];
    }
    if (/FROM kanji WHERE/i.test(sql)) {
      const owned = ownedByUser[params[1]] || new Map();
      const row = [...owned.values()].find((candidate) => candidate.id_kanji === params[0]);
      return [row ? [row] : []];
    }
    return [[]];
  };
  pool.getConnection = async () => {
    const connection = {
      async beginTransaction() {},
      async execute(sql, params) {
        seen.push({ sql, params, via: 'connection' });
        if (/^INSERT INTO kanji /i.test(sql)) {
          const owned = ownedByUser[params[7]] || new Map();
          const row = { id_kanji: nextId++, character_kanji: params[0], meaning: params[1], jlpt_level: params[4], status: params[5] };
          owned.set(params[0], row);
          ownedByUser[params[7]] = owned;
          return [{ insertId: row.id_kanji }];
        }
        return [{ affectedRows: 1 }];
      },
      async commit() {},
      async rollback() {},
      release() {}
    };
    return connection;
  };
  return { originalExecute, originalGetConnection, seen };
}

function restoreStub(handles) {
  const pool = require('../src/config/db');
  pool.execute = handles.originalExecute;
  pool.getConnection = handles.originalGetConnection;
}

test.after(async () => {
  try {
    const pool = require('../src/config/db');
    await pool.end();
  } catch {
    // Pool may already be ended when only unit tests ran; ignore.
  }
});

async function postAnalysis(base, body) {
  const response = await fetch(`${base}/api/analyze/text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  let payload = null;
  try { payload = await response.json(); } catch { /* non-JSON error shape */ }
  return { status: response.status, body: payload };
}

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

const refRow = (character, overrides = {}) => ({
  character,
  jlpt_level: 'N5',
  onyomi: [`${character}-on`],
  kunyomi: [`${character}-kun`],
  meanings: [`${character}-meaning`],
  stroke_count: 4,
  ...overrides
});
const ownedRow = (character, overrides = {}) => ({
  id_kanji: 7,
  character_kanji: character,
  meaning: `${character}-owned`,
  jlpt_level: 'N5',
  status: 'Learning',
  user_onyomi: null,
  user_kunyomi: null,
  ...overrides
});

test('Phase 8: basic sentence yields unique kanji in first-occurrence order', async () => {
  const stub = installAnalyzerStub({
    ownedByUser: { [TEST_USER]: new Map() },
    references: new Map(['今', '日', '学', '校', '行'].map((ch) => [ch, refRow(ch)]))
  });
  try {
    await withServer(async (base) => {
      const { status, body } = await postAnalysis(base, { text: '今日は学校に行く' });
      assert.equal(status, 200);
      assert.deepEqual(body.characters, ['今', '日', '学', '校', '行']);
      assert.equal(body.uniqueKanjiCount, 5);
      assert.equal(body.totalKanjiOccurrences, 5);
      assert.equal(body.totalCharacters, 8);
      assert.deepEqual(body.kanji.map((entry) => entry.occurrences), [1, 1, 1, 1, 1]);
      assert.equal(body.source, 'pasted_text');
      assert.equal(body.maxLength, 10000);
      assert.ok(typeof body.notice === 'string' && body.notice.length > 0);
      assert.deepEqual(body.summary, { uniqueKanji: 5, totalOccurrences: 5, inCollection: 0, availableToAdd: 5, noReferenceData: 0 });
    });
  } finally {
    restoreStub(stub);
  }
});

test('Phase 8: repeated kanji count occurrences without duplicating entries', async () => {
  const stub = installAnalyzerStub({
    ownedByUser: { [TEST_USER]: new Map() },
    references: new Map([['日', refRow('日')], ['本', refRow('本')]])
  });
  try {
    await withServer(async (base) => {
      const { status, body } = await postAnalysis(base, { text: '日本日本' });
      assert.equal(status, 200);
      assert.deepEqual(body.characters, ['日', '本']);
      const byChar = new Map(body.kanji.map((entry) => [entry.character, entry.occurrences]));
      assert.equal(byChar.get('日'), 2);
      assert.equal(byChar.get('本'), 2);
      assert.equal(body.uniqueKanjiCount, 2);
      assert.equal(body.totalKanjiOccurrences, 4);
    });
  } finally {
    restoreStub(stub);
  }
});

test('Phase 8: jukujikun words never receive per-kanji reading assignment', async () => {
  const stub = installAnalyzerStub({
    ownedByUser: { [TEST_USER]: new Map() },
    references: new Map(['今', '日', '大', '人', '明'].map((ch) => [ch, refRow(ch)]))
  });
  try {
    await withServer(async (base) => {
      const { status, body } = await postAnalysis(base, { text: '今日大人明日' });
      assert.equal(status, 200);
      assert.deepEqual(body.characters, ['今', '日', '大', '人', '明']);
      for (const entry of body.kanji) {
        assert.equal(entry.readingSegment, null);
        assert.equal(entry.readingProvenance, 'unverified');
      }
    });
  } finally {
    restoreStub(stub);
  }
});

test('Phase 8: collection, reference-only, and no-reference states resolve correctly', async () => {
  const stub = installAnalyzerStub({
    ownedByUser: { [TEST_USER]: new Map([['日', ownedRow('日')]]) },
    references: new Map([['日', refRow('日')], ['学', refRow('学')]])
  });
  try {
    await withServer(async (base) => {
      const { status, body } = await postAnalysis(base, { text: '日学校' });
      assert.equal(status, 200);
      const byChar = new Map(body.kanji.map((entry) => [entry.character, entry]));
      assert.equal(byChar.get('日').state, 'in_collection');
      assert.equal(byChar.get('日').discoveryState, 'alreadyInCollection');
      assert.ok(byChar.get('日').inUserCollection);
      assert.equal(byChar.get('学').state, 'available_from_reference');
      assert.equal(byChar.get('学').discoveryState, 'availableToAdd');
      assert.equal(byChar.get('校').state, 'no_reference_data');
      assert.equal(byChar.get('校').discoveryState, 'noReferenceData');
      assert.equal(byChar.get('校').reference, null);
      assert.deepEqual(byChar.get('学').reference.meanings, ['学-meaning']);
      assert.equal(byChar.get('学').reference.contextualOnly, true);
      assert.deepEqual(body.summary, { uniqueKanji: 3, totalOccurrences: 3, inCollection: 1, availableToAdd: 1, noReferenceData: 1 });
    });
  } finally {
    restoreStub(stub);
  }
});

test('Phase 8: kana-only and empty input return valid empty analysis without DB work', async () => {
  const stub = installAnalyzerStub({ ownedByUser: { [TEST_USER]: new Map() }, references: new Map() });
  try {
    await withServer(async (base) => {
      for (const text of ['こんにちは', '', '   ']) {
        const { status, body } = await postAnalysis(base, { text });
        assert.equal(status, 200);
        assert.equal(body.uniqueKanjiCount, 0);
        assert.equal(body.totalKanjiOccurrences, 0);
        assert.deepEqual(body.characters, []);
        assert.deepEqual(body.kanji, []);
      }
      // No SELECT ran at all: empty scans never build an IN () query.
      assert.equal(stub.seen.length, 0);
    });
  } finally {
    restoreStub(stub);
  }
});

test('Phase 8: mixed scripts analyze kanji while ignoring other scripts', async () => {
  const stub = installAnalyzerStub({
    ownedByUser: { [TEST_USER]: new Map() },
    references: new Map([['日', refRow('日')], ['本', refRow('本')], ['語', refRow('語')]])
  });
  try {
    await withServer(async (base) => {
      const { status, body } = await postAnalysis(base, { text: '日本語 test 123。ABC' });
      assert.equal(status, 200);
      assert.deepEqual(body.characters, ['日', '本', '語']);
      assert.equal(body.uniqueKanjiCount, 3);
    });
  } finally {
    restoreStub(stub);
  }
});

test('Phase 8: repeated large input stays within two bounded queries', async () => {
  const stub = installAnalyzerStub({
    ownedByUser: { [TEST_USER]: new Map() },
    references: new Map([['日', refRow('日')], ['本', refRow('本')], ['語', refRow('語')]])
  });
  try {
    await withServer(async (base) => {
      const { status, body } = await postAnalysis(base, { text: '日本語'.repeat(2000) });
      assert.equal(status, 200);
      assert.equal(body.uniqueKanjiCount, 3);
      assert.equal(body.totalKanjiOccurrences, 6000);
      // Query count is bounded (owned + reference) regardless of repetitions.
      assert.ok(stub.seen.length <= 2, `expected <= 2 queries, saw ${stub.seen.length}`);
    });
  } finally {
    restoreStub(stub);
  }
});

test('Phase 8: collection state is scoped to the requesting user', async () => {
  const stub = installAnalyzerStub({
    ownedByUser: { [TEST_USER]: new Map([['日', ownedRow('日')]]) },
    references: new Map([['日', refRow('日')]])
  });
  const previousTestUser = process.env.JLT_TEST_USER_ID;
  try {
    await withServer(async (base) => {
      const own = await postAnalysis(base, { text: '日本' });
      assert.equal(own.body.kanji.find((entry) => entry.character === '日').state, 'in_collection');
      process.env.JLT_TEST_USER_ID = OTHER_USER;
      const other = await postAnalysis(base, { text: '日本' });
      assert.equal(other.body.kanji.find((entry) => entry.character === '日').state, 'available_from_reference');
      assert.equal(other.body.kanji.find((entry) => entry.character === '日').userKanji, null);
    });
  } finally {
    if (previousTestUser === undefined) delete process.env.JLT_TEST_USER_ID;
    else process.env.JLT_TEST_USER_ID = previousTestUser;
    restoreStub(stub);
  }
});

test('Phase 8: JLPT distribution counts unique kanji by reference level only', async () => {
  const stub = installAnalyzerStub({
    ownedByUser: { [TEST_USER]: new Map() },
    references: new Map([
      ['日', refRow('日', { jlpt_level: 'N5' })],
      ['本', refRow('本', { jlpt_level: 'N4' })],
      ['語', refRow('語', { jlpt_level: null })]
    ])
  });
  try {
    await withServer(async (base) => {
      // 日 appears twice but counts once: distribution is unique-based.
      const { status, body } = await postAnalysis(base, { text: '日本日語' });
      assert.equal(status, 200);
      assert.deepEqual(body.jlptDistribution, { N5: 1, N4: 1, N3: 0, N2: 0, N1: 0, unclassified: 1 });
    });
  } finally {
    restoreStub(stub);
  }
});

test('Phase 8: missing reference-backed kanji imports explicitly, then shows collected', async () => {
  const stub = installAnalyzerStub({
    ownedByUser: { [TEST_USER]: new Map() },
    references: new Map([['学', refRow('学')]])
  });
  try {
    await withServer(async (base) => {
      const before = await postAnalysis(base, { text: '学' });
      assert.equal(before.body.kanji[0].state, 'available_from_reference');
      const created = await fetch(`${base}/api/kanji`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ character_kanji: '学', meaning: 'study', onyomi: 'ガク', kunyomi: 'まなぶ', jlpt_level: 'N5', status: 'New' })
      });
      assert.equal(created.status, 201);
      const after = await postAnalysis(base, { text: '学' });
      assert.equal(after.body.kanji[0].state, 'in_collection');
      assert.ok(after.body.kanji[0].inUserCollection);
    });
  } finally {
    restoreStub(stub);
  }
});

test('Phase 8: analysis performs no writes of any kind', async () => {
  const stub = installAnalyzerStub({
    ownedByUser: { [TEST_USER]: new Map([['日', ownedRow('日')]]) },
    references: new Map([['日', refRow('日')], ['学', refRow('学')]])
  });
  try {
    await withServer(async (base) => {
      const { status } = await postAnalysis(base, { text: '今日は学校に行く' });
      assert.equal(status, 200);
      const writes = stub.seen.filter(({ sql }) => /INSERT|UPDATE|DELETE|kanji_encounters|session_writings|review_items/i.test(sql));
      assert.deepEqual(writes, []);
      // Reads are SELECT-only and bounded.
      assert.ok(stub.seen.length <= 2);
      for (const { sql } of stub.seen) assert.match(sql, /^\s*SELECT/i);
    });
  } finally {
    restoreStub(stub);
  }
});

test('Phase 8: unauthenticated requests are rejected before any analysis', async () => {
  const stub = installAnalyzerStub({ ownedByUser: { [TEST_USER]: new Map() }, references: new Map() });
  const previousBypass = process.env.JLT_AUTH_BYPASS_FOR_TESTS;
  delete process.env.JLT_AUTH_BYPASS_FOR_TESTS;
  try {
    await withServer(async (base) => {
      const { status } = await postAnalysis(base, { text: '今日は学校に行く' });
      assert.equal(status, 401);
      assert.equal(stub.seen.length, 0);
    });
  } finally {
    if (previousBypass !== undefined) process.env.JLT_AUTH_BYPASS_FOR_TESTS = previousBypass;
    restoreStub(stub);
  }
});

test('Phase 8: boundary input passes, oversized and invalid input rejected', async () => {
  const stub = installAnalyzerStub({ ownedByUser: { [TEST_USER]: new Map() }, references: new Map() });
  try {
    await withServer(async (base) => {
      const boundary = await postAnalysis(base, { text: 'あ'.repeat(10000) });
      assert.equal(boundary.status, 200);
      assert.equal(boundary.body.uniqueKanjiCount, 0);
      const oversized = await postAnalysis(base, { text: 'あ'.repeat(10001) });
      assert.equal(oversized.status, 400);
      const missing = await postAnalysis(base, {});
      assert.equal(missing.status, 400);
      const nonString = await postAnalysis(base, { text: 123 });
      assert.equal(nonString.status, 400);
    });
  } finally {
    restoreStub(stub);
  }
});
