// Where-seen aggregation (V5.6 Completion Pass): learner-facing encounter
// history for vocabulary and grammar, built ONLY from existing relations.
// No new tables, no new tracking. Kanji keeps its dedicated encounter
// summary (kanjiEncounters.getKanjiEncounterSummary); this module covers
// the two types that never had one.
//
// Per entity, up to 3 bounded parallel SELECTs, every branch user-scoped
// in the same statement (never check-then-read across statements):
//   examples  — owned sentences the learner saved (usage/grammar_examples)
//   sessions  — study sessions linked to the entity (date + category)
//   immersion — immersion sessions that captured the entity
// Empty everywhere → { examples: [], sessions: [], immersion: [] } and the
// UI hides the section (never fabricated).
const WHERE_SEEN_LIMIT = 5;

const ENTITY_SOURCES = {
  vocabulary: {
    exampleTable: 'usage_examples',
    exampleId: 'id_usage_example',
    entityColumn: 'id_vocabulary',
    parentTable: 'vocabulary',
    parentPk: 'id_vocabulary',
    sessionTable: 'session_vocabulary'
  },
  grammar: {
    exampleTable: 'grammar_examples',
    exampleId: 'id_grammar_example',
    entityColumn: 'id_grammar',
    parentTable: 'grammar_points',
    parentPk: 'id_grammar',
    sessionTable: 'session_grammar'
  }
};

function entitySource(entityType) {
  const source = ENTITY_SOURCES[entityType];
  if (!source) throw new Error(`Unsupported where-seen entity type: ${entityType}`);
  return source;
}

async function getWhereSeen(executor, userId, entityType, entityId) {
  const source = entitySource(entityType);
  const id = Number(entityId);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`${entityType} id must be a positive integer.`);
  const [[exampleRows], [sessionRows], [immersionRows]] = await Promise.all([
    executor.execute(
      `SELECT e.sentence, e.translation, e.created_at AS "createdAt"
       FROM ${source.exampleTable} e
       JOIN ${source.parentTable} p ON p.${source.parentPk} = e.${source.entityColumn} AND p.user_id = ?
       WHERE e.${source.entityColumn} = ?
       ORDER BY e.${source.exampleId} DESC LIMIT ${WHERE_SEEN_LIMIT}`,
      [userId, id]
    ),
    executor.execute(
      `SELECT ss.session_date AS "date", ss.category, ss.duration_minutes AS "minutes"
       FROM ${source.sessionTable} sl
       JOIN study_sessions ss ON ss.id_session = sl.id_session AND ss.user_id = ?
       JOIN ${source.parentTable} p ON p.${source.parentPk} = sl.${source.entityColumn} AND p.user_id = ?
       WHERE sl.${source.entityColumn} = ?
       ORDER BY ss.session_date DESC, ss.id_session DESC LIMIT ${WHERE_SEEN_LIMIT}`,
      [userId, userId, id]
    ),
    executor.execute(
      `SELECT ms.created_at AS "createdAt", ms.estimated_level AS "level"
       FROM immersion_session_items mi
       JOIN immersion_sessions ms ON ms.id_immersion_session = mi.id_immersion_session AND ms.user_id = ?
       WHERE mi.entity_type = ? AND mi.entity_id = ?
       ORDER BY ms.created_at DESC, ms.id_immersion_session DESC LIMIT ${WHERE_SEEN_LIMIT}`,
      [userId, entityType, id]
    )
  ]);
  return {
    examples: (exampleRows || []).map((row) => ({
      sentence: row.sentence,
      translation: row.translation || null,
      createdAt: row.createdAt || null
    })),
    sessions: (sessionRows || []).map((row) => ({
      date: row.date ? String(row.date).slice(0, 10) : null,
      category: row.category,
      minutes: Number(row.minutes || 0)
    })),
    immersion: (immersionRows || []).map((row) => ({
      createdAt: row.createdAt || null,
      level: row.level || null
    }))
  };
}

module.exports = { WHERE_SEEN_LIMIT, getWhereSeen };
