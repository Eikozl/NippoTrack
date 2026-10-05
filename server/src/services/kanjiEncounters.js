const { extractUniqueKanji } = require('./kanjiVocabularyLinks');

const ENCOUNTER_SOURCE_TYPES = Object.freeze({
  VOCABULARY: 'vocabulary',
  SESSION_WRITING: 'session_writing',
  // V5.3a immersion sessions; allowed by migration 021's widened
  // chk_kanji_encounters_source_type CHECK.
  IMMERSION_SESSION: 'immersion_session'
});

function encounterDedupeKey(source, kanjiId) {
  return `v1:${source.type}:${source.sourceId}:${kanjiId}`;
}

function validateSource(source) {
  if (!Object.values(ENCOUNTER_SOURCE_TYPES).includes(source?.type)) throw new Error('Unsupported kanji encounter source.');
  if (!Number.isInteger(source.sourceId) || source.sourceId <= 0) throw new Error('Kanji encounter source id must be a positive integer.');
}

async function recordKanjiEncounters(executor, userId, text, source) {
  validateSource(source);
  const characters = extractUniqueKanji(text);
  if (!characters.length) return [];

  const [ownedKanji] = await executor.execute(
    'SELECT id_kanji, character_kanji FROM kanji WHERE user_id = ? AND character_kanji = ANY(?) ORDER BY id_kanji',
    [userId, characters]
  );
  if (!ownedKanji.length) return [];

  const valuesSql = ownedKanji.map(() => '(?, ?, ?, ?, ?)').join(', ');
  const values = ownedKanji.flatMap((kanji) => [
    userId,
    kanji.id_kanji,
    source.type,
    source.sourceId,
    encounterDedupeKey(source, kanji.id_kanji)
  ]);
  await executor.execute(
    `INSERT INTO kanji_encounters (user_id, id_kanji, source_type, source_id, dedupe_key)
     VALUES ${valuesSql}
     ON CONFLICT (user_id, dedupe_key) DO NOTHING`,
    values
  );

  return ownedKanji.map((kanji) => ({ idKanji: kanji.id_kanji, character: kanji.character_kanji }));
}

async function getKanjiEncounterSummary(executor, userId, kanjiId) {
  const [rows] = await executor.execute(
    `WITH scoped AS (
      SELECT id_kanji_encounter, source_type, source_id, encountered_at
      FROM kanji_encounters WHERE user_id = ? AND id_kanji = ?
    ),
    summary AS (
      SELECT COUNT(*) AS count, MIN(encountered_at) AS first_encountered_at, MAX(encountered_at) AS last_encountered_at FROM scoped
    ),
    by_source AS (
      SELECT source_type, COUNT(*) AS count FROM scoped GROUP BY source_type ORDER BY source_type
    ),
    recent AS (
      SELECT s.id_kanji_encounter, s.source_type, s.source_id, s.encountered_at,
              CASE
                WHEN s.source_type = 'vocabulary' THEN v.word
                WHEN s.source_type = 'session_writing' THEN COALESCE(sw.title, 'Session writing')
                WHEN s.source_type = 'immersion_session' THEN 'Immersion session'
                ELSE NULL
              END AS source_title
      FROM scoped s
      LEFT JOIN vocabulary v ON s.source_type = 'vocabulary' AND v.id_vocabulary = s.source_id AND v.user_id = ?
      LEFT JOIN study_sessions ss ON s.source_type = 'session_writing' AND ss.id_session = s.source_id AND ss.user_id = ?
      LEFT JOIN session_writings sw ON s.source_type = 'session_writing' AND sw.id_session = ss.id_session
      ORDER BY s.encountered_at DESC, s.id_kanji_encounter DESC
      LIMIT 5
    )
    SELECT (SELECT row_to_json(summary) FROM summary) AS summary,
           (SELECT COALESCE(json_agg(row_to_json(by_source)), '[]') FROM by_source) AS by_source,
           (SELECT COALESCE(json_agg(row_to_json(recent)), '[]') FROM recent) AS recent`,
    [userId, kanjiId, userId, userId]
  );
  const summary = rows[0]?.summary || {};
  const bySourceRows = rows[0]?.by_source || [];
  const recentRows = rows[0]?.recent || [];
  return {
    count: Number(summary.count || 0),
    firstEncounteredAt: summary.first_encountered_at || null,
    lastEncounteredAt: summary.last_encountered_at || null,
    bySource: bySourceRows.map((row) => ({ sourceType: row.source_type, count: Number(row.count || 0) })),
    recent: (recentRows || []).map((row) => ({
      idEncounter: row.id_kanji_encounter,
      sourceType: row.source_type,
      sourceId: row.source_id,
      encounteredAt: row.encountered_at,
      sourceTitle: row.source_title || null
    }))
  };
}

module.exports = { ENCOUNTER_SOURCE_TYPES, getKanjiEncounterSummary, recordKanjiEncounters };
