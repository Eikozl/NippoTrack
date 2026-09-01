const { JLPT_LEVELS } = require('../constants');
const { ValidationError } = require('../errors/http');
const { buildSearchCandidates } = require('../search/japaneseSearch');
const { kanaSearchValues } = require('../search/sqlSearch');

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
  const readingValues = kanaSearchValues(candidates).map((value) => `%${value}%`);
  const normalizedReadings = "REPLACE(REPLACE(REPLACE(REPLACE(array_to_string(r.onyomi || r.kunyomi, ' '), '.', ''), '．', ''), '・', ''), ' ', '')";
  const readingWhere = readingValues.length
    ? ` OR (${readingValues.map(() => `${normalizedReadings} ILIKE ?`).join(' OR ')})`
    : '';
  const [rows] = await database.execute(
    `SELECT r.id_kanji_reference AS reference_id, r.character, r.jlpt_level, r.onyomi, r.kunyomi, r.meanings, r.stroke_count
     FROM kanji_reference AS r
     WHERE r.character ILIKE ? OR array_to_string(r.meanings, ' ') ILIKE ?${readingWhere}
     ORDER BY CASE WHEN r.character = ? THEN 0 ELSE 1 END,
              CASE r.jlpt_level WHEN 'N5' THEN 1 WHEN 'N4' THEN 2 WHEN 'N3' THEN 3 WHEN 'N2' THEN 4 WHEN 'N1' THEN 5 ELSE 6 END,
              r.character ASC
     LIMIT ?`,
    [`%${candidates.raw}%`, `%${candidates.raw}%`, ...readingValues, candidates.raw, limit]
  );
  return {
    items: rows.map(publicReference),
    transliteration: candidates.romajiComplete ? { hiragana: candidates.hiragana, katakana: candidates.katakana } : null
  };
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
  importKanjiReferences,
  isSingleHanCodePoint,
  lookupKanjiReference,
  searchKanjiReferences,
  normalizeImportedReference
};
