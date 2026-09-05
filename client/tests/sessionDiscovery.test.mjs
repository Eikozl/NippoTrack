import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildKanjiImportPayload,
  formatKanjiContextEntry,
  getDiscoveryContext,
  getDiscoveryKanji,
  getDiscoveryState,
  getImportableKanji,
  summarizeImportResults
} from '../src/vocabularyReading.js';

const discoveryFixture = (characters, owned = [], references = {}) => ({
  kanjiDiscovery: {
    source: 'session_writing',
    characters,
  kanji: characters.map((character) => ({
    character,
    inUserCollection: owned.includes(character),
    userKanji: owned.includes(character)
      ? { idKanji: 1, meaning: `${character} owned`, jlptLevel: 'N5', status: 'New', onyomi: null, kunyomi: null }
      : null,
    idKanji: null,
    meaning: null,
    jlptLevel: null,
    status: null,
    userOnyomi: null,
    userKunyomi: null,
    userProvenance: 'user',
    reference: references[character]
      ? { ...references[character], provenance: 'reference', contextualOnly: true }
      : null,
    discoveryState: null,
    readingSegment: null,
    readingProvenance: 'unverified'
  })),
  notice: 'notice'
  }
});

test('Phase 6: discovery accessors are null-safe for legacy payloads', () => {
  assert.equal(getDiscoveryContext(null), null);
  assert.equal(getDiscoveryContext({}), null);
  assert.deepEqual(getDiscoveryKanji({}), []);
  assert.deepEqual(getDiscoveryKanji({ kanjiDiscovery: { source: 'session_writing' } }), []);
});

test('Phase 6: states distinguish collected / reference / unknown', () => {
  const record = discoveryFixture(
    ['今', '日', '曜'],
    ['今'],
    { 日: { onyomi: ['ニチ'], kunyomi: ['ひ'], meanings: ['day'], jlptLevel: 'N5' } }
  );
  const formatted = getDiscoveryKanji(record).map(formatKanjiContextEntry);
  const states = Object.fromEntries(formatted.map((entry) => [entry.character, getDiscoveryState(entry)]));
  assert.deepEqual(states, { 今: 'alreadyInCollection', 日: 'availableToAdd', 曜: 'noReferenceData' });
});

test('Phase 6: reference without usable meanings is not offered as available', () => {
  const record = discoveryFixture(['学'], [], { 学: { onyomi: [], kunyomi: [], meanings: [], jlptLevel: null } });
  const [entry] = getDiscoveryKanji(record).map(formatKanjiContextEntry);
  assert.equal(entry.hasReference, true);
  assert.equal(entry.importable, false);
  assert.equal(getDiscoveryState(entry), 'noReferenceData');
});

test('Phase 6: discovery entries never claim per-character readings', () => {
  const record = discoveryFixture(
    ['今', '日', '学', '校', '行'],
    ['今', '日'],
    Object.fromEntries(['今', '日', '学', '校', '行'].map((ch) => [ch, { onyomi: ['X'], kunyomi: ['y'], meanings: ['m'], jlptLevel: 'N5' }]))
  );
  for (const entry of getDiscoveryKanji(record).map(formatKanjiContextEntry)) {
    assert.equal(entry.readingSegment, null);
    assert.equal(entry.unverified, true);
  }
});

test('Phase 6: unknown and malformed entries degrade to noReferenceData', () => {
  assert.equal(getDiscoveryState(null), 'noReferenceData');
  assert.equal(getDiscoveryState({}), 'noReferenceData');
});

test('Phase 7: selection admits only reference-backed missing kanji, in order', () => {
  const record = discoveryFixture(
    ['今', '日', '学', '曜'],
    ['今'],
    {
      日: { onyomi: ['ニチ'], kunyomi: ['ひ'], meanings: ['day'], jlptLevel: 'N5' },
      学: { onyomi: ['ガク'], kunyomi: ['まな'], meanings: ['study'], jlptLevel: 'N5' }
    }
  );
  const formatted = getDiscoveryKanji(record).map(formatKanjiContextEntry);
  const selectable = getImportableKanji(formatted);
  // 今 is collected, 曜 has no reference: neither may be selected.
  assert.deepEqual(selectable.map((entry) => entry.character), ['日', '学']);
  assert.deepEqual(getImportableKanji([]), []);
  assert.deepEqual(getImportableKanji(null), []);
});

test('Phase 7: every selected entry yields a valid import payload from reference only', () => {
  // 明日/あした where only 明 has reference data: 日 is not selectable.
  const record = discoveryFixture(
    ['明', '日'],
    [],
    { 明: { onyomi: ['メイ'], kunyomi: ['あ'], meanings: ['bright'], jlptLevel: 'N4' } }
  );
  const rawByChar = new Map(getDiscoveryKanji(record).map((entry) => [entry.character, entry]));
  const formatted = getDiscoveryKanji(record).map(formatKanjiContextEntry);
  for (const entry of getImportableKanji(formatted)) {
    const payload = buildKanjiImportPayload(rawByChar.get(entry.character));
    assert.ok(payload);
    assert.equal(payload.character_kanji, entry.character);
    assert.ok(payload.meaning.length > 0, 'creation requires a meaning; never fabricated');
    // Reference inventory only — never derived from session text.
    assert.ok(!payload.onyomi.includes('あした') && !payload.kunyomi.includes('あした'));
  }
  // Collected entries can never produce a payload, even if forced.
  const collected = discoveryFixture(['今'], ['今'], {});
  const [collectedRaw] = getDiscoveryKanji(collected);
  assert.equal(buildKanjiImportPayload(collectedRaw), null);
});

test('Phase 7: import outcomes summarize into added / already / failed', () => {
  assert.deepEqual(
    summarizeImportResults([
      { character: '学', ok: true, status: 'added' },
      { character: '校', ok: true, status: 'added' },
      { character: '日', ok: true, status: 'already' },
      { character: '曜', ok: false, status: 'failed' },
      null
    ]),
    { added: 2, already: 1, failed: ['曜'] }
  );
  assert.deepEqual(summarizeImportResults([]), { added: 0, already: 0, failed: [] });
  assert.deepEqual(summarizeImportResults(null), { added: 0, already: 0, failed: [] });
});
