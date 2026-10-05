// Story Registry extraction (V5.6 phase 1): pasted-text analysis shaped for
// stories, reusing the immersion engine (deterministic analysis + idempotent
// entity creation). Never trusts client word/meaning payloads: enroll
// re-runs the analysis and intersects by candidate id keys, exactly like
// createImmersionSession.
const { ValidationError } = require('../errors/http');
const { extractHanOccurrences } = require('./kanjiVocabularyLinks');
const {
  MAX_IMMERSION_TEXT_LENGTH,
  ensureGrammarEntities,
  ensureKanjiEntities,
  ensureVocabularyEntities,
  intersectSelected,
  runAnalysis,
  truncateCodePoints
} = require('./immersionPipeline');

const REVIEW_TARGET_COLUMN = { vocabulary: 'id_vocabulary', kanji: 'id_kanji', grammar: 'id_grammar' };

function validateStoryText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new ValidationError('text is required and must not be empty.');
  }
  if (Array.from(text).length > MAX_IMMERSION_TEXT_LENGTH) {
    throw new ValidationError(`text exceeds the maximum length of ${MAX_IMMERSION_TEXT_LENGTH} characters.`);
  }
  return text;
}

async function previewExtraction(executor, userId, text) {
  const sourceText = validateStoryText(text);
  const analysis = await runAnalysis(executor, userId, sourceText);
  const frequencies = new Map(extractHanOccurrences(sourceText).map((entry) => [entry.character, entry.occurrences]));
  return {
    kanji: analysis.candidates.kanji.map((candidate) => ({
      id: candidate.id,
      char: candidate.display,
      reading: candidate.reading || null,
      meaning: candidate.meaning || null,
      frequency: frequencies.get(candidate.display) || 1
    })),
    vocab: analysis.candidates.vocabulary.map((candidate) => ({
      id: candidate.id,
      word: candidate.display,
      reading: candidate.reading || null,
      meaning: candidate.meaning || null,
      frequency: 1
    })),
    grammar: analysis.candidates.grammar.map((candidate) => ({
      id: candidate.id,
      pattern: candidate.display,
      meaning: candidate.meaning || null,
      example: null
    }))
  };
}

async function fetchStory(executor, id, userId) {
  const [rows] = await executor.execute(
    'SELECT * FROM content_entries WHERE id_content_entry = ? AND user_id = ?',
    [id, userId]
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function enrollStoryItems(executor, userId, storyId, selectedIds) {
  const story = await fetchStory(executor, storyId, userId);
  if (!story) return null;
  if (!story.source_text) throw new ValidationError('story has no text to extract from.');
  if (!Array.isArray(selectedIds) || !selectedIds.length) {
    throw new ValidationError('selected must be a non-empty array of candidate id strings.');
  }
  const selectedKeys = new Set();
  for (const key of selectedIds) {
    if (typeof key !== 'string' || !key) throw new ValidationError('selected must contain only non-empty candidate id strings.');
    selectedKeys.add(key);
  }
  const analysis = await runAnalysis(executor, userId, story.source_text);
  const chosen = {
    vocabulary: intersectSelected(analysis.candidates.vocabulary, selectedKeys),
    kanji: intersectSelected(analysis.candidates.kanji, selectedKeys),
    grammar: intersectSelected(analysis.candidates.grammar, selectedKeys)
  };
  const connection = typeof executor.getConnection === 'function' ? await executor.getConnection() : null;
  const db = connection || executor;
  try {
    if (connection && typeof connection.beginTransaction === 'function') await connection.beginTransaction();
    const vocabularyResult = await ensureVocabularyEntities(db, userId, chosen.vocabulary);
    const kanjiResult = await ensureKanjiEntities(db, userId, chosen.kanji, analysis.internals.referenceByCharacter);
    const grammarResult = await ensureGrammarEntities(db, userId, chosen.grammar, analysis.internals.grammarInternals);
    const targets = ['vocabulary', 'kanji', 'grammar'].flatMap((entityType) => {
      const ids = { vocabulary: vocabularyResult.ids, kanji: kanjiResult.ids, grammar: grammarResult.ids }[entityType];
      return [...ids.values()].map((entityId) => [REVIEW_TARGET_COLUMN[entityType], entityType, entityId]);
    });
    for (const [targetColumn, , targetId] of targets) {
      await db.execute(
        `INSERT INTO review_items (${targetColumn}, due_on, interval_days) VALUES (?, CURRENT_DATE, 0) ON CONFLICT (${targetColumn}) DO NOTHING`,
        [targetId]
      );
    }
    const createdIds = [];
    for (const [targetColumn, entityType, targetId] of targets) {
      const [rows] = await db.execute(
        `SELECT id_review_item FROM review_items WHERE ${targetColumn} = ?`,
        [targetId]
      );
      const row = Array.isArray(rows) ? rows[0] : null;
      if (row && Number.isInteger(Number(row.id_review_item))) {
        createdIds.push({ entityType, reviewItemId: Number(row.id_review_item) });
        await db.execute(
          'INSERT INTO story_review_links (id_content_entry, id_review_item) VALUES (?, ?) ON CONFLICT DO NOTHING',
          [storyId, Number(row.id_review_item)]
        );
      }
    }
    // Open review session for today (mirrors immersion step 2) so the dialog
    // can hand off straight into REVIEWING with server-resolved items.
    let reviewSessionId = null;
    const displayByKey = new Map();
    for (const [entityType, candidates, ids] of [
      ['vocabulary', chosen.vocabulary, vocabularyResult.ids],
      ['kanji', chosen.kanji, kanjiResult.ids],
      ['grammar', chosen.grammar, grammarResult.ids]
    ]) {
      for (const candidate of candidates) {
        const entityId = ids.get(candidate.id);
        if (Number.isInteger(entityId)) displayByKey.set(`${entityType}::${entityId}`, candidate);
      }
    }
    const queueItems = [];
    if (targets.length) {
      const [sessionResult] = await db.execute(
        'INSERT INTO review_sessions (user_id, source_from, source_to) VALUES (?, CURRENT_DATE, CURRENT_DATE) RETURNING id_review_session AS insertId',
        [userId]
      );
      reviewSessionId = Number(sessionResult?.insertId);
      if (!Number.isInteger(reviewSessionId)) throw new Error('Unable to start the review session.');
      const seen = new Set();
      for (const [, entityType, targetId] of targets) {
        const key = `${entityType}::${targetId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const candidate = displayByKey.get(key) || {};
        queueItems.push({
          entityType,
          entityId: targetId,
          display: candidate.display || '',
          reading: candidate.reading || null,
          meaning: candidate.meaning || null
        });
      }
      await db.execute(
        `INSERT INTO review_session_items (id_review_session, entity_type, entity_id, position) VALUES ${queueItems.map(() => '(?, ?, ?, ?)').join(', ')}`,
        queueItems.flatMap(({ entityType, entityId }, position) => [reviewSessionId, entityType, entityId, position])
      );
    }
    const extracted = {
      kanji: chosen.kanji.length,
      vocab: chosen.vocabulary.length,
      grammar: chosen.grammar.length
    };
    await db.execute(
      "UPDATE content_entries SET extracted_json = ?::jsonb, processing_status = 'completed', extraction_error = NULL WHERE id_content_entry = ? AND user_id = ?",
      [JSON.stringify({ enrolled: extracted }), storyId, userId]
    );
    if (connection && typeof connection.commit === 'function') await connection.commit();
    if (connection && typeof connection.release === 'function') {
      try { await connection.release(); } catch { /* release is best-effort */ }
    }
    return {
      created: createdIds.length,
      reviewItems: createdIds,
      reviewSessionId,
      queueItems,
      items: [
        ...chosen.vocabulary.map((candidate) => ({ entityType: 'vocabulary', display: candidate.display })),
        ...chosen.kanji.map((candidate) => ({ entityType: 'kanji', display: candidate.display })),
        ...chosen.grammar.map((candidate) => ({ entityType: 'grammar', display: candidate.display }))
      ],
      entities: {
        vocabulary: vocabularyResult.created,
        kanji: kanjiResult.created,
        grammar: grammarResult.created
      }
    };
  } catch (error) {
    if (connection) {
      if (typeof connection.rollback === 'function') {
        try { await connection.rollback(); } catch { /* rollback is best-effort */ }
      }
      if (typeof connection.release === 'function') {
        try { await connection.release(); } catch { /* release is best-effort */ }
      }
    }
    throw error;
  }
}

module.exports = {
  enrollStoryItems,
  fetchStory,
  previewExtraction,
  truncateCodePoints,
  validateStoryText
};
