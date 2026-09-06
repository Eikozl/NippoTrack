// Review candidates (R-A): read-only evidence aggregation for review sessions.
//
// Strategy (<=6 round trips): one UNION ALL query per evidence class across
// the selected entity types, each branch carrying an entity_type literal +
// display fields + JLPT band + source date/context columns.
//
// Budget note: each class query caps at 501 rows per entity type via a
// ROW_NUMBER() window partitioned by entity_type ordered by source date DESC
// (501 = 500 kept + 1 overflow probe). Worst case in memory is
// 4 classes x 501 rows x 3 types ~= ~6000 rows, which is acceptable for a
// bounded candidates endpoint. Merged per-type lists are then capped at 500
// in code (strength rank, latest source date DESC, id) and truncated=true is
// set whenever any SQL or in-code cap is hit.
//
// READ-ONLY: only SELECT. No writes.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const STRENGTH_RANK = { strong: 3, moderate: 2, weak: 1 };

function toIsoDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'string') {
    const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : null;
  }
  return null;
}

function formatDateLabel(isoDate) {
  if (typeof isoDate !== 'string') return isoDate;
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return isoDate;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!month || month < 1 || month > 12) return isoDate;
  const label = `${MONTHS[month - 1]} ${day}`;
  const currentYear = new Date().getFullYear();
  return year === currentYear ? label : `${label}, ${year}`;
}

function wrapWithRowNumberCap(unionSql) {
  // Per-type cap via window function partitioned by entity type.
  return `SELECT * FROM (
    SELECT inner_q.*, ROW_NUMBER() OVER (PARTITION BY entity_type ORDER BY source_ts DESC, entity_id DESC) AS rn
    FROM (${unionSql}) AS inner_q
  ) AS capped WHERE rn <= 501`;
}

function buildReviewQuery(selectedTypes, { from, to, userId, jlpt }) {
  const needJlpt = jlpt !== 'all';
  const branches = [];
  const params = [];
  if (selectedTypes.includes('kanji')) {
    // Kanji JLPT band: COALESCE(reference overlay, owned column). Verified in
    // levelEstimate.js: LEFT JOIN kanji_reference kr ON
    // kr.id_kanji_reference = k.reference_id.
    branches.push(`SELECT 'kanji' AS entity_type, k.id_kanji AS entity_id,
      k.character_kanji AS display, k.onyomi AS reading, k.meaning AS meaning,
      COALESCE(kr.jlpt_level, k.jlpt_level) AS jlpt,
      re.reviewed_at::date AS source_date, re.reviewed_at AS source_ts, re.result AS source_result
      FROM kanji k
      JOIN review_items ri ON ri.id_kanji = k.id_kanji
      JOIN review_events re ON re.id_review_item = ri.id_review_item
      LEFT JOIN kanji_reference kr ON kr.id_kanji_reference = k.reference_id
      WHERE re.reviewed_at >= ?::date AND re.reviewed_at < (?::date + 1)
        AND k.user_id = ?${needJlpt ? ' AND COALESCE(kr.jlpt_level, k.jlpt_level) = ?' : ''}`);
    params.push(from, to, userId);
    if (needJlpt) params.push(jlpt);
  }
  if (selectedTypes.includes('vocabulary')) {
    branches.push(`SELECT 'vocabulary' AS entity_type, v.id_vocabulary AS entity_id,
      v.word AS display, v.reading AS reading, v.meaning AS meaning,
      v.jlpt_level AS jlpt,
      re.reviewed_at::date AS source_date, re.reviewed_at AS source_ts, re.result AS source_result
      FROM vocabulary v
      JOIN review_items ri ON ri.id_vocabulary = v.id_vocabulary
      JOIN review_events re ON re.id_review_item = ri.id_review_item
      WHERE re.reviewed_at >= ?::date AND re.reviewed_at < (?::date + 1)
        AND v.user_id = ?${needJlpt ? ' AND v.jlpt_level = ?' : ''}`);
    params.push(from, to, userId);
    if (needJlpt) params.push(jlpt);
  }
  if (selectedTypes.includes('grammar')) {
    branches.push(`SELECT 'grammar' AS entity_type, g.id_grammar AS entity_id,
      g.grammar_point AS display, NULL AS reading, g.meaning AS meaning,
      g.jlpt_level AS jlpt,
      re.reviewed_at::date AS source_date, re.reviewed_at AS source_ts, re.result AS source_result
      FROM grammar_points g
      JOIN review_items ri ON ri.id_grammar = g.id_grammar
      JOIN review_events re ON re.id_review_item = ri.id_review_item
      WHERE re.reviewed_at >= ?::date AND re.reviewed_at < (?::date + 1)
        AND g.user_id = ?${needJlpt ? ' AND g.jlpt_level = ?' : ''}`);
    params.push(from, to, userId);
    if (needJlpt) params.push(jlpt);
  }
  if (!branches.length) return null;
  return { sql: wrapWithRowNumberCap(branches.join(' UNION ALL ')), params };
}

function buildSessionQuery(selectedTypes, { from, to, userId, jlpt }) {
  const needJlpt = jlpt !== 'all';
  const branches = [];
  const params = [];
  if (selectedTypes.includes('kanji')) {
    branches.push(`SELECT 'kanji' AS entity_type, k.id_kanji AS entity_id,
      k.character_kanji AS display, k.onyomi AS reading, k.meaning AS meaning,
      COALESCE(kr.jlpt_level, k.jlpt_level) AS jlpt,
      s.session_date AS source_date, s.session_date AS source_ts,
      s.category AS source_category, s.duration_minutes AS source_duration
      FROM kanji k
      JOIN session_kanji sk ON sk.id_kanji = k.id_kanji
      JOIN study_sessions s ON s.id_session = sk.id_session
      LEFT JOIN kanji_reference kr ON kr.id_kanji_reference = k.reference_id
      WHERE s.session_date BETWEEN ?::date AND ?::date AND s.session_date <= CURRENT_DATE
        AND s.user_id = ? AND k.user_id = ?${needJlpt ? ' AND COALESCE(kr.jlpt_level, k.jlpt_level) = ?' : ''}`);
    params.push(from, to, userId, userId);
    if (needJlpt) params.push(jlpt);
  }
  if (selectedTypes.includes('vocabulary')) {
    branches.push(`SELECT 'vocabulary' AS entity_type, v.id_vocabulary AS entity_id,
      v.word AS display, v.reading AS reading, v.meaning AS meaning,
      v.jlpt_level AS jlpt,
      s.session_date AS source_date, s.session_date AS source_ts,
      s.category AS source_category, s.duration_minutes AS source_duration
      FROM vocabulary v
      JOIN session_vocabulary sv ON sv.id_vocabulary = v.id_vocabulary
      JOIN study_sessions s ON s.id_session = sv.id_session
      WHERE s.session_date BETWEEN ?::date AND ?::date AND s.session_date <= CURRENT_DATE
        AND s.user_id = ? AND v.user_id = ?${needJlpt ? ' AND v.jlpt_level = ?' : ''}`);
    params.push(from, to, userId, userId);
    if (needJlpt) params.push(jlpt);
  }
  if (selectedTypes.includes('grammar')) {
    branches.push(`SELECT 'grammar' AS entity_type, g.id_grammar AS entity_id,
      g.grammar_point AS display, NULL AS reading, g.meaning AS meaning,
      g.jlpt_level AS jlpt,
      s.session_date AS source_date, s.session_date AS source_ts,
      s.category AS source_category, s.duration_minutes AS source_duration
      FROM grammar_points g
      JOIN session_grammar sg ON sg.id_grammar = g.id_grammar
      JOIN study_sessions s ON s.id_session = sg.id_session
      WHERE s.session_date BETWEEN ?::date AND ?::date AND s.session_date <= CURRENT_DATE
        AND s.user_id = ? AND g.user_id = ?${needJlpt ? ' AND g.jlpt_level = ?' : ''}`);
    params.push(from, to, userId, userId);
    if (needJlpt) params.push(jlpt);
  }
  if (!branches.length) return null;
  return { sql: wrapWithRowNumberCap(branches.join(' UNION ALL ')), params };
}

function buildEncounterQuery({ from, to, userId, jlpt }) {
  const needJlpt = jlpt !== 'all';
  // Kanji-only moderate evidence. Single query with LEFT JOINs for source
  // detail names (vocabulary word / writing title); context still derives
  // from source_type so labels stay stable when the joined row is gone.
  const sql = wrapWithRowNumberCap(`SELECT 'kanji' AS entity_type, k.id_kanji AS entity_id,
      k.character_kanji AS display, k.onyomi AS reading, k.meaning AS meaning,
      COALESCE(kr.jlpt_level, k.jlpt_level) AS jlpt,
      ke.encountered_at::date AS source_date, ke.encountered_at AS source_ts,
      ke.source_type AS source_type, ke.source_id AS source_id,
      v.word AS vocab_word, COALESCE(sw.title, 'Session writing') AS writing_title
      FROM kanji_encounters ke
      JOIN kanji k ON k.id_kanji = ke.id_kanji
      LEFT JOIN kanji_reference kr ON kr.id_kanji_reference = k.reference_id
      LEFT JOIN vocabulary v ON ke.source_type = 'vocabulary' AND v.id_vocabulary = ke.source_id AND v.user_id = ?
      LEFT JOIN study_sessions ss ON ke.source_type = 'session_writing' AND ss.id_session = ke.source_id AND ss.user_id = ?
      LEFT JOIN session_writings sw ON sw.id_session = ss.id_session
      WHERE ke.user_id = ?
        AND ke.encountered_at >= ?::date AND ke.encountered_at < (?::date + 1)
        AND k.user_id = ?${needJlpt ? ' AND COALESCE(kr.jlpt_level, k.jlpt_level) = ?' : ''}`);
  const params = [userId, userId, userId, from, to, userId];
  if (needJlpt) params.push(jlpt);
  return { sql, params };
}

function buildAddedQuery(selectedTypes, { from, to, userId, jlpt }) {
  const needJlpt = jlpt !== 'all';
  const branches = [];
  const params = [];
  if (selectedTypes.includes('kanji')) {
    branches.push(`SELECT 'kanji' AS entity_type, k.id_kanji AS entity_id,
      k.character_kanji AS display, k.onyomi AS reading, k.meaning AS meaning,
      COALESCE(kr.jlpt_level, k.jlpt_level) AS jlpt,
      k.created_at::date AS source_date, k.created_at AS source_ts
      FROM kanji k
      LEFT JOIN kanji_reference kr ON kr.id_kanji_reference = k.reference_id
      WHERE k.created_at >= ?::date AND k.created_at < (?::date + 1)
        AND k.user_id = ?${needJlpt ? ' AND COALESCE(kr.jlpt_level, k.jlpt_level) = ?' : ''}`);
    params.push(from, to, userId);
    if (needJlpt) params.push(jlpt);
  }
  if (selectedTypes.includes('vocabulary')) {
    branches.push(`SELECT 'vocabulary' AS entity_type, v.id_vocabulary AS entity_id,
      v.word AS display, v.reading AS reading, v.meaning AS meaning,
      v.jlpt_level AS jlpt,
      v.created_at::date AS source_date, v.created_at AS source_ts
      FROM vocabulary v
      WHERE v.created_at >= ?::date AND v.created_at < (?::date + 1)
        AND v.user_id = ?${needJlpt ? ' AND v.jlpt_level = ?' : ''}`);
    params.push(from, to, userId);
    if (needJlpt) params.push(jlpt);
  }
  if (selectedTypes.includes('grammar')) {
    branches.push(`SELECT 'grammar' AS entity_type, g.id_grammar AS entity_id,
      g.grammar_point AS display, NULL AS reading, g.meaning AS meaning,
      g.jlpt_level AS jlpt,
      g.created_at::date AS source_date, g.created_at AS source_ts
      FROM grammar_points g
      WHERE g.created_at >= ?::date AND g.created_at < (?::date + 1)
        AND g.user_id = ?${needJlpt ? ' AND g.jlpt_level = ?' : ''}`);
    params.push(from, to, userId);
    if (needJlpt) params.push(jlpt);
  }
  if (!branches.length) return null;
  return { sql: wrapWithRowNumberCap(branches.join(' UNION ALL ')), params };
}

async function getReviewCandidates(poolOrExecutor, userId, { from, to, jlpt, types }) {
  const allowedTypes = ['kanji', 'vocabulary', 'grammar'];
  const selectedTypes = Array.isArray(types) && types.length
    ? [...new Set(types)].filter((type) => allowedTypes.includes(type))
    : [...allowedTypes];
  const activeTypes = selectedTypes.length ? selectedTypes : [...allowedTypes];
  const jlptBand = jlpt || 'all';
  const needJlptFilter = jlptBand !== 'all';
  const context = { from, to, userId, jlpt: jlptBand };

  const reviewQuery = buildReviewQuery(activeTypes, context);
  const sessionQuery = buildSessionQuery(activeTypes, context);
  const encounterQuery = activeTypes.includes('kanji') ? buildEncounterQuery(context) : null;
  const addedQuery = buildAddedQuery(activeTypes, context);

  // Four bounded SELECTs (three when kanji is excluded) — well under the
  // six round-trip budget. All read-only.
  const [reviewResult, sessionResult, encounterResult, addedResult] = await Promise.all([
    reviewQuery ? poolOrExecutor.execute(reviewQuery.sql, reviewQuery.params) : Promise.resolve([[]]),
    sessionQuery ? poolOrExecutor.execute(sessionQuery.sql, sessionQuery.params) : Promise.resolve([[]]),
    encounterQuery ? poolOrExecutor.execute(encounterQuery.sql, encounterQuery.params) : Promise.resolve([[]]),
    addedQuery ? poolOrExecutor.execute(addedQuery.sql, addedQuery.params) : Promise.resolve([[]])
  ]);
  const reviewRows = (reviewResult && reviewResult[0]) || [];
  const sessionRows = (sessionResult && sessionResult[0]) || [];
  const encounterRows = (encounterResult && encounterResult[0]) || [];
  const addedRows = (addedResult && addedResult[0]) || [];

  const sqlCapHitByType = { kanji: false, vocabulary: false, grammar: false };
  function noteCapHits(rows) {
    const counts = {};
    for (const row of rows || []) {
      if (!row || !row.entity_type) continue;
      counts[row.entity_type] = (counts[row.entity_type] || 0) + 1;
    }
    for (const [type, count] of Object.entries(counts)) {
      if (count >= 501) sqlCapHitByType[type] = true;
    }
  }
  noteCapHits(reviewRows);
  noteCapHits(sessionRows);
  noteCapHits(encounterRows);
  noteCapHits(addedRows);

  const merged = new Map();

  function upsertRow(row, strength, buildSource) {
    if (!row) return;
    const entityType = row.entity_type;
    if (!activeTypes.includes(entityType)) return;
    const entityId = Number(row.entity_id);
    if (!Number.isInteger(entityId) || entityId <= 0) return;
    const isoDate = toIsoDate(row.source_date);
    if (!isoDate) return;
    if (isoDate < from || isoDate > to) return;
    if (needJlptFilter) {
      if (!row.jlpt || row.jlpt !== jlptBand) return;
    }
    const key = `${entityType}:${entityId}`;
    let entry = merged.get(key);
    if (!entry) {
      entry = {
        entityType,
        entityId,
        display: row.display ?? null,
        reading: row.reading ?? null,
        meaning: row.meaning ?? null,
        jlpt: row.jlpt || null,
        evidenceStrength: strength,
        strengthRank: STRENGTH_RANK[strength],
        latestDate: isoDate,
        sources: []
      };
      merged.set(key, entry);
    } else {
      if (STRENGTH_RANK[strength] > entry.strengthRank) {
        entry.evidenceStrength = strength;
        entry.strengthRank = STRENGTH_RANK[strength];
      }
      if (isoDate > entry.latestDate) entry.latestDate = isoDate;
    }
    entry.sources.push(buildSource(row, isoDate));
  }

  for (const row of reviewRows) {
    upsertRow(row, 'strong', (sourceRow, isoDate) => ({
      kind: 'review',
      date: isoDate,
      label: `Reviewed \u00B7 ${formatDateLabel(isoDate)}`,
      context: sourceRow.source_result || 'Reviewed'
    }));
  }
  for (const row of sessionRows) {
    upsertRow(row, 'strong', (sourceRow, isoDate) => {
      const category = sourceRow.source_category || 'Study';
      const duration = sourceRow.source_duration;
      const context = duration !== null && duration !== undefined
        ? `${category} \u00B7 ${Number(duration)} min`
        : `${category}`;
      return {
        kind: 'session',
        date: isoDate,
        label: `Study session \u00B7 ${formatDateLabel(isoDate)}`,
        context
      };
    });
  }
  for (const row of encounterRows) {
    upsertRow(row, 'moderate', (sourceRow, isoDate) => {
      const isWriting = sourceRow.source_type === 'session_writing';
      const label = isWriting
        ? `Seen in session writing \u00B7 ${formatDateLabel(isoDate)}`
        : `Seen in vocabulary \u00B7 ${formatDateLabel(isoDate)}`;
      let context = isWriting ? 'Session writing' : 'Vocabulary';
      if (isWriting && sourceRow.writing_title && sourceRow.writing_title !== 'Session writing') {
        context = `Session writing \u00B7 ${sourceRow.writing_title}`;
      } else if (!isWriting && sourceRow.vocab_word) {
        context = `Vocabulary \u00B7 ${sourceRow.vocab_word}`;
      }
      return { kind: 'encounter', date: isoDate, label, context };
    });
  }
  for (const row of addedRows) {
    upsertRow(row, 'weak', (sourceRow, isoDate) => ({
      kind: 'added',
      date: isoDate,
      label: `Added \u00B7 ${formatDateLabel(isoDate)}`,
      context: 'Not linked to a study session'
    }));
  }

  const groups = {};
  for (const type of ['kanji', 'vocabulary', 'grammar']) {
    if (!activeTypes.includes(type)) {
      groups[type] = { items: [], total: 0, truncated: false };
      continue;
    }
    const list = [];
    for (const entry of merged.values()) {
      if (entry.entityType !== type) continue;
      entry.sources.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      entry.sources = entry.sources.slice(0, 5);
      list.push(entry);
    }
    list.sort((a, b) => {
      if (b.strengthRank !== a.strengthRank) return b.strengthRank - a.strengthRank;
      if (b.latestDate !== a.latestDate) return b.latestDate < a.latestDate ? -1 : 1;
      return a.entityId - b.entityId;
    });
    let truncated = Boolean(sqlCapHitByType[type]);
    let items = list;
    if (list.length > 500) {
      truncated = true;
      items = list.slice(0, 500);
    }
    groups[type] = {
      items: items.map((entry) => ({
        entityType: entry.entityType,
        entityId: entry.entityId,
        display: entry.display,
        reading: entry.reading,
        meaning: entry.meaning,
        jlpt: entry.jlpt,
        evidenceStrength: entry.evidenceStrength,
        sources: entry.sources
      })),
      total: items.length,
      truncated
    };
  }

  return groups;
}

module.exports = { getReviewCandidates, formatDateLabel, toIsoDate };
