const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  normalizeOpenJlptFiles,
  OPENJLPT_LEVELS
} = require('../scripts/normalize-openjlpt-kanji');
const { importKanjiReferences } = require('../src/services/kanjiReference');

const han = (codePoint) => String.fromCodePoint(codePoint);

function files(overrides = {}) {
  return Object.fromEntries(OPENJLPT_LEVELS.map((level, index) => [level, overrides[level] || [{
    character: han(0x4e00 + index),
    level,
    strokes: index + 1,
    onyomi: [],
    kunyomi: [],
    meanings: [`meaning-${level}`]
  }]]));
}

test('normalizes and deterministically merges duplicate N5 OpenJLPT records', () => {
  const normalized = normalizeOpenJlptFiles(files({
    N5: [
      {
        character: '\u98df',
        level: 'N5',
        strokes: 9,
        grade: 2,
        freq: 100,
        onyomi: ['\u30b7\u30e7\u30af', '\u30b7\u30e7\u30af'],
        kunyomi: ['\u305f.\u3079\u308b'],
        meanings: ['eat', 'food', 'eat']
      },
      {
        character: '\u98df',
        level: 'N5',
        strokes: 9,
        grade: 2,
        freq: 100,
        onyomi: ['\u30b8\u30ad'],
        kunyomi: ['\u304f.\u3089\u3046'],
        meanings: ['food', 'consume']
      }
    ]
  }));

  assert.equal(normalized.references.length, 5);
  assert.deepEqual(normalized.references[0], {
    character: '\u98df',
    jlpt_level: 'N5',
    onyomi: ['\u30b7\u30e7\u30af', '\u30b8\u30ad'],
    kunyomi: ['\u305f.\u3079\u308b', '\u304f.\u3089\u3046'],
    meanings: ['eat', 'food', 'consume'],
    stroke_count: 9,
    source_name: 'OpenJLPT',
    source_metadata: {
      dataset: 'OpenJLPT',
      license: 'CC BY-SA 4.0',
      source_repository: 'https://github.com/evanclan/OpenJLPT',
      source_notice: 'https://github.com/evanclan/OpenJLPT/blob/main/NOTICE.md',
      jlpt_source: "Jonathan Waller's JLPT Resources (tanos.co.uk; CC BY)",
      kanji_dictionary_source: 'KANJIDIC2 — EDRDG (CC BY-SA 4.0)',
      jlpt_classification: 'Community/reference data; not an official JLPT syllabus.',
      source_files: ['N5.json'],
      openjlpt_grade: 2,
      openjlpt_frequency_rank: 100
    }
  });
  assert.equal(normalized.report.duplicatesMerged, 1);
  assert.deepEqual(normalized.report.acceptedByLevel, { N5: 1, N4: 1, N3: 1, N2: 1, N1: 1 });
});

test('normalizes representative records across every N5 through N1 input', () => {
  const normalized = normalizeOpenJlptFiles(files());

  assert.equal(normalized.report.acceptedRecords, 5);
  assert.deepEqual(normalized.report.acceptedByLevel, { N5: 1, N4: 1, N3: 1, N2: 1, N1: 1 });
  assert.deepEqual(normalized.references.map((reference) => reference.jlpt_level), OPENJLPT_LEVELS);
});

test('accepts missing optional OpenJLPT fields without manufacturing metadata', () => {
  const normalized = normalizeOpenJlptFiles(files({
    N3: [{ character: '\u6f22', level: 'N3' }]
  }));
  const reference = normalized.references.find((entry) => entry.character === '\u6f22');

  assert.deepEqual(reference.onyomi, []);
  assert.deepEqual(reference.kunyomi, []);
  assert.deepEqual(reference.meanings, []);
  assert.equal(reference.stroke_count, null);
  assert.deepEqual(reference.source_metadata.source_files, ['N3.json']);
  assert.equal('openjlpt_grade' in reference.source_metadata, false);
  assert.equal('openjlpt_frequency_rank' in reference.source_metadata, false);
});

test('rejects invalid records and cross-level conflicts with useful diagnostics', () => {
  const normalized = normalizeOpenJlptFiles(files({
    N5: [
      { character: '\u65e5', level: 'N5', strokes: 4 },
      { character: '\u65e5\u672c', level: 'N5', strokes: 4 }
    ],
    N4: [
      { character: '\u65e5', level: 'N4', strokes: 4 },
      { character: '\u672c', level: 'N4', strokes: 5 }
    ]
  }));

  assert.equal(normalized.references.some((entry) => entry.character === '\u65e5'), false);
  assert.equal(normalized.report.crossLevelConflicts.length, 1);
  assert.deepEqual(normalized.report.crossLevelConflicts[0], {
    character: '\u65e5',
    levels: ['N5', 'N4'],
    records: [
      { level: 'N5', file: 'N5.json', index: 0 },
      { level: 'N4', file: 'N4.json', index: 0 }
    ]
  });
  assert.equal(normalized.report.rejectedRecords.length, 3);
  assert.ok(normalized.report.rejectedRecords.some(({ reason }) => /exactly one Han Unicode code point/.test(reason)));
  assert.equal(normalized.report.rejectedRecords.filter(({ reason }) => /multiple JLPT levels/.test(reason)).length, 2);
});

test('rejects malformed optional values rather than silently changing them', () => {
  const normalized = normalizeOpenJlptFiles(files({
    N2: [{ character: '\u5b57', level: 'N2', onyomi: '\u30b8' }]
  }));

  assert.equal(normalized.references.some((entry) => entry.character === '\u5b57'), false);
  assert.equal(normalized.report.rejectedRecords.length, 1);
  assert.match(normalized.report.rejectedRecords[0].reason, /onyomi must be an array of strings/);
});

test('produces byte-for-byte deterministic canonical output for repeated input', () => {
  const input = files({
    N1: [{ character: '\u4e00', level: 'N1', meanings: ['one', 'one', 'unit'] }]
  });

  assert.equal(
    JSON.stringify(normalizeOpenJlptFiles(input)),
    JSON.stringify(normalizeOpenJlptFiles(input))
  );
});

test('CLI accepts explicit N5 through N1 JSON files and writes importable canonical JSON', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jlt-openjlpt-'));
  try {
    const input = files();
    const paths = {};
    for (const level of OPENJLPT_LEVELS) {
      paths[level] = path.join(directory, `${level.toLowerCase()}.json`);
      await fs.writeFile(paths[level], JSON.stringify(input[level]));
    }
    const output = path.join(directory, 'canonical.json');
    const result = spawnSync(process.execPath, [
      'scripts/normalize-openjlpt-kanji.js',
      '--n5', paths.N5,
      '--n4', paths.N4,
      '--n3', paths.N3,
      '--n2', paths.N2,
      '--n1', paths.N1,
      '--output', output
    ], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).acceptedRecords, 5);
    assert.equal((await JSON.parse(await fs.readFile(output, 'utf8'))).length, 5);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('canonical OpenJLPT output imports idempotently through the source-agnostic importer with provenance', async () => {
  const canonical = normalizeOpenJlptFiles(files({
    N5: [{ character: '\u65e5', level: 'N5', strokes: 4, meanings: ['day'] }]
  })).references;
  const statements = [];
  const client = {
    async query(sql, params = []) {
      statements.push({ sql, params });
      return { rowCount: 1, rows: [] };
    }
  };

  await importKanjiReferences(client, canonical);
  await importKanjiReferences(client, canonical);

  const upserts = statements.filter(({ sql }) => /INSERT INTO kanji_reference/i.test(sql));
  assert.equal(upserts.length, 2);
  assert.equal(new Set(upserts.flatMap(({ params }) => params.filter((_, index) => index % 7 === 0))).size, canonical.length);
  assert.deepEqual(JSON.parse(upserts[0].params[6]), canonical[0].source_metadata);
});
