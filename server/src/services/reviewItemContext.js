// Batched per-item review context (V5.6 Completion Pass). One call enriches a
// whole queue with a FIXED small number of set-based queries — never one
// query per card. All branches user-scoped in-statement. Missing data yields
// nulls (the UI hides those blocks; nothing is fabricated).
//
// Output per `${entityType}:${entityId}`:
//   { lastReviewedAt, lastResult, lastFailedAt, againCount,
//     example: { sentence, translation } | null,   // vocab + grammar only
//     encounters: { count, lastAt } | null }       // kanji only
const MAX_CONTEXT_ITEMS = 500;

function partitionIds(items) {
  const groups = { vocabulary: new Set(), kanji: new Set(), grammar: new Set() };
  for (const item of Array.isArray(items) ? items : []) {
    const type = item?.entityType;
    const id = Number(item?.entityId);
    if (!groups[type] || !Number.isInteger(id) || id <= 0) continue;
    groups[type].add(id);
    if (groups[type].size >= MAX_CONTEXT_ITEMS) break;
  }
  return {
    vocabulary: [...groups.vocabulary],
    kanji: [...groups.kanji],
    grammar: [...groups.grammar]
  };
}

function placeholders(count) {
  return count.map(() => '?').join(', ');
}

async function getReviewItemContext(executor, userId, items) {
  const ids = partitionIds(items);
  const context = new Map();
  const key = (type, id) => `${type}:${id}`;
  for (const type of Object.keys(ids)) {
    for (const id of ids[type]) context.set(key(type, id), {
      lastReviewedAt: null, lastResult: null, lastFailedAt: null, againCount: 0,
      example: null, encounters: null
    });
  }
  const queries = [];
  const branches = [];
  const branchParams = [];
  if (ids.vocabulary.length) {
    branches.push(`SELECT 'vocabulary' AS entity_type, ri.id_vocabulary AS entity_id,
      MAX(re.reviewed_at) AS last_reviewed_at,
      MAX(re.reviewed_at) FILTER (WHERE re.result = 'Again') AS last_failed_at,
      COUNT(*) FILTER (WHERE re.result = 'Again') AS again_count
     FROM review_events re
     JOIN review_items ri ON ri.id_review_item = re.id_review_item
     JOIN vocabulary v ON v.id_vocabulary = ri.id_vocabulary AND v.user_id = ?
     WHERE ri.id_vocabulary IN (${placeholders(ids.vocabulary)})
     GROUP BY ri.id_vocabulary`);
    branchParams.push(userId, ...ids.vocabulary);
  }
  if (branches.length) {
    queries.push(executor.execute(
      `SELECT * FROM (${branches.join(' UNION ALL ')}) review_agg`,
      branchParams
    ).then(([rows]) => {
      for (const row of rows || []) {
        const entry = context.get(key(row.entity_type, Number(row.entity_id)));
        if (!entry) continue;
        entry.lastReviewedAt = row.last_reviewed_at || null;
        entry.lastFailedAt = row.last_failed_at || null;
        entry.againCount = Number(row.again_count || 0);
      }
    }));
  }
  // Kanji + grammar review aggregates share the shape with their own joins.
  const extraBranches = [];
  const extraParams = [];
  if (ids.kanji.length) {
    extraBranches.push(`SELECT 'kanji' AS entity_type, ri.id_kanji AS entity_id,
      MAX(re.reviewed_at) AS last_reviewed_at,
      MAX(re.reviewed_at) FILTER (WHERE re.result = 'Again') AS last_failed_at,
      COUNT(*) FILTER (WHERE re.result = 'Again') AS again_count
     FROM review_events re
     JOIN review_items ri ON ri.id_review_item = re.id_review_item
     JOIN kanji k ON k.id_kanji = ri.id_kanji AND k.user_id = ?
     WHERE ri.id_kanji IN (${placeholders(ids.kanji)})
     GROUP BY ri.id_kanji`);
    extraParams.push(userId, ...ids.kanji);
  }
  if (ids.grammar.length) {
    extraBranches.push(`SELECT 'grammar' AS entity_type, ri.id_grammar AS entity_id,
      MAX(re.reviewed_at) AS last_reviewed_at,
      MAX(re.reviewed_at) FILTER (WHERE re.result = 'Again') AS last_failed_at,
      COUNT(*) FILTER (WHERE re.result = 'Again') AS again_count
     FROM review_events re
     JOIN review_items ri ON ri.id_review_item = re.id_review_item
     JOIN grammar_points g ON g.id_grammar = ri.id_grammar AND g.user_id = ?
     WHERE ri.id_grammar IN (${placeholders(ids.grammar)})
     GROUP BY ri.id_grammar`);
    extraParams.push(userId, ...ids.grammar);
  }
  if (extraBranches.length) {
    queries.push(executor.execute(
      `SELECT * FROM (${extraBranches.join(' UNION ALL ')}) review_agg`,
      extraParams
    ).then(([rows]) => {
      for (const row of rows || []) {
        const entry = context.get(key(row.entity_type, Number(row.entity_id)));
        if (!entry) continue;
        entry.lastReviewedAt = row.last_reviewed_at || null;
        entry.lastFailedAt = row.last_failed_at || null;
        entry.againCount = Number(row.again_count || 0);
      }
    }));
  }
  // First owned example sentence per vocab / grammar item (one query each).
  if (ids.vocabulary.length) {
    queries.push(executor.execute(
      `SELECT e.id_vocabulary AS entity_id, e.sentence, e.translation
       FROM usage_examples e
       JOIN vocabulary v ON v.id_vocabulary = e.id_vocabulary AND v.user_id = ?
       WHERE e.id_vocabulary IN (${placeholders(ids.vocabulary)})
       ORDER BY e.id_vocabulary ASC, e.id_usage_example ASC`,
      [userId, ...ids.vocabulary]
    ).then(([rows]) => {
      const seen = new Set();
      for (const row of rows || []) {
        const id = Number(row.entity_id);
        if (seen.has(id)) continue;
        seen.add(id);
        const entry = context.get(key('vocabulary', id));
        if (entry) entry.example = { sentence: row.sentence, translation: row.translation || null };
      }
    }));
  }
  if (ids.grammar.length) {
    queries.push(executor.execute(
      `SELECT e.id_grammar AS entity_id, e.sentence, e.translation
       FROM grammar_examples e
       JOIN grammar_points g ON g.id_grammar = e.id_grammar AND g.user_id = ?
       WHERE e.id_grammar IN (${placeholders(ids.grammar)})
       ORDER BY e.id_grammar ASC, e.id_grammar_example ASC`,
      [userId, ...ids.grammar]
    ).then(([rows]) => {
      const seen = new Set();
      for (const row of rows || []) {
        const id = Number(row.entity_id);
        if (seen.has(id)) continue;
        seen.add(id);
        const entry = context.get(key('grammar', id));
        if (entry) entry.example = { sentence: row.sentence, translation: row.translation || null };
      }
    }));
  }
  // Kanji encounter counts (one GROUP BY for the whole queue).
  if (ids.kanji.length) {
    queries.push(executor.execute(
      `SELECT id_kanji AS entity_id, COUNT(*) AS count, MAX(encountered_at) AS last_at
       FROM kanji_encounters WHERE user_id = ? AND id_kanji IN (${placeholders(ids.kanji)})
       GROUP BY id_kanji`,
      [userId, ...ids.kanji]
    ).then(([rows]) => {
      for (const row of rows || []) {
        const entry = context.get(key('kanji', Number(row.entity_id)));
        if (entry) entry.encounters = { count: Number(row.count || 0), lastAt: row.last_at || null };
      }
    }));
  }
  await Promise.all(queries);
  return context;
}

module.exports = { MAX_CONTEXT_ITEMS, getReviewItemContext };
