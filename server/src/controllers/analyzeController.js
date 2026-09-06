const pool = require('../config/db');
const { ValidationError, sendRouteError } = require('../errors/http');
const {
  buildTextKanjiAnalysis,
  emptyAnalysis,
  extractHanOccurrences,
  MAX_ANALYZER_TEXT_LENGTH
} = require('../services/textKanjiAnalysis');
const { adaptTokens } = require('../services/lexicalTokenAdapter');
const {
  engineMetadata,
  MAX_LEXICAL_TEXT_LENGTH,
  parseJapanese
} = require('../services/japaneseParser');

// Phase 12-A — opt-in lexical analysis. Builds the additive `lexical` block
// for { lexical: { enabled: true } } requests. Kanji analysis always runs
// first and independently; ANY lexical failure degrades to
// status 'unavailable' with HTTP 200 so Kanji results survive. No user text
// ever appears in warnings, reasons, or logs here.
async function buildLexicalBlock(text) {
  try {
    // Resolved inside the guarded block so that no lexical failure — even a
    // future throwing metadata path — can escape into the outer 503 handler.
    const engine = engineMetadata();
    if (text.length > MAX_LEXICAL_TEXT_LENGTH) {
    return {
      status: 'unavailable',
      reason: 'lexical-text-too-long',
      engine,
      tokens: [],
      warnings: [
        `Word-level analysis supports up to ${MAX_LEXICAL_TEXT_LENGTH} characters. Kanji results below cover the full text.`
      ],
      limit: MAX_LEXICAL_TEXT_LENGTH,
      retryable: false
    };
  }
  const { rawTokens, durationMs } = await parseJapanese(text);
    return {
      status: 'ok',
      engine,
      tokens: adaptTokens(rawTokens, text, engine),
      warnings: [],
      limit: MAX_LEXICAL_TEXT_LENGTH,
      durationMs
    };
  } catch (_) {
    return {
      status: 'unavailable',
      reason: 'parser-unavailable',
      engine: engineMetadata(),
      tokens: [],
      warnings: ['Word-level analysis is unavailable. Kanji results below are complete.'],
      limit: MAX_LEXICAL_TEXT_LENGTH,
      retryable: true
    };
  }
}

function lexicalRequested(req) {
  return !!(req.body && req.body.lexical && req.body.lexical.enabled === true);
}

// Phase 8 — Smart Text Analyzer. POST /api/analyze/text accepts arbitrary
// pasted text and returns deterministic Han character analysis for the
// requesting user. Read-only: two bounded batched SELECTs (owned kanji +
// shared reference), no writes, no encounters, no statistics. Ownership
// always derives from req.user.id.
async function analyzeText(req, res) {
  try {
    const text = req.body && req.body.text;
    if (typeof text !== 'string') {
      throw new ValidationError('text is required and must be a string.');
    }
    if (text.length > MAX_ANALYZER_TEXT_LENGTH) {
      throw new ValidationError(`text exceeds the maximum length of ${MAX_ANALYZER_TEXT_LENGTH} characters.`);
    }
    // Code-point length keeps astral-plane characters (e.g. rare kanji
    // outside the BMP) counted as single characters, deterministically.
    const totalCharacters = Array.from(text).length;
    const scanned = extractHanOccurrences(text);
    if (!scanned.length) {
      // Kana-only / Latin-only / punctuation-only / empty input is a valid
      // empty analysis — no DB work, and no `IN ()` query is ever built.
      const payload = emptyAnalysis(totalCharacters);
      if (lexicalRequested(req)) {
        payload.lexical = await buildLexicalBlock(text);
      }
      return res.json(payload);
    }
    const characters = scanned.map((entry) => entry.character);
    const charPlaceholders = characters.map(() => '?').join(', ');
    const [userKanjiPromise, referencePromise] = [
      pool.execute(
        'SELECT k.id_kanji, k.character_kanji, k.meaning, k.jlpt_level, k.status, k.onyomi AS user_onyomi, k.kunyomi AS user_kunyomi FROM kanji k WHERE k.user_id = ? AND k.character_kanji IN (' + charPlaceholders + ')',
        [req.user.id, ...characters]
      ),
      pool.execute(
        'SELECT character, jlpt_level, onyomi, kunyomi, meanings, stroke_count FROM kanji_reference WHERE character IN (' + charPlaceholders + ')',
        characters
      )
    ];
    const [[userKanjiRows], [referenceRows]] = await Promise.all([userKanjiPromise, referencePromise]);
    const payload = buildTextKanjiAnalysis(scanned, userKanjiRows, referenceRows, totalCharacters);
    if (lexicalRequested(req)) {
      payload.lexical = await buildLexicalBlock(text);
    }
    return res.json(payload);
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to analyze text.' });
  }
}

module.exports = { analyzeText };
