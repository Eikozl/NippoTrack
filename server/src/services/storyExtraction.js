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
  const vocabularyResult = await ensureVocabularyEntities(executor, userId, chosen.vocabulary);
  const kanjiResult = await ensureKanjiEntities(executor, userId, chosen.kanji, analysis.internals.referenceByCharacter);
  const grammarResult = await ensureGrammarEntities(executor, userId, chosen.grammar, analysis.internals.grammarInternals);
  const targets = ['vocabulary', 'kanji', 'grammar'].flatMap((entityType) => {
    const ids = { vocabulary: vocabularyResult.ids, kanji: kanjiResult.ids, grammar: grammarResult.ids }[entityType];
    return [...ids.values()].map((entityId) => [REVIEW_TARGET_COLUMN[entityType], entityType, entityId]);
  });
  for (const [targetColumn, , targetId] of targets) {
    await executor.execute(
      `INSERT INTO review_items (${targetColumn}, due_on, interval_days) VALUES (?, CURRENT_DATE, 0) ON CONFLICT (${targetColumn}) DO NOTHING`,
      [targetId]
    );
  }
  const createdIds = [];
  for (const [targetColumn, entityType, targetId] of targets) {
    const [rows] = await executor.execute(
      `SELECT id_review_item FROM review_items WHERE ${targetColumn} = ?`,
      [targetId]
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    if (row && Number.isInteger(Number(row.id_review_item))) {
      createdIds.push({ entityType, reviewItemId: Number(row.id_review_item) });
      await executor.execute(
        'INSERT INTO story_review_links (id_content_entry, id_review_item) VALUES (?, ?) ON CONFLICT DO NOTHING',
        [storyId, Number(row.id_review_item)]
      );
    }
  }
  const extracted = {
    kanji: chosen.kanji.length,
    vocab: chosen.vocabulary.length,
    grammar: chosen.grammar.length
  };
  await executor.execute(
    "UPDATE content_entries SET extracted_json = ?::jsonb, processing_status = 'completed', extraction_error = NULL WHERE id_content_entry = ? AND user_id = ?",
    [JSON.stringify({ enrolled: extracted }), storyId, userId]
  );
  return {
    created: createdIds.length,
    reviewItems: createdIds,
    entities: {
      vocabulary: vocabularyResult.created,
      kanji: kanjiResult.created,
      grammar: grammarResult.created
    }
  };
}

module.exports = {
  enrollStoryItems,
  fetchStory,
  previewExtraction,
  truncateCodePoints,
  validateStoryText
};
