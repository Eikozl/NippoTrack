const pool = require('../config/db');
const { ValidationError } = require('../errors/http');
const { loadGrammarCatalog } = require('./grammarReference');

function serializeReference(row) {
  if (!row) return null;
  return {
    referenceId: Number(row.id_grammar_reference ?? row.reference_id),
    grammarPoint: row.grammar_point,
    kana: row.kana || null,
    romaji: row.romaji || null,
    meaning: row.meaning,
    summary: row.summary || null,
    structures: row.structures || [],
    pitfalls: row.pitfalls || [],
    examples: row.examples || [],
    jlptLevel: row.jlpt_level,
    source: row.source,
    sourceSlug: row.source_slug,
    sourceCommit: row.source_commit
  };
}

async function findGrammarReferenceId(referenceId) {
  if (referenceId === undefined || referenceId === null || referenceId === '') return null;
  const id = Number(referenceId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ValidationError('reference_id must be a positive integer.');
  const [rows] = await pool.execute('SELECT id_grammar_reference FROM grammar_reference WHERE id_grammar_reference = ?', [id]);
  if (!rows[0]) throw new ValidationError('Grammar reference not found.');
  return id;
}

async function getGrammarReferenceById(id) {
  const [rows] = await pool.execute('SELECT * FROM grammar_reference WHERE id_grammar_reference = ?', [id]);
  return serializeReference(rows[0]);
}

async function searchGrammarReferences(query, limit = 8) {
  const size = Math.min(Math.max(Number(limit) || 8, 1), 20);
  const needle = `%${String(query || '').normalize('NFKC').trim()}%`;
  const [rows] = await pool.execute(
    `SELECT id_grammar_reference, grammar_point, kana, romaji, meaning, summary, structures, pitfalls, examples, jlpt_level, source, source_slug, source_commit
     FROM grammar_reference WHERE grammar_point ILIKE ? OR kana ILIKE ? OR romaji ILIKE ? OR meaning ILIKE ? OR summary ILIKE ?
     ORDER BY CASE WHEN grammar_point ILIKE ? THEN 0 ELSE 1 END, grammar_point LIMIT ?`,
    [needle, needle, needle, needle, needle, `${String(query || '').trim()}%`, size]
  );
  return { items: rows.map(serializeReference) };
}

async function importGrammarReferences(client, catalog = loadGrammarCatalog()) {
  let upserted = 0;
  for (const item of catalog) {
    await client.query(
      `INSERT INTO grammar_reference (reference_key, grammar_point, kana, romaji, meaning, summary, structures, pitfalls, examples, jlpt_level, source, source_slug, source_commit)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12,$13)
       ON CONFLICT (reference_key) DO UPDATE SET grammar_point = EXCLUDED.grammar_point, kana = EXCLUDED.kana, romaji = EXCLUDED.romaji, meaning = EXCLUDED.meaning, summary = EXCLUDED.summary, structures = EXCLUDED.structures, pitfalls = EXCLUDED.pitfalls, examples = EXCLUDED.examples, jlpt_level = EXCLUDED.jlpt_level, source_commit = EXCLUDED.source_commit`,
      [item.referenceKey, item.grammarPoint, item.kana, item.romaji, item.meaning, item.summary, JSON.stringify(item.structures), JSON.stringify(item.pitfalls), JSON.stringify(item.examples), item.jlptLevel, item.source, item.sourceSlug, item.sourceCommit]
    );
    upserted += 1;
  }
  await client.query(`UPDATE grammar_points g SET reference_id = r.id_grammar_reference FROM (SELECT lower(trim(grammar_point)) key, min(id_grammar_reference) id_grammar_reference FROM grammar_reference GROUP BY lower(trim(grammar_point)) HAVING count(*) = 1) r WHERE g.reference_id IS NULL AND lower(trim(g.grammar_point)) = r.key`);
  return { upserted };
}

async function hydrateGrammarMatches(userId, matches) {
  const list = Array.isArray(matches) ? matches : [];
  const slugs = [...new Set(list.flatMap((match) => match.status === 'AMBIGUOUS' ? match.sourceSlugs : [match.sourceSlug]).filter(Boolean))];
  if (!slugs.length) return [];
  const placeholders = slugs.map(() => '?').join(', ');
  const [references] = await pool.execute(`SELECT * FROM grammar_reference WHERE source = 'nihongo-mono' AND source_slug IN (${placeholders})`, slugs);
  const bySlug = new Map(references.map((row) => [row.source_slug, serializeReference(row)]));
  const ids = references.map((row) => row.id_grammar_reference);
  const owned = new Map();
  if (ids.length) {
    const [rows] = await pool.execute(`SELECT id_grammar, reference_id FROM grammar_points WHERE user_id = ? AND reference_id IN (${ids.map(() => '?').join(', ')})`, [userId, ...ids]);
    rows.forEach((row) => owned.set(Number(row.reference_id), Number(row.id_grammar)));
  }
  return list.map((match) => {
    if (match.status === 'AMBIGUOUS') return { familyId: match.familyId, status: 'AMBIGUOUS', detected: match.detected, references: match.sourceSlugs.map((slug) => bySlug.get(slug)).filter(Boolean) };
    const reference = bySlug.get(match.sourceSlug);
    if (!reference) return null;
    return { ruleId: match.ruleId || match.familyId, status: 'DETERMINATE', detected: match.detected, reference, collection: { inGrammar: owned.has(reference.referenceId), grammarId: owned.get(reference.referenceId) || null } };
  }).filter(Boolean);
}

module.exports = { findGrammarReferenceId, getGrammarReferenceById, hydrateGrammarMatches, importGrammarReferences, searchGrammarReferences, serializeReference };
