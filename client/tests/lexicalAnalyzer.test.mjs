// Phase 12-B — client lexical analyzer view helpers test.
// Pure module, no DOM, no server, no async — just assertion logic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lexicalPosLabel,
  lexicalMatchPill,
  formatLexicalCandidate,
  groupLexicalCandidates,
  buildVocabularyImportPayload
} from '../src/lexicalAnalyzer.js';

function baseCandidate(overrides = {}) {
  return {
    key: 'test',
    canonical: '行く',
    lemma: '行く',
    lemmaReading: 'いく',
    surfaceReading: null,
    pos: 'verb',
    occurrences: 1,
    observed: [],
    match: { state: 'new', ownedCount: 0, possibleMatches: [] },
    ...overrides
  };
}

test('lexicalPosLabel maps coarse POS to human labels', () => {
  assert.equal(lexicalPosLabel('noun'), 'noun');
  assert.equal(lexicalPosLabel('verb'), 'verb');
  assert.equal(lexicalPosLabel('i-adjective'), 'adjective');
  assert.equal(lexicalPosLabel('na-adjective'), 'adjective');
  assert.equal(lexicalPosLabel('adverb'), 'adverb');
  assert.equal(lexicalPosLabel('interjection'), 'interjection');
  assert.equal(lexicalPosLabel('unknown'), 'word');
});

test('lexicalMatchPill maps match states to pill text', () => {
  assert.equal(lexicalMatchPill('existing'), 'Already in Vocabulary');
  assert.equal(lexicalMatchPill('new'), 'New');
  assert.equal(lexicalMatchPill('ambiguous'), 'Needs verification');
  assert.equal(lexicalMatchPill('unavailable'), 'Ownership unknown');
  assert.equal(lexicalMatchPill('unsupported'), 'Needs verification');
  assert.equal(lexicalMatchPill('unknown'), 'Needs verification');
});

test('formatLexicalCandidate produces view model with add button for new items', () => {
  const c = baseCandidate({ match: { state: 'new' } });
  const view = formatLexicalCandidate(c);
  assert.equal(view.matchState, 'new');
  assert.equal(view.showAdd, true);
  assert.equal(view.addLabel, 'Add to Vocabulary');
  assert.equal(view.pill, 'New');
});

test('formatLexicalCandidate shows add label with canonical when observed differs', () => {
  const c = baseCandidate({
    canonical: '行く',
    lemma: '行く',
    observed: [{ surface: '行った', surfaceReading: 'いった', occurrences: 1, firstStart: 4 }],
    match: { state: 'new' }
  });
  const view = formatLexicalCandidate(c);
  assert.equal(view.showAdd, true);
  assert.equal(view.addLabel, 'Add 行く');
});

test('formatLexicalCandidate shows "Add to Vocabulary" when observed equals canonical', () => {
  const c = baseCandidate({
    canonical: '学校',
    lemma: '学校',
    observed: [{ surface: '学校', surfaceReading: 'がっこう', occurrences: 1, firstStart: 0 }],
    match: { state: 'new' }
  });
  const view = formatLexicalCandidate(c);
  assert.equal(view.showAdd, true);
  assert.equal(view.addLabel, 'Add to Vocabulary');
});

test('formatLexicalCandidate hides add button for existing/ambiguous/unavailable', () => {
  for (const state of ['existing', 'ambiguous', 'unavailable', 'unsupported']) {
    const c = baseCandidate({ match: { state } });
    const view = formatLexicalCandidate(c);
    assert.equal(view.showAdd, false, `expected showAdd=false for ${state}`);
  }
});

test('groupLexicalCandidates splits candidates by state + adds local adds', () => {
  const candidates = [
    baseCandidate({ canonical: '行く', match: { state: 'existing' } }),
    baseCandidate({ canonical: '食べる', match: { state: 'new' } }),
    baseCandidate({ canonical: '寝る', match: { state: 'ambiguous' } }),
    baseCandidate({ canonical: '書く', match: { state: 'unsupported' } })
  ];
  const groups = groupLexicalCandidates({ candidates, unverified: [] }, new Set(['食べる']));
  assert.equal(groups.existing.length, 2); // 行く + 食べる (local added)
  assert.equal(groups.fresh.length, 0); // 食べる moved to existing
  assert.equal(groups.verify.length, 2); // 寝る + 書く
});

test('groupLexicalCandidates appends unverified as verify entries', () => {
  const groups = groupLexicalCandidates(
    { candidates: [], unverified: [{ key: 'x', canonical: '田中', occurrences: 1, pos: 'proper-noun', match: { state: 'unsupported', ownedCount: 0, possibleMatches: [] } }] },
    new Set()
  );
  assert.equal(groups.verify.length, 1);
  assert.equal(groups.verify[0].matchState, 'unsupported');
  assert.equal(groups.verify[0].showAdd, false);
});

test('buildVocabularyImportPayload uses lemmaReading only for the lemma word', () => {
  const c = {
    canonical: '行った',
    lemma: '行く',
    lemmaReading: 'いく',
    surfaceReading: 'いった'
  };
  const payload = buildVocabularyImportPayload(c, { meaning: 'to go' });
  assert.deepEqual(payload, { word: '行く', reading: 'いく', meaning: 'to go' });
});

test('buildVocabularyImportPayload does not use surfaceReading for lemma', () => {
  const c = {
    canonical: '行った',
    lemma: '行く',
    lemmaReading: null,
    surfaceReading: 'いった'
  };
  const payload = buildVocabularyImportPayload(c, { meaning: 'to go' });
  assert.equal(payload.reading, '');
  assert.equal(payload.word, '行く');
});

test('buildVocabularyImportPayload allows caller overrides for word/reading', () => {
  const c = { canonical: '行った', lemma: '行く', lemmaReading: 'いく', surfaceReading: 'いった' };
  const payload = buildVocabularyImportPayload(c, { meaning: 'to go', word: '行く', reading: 'ユーザー指定' });
  assert.equal(payload.reading, 'ユーザー指定');
  assert.equal(payload.word, '行く');
});

test('buildVocabularyImportPayload returns null without meaning', () => {
  const c = baseCandidate({ canonical: '行く' });
  assert.equal(buildVocabularyImportPayload(c, { meaning: '' }), null);
  assert.equal(buildVocabularyImportPayload(c, { meaning: '   ' }), null);
  assert.equal(buildVocabularyImportPayload(c), null);
});

test('buildVocabularyImportPayload returns null for empty candidate', () => {
  assert.equal(buildVocabularyImportPayload(null, { meaning: 'x' }), null);
  assert.equal(buildVocabularyImportPayload({ canonical: '' }, { meaning: 'x' }), null);
});