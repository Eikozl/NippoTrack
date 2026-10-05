const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const {
  DISCOVERY_NOTICE,
  DISCOVERY_SOURCE,
  DISCOVERY_STATES,
  buildSessionKanjiDiscovery,
  extractDiscoveryCharacters
} = require('../src/services/sessionKanjiDiscovery');

const TEST_USER = '00000000-0000-4000-8000-000000000001';

test.after(async () => {
  try {
    const pool = require('../src/config/db');
    await pool.end();
  } catch {
    // Pool may already be ended when only unit tests ran; ignore.
  }
});

const userRow = (character, overrides = {}) => ({
  id_kanji: character.codePointAt(0),
  character_kanji: character,
  meaning: `${character}-meaning`,
  jlpt_level: 'N5',
  status: 'New',
  user_onyomi: null,
  user_kunyomi: null,
  ...overrides
});

const refRow = (character, overrides = {}) => ({
  character,
  jlpt_level: 'N5',
  onyomi: [`${character}-on`],
  kunyomi: [`${character}-kun`],
  meanings: [`${character}-meaning`],
  stroke_count: 5,
  ...overrides
});

test('Phase 6: session text detects unique Han in first-occurrence order', () => {
  // 今日は学校に行く → 今 日 学 校 行 (deterministic extraction, not NLP).
  assert.deepEqual(extractDiscoveryCharacters(['今日は学校に行く']), ['今', '日', '学', '校', '行']);
});

test('Phase 6: repeated characters produce stable unique output', () => {
  assert.deepEqual(extractDiscoveryCharacters(['日本日本']), ['日', '本']);
});

test('Phase 6: kana-only content returns empty discovery safely', () => {
  assert.deepEqual(extractDiscoveryCharacters(['あしたははれです']), []);
  assert.deepEqual(extractDiscoveryCharacters([null, undefined, 42]), []);
  const discovery = buildSessionKanjiDiscovery([], [], []);
  assert.deepEqual(discovery, { source: DISCOVERY_SOURCE, characters: [], kanji: [], notice: DISCOVERY_NOTICE });
});

test('Phase 6: multiple writing rows aggregate with stable de-duplication', () => {
  // Second row repeats 日 and adds 本; order follows first occurrence.
  assert.deepEqual(extractDiscoveryCharacters(['今日は学校', '日本に行く']), ['今', '日', '学', '校', '本', '行']);
});

test('Phase 6: mixed collected / reference-only / unknown states', () => {
  const discovery = buildSessionKanjiDiscovery(
    ['今', '日', '学'],
    [userRow('今')],
    [refRow('今'), refRow('日')]
  );
  assert.equal(discovery.source, DISCOVERY_SOURCE);
  assert.deepEqual(discovery.characters, ['今', '日', '学']);
  const kon = discovery.kanji.find((entry) => entry.character === '今');
  assert.equal(kon.discoveryState, DISCOVERY_STATES.IN_COLLECTION);
  assert.equal(kon.inUserCollection, true);
  assert.equal(kon.userKanji.meaning, '今-meaning');
  const nichi = discovery.kanji.find((entry) => entry.character === '日');
  assert.equal(nichi.discoveryState, DISCOVERY_STATES.AVAILABLE);
  assert.equal(nichi.inUserCollection, false);
  assert.equal(nichi.userKanji, null);
  assert.deepEqual(nichi.reference.meanings, ['日-meaning']);
  assert.equal(nichi.reference.contextualOnly, true);
  assert.equal(nichi.reference.strokeCount, 5);
  const gaku = discovery.kanji.find((entry) => entry.character === '学');
  assert.equal(gaku.discoveryState, DISCOVERY_STATES.NO_REFERENCE);
  assert.equal(gaku.reference, null);
});

test('Phase 6: reference without usable meanings is not offered as available', () => {
  const discovery = buildSessionKanjiDiscovery(['学'], [], [refRow('学', { meanings: [] })]);
  assert.equal(discovery.kanji[0].discoveryState, DISCOVERY_STATES.NO_REFERENCE);
});

test('Phase 6: discovery never claims per-character readings', () => {
  const discovery = buildSessionKanjiDiscovery(
    ['今', '日', '学', '校', '行'],
    [userRow('今'), userRow('日')],
    [refRow('今'), refRow('日'), refRow('学'), refRow('校'), refRow('行')]
  );
  for (const entry of discovery.kanji) {
    assert.equal(entry.readingSegment, null);
    assert.equal(entry.readingProvenance, 'unverified');
  }
  assert.doesNotMatch(JSON.stringify(discovery), /"readingSegment":"/);
  assert.ok(discovery.notice.length > 0);
});

test('Phase 6: collection membership is per-user input, never leaked across users', () => {
  const characters = ['今', '日'];
  // User A owns 今; User B owns 日. Same text, different row sets.
  const forA = buildSessionKanjiDiscovery(characters, [userRow('今')], [refRow('今'), refRow('日')]);
  const forB = buildSessionKanjiDiscovery(characters, [userRow('日')], [refRow('今'), refRow('日')]);
  assert.equal(forA.kanji.find((entry) => entry.character === '今').discoveryState, DISCOVERY_STATES.IN_COLLECTION);
  assert.equal(forA.kanji.find((entry) => entry.character === '日').discoveryState, DISCOVERY_STATES.AVAILABLE);
  assert.equal(forB.kanji.find((entry) => entry.character === '今').discoveryState, DISCOVERY_STATES.AVAILABLE);
  assert.equal(forB.kanji.find((entry) => entry.character === '日').discoveryState, DISCOVERY_STATES.IN_COLLECTION);
});

test('Phase 6: GET /api/sessions/:id adds bounded discovery without changing existing shape', async () => {
  const app = require('../src/app');
  const pool = require('../src/config/db');
  const originalExecute = pool.execute;
  const seen = [];
  // User owns 学 and 行 only; 日/今/校 have reference; 曜 has neither.
  const owned = new Map(['学', '行'].map((ch) => [ch, userRow(ch)]));
  const references = new Map(['今', '日', '学', '校', '行'].map((ch) => [ch, refRow(ch)]));
  pool.execute = async (sql, params) => {
    seen.push({ sql, count: Array.isArray(params) ? params.length : 0 });
    if (/FROM study_sessions WHERE/i.test(sql)) {
      assert.deepEqual(params[1], TEST_USER);
      return [[{ id_session: 5, session_date: '2026-09-01', duration_minutes: 30, category: 'Writing', resource: null, notes: null }]];
    }
    if (/FROM session_vocabulary/i.test(sql)) return [[{ id_vocabulary: 1, word: '今日', reading: 'きょう', meaning: 'today', jlpt_level: 'N5', status: 'New' }]];
    if (/FROM session_kanji/i.test(sql)) return [[{ id_kanji: 7, character_kanji: '学', meaning: 'study', onyomi: 'ガク', kunyomi: 'まな', jlpt_level: 'N5', status: 'New' }]];
    if (/FROM session_grammar/i.test(sql)) return [[]];
    if (/FROM session_writings/i.test(sql)) return [[{ id_session_writing: 9, title: 'oct', content: '今日は学校に行く', notes: null }]];
    if (/FROM kanji k WHERE k\.user_id/i.test(sql)) {
      assert.deepEqual(params[0], TEST_USER);
      return [params.slice(1).filter((ch) => owned.has(ch)).map((ch) => owned.get(ch))];
    }
    if (/FROM kanji_reference WHERE character IN/i.test(sql)) {
      assert.ok(!/user_id/i.test(sql), 'reference lookup must not be user-scoped');
      return [params.filter((ch) => references.has(ch)).map((ch) => references.get(ch))];
    }
    return [[]];
  };
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/5`);
    assert.equal(response.status, 200);
    const body = await response.json();
    // Existing session/encounter-adjacent shape intact.
    assert.equal(body.id_session, 5);
    assert.equal(body.vocabulary.length, 1);
    assert.equal(body.kanji.length, 1);
    assert.deepEqual(body.grammar, []);
    assert.equal(body.writing.content, '今日は学校に行く');
    // Additive discovery covers every Han char in the writing content.
    assert.deepEqual(body.kanjiDiscovery.characters, ['今', '日', '学', '校', '行']);
    const states = Object.fromEntries(body.kanjiDiscovery.kanji.map((entry) => [entry.character, entry.discoveryState]));
    assert.deepEqual(states, { 今: 'availableToAdd', 日: 'availableToAdd', 学: 'alreadyInCollection', 校: 'availableToAdd', 行: 'alreadyInCollection' });
    assert.ok(body.kanjiDiscovery.kanji.every((entry) => entry.readingSegment === null));
    // Bounded query count: entry + vocab + kanji + grammar + writing +
    // linked stories (V5.5 session links) + user-kanji + reference,
    // regardless of discovered character count.
    assert.ok(seen.length <= 8, `expected at most 8 queries, saw ${seen.length}`);
    assert.equal(seen.filter(({ sql }) => /FROM kanji k WHERE/i.test(sql)).length, 1);
    assert.equal(seen.filter(({ sql }) => /FROM kanji_reference/i.test(sql)).length, 1);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    pool.execute = originalExecute;
  }
});

test('Phase 6: session without writing returns empty discovery and no IN queries', async () => {
  const app = require('../src/app');
  const pool = require('../src/config/db');
  const originalExecute = pool.execute;
  const seen = [];
  pool.execute = async (sql, params) => {
    seen.push(sql);
    if (/FROM study_sessions WHERE/i.test(sql)) {
      return [[{ id_session: 6, session_date: '2026-09-02', duration_minutes: 15, category: 'Reading', resource: null, notes: null }]];
    }
    if (/FROM session_writings/i.test(sql)) return [[]];
    return [[]];
  };
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/6`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.writing, null);
    assert.deepEqual(body.kanjiDiscovery.characters, []);
    assert.deepEqual(body.kanjiDiscovery.kanji, []);
    assert.equal(seen.filter((sql) => /character IN \(/i.test(sql)).length, 0);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    pool.execute = originalExecute;
  }
});
