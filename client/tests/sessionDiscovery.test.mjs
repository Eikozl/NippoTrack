import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatKanjiContextEntry,
  getDiscoveryContext,
  getDiscoveryKanji,
  getDiscoveryState
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
