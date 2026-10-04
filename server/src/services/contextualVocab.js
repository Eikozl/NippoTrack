// Contextual vocabulary: cloze sentences built from the learner's own saved
// examples, plus tag suggestions from a small local heuristic (suggestions
// only — nothing is ever auto-applied). Assignment reuses the existing
// tags/tag_vocabulary tables; no new tables, no new dependencies.
const CLOZE_BLANK = '＿＿';

function buildCloze(sentence, word, reading) {
  const text = String(sentence || '');
  if (!text) return null;
  const candidates = [word, reading].map((value) => String(value || '').trim()).filter(Boolean);
  // Longest first so a reading never shadows a longer word form.
  candidates.sort((a, b) => b.length - a.length);
  for (const candidate of candidates) {
    if (text.includes(candidate)) {
      return { sentence: text, cloze: text.replace(candidate, CLOZE_BLANK) };
    }
  }
  return null;
}

function normalizeTagName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 60);
}

// Fixed suggestion vocabulary with local matchers over the entry's own
// word/reading/meaning. Heuristic, documented, and never stored silently.
const TAG_RULES = [
  { tag: 'verb', test: ({ meaning }) => /\bto [a-z]/i.test(meaning) || /\(.*\bv[i1]\b.*\)/i.test(meaning) },
  { tag: 'noun', test: ({ meaning }) => /^(the|a|an) /i.test(meaning) },
  { tag: 'adjective', test: ({ meaning }) => /adjective/i.test(meaning) || /\(.*\bn?a?adj.*\)/i.test(meaning) },
  { tag: 'adverb', test: ({ meaning }) => /\badverb/i.test(meaning) },
  { tag: 'onomatopoeia', test: ({ word, meaning }) => /onomatopoe/i.test(meaning) || /^([ぁ-んァ-ヶー]{2,})\1$/.test(word) },
  { tag: 'polite', test: ({ word, meaning }) => /\bpolite\b/i.test(meaning) || /^[おご][一-鿿ぁ-んァ-ヶー]/.test(word) },
  { tag: 'casual', test: ({ meaning }) => /\bcasual\b|\bslang\b|\brough\b|\bcolloquial\b/i.test(meaning) },
  { tag: 'question', test: ({ word, meaning }) => /[か?？]$/.test(word) || /^(what|who|where|when|why|how)\b/i.test(meaning) },
  { tag: 'food', test: ({ meaning }) => /\b(food|eat|drink|rice|meal|cook|taste|sweet|fish|meat|vegetable|fruit)\b/i.test(meaning) },
  { tag: 'travel', test: ({ meaning }) => /\b(travel|trip|station|train|airport|hotel|ticket|map|abroad)\b/i.test(meaning) },
  { tag: 'study', test: ({ meaning }) => /\b(study|learn|school|exam|homework|student|teacher|read|write)\b/i.test(meaning) },
  { tag: 'business', test: ({ meaning }) => /\b(business|company|office|meeting|work|job|salary|client)\b/i.test(meaning) },
  { tag: 'daily', test: ({ meaning }) => /\b(daily|everyday|home|family|morning|evening|life|living)\b/i.test(meaning) }
];

function suggestTags({ word = '', reading = '', meaning = '' } = {}) {
  const entry = { word: String(word || ''), reading: String(reading || ''), meaning: String(meaning || '') };
  const suggested = [];
  for (const rule of TAG_RULES) {
    try {
      if (rule.test(entry)) suggested.push(rule.tag);
    } catch { /* a rule never breaks suggestions */ }
  }
  return suggested;
}

async function fetchVocabItem(executor, id, userId) {
  const [rows] = await executor.execute(
    'SELECT id_vocabulary, word, reading, meaning FROM vocabulary WHERE id_vocabulary = ? AND user_id = ?',
    [id, userId]
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function getClozeSentences(executor, id, userId) {
  const item = await fetchVocabItem(executor, id, userId);
  if (!item) return null;
  const [rows] = await executor.execute(
    'SELECT id_usage_example, sentence, translation FROM usage_examples WHERE id_vocabulary = ? ORDER BY id_usage_example ASC',
    [id]
  );
  const sentences = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const built = buildCloze(row?.sentence, item.word, item.reading);
    if (!built) continue;
    sentences.push({
      id: row.id_usage_example,
      sentence: built.sentence,
      cloze: built.cloze,
      translation: row.translation || null,
      source: 'example'
    });
  }
  return { item: { id: item.id_vocabulary, word: item.word, reading: item.reading }, sentences };
}

async function getVocabTags(executor, id, userId) {
  const item = await fetchVocabItem(executor, id, userId);
  if (!item) return null;
  const [rows] = await executor.execute(
    `SELECT t.id_tag, t.name FROM tags t
     JOIN tag_vocabulary tv ON tv.id_tag = t.id_tag
     WHERE tv.id_vocabulary = ? AND t.user_id = ? ORDER BY t.name ASC`,
    [id, userId]
  );
  const assigned = (Array.isArray(rows) ? rows : []).map((row) => ({ id: row.id_tag, name: row.name }));
  const assignedNames = new Set(assigned.map((entry) => normalizeTagName(entry.name)));
  const suggested = suggestTags(item).filter((tag) => !assignedNames.has(tag));
  return { assigned, suggested };
}

async function replaceVocabTags(executor, id, userId, names) {
  const item = await fetchVocabItem(executor, id, userId);
  if (!item) return null;
  const wanted = [...new Set((Array.isArray(names) ? names : []).map(normalizeTagName).filter(Boolean))].slice(0, 20);
  // Tags live per user (UNIQUE (user_id, normalized_name) since the
  // multi-user migrations): scope every touch by the requester.
  for (const name of wanted) {
    await executor.execute(
      'INSERT INTO tags (user_id, name, normalized_name) VALUES (?, ?, ?) ON CONFLICT (user_id, normalized_name) DO NOTHING',
      [userId, name, name]
    );
  }
  await executor.execute('DELETE FROM tag_vocabulary WHERE id_vocabulary = ?', [id]);
  for (const name of wanted) {
    await executor.execute(
      `INSERT INTO tag_vocabulary (id_tag, id_vocabulary)
       SELECT id_tag, ? FROM tags WHERE normalized_name = ? AND user_id = ?
       ON CONFLICT DO NOTHING`,
      [id, name, userId]
    );
  }
  const [rows] = await executor.execute(
    'SELECT t.id_tag, t.name FROM tags t JOIN tag_vocabulary tv ON tv.id_tag = t.id_tag WHERE tv.id_vocabulary = ? AND t.user_id = ? ORDER BY t.name ASC',
    [id, userId]
  );
  return (Array.isArray(rows) ? rows : []).map((row) => ({ id: row.id_tag, name: row.name }));
}

module.exports = {
  buildCloze,
  CLOZE_BLANK,
  getClozeSentences,
  getVocabTags,
  normalizeTagName,
  replaceVocabTags,
  suggestTags
};
