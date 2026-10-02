// V5.3a Review 2.0 — card types, per-user preferences, error-pattern
// heuristics, and the dynamic-interval calculator.
//
// CARD TYPES are a presentation/config layer over the frozen V5.2 review
// contract (review_items/review_events stay untouched): each entity supports
// a fixed, documented set of card types and the /due endpoint reports them
// so the client can render type-aware cards.
//
// INTERVALS: the V5.2 grading path keeps the frozen 1/3/7 schedule
// (engine_mode='fixed', the default, so existing behavior and tests are
// byte-identical). engine_mode='dynamic' is opt-in per user and applies the
// V5.3a formula VERBATIM:
//     facility  = correct / (correct + wrong * 1.5)
//     interval  = base * (1 / facility) ^ repetitions
//     clamp     = [1, 365] days
// facility is clamped to [0.25, 1] before use so a tiny history cannot
// explode the exponent; 'correct' counts Good + Hard (recalled), 'wrong'
// counts Again. NOTE (flagged, spec-verbatim): with facility < 1 the
// (1/facility) factor LENGTHENS intervals — the inverse of classic SRS ease.
// The formula is implemented exactly as specified and pinned by tests; the
// opt-in default keeps production scheduling on the proven fixed curve.
//
// PATTERNS are replace-per-detection heuristics over the user's last 50
// review events: repeatedly-failing kanji that share a dictionary reading
// (kanji-reading-confusion), failing grammar grouped by JLPT band
// (grammar-family-failures), and vocabulary with >= 3 Again
// (vocabulary-frequent-again). No ML, no network, all queries user-scoped.

const { ValidationError } = require('../errors/http');

const CARD_TYPES = Object.freeze(['recognition', 'recall', 'cloze', 'audio']);
const ENGINE_MODES = Object.freeze(['fixed', 'dynamic']);

// Deterministic entity -> supported card types map (documented contract):
// - kanji: recognise the character, or recall/write it from meaning.
// - vocabulary: recognise, recall, cloze (usage_examples exist), audio (TTS).
// - grammar: recognise the pattern, cloze (grammar_examples exist), audio.
const ENTITY_CARD_TYPES = Object.freeze({
  kanji: ['recognition', 'recall'],
  vocabulary: ['recognition', 'recall', 'cloze', 'audio'],
  grammar: ['recognition', 'cloze', 'audio']
});

const BASE_INTERVALS = Object.freeze({ Again: 1, Hard: 3, Good: 7 });
const PATTERN_EVENT_WINDOW = 50;
const PATTERN_MINIMUM_EVENTS = 2;

const DEFAULT_PREFERENCES = Object.freeze({
  cardTypes: ['recognition'],
  weights: {},
  engineMode: 'fixed'
});

function normalizeCardTypes(value) {
  if (!Array.isArray(value) || !value.length) {
    throw new ValidationError(`cardTypes must be a non-empty array of: ${CARD_TYPES.join(', ')}.`);
  }
  const unique = [...new Set(value.map((item) => String(item)))];
  for (const item of unique) {
    if (!CARD_TYPES.includes(item)) {
      throw new ValidationError(`cardTypes must be a subset of: ${CARD_TYPES.join(', ')}.`);
    }
  }
  return unique;
}

function normalizeWeights(value) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('weights must be an object of numeric card-type weights (0-100).');
  }
  const weights = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!CARD_TYPES.includes(key)) {
      throw new ValidationError(`weights keys must be one of: ${CARD_TYPES.join(', ')}.`);
    }
    const weight = Number(raw);
    if (!Number.isFinite(weight) || weight < 0 || weight > 100) {
      throw new ValidationError(`weights.${key} must be a number between 0 and 100.`);
    }
    weights[key] = weight;
  }
  return weights;
}

function normalizeEngineMode(value) {
  if (value === undefined || value === null || value === '') return 'fixed';
  const mode = String(value);
  if (!ENGINE_MODES.includes(mode)) {
    throw new ValidationError(`engineMode must be one of: ${ENGINE_MODES.join(', ')}.`);
  }
  return mode;
}

// facility from a result history; 'correct' = Good + Hard, 'wrong' = Again.
// Empty history returns the neutral 1 so the formula reduces to the base.
function facilityFromResults(results) {
  const list = Array.isArray(results) ? results.filter((item) => Object.hasOwn(BASE_INTERVALS, item)) : [];
  if (!list.length) return 1;
  const correct = list.filter((item) => item === 'Good' || item === 'Hard').length;
  const wrong = list.filter((item) => item === 'Again').length;
  if (correct + wrong === 0) return 1;
  const raw = correct / (correct + wrong * 1.5);
  return Math.min(1, Math.max(0.25, raw));
}

// V5.3a dynamic interval, spec-verbatim, clamped to [1, 365] days.
function computeDynamicInterval({ result, repetitions = 0, facility = 1 } = {}) {
  if (!Object.hasOwn(BASE_INTERVALS, result)) {
    throw new ValidationError('result must be Again, Hard, or Good.');
  }
  const base = BASE_INTERVALS[result];
  const safeFacility = Math.min(1, Math.max(0.25, Number.isFinite(facility) ? facility : 1));
  const reps = Number.isInteger(repetitions) && repetitions >= 0 ? repetitions : 0;
  const raw = base * Math.pow(1 / safeFacility, reps);
  return Math.min(365, Math.max(1, Math.round(raw)));
}

// ---------------------------------------------------------------- preferences

function preferencesFromRow(row) {
  if (!row) return { ...DEFAULT_PREFERENCES, cardTypes: [...DEFAULT_PREFERENCES.cardTypes] };
  return {
    cardTypes: Array.isArray(row.card_types) ? [...row.card_types] : [...DEFAULT_PREFERENCES.cardTypes],
    weights: row.weights && typeof row.weights === 'object' && !Array.isArray(row.weights) ? { ...row.weights } : {},
    engineMode: normalizeEngineMode(row.engine_mode)
  };
}

async function getUserReviewPreferences(executor, userId) {
  const [rows] = await executor.execute(
    'SELECT card_types, weights, engine_mode FROM user_review_preferences WHERE user_id = ?',
    [userId]
  );
  return preferencesFromRow(rows && rows[0]);
}

async function upsertUserReviewPreferences(executor, userId, { cardTypes, weights, engineMode } = {}) {
  const normalized = {
    cardTypes: normalizeCardTypes(cardTypes),
    weights: normalizeWeights(weights),
    engineMode: normalizeEngineMode(engineMode)
  };
  await executor.execute(
    `INSERT INTO user_review_preferences (user_id, card_types, weights, engine_mode)
     VALUES (?, ?::jsonb, ?::jsonb, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       card_types = EXCLUDED.card_types,
       weights = EXCLUDED.weights,
       engine_mode = EXCLUDED.engine_mode,
       updated_at = CURRENT_TIMESTAMP`,
    [userId, JSON.stringify(normalized.cardTypes), JSON.stringify(normalized.weights), normalized.engineMode]
  );
  return normalized;
}

// ---------------------------------------------------------------- grading hook

// Resolves the next interval for a grade. Fixed mode (default) keeps the
// frozen V5.2 curve. Dynamic mode computes facility + repetition streak from
// the item's recent events (bounded, inside the caller's transaction).
async function resolveIntervalDays(executor, userId, reviewItemId, result) {
  const preferences = await getUserReviewPreferences(executor, userId);
  if (preferences.engineMode !== 'dynamic') {
    return { intervalDays: BASE_INTERVALS[result], engineMode: 'fixed' };
  }
  const [rows] = await executor.execute(
    `SELECT result FROM review_events
     WHERE id_review_item = ?
     ORDER BY reviewed_at DESC, id_review_event DESC
     LIMIT 20`,
    [reviewItemId]
  );
  const previous = (rows || []).map((row) => row.result).reverse();
  const streak = (() => {
    let count = 0;
    for (let index = previous.length - 1; index >= 0; index -= 1) {
      if (previous[index] === 'Good') count += 1;
      else break;
    }
    return count;
  })();
  return {
    intervalDays: computeDynamicInterval({ result, repetitions: streak, facility: facilityFromResults(previous) }),
    engineMode: 'dynamic'
  };
}

// ---------------------------------------------------------------- patterns

function patternRow(patternType, affectedItems, suggestedAction, priority) {
  return {
    patternType,
    affectedItems,
    suggestedAction,
    priority
  };
}

// Heuristic detector over the user's last 50 events. Pure given the joined
// rows: { id_review_item, entityType, display, level, result, readings }
// (readings = kanji_reference onyomi/kunyomi array for kanji rows).
function detectPatternsFromRows(rows) {
  const patterns = [];
  const againCounts = new Map();
  const kanjiByReading = new Map();
  const grammarByLevel = new Map();

  for (const row of rows || []) {
    const key = `${row.entityType}:${row.id_review_item}`;
    if (row.result !== 'Again') continue;
    const current = againCounts.get(key) || { row, count: 0 };
    current.count += 1;
    againCounts.set(key, current);

    if (row.entityType === 'kanji' && Array.isArray(row.readings)) {
      for (const reading of row.readings) {
        if (!reading) continue;
        const bucket = kanjiByReading.get(reading) || new Map();
        bucket.set(key, current.row);
        kanjiByReading.set(reading, bucket);
      }
    }
    if (row.entityType === 'grammar') {
      const band = row.level || 'unclassified';
      const bucket = grammarByLevel.get(band) || new Map();
      bucket.set(key, current.row);
      grammarByLevel.set(band, bucket);
    }
  }

  // Kanji that keep failing AND share a dictionary reading with another
  // failing kanji — classic look-alike/sound-alike confusion.
  for (const [reading, bucket] of kanjiByReading) {
    const failing = [...bucket.entries()]
      .filter(([key]) => (againCounts.get(key)?.count || 0) >= PATTERN_MINIMUM_EVENTS)
      .map(([, row]) => row);
    if (failing.length >= 2) {
      patterns.push(patternRow(
        'kanji-reading-confusion',
        failing.map((row) => ({ idReviewItem: Number(row.id_review_item), entityType: 'kanji', display: row.display, reading })),
        `These kanji share the reading ${reading} and keep coming back — practice them side by side.`,
        1
      ));
      break; // one representative reading-confusion pattern per detection run
    }
  }

  for (const [band, bucket] of grammarByLevel) {
    const failing = [...bucket.entries()]
      .filter(([key]) => (againCounts.get(key)?.count || 0) >= PATTERN_MINIMUM_EVENTS)
      .map(([, row]) => row);
    if (failing.length >= 2) {
      patterns.push(patternRow(
        'grammar-family-failures',
        failing.map((row) => ({ idReviewItem: Number(row.id_review_item), entityType: 'grammar', display: row.display, level: band })),
        `Several ${band || 'unclassified'} grammar points keep coming back — review the whole band together.`,
        2
      ));
      break;
    }
  }

  const frequentVocabulary = [...againCounts.entries()]
    .filter(([key, { row, count }]) => row.entityType === 'vocabulary' && count >= 3)
    .map(([, { row }]) => row);
  if (frequentVocabulary.length) {
    patterns.push(patternRow(
      'vocabulary-frequent-again',
      frequentVocabulary.map((row) => ({ idReviewItem: Number(row.id_review_item), entityType: 'vocabulary', display: row.display })),
      'These words were marked Again three or more times — add them to a focused session.',
      2
    ));
  }

  return patterns.sort((a, b) => a.priority - b.priority);
}

// Runs detection against the user's 50 most recent owned events and REPLACES
// the stored pattern rows for that user (one row set per detection run).
async function detectAndStoreReviewPatterns(executor, userId) {
  const [rows] = await executor.execute(
    `SELECT re.id_review_event, re.result, ri.id_review_item,
       CASE WHEN ri.id_kanji IS NOT NULL THEN 'kanji'
            WHEN ri.id_vocabulary IS NOT NULL THEN 'vocabulary'
            ELSE 'grammar' END AS "entityType",
       COALESCE(v.word, k.character_kanji, g.grammar_point) AS display,
       COALESCE(v.jlpt_level, k.jlpt_level, g.jlpt_level) AS level,
       kr.onyomi, kr.kunyomi
      FROM review_events re
      JOIN review_items ri ON ri.id_review_item = re.id_review_item
      LEFT JOIN vocabulary v ON v.id_vocabulary = ri.id_vocabulary AND v.user_id = ?
      LEFT JOIN kanji k ON k.id_kanji = ri.id_kanji AND k.user_id = ?
      LEFT JOIN grammar_points g ON g.id_grammar = ri.id_grammar AND g.user_id = ?
      LEFT JOIN kanji_reference kr ON kr.character = k.character_kanji
      WHERE (v.user_id = ? OR k.user_id = ? OR g.user_id = ?)
      ORDER BY re.reviewed_at DESC, re.id_review_event DESC
      LIMIT ${PATTERN_EVENT_WINDOW}`,
    [userId, userId, userId, userId, userId, userId]
  );

  const normalized = (rows || []).map((row) => ({
    ...row,
    readings: Array.isArray(row.onyomi) ? [...row.onyomi, ...(Array.isArray(row.kunyomi) ? row.kunyomi : [])] : []
  }));
  const patterns = detectPatternsFromRows(normalized);

  await executor.execute('DELETE FROM review_patterns WHERE user_id = ?', [userId]);
  for (const pattern of patterns) {
    await executor.execute(
      `INSERT INTO review_patterns (user_id, pattern_type, affected_items, suggested_action, priority)
       VALUES (?, ?, ?::jsonb, ?, ?)`,
      [userId, pattern.patternType, JSON.stringify(pattern.affectedItems), pattern.suggestedAction, pattern.priority]
    );
  }
  return patterns;
}

async function listReviewPatterns(executor, userId) {
  const [rows] = await executor.execute(
    `SELECT pattern_type, affected_items, suggested_action, priority, detected_at
     FROM review_patterns WHERE user_id = ?
     ORDER BY priority ASC, detected_at DESC`,
    [userId]
  );
  return (rows || []).map((row) => ({
    patternType: row.pattern_type,
    affectedItems: Array.isArray(row.affected_items) ? row.affected_items : [],
    suggestedAction: row.suggested_action,
    priority: Number(row.priority || 3),
    detectedAt: row.detected_at || null
  }));
}

module.exports = {
  BASE_INTERVALS,
  CARD_TYPES,
  DEFAULT_PREFERENCES,
  ENTITY_CARD_TYPES,
  ENGINE_MODES,
  PATTERN_EVENT_WINDOW,
  computeDynamicInterval,
  detectAndStoreReviewPatterns,
  detectPatternsFromRows,
  facilityFromResults,
  getUserReviewPreferences,
  listReviewPatterns,
  normalizeCardTypes,
  normalizeEngineMode,
  normalizeWeights,
  preferencesFromRow,
  resolveIntervalDays,
  upsertUserReviewPreferences
};
