// Kanji Reference vocabulary examples — compact JMdict-derived illustration
// of how a character appears in real words (max 3, read-only).
//
// REFERENCE vocabulary only: never the user's collection, never learned /
// reviewed / known vocabulary, never Encounter or Review evidence. No
// ownership lookup is performed here by design (closure scope).
//
// Source of truth: the existing JMdict snapshot (jmdict_forms keb written
// forms + reb readings + jmdict_senses English glosses) behind the active
// pointer. No new table, no seed, no migration. Priority reuses the stored
// JMdict `is_common` flags (never invented frequency); the deterministic
// fallback is common → concise headword → stable entry order.
//
// One bounded snapshot-scoped query (candidate cap 20, lateral reading +
// gloss per candidate); a second tiny pointer probe runs ONLY when the
// first query returns zero rows, to distinguish NO MATCHES (status ok,
// examples []) from REFERENCE UNAVAILABLE (status unavailable). This
// function is total: it never throws — lookup stays available when JMdict
// is down.

const { isSingleHanCodePoint } = require('./kanjiReference');

const MAX_EXAMPLES = 3;
const CANDIDATE_FETCH = 20;
const MAX_HEADWORD_LENGTH = 8;

function runtimeDatabase() {
  return require('../config/db');
}

const EXAMPLES_SQL =
  'WITH active AS (' +
  ' SELECT a.source_id FROM jmdict_active_snapshot a' +
  ' JOIN jmdict_sources s ON s.source_id = a.source_id' +
  " WHERE a.singleton = 1 AND s.status = 'ready'" +
  ')' +
  ' SELECT c.entry_id, c.surface, r.reading, g.gloss' +
  ' FROM active' +
  ' JOIN LATERAL (' +
  ' SELECT f.entry_id, f.surface' +
  ' FROM jmdict_forms f' +
  ' WHERE f.source_id = active.source_id' +
  " AND f.kind = 'keb'" +
  ' AND POSITION(? IN f.surface) > 0' +
  ' AND CHAR_LENGTH(f.surface) <= ' + MAX_HEADWORD_LENGTH +
  ' ORDER BY f.is_common DESC, CHAR_LENGTH(f.surface), f.entry_id, f.surface' +
  ' LIMIT ' + CANDIDATE_FETCH +
  ' ) c ON true' +
  ' LEFT JOIN LATERAL (' +
  ' SELECT r.surface AS reading FROM jmdict_forms r' +
  ' WHERE r.source_id = active.source_id AND r.entry_id = c.entry_id' +
  " AND r.kind = 'reb' AND NOT r.nokanji" +
  // Hard applicability: a restricted reading belongs ONLY to its listed
  // keb — never pair another keb with it (soft ORDER BY would leak).
  ' AND (r.restr = \'{}\' OR r.restr @> ARRAY[c.surface])' +
  ' ORDER BY r.is_common DESC, r.surface' +
  ' LIMIT 1' +
  ' ) r ON true' +
  ' LEFT JOIN LATERAL (' +
  ' SELECT s.gloss_en[1] AS gloss FROM jmdict_senses s' +
  ' WHERE s.source_id = active.source_id AND s.entry_id = c.entry_id' +
  " AND s.gloss_en <> '{}'" +
  // Hard applicability: same rule for senses (stagk).
  ' AND (s.stagk = \'{}\' OR s.stagk @> ARRAY[c.surface])' +
  ' ORDER BY s.sense_no' +
  ' LIMIT 1' +
  ' ) g ON true';

const SNAPSHOT_PROBE_SQL =
  'SELECT a.source_id FROM jmdict_active_snapshot a' +
  ' JOIN jmdict_sources s ON s.source_id = a.source_id' +
  " WHERE a.singleton = 1 AND s.status = 'ready' LIMIT 1";

// Pure selection over pre-ranked candidate rows: require a written form
// genuinely containing the target kanji plus a usable kana reading and at
// least one English gloss; conservative surface dedupe (first ranked
// occurrence wins — genuinely distinct entries sharing a surface collapse
// to one card by design); hard max enforced here, not just in SQL.
function selectVocabularyExamples(rows, character, limit = MAX_EXAMPLES) {
  if (!isSingleHanCodePoint(character)) return [];
  const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_EXAMPLES) : MAX_EXAMPLES;
  const seen = new Set();
  const examples = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (examples.length >= cap) break;
    const word = typeof row?.surface === 'string' ? row.surface : '';
    const reading = typeof row?.reading === 'string' ? row.reading : '';
    const meaning = typeof row?.gloss === 'string' ? row.gloss : '';
    if (!word || !word.includes(character)) continue;
    if (!reading || !meaning) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    examples.push({ word, reading, meaning });
  }
  return examples;
}

async function fetchKanjiVocabularyExamples(character, database = runtimeDatabase()) {
  if (!isSingleHanCodePoint(character)) return { status: 'unavailable', examples: [] };
  try {
    const [rows] = await database.execute(EXAMPLES_SQL, [character]);
    if (!rows || !rows.length) {
      const [pin] = await database.execute(SNAPSHOT_PROBE_SQL, []);
      if (!pin || !pin.length) return { status: 'unavailable', examples: [] };
      return { status: 'ok', examples: [] };
    }
    return { status: 'ok', examples: selectVocabularyExamples(rows, character) };
  } catch {
    return { status: 'unavailable', examples: [] };
  }
}

module.exports = {
  MAX_EXAMPLES,
  fetchKanjiVocabularyExamples,
  selectVocabularyExamples
};
