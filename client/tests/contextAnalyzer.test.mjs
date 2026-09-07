// CA-B3 — client context presentation mapper tests.
// Pure module, no DOM, no server — assertion logic over backend-shaped fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTEXT_EVIDENCE_COPY,
  addSuggestion,
  attributionModel,
  contextBlockModel,
  contextItemModel,
  evidenceLines,
  excludedSummary,
  multipleEntryRows,
  senseChoices,
  truncationNotes
} from '../src/contextAnalyzer.js';

function baseItem(overrides = {}) {
  return {
    key: 'noun::学校',
    canonical: '学校',
    dictionaryMatch: {
      status: 'UNIQUE',
      identityStrategy: 'ORTHOGRAPHIC',
      lookupTruncated: false,
      entries: [{
        entryId: '1000001', kanji: ['学校'], kana: ['がっこう'], posSummary: ['n'],
        isCommon: true, matchedSurfaces: ['学校'], kanjiCount: 1, kanaCount: 1
      }],
      entryCount: 1,
      selectedEntryId: '1000001',
      readings: { suggested: 'がっこう', alternatives: ['がっこう'], provenance: 'dictionary' },
      reason: 'single-compatible-entry'
    },
    interpretation: {
      status: 'COMPATIBLE',
      evaluationTruncated: false,
      selectedSense: { entryId: '1000001', senseId: 1, glosses: ['school'], glossCount: 1, pos: ['n'] },
      compatibleSenses: [{ entryId: '1000001', senseId: 1, glosses: ['school'], glossCount: 1, pos: ['n'] }],
      remainingCount: 0,
      evidenceSummary: { codes: ['LEMMA_EXACT', 'ORTHOGRAPHIC_EXACT', 'POS_EXACT'], excludedBy: {} },
      reason: 'single-compatible-sense'
    },
    ...overrides
  };
}

function ambiguousIku() {
  const item = baseItem({
    key: 'verb::行く',
    canonical: '行く',
    dictionaryMatch: {
      status: 'UNIQUE',
      identityStrategy: 'ORTHOGRAPHIC',
      lookupTruncated: false,
      entries: [{ entryId: '1000006', kanji: ['行く'], kana: ['いく'], posSummary: ['v5k-s'], isCommon: true, matchedSurfaces: ['行く'], kanjiCount: 1, kanaCount: 1 }],
      entryCount: 1,
      selectedEntryId: '1000006',
      readings: { suggested: 'いく', alternatives: ['いく'], provenance: 'dictionary' },
      reason: 'single-compatible-entry'
    }
  });
  item.interpretation = {
    status: 'AMBIGUOUS',
    evaluationTruncated: false,
    selectedSense: null,
    compatibleSenses: [
      { entryId: '1000006', senseId: 1, glosses: ['to go'], glossCount: 1, pos: ['v5k-s'] },
      { entryId: '1000006', senseId: 2, glosses: ['to proceed'], glossCount: 1, pos: ['v5k-s'] }
    ],
    remainingCount: 0,
    evidenceSummary: { codes: ['LEMMA_EXACT'], excludedBy: {} },
    reason: 'multiple-compatible-senses'
  };
  return item;
}

function multipleHashi() {
  const item = baseItem({ key: 'noun::はし', canonical: 'はし' });
  item.dictionaryMatch = {
    status: 'MULTIPLE',
    identityStrategy: 'READING_FALLBACK',
    lookupTruncated: false,
    entries: [
      { entryId: '3000001', kanji: ['橋'], kana: ['はし'], posSummary: ['n'], isCommon: true, matchedSurfaces: ['はし'], kanjiCount: 1, kanaCount: 1 },
      { entryId: '3000002', kanji: ['箸'], kana: ['はし'], posSummary: ['n'], isCommon: false, matchedSurfaces: ['はし'], kanjiCount: 1, kanaCount: 1 },
      { entryId: '3000003', kanji: ['端'], kana: ['はし'], posSummary: ['n'], isCommon: false, matchedSurfaces: ['はし'], kanjiCount: 1, kanaCount: 1 }
    ],
    entryCount: 3,
    selectedEntryId: null,
    readings: { suggested: null, alternatives: [], provenance: null },
    reason: 'multiple-compatible-entries'
  };
  item.interpretation = {
    status: 'AMBIGUOUS',
    evaluationTruncated: false,
    selectedSense: null,
    compatibleSenses: [
      { entryId: '3000001', senseId: 1, glosses: ['bridge'], glossCount: 1, pos: ['n'] },
      { entryId: '3000002', senseId: 1, glosses: ['chopsticks'], glossCount: 1, pos: ['n'] },
      { entryId: '3000003', senseId: 1, glosses: ['edge'], glossCount: 1, pos: ['n'] }
    ],
    remainingCount: 0,
    evidenceSummary: { codes: [], excludedBy: {} },
    reason: 'multiple-compatible-entries'
  };
  return item;
}

test('UNIQUE + COMPATIBLE maps to the Compatible meaning display state', () => {
  const model = contextItemModel(baseItem());
  assert.equal(model.kind, 'compatible');
  assert.equal(model.heading, 'Compatible meaning');
  assert.equal(model.meaning, 'school');
  assert.equal(model.readings.suggested, 'がっこう');
  assert.equal(model.readings.provenance, 'dictionary');
  assert.deepEqual(model.evidence, ['Dictionary form matches', 'Spelling matches', 'Part of speech matches']);
});

test('multi-gloss single sense joins compactly without inventing ambiguity', () => {
  const item = baseItem();
  item.interpretation.selectedSense.glosses = ['to begin', 'to start'];
  const model = contextItemModel(item);
  assert.equal(model.kind, 'compatible');
  assert.equal(model.meaning, 'to begin · to start');
});

test('UNIQUE + AMBIGUOUS keeps reading, lists choices, selects nothing', () => {
  const model = contextItemModel(ambiguousIku());
  assert.equal(model.kind, 'ambiguous-unique');
  assert.equal(model.heading, 'Possible meanings');
  assert.ok(model.subheading.length > 0);
  assert.equal(model.readings.suggested, 'いく');
  assert.deepEqual(model.choices.map((choice) => choice.label), ['to go', 'to proceed']);
  assert.ok(!('meaning' in model) || model.meaning === undefined);
});

test('MULTIPLE maps to entry rows with no authoritative reading', () => {
  const model = contextItemModel(multipleHashi());
  assert.equal(model.kind, 'multiple');
  assert.equal(model.heading, 'Multiple dictionary matches');
  assert.deepEqual(model.rows.map((row) => `${row.headword} — ${row.gloss}`), ['橋 — bridge', '箸 — chopsticks', '端 — edge']);
  const suggestion = addSuggestion(multipleHashi());
  assert.equal(suggestion.reading, null);
  assert.equal(suggestion.meaning, null);
  assert.deepEqual(suggestion.meaningChoices, []);
});

test('NO_MATCH / UNAVAILABLE / UNSUPPORTED degrade quietly', () => {
  const noMatch = contextItemModel(baseItem({ dictionaryMatch: { status: 'NO_MATCH' } }));
  assert.equal(noMatch.kind, 'no-match');
  assert.match(noMatch.notice, /No reliable dictionary match/);
  const unavailable = contextItemModel(baseItem({ dictionaryMatch: { status: 'UNAVAILABLE' } }));
  assert.equal(unavailable.kind, 'unavailable');
  const unsupported = contextItemModel(baseItem({ dictionaryMatch: { status: 'UNSUPPORTED' } }));
  assert.equal(unsupported.kind, 'unsupported');
  assert.equal(contextItemModel(null).kind, 'pending');
  assert.equal(contextItemModel({ dictionaryMatch: { status: 'SOMETHING_NEW' } }).kind, 'no-match');
});

test('addSuggestion matrix: only UNIQUE yields context-derived reading/meaning', () => {
  const compatible = addSuggestion(baseItem());
  assert.equal(compatible.reading, 'がっこう');
  assert.equal(compatible.readingProvenance, 'dictionary');
  assert.equal(compatible.meaning, 'school');
  assert.equal(compatible.requiresChoice, false);
  const ambiguous = addSuggestion(ambiguousIku());
  assert.equal(ambiguous.reading, 'いく');
  assert.equal(ambiguous.meaning, null);
  assert.equal(ambiguous.requiresChoice, true);
  assert.deepEqual(ambiguous.meaningChoices.map((choice) => choice.primaryGloss), ['to go', 'to proceed']);
  assert.equal(ambiguous.moreMeanings, false);
  for (const status of ['MULTIPLE', 'NO_MATCH', 'UNSUPPORTED', 'UNAVAILABLE']) {
    const suggestion = addSuggestion(baseItem({ dictionaryMatch: { status } }));
    assert.equal(suggestion.reading, null, status);
    assert.equal(suggestion.meaning, null, status);
    assert.equal(suggestion.requiresChoice, false, status);
  }
});

test('addSuggestion withholds reading when the dictionary suggests none', () => {
  const item = ambiguousIku();
  item.dictionaryMatch.readings = { suggested: null, alternatives: ['いく', 'ゆく'], provenance: null };
  const suggestion = addSuggestion(item);
  assert.equal(suggestion.reading, null);
  assert.equal(suggestion.readingProvenance, null);
});

test('senseChoices cap display and remainingCount drives the more-meanings note', () => {
  const item = ambiguousIku();
  item.interpretation.remainingCount = 4;
  assert.deepEqual(senseChoices(item).length, 2);
  const model = contextItemModel(item);
  assert.equal(model.moreMeanings, true);
  assert.deepEqual(truncationNotes(item), ['More meanings exist.']);
});

test('evidence mapping never leaks raw codes', () => {
  assert.deepEqual(evidenceLines({ codes: ['LEMMA_EXACT', 'POS_EXACT'] }), ['Dictionary form matches', 'Part of speech matches']);
  assert.deepEqual(evidenceLines({ codes: ['BOGUS_CODE', 'POS_BROAD'] }), ['Part of speech is compatible']);
  assert.deepEqual(evidenceLines(null), []);
  const rendered = JSON.stringify({ ...CONTEXT_EVIDENCE_COPY });
  assert.ok(!rendered.includes('STAGK') && !rendered.includes('Q1') && !rendered.includes('LIKELY'));
  assert.equal(excludedSummary({ STAGK_INCOMPATIBLE: 3 }), 'Some dictionary meanings were excluded because they do not match this spelling.');
  assert.equal(
    excludedSummary({ STAGR_INCOMPATIBLE: 1, POS_INCOMPATIBLE: 2 }),
    'Some dictionary meanings were excluded because they do not match this reading or part of speech.'
  );
  assert.equal(excludedSummary({}), null);
  assert.equal(excludedSummary(null), null);
});

test('truncation notes use user copy, never implementation caps', () => {
  const item = multipleHashi();
  item.dictionaryMatch.lookupTruncated = true;
  item.interpretation.evaluationTruncated = true;
  const notes = truncationNotes(item);
  assert.ok(notes.includes('More dictionary matches exist.'));
  assert.ok(notes.some((note) => note.includes('not every dictionary possibility could be evaluated')));
  assert.ok(!JSON.stringify(notes).match(/5\+1|64\+1|150|100 ?KB/));
});

test('contextBlockModel offers retry only for transient failures', () => {
  assert.deepEqual(contextBlockModel(null), { state: 'pending', retryable: false, notice: null });
  assert.deepEqual(contextBlockModel({ status: 'ok' }), { state: 'ok', retryable: false, notice: null });
  assert.equal(contextBlockModel({ status: 'unavailable', reason: 'reference-query-failed', retryable: true }).retryable, true);
  const absent = contextBlockModel({ status: 'unavailable', reason: 'version-absent', retryable: false });
  assert.equal(absent.retryable, false);
  assert.match(absent.notice, /isn't available in this environment yet/);
  const truncated = contextBlockModel({ status: 'partial', reason: 'lookup-truncated', retryable: false });
  assert.equal(truncated.retryable, false);
  const lexical = contextBlockModel({ status: 'unavailable', reason: 'lexical-required', retryable: false });
  assert.equal(lexical.state, 'pending');
});

test('attribution model carries the canonical acknowledgement, never sourceId', () => {
  const model = attributionModel({ source: 'JMdict', converter: 'x', version: '3.6.2', fileDate: '2026-08-31', sourceId: '7' });
  assert.equal(model.text, 'Dictionary data: JMdict © EDRDG (CC BY-SA 4.0)');
  assert.match(model.detail, /3\.6\.2/);
  assert.match(model.detail, /2026-08-31/);
  assert.ok(!JSON.stringify(model).includes('sourceId') || !JSON.stringify(model).includes('"sourceId":"7"'));
  assert.equal(attributionModel(null), null);
  assert.equal(attributionModel({}), null);
});

test('multipleEntryRows prefers kanji headwords and tolerates sparse entries', () => {
  const rows = multipleEntryRows(multipleHashi());
  assert.equal(rows.length, 3);
  assert.equal(rows[0].headword, '橋');
  const sparse = multipleEntryRows({ dictionaryMatch: { entries: [{ entryId: '9' }] }, interpretation: { compatibleSenses: [] } });
  assert.equal(sparse[0].headword, 'Dictionary entry');
  assert.equal(sparse[0].gloss, '');
});
