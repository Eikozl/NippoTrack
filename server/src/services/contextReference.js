// CA-B2 — bounded JMdict reference cohort retrieval (Q1 + Q2).
//
// Pool contract: `{ execute(sql, params) }` with `?` placeholders returning
// `[rows]` — exactly the runtime adapter shape (`src/config/db`). All SQL
// below is adapter-safe: positional `?` only, no LIKE, no JSON `?`
// operators (the adapter rewrites every `?`). SELECT-only; no writes, no
// user tables, no user_id anywhere near JMdict.
//
// Q1 resolves the active snapshot EXACTLY ONCE and preserves the pin even
// when no key matches (active CTE × input keys, LEFT JOIN LATERAL lookup):
// a request that looked against snapshot A reports provenance A, never a
// second pointer read. Zero eligible candidates → no query at all (no
// dictionary assertion is made).
//
// Bounds (frozen): ≤30 candidates, ≤4 keys each (≤120 keys), 5+1 per-key
// sentinel (≤720 physical rows), ≤150 distinct entries to Q2, 64+1 per-entry
// sense valve, ≤200 forms per entry with an explicit truncation flag.
// Total: ≤3 batched DB queries, never N+1.

const { JMDICT_EVAL_SENSE_VALVE } = require('./jmdictReference');

const Q1_PER_KEY_LIMIT = 6; // 5 usable rows + 1 overflow sentinel
const Q1_USABLE_PER_KEY = 5;
const Q1_MAX_ROWS = 720;
const Q1_MAX_KEYS = 120; // 30 candidates × 4 keys: enforced here, not just by callers
const CONTEXT_MAX_ENTRIES_Q2 = 150;
const Q2_SENSE_FETCH = JMDICT_EVAL_SENSE_VALVE + 1; // 65: 64 usable + sentinel
const Q2_FORMS_PER_ENTRY_CAP = 200;

function asBoolean(value) {
  // Runtime adapter folds booleans to 0/1; admin pg returns real booleans.
  return value === true || value === 1;
}

function asStringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

// Q1 input: flat key rows [{ candidateIdx, normalized, kind }]. ≤120 rows.
function buildQ1(sqlKeys) {
  if (!Array.isArray(sqlKeys) || !sqlKeys.length) throw new Error('buildQ1 requires at least one key.');
  if (sqlKeys.length > Q1_MAX_KEYS) throw new Error(`buildQ1 refuses ${sqlKeys.length} keys (cap ${Q1_MAX_KEYS}).`);
  const values = sqlKeys.map(() => '(?, ?, ?)').join(', ');
  const sql =
    'WITH active AS (' +
    ' SELECT s.source_id, s.source_name, s.converter, s.converter_version, s.file_date' +
    ' FROM jmdict_active_snapshot a' +
    ' JOIN jmdict_sources s ON s.source_id = a.source_id' +
    " WHERE a.singleton = 1 AND s.status = 'ready'" +
    '), keys (candidate_idx, normalized, kind) AS (VALUES ' + values + ')' +
    ' SELECT a.source_id, a.source_name, a.converter, a.converter_version, a.file_date,' +
    ' k.candidate_idx::int AS candidate_idx, k.normalized AS key_normalized, k.kind AS key_kind,' +
    ' f.entry_id, f.surface, f.normalized AS form_normalized, f.kind AS form_kind,' +
    ' f.is_common, f.nokanji, f.restr' +
    ' FROM active a CROSS JOIN keys k' +
    ' LEFT JOIN LATERAL (' +
    ' SELECT f.entry_id, f.surface, f.normalized, f.kind, f.is_common, f.nokanji, f.restr' +
    ' FROM jmdict_forms f' +
    ' WHERE f.source_id = a.source_id AND f.normalized = k.normalized AND f.kind = k.kind' +
    ' ORDER BY f.is_common DESC, f.entry_id LIMIT ' + Q1_PER_KEY_LIMIT +
    ' ) f ON true ORDER BY k.candidate_idx::int';
  const params = [];
  for (const key of sqlKeys) params.push(key.candidateIdx, key.normalized, key.kind);
  return { sql, params };
}

// Runs Q1. Returns { pin: null | {sourceId,...}, cohorts: Map<candidateIdx,
// { rows: [...matched form rows...], truncated: bool }> }. pin null ⇔ no
// ready active snapshot (UNAVAILABLE — never confuse with zero matches).
async function runQ1(pool, sqlKeys) {
  const { sql, params } = buildQ1(sqlKeys);
  const [rows] = await pool.execute(sql, params);
  if (!rows.length) return { pin: null, cohorts: new Map() };
  const first = rows[0];
  const pin = {
    sourceId: String(first.source_id),
    sourceName: String(first.source_name),
    converter: String(first.converter),
    converterVersion: String(first.converter_version),
    fileDate: first.file_date instanceof Date
      ? first.file_date.toISOString().slice(0, 10)
      : String(first.file_date)
  };
  const cohorts = new Map();
  for (const row of rows) {
    const idx = Number(row.candidate_idx);
    let cohort = cohorts.get(idx);
    if (!cohort) {
      cohort = { rows: [], truncated: false };
      cohorts.set(idx, cohort);
    }
    if (row.entry_id === null || row.entry_id === undefined) continue;
    cohort.rows.push({
      entryId: String(row.entry_id),
      surface: row.surface,
      normalized: row.form_normalized,
      kind: row.form_kind,
      isCommon: asBoolean(row.is_common),
      nokanji: asBoolean(row.nokanji),
      restr: asStringArray(row.restr)
    });
  }
  for (const cohort of cohorts.values()) {
    if (cohort.rows.length > Q1_USABLE_PER_KEY) {
      cohort.rows.length = Q1_USABLE_PER_KEY;
      cohort.truncated = true;
    }
  }
  return { pin, cohorts };
}

// Q2a: all correctness-required sense data for the bounded entry set, plus
// entry metadata, under the EXPLICIT pinned source (never re-reads the
// pointer). Per-entry 64+1 valve via LATERAL: ≤150 × 65 rows. Entry ids are
// cast ::bigint at the VALUES edge: unknown-type text params never compare
// implicitly against bigint columns (operator does not exist otherwise).
function buildQ2Senses(sourceId, entryIds) {
  if (!Array.isArray(entryIds) || !entryIds.length) throw new Error('buildQ2Senses requires at least one entry.');
  if (entryIds.length > CONTEXT_MAX_ENTRIES_Q2) throw new Error(`buildQ2Senses refuses ${entryIds.length} entries (cap ${CONTEXT_MAX_ENTRIES_Q2}).`);
  const values = entryIds.map(() => '(?::bigint)').join(', ');
  const sql =
    'WITH input (entry_id) AS (VALUES ' + values + '),' +
    ' pinned (source_id) AS (SELECT ?::bigint AS source_id)' +
    ' SELECT e.ent_seq AS entry_id, e.pos_summary, e.is_common,' +
    ' s.sense_no, s.pos, s.gloss_en, s.stagk, s.stagr' +
    ' FROM pinned p' +
    ' JOIN jmdict_entries e ON e.source_id = p.source_id AND e.ent_seq IN (SELECT entry_id FROM input)' +
    ' LEFT JOIN LATERAL (' +
    ' SELECT sense_no, pos, gloss_en, stagk, stagr FROM jmdict_senses' +
    ' WHERE source_id = p.source_id AND entry_id = e.ent_seq' +
    ' ORDER BY sense_no LIMIT ' + Q2_SENSE_FETCH +
    ' ) s ON true ORDER BY e.ent_seq, s.sense_no';
  return { sql, params: [...entryIds, sourceId] };
}

// Q2b: full form inventory for the bounded entry set (reading applicability:
// re_restr, nokanji, applicable dictionary readings) under the same pin.
// Per-entry cap 200 with an explicit truncation flag — unseen forms forbid
// UNIQUE exactly like unseen entries do.
function buildQ2Forms(sourceId, entryIds) {
  if (!Array.isArray(entryIds) || !entryIds.length) throw new Error('buildQ2Forms requires at least one entry.');
  if (entryIds.length > CONTEXT_MAX_ENTRIES_Q2) throw new Error(`buildQ2Forms refuses ${entryIds.length} entries (cap ${CONTEXT_MAX_ENTRIES_Q2}).`);
  const values = entryIds.map(() => '(?::bigint)').join(', ');
  const sql =
    'WITH input (entry_id) AS (VALUES ' + values + '),' +
    ' pinned (source_id) AS (SELECT ?::bigint AS source_id),' +
    ' ranked AS (' +
    ' SELECT f.entry_id, f.surface, f.normalized, f.kind, f.restr, f.is_common, f.nokanji,' +
    ' ROW_NUMBER() OVER (PARTITION BY f.entry_id ORDER BY f.kind, f.surface) AS rn,' +
    " COUNT(*) OVER (PARTITION BY f.entry_id) AS total" +
    ' FROM pinned p' +
    ' JOIN jmdict_forms f ON f.source_id = p.source_id AND f.entry_id IN (SELECT entry_id FROM input)' +
    ' ) SELECT entry_id, surface, normalized, kind, restr, is_common, nokanji, rn, total' +
    ' FROM ranked WHERE rn <= ' + (Q2_FORMS_PER_ENTRY_CAP + 1) + ' ORDER BY entry_id, kind, surface';
  return { sql, params: [...entryIds, sourceId] };
}

// Runs Q2a+Q2b in parallel (both read-only, same pin, independent).
// Returns { sensesByEntry: Map<entryId, { senses, truncated, posSummary,
// isCommon }>, formsByEntry: Map<entryId, { forms, truncated }> }.
async function runQ2(pool, sourceId, entryIds) {
  const senses = buildQ2Senses(sourceId, entryIds);
  const forms = buildQ2Forms(sourceId, entryIds);
  const [[senseRows], [formRows]] = await Promise.all([
    pool.execute(senses.sql, senses.params),
    pool.execute(forms.sql, forms.params)
  ]);
  const sensesByEntry = new Map();
  for (const row of senseRows) {
    const id = String(row.entry_id);
    let bucket = sensesByEntry.get(id);
    if (!bucket) {
      bucket = {
        senses: [],
        truncated: false,
        posSummary: asStringArray(row.pos_summary),
        isCommon: asBoolean(row.is_common)
      };
      sensesByEntry.set(id, bucket);
    }
    if (row.sense_no === null || row.sense_no === undefined) continue;
    bucket.senses.push({
      senseNo: Number(row.sense_no),
      pos: asStringArray(row.pos),
      glossEn: asStringArray(row.gloss_en),
      stagk: asStringArray(row.stagk),
      stagr: asStringArray(row.stagr)
    });
  }
  for (const bucket of sensesByEntry.values()) {
    if (bucket.senses.length > JMDICT_EVAL_SENSE_VALVE) {
      bucket.senses.length = JMDICT_EVAL_SENSE_VALVE;
      bucket.truncated = true;
    }
  }
  const formsByEntry = new Map();
  for (const row of formRows) {
    const id = String(row.entry_id);
    let bucket = formsByEntry.get(id);
    if (!bucket) {
      bucket = { forms: [], truncated: false };
      formsByEntry.set(id, bucket);
    }
    if (Number(row.total) > Q2_FORMS_PER_ENTRY_CAP) bucket.truncated = true;
    if (Number(row.rn) > Q2_FORMS_PER_ENTRY_CAP) continue;
    bucket.forms.push({
      surface: row.surface,
      normalized: row.normalized,
      kind: row.kind,
      restr: asStringArray(row.restr),
      isCommon: asBoolean(row.is_common),
      nokanji: asBoolean(row.nokanji)
    });
  }
  return { sensesByEntry, formsByEntry };
}

module.exports = {
  Q1_PER_KEY_LIMIT,
  Q1_USABLE_PER_KEY,
  Q1_MAX_ROWS,
  Q1_MAX_KEYS,
  CONTEXT_MAX_ENTRIES_Q2,
  Q2_SENSE_FETCH,
  Q2_FORMS_PER_ENTRY_CAP,
  buildQ1,
  runQ1,
  buildQ2Senses,
  buildQ2Forms,
  runQ2
};
