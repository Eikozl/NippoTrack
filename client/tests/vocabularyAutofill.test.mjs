// VAF-B pure contract tests: mirror composer, pick models, gates, state
// machine, fetch wrappers (injected request, no DOM, no network).
// Loads src/vocabularyAutofill.js via source-transform so Vite-only imports
// (api/ui) never execute under node:test — same pattern as reviewHub tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadVaf() {
  const src = readFileSync(join(root, 'src/vocabularyAutofill.js'), 'utf8');
  let code = src.replace(/import\s*\{[^}]+\}\s*from\s*['"][^'"]+['"];?/g, '');
  code = code.replace(/export\s+(?=const\s|let\s|var\s|function\s|async\s+function|class\s)/g, '');
  code += `\nreturn {
    VAF_DEBOUNCE_MS, VAF_MEANING_MAX_LENGTH, VAF_EXAMPLE_PREFILL_MAX_LENGTH,
    VAF_EXAMPLE_SERVER_MAX_LENGTH, VAF_PROVENANCE, VAF_STALE_MESSAGE, provenanceLabel,
    composeSenseMeaningMirror, glossCountNote, createAutofillState,
    markUserEdited, markSystemPrefilled, markSystemSuggested,
    shouldClearSystemField, planWordChange, shouldDiscardResponse,
    isStaleAutofillResult, autofillMatchStatuses, ownershipBannerModel, normalizeReadingHint,
    normalizeMeaningHint, sensePickRows, entryPickRows, countTerminalMarks,
    evaluateExampleOffer, analyzerPrefillFromContext, lookupVocabularyAutofill,
    fetchAutofillEntry
  };`;
  const factory = new Function('apiRequest', 'element', code);
  const boom = async () => { throw new Error('no network in pure tests'); };
  return factory(boom, null);
}

const vaf = loadVaf();

// ---------------------------------------------------------------- fixtures
function uniqueCompatibleItem() {
  return {
    key: 'noun::学校', canonical: '学校',
    dictionaryMatch: {
      status: 'UNIQUE', entries: [{ entryId: '1000001', kanji: ['学校'], kana: ['がっこう'] }],
      readings: { suggested: 'がっこう', alternatives: ['がっこう'], provenance: 'dictionary' }
    },
    interpretation: {
      status: 'COMPATIBLE',
      selectedSense: { entryId: '1000001', senseId: 1, glosses: ['school'], pos: ['n'] },
      compatibleSenses: [{ entryId: '1000001', senseId: 1, glosses: ['school'], pos: ['n'] }],
      remainingCount: 0
    }
  };
}

function ambiguousIkuItem() {
  return {
    key: 'verb::行く', canonical: '行く',
    dictionaryMatch: {
      status: 'UNIQUE',
      entries: [{ entryId: '1000006', kanji: ['行く'], kana: ['いく'] }],
      readings: { suggested: 'いく', alternatives: ['いく'], provenance: 'dictionary' }
    },
    interpretation: {
      status: 'AMBIGUOUS', selectedSense: null,
      compatibleSenses: [
        { entryId: '1000006', senseId: 1, glosses: ['to go'], pos: ['v5k-s'] },
        { entryId: '1000006', senseId: 2, glosses: ['to proceed'], pos: ['v5k-s'] }
      ],
      remainingCount: 0
    }
  };
}

function multipleHashiItem() {
  return {
    key: 'noun::はし', canonical: 'はし',
    dictionaryMatch: {
      status: 'MULTIPLE',
      entries: [
        { entryId: '3000001', kanji: ['橋'], kana: ['はし'], posSummary: ['n'], matchedSurfaces: ['はし'] },
        { entryId: '3000002', kanji: ['箸'], kana: ['はし'], posSummary: ['n'], matchedSurfaces: ['はし'] }
      ],
      readings: { suggested: null, alternatives: [], provenance: null }
    },
    interpretation: {
      status: 'AMBIGUOUS', selectedSense: null,
      compatibleSenses: [
        { entryId: '3000001', senseId: 1, glosses: ['bridge'], pos: ['n'] },
        { entryId: '3000002', senseId: 1, glosses: ['chopsticks'], pos: ['n'] }
      ],
      remainingCount: 0
    }
  };
}

// ---------------------------------------------------------------- composer
test('composer joins same-sense glosses with " · " within 255', () => {
  const out = vaf.composeSenseMeaningMirror(['to go', 'to proceed', 'to move']);
  assert.equal(out.value, 'to go · to proceed · to move');
  assert.deepEqual(out.glossesUsed, ['to go', 'to proceed', 'to move']);
  assert.equal(out.glossCount, 3);
  assert.equal(out.remainingCount, 0);
  assert.equal(out.fits, true);
});

test('composer greedily fits whole glosses only', () => {
  const out = vaf.composeSenseMeaningMirror(['aaaa', 'bbbb', 'cccc'], 9);
  // 'aaaa · bbbb' is 11 chars > 9, so only the first gloss fits.
  assert.equal(out.value, 'aaaa');
  assert.equal(out.glossCount, 1);
  assert.equal(out.remainingCount, 2);
  assert.equal(out.fits, false);
});

test('composer zero-fit yields blank (never a clipped gloss)', () => {
  const long = 'x'.repeat(300);
  const out = vaf.composeSenseMeaningMirror([long]);
  assert.equal(out.value, '');
  assert.equal(out.glossCount, 0);
  assert.equal(out.remainingCount, 1);
  assert.equal(out.fits, false);
});

test('composer handles empty and non-string input', () => {
  assert.deepEqual(vaf.composeSenseMeaningMirror([]), { value: '', glossesUsed: [], glossCount: 0, remainingCount: 0, fits: true });
  assert.deepEqual(vaf.composeSenseMeaningMirror(null).value, '');
  const out = vaf.composeSenseMeaningMirror(['ok', null, 42, '']);
  assert.equal(out.value, 'ok');
});

test('glossCountNote includes "+N more" only when remainingCount > 0', () => {
  assert.equal(vaf.glossCountNote({ glossCount: 2, remainingCount: 3 }), '2 glosses used · +3 more');
  assert.equal(vaf.glossCountNote({ glossCount: 1, remainingCount: 0 }), '1 gloss used');
  assert.equal(vaf.glossCountNote({}), null);
});

// ---------------------------------------------------------------- provenance
test('provenance labels are verbatim JMdict/Context/Parser/User', () => {
  assert.deepEqual(vaf.VAF_PROVENANCE, { JMDICT: 'JMdict', CONTEXT: 'Context', PARSER: 'Parser', USER: 'User' });
  assert.equal(vaf.provenanceLabel('JMdict'), 'JMdict');
  assert.equal(vaf.provenanceLabel('Context'), 'Context');
  assert.equal(vaf.provenanceLabel('Parser'), 'Parser');
  assert.equal(vaf.provenanceLabel('User'), 'User');
  assert.equal(vaf.provenanceLabel('dictionary'), 'JMdict');
  assert.equal(vaf.provenanceLabel('context'), 'Context');
  assert.equal(vaf.provenanceLabel('bogus'), null);
  assert.equal(vaf.provenanceLabel(''), null);
});

// ---------------------------------------------------------------- state machine
test('debounce constant is 300ms', () => {
  assert.equal(vaf.VAF_DEBOUNCE_MS, 300);
});

test('stale responses are discarded entirely by sequence', () => {
  assert.equal(vaf.shouldDiscardResponse(1, 2), true);
  assert.equal(vaf.shouldDiscardResponse(2, 2), false);
});

test('word-edit clears untouched system fields, never user-edited', () => {
  const state = vaf.createAutofillState('学校');
  vaf.markSystemPrefilled(state, 'reading', 'JMdict');
  vaf.markSystemSuggested(state, 'meaning', 'JMdict');
  const plan = vaf.planWordChange({ state, newWord: '行く' });
  assert.deepEqual(plan, { clearReading: true, clearMeaning: true });

  const userState = vaf.createAutofillState('学校');
  vaf.markUserEdited(userState, 'reading');
  vaf.markUserEdited(userState, 'meaning');
  assert.deepEqual(vaf.planWordChange({ state: userState, newWord: '行く' }), { clearReading: false, clearMeaning: false });
});

test('same-word edits never clear', () => {
  const state = vaf.createAutofillState('学校');
  vaf.markSystemPrefilled(state, 'reading', 'JMdict');
  assert.deepEqual(vaf.planWordChange({ state, newWord: '学校' }), { clearReading: false, clearMeaning: false });
  assert.deepEqual(vaf.planWordChange({ state, newWord: '' }), { clearReading: true, clearMeaning: false });
});

test('user edits survive: choice marks user-controlled with User provenance', () => {
  const state = vaf.createAutofillState('行く');
  vaf.markUserEdited(state, 'meaning');
  assert.equal(state.fieldStates.meaning, 'user-edited');
  assert.equal(state.provenance.meaning, 'User');
});

test('stale-snapshot detection keeps data and requires explicit refresh', () => {
  assert.equal(vaf.isStaleAutofillResult({ reason: 'snapshot-unavailable' }), true);
  assert.equal(vaf.isStaleAutofillResult({ status: 'unavailable', reason: 'snapshot-unavailable' }), true);
  assert.equal(vaf.isStaleAutofillResult({ reason: null }), false);
  assert.equal(vaf.isStaleAutofillResult({ dictionaryMatch: 'UNAVAILABLE', retryable: false }), false);
  assert.equal(vaf.isStaleAutofillResult(null), false);
});

// ---------------------------------------------------------------- nested statuses (fix 1)
test('autofillMatchStatuses reads nested backend statuses, never bare strings', () => {
  assert.deepEqual(
    vaf.autofillMatchStatuses({
      dictionaryMatch: { status: 'UNIQUE' },
      interpretation: { status: 'COMPATIBLE' }
    }),
    { dictionaryMatch: 'UNIQUE', interpretation: 'COMPATIBLE' }
  );
  assert.deepEqual(
    vaf.autofillMatchStatuses({
      dictionaryMatch: { status: 'NO_MATCH' },
      interpretation: { status: 'NOT_APPLICABLE' }
    }),
    { dictionaryMatch: 'NO_MATCH', interpretation: 'NOT_APPLICABLE' }
  );
  assert.deepEqual(
    vaf.autofillMatchStatuses({
      dictionaryMatch: { status: 'UNAVAILABLE', reason: 'reference-query-failed' },
      interpretation: { status: 'UNAVAILABLE' }
    }),
    { dictionaryMatch: 'UNAVAILABLE', interpretation: 'UNAVAILABLE' }
  );
});

test('autofillMatchStatuses degrades missing shapes to manual without crashing', () => {
  assert.deepEqual(vaf.autofillMatchStatuses(null), { dictionaryMatch: null, interpretation: null });
  assert.deepEqual(vaf.autofillMatchStatuses({}), { dictionaryMatch: null, interpretation: null });
  assert.deepEqual(
    vaf.autofillMatchStatuses({ dictionaryMatch: null, interpretation: null }),
    { dictionaryMatch: null, interpretation: null }
  );
  assert.deepEqual(
    vaf.autofillMatchStatuses({ dictionaryMatch: { status: 42 }, interpretation: {} }),
    { dictionaryMatch: null, interpretation: null }
  );
  // Legacy bare strings are NOT a backend shape: they degrade to manual.
  assert.deepEqual(
    vaf.autofillMatchStatuses({ dictionaryMatch: 'NO_MATCH', interpretation: 'UNAVAILABLE' }),
    { dictionaryMatch: null, interpretation: null }
  );
});

// ---------------------------------------------------------------- ownership
test('ownership existing banner is advisory, never blocking', () => {
  const model = vaf.ownershipBannerModel({ state: 'existing', matches: [{ word: '学校' }] });
  assert.equal(model.kind, 'existing');
  assert.match(model.text, /Already in Vocabulary/);
  assert.match(model.text, /duplicate/);
});

test('ownership possible-match lists words for verification', () => {
  const model = vaf.ownershipBannerModel({ state: 'possible-match', matches: [{ word: '橋' }, { word: '箸' }] });
  assert.equal(model.kind, 'possible-match');
  assert.match(model.text, /Possible match/);
  assert.match(model.text, /橋/);
});

test('ownership unavailable and new degrade quietly', () => {
  assert.equal(vaf.ownershipBannerModel({ state: 'unavailable' }).kind, 'unavailable');
  assert.deepEqual(vaf.ownershipBannerModel({ state: 'new' }), { kind: null, text: null });
  assert.deepEqual(vaf.ownershipBannerModel(null), { kind: null, text: null });
});

// ---------------------------------------------------------------- field hints
test('prefill reading hint normalizes with JMdict provenance', () => {
  const hint = vaf.normalizeReadingHint({ action: 'prefill', value: 'がっこう', choices: [], provenance: 'dictionary' });
  assert.equal(hint.action, 'prefill');
  assert.equal(hint.value, 'がっこう');
  assert.equal(hint.provenance, 'JMdict');
});

test('choose reading hint carries choices', () => {
  const hint = vaf.normalizeReadingHint({ action: 'choose', value: '', choices: ['いく', 'ゆく'], provenance: 'JMdict' });
  assert.deepEqual(hint.choices, ['いく', 'ゆく']);
});

test('overflow reading choices consume {reading, provenance} objects exactly', () => {
  const hint = vaf.normalizeReadingHint({
    action: 'choose',
    value: '',
    choices: [
      { reading: 'はし', provenance: 'dictionary' },
      { reading: 'ハシ', provenance: 'dictionary' },
      'いく',
      null,
      { reading: '', provenance: 'dictionary' }
    ],
    provenance: 'dictionary'
  });
  assert.equal(hint.action, 'choose');
  assert.deepEqual(hint.choices, ['はし', 'ハシ', 'いく']);
  assert.equal(hint.provenance, 'JMdict');
});

test('overflow reading prefill carries the backend value verbatim', () => {
  const hint = vaf.normalizeReadingHint({ action: 'prefill', value: 'はし', choices: [], provenance: 'dictionary' });
  assert.equal(hint.action, 'prefill');
  assert.equal(hint.value, 'はし');
  assert.equal(hint.provenance, 'JMdict');
});

test('prefill meaning hint carries counts for the gloss note', () => {
  const hint = vaf.normalizeMeaningHint({
    action: 'prefill', value: 'to go · to proceed', glossCount: 2, remainingCount: 3,
    entryId: '1000006', senseId: 1, provenance: 'JMdict', senseChoices: [], entryChoices: []
  });
  assert.equal(hint.glossCount, 2);
  assert.equal(hint.remainingCount, 3);
  assert.equal(vaf.glossCountNote(hint), '2 glosses used · +3 more');
});

test('sense rows show full composed previews', () => {
  const rows = vaf.sensePickRows([
    { entryId: '1', senseId: 1, glosses: ['to go', 'to proceed'], pos: ['v5k-s'] },
    { entryId: '1', senseId: 2, glosses: ['to pass'], pos: [] }
  ]);
  assert.equal(rows[0].label, 'to go · to proceed');
  assert.equal(rows[1].label, 'to pass');
});

test('entry rows tolerate sparse shapes without crashing', () => {
  const rows = vaf.entryPickRows([
    { entryId: '3000001', kanji: ['橋'], kana: ['はし'], glossPreview: 'bridge', pos: ['n'] },
    { entryId: '9' },
    null
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].headword, '橋');
  assert.equal(rows[0].glossPreview, 'bridge');
  assert.equal(rows[1].headword, 'Dictionary entry');
});

test('manual fallback: blank hints degrade without certainty', () => {
  assert.deepEqual(vaf.normalizeReadingHint(null).action, 'blank');
  assert.deepEqual(vaf.normalizeMeaningHint({ action: 'bogus' }).action, 'blank');
});

test('canonical MULTIPLE hint passes entryChoices through untouched', () => {
  const entryChoices = [
    { entryId: '3000001', kanji: ['橋'], kana: ['はし'], glossPreview: 'bridge', pos: ['n'] },
    { entryId: '3000002', kanji: ['箸'], kana: ['はし'], glossPreview: 'chopsticks', pos: ['n'] }
  ];
  const hint = vaf.normalizeMeaningHint({
    action: 'choose-entry-then-sense', value: '', glossCount: 0, remainingCount: 0,
    entryId: null, senseId: null, provenance: null, senseChoices: null, entryChoices
  });
  assert.equal(hint.action, 'choose-entry-then-sense');
  assert.deepEqual(hint.entryChoices, entryChoices);
});

// ---------------------------------------------------------------- fetch wrappers
test('lookup wrapper trims, sends includeOwnership, forwards signal', async () => {
  const calls = [];
  const fake = async (path, opts) => { calls.push({ path, opts }); return { word: '学校' }; };
  const out = await vaf.lookupVocabularyAutofill('  学校 ', { request: fake, signal: 'SIG' });
  assert.equal(out.word, '学校');
  assert.equal(calls[0].path, '/api/vocabulary/autofill');
  assert.equal(calls[0].opts.body.word, '学校');
  assert.equal(calls[0].opts.body.includeOwnership, true);
  assert.equal(calls[0].opts.signal, 'SIG');
  assert.equal(await vaf.lookupVocabularyAutofill('   ', { request: fake }), null);
});

test('entry fetch requires ids and forwards senseCursor', async () => {
  const calls = [];
  const fake = async (path, opts) => { calls.push({ path, opts }); return { status: 'ok' }; };
  await vaf.fetchAutofillEntry({ sourceId: 's1', entryId: 'e1', senseCursor: 'c' }, { request: fake });
  assert.equal(calls[0].path, '/api/vocabulary/autofill/entry');
  assert.deepEqual(calls[0].opts.body, { sourceId: 's1', entryId: 'e1', senseCursor: 'c' });
  await assert.rejects(vaf.fetchAutofillEntry({ sourceId: null, entryId: 'e' }, { request: fake }), /sourceId/);
});

// ---------------------------------------------------------------- analyzer seed
test('analyzer seeds 行った surface to 行く lemma word', () => {
  const candidate = { canonical: '行く', lemma: '行く', lemmaReading: 'いく', pos: 'verb', observed: [{ surface: '行った' }] };
  const prefill = vaf.analyzerPrefillFromContext(candidate, uniqueCompatibleItem());
  assert.equal(prefill.word, '行く');
});

test('analyzer compatible meaning composes full glosses (not primary-only)', () => {
  const candidate = { canonical: '学校', lemma: '学校', lemmaReading: 'がっこう', pos: 'noun', observed: [] };
  const item = uniqueCompatibleItem();
  item.interpretation.selectedSense.glosses = ['school', 'schoolhouse', 'academy'];
  const prefill = vaf.analyzerPrefillFromContext(candidate, item);
  assert.equal(prefill.meaning, 'school · schoolhouse · academy');
  assert.equal(prefill.reading, 'がっこう');
});

test('analyzer ambiguous keeps meaning blank with explicit composed choices', () => {
  const candidate = { canonical: '行く', lemma: '行く', lemmaReading: 'いく', pos: 'verb', observed: [] };
  const prefill = vaf.analyzerPrefillFromContext(candidate, ambiguousIkuItem());
  assert.equal(prefill.meaning, '');
  assert.equal(prefill.requiresChoice, true);
  assert.deepEqual(prefill.meaningChoices.map((c) => c.label), ['to go', 'to proceed']);
  assert.equal(prefill.reading, 'いく');
});

test('analyzer multiple yields entry picker with no authoritative reading', () => {
  const candidate = { canonical: 'はし', lemma: 'はし', lemmaReading: null, pos: 'noun', observed: [] };
  const prefill = vaf.analyzerPrefillFromContext(candidate, multipleHashiItem());
  assert.equal(prefill.meaning, '');
  assert.equal(prefill.reading, '');
  assert.equal(prefill.entryRows.length, 2);
  assert.equal(prefill.entryRows[0].headword, '橋');
  assert.equal(prefill.entryRows[0].glossPreview, 'bridge');
});

test('analyzer proper-noun stays Needs-verification with no rescue', () => {
  const candidate = { canonical: '田中', lemma: '田中', lemmaReading: 'たなか', pos: 'proper-noun', observed: [] };
  const prefill = vaf.analyzerPrefillFromContext(candidate, uniqueCompatibleItem());
  assert.equal(prefill.reading, '');
  assert.equal(prefill.meaning, '');
  assert.deepEqual(prefill.meaningChoices, []);
  assert.deepEqual(prefill.entryRows, []);
});

test('analyzer remainingCount drives "+N more" without inventing N', () => {
  const candidate = { canonical: '��O�??', lemma: '��O�??', lemmaReading: '�?"�??', pos: 'verb', observed: [] };
  const item = ambiguousIkuItem();
  item.interpretation.remainingCount = 4;
  const prefill = vaf.analyzerPrefillFromContext(candidate, item);
  assert.equal(prefill.moreMeanings, true);
  const capped = vaf.analyzerPrefillFromContext(candidate, ambiguousIkuItem());
  assert.equal(capped.moreMeanings, false);
});

// Pin fallback: the server's context diet never emits per-item pins; the
// block-level dictionary (same pinned snapshot) must anchor entry expansion,
// otherwise the MULTIPLE picker hits "This entry cannot be expanded." with
// valid rows on screen (real JMdict: 学生 → MULTIPLE がくせい/がくしょう).
test('analyzer expansion pin falls back to the context block dictionary snapshot', () => {
  const candidate = { canonical: '�?��?-', lemma: '�?��?-', lemmaReading: null, pos: 'noun', observed: [] };
  const item = multipleHashiItem(); // no per-item pin, as the server emits
  assert.equal('pin' in item, false, 'fixture proves server ships no per-item pin');
  const withoutFallback = vaf.analyzerPrefillFromContext(candidate, item);
  assert.equal(withoutFallback.pin, null, 'no fabrication when no pin exists anywhere');
  const blockDictionary = { source: 'JMdict', version: '3.6.2', fileDate: '2026-08-31', converter: 'jmdict-simplified', sourceId: '1' };
  const blockPin = {
    sourceId: String(blockDictionary.sourceId),
    sourceName: blockDictionary.source,
    converter: blockDictionary.converter,
    converterVersion: blockDictionary.version,
    fileDate: blockDictionary.fileDate
  };
  const withFallback = vaf.analyzerPrefillFromContext(candidate, item, blockPin);
  assert.deepEqual(withFallback.pin, blockPin, 'block snapshot anchors the expansion');
  assert.equal(withFallback.entryRows.length, 2);
  assert.ok(withFallback.entryRows.every((row) => row.entryId != null), 'rows stay expandable via entry ids');
  assert.ok(!String(withFallback.pin.sourceId).trim() === false, 'sourceId present for the expand call');
});

test('analyzer expansion pin prefers an item-level pin over the fallback', () => {
  const candidate = { canonical: '�?��?-', lemma: '�?��?-', lemmaReading: null, pos: 'noun', observed: [] };
  const item = multipleHashiItem();
  item.pin = { sourceId: 'item-pin', sourceName: 'JMdict' };
  const prefill = vaf.analyzerPrefillFromContext(candidate, item, { sourceId: 'block-pin' });
  assert.equal(prefill.pin.sourceId, 'item-pin', 'item pin wins when the item carries one');
});

// ---------------------------------------------------------------- example gate
test('example prefills only for short single-statement observed sources', () => {
  const single = vaf.evaluateExampleOffer({ sourceText: '学校に行く。', observedSurface: '学校' });
  assert.equal(single.action, 'prefill');
  assert.equal(single.provenance, 'Context');
  assert.equal(single.value, '学校に行く。');
});

test('example multi-statement sources offer instead of inserting', () => {
  const multi = vaf.evaluateExampleOffer({ sourceText: '学校に行く。友達に会う。', observedSurface: '学校' });
  assert.equal(multi.action, 'offer');
});

test('example missing surface never prefills', () => {
  const missing = vaf.evaluateExampleOffer({ sourceText: '学校に行く。', observedSurface: '図書館' });
  assert.equal(missing.action, 'offer');
});

test('example long sources offer; over-server-max disables with explanation', () => {
  const long = vaf.evaluateExampleOffer({ sourceText: 'あ'.repeat(300), observedSurface: 'あ' });
  assert.equal(long.action, 'offer');
  const over = vaf.evaluateExampleOffer({ sourceText: 'あ'.repeat(2001), observedSurface: 'あ' });
  assert.equal(over.action, 'disabled');
  assert.match(over.reason, /2000/);
  assert.equal(vaf.evaluateExampleOffer({ sourceText: '  ', observedSurface: 'x' }).action, 'none');
});
