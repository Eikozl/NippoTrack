// JMdict global reference foundation (Context-Aware Vocabulary Intelligence, CA-B1).
//
// This module owns: deterministic normalization of the jmdict-simplified JSON
// projection, snapshot lifecycle SQL (import/verify/activate/rollback/prune),
// integrity checks, and the C1 linguistic/import audit.
//
// Boundaries (frozen):
// - JMdict is GLOBAL reference data: no user_id, no user-table FKs, runtime
//   SELECT-only. All functions here take a privileged admin client and must
//   never run on the runtime pool.
// - Display surfaces (surface/raw keb/reb/gloss text) are stored verbatim;
//   `normalized` is the lookup-only folded key. Never mutate one into the other.
// - CA-B2 amendments preserved: (A) Q1 must return/preserve the pinned active
//   source metadata even with zero lexical matches, with no second pointer
//   read; (B) reconstructed/inflected observed surfaces (行った, 行きました,
//   食べなかった, 来なかった, …) must NEVER become dictionary identity keys —
//   identity comes from safe lemma/canonical, plus surface only when proven
//   dictionary-form/uninflected. This module exposes no identity-key builder;
//   B2 must implement that rule at Q1 key-generation time.

const crypto = require('node:crypto');
const { katakanaToHiragana } = require('../search/japaneseSearch');

const JMDICT_SOURCE_NAME = 'JMdict';
const JMDICT_CONVERTER = 'jmdict-simplified';
const JMDICT_IMPORTER_VERSION = 'cab1-1';
const IMPORT_BATCH_SIZE = 500;
// Max child rows per bulk INSERT statement. A 500-entry batch carries ~1150
// forms / ~580 senses on average (measured pin 3.6.2), so one chunk each in
// practice; pathological batches split deterministically instead of building
// one giant statement. Entries are always a single statement per batch.
const BULK_CHUNK_ROWS = 2000;
const SNAPSHOT_STATUSES = ['importing', 'validating', 'ready', 'failed'];
// Frozen CA-B2 evaluation valve: at most this many senses per entry are
// evaluated; a 65th sense is an overflow sentinel. See docs/jmdict-import.md.
const JMDICT_EVAL_SENSE_VALVE = 64;

const HAN_PATTERN = /\p{Script=Han}/u;

class JmdictImportError extends Error {
  constructor(message, { entryId = null, sourceId = null } = {}) {
    super(entryId === null ? message : `JMdict entry ${entryId}: ${message}`);
    this.name = 'JmdictImportError';
    this.entryId = entryId;
    this.sourceId = sourceId;
  }
}

// Lookup-only folded key. Policy: NFKC + katakana→hiragana fold ONLY — no
// trim, no punctuation stripping (JMdict readings legitimately contain 〜, ・,
// -, etc.). Display surfaces are stored verbatim alongside. CA-B2 Q1 MUST use
// this exact function so importer keys and query keys agree byte-for-byte.
function normalizeJmdictForm(surface) {
  if (typeof surface !== 'string' || surface === '') {
    throw new JmdictImportError('form surface must be a non-empty string');
  }
  return katakanaToHiragana(surface);
}

function hasHanCharacter(value) {
  return typeof value === 'string' && HAN_PATTERN.test(value);
}

// jmdict-simplified uses ["*"] for "applies to all". An empty array means
// "applies to none" (kana-only in effect). Anything else is an explicit
// restriction list that must reference existing spellings/readings.
function resolveAppliesTo(values, kind) {
  if (!Array.isArray(values)) throw new JmdictImportError(`${kind} restriction must be an array`);
  if (values.length === 1 && values[0] === '*') return { restricted: false, targets: [] };
  if (values.length === 0) return { restricted: true, targets: [], appliesToNone: true };
  const targets = [];
  for (const value of values) {
    if (typeof value !== 'string' || value === '') {
      throw new JmdictImportError(`${kind} restriction target must be a non-empty string`);
    }
    if (!targets.includes(value)) targets.push(value);
  }
  return { restricted: true, targets, appliesToNone: false };
}

function englishGlosses(glossArray, entryId) {
  if (!Array.isArray(glossArray)) throw new JmdictImportError('sense gloss must be an array', { entryId });
  const english = glossArray.filter((gloss) => gloss && gloss.lang === 'eng' && typeof gloss.text === 'string' && gloss.text !== '');
  if (!english.length) {
    throw new JmdictImportError('sense has no English gloss; refusing to store a gloss-less sense', { entryId });
  }
  // Plain translations first; typed glosses (literal/figurative/explanation)
  // only as a deterministic fallback so gloss_en is never empty while real
  // translation text exists. Full typed fidelity remains in doc.
  const plain = english.filter((gloss) => !gloss.type);
  const chosen = plain.length ? plain : english;
  return [...new Set(chosen.map((gloss) => gloss.text))];
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function chunkRows(rows, size) {
  const chunks = [];
  for (let offset = 0; offset < rows.length; offset += size) {
    chunks.push(rows.slice(offset, offset + size));
  }
  return chunks;
}

// Normalize one jmdict-simplified word into the frozen hybrid projection.
// Throws JmdictImportError (with entry id) on any malformed or
// restriction-unsafe construct. Restriction loss is a high-harm bug: dangling
// stagk/stagr/re_restr targets fail the import instead of being dropped.
function normalizeJmdictWord(word) {
  if (!word || typeof word !== 'object') throw new JmdictImportError('word must be an object');
  const entSeq = Number(word.id);
  if (!Number.isInteger(entSeq) || entSeq <= 0) {
    throw new JmdictImportError(`invalid id (expected positive integer ent_seq): ${JSON.stringify(word.id)}`, { entryId: word.id });
  }
  const entryId = entSeq;
  const kanjiList = Array.isArray(word.kanji) ? word.kanji : null;
  const kanaList = Array.isArray(word.kana) ? word.kana : null;
  if (!kanjiList) throw new JmdictImportError('kanji must be an array', { entryId });
  if (!kanaList || !kanaList.length) throw new JmdictImportError('kana must be a non-empty array (DTD r_ele+)', { entryId });
  const senseList = Array.isArray(word.sense) ? word.sense : null;
  if (!senseList || !senseList.length) throw new JmdictImportError('sense must be a non-empty array', { entryId });

  const kebSet = [];
  for (const kanji of kanjiList) {
    if (!kanji || typeof kanji.text !== 'string' || kanji.text === '') {
      throw new JmdictImportError('kanji entry must have non-empty text', { entryId });
    }
    if (kebSet.includes(kanji.text)) throw new JmdictImportError(`duplicate keb: ${kanji.text}`, { entryId });
    kebSet.push(kanji.text);
  }
  const rebSet = [];
  for (const kana of kanaList) {
    if (!kana || typeof kana.text !== 'string' || kana.text === '') {
      throw new JmdictImportError('kana entry must have non-empty text', { entryId });
    }
    if (rebSet.includes(kana.text)) throw new JmdictImportError(`duplicate reb: ${kana.text}`, { entryId });
    rebSet.push(kana.text);
  }

  const forms = [];
  for (const kanji of kanjiList) {
    forms.push({
      surface: kanji.text,
      normalized: normalizeJmdictForm(kanji.text),
      kind: 'keb',
      restr: [],
      isCommon: kanji.common === true,
      nokanji: false
    });
  }
  for (const kana of kanaList) {
    const applies = resolveAppliesTo(kana.appliesToKanji, 'reading appliesToKanji');
    if (applies.restricted && !applies.appliesToNone) {
      for (const target of applies.targets) {
        if (!kebSet.includes(target)) {
          throw new JmdictImportError(`reading restriction target has no keb: ${target}`, { entryId });
        }
      }
    }
    forms.push({
      surface: kana.text,
      normalized: normalizeJmdictForm(kana.text),
      kind: 'reb',
      // ["*"] (unrestricted) stores empty restr; explicit lists store targets;
      // [] (applies-to-none) is kana-only in effect: kept for kana matching
      // but flagged so a kanji observation can never claim it (H4 direction).
      restr: applies.restricted && !applies.appliesToNone ? applies.targets : [],
      isCommon: kana.common === true,
      nokanji: applies.appliesToNone === true
    });
  }

  const senses = [];
  const posSummary = [];
  senseList.forEach((sense, index) => {
    if (!sense || typeof sense !== 'object') throw new JmdictImportError(`sense ${index + 1} must be an object`, { entryId });
    const pos = Array.isArray(sense.partOfSpeech) ? sense.partOfSpeech.filter((p) => typeof p === 'string') : [];
    const stagk = resolveAppliesTo(sense.appliesToKanji, 'sense appliesToKanji');
    const stagr = resolveAppliesTo(sense.appliesToKana, 'sense appliesToKana');
    if (stagk.restricted && !stagk.appliesToNone) {
      for (const target of stagk.targets) {
        if (!kebSet.includes(target)) throw new JmdictImportError(`stagk target has no keb: ${target}`, { entryId });
      }
    }
    if (stagr.restricted && !stagr.appliesToNone) {
      for (const target of stagr.targets) {
        if (!rebSet.includes(target)) throw new JmdictImportError(`stagr target has no reb: ${target}`, { entryId });
      }
    }
    for (const tag of pos) if (!posSummary.includes(tag)) posSummary.push(tag);
    senses.push({
      senseNo: index + 1,
      pos,
      glossEn: englishGlosses(sense.gloss, entryId),
      stagk: stagk.restricted && !stagk.appliesToNone ? stagk.targets : [],
      stagr: stagr.restricted && !stagr.appliesToNone ? stagr.targets : [],
      stagkNone: stagk.appliesToNone === true,
      stagrNone: stagr.appliesToNone === true
    });
  });

  const record = { entSeq, posSummary, isCommon: forms.some((form) => form.isCommon), forms, senses };
  const checksum = sha256Hex(stableStringify(record));
  return {
    ...record,
    doc: { id: word.id, kanji: word.kanji, kana: word.kana, sense: word.sense },
    checksum
  };
}

// ---------------------------------------------------------------------------
// Snapshot lifecycle (privileged admin client only — never the runtime pool).
// ---------------------------------------------------------------------------

function snapshotIdentity(provenance) {
  const { sourceName = JMDICT_SOURCE_NAME, fileDate, converter = JMDICT_CONVERTER, converterVersion, sha256 } = provenance;
  if (!fileDate || !converterVersion || !sha256) {
    throw new JmdictImportError('provenance requires fileDate, converterVersion, and sha256; refusing untraceable snapshot');
  }
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new JmdictImportError('sha256 must be 64 lowercase hex characters');
  return { sourceName, fileDate, converter, converterVersion, sha256 };
}

async function findSnapshotByIdentity(client, identity) {
  const result = await client.query(
    'SELECT source_id, status FROM jmdict_sources WHERE source_name = $1 AND file_date = $2 AND converter = $3 AND converter_version = $4 AND sha256 = $5',
    [identity.sourceName, identity.fileDate, identity.converter, identity.converterVersion, identity.sha256]
  );
  return result.rows[0] || null;
}

async function activeSourceId(client) {
  const result = await client.query('SELECT source_id FROM jmdict_active_snapshot WHERE singleton = 1');
  return result.rows.length ? result.rows[0].source_id : null;
}

async function deleteSnapshotRows(client, sourceId) {
  // Children first for clarity (entries CASCADE covers forms/senses anyway),
  // source row last. Caller owns the transaction.
  await client.query('DELETE FROM jmdict_forms WHERE source_id = $1', [sourceId]);
  await client.query('DELETE FROM jmdict_senses WHERE source_id = $1', [sourceId]);
  await client.query('DELETE FROM jmdict_entries WHERE source_id = $1', [sourceId]);
  await client.query('DELETE FROM jmdict_sources WHERE source_id = $1', [sourceId]);
}

// Allocate a NEW source_id for an import. Idempotency: identical READY
// snapshot → reuse (no duplicate). Identical stuck/failed snapshot → restart
// under a FRESH source_id (never reuse a partial row set; never touch the
// ACTIVE snapshot or any other source_id).
async function allocateSnapshot(client, provenance) {
  const identity = snapshotIdentity(provenance);
  const existing = await findSnapshotByIdentity(client, identity);
  const active = await activeSourceId(client);
  if (existing) {
    if (existing.source_id === active) return { sourceId: existing.source_id, reused: true };
    if (existing.status === 'ready') return { sourceId: existing.source_id, reused: true };
    await deleteSnapshotRows(client, existing.source_id);
  }
  const inserted = await client.query(
    `INSERT INTO jmdict_sources
       (source_name, file_date, converter, converter_version, dict_revisions, ent_count, sha256, sha256_verified, importer_version, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'importing') RETURNING source_id`,
    [identity.sourceName, identity.fileDate, identity.converter, identity.converterVersion,
      provenance.dictRevisions || [], provenance.entCount || null, identity.sha256,
      provenance.sha256Verified === true, JMDICT_IMPORTER_VERSION]
  );
  return { sourceId: inserted.rows[0].source_id, reused: false };
}

async function setSnapshotStatus(client, sourceId, status, { entCount = null } = {}) {
  if (!SNAPSHOT_STATUSES.includes(status)) throw new JmdictImportError(`invalid snapshot status: ${status}`);
  await client.query('UPDATE jmdict_sources SET status = $1, ent_count = COALESCE($2, ent_count) WHERE source_id = $3', [status, entCount, sourceId]);
}

async function insertNormalizedBatch(client, sourceId, records) {
  // SQL-batched import (CA-B1.1): one batch = 1 entry upsert + 1 forms
  // DELETE + ceil(forms/chunk) forms INSERTs + 1 senses DELETE +
  // ceil(senses/chunk) senses INSERTs — independent of per-entry child counts.
  // Payloads ride a single jsonb parameter per statement (option C), so
  // unrestricted gloss/surface text needs no hand-built array literals and
  // the 65535-parameter ceiling never applies. Caller owns the transaction.
  //
  // Semantics are identical to the former per-row loop: same upsert target,
  // same source-scoped child replacement, same ON CONFLICT scope. One strict
  // difference: a duplicate ent_seq WITHIN one artifact now fails loudly
  // (ON CONFLICT cannot fire twice in one command) instead of last-wins —
  // fail-loud on corrupt input, consistent with this module's policy.
  if (!records.length) return { entries: 0, forms: 0, senses: 0, statements: 0 };
  let statements = 0;
  await client.query(
    `INSERT INTO jmdict_entries (source_id, ent_seq, doc, pos_summary, is_common, checksum)
     SELECT $1, batch.ent_seq, batch.doc, batch.pos_summary, batch.is_common, batch.checksum
     FROM jsonb_to_recordset($2::jsonb)
       AS batch(ent_seq bigint, doc jsonb, pos_summary text[], is_common boolean, checksum text)
     ON CONFLICT (source_id, ent_seq) DO UPDATE SET
       doc = EXCLUDED.doc, pos_summary = EXCLUDED.pos_summary,
       is_common = EXCLUDED.is_common, checksum = EXCLUDED.checksum`,
    [sourceId, JSON.stringify(records.map((record) => ({
      ent_seq: record.entSeq,
      doc: record.doc,
      pos_summary: record.posSummary,
      is_common: record.isCommon,
      checksum: record.checksum
    })))]
  );
  statements += 1;
  const entryIds = records.map((record) => record.entSeq);
  const formPayload = [];
  const sensePayload = [];
  for (const record of records) {
    for (const form of record.forms) {
      formPayload.push({
        entry_id: record.entSeq,
        surface: form.surface,
        normalized: form.normalized,
        kind: form.kind,
        restr: form.restr,
        is_common: form.isCommon,
        nokanji: form.nokanji
      });
    }
    for (const sense of record.senses) {
      sensePayload.push({
        entry_id: record.entSeq,
        sense_no: sense.senseNo,
        pos: sense.pos,
        gloss_en: sense.glossEn,
        stagk: sense.stagk,
        stagr: sense.stagr
      });
    }
  }
  // Children are set-replaced per batch: within one source_id this is
  // restart-idempotent and cannot affect other snapshots or entries
  // outside the batch.
  await client.query('DELETE FROM jmdict_forms WHERE source_id = $1 AND entry_id = ANY($2::bigint[])', [sourceId, entryIds]);
  statements += 1;
  for (const chunk of chunkRows(formPayload, BULK_CHUNK_ROWS)) {
    await client.query(
      `INSERT INTO jmdict_forms (source_id, entry_id, surface, normalized, kind, restr, is_common, nokanji)
       SELECT $1, batch.entry_id, batch.surface, batch.normalized, batch.kind, batch.restr, batch.is_common, batch.nokanji
       FROM jsonb_to_recordset($2::jsonb)
         AS batch(entry_id bigint, surface text, normalized text, kind text, restr text[], is_common boolean, nokanji boolean)`,
      [sourceId, JSON.stringify(chunk)]
    );
    statements += 1;
  }
  await client.query('DELETE FROM jmdict_senses WHERE source_id = $1 AND entry_id = ANY($2::bigint[])', [sourceId, entryIds]);
  statements += 1;
  for (const chunk of chunkRows(sensePayload, BULK_CHUNK_ROWS)) {
    await client.query(
      `INSERT INTO jmdict_senses (source_id, entry_id, sense_no, pos, gloss_en, stagk, stagr)
       SELECT $1, batch.entry_id, batch.sense_no, batch.pos, batch.gloss_en, batch.stagk, batch.stagr
       FROM jsonb_to_recordset($2::jsonb)
         AS batch(entry_id bigint, sense_no integer, pos text[], gloss_en text[], stagk text[], stagr text[])`,
      [sourceId, JSON.stringify(chunk)]
    );
    statements += 1;
  }
  return { entries: records.length, forms: formPayload.length, senses: sensePayload.length, statements };
}

// Integrity checks. Fail validation on correctness-critical corruption —
// especially restriction orphans (restriction loss can later manufacture
// false semantic certainty). Returns check list; throws on any failure.
async function verifySnapshot(client, sourceId) {
  const checks = [];
  const check = async (name, sql, params, expectZero, detail) => {
    const result = await client.query(sql, params);
    const value = Number(result.rows[0].value);
    const ok = expectZero ? value === 0 : value > 0;
    checks.push({ name, ok, value, detail });
    return ok;
  };
  let ok = true;
  ok = await check('entries_present', 'SELECT COUNT(1)::int AS value FROM jmdict_entries WHERE source_id = $1', [sourceId], false, 'imported entry rows') && ok;
  ok = await check('forms_present', 'SELECT COUNT(1)::int AS value FROM jmdict_forms WHERE source_id = $1', [sourceId], false, 'imported form rows') && ok;
  ok = await check('senses_present', 'SELECT COUNT(1)::int AS value FROM jmdict_senses WHERE source_id = $1', [sourceId], false, 'imported sense rows') && ok;
  ok = await check(
    'entry_count_matches_source', 'SELECT (COUNT(1)::int - COALESCE((SELECT ent_count FROM jmdict_sources WHERE source_id = $1), COUNT(1)::int)) = 0 AS value FROM jmdict_entries WHERE source_id = $1',
    [sourceId], false, 'imported entries equal recorded ent_count'
  ) && ok;
  ok = await check(
    'no_orphan_forms', 'SELECT COUNT(1)::int AS value FROM jmdict_forms f LEFT JOIN jmdict_entries e ON e.source_id = f.source_id AND e.ent_seq = f.entry_id WHERE f.source_id = $1 AND e.ent_seq IS NULL',
    [sourceId], true, 'forms without entries'
  ) && ok;
  ok = await check(
    'no_orphan_senses', 'SELECT COUNT(1)::int AS value FROM jmdict_senses s LEFT JOIN jmdict_entries e ON e.source_id = s.source_id AND e.ent_seq = s.entry_id WHERE s.source_id = $1 AND e.ent_seq IS NULL',
    [sourceId], true, 'senses without entries'
  ) && ok;
  ok = await check(
    'no_restr_orphans', `SELECT COUNT(1)::int AS value FROM jmdict_forms f
      CROSS JOIN LATERAL UNNEST(f.restr) AS target
      WHERE f.source_id = $1 AND NOT EXISTS (
        SELECT 1 FROM jmdict_forms keb WHERE keb.source_id = f.source_id AND keb.entry_id = f.entry_id AND keb.kind = 'keb' AND keb.surface = target
      )`, [sourceId], true, 'reading restrictions without matching keb'
  ) && ok;
  ok = await check(
    'no_stagk_orphans', `SELECT COUNT(1)::int AS value FROM jmdict_senses s
      CROSS JOIN LATERAL UNNEST(s.stagk) AS target
      WHERE s.source_id = $1 AND NOT EXISTS (
        SELECT 1 FROM jmdict_forms keb WHERE keb.source_id = s.source_id AND keb.entry_id = s.entry_id AND keb.kind = 'keb' AND keb.surface = target
      )`, [sourceId], true, 'stagk targets without matching keb'
  ) && ok;
  ok = await check(
    'no_stagr_orphans', `SELECT COUNT(1)::int AS value FROM jmdict_senses s
      CROSS JOIN LATERAL UNNEST(s.stagr) AS target
      WHERE s.source_id = $1 AND NOT EXISTS (
        SELECT 1 FROM jmdict_forms reb WHERE reb.source_id = s.source_id AND reb.entry_id = s.entry_id AND reb.kind = 'reb' AND reb.surface = target
      )`, [sourceId], true, 'stagr targets without matching reb'
  ) && ok;
  ok = await check(
    'no_glossless_senses', 'SELECT COUNT(1)::int AS value FROM jmdict_senses WHERE source_id = $1 AND gloss_en = \'{}\'',
    [sourceId], true, 'senses with empty English gloss list'
  ) && ok;
  const failures = checks.filter((item) => !item.ok);
  if (failures.length) {
    throw new JmdictImportError(`integrity validation failed: ${failures.map((item) => `${item.name}=${item.value}`).join(', ')}`, { sourceId });
  }
  return checks;
}

// POS family patterns for the C1 audit. Applied to raw JMdict entity codes
// stored verbatim. Values matching no family are reported as unknown so DTD
// evolution is surfaced, never silently absorbed.
const POS_FAMILIES = [
  [/^v1\b/i, 'v1'], [/^v5/i, 'v5'], [/^vk\b/i, 'vk'], [/^vs/i, 'vs'], [/^vz\b/i, 'vz'],
  [/^v2/i, 'verb-archaic'], [/^v4/i, 'verb-archaic'],
  [/^vn\b/i, 'verb-unspec'], [/^vr\b/i, 'verb-unspec'], [/^v-unspec\b/i, 'verb-unspec'],
  [/^vi\b/i, 'vi'], [/^vt\b/i, 'vt'],
  [/^adj-i/i, 'adj-i'], [/^adj-na/i, 'adj-na'], [/^adj-no/i, 'adj-no'],
  [/^adj-pn/i, 'adj-pn'], [/^adj-f/i, 'adj-f'], [/^adj-/i, 'adj-other'],
  [/^adv/i, 'adv'], [/^n-(suf|pref)/i, 'noun-affix'], [/^n([-$]|$)/i, 'noun'], [/^int\b/i, 'int'], [/^exp\b/i, 'exp'],
  [/^aux/i, 'aux'], [/^cop/i, 'cop'], [/^conj\b/i, 'conj'], [/^prt\b/i, 'prt'],
  [/^pref/i, 'pref'], [/^suf/i, 'suff'], [/^ctr\b/i, 'ctr'], [/^num\b/i, 'num'], [/^pn\b/i, 'pn']
];

function classifyPosCode(code) {
  for (const [pattern, family] of POS_FAMILIES) if (pattern.test(code)) return family;
  return null;
}

// C1 linguistic/import audit. Returns measured counts; throws nothing.
// maxSensesPerEntry answers the CA-B2 valve question (valve = 64).
async function auditSnapshot(client, sourceId) {
  const one = async (sql, params = []) => Number((await client.query(sql, params)).rows[0].value);
  const distinctPos = (await client.query(
    'SELECT DISTINCT UNNEST(pos) AS code FROM jmdict_senses WHERE source_id = $1 ORDER BY 1', [sourceId]
  )).rows.map((row) => row.code);
  const unknownPos = distinctPos.filter((code) => classifyPosCode(code) === null);
  const familyCounts = {};
  for (const code of distinctPos) {
    const family = classifyPosCode(code) || 'unknown';
    const count = await one(
      'SELECT COUNT(DISTINCT (source_id, entry_id))::int AS value FROM jmdict_senses WHERE source_id = $1 AND pos @> ARRAY[$2]',
      [sourceId, code]
    );
    familyCounts[`${family}:${code}`] = count;
  }
  const verbFamilies = {};
  // NOTE: PostgreSQL ARE has no \b word boundary (\b is backspace); use
  // explicit ($|-) anchors instead. JS-side POS_FAMILIES keeps \b correctly.
  const verbPatterns = { v1: '^v1($|-)', v5: '^v5', vk: '^vk($|-)', vs: '^vs($|-)' };
  for (const [family, pattern] of Object.entries(verbPatterns)) {
    verbFamilies[family] = await one(
      `SELECT COUNT(DISTINCT (source_id, entry_id))::int AS value FROM jmdict_senses s
       WHERE s.source_id = $1 AND EXISTS (SELECT 1 FROM UNNEST(s.pos) code WHERE code ~* $2)`,
      [sourceId, pattern]
    );
  }
  return {
    sourceId,
    entries: await one('SELECT COUNT(1)::int AS value FROM jmdict_entries WHERE source_id = $1', [sourceId]),
    forms: await one('SELECT COUNT(1)::int AS value FROM jmdict_forms WHERE source_id = $1', [sourceId]),
    kebForms: await one("SELECT COUNT(1)::int AS value FROM jmdict_forms WHERE source_id = $1 AND kind = 'keb'", [sourceId]),
    rebForms: await one("SELECT COUNT(1)::int AS value FROM jmdict_forms WHERE source_id = $1 AND kind = 'reb'", [sourceId]),
    senses: await one('SELECT COUNT(1)::int AS value FROM jmdict_senses WHERE source_id = $1', [sourceId]),
    sensesRestrictedStagk: await one('SELECT COUNT(1)::int AS value FROM jmdict_senses WHERE source_id = $1 AND stagk <> \'{}\'', [sourceId]),
    sensesRestrictedStagr: await one('SELECT COUNT(1)::int AS value FROM jmdict_senses WHERE source_id = $1 AND stagr <> \'{}\'', [sourceId]),
    formsRestrictedRestr: await one('SELECT COUNT(1)::int AS value FROM jmdict_forms WHERE source_id = $1 AND restr <> \'{}\'', [sourceId]),
    formsNokanji: await one('SELECT COUNT(1)::int AS value FROM jmdict_forms WHERE source_id = $1 AND nokanji', [sourceId]),
    entriesWithStagk: await one('SELECT COUNT(DISTINCT (source_id, entry_id))::int AS value FROM jmdict_senses WHERE source_id = $1 AND stagk <> \'{}\'', [sourceId]),
    entriesWithStagr: await one('SELECT COUNT(DISTINCT (source_id, entry_id))::int AS value FROM jmdict_senses WHERE source_id = $1 AND stagr <> \'{}\'', [sourceId]),
    entriesNounAdjNaOverlap: await one(
      `SELECT COUNT(1)::int AS value FROM jmdict_entries e WHERE e.source_id = $1
       AND EXISTS (SELECT 1 FROM jmdict_senses s WHERE s.source_id = e.source_id AND s.entry_id = e.ent_seq AND s.pos && ARRAY['n','n-t','n-adv','n-suf','n-pref'])
       AND EXISTS (SELECT 1 FROM jmdict_senses s WHERE s.source_id = e.source_id AND s.entry_id = e.ent_seq AND s.pos @> ARRAY['adj-na'])`,
      [sourceId]
    ),
    sensesNounAdjNaOverlap: await one(
      `SELECT COUNT(1)::int AS value FROM jmdict_senses WHERE source_id = $1
       AND pos && ARRAY['n','n-t','n-adv','n-suf','n-pref'] AND pos @> ARRAY['adj-na']`,
      [sourceId]
    ),
    verbFamilies,
    distinctPosCount: distinctPos.length,
    unknownPos,
    maxSensesPerEntry: await one(
      'SELECT COALESCE(MAX(c), 0)::int AS value FROM (SELECT COUNT(1) AS c FROM jmdict_senses WHERE source_id = $1 GROUP BY entry_id) t',
      [sourceId]
    ),
    evalValve: JMDICT_EVAL_SENSE_VALVE
  };
}

async function activateSnapshot(client, sourceId) {
  const row = (await client.query('SELECT status FROM jmdict_sources WHERE source_id = $1', [sourceId])).rows[0];
  if (!row) throw new JmdictImportError(`snapshot not found: ${sourceId}`, { sourceId });
  if (row.status !== 'ready') throw new JmdictImportError(`only ready snapshots may activate (status=${row.status})`, { sourceId });
  await client.query('BEGIN');
  try {
    await client.query('UPDATE jmdict_active_snapshot SET source_id = $1, switched_at = CURRENT_TIMESTAMP WHERE singleton = 1', [sourceId]);
    await client.query('UPDATE jmdict_sources SET activated_at = CURRENT_TIMESTAMP WHERE source_id = $1', [sourceId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

// Rollback = atomic pointer switch to the most recently activated ready
// snapshot that is not currently active. Content is untouched (immutability).
async function rollbackSnapshot(client) {
  const active = await activeSourceId(client);
  const previous = (await client.query(
    `SELECT source_id FROM jmdict_sources
     WHERE status = 'ready' AND ($1::bigint IS NULL OR source_id <> $1::bigint) AND activated_at IS NOT NULL
     ORDER BY activated_at DESC, source_id DESC LIMIT 1`,
    [active]
  )).rows[0];
  if (!previous) throw new JmdictImportError('no previous ready snapshot to roll back to');
  await activateSnapshot(client, previous.source_id);
  return { sourceId: previous.source_id, previousActive: active };
}

// Prune an inactive snapshot. Refuses the ACTIVE snapshot and the newest
// ACTIVATED non-active snapshot (the rollback target) so rollback can never
// be destroyed by accident. Never-activated snapshots are safe to prune.
// Explicit admin action only; runtime cannot prune.
async function pruneSnapshot(client, sourceId) {
  const active = await activeSourceId(client);
  // pg returns bigint as string; compare numerically (CLI passes Numbers).
  if (Number(sourceId) === Number(active)) throw new JmdictImportError(`refusing to prune the ACTIVE snapshot (${sourceId})`, { sourceId });
  const newestActivated = (await client.query(
    `SELECT source_id FROM jmdict_sources
     WHERE status = 'ready' AND activated_at IS NOT NULL AND ($1::bigint IS NULL OR source_id <> $1::bigint)
     ORDER BY activated_at DESC, source_id DESC LIMIT 1`,
    [active]
  )).rows[0];
  if (newestActivated && Number(newestActivated.source_id) === Number(sourceId)) {
    throw new JmdictImportError(`refusing to prune the rollback-target snapshot (${sourceId}); activate another snapshot first`, { sourceId });
  }
  const exists = (await client.query('SELECT 1 FROM jmdict_sources WHERE source_id = $1', [sourceId])).rowCount;
  if (!exists) throw new JmdictImportError(`snapshot not found: ${sourceId}`, { sourceId });
  await client.query('BEGIN');
  try {
    await deleteSnapshotRows(client, sourceId);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function snapshotStatus(client) {
  const active = await activeSourceId(client);
  const sources = (await client.query(
    `SELECT s.source_id, s.source_name, s.file_date, s.converter, s.converter_version,
            s.ent_count, s.sha256, s.sha256_verified, s.importer_version, s.status,
            s.created_at, s.activated_at,
            (SELECT COUNT(1)::int FROM jmdict_entries e WHERE e.source_id = s.source_id) AS entries
     FROM jmdict_sources s ORDER BY s.source_id`
  )).rows;
  return { activeSourceId: active, sources };
}

module.exports = {
  JMDICT_SOURCE_NAME,
  JMDICT_CONVERTER,
  JMDICT_IMPORTER_VERSION,
  IMPORT_BATCH_SIZE,
  BULK_CHUNK_ROWS,
  SNAPSHOT_STATUSES,
  JMDICT_EVAL_SENSE_VALVE,
  JmdictImportError,
  normalizeJmdictForm,
  hasHanCharacter,
  normalizeJmdictWord,
  snapshotIdentity,
  findSnapshotByIdentity,
  POS_FAMILIES,
  classifyPosCode,
  activeSourceId,
  allocateSnapshot,
  setSnapshotStatus,
  insertNormalizedBatch,
  verifySnapshot,
  auditSnapshot,
  activateSnapshot,
  rollbackSnapshot,
  pruneSnapshot,
  snapshotStatus,
  stableStringify,
  sha256Hex
};
