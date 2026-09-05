const { JLPT_LEVELS } = require('../constants');
const { ValidationError } = require('../errors/http');
const { buildSearchCandidates, classifyReferenceQuery, expandReferenceReadings } = require('../search/japaneseSearch');

const singleHanCodePoint = /^\p{Script=Han}$/u;
const IMPORT_BATCH_SIZE = 200;

function isSingleHanCodePoint(value) {
  return typeof value === 'string' && singleHanCodePoint.test(value);
}

function requireSingleHanCodePoint(value) {
  if (!isSingleHanCodePoint(value)) {
    throw new ValidationError('character must be exactly one Han Unicode code point.');
  }
  return value;
}

function publicReference(row) {
  if (!row) return null;
  return {
    referenceId: row.reference_id,
    character: row.character,
    jlptLevel: row.jlpt_level,
    onyomi: row.onyomi || [],
    kunyomi: row.kunyomi || [],
    meanings: row.meanings || [],
    strokeCount: row.stroke_count
  };
}

function runtimeDatabase() {
  return require('../config/db');
}

async function lookupKanjiReference(character, database = runtimeDatabase()) {
  requireSingleHanCodePoint(character);
  const [rows] = await database.execute(
    'SELECT id_kanji_reference AS reference_id, character, jlpt_level, onyomi, kunyomi, meanings, stroke_count FROM kanji_reference WHERE character = ?',
    [character]
  );
  return publicReference(rows[0]);
}

async function searchKanjiReferences(search, limit, database = runtimeDatabase()) {
  const candidates = buildSearchCandidates(search);
  // Intent is a routing hint only: Latin input keeps both the reading and
  // the English-meaning channels, and the relevance tiers below decide the
  // weights. JLPT level is a tie-breaker, never the primary signal.
  const intent = classifyReferenceQuery(candidates.raw, candidates);
  const { strong, weak } = expandReferenceReadings(candidates);
  // Prefix guesses only exist for Latin input (they need a romaji parse);
  // Japanese input therefore searches the weak channel never. Latin input
  // keeps both channels: strong readings rank high, weak guesses and
  // English substrings stay at substring fallback.
  const weakActive = intent.primary !== 'han' && intent.primary !== 'kana' ? weak : [];
  // Stored readings carry dictionary morphology markers ('.', '・', spaces)
  // plus hyphen affixes; strip them on the stored side to match the
  // hyphen-stripped candidate keys. Canonical rows are never rewritten.
  // Element-wise normalizer for single reading/meaning array entries.
  // (The whole-array normalizedReadings above is recall-only; prefix and
  // equality tiers must compare per element, not against the concatenation.)
  const normElement = (expression) => `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(${expression}, '.', ''), '．', ''), '・', ''), ' ', ''), '-', '')`;
  const normalizedReadings = `(${normElement("array_to_string(r.onyomi || r.kunyomi, ' ')")})`;
  const strongValues = [...new Set(strong.flatMap(({ hiragana, katakana }) => [hiragana, katakana]))];
  const weakValues = [...new Set(weakActive.flatMap(({ hiragana, katakana }) => [hiragana, katakana]))];
  const readingValues = [...new Set([...strongValues, ...weakValues])].map((value) => `%${value}%`);
  const readingWhere = readingValues.length
    ? ` OR (${readingValues.map(() => `${normalizedReadings} ILIKE ?`).join(' OR ')})`
    : '';
  const params = [`%${candidates.raw}%`, `%${candidates.raw}%`, ...readingValues];

  // Relevance tiers (lower wins): exact character, exact meaning, exact
  // stored reading, exact normalized reading, whole-word meaning, strong
  // reading prefix, meaning prefix, substring fallback. Groups that have no
  // values are omitted so the tier order never shifts.
  const tiers = [];
  tiers.push({ sql: 'WHEN r.character = ?', params: [candidates.raw] });
  tiers.push({ sql: 'WHEN EXISTS (SELECT 1 FROM UNNEST(r.meanings) AS meaning WHERE LOWER(meaning) = LOWER(?))', params: [candidates.raw] });
  if (strongValues.length) {
    tiers.push({ sql: 'WHEN EXISTS (SELECT 1 FROM UNNEST(r.onyomi || r.kunyomi) AS reading WHERE reading = ANY (?))', params: [strongValues] });
    tiers.push({ sql: `WHEN EXISTS (SELECT 1 FROM UNNEST(r.onyomi || r.kunyomi) AS reading WHERE ${normElement('reading')} = ANY (?))`, params: [strongValues] });
  }
  tiers.push({ sql: "WHEN (' ' || array_to_string(r.meanings, ' ') || ' ') ILIKE ?", params: [`% ${candidates.raw} %`] });
  if (strongValues.length) {
    tiers.push({ sql: `WHEN EXISTS (SELECT 1 FROM UNNEST(r.onyomi || r.kunyomi) AS reading WHERE ${normElement('reading')} LIKE ANY (?))`, params: [strongValues.map((value) => `${value}%`)] });
  }
  tiers.push({ sql: 'WHEN EXISTS (SELECT 1 FROM UNNEST(r.meanings) AS meaning WHERE meaning ILIKE ?)', params: [`${candidates.raw}%`] });
  const orderBy = tiers.map(({ sql }, index) => `${sql} THEN ${index}`).join(' ');
  tiers.forEach(({ params: tierParams }) => params.push(...tierParams));

  const [rows] = await database.execute(
    `SELECT r.id_kanji_reference AS reference_id, r.character, r.jlpt_level, r.onyomi, r.kunyomi, r.meanings, r.stroke_count
     FROM kanji_reference AS r
     WHERE r.character ILIKE ? OR array_to_string(r.meanings, ' ') ILIKE ?${readingWhere}
     ORDER BY CASE ${orderBy} ELSE ${tiers.length} END,
              CASE r.jlpt_level WHEN 'N5' THEN 1 WHEN 'N4' THEN 2 WHEN 'N3' THEN 3 WHEN 'N2' THEN 4 WHEN 'N1' THEN 5 ELSE 6 END,
              r.character ASC
     LIMIT ?`,
    [...params, limit]
  );
  return {
    items: rows.map(publicReference),
    transliteration: candidates.romajiComplete ? { hiragana: candidates.hiragana, katakana: candidates.katakana } : null
  };
}

async function getKanjiReferenceById(referenceId, database = runtimeDatabase()) {
  const [rows] = await database.execute(
    'SELECT id_kanji_reference AS reference_id, character, jlpt_level, onyomi, kunyomi, meanings, stroke_count FROM kanji_reference WHERE id_kanji_reference = ?',
    [referenceId]
  );
  return publicReference(rows[0]);
}

async function findKanjiReferenceId(character, database = runtimeDatabase()) {
  const [rows] = await database.execute(
    'SELECT id_kanji_reference AS reference_id FROM kanji_reference WHERE character = ?',
    [character]
  );
  return rows[0]?.reference_id ?? null;
}

function normalizeStringArray(value, fieldName) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ValidationError(`${fieldName} must be an array of strings.`);
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function normalizeSourceMetadata(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('source_metadata must be an object.');
  }
  return value;
}

function normalizeImportedReference(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('Each reference entry must be an object.');
  }
  const character = requireSingleHanCodePoint(value.character);
  const jlptLevel = value.jlpt_level === undefined || value.jlpt_level === null || value.jlpt_level === ''
    ? null
    : String(value.jlpt_level).trim().toUpperCase();
  if (jlptLevel && !JLPT_LEVELS.includes(jlptLevel)) {
    throw new ValidationError(`jlpt_level must be one of: ${JLPT_LEVELS.join(', ')}`);
  }
  const strokeCount = value.stroke_count === undefined || value.stroke_count === null || value.stroke_count === ''
    ? null
    : Number(value.stroke_count);
  if (strokeCount !== null && (!Number.isInteger(strokeCount) || strokeCount < 1 || strokeCount > 255)) {
    throw new ValidationError('stroke_count must be a positive integer no greater than 255.');
  }
  return {
    character,
    jlptLevel,
    onyomi: normalizeStringArray(value.onyomi, 'onyomi'),
    kunyomi: normalizeStringArray(value.kunyomi, 'kunyomi'),
    meanings: normalizeStringArray(value.meanings, 'meanings'),
    strokeCount,
    sourceMetadata: normalizeSourceMetadata(value.source_metadata)
  };
}

async function importKanjiReferences(client, references) {
  if (!Array.isArray(references)) throw new ValidationError('Import JSON must be an array of reference entries.');
  const normalized = references.map(normalizeImportedReference);
  const unique = [...new Map(normalized.map((reference) => [reference.character, reference])).values()];
  let upserted = 0;

  for (let start = 0; start < unique.length; start += IMPORT_BATCH_SIZE) {
    const batch = unique.slice(start, start + IMPORT_BATCH_SIZE);
    const values = batch.map((_, rowIndex) => {
      const parameter = rowIndex * 7;
      return `($${parameter + 1}, $${parameter + 2}, $${parameter + 3}, $${parameter + 4}, $${parameter + 5}, $${parameter + 6}, $${parameter + 7}::jsonb)`;
    }).join(', ');
    const parameters = batch.flatMap((reference) => [
      reference.character,
      reference.jlptLevel,
      reference.onyomi,
      reference.kunyomi,
      reference.meanings,
      reference.strokeCount,
      JSON.stringify(reference.sourceMetadata)
    ]);
    const result = await client.query(
      `INSERT INTO kanji_reference (character, jlpt_level, onyomi, kunyomi, meanings, stroke_count, source_metadata)
       VALUES ${values}
       ON CONFLICT (character) DO UPDATE
       SET jlpt_level = EXCLUDED.jlpt_level,
           onyomi = EXCLUDED.onyomi,
           kunyomi = EXCLUDED.kunyomi,
           meanings = EXCLUDED.meanings,
           stroke_count = EXCLUDED.stroke_count,
           source_metadata = EXCLUDED.source_metadata,
           updated_at = CURRENT_TIMESTAMP`,
      parameters
    );
    upserted += result.rowCount;
  }

  const backfill = await client.query(
    `UPDATE kanji AS k
     SET reference_id = r.id_kanji_reference
     FROM kanji_reference AS r
     WHERE k.character_kanji = r.character
       AND k.reference_id IS DISTINCT FROM r.id_kanji_reference`
  );

  return { received: references.length, upserted, backfilled: backfill.rowCount };
}

module.exports = {
  findKanjiReferenceId,
  getKanjiReferenceById,
  importKanjiReferences,
  isSingleHanCodePoint,
  lookupKanjiReference,
  searchKanjiReferences,
  normalizeImportedReference
};
