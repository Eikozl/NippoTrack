import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANALYZER_FILTERS,
  ANALYZER_MAX_LENGTH,
  filterAnalyzerEntries,
  formatAnalyzerEntries,
  formatAnalyzerEntry,
  matchesAnalyzerFilter,
  normalizeAnalyzerJlptLevel,
  summarizeAnalyzerEntries
} from '../src/textAnalyzer.js';
import { getDiscoveryState, getImportableKanji } from '../src/vocabularyReading.js';

const rawEntry = (character, overrides = {}) => ({
  character,
  occurrences: 1,
  inUserCollection: false,
  userKanji: null,
  reference: {
    onyomi: [`${character}-on`],
    kunyomi: [`${character}-kun`],
    meanings: [`${character}-meaning`],
    jlptLevel: 'N5',
    strokeCount: 4,
    provenance: 'reference',
    contextualOnly: true
  },
  discoveryState: 'availableToAdd',
  readingSegment: null,
  readingProvenance: 'unverified',
  ...overrides
});

test('Phase 8: analyzer entries format with occurrences and no claimed segments', () => {
  const formatted = formatAnalyzerEntries([rawEntry('日', { occurrences: 2 }), rawEntry('本', { occurrences: 2 })]);
  assert.equal(formatted.length, 2);
  assert.deepEqual(formatted.map((entry) => [entry.character, entry.occurrences]), [['日', 2], ['本', 2]]);
  for (const entry of formatted) {
    assert.equal(entry.readingSegment, null);
    assert.equal(entry.unverified, true);
  }
  assert.equal(formatAnalyzerEntry(null), null);
  assert.deepEqual(formatAnalyzerEntries(null), []);
});

test('Phase 8: states reuse Phase 6 discovery semantics for Phase 7 import', () => {
  const formatted = formatAnalyzerEntries([
    rawEntry('日', { inUserCollection: true, userKanji: { meaning: 'day' }, discoveryState: 'alreadyInCollection' }),
    rawEntry('学'),
    rawEntry('校', { reference: null, discoveryState: 'noReferenceData' })
  ]);
  assert.deepEqual(formatted.map(getDiscoveryState), ['alreadyInCollection', 'availableToAdd', 'noReferenceData']);
  assert.deepEqual(getImportableKanji(formatted).map((entry) => entry.character), ['学']);
});

test('Phase 8: summary counts states and occurrences for local refresh after import', () => {
  const formatted = formatAnalyzerEntries([
    rawEntry('日', { occurrences: 2, inUserCollection: true, discoveryState: 'alreadyInCollection' }),
    rawEntry('学', { occurrences: 1 }),
    rawEntry('校', { occurrences: 3, reference: null, discoveryState: 'noReferenceData' })
  ]);
  assert.deepEqual(summarizeAnalyzerEntries(formatted), {
    uniqueKanji: 3,
    totalOccurrences: 6,
    inCollection: 1,
    availableToAdd: 1,
    noReferenceData: 1
  });
  assert.deepEqual(summarizeAnalyzerEntries([]), {
    uniqueKanji: 0,
    totalOccurrences: 0,
    inCollection: 0,
    availableToAdd: 0,
    noReferenceData: 0
  });
});

test('Phase 8: filters cover states, JLPT levels, and unclassified separately', () => {
  const formatted = formatAnalyzerEntries([
    rawEntry('日', { inUserCollection: true, discoveryState: 'alreadyInCollection' }),
    rawEntry('学'),
    rawEntry('語', { reference: { onyomi: [], kunyomi: [], meanings: [], jlptLevel: null, strokeCount: null, provenance: 'reference', contextualOnly: true }, discoveryState: 'noReferenceData' })
  ]);
  assert.equal(filterAnalyzerEntries(formatted, 'all').length, 3);
  assert.deepEqual(filterAnalyzerEntries(formatted, 'in_collection').map((entry) => entry.character), ['日']);
  assert.deepEqual(filterAnalyzerEntries(formatted, 'available').map((entry) => entry.character), ['学']);
  assert.deepEqual(filterAnalyzerEntries(formatted, 'no_reference').map((entry) => entry.character), ['語']);
  assert.deepEqual(filterAnalyzerEntries(formatted, 'N5').map((entry) => entry.character), ['日', '学']);
  assert.deepEqual(filterAnalyzerEntries(formatted, 'N4'), []);
  assert.deepEqual(filterAnalyzerEntries(formatted, 'unclassified').map((entry) => entry.character), ['語']);
  assert.equal(matchesAnalyzerFilter(null, 'all'), false);
  assert.deepEqual(filterAnalyzerEntries(null, 'all'), []);
});

test('Phase 8: JLPT normalization keeps unknown levels out of N5..N1', () => {
  assert.equal(normalizeAnalyzerJlptLevel('N5'), 'N5');
  assert.equal(normalizeAnalyzerJlptLevel(' n4 '), 'N4');
  assert.equal(normalizeAnalyzerJlptLevel(null), 'unclassified');
  assert.equal(normalizeAnalyzerJlptLevel('N0'), 'unclassified');
  assert.equal(normalizeAnalyzerJlptLevel(''), 'unclassified');
});

test('Phase 8: every documented filter value exists exactly once', () => {
  const values = ANALYZER_FILTERS.map((filter) => filter.value);
  assert.deepEqual(values, ['all', 'in_collection', 'available', 'no_reference', 'N5', 'N4', 'N3', 'N2', 'N1', 'unclassified']);
  assert.equal(ANALYZER_MAX_LENGTH, 10000);
});

test('Phase 8: markup-like analyzer data passes through untouched (render layer escapes)', () => {
  // Escaping is guaranteed by textContent at render time; the data layer
  // must neither strip nor interpret markup-looking content.
  const hostile = rawEntry('<img src=x onerror=alert(1)>', { occurrences: 5 });
  const [formatted] = formatAnalyzerEntries([hostile]);
  assert.equal(formatted.character, '<img src=x onerror=alert(1)>');
  assert.equal(formatted.occurrences, 5);
});
