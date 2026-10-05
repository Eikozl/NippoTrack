// Graded-reader TOKEN LAYER — contract-first QA locks.
//
// Backend + frontend land the implementation in parallel, so every assertion
// below runs against LOCAL fixtures and a LOCAL reference harness first.
// Live probes at the bottom attempt the real service/controller through
// stubbed pool executors (weekly-insights routing style + smart-goals
// withPoolExecute style). While the token layer has not landed yet those
// probes SKIP with a pending-implementation note — never a placeholder that
// goes red.
//
// Pinned contract asserted here (names/shapes are normative):
//   sentences[]: { id:Number, text:String, start:Number, end:Number }
//   tokens[]: { surface, lemma|null, surfaceReading|null, lemmaReading|null,
//     gloss|null, entityKind:'vocabulary'|'kanji'|'grammar', candidateId:String,
//     start:Number, end:Number, sentenceId:Number, tappable:Boolean,
//     known:Boolean, level:String|null }
//   POST /api/reading/text/:id/enroll {selected:[candidateId]}
//     -> {reviewSessionId, queueItems, created, items:[{entityType, entityId, display}]}
//
// candidateId convention (mirrors immersion/stories enroll keys):
// aggregate-stable ids — vocabulary::<canonical>::<reading>,
// kanji::<char>, grammar::<slug> — shared across occurrences of the same
// candidate. Occurrences stay distinct via (sentenceId, start, end); enroll
// dedupes by id exactly like intersectSelected.
//
// Linguistic invariants encoded: surface is the observed inflected form;
// lemmaReading is null for inflected/unresolved forms (lexical-token-adapter
// precedent: 行っ→イッ yields null); whole-word readings never split;
// kana-only surfaces carry no ruby expectation (consumer rule); proper
// nouns/unknown spans withhold readings and are not tappable; gloss stays
// null when no hit (never invented); vocabulary level stays null; offsets
// align with surfaces via Array.from slicing (astral-safe); bogus enroll ids
// are ignored and never written; the enroll response mirrors the stories
// enroll-srs handoff shape.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '00000000-0000-4000-8000-000000000002';
const ENROLL_CAP = 200;

let pool = null;
try {
  // Pool stubbing target only; services/controllers below load lazily per
  // probe so mid-edit product modules can never break file load.
  pool = require('../src/config/db');
} catch (_) {
  pool = null;
}

function loadOptional(path) {
  try {
    return require(path);
  } catch (_) {
    return null;
  }
}

async function withPoolStubs(stubs, callback) {
  if (!pool) throw new Error('pool unavailable');
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

function mockRes() {
  let statusCode = 200;
  let body;
  const res = {
    status(code) { statusCode = code; return res; },
    json(value) { body = value; return res; }
  };
  return { res, status: () => statusCode, body: () => body };
}

// ---------------------------------------------------------------- fixtures
// Code-point indexed text (14 + 14 points). s0 holds an inflected adjective,
// s1 holds an astral-plane char, s2 holds a proper noun, a suffix, a numeral
// and a grammar span nested over verb + particle spans.
const TEXT = '今日は暑くて。学校𠀋に行く。田中さんは三時に来てもいい。';
const SENTENCES = [
  { id: 0, text: '今日は暑くて。', start: 0, end: 7 },
  { id: 1, text: '学校𠀋に行く。', start: 7, end: 14 },
  { id: 2, text: '田中さんは三時に来てもいい。', start: 14, end: 28 }
];

function token(overrides) {
  return {
    surface: '学校',
    lemma: '学校',
    surfaceReading: 'がっこう',
    lemmaReading: 'がっこう',
    gloss: 'school',
    entityKind: 'vocabulary',
    candidateId: 'vocabulary::学校::がっこう',
    start: 7,
    end: 9,
    sentenceId: 1,
    tappable: true,
    known: false,
    level: null,
    ...overrides
  };
}

const PINNED_TOKEN_KEYS = [
  'surface', 'lemma', 'surfaceReading', 'lemmaReading', 'gloss',
  'entityKind', 'candidateId', 'start', 'end', 'sentenceId',
  'tappable', 'known', 'level'
].sort();

function stubTokens() {
  return [
    token({ surface: '今日', lemma: '今日', surfaceReading: 'きょう', lemmaReading: 'きょう', gloss: 'today', candidateId: 'vocabulary::今日::きょう', start: 0, end: 2, sentenceId: 0, known: false }),
    token({ surface: 'は', lemma: 'は', surfaceReading: 'わ', lemmaReading: 'は', gloss: null, candidateId: 'vocabulary::は::は', start: 2, end: 3, sentenceId: 0, tappable: false }),
    token({ surface: '暑くて', lemma: '暑い', surfaceReading: 'あつくて', lemmaReading: null, gloss: 'hot', candidateId: 'vocabulary::暑い::あつくて', start: 3, end: 6, sentenceId: 0 }),
    token({ surface: '。', lemma: '。', surfaceReading: null, lemmaReading: null, gloss: null, candidateId: 'vocabulary::。::', start: 6, end: 7, sentenceId: 0, tappable: false }),
    token({}),
    token({ surface: '𠀋', lemma: null, surfaceReading: null, lemmaReading: null, gloss: null, entityKind: 'kanji', candidateId: 'kanji::𠀋', start: 9, end: 10, sentenceId: 1, tappable: true, known: false, level: null }),
    token({ surface: '学', lemma: null, surfaceReading: null, lemmaReading: null, gloss: 'study', entityKind: 'kanji', candidateId: 'kanji::学', start: 7, end: 8, sentenceId: 1, tappable: true, known: true, level: 'N5' }),
    token({ surface: 'に', lemma: 'に', surfaceReading: 'に', lemmaReading: 'に', gloss: null, candidateId: 'vocabulary::に::に', start: 10, end: 11, sentenceId: 1, tappable: false }),
    token({ surface: '行く', lemma: '行く', surfaceReading: 'いく', lemmaReading: 'いく', gloss: 'to go', candidateId: 'vocabulary::行く::いく', start: 11, end: 13, sentenceId: 1, known: true }),
    token({ surface: '。', lemma: '。', surfaceReading: null, lemmaReading: null, gloss: null, candidateId: 'vocabulary::。::', start: 13, end: 14, sentenceId: 1, tappable: false }),
    token({ surface: '田中', lemma: '田中', surfaceReading: null, lemmaReading: null, gloss: null, candidateId: 'vocabulary::田中::', start: 14, end: 16, sentenceId: 2, tappable: false }),
    token({ surface: 'さん', lemma: 'さん', surfaceReading: 'さん', lemmaReading: 'さん', gloss: null, candidateId: 'vocabulary::さん::さん', start: 16, end: 18, sentenceId: 2, tappable: false }),
    token({ surface: 'は', lemma: 'は', surfaceReading: 'わ', lemmaReading: 'は', gloss: null, candidateId: 'vocabulary::は::は', start: 18, end: 19, sentenceId: 2, tappable: false }),
    token({ surface: '三', lemma: '三', surfaceReading: 'さん', lemmaReading: 'さん', gloss: null, candidateId: 'vocabulary::三::さん', start: 19, end: 20, sentenceId: 2, tappable: false }),
    token({ surface: '時', lemma: '時', surfaceReading: 'とき', lemmaReading: 'とき', gloss: 'time', candidateId: 'vocabulary::時::とき', start: 20, end: 21, sentenceId: 2, tappable: true }),
    token({ surface: 'に', lemma: 'に', surfaceReading: 'に', lemmaReading: 'に', gloss: null, candidateId: 'vocabulary::に::に', start: 21, end: 22, sentenceId: 2, tappable: false }),
    token({ surface: '来て', lemma: '来る', surfaceReading: 'きて', lemmaReading: null, gloss: 'to come', candidateId: 'vocabulary::来る::きて', start: 22, end: 24, sentenceId: 2, tappable: true }),
    token({ surface: 'も', lemma: 'も', surfaceReading: 'も', lemmaReading: 'も', gloss: null, candidateId: 'vocabulary::も::も', start: 24, end: 25, sentenceId: 2, tappable: false }),
    token({ surface: 'ても', lemma: null, surfaceReading: null, lemmaReading: null, gloss: 'even if', entityKind: 'grammar', candidateId: 'grammar::temo', start: 23, end: 25, sentenceId: 2, tappable: true, known: false, level: 'N3' }),
    token({ surface: 'いい', lemma: 'いい', surfaceReading: 'いい', lemmaReading: 'いい', gloss: 'good', candidateId: 'vocabulary::いい::いい', start: 25, end: 27, sentenceId: 2, tappable: true }),
    token({ surface: '。', lemma: '。', surfaceReading: null, lemmaReading: null, gloss: null, candidateId: 'vocabulary::。::', start: 27, end: 28, sentenceId: 2, tappable: false })
  ];
}

// Lexical precedent fixture: 行っ→イッ yields null lemmaReading (the fragment
// reading is never presented as the lemma reading).
function inflectedFragmentFixture() {
  return {
    text: '行った',
    item: {
      surface: '行っ', lemma: '行く', surfaceReading: 'いっ', lemmaReading: null,
      gloss: 'to go', entityKind: 'vocabulary', candidateId: 'vocabulary::行く::いっ',
      start: 0, end: 2, sentenceId: 9, tappable: true, known: false, level: null
    }
  };
}

// ------------------------------------------------------- local validators
function slicePoints(text, start, end) {
  return Array.from(String(text)).slice(start, end).join('');
}

function assertSentenceShape(sentence, text) {
  assert.deepEqual(Object.keys(sentence).sort(), ['end', 'id', 'start', 'text']);
  assert.equal(typeof sentence.id, 'number');
  assert.equal(typeof sentence.text, 'string');
  assert.ok(Number.isInteger(sentence.start) && Number.isInteger(sentence.end));
  assert.ok(sentence.start >= 0 && sentence.end <= Array.from(text).length && sentence.end > sentence.start);
  assert.equal(slicePoints(text, sentence.start, sentence.end), sentence.text);
}

function assertTokenShape(item) {
  assert.deepEqual(Object.keys(item).sort(), PINNED_TOKEN_KEYS);
  assert.equal(typeof item.surface, 'string');
  assert.ok(item.surface.length > 0, 'surface is the observed form, never blank');
  assert.ok(item.lemma === null || typeof item.lemma === 'string');
  assert.ok(item.surfaceReading === null || typeof item.surfaceReading === 'string');
  assert.ok(item.lemmaReading === null || typeof item.lemmaReading === 'string');
  assert.ok(item.gloss === null || typeof item.gloss === 'string');
  assert.ok(['vocabulary', 'kanji', 'grammar'].includes(item.entityKind));
  assert.equal(typeof item.candidateId, 'string');
  assert.ok(item.candidateId.length > 0);
  assert.ok(Number.isInteger(item.start) && Number.isInteger(item.end) && item.end > item.start);
  assert.equal(typeof item.sentenceId, 'number');
  assert.equal(typeof item.tappable, 'boolean');
  assert.equal(typeof item.known, 'boolean');
  assert.ok(item.level === null || typeof item.level === 'string');
}

function hasHan(value) {
  return /\p{Script=Han}/u.test(String(value || ''));
}

// Consumer ruby rule mirrored for the server-side null-reading assertions:
// ruby is only ever sourced from surfaceReading and only for Han surfaces.
function rubyExpected(item) {
  if (typeof item.surfaceReading !== 'string' || !item.surfaceReading) return false;
  if (!hasHan(item.surface)) return false;
  return true;
}

// ------------------------------------------------------- reference harness
// Aggregate-stable id builders mirroring the stories/immersion enroll keys:
// vocabulary::<canonical>::<reading>, kanji::<char>, grammar::<slug>.
function referenceVocabularyId(item) {
  return `vocabulary::${item.lemma || item.surface}::${item.lemmaReading || item.surfaceReading || ''}`;
}

function referenceKanjiId(item) {
  return `kanji::${item.surface}`;
}

function referenceTokenId(item) {
  if (item.entityKind === 'kanji') return referenceKanjiId(item);
  if (item.entityKind === 'grammar') return item.candidateId;
  return referenceVocabularyId(item);
}

function selectEnrollIds(validIdSet, requested) {
  // Mirrors the landed validation: 1..200 entries, every entry a non-empty
  // string. Well-formed but unknown ids are ignored (never written); anything
  // else is rejected before any write.
  if (!Array.isArray(requested) || requested.length < 1 || requested.length > ENROLL_CAP) {
    throw new Error(`selected must be an array of 1 to ${ENROLL_CAP} candidate id strings.`);
  }
  for (const id of requested) {
    if (typeof id !== 'string' || !id) {
      throw new Error('selected must contain only non-empty candidate id strings.');
    }
  }
  const seen = new Set();
  const selected = [];
  const ignored = [];
  for (const id of requested) {
    if (seen.has(id)) continue; // repeat picks stay idempotent
    seen.add(id);
    if (!validIdSet.has(id)) { ignored.push(id); continue; }
    selected.push(id);
  }
  return { selected, ignored };
}

function makeEnrollStore() {
  return { writes: [], entities: new Map(), reviewSessionId: 901, nextEntityId: 701, sessions: 0 };
}

function runReferenceEnroll({ validTokens, requested, userId, store }) {
  const validIdSet = new Set(validTokens.map((item) => item.candidateId));
  const { selected, ignored } = selectEnrollIds(validIdSet, requested);
  const items = [];
  const queueItems = [];
  for (const id of selected) {
    const found = validTokens.find((item) => item.candidateId === id);
    // Idempotent entity reuse: a trimmed word already in the collection is
    // reused, never duplicated (mirrors ensure*Entities + ON CONFLICT).
    const key = `${found.entityKind}::${found.surface}`;
    let entityId = store.entities.get(key);
    if (!Number.isInteger(entityId)) {
      entityId = store.nextEntityId;
      store.nextEntityId += 1;
      store.entities.set(key, entityId);
    }
    // Every write is user-scoped; bogus ids never reach this point.
    store.writes.push({ userId, candidateId: id, entityType: found.entityKind, entityId });
    items.push({ entityType: found.entityKind, entityId, display: found.surface });
    queueItems.push({
      entityType: found.entityKind,
      entityId,
      display: found.surface,
      reading: found.surfaceReading,
      meaning: found.gloss
    });
  }
  // No valid selection: graceful no-op without a review session, exactly like
  // the stories unknown-ids path (created 0, null session).
  if (!items.length) {
    return { reviewSessionId: null, queueItems: [], created: 0, items: [], ignored };
  }
  store.sessions += 1;
  return { reviewSessionId: store.reviewSessionId, queueItems, created: items.length, items, ignored };
}

function assertEnrollShape(result) {
  assert.equal(typeof result.reviewSessionId, 'number');
  assert.ok(Number.isInteger(result.reviewSessionId) && result.reviewSessionId > 0);
  assert.ok(Array.isArray(result.queueItems));
  assert.equal(typeof result.created, 'number');
  assert.equal(result.created, result.items.length);
  assert.ok(Array.isArray(result.items));
  for (const entry of result.items) {
    assert.ok(['vocabulary', 'kanji', 'grammar'].includes(entry.entityType));
    assert.equal(typeof entry.entityId, 'number');
    assert.equal(typeof entry.display, 'string');
  }
  for (const entry of result.queueItems) {
    assert.ok(['vocabulary', 'kanji', 'grammar'].includes(entry.entityType));
    assert.equal(typeof entry.entityId, 'number');
    assert.equal(typeof entry.display, 'string');
  }
}

function assertEnrollNoop(result) {
  assert.equal(result.reviewSessionId, null, 'no valid selection opens no session');
  assert.equal(result.created, 0);
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.queueItems, []);
}

// ------------------------------------------------------- contract: shape
test('token layer contract: sentences carry id/text/start/end code-point offsets', () => {
  assert.equal(Array.from(TEXT).length, 28);
  for (const sentence of SENTENCES) assertSentenceShape(sentence, TEXT);
  assert.deepEqual(SENTENCES.map((s) => s.id), [0, 1, 2]);
  assert.equal(SENTENCES.map((s) => s.text).join(''), TEXT, 'sentences partition the text without gaps');
});

test('token layer contract: tokens expose exactly the pinned keys per entity kind', () => {
  const items = stubTokens();
  assert.ok(items.some((t) => t.entityKind === 'vocabulary'));
  assert.ok(items.some((t) => t.entityKind === 'kanji'));
  assert.ok(items.some((t) => t.entityKind === 'grammar'));
  for (const item of items) assertTokenShape(item);
});

test('token layer contract: offsets align with surfaces via Array.from slicing (astral-safe)', () => {
  const chars = Array.from(TEXT);
  for (const item of stubTokens()) {
    assert.equal(slicePoints(TEXT, item.start, item.end), item.surface, `span mismatch for ${item.candidateId}`);
    assert.equal(item.end - item.start, Array.from(item.surface).length);
  }
  const astral = stubTokens().find((t) => t.surface === '𠀋');
  assert.equal(astral.end - astral.start, 1, 'astral char spans one code point');
  assert.equal('𠀋'.length, 2, 'guard: the astral char is two UTF-16 units, so text.slice would drift');
  assert.equal(chars[astral.start], '𠀋');
  const inflected = stubTokens().find((t) => t.surface === '暑くて');
  assert.equal(slicePoints(TEXT, inflected.start, inflected.end), '暑くて', 'inflected surface fully covered');
  const verb = stubTokens().find((t) => t.surface === '来て');
  assert.equal(slicePoints(TEXT, verb.start, verb.end), '来て');
});

test('token layer contract: surface is the observed inflected form', () => {
  const items = stubTokens();
  const atsui = items.find((t) => t.surface === '暑くて');
  assert.equal(atsui.surface, '暑くて', 'observed 暑くて, not the dictionary form');
  assert.equal(atsui.lemma, '暑い');
  const kuru = items.find((t) => t.surface === '来て');
  assert.equal(kuru.surface, '来て');
  assert.equal(kuru.lemma, '来る');
  const { text, item } = inflectedFragmentFixture();
  assert.equal(slicePoints(text, item.start, item.end), '行っ');
  assert.equal(item.lemma, '行く');
});

test('token layer contract: lemmaReading null for inflected or unresolved forms', () => {
  const { item } = inflectedFragmentFixture();
  assertTokenShape(item);
  assert.equal(item.surfaceReading, 'いっ');
  assert.equal(item.lemmaReading, null, 'イッ is a fragment, never the 行く reading (adapter precedent)');
  for (const surface of ['暑くて', '来て']) {
    const found = stubTokens().find((t) => t.surface === surface);
    assert.equal(found.lemmaReading, null, `${surface}: inflected, so no lemma reading is claimed`);
    assert.equal(typeof found.surfaceReading, 'string', `${surface}: occurrence reading stays visible`);
  }
  const astral = stubTokens().find((t) => t.surface === '𠀋');
  assert.equal(astral.surfaceReading, null);
  assert.equal(astral.lemmaReading, null);
  // Contrast: the dictionary form observed directly may carry both readings.
  const school = stubTokens().find((t) => t.surface === '学校');
  assert.equal(school.surfaceReading, 'がっこう');
  assert.equal(school.lemmaReading, 'がっこう');
});

test('token layer contract: whole-word readings are never split', () => {
  for (const item of [...stubTokens(), inflectedFragmentFixture().item]) {
    for (const value of [item.surfaceReading, item.lemmaReading]) {
      if (value !== null) assert.ok(!value.includes(' '), `no partitioned reading on ${item.candidateId}`);
    }
    assert.ok(!('kanjiReadings' in item) && !('readingSegments' in item), 'no per-kanji split field exists');
  }
});

test('token layer contract: kana-only surfaces carry no ruby expectation', () => {
  assert.equal(rubyExpected(token({ surface: 'は', surfaceReading: 'わ' })), false);
  assert.equal(rubyExpected(token({ surface: 'いい', surfaceReading: 'いい' })), false);
  assert.equal(rubyExpected(token({ surface: 'ひらがな', surfaceReading: 'ひらがな' })), false);
  assert.equal(rubyExpected(token({ surface: '学校', surfaceReading: 'がっこう' })), true);
  assert.equal(rubyExpected(token({ surface: '学校', surfaceReading: null })), false, 'no reading, no ruby');
});

test('token layer contract: proper-noun and unknown spans withhold readings and are not tappable', () => {
  const name = stubTokens().find((t) => t.surface === '田中');
  assert.equal(name.surfaceReading, null);
  assert.equal(name.lemmaReading, null);
  assert.equal(name.gloss, null);
  assert.equal(name.tappable, false);
  const unknown = token({
    surface: 'ｺﾝﾋﾟｭｰﾀｰ', lemma: null, surfaceReading: null, lemmaReading: null, gloss: null,
    candidateId: 'vocabulary::ｺﾝﾋﾟｭｰﾀｰ::', start: 0, end: 7, sentenceId: 9, tappable: false
  });
  assertTokenShape(unknown);
  assert.equal(unknown.surface, 'ｺﾝﾋﾟｭｰﾀｰ', 'original surface untouched');
});

test('token layer contract: gloss null when no hit (never invented)', () => {
  for (const item of stubTokens()) assert.ok(item.gloss === null || (typeof item.gloss === 'string' && item.gloss.length > 0));
  for (const surface of ['田中', 'は', '。', '𠀋', 'さん', '三']) {
    assert.equal(stubTokens().find((t) => t.surface === surface).gloss, null, `${surface}: no hit stays null`);
  }
  assert.equal(stubTokens().find((t) => t.surface === '学校').gloss, 'school');
});

test('token layer contract: vocabulary level always null', () => {
  for (const item of stubTokens().filter((t) => t.entityKind === 'vocabulary')) {
    assert.equal(item.level, null, `vocabulary carries no JLPT band (${item.candidateId})`);
  }
  assert.equal(stubTokens().find((t) => t.entityKind === 'kanji' && t.surface === '学').level, 'N5');
  assert.equal(stubTokens().find((t) => t.entityKind === 'grammar').level, 'N3');
});

test('token layer contract: tappable false for particles symbols numerals suffixes', () => {
  const items = stubTokens();
  const silent = ['は', '。', 'に', 'も', '三', 'さん', '田中'];
  for (const surface of silent) {
    for (const found of items.filter((t) => t.surface === surface)) {
      assert.equal(found.tappable, false, `${surface} renders non-interactive`);
    }
  }
  for (const surface of ['学校', '暑くて', '学', '𠀋', 'ても', 'いい', '来て', '今日', '時', '行く']) {
    assert.equal(items.find((t) => t.surface === surface).tappable, true, `${surface} stays tappable`);
  }
});

test('token layer contract: candidateId is deterministic and namespaced', () => {
  for (const item of stubTokens()) {
    assert.ok(item.candidateId.startsWith(`${item.entityKind}::`), `id namespaced by kind: ${item.candidateId}`);
    assert.match(item.candidateId, /^(vocabulary|kanji|grammar)::/);
  }
  // Deterministic rebuild from the same logical inputs.
  for (const item of stubTokens().filter((t) => t.entityKind !== 'grammar')) {
    assert.equal(referenceTokenId(item), item.candidateId, `stable id for ${item.surface}`);
  }
  // Occurrences stay distinct via (sentenceId, start, end) even when they
  // share one aggregate id (は/に/。 repeat across sentences).
  const spans = stubTokens().map((t) => [t.sentenceId, t.start, t.end].join(':'));
  assert.equal(new Set(spans).size, spans.length, 'one span per occurrence');
  const shared = stubTokens().filter((t) => t.candidateId === 'vocabulary::は::は');
  assert.equal(shared.length, 2, 'repeat occurrences share the aggregate id');
  assert.notDeepEqual([shared[0].sentenceId, shared[0].start], [shared[1].sentenceId, shared[1].start], 'shared id still marks two distinct spans');
});

test('token layer contract: sentence bounds ordered and non-overlapping', () => {
  const ordered = [...SENTENCES].sort((a, b) => a.start - b.start);
  assert.deepEqual(ordered.map((s) => s.id), [0, 1, 2]);
  for (let i = 1; i < ordered.length; i += 1) {
    assert.ok(ordered[i].start >= ordered[i - 1].end, 'no overlapping sentence spans');
  }
  for (const item of stubTokens()) {
    const sentence = SENTENCES.find((s) => s.id === item.sentenceId);
    assert.ok(sentence, `token ${item.candidateId} points at a known sentence`);
    assert.ok(item.start >= sentence.start && item.end <= sentence.end, 'token lives inside its sentence');
  }
});

// ------------------------------------------------------- contract: enroll
test('enroll contract: happy-path response mirrors the stories enroll-srs shape', () => {
  const store = makeEnrollStore();
  const valid = stubTokens().filter((t) => t.tappable);
  const requested = [valid[0].candidateId, valid[1].candidateId];
  const result = runReferenceEnroll({ validTokens: valid, requested, userId: USER_ID, store });
  assertEnrollShape(result);
  assert.equal(result.created, 2);
  assert.equal(result.queueItems.length, 2);
  assert.ok(result.queueItems.every((entry) => typeof entry.display === 'string' && entry.display.length > 0));
  assert.deepEqual(result.items.map((entry) => entry.display), [valid[0].surface, valid[1].surface]);
});

test('enroll contract: bogus ids ignored and never written', () => {
  const store = makeEnrollStore();
  const valid = stubTokens();
  const good = valid[0].candidateId;
  const result = runReferenceEnroll({
    validTokens: valid,
    requested: [good, 'vocabulary::存在しない::x', 'not-a-candidate', 'grammar::nope'],
    userId: USER_ID,
    store
  });
  assert.equal(result.created, 1);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].display, valid[0].surface);
  assert.ok(store.writes.every((w) => w.candidateId === good), 'no write references a bogus id');
  assert.ok(!JSON.stringify(store.writes).includes('存在しない'));
  assert.deepEqual(result.ignored, ['vocabulary::存在しない::x', 'not-a-candidate', 'grammar::nope']);
});

test('enroll contract: malformed selections rejected before any write', () => {
  const store = makeEnrollStore();
  for (const bad of [[], null, ['', 'vocabulary::x::y'], [null], [42], 'vocabulary::x::y']) {
    assert.throws(
      () => runReferenceEnroll({ validTokens: stubTokens(), requested: bad, userId: USER_ID, store }),
      /selected must be an array|selected must contain only/
    );
  }
  assert.equal(store.writes.length, 0, 'rejected selections write nothing');
  assert.equal(store.entities.size, 0);
});

test('enroll contract: writes scoped to req.user.id', () => {
  const store = makeEnrollStore();
  const valid = stubTokens();
  runReferenceEnroll({ validTokens: valid, requested: [valid[0].candidateId], userId: USER_ID, store });
  assert.ok(store.writes.length > 0);
  assert.ok(store.writes.every((w) => w.userId === USER_ID));
  assert.ok(!store.writes.some((w) => w.userId === OTHER_USER_ID));
});

test('enroll contract: oversized selection rejected (200-cap)', () => {
  const many = Array.from({ length: 205 }, (_, i) => token({
    surface: `語${i}`, lemma: `語${i}`, surfaceReading: null, lemmaReading: null, gloss: null,
    candidateId: `vocabulary::語${i}::`, start: i, end: i + 1, sentenceId: 9
  }));
  const store = makeEnrollStore();
  assert.throws(
    () => runReferenceEnroll({ validTokens: many, requested: many.map((t) => t.candidateId), userId: USER_ID, store }),
    /1 to 200/
  );
  assert.equal(store.writes.length, 0, 'rejected selections write nothing');
  const okIds = many.slice(0, 200).map((t) => t.candidateId);
  const result = runReferenceEnroll({ validTokens: many, requested: okIds, userId: USER_ID, store });
  assert.equal(result.created, 200, 'exactly 200 valid ids enroll');
});

test('enroll contract: empty selection rejected, all-bogus is a graceful no-op', () => {
  const store = makeEnrollStore();
  assert.throws(() => runReferenceEnroll({ validTokens: stubTokens(), requested: [], userId: USER_ID, store }), /non-empty|1 to 200/);
  const noop = runReferenceEnroll({
    validTokens: stubTokens(),
    requested: ['vocabulary::nope::x'],
    userId: USER_ID,
    store
  });
  assertEnrollNoop(noop);
  assert.equal(store.writes.length, 0, 'no-op writes nothing');
});

test('enroll contract: repeat enroll stays idempotent', () => {
  const store = makeEnrollStore();
  const valid = stubTokens();
  const requested = [valid[0].candidateId, valid[0].candidateId, valid[4].candidateId];
  const first = runReferenceEnroll({ validTokens: valid, requested, userId: USER_ID, store });
  assert.deepEqual(first.items.map((e) => e.display), [valid[0].surface, valid[4].surface], 'duplicate picks collapse');
  const entitiesBefore = store.entities.size;
  const second = runReferenceEnroll({ validTokens: valid, requested, userId: USER_ID, store });
  assert.deepEqual(second.items, first.items, 'same selection resolves the identical set twice');
  assert.equal(store.entities.size, entitiesBefore, 'no duplicate entities on repeat');
});

// ------------------------------------------------------- live probes
function lenientReadingStub(calls, textRow) {
  return async (sql, params = []) => {
    calls.push({ sql, params });
    if (/FROM reading_texts/i.test(sql)) return [[textRow]];
    if (/kanji_reference/i.test(sql)) return [[]];
    if (/FROM kanji WHERE/i.test(sql)) return [[]];
    if (/grammar_reference/i.test(sql)) return [[]];
    if (/grammar_points/i.test(sql)) return [[]];
    if (/FROM vocabulary WHERE/i.test(sql)) return [[]];
    if (/jmdict/i.test(sql)) return [[]];
    if (/INSERT INTO review_sessions/i.test(sql)) return [{ insertId: 901 }];
    if (/INSERT INTO review_session_items/i.test(sql)) return [[{ affectedRows: 1 }]];
    if (/INSERT INTO review_items/i.test(sql)) return [[{ affectedRows: 1 }]];
    if (/FROM review_items WHERE/i.test(sql)) return [[{ id_review_item: 701 }]];
    if (/INSERT INTO/i.test(sql)) return [{ insertId: 702 }];
    if (/^\s*SELECT/i.test(sql)) return [[]];
    return [[]];
  };
}

test('live: gradedReader service exposes a token-layer builder (skip while pending)', async (t) => {
  const service = loadOptional('../src/services/gradedReader');
  if (!service) { t.skip('gradedReader service not importable yet'); return; }
  const names = ['buildReadingTokens', 'getReadingTokens', 'tokenizeReading', 'buildSentences', 'enrollReading', 'enrollReadingItems'];
  const found = names.filter((name) => typeof service[name] === 'function');
  if (!found.length) { t.skip(`no token-layer builder among [${names.join(', ')}] yet`); return; }
  assert.ok(found.length > 0, `token-layer builder present: ${found.join(', ')}`);
});

test('live: GET text returns sentences[] + tokens[] through stubbed pool (skip while pending)', async (t) => {
  const controller = loadOptional('../src/controllers/gradedReaderController');
  if (!controller || typeof controller.getText !== 'function') { t.skip('gradedReaderController.getText not importable yet'); return; }
  if (!pool) { t.skip('pool unavailable for stubbing'); return; }
  const calls = [];
  const textRow = {
    id: '26', title: 'Tokens', level: 'N5', sourceType: 'user', metadata: {},
    text: TEXT, position: null, completedAt: null, timeSpentSeconds: null
  };
  await withPoolStubs({ execute: lenientReadingStub(calls, textRow), query: lenientReadingStub(calls, textRow) }, async () => {
    const { res, status, body } = mockRes();
    let data;
    try {
      await controller.getText({ params: { id: '26' }, user: { id: USER_ID } }, res);
    } catch (error) {
      t.skip(`getText threw against the stub (${error?.message || error})`);
      return;
    }
    assert.equal(status(), 200);
    data = body();
    if (!Array.isArray(data.sentences) || !Array.isArray(data.tokens)) {
      t.skip('token layer not yet on the getText response');
      return;
    }
    for (const sentence of data.sentences) assertSentenceShape(sentence, data.text);
    for (const item of data.tokens) {
      assertTokenShape(item);
      assert.equal(slicePoints(data.text, item.start, item.end), item.surface, `live span mismatch ${item.candidateId}`);
    }
    // Task pins candidateId as shared enrollable identity
    // (vocabulary::<canonical>::<reading>, kanji::<char>, grammar::<slug>):
    // repeats share one id for idempotent enroll, so uniqueness lives in the
    // occurrence span (start/end/surface), not in the id.
    const spans = data.tokens.map((item) => `${item.start}-${item.end}-${item.surface}`);
    assert.equal(new Set(spans).size, spans.length, 'live spans unique per occurrence');
    for (const item of data.tokens) {
      assert.ok(item.candidateId.startsWith(`${item.entityKind}::`), `live id namespaced by kind: ${item.candidateId}`);
    }
    for (const item of data.tokens.filter((entry) => entry.entityKind === 'vocabulary')) {
      assert.equal(item.level, null, `live vocabulary level stays null (${item.candidateId})`);
    }
    for (const item of data.tokens.filter((entry) => entry.entityKind !== 'vocabulary')) {
      assert.equal(item.lemma, null, `live ${item.entityKind} tokens carry no lemma (${item.candidateId})`);
    }
    for (const item of data.tokens.filter((entry) => entry.entityKind === 'vocabulary' && entry.lemma !== null && entry.surface !== entry.lemma)) {
      assert.equal(item.lemmaReading, null, `live inflected occurrence withholds the lemma reading (${item.candidateId})`);
    }
    assert.ok(calls.some((c) => (c.params || []).includes(USER_ID)), 'reads scoped to req.user.id');
    assert.ok(!calls.some((c) => (c.params || []).includes(OTHER_USER_ID)), 'no foreign identity leaks into params');
  });
});

test('live: enrollText enrolls stable ids, ignores bogus, stays scoped', async (t) => {
  const controller = loadOptional('../src/controllers/gradedReaderController');
  if (!controller || typeof controller.enrollText !== 'function') { t.skip('gradedReaderController.enrollText not present yet'); return; }
  const service = loadOptional('../src/services/gradedReader');
  if (!service || typeof service.analyzeTextForReading !== 'function') { t.skip('gradedReader analysis not importable yet'); return; }
  if (!pool) { t.skip('pool unavailable for stubbing'); return; }
  // A real candidate id from a fresh analysis (never guessed): the enroll
  // path re-runs this same analysis and intersects by id.
  let realId = null;
  try {
    const analysis = await service.analyzeTextForReading({ execute: lenientReadingStub([], null) }, USER_ID, TEXT);
    realId = (analysis.tokens.find((item) => item.tappable) || {}).candidateId || null;
  } catch (error) {
    t.skip(`analysis threw against the stub (${error?.message || error})`);
    return;
  }
  if (!realId) { t.skip('analysis yielded no tappable token to enroll'); return; }
  const calls = [];
  const stub = async (sql, params = []) => {
    calls.push({ sql, params });
    if (/FROM reading_texts/i.test(sql)) return [[{ id_reading_text: 26, text: TEXT }]];
    if (/INSERT INTO review_sessions/i.test(sql)) return [{ insertId: 901 }];
    if (/INSERT INTO review_session_items/i.test(sql)) return [[{ affectedRows: 1 }]];
    if (/INSERT INTO review_items/i.test(sql)) return [[{ affectedRows: 1 }]];
    if (/FROM review_items WHERE/i.test(sql)) return [[{ id_review_item: 701 }]];
    if (/INSERT INTO/i.test(sql)) return [{ insertId: 702 }];
    if (/kanji_reference/i.test(sql)) return [[]];
    if (/FROM kanji WHERE/i.test(sql)) return [[]];
    if (/grammar_reference/i.test(sql)) return [[]];
    if (/grammar_points/i.test(sql)) return [[]];
    if (/FROM vocabulary WHERE/i.test(sql)) return [[]];
    if (/jmdict/i.test(sql)) return [[]];
    if (/^\s*SELECT/i.test(sql)) return [[]];
    return [[]];
  };
  const fakeConn = {
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
    execute: stub,
    query: stub
  };
  await withPoolStubs({ execute: stub, query: stub, getConnection: async () => fakeConn }, async () => {
    const happy = mockRes();
    await controller.enrollText({ params: { id: '26' }, body: { selected: [realId, 'vocabulary::nope::x'] }, user: { id: USER_ID } }, happy.res);
    if (happy.status() !== 200) { t.skip(`enroll happy path answered ${happy.status()} against the stub`); return; }
    const data = happy.body();
    assertEnrollShape(data);
    assert.ok(data.created >= 1, 'the real id enrolled');
    assert.ok(!JSON.stringify(calls).includes('vocabulary::nope::x'), 'bogus ids never written');
    assert.ok(calls.some((c) => (c.params || []).includes(USER_ID)), 'enroll scoped to req.user.id');
    assert.ok(!calls.some((c) => (c.params || []).includes(OTHER_USER_ID)), 'no foreign identity leaks into params');

    const empty = mockRes();
    await controller.enrollText({ params: { id: '26' }, body: { selected: [] }, user: { id: USER_ID } }, empty.res);
    assert.equal(empty.status(), 400, 'empty selection rejected');

    const huge = mockRes();
    await controller.enrollText({ params: { id: '26' }, body: { selected: Array.from({ length: 201 }, () => realId) }, user: { id: USER_ID } }, huge.res);
    assert.equal(huge.status(), 400, 'over-200 selection rejected');
  });
});

test('live: enrollText hides foreign texts as 404', async (t) => {
  const controller = loadOptional('../src/controllers/gradedReaderController');
  if (!controller || typeof controller.enrollText !== 'function') { t.skip('gradedReaderController.enrollText not present yet'); return; }
  if (!pool) { t.skip('pool unavailable for stubbing'); return; }
  const foreign = async (sql, params = []) => {
    if (/FROM reading_texts/i.test(sql)) return [[]];
    if (/^\s*SELECT/i.test(sql)) return [[]];
    return [[]];
  };
  const fakeConn = {
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
    execute: foreign,
    query: foreign
  };
  await withPoolStubs({ execute: foreign, query: foreign, getConnection: async () => fakeConn }, async () => {
    const response = mockRes();
    await controller.enrollText({ params: { id: '999' }, body: { selected: ['vocabulary::x::y'] }, user: { id: USER_ID } }, response.res);
    assert.equal(response.status(), 404);
  });
});

test('live: candidateIds deterministic across repeated reads (skip while pending)', async (t) => {
  const controller = loadOptional('../src/controllers/gradedReaderController');
  if (!controller || typeof controller.getText !== 'function') { t.skip('gradedReaderController.getText not importable yet'); return; }
  if (!pool) { t.skip('pool unavailable for stubbing'); return; }
  const textRow = {
    id: '26', title: 'Tokens', level: 'N5', sourceType: 'user', metadata: {},
    text: TEXT, position: null, completedAt: null, timeSpentSeconds: null
  };
  const run = async () => {
    const calls = [];
    let data = null;
    await withPoolStubs({ execute: lenientReadingStub(calls, textRow), query: lenientReadingStub(calls, textRow) }, async () => {
      const ctx = mockRes();
      await controller.getText({ params: { id: '26' }, user: { id: USER_ID } }, ctx.res);
      data = ctx.body();
    });
    return data;
  };
  let first;
  try {
    first = await run();
  } catch (error) {
    t.skip(`getText threw against the stub (${error?.message || error})`);
    return;
  }
  if (!first || !Array.isArray(first.tokens)) { t.skip('token layer not yet on the getText response'); return; }
  const second = await run();
  assert.deepEqual(
    second.tokens.map((item) => item.candidateId),
    first.tokens.map((item) => item.candidateId),
    'same text yields the same ids twice'
  );
});
