const { extractUniqueKanji } = require('./kanjiVocabularyLinks');

const ENCOUNTER_SOURCE_TYPES = Object.freeze({
  VOCABULARY: 'vocabulary',
  SESSION_WRITING: 'session_writing'
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
  const [summaryRows] = await executor.execute(
    `SELECT COUNT(*) AS count, MIN(encountered_at) AS first_encountered_at, MAX(encountered_at) AS last_encountered_at
     FROM kanji_encounters WHERE user_id = ? AND id_kanji = ?`,
    [userId, kanjiId]
  );
  const [bySourceRows] = await executor.execute(
    `SELECT source_type, COUNT(*) AS count FROM kanji_encounters
     WHERE user_id = ? AND id_kanji = ? GROUP BY source_type ORDER BY source_type`,
    [userId, kanjiId]
  );
  const [recentRows] = await executor.execute(
    `SELECT ke.id_kanji_encounter, ke.source_type, ke.source_id, ke.encountered_at,
            CASE
              WHEN ke.source_type = 'vocabulary' THEN v.word
              WHEN ke.source_type = 'session_writing' THEN COALESCE(sw.title, 'Session writing')
              ELSE NULL
            END AS source_title
     FROM kanji_encounters ke
      LEFT JOIN vocabulary v ON ke.source_type = 'vocabulary' AND v.id_vocabulary = ke.source_id AND v.user_id = ke.user_id
      LEFT JOIN study_sessions ss ON ke.source_type = 'session_writing' AND ss.id_session = ke.source_id AND ss.user_id = ke.user_id
      LEFT JOIN session_writings sw ON ke.source_type = 'session_writing' AND sw.id_session = ss.id_session
     WHERE ke.user_id = ? AND ke.id_kanji = ?
     ORDER BY ke.encountered_at DESC, ke.id_kanji_encounter DESC
     LIMIT 5`,
    [userId, kanjiId]
  );
  const summary = summaryRows[0] || {};
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
