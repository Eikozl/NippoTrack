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
  buildLexicalCandidates,
  matchOwnedVocabulary,
  summarizeLexical
} = require('../services/lexicalCandidates');
const {
  engineMetadata,
  MAX_LEXICAL_TEXT_LENGTH,
  parseJapanese
} = require('../services/japaneseParser');
const { tryConsumeLexical } = require('../services/lexicalRateLimit');
const { resolveContext } = require('../services/contextService');
const { lexicalRequiredBlock, unavailableBlock } = require('../services/contextResponse');

// Log only slow parses, and never with user content: version, sizes,
// durations, outcome category.
const SLOW_PARSE_LOG_MS = 1000;

function emptyLexicalPayload(engine, reason, warnings, retryable) {
  return {
    status: 'unavailable',
    reason,
    engine,
    tokens: [],
    candidates: [],
    unverified: [],
    summary: summarizeLexical([], [], true),
    matching: { available: true },
    warnings,
    limit: MAX_LEXICAL_TEXT_LENGTH,
    retryable
  };
}

// Payload diet: internal normalized tokens keep per-token engine metadata,
// but the API serializes one top-level engine block instead of repeating it
// ~1k times. Internal adapter guarantees are untouched.
function stripTokenEngine(token) {
  const { engine, ...rest } = token;
  return rest;
}

// Phase 12-B — opt-in lexical analysis. Builds the additive `lexical` block
// for { lexical: { enabled: true } } requests: diet tokens, aggregated
// vocabulary candidates, unverified material, owned-vocabulary matching, and
// a summary. Kanji analysis always runs first and independently; ANY lexical
// failure degrades to status 'unavailable' with HTTP 200 so Kanji results
// survive. No user text ever appears in warnings, reasons, or logs here.
async function buildLexicalBlock(text, { userId, ip, wantContext } = {}) {
  try {
    // Resolved inside the guarded block so that no lexical failure — even a
    // future throwing metadata path — can escape into the outer 503 handler.
    const engine = engineMetadata();
    if (text.length > MAX_LEXICAL_TEXT_LENGTH) {
      return attachContext(emptyLexicalPayload(
        engine,
        'lexical-text-too-long',
        [`Word-level analysis supports up to ${MAX_LEXICAL_TEXT_LENGTH} characters. Kanji results below cover the full text.`],
        false
      ), wantContext);
    }
    const budget = tryConsumeLexical({ userId, ip });
    if (!budget.allowed) {
      return attachContext(emptyLexicalPayload(
        engine,
        'lexical-rate-limited',
        ['Word-level analysis is temporarily limited. Kanji results below are complete; try again in a few minutes.'],
        true
      ), wantContext);
    }
    const { rawTokens, durationMs } = await parseJapanese(text);
    const adapted = adaptTokens(rawTokens, text, engine);
    const { candidates, unverified } = buildLexicalCandidates(adapted);
    let matchingAvailable = true;
    try {
      await matchOwnedVocabulary(pool, userId, candidates);
    } catch (_) {
      // Lookup failure must never read as "all new": mark every candidate
      // unavailable so the UI shows an explicit degraded state.
      matchingAvailable = false;
      for (const candidate of candidates) {
        candidate.match = { state: 'unavailable', ownedCount: 0, possibleMatches: [] };
      }
    }
    if (durationMs >= SLOW_PARSE_LOG_MS) {
      console.warn(JSON.stringify({
        scope: 'lexical-parse-slow',
        package: engine.package,
        packageVersion: engine.packageVersion,
        dictionary: engine.dictionary,
        chars: text.length,
        tokens: adapted.length,
        candidates: candidates.length,
        durationMs
      }));
    }
    return attachContext({
      status: 'ok',
      engine,
      tokens: adapted.map(stripTokenEngine),
      candidates,
      unverified,
      summary: summarizeLexical(candidates, unverified, matchingAvailable),
      matching: { available: matchingAvailable },
      warnings: matchingAvailable
        ? []
        : ['Vocabulary collection matching is unavailable. Candidates are shown without ownership state.'],
      limit: MAX_LEXICAL_TEXT_LENGTH,
      durationMs
    }, wantContext, candidates, adapted);
  } catch (_) {
    return attachContext({
      status: 'unavailable',
      reason: 'parser-unavailable',
      engine: engineMetadata(),
      tokens: [],
      candidates: [],
      unverified: [],
      summary: summarizeLexical([], [], true),
      matching: { available: true },
      warnings: ['Word-level analysis is unavailable. Kanji results below are complete.'],
      limit: MAX_LEXICAL_TEXT_LENGTH,
      retryable: true
    }, wantContext);
  }
}

// Context rides the lexical block: on success it resolves against the real
// candidates + tokens; on any lexical degradation it degrades alongside
// (lexical-unavailable) so the two blocks never contradict each other.
async function attachContext(payload, wantContext, candidates, tokens) {
  if (!wantContext) return payload;
  if (payload.status === 'ok' && Array.isArray(candidates)) {
    payload.context = await buildContextBlock(candidates, tokens || []);
  } else {
    payload.context = unavailableBlock('lexical-unavailable', payload.retryable === true);
  }
  return payload;
}

// CA-B2 — additive Context-Aware block. Runs inside the lexical budget (no
// second limiter, no request amplification): at most 3 batched read-only
// reference queries under one pinned snapshot. Never throws: any failure
// degrades to an explicit unavailable block so Kanji + lexical survive.
async function buildContextBlock(candidates, tokens) {
  try {
    return await resolveContext({ pool, candidates, tokens });
  } catch (_) {
    return unavailableBlock('context-failed', true);
  }
}

function lexicalRequested(req) {
  return !!(req.body && req.body.lexical && req.body.lexical.enabled === true);
}

function contextRequested(req) {
  return !!(req.body && req.body.context && req.body.context.enabled === true);
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
        payload.lexical = await buildLexicalBlock(text, { userId: req.user && req.user.id, ip: req.ip, wantContext: contextRequested(req) });
      } else if (contextRequested(req)) {
        // Context requires lexical: HTTP 200 survives with an explicit
        // lexical-required state instead of a fatal error.
        payload.context = lexicalRequiredBlock();
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
      payload.lexical = await buildLexicalBlock(text, { userId: req.user && req.user.id, ip: req.ip, wantContext: contextRequested(req) });
    } else if (contextRequested(req)) {
      payload.context = lexicalRequiredBlock();
    }
    return res.json(payload);
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to analyze text.' });
  }
}

module.exports = { analyzeText };
