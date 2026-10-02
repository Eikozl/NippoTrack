const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  EXPECTED_LEVEL_COUNTS,
  EXPECTED_TOTAL,
  loadGrammarCatalog,
  normalizeReference,
  searchableReferences
} = require('../src/services/grammarReference');

test('pinned Nihongo Mono catalog has the frozen size and level distribution', () => {
  const catalog = loadGrammarCatalog();
  assert.equal(catalog.length, EXPECTED_TOTAL);
  assert.deepEqual(Object.fromEntries(Object.entries(EXPECTED_LEVEL_COUNTS)), {
    N5: 119, N4: 189, N3: 248, N2: 208, N1: 267
  });
  assert.deepEqual(catalog.reduce((counts, item) => {
    counts[item.jlptLevel] = (counts[item.jlptLevel] || 0) + 1;
    return counts;
  }, {}), EXPECTED_LEVEL_COUNTS);
});

test('catalog records are normalized into NippoTrack-owned reference fields', () => {
  const tai = loadGrammarCatalog().find((item) => item.sourceSlug === 'tai');
  assert.ok(tai);
  assert.equal(tai.referenceKey, 'nihongo-mono:tai');
  assert.equal(tai.grammarPoint, 'たい');
  assert.equal(tai.jlptLevel, 'N5');
  assert.ok(Array.isArray(tai.structures));
  assert.ok(Array.isArray(tai.examples));
  assert.deepEqual(normalizeReference({ slug: 'x', title: 'X', meaning: 'x', jlpt: 5, structure: [], pitfalls: [], examples: [] }), {
    referenceKey: 'nihongo-mono:x', grammarPoint: 'X', kana: null, romaji: null,
    meaning: 'x', summary: null, structures: [], pitfalls: [], examples: [], jlptLevel: 'N5',
    source: 'nihongo-mono', sourceSlug: 'x', sourceCommit: 'ec0ba4a0ce1611c568b0e4f8a223eb8029249a25'
  });
});

test('English summary terms remain searchable for reference selection', () => {
  const matches = searchableReferences(loadGrammarCatalog(), 'permission');
  assert.ok(matches.length > 0);
  assert.ok(matches.some((item) => item.summary?.toLocaleLowerCase('en').includes('permission')));
});

test('runtime security verifier counts 43 application tables after migration 022', () => {
  const verifier = fs.readFileSync(path.join(__dirname, '../scripts/verify-postgres-runtime-security.js'), 'utf8');
  assert.match(verifier, /'grammar_reference'/);
  assert.match(verifier, /tables\.length !== 43/);
});
