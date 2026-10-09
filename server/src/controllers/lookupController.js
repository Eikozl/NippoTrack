// Sentence lookup for tap-to-define (deck examples and anywhere else a raw
// Japanese sentence needs per-word help). Thin over the immersion analysis:
// deterministic, read-only, never persists. Owned meanings already win over
// dictionary glosses inside the analysis; `owned` mirrors `known` (which is
// exactly "in the learner's library" on this path) so clients can badge
// "your definition" without a new key leaking elsewhere.
const pool = require('../config/db');
const { ValidationError, sendRouteError } = require('../errors/http');
const { rejectUnknownFields } = require('../validation');
const { analyzeTextForImmersion } = require('../services/immersionPipeline');

const MAX_SENTENCE_CODE_POINTS = 2000;
const MAX_LOOKUP_ITEMS = 120;

function cleanSentence(value) {
  if (typeof value !== 'string') throw new ValidationError('sentence is required and must be a string.');
  const sentence = value.trim();
  if (!sentence) throw new ValidationError('sentence is required and must be a string.');
  if (Array.from(sentence).length > MAX_SENTENCE_CODE_POINTS) {
    throw new ValidationError(`sentence exceeds the maximum length of ${MAX_SENTENCE_CODE_POINTS} characters.`);
  }
  return sentence;
}

function toLookupItem(candidate, kind) {
  return {
    surface: String(candidate.display || ''),
    reading: candidate.reading || null,
    meaning: candidate.meaning || null,
    owned: candidate.known === true,
    kind
  };
}

async function defineSentence(req, res) {
  try {
    rejectUnknownFields(req.body || {}, ['sentence']);
    const sentence = cleanSentence(req.body && req.body.sentence);
    const analysis = await analyzeTextForImmersion(pool, req.user.id, sentence);
    const candidates = (analysis && analysis.candidates) || {};
    const vocabulary = (Array.isArray(candidates.vocabulary) ? candidates.vocabulary : [])
      .filter((candidate) => candidate && candidate.display)
      .slice(0, MAX_LOOKUP_ITEMS)
      .map((candidate) => toLookupItem(candidate, 'vocabulary'));
    const kanji = (Array.isArray(candidates.kanji) ? candidates.kanji : [])
      .filter((candidate) => candidate && candidate.display)
      .slice(0, MAX_LOOKUP_ITEMS)
      .map((candidate) => toLookupItem(candidate, 'kanji'));
    return res.json({ sentence, vocabulary, kanji });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to define this sentence.' });
  }
}

module.exports = { defineSentence };
