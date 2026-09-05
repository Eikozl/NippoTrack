const { test } = require('node:test');
const assert = require('node:assert');
const { parseKanjidic2, mergeReferences } = require('../scripts/build-kanji-reference');
const { importKanjiReferences } = require('../src/services/kanjiReference');

const FIXTURE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<kanjidic2>
<header><file_version>4</file_version><database_version>2026-001</database_version><date_of_creation>2026-01-01</date_of_creation></header>
<character>
<literal>俺</literal>
<misc><grade>8</grade><stroke_count>10</stroke_count></misc>
<reading_meaning><rmgroup>
<reading r_type="ja_on">エン</reading>
<reading r_type="ja_kun">おれ</reading>
<reading r_type="ja_kun">われ</reading>
<reading r_type="pinyin">an3</reading>
<meaning>I</meaning>
<meaning>myself</meaning>
<meaning m_lang="fr">je</meaning>
</rmgroup></reading_meaning>
</character>
<character>
<literal>日</literal>
<misc><grade>1</grade><stroke_count>4</stroke_count><jlpt>4</jlpt></misc>
<reading_meaning><rmgroup>
<reading r_type="ja_on">ニチ</reading>
<reading r_type="ja_kun">ひ</reading>
<meaning>day</meaning>
<meaning>sun</meaning>
</rmgroup></reading_meaning>
</character>
</kanjidic2>`;

const OPENJLPT_FIXTURE = [{
  character: '日',
  jlpt_level: 'N5',
  onyomi: ['ニチ', 'ジツ'],
  kunyomi: ['ひ', '-び', 'か'],
  meanings: ['day', 'sun', 'Japan', 'counter for days'],
  stroke_count: 4,
  source_name: 'OpenJLPT',
  source_metadata: { dataset: 'OpenJLPT', source_files: ['n5.json'], openjlpt_grade: 1 }
}];

function buildFixture() {
  const kanjidic = parseKanjidic2(FIXTURE_XML);
  return mergeReferences(kanjidic, OPENJLPT_FIXTURE);
}

test('KANJIDIC2-only character is present with null jlpt_level', () => {
  const { references, report } = buildFixture();
  const ore = references.find((reference) => reference.character === '俺');
  assert.ok(ore);
  assert.equal(ore.jlpt_level, null);
  assert.deepEqual(ore.onyomi, ['エン']);
  assert.deepEqual(ore.kunyomi, ['おれ', 'われ']);
  assert.deepEqual(ore.meanings, ['I', 'myself']);
  assert.equal(ore.stroke_count, 10);
  assert.equal(report.unclassified, 1);
});

test('non-English meanings and non-Japanese readings are excluded', () => {
  const { references } = buildFixture();
  const ore = references.find((reference) => reference.character === '俺');
  assert.ok(!ore.meanings.includes('je'));
  assert.ok(!ore.onyomi.includes('an3'));
  assert.ok(!ore.kunyomi.includes('an3'));
});

test('OpenJLPT overlap takes KANJIDIC2 fields plus JLPT classification', () => {
  const { references, report } = buildFixture();
  const nichi = references.find((reference) => reference.character === '日');
  assert.equal(nichi.jlpt_level, 'N5');
  assert.deepEqual(nichi.onyomi, ['ニチ']);
  assert.deepEqual(nichi.kunyomi, ['ひ']);
  assert.deepEqual(nichi.meanings, ['day', 'sun']);
  assert.equal(nichi.stroke_count, 4);
  assert.equal(nichi.source_metadata.jlpt_source, 'OpenJLPT');
  assert.deepEqual(nichi.source_metadata.source_files, ['n5.json']);
  assert.equal(nichi.source_metadata.openjlpt_grade, 1);
  assert.equal(nichi.source_metadata.kanjidic2_database_version, '2026-001');
  assert.equal(report.classified, 1);
  assert.equal(report.openjlptMatched, 1);
  assert.deepEqual(report.openjlptOnly, []);
});

test('legacy KANJIDIC2 jlpt codes never become JLT levels', () => {
  const { references } = buildFixture();
  for (const reference of references) {
    assert.ok(reference.jlpt_level === null || ['N5', 'N4', 'N3', 'N2', 'N1'].includes(reference.jlpt_level));
  }
  const ore = references.find((reference) => reference.character === '俺');
  assert.equal(ore.jlpt_level, null);
});

test('merge output is deterministic with one record per character', () => {
  const first = buildFixture().references;
  const second = buildFixture().references;
  assert.deepEqual(first, second);
  assert.equal(first.length, new Set(first.map((reference) => reference.character)).size);
});

test('importer upserts null-jlpt rows idempotently without touching user data', async () => {
  const { references } = buildFixture();
  const queries = [];
  const client = { query: async (sql, params) => { queries.push({ sql, params }); return { rowCount: 1 }; } };
  const first = await importKanjiReferences(client, references);
  const second = await importKanjiReferences(client, references);
  assert.deepEqual(first.received, second.received);
  assert.ok(queries.every(({ sql }) => !/kanji\s+SET|user_id/i.test(sql) || /reference_id/.test(sql)));
  const upserts = queries.filter(({ sql }) => sql.includes('INSERT INTO kanji_reference'));
  assert.ok(upserts.length > 0);
  const oreParams = upserts.flatMap(({ params }) => params);
  const oreIndex = oreParams.findIndex((param) => param === '俺');
  assert.ok(oreIndex !== -1);
  assert.equal(oreParams[oreIndex + 1], null);
});
