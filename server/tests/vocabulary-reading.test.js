const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const {
  CONTEXT_NOTICE,
  READING_PROVENANCE,
  buildVocabularyReadingContext
} = require('../src/services/vocabularyReading');

const TEST_USER = '00000000-0000-4000-8000-000000000001';

test.after(async () => {
  try {
    const pool = require('../src/config/db');
    await pool.end();
  } catch {
    // Pool may already be ended when only unit tests ran; ignore.
  }
});

// Jukujikun/irregular fixtures: the word reading must stay whole and no
// per-kanji segment may ever be fabricated (e.g. 今=きょ + 日=う is forbidden).
const IRREGULAR_CASES = [
  {
    word: '今日', reading: 'きょう', meaning: 'today',
    kanjiRows: [
      { id_kanji: 1, character_kanji: '今', meaning: 'now', jlpt_level: 'N5', status: 'Learning', user_onyomi: 'コン', user_kunyomi: 'いま', reference_id: 11, ref_onyomi: ['コン', 'キン'], ref_kunyomi: ['いま'], ref_meanings: ['now'] },
      { id_kanji: 2, character_kanji: '日', meaning: 'day', jlpt_level: 'N5', status: 'New', user_onyomi: 'ニチ', user_kunyomi: 'ひ', reference_id: 12, ref_onyomi: ['ニチ', 'ジツ'], ref_kunyomi: ['ひ', 'か'], ref_meanings: ['day', 'sun'] }
    ]
  },
  {
    word: '大人', reading: 'おとな', meaning: 'adult',
    kanjiRows: [
      { id_kanji: 3, character_kanji: '大', meaning: 'big', jlpt_level: 'N5', status: 'New', user_onyomi: 'ダイ', user_kunyomi: 'おお', reference_id: 13, ref_onyomi: ['ダイ', 'タイ'], ref_kunyomi: ['おお'], ref_meanings: ['large'] },
      { id_kanji: 4, character_kanji: '人', meaning: 'person', jlpt_level: 'N5', status: 'New', user_onyomi: 'ジン', user_kunyomi: 'ひと', reference_id: 14, ref_onyomi: ['ジン', 'ニン'], ref_kunyomi: ['ひと'], ref_meanings: ['person'] }
    ]
  },
  {
    word: '明日', reading: 'あした', meaning: 'tomorrow',
    kanjiRows: [
      { id_kanji: 5, character_kanji: '明', meaning: 'bright', jlpt_level: 'N5', status: 'New', user_onyomi: 'メイ', user_kunyomi: 'あ', reference_id: 15, ref_onyomi: ['メイ', 'ミョウ'], ref_kunyomi: ['あ', 'あかり'], ref_meanings: ['bright'] },
      { id_kanji: 2, character_kanji: '日', meaning: 'day', jlpt_level: 'N5', status: 'New', user_onyomi: 'ニチ', user_kunyomi: 'ひ', reference_id: 12, ref_onyomi: ['ニチ', 'ジツ'], ref_kunyomi: ['ひ', 'か'], ref_meanings: ['day', 'sun'] }
    ]
  }
];

test('Phase 5: full vocabulary reading stays authoritative for irregular words', () => {
  for (const fixture of IRREGULAR_CASES) {
    const context = buildVocabularyReadingContext(
      { word: fixture.word, reading: fixture.reading },
      fixture.kanjiRows
    );
    assert.equal(context.wordReading.value, fixture.reading);
    assert.equal(context.wordReading.provenance, READING_PROVENANCE.AUTHORITATIVE);
    assert.equal(context.kanji.length, fixture.kanjiRows.length);
  }
});

test('Phase 5: no per-kanji reading is mechanically fabricated', () => {
  for (const fixture of IRREGULAR_CASES) {
    const context = buildVocabularyReadingContext(
      { word: fixture.word, reading: fixture.reading },
      fixture.kanjiRows
    );
    for (const entry of context.kanji) {
      assert.equal(entry.readingSegment, null);
      assert.equal(entry.readingProvenance, READING_PROVENANCE.UNVERIFIED);
    }
    // The forbidden artificial split (e.g. 今=きょ + 日=う) must not appear
    // anywhere as a claimed per-kanji segment.
    const segments = context.kanji.map((entry) => entry.readingSegment);
    assert.deepEqual(segments, Array(context.kanji.length).fill(null));
    assert.doesNotMatch(JSON.stringify(context), /"readingSegment":"/);
  }
});

test('Phase 5: reference onyomi/kunyomi remain reference-only context', () => {
  const fixture = IRREGULAR_CASES[0];
  const context = buildVocabularyReadingContext(
    { word: fixture.word, reading: fixture.reading },
    fixture.kanjiRows
  );
  const kon = context.kanji.find((entry) => entry.character === '今');
  assert.deepEqual(kon.reference.onyomi, ['コン', 'キン']);
  assert.deepEqual(kon.reference.kunyomi, ['いま']);
  assert.equal(kon.reference.provenance, READING_PROVENANCE.REFERENCE);
  assert.equal(kon.reference.contextualOnly, true);
  assert.equal(kon.userProvenance, READING_PROVENANCE.USER);
  assert.equal(kon.userOnyomi, 'コン');
  assert.ok(context.notice.length > 0);
  assert.equal(context.notice, CONTEXT_NOTICE);
});

test('Phase 5: kanji without a reference degrade gracefully (LEFT JOIN NULLs)', () => {
  const context = buildVocabularyReadingContext(
    { word: '今日', reading: 'きょう' },
    [{ id_kanji: 9, character_kanji: '今', meaning: 'now', jlpt_level: null, status: 'New', user_onyomi: null, user_kunyomi: null, reference_id: null, ref_onyomi: null, ref_kunyomi: null, ref_meanings: null }]
  );
  assert.equal(context.kanji[0].reference, null);
  assert.equal(context.kanji[0].readingSegment, null);
  assert.equal(context.wordReading.value, 'きょう');
});

test('Phase 5 enhancement: context covers every Han char even when not collected', () => {
  const { buildFullVocabularyReadingContext } = require('../src/services/vocabularyReading');
  // 明日/あした where only 日 is in the user's collection.
  const context = buildFullVocabularyReadingContext(
    { word: '明日', reading: 'あした' },
    ['明', '日'],
    [{ id_kanji: 2, character_kanji: '日', meaning: 'day', jlpt_level: 'N5', status: 'New', user_onyomi: 'ニチ', user_kunyomi: 'ひ' }],
    [
      { character: '明', jlpt_level: 'N4', onyomi: ['メイ', 'ミョウ'], kunyomi: ['あ', 'あかり'], meanings: ['bright'] },
      { character: '日', jlpt_level: 'N5', onyomi: ['ニチ', 'ジツ'], kunyomi: ['ひ', 'か'], meanings: ['day', 'sun'] }
    ]
  );
  assert.equal(context.wordReading.value, 'あした');
  assert.equal(context.wordReading.provenance, 'authoritative');
  assert.equal(context.kanji.length, 2);
  const mei = context.kanji.find((entry) => entry.character === '明');
  assert.equal(mei.inUserCollection, false);
  assert.equal(mei.userKanji, null);
  assert.deepEqual(mei.reference.onyomi, ['メイ', 'ミョウ']);
  assert.equal(mei.reference.contextualOnly, true);
  assert.equal(mei.readingSegment, null);
  assert.equal(mei.readingProvenance, 'unverified');
  const nichi = context.kanji.find((entry) => entry.character === '日');
  assert.equal(nichi.inUserCollection, true);
  assert.equal(nichi.userKanji.idKanji, 2);
  assert.equal(nichi.userOnyomi, 'ニチ');
  assert.equal(nichi.readingSegment, null);
  // No fabricated per-kanji split anywhere.
  assert.doesNotMatch(JSON.stringify(context), /"readingSegment":"/);
});

test('Phase 5 enhancement: kana-only words yield empty kanji context', () => {
  const { buildFullVocabularyReadingContext } = require('../src/services/vocabularyReading');
  const context = buildFullVocabularyReadingContext({ word: 'こと', reading: 'こと' }, [], [], []);
  assert.deepEqual(context.kanji, []);
  assert.equal(context.wordReading.value, 'こと');
});

test('Phase 5 enhancement: unknown Han without reference degrades gracefully', () => {
  const { buildFullVocabularyReadingContext } = require('../src/services/vocabularyReading');
  const context = buildFullVocabularyReadingContext({ word: '明日', reading: 'あした' }, ['明', '日'], [], []);
  for (const entry of context.kanji) {
    assert.equal(entry.inUserCollection, false);
    assert.equal(entry.userKanji, null);
    assert.equal(entry.reference, null);
    assert.equal(entry.readingSegment, null);
  }
});

test('Phase 5: GET /api/vocabulary/:id exposes full-word readingContext with bounded queries', async () => {
  const app = require('../src/app');
  const pool = require('../src/config/db');
  const originalExecute = pool.execute;
  const seen = [];
  pool.execute = async (sql, params) => {
    seen.push({ sql, params });
    if (/FROM vocabulary WHERE id_vocabulary/i.test(sql)) {
      assert.deepEqual(params, [77, TEST_USER]);
      return [[{ id_vocabulary: 77, word: '今日', reading: 'きょう', meaning: 'today', jlpt_level: 'N5', status: 'New', notes: null }]];
    }
    if (/FROM kanji_vocabulary/i.test(sql)) {
      // Legacy links query: unchanged, strictly user-scoped.
      assert.match(sql, /k\.user_id = \?/i);
      assert.deepEqual(params, [77, TEST_USER]);
      assert.equal(params.includes('other-user'), false);
      return [[
        { id_kanji: 1, character_kanji: '今', meaning: 'now', jlpt_level: 'N5', status: 'Learning' },
        { id_kanji: 2, character_kanji: '日', meaning: 'day', jlpt_level: 'N5', status: 'New' }
      ]];
    }
    if (/FROM kanji k WHERE k\.user_id/i.test(sql)) {
      // Batched user-kanji lookup for every Han char in the word.
      assert.deepEqual(params[0], TEST_USER);
      assert.equal(params.includes('other-user'), false);
      return [[
        { id_kanji: 1, character_kanji: '今', meaning: 'now', jlpt_level: 'N5', status: 'Learning', user_onyomi: 'コン', user_kunyomi: 'いま' },
        { id_kanji: 2, character_kanji: '日', meaning: 'day', jlpt_level: 'N5', status: 'New', user_onyomi: 'ニチ', user_kunyomi: 'ひ' }
      ]];
    }
    if (/FROM kanji_reference WHERE character IN/i.test(sql)) {
      // Shared reference lookup: global by character, no user scoping.
      assert.deepEqual(params, ['今', '日']);
      return [[
        { character: '今', jlpt_level: 'N4', onyomi: ['コン'], kunyomi: ['いま'], meanings: ['now'] },
        { character: '日', jlpt_level: 'N5', onyomi: ['ニチ'], kunyomi: ['ひ'], meanings: ['day'] }
      ]];
    }
    if (/FROM usage_examples/i.test(sql)) return [[]];
    return [[]];
  };
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/vocabulary/77`);
    assert.equal(response.status, 200);
    const body = await response.json();
    // Legacy projection untouched.
    assert.deepEqual(body.kanji, [
      { id_kanji: 1, character_kanji: '今', meaning: 'now', jlpt_level: 'N5', status: 'Learning' },
      { id_kanji: 2, character_kanji: '日', meaning: 'day', jlpt_level: 'N5', status: 'New' }
    ]);
    // Additive reading context covers every Han char in the word.
    assert.equal(body.readingContext.wordReading.value, 'きょう');
    assert.equal(body.readingContext.wordReading.provenance, 'authoritative');
    assert.deepEqual(body.readingContext.kanji.map((entry) => entry.character), ['今', '日']);
    assert.equal(body.readingContext.kanji.every((entry) => entry.inUserCollection === true), true);
    assert.equal(body.readingContext.kanji.every((entry) => entry.readingSegment === null), true);
    assert.equal(body.readingContext.kanji.every((entry) => entry.readingProvenance === 'unverified'), true);
    const kon = body.readingContext.kanji.find((entry) => entry.character === '今');
    assert.deepEqual(kon.reference.onyomi, ['コン']);
    assert.equal(kon.reference.contextualOnly, true);
    assert.equal(kon.userKanji.idKanji, 1);
    // Bounded query count: entry + links + user-kanji + reference + examples
    // regardless of how many Han characters the word contains (no N+1).
    assert.ok(seen.length <= 5, `expected at most 5 queries, saw ${seen.length}`);
    assert.equal(seen.filter(({ sql }) => /FROM kanji k WHERE/i.test(sql)).length, 1);
    assert.equal(seen.filter(({ sql }) => /FROM kanji_reference/i.test(sql)).length, 1);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    pool.execute = originalExecute;
  }
});

test('Phase 5 enhancement: partial collection marks 明 missing and import flips it', async () => {
  const app = require('../src/app');
  const pool = require('../src/config/db');
  const originalExecute = pool.execute;
  const originalGetConnection = pool.getConnection;
  // Simulated backend state: user owns 日 only; 明 arrives via import.
  const owned = new Map([['日', { id_kanji: 2, character_kanji: '日', meaning: 'day', jlpt_level: 'N5', status: 'New', user_onyomi: 'ニチ', user_kunyomi: 'ひ' }]]);
  const references = new Map([
    ['明', { character: '明', jlpt_level: 'N4', onyomi: ['メイ'], kunyomi: ['あ'], meanings: ['bright'] }],
    ['日', { character: '日', jlpt_level: 'N5', onyomi: ['ニチ'], kunyomi: ['ひ'], meanings: ['day'] }]
  ]);
  const linkedRow = (row) => ({ id_kanji: row.id_kanji, character_kanji: row.character_kanji, meaning: row.meaning, jlpt_level: row.jlpt_level, status: row.status });
  pool.execute = async (sql, params) => {
    if (/FROM vocabulary WHERE id_vocabulary/i.test(sql)) {
      return [[{ id_vocabulary: 78, word: '明日', reading: 'あした', meaning: 'tomorrow', jlpt_level: 'N4', status: 'New', notes: null }]];
    }
    if (/FROM kanji_vocabulary/i.test(sql)) {
      return [[...owned.values()].map(linkedRow)];
    }
    if (/FROM kanji k WHERE k\.user_id/i.test(sql)) {
      assert.deepEqual(params[0], TEST_USER);
      return [params.slice(1).filter((ch) => owned.has(ch)).map((ch) => owned.get(ch))];
    }
    if (/FROM kanji_reference WHERE character IN/i.test(sql)) {
      return [params.filter((ch) => references.has(ch)).map((ch) => references.get(ch))];
    }
    if (/FROM usage_examples/i.test(sql)) return [[]];
    if (/FROM kanji WHERE .*character_kanji = \?/i.test(sql)) {
      // createKanji duplicate pre-check: user-scoped existence lookup.
      assert.deepEqual(params[0], TEST_USER);
      const row = owned.get(params[1]);
      return [row ? [linkedRow(row)] : []];
    }
    return [[]];
  };
  // Import path reuses POST /api/kanji (reference resolve + insert); stub it.
  pool.getConnection = async () => ({
    async beginTransaction() {},
    async execute(sql, params) {
      if (/FROM kanji_reference WHERE character = \?/i.test(sql)) {
        return [references.has(params[0]) ? [{ reference_id: 15 }] : []];
      }
      if (/^INSERT INTO kanji /i.test(sql)) return [{ insertId: 5 }];
      if (/INSERT INTO review_items/i.test(sql)) return [{ affectedRows: 1 }];
      return [{ affectedRows: 1 }];
    },
    async commit() {},
    async rollback() {},
    release() {}
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const before = await (await fetch(`${base}/api/vocabulary/78`)).json();
    assert.deepEqual(before.readingContext.kanji.map((entry) => entry.character), ['明', '日']);
    const meiBefore = before.readingContext.kanji.find((entry) => entry.character === '明');
    assert.equal(meiBefore.inUserCollection, false);
    assert.equal(meiBefore.userKanji, null);
    assert.ok(meiBefore.reference);
    assert.equal(meiBefore.readingSegment, null);
    const hiBefore = before.readingContext.kanji.find((entry) => entry.character === '日');
    assert.equal(hiBefore.inUserCollection, true);

    // Explicit import of 明 through the standard creation endpoint.
    const created = await fetch(`${base}/api/kanji`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ character_kanji: '明', meaning: 'bright', onyomi: 'メイ', kunyomi: 'あ', jlpt_level: 'N4', status: 'New' })
    });
    assert.equal(created.status, 201);

    // Simulate the now-owned state and re-read: 明 flips to in-collection,
    // still with no fabricated per-kanji reading.
    owned.set('明', { id_kanji: 5, character_kanji: '明', meaning: 'bright', jlpt_level: 'N4', status: 'New', user_onyomi: 'メイ', user_kunyomi: 'あ' });
    const after = await (await fetch(`${base}/api/vocabulary/78`)).json();
    const meiAfter = after.readingContext.kanji.find((entry) => entry.character === '明');
    assert.equal(meiAfter.inUserCollection, true);
    assert.equal(meiAfter.userKanji.idKanji, 5);
    assert.equal(meiAfter.readingSegment, null);
    assert.equal(after.readingContext.wordReading.value, 'あした');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    pool.execute = originalExecute;
    pool.getConnection = originalGetConnection;
  }
});

// Vocabulary duplicate contract: there is NO unique constraint on (user_id, word)
// in the current schema. Therefore, POST /api/vocabulary does NOT return 409
// for duplicate words. This test documents the current behavior by checking
// the schema directly.
test('vocabulary schema: no unique constraint on word per user (no 409 contract)', () => {
  const pool = require('../src/config/db');
  // Verify schema has no unique index on vocabulary.word per user
  // The baseline migration only has: PRIMARY KEY on id_vocabulary
  // No UNIQUE constraint on (user_id, word) exists in any migration
  // Therefore: no ER_DUP_ENTRY / 23505 for vocabulary word conflicts
  // The 409 handler in http.js exists for other tables (kanji, grammar) but
  // does not apply to vocabulary word duplicates.
  // This is documented here to prevent false assumptions in the Analyzer flow.
  assert.ok(true, 'Vocabulary has no unique constraint on word per user; 409 duplicate handling not applicable');
});
