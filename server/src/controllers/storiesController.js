// Story Registry endpoints (V5.6 phase 1): pasted-text preview, story
// creation with optional extraction, re-extraction, SRS enrollment and the
// phase-2 embed contract (null until fetching lands).
const pool = require('../config/db');
const { ValidationError, sendRouteError } = require('../errors/http');
const { parseIdParam } = require('../validation');
const { enrollStoryItems, fetchStory, previewExtraction } = require('../services/storyExtraction');

const ALLOWED_STORY_TYPES = ['Anime', 'Manga', 'Book', 'Article', 'YouTube', 'Podcast', 'Game', 'Conversation'];

async function postExtractPreview(req, res) {
  try {
    const preview = await previewExtraction(pool, req.user.id, req.body?.text);
    return res.json({ preview });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to preview the extraction.' });
  }
}

async function postStory(req, res) {
  try {
    const body = req.body || {};
    const title = String(body.title || '').trim().slice(0, 255);
    if (!title) throw new ValidationError('title must be a non-empty string');
    const contentType = body.content_type === undefined || body.content_type === null || body.content_type === ''
      ? 'Article'
      : String(body.content_type);
    if (!ALLOWED_STORY_TYPES.includes(contentType)) {
      throw new ValidationError(`content_type must be one of: ${ALLOWED_STORY_TYPES.join(', ')}.`);
    }
    const text = body.text === undefined || body.text === null ? null : String(body.text);
    if (text !== null && Array.from(text).length > 5000) {
      throw new ValidationError('text exceeds the maximum length of 5000 characters.');
    }
    const [inserted] = await pool.execute(
      `INSERT INTO content_entries (user_id, title, content_type, content_date, notes, source_url, source_text, processing_status)
       VALUES (?, ?, ?, CURRENT_DATE, ?, ?, ?, ?)`,
      [
        req.user.id,
        title,
        contentType,
        body.notes === undefined || body.notes === null ? null : String(body.notes).slice(0, 1500),
        body.source_url === undefined || body.source_url === null ? null : String(body.source_url).slice(0, 2000),
        text,
        text && body.auto_extract !== false ? 'pending' : 'none'
      ]
    );
    const storyId = Number(inserted?.insertId);
    if (!Number.isInteger(storyId) || storyId <= 0) throw new Error('Unable to create the story.');
    let extracted = null;
    if (text && body.auto_extract !== false) {
      const preview = await previewExtraction(pool, req.user.id, text);
      extracted = {
        kanji: preview.kanji.length,
        vocab: preview.vocab.length,
        grammar: preview.grammar.length
      };
      await pool.execute(
        "UPDATE content_entries SET extracted_json = ?::jsonb, processing_status = 'completed' WHERE id_content_entry = ? AND user_id = ?",
        [JSON.stringify(preview), storyId, req.user.id]
      );
    }
    return res.status(201).json({ story_id: storyId, extracted });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to create the story.' });
  }
}

async function postExtract(req, res) {
  try {
    const id = parseIdParam(req, 'story');
    const story = await fetchStory(pool, id, req.user.id);
    if (!story) return res.status(404).json({ error: 'story not found' });
    if (!story.source_text) throw new ValidationError('story has no text to extract from.');
    const preview = await previewExtraction(pool, req.user.id, story.source_text);
    await pool.execute(
      "UPDATE content_entries SET extracted_json = ?::jsonb, processing_status = 'completed', extraction_error = NULL WHERE id_content_entry = ? AND user_id = ?",
      [JSON.stringify(preview), id, req.user.id]
    );
    return res.json({ story_id: id, extracted: preview });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to extract the story.' });
  }
}

async function postEnrollSrs(req, res) {
  try {
    const id = parseIdParam(req, 'story');
    const result = await enrollStoryItems(pool, req.user.id, id, req.body?.selected);
    if (!result) return res.status(404).json({ error: 'story not found' });
    return res.json({ story_id: id, ...result });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to enroll the story.' });
  }
}

async function getEmbed(req, res) {
  try {
    const id = parseIdParam(req, 'story');
    const story = await fetchStory(pool, id, req.user.id);
    if (!story) return res.status(404).json({ error: 'story not found' });
    // Phase 1: no fetching yet, so embeds are always empty. The contract
    // (embedHtml + sandbox recommendation) already matches phase 2.
    return res.json({ embedHtml: story.embed_html || null, sandbox: null });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load the story embed.' });
  }
}

module.exports = {
  getEmbed,
  postEnrollSrs,
  postExtract,
  postExtractPreview,
  postStory
};
