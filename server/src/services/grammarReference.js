const fs = require('fs');
const path = require('path');

const SOURCE = 'nihongo-mono';
const SOURCE_COMMIT = 'ec0ba4a0ce1611c568b0e4f8a223eb8029249a25';
const EXPECTED_TOTAL = 1031;
const EXPECTED_LEVEL_COUNTS = { N5: 119, N4: 189, N3: 248, N2: 208, N1: 267 };
const DATA_DIRECTORY = path.join(__dirname, '../../data/grammar');

function normalizeReference(raw) {
  if (!raw || typeof raw !== 'object' || !raw.slug || !raw.title || !raw.meaning || !Number.isInteger(raw.jlpt)) {
    throw new Error('Invalid Nihongo Mono grammar reference record.');
  }
  const jlptLevel = `N${raw.jlpt}`;
  if (!EXPECTED_LEVEL_COUNTS[jlptLevel] || !Array.isArray(raw.structure) || !Array.isArray(raw.pitfalls) || !Array.isArray(raw.examples)) {
    throw new Error(`Invalid Nihongo Mono grammar reference: ${raw.slug}`);
  }
  return {
    referenceKey: `${SOURCE}:${raw.slug}`,
    grammarPoint: raw.title,
    kana: typeof raw.kana === 'string' ? raw.kana : null,
    romaji: typeof raw.romaji === 'string' ? raw.romaji : null,
    meaning: raw.meaning,
    summary: typeof raw.summary === 'string' ? raw.summary : null,
    structures: raw.structure,
    pitfalls: raw.pitfalls,
    examples: raw.examples,
    jlptLevel,
    source: SOURCE,
    sourceSlug: raw.slug,
    sourceCommit: SOURCE_COMMIT
  };
}

function loadGrammarCatalog() {
  const raw = [];
  for (const level of [1, 2, 3, 4, 5]) {
    const file = path.join(DATA_DIRECTORY, `n${level}.json`);
    raw.push(...JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  const catalog = raw.map(normalizeReference);
  const keys = new Set(catalog.map((item) => item.referenceKey));
  const counts = catalog.reduce((result, item) => ({ ...result, [item.jlptLevel]: (result[item.jlptLevel] || 0) + 1 }), {});
  if (catalog.length !== EXPECTED_TOTAL || keys.size !== catalog.length || Object.keys(EXPECTED_LEVEL_COUNTS).some((level) => counts[level] !== EXPECTED_LEVEL_COUNTS[level])) {
    throw new Error('Pinned Nihongo Mono catalog validation failed.');
  }
  return catalog;
}

function searchableReferences(catalog, query, limit = 8) {
  const needle = String(query || '').normalize('NFKC').trim().toLocaleLowerCase('en');
  if (!needle) return [];
  return catalog.filter((item) => [item.grammarPoint, item.kana, item.romaji, item.meaning, item.summary]
    .filter(Boolean).some((value) => value.normalize('NFKC').toLocaleLowerCase('en').includes(needle)))
    .slice(0, Math.min(Math.max(Number(limit) || 8, 1), 20));
}

module.exports = { DATA_DIRECTORY, EXPECTED_LEVEL_COUNTS, EXPECTED_TOTAL, SOURCE, SOURCE_COMMIT, loadGrammarCatalog, normalizeReference, searchableReferences };
