const pool = require('../config/db');
const { ValidationError, sendRouteError } = require('../errors/http');
const {
  buildTextKanjiAnalysis,
  emptyAnalysis,
  extractHanOccurrences,
  MAX_ANALYZER_TEXT_LENGTH
} = require('../services/textKanjiAnalysis');

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
      return res.json(emptyAnalysis(totalCharacters));
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
    return res.json(buildTextKanjiAnalysis(scanned, userKanjiRows, referenceRows, totalCharacters));
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to analyze text.' });
  }
}

module.exports = { analyzeText };
