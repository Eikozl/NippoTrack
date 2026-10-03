// V5.3a — Immersion reading pipeline.
//
// Turns pasted Japanese text into selectable learning candidates and, on
// explicit user selection, atomically persists the user's entities, a review
// session with review items, the immersion session record, and kanji
// encounter evidence.
//
// Trust boundary: clients NEVER supply words/readings/meanings. The create
// flow re-runs the deterministic server-side analysis on the submitted text
// and only honours the stable candidate id keys previously produced by
// analyzeTextForImmersion; any id that no longer intersects the fresh
// analysis is silently ignored.
//
// Degradation: the lexical engine is bounded to MAX_LEXICAL_TEXT_LENGTH
// (2000) characters. Longer accepted texts (up to MAX_IMMERSION_TEXT_LENGTH)
// still get kanji candidates + level estimation with empty vocabulary/grammar
// candidate lists; any parser or hydration failure degrades the same way so
// kanji analysis always survives.
//
// Estimated-level heuristic (deliberately simple and deterministic, no
// weighting): over the text's UNIQUE Han characters using kanji_reference
// jlpt_level distribution only. Scanning bands hardest-first (N1 → N5), the
// estimate is the first band that both appears in the text and keeps the
// "coverage-unknown share" (kanji with no classified level or a harder
// level than the band) at or below LEVEL_UNKNOWN_THRESHOLD of all unique
// kanji. Because that share only grows as the band gets easier, this reduces
// to: the hardest JLPT band present, provided the unclassified share stays
// under the threshold; otherwise null. Confidence is count-based only:
// classifiedShare * min(1, uniqueKanji / 20), rounded to two decimals,
// 0 when the text contains no kanji.

const { JLPT_LEVELS } = require('../constants');
const { ValidationError } = require('../errors/http');
const { isValidDateString, validateAllowedValues } = require('../validation');
const { MAX_LEXICAL_TEXT_LENGTH, engineMetadata, parseJapanese } = require('./japaneseParser');
const { adaptTokens } = require('./lexicalTokenAdapter');
const { buildLexicalCandidates, matchOwnedVocabulary } = require('./lexicalCandidates');
const { extractHanOccurrences } = require('./kanjiVocabularyLinks');
const { detectGrammar } = require('./grammarDetector');
const { hydrateGrammarMatches } = require('./grammarReferenceStore');
const { ENCOUNTER_SOURCE_TYPES, recordKanjiEncounters } = require('./kanjiEncounters');

const MAX_IMMERSION_TEXT_LENGTH = 5000;
const LEVEL_BY_DIFFICULTY = ['N1', 'N2', 'N3', 'N4', 'N5']; // hardest first
const LEVEL_UNKNOWN_THRESHOLD = 0.2;
const LEVEL_CONFIDENCE_KANJI_SATURATION = 20;

function normalizeImmersionText(text) {
  if (typeof text !== 'string') {
    throw new ValidationError('text is required and must be a string.');
  }
  const trimmed = text.trim();
  if (!trimmed) {
    throw new ValidationError('text is required and must not be empty.');
  }
  if (Array.from(trimmed).length > MAX_IMMERSION_TEXT_LENGTH) {
    throw new ValidationError(`text exceeds the maximum length of ${MAX_IMMERSION_TEXT_LENGTH} characters.`);
  }
  return trimmed;
}

function truncateCodePoints(value, max) {
  if (typeof value !== 'string') return value;
  const characters = Array.from(value);
  return characters.length > max ? characters.slice(0, max).join('') : value;
}

function normalizeJlpt(value) {
  if (typeof value !== 'string') return null;
  const level = value.trim().toUpperCase();
  return JLPT_LEVELS.includes(level) ? level : null;
}

// Same dual-shape RETURNING handling as reviewController.extractInsertId
// (adapter {insertId} vs raw [[row]]), kept local so the service stays
// decoupled from the controller module.
function extractInsertId(first) {
  if (!first) return undefined;
  if (Array.isArray(first)) {
    const row = first[0];
    if (!row || typeof row !== 'object') return undefined;
    const value = row.insertId ?? row.insertid ?? Object.values(row)[0];
    return value === undefined ? undefined : Number(value);
  }
  if (typeof first === 'object') {
    const direct = first.insertId ?? first.insertid;
    if (direct !== undefined) return Number(direct);
    if (Array.isArray(first.rows) && first.rows[0]) {
      const value = first.rows[0].insertId ?? first.rows[0].insertid ?? Object.values(first.rows[0])[0];
      return value === undefined ? undefined : Number(value);
    }
  }
  return undefined;
}

// Documented heuristic; pure so it can be unit-tested without a pool.
function estimateDifficultyLevel(uniqueHanCharacters, referenceRows, ownedCharacters) {
  const referenceByCharacter = new Map(
    (Array.isArray(referenceRows) ? referenceRows : []).map((row) => [row.character, row])
  );
  const owned = ownedCharacters instanceof Set ? ownedCharacters : new Set(ownedCharacters || []);
  const kanjiTotal = uniqueHanCharacters.length;
  const byLevel = { N5: 0, N4: 0, N3: 0, N2: 0, N1: 0, unclassified: 0 };
  let knownCount = 0;
  for (const character of uniqueHanCharacters) {
    const level = normalizeJlpt(referenceByCharacter.get(character)?.jlpt_level);
    if (level) byLevel[level] += 1;
    else byLevel.unclassified += 1;
    if (owned.has(character)) knownCount += 1;
  }
  const kanjiKnownPct = kanjiTotal === 0 ? 0 : Math.round((knownCount / kanjiTotal) * 1000) / 10;
  let level = null;
  if (kanjiTotal > 0) {
    let unknownShareNumerator = byLevel.unclassified;
    for (const band of LEVEL_BY_DIFFICULTY) {
      if (byLevel[band] > 0 && unknownShareNumerator / kanjiTotal <= LEVEL_UNKNOWN_THRESHOLD) {
        level = band;
        break;
      }
      unknownShareNumerator += byLevel[band];
    }
  }
  const classifiedShare = kanjiTotal === 0 ? 0 : (kanjiTotal - byLevel.unclassified) / kanjiTotal;
  const volume = Math.min(1, kanjiTotal / LEVEL_CONFIDENCE_KANJI_SATURATION);
  const confidence = Math.round(classifiedShare * volume * 100) / 100;
  return { level, confidence, stats: { kanjiTotal, kanjiKnownPct, byLevel } };
}

// One bounded best-effort JMdict lookup: first gloss per exact written or
// reading surface. Never fabricated: words without a dictionary hit keep
// meaning null. Any failure leaves all meanings null (analysis survives).
function buildVocabularyGlossSql(placeholders) {
  return 'WITH active AS (' +
    ' SELECT a.source_id FROM jmdict_active_snapshot a' +
    ' JOIN jmdict_sources s ON s.source_id = a.source_id' +
    " WHERE a.singleton = 1 AND s.status = 'ready'" +
    ' ), matched AS (' +
    ' SELECT DISTINCT ON (f.surface) f.surface, f.entry_id FROM jmdict_forms f CROSS JOIN active' +
    ` WHERE f.source_id = active.source_id AND f.surface IN (${placeholders})` +
    ' ORDER BY f.surface, f.is_common DESC, f.entry_id' +
    ' ) SELECT m.surface, g.gloss FROM matched m' +
    ' LEFT JOIN LATERAL (' +
    ' SELECT s.gloss_en[1] AS gloss FROM jmdict_senses s' +
    ' WHERE s.source_id IN (SELECT source_id FROM active) AND s.entry_id = m.entry_id' +
    " AND s.gloss_en <> '{}' ORDER BY s.sense_no LIMIT 1" +
    ' ) g ON true';
}

async function attachVocabularyGlosses(executor, candidates) {
  const words = [...new Set(
    candidates.flatMap((candidate) => [candidate.canonical, candidate.lemma])
      .filter((value) => typeof value === 'string' && value !== '')
  )];
  if (!words.length) return;
  let rows = [];
  try {
    [rows] = await executor.execute(buildVocabularyGlossSql(words.map(() => '?').join(', ')), words);
  } catch (_) {
    return; // dictionary lookup unavailable: meanings stay null
  }
  const glossBySurface = new Map();
  for (const row of rows || []) {
    if (row && typeof row.surface === 'string' && typeof row.gloss === 'string' && !glossBySurface.has(row.surface)) {
      glossBySurface.set(row.surface, row.gloss);
    }
  }
  for (const candidate of candidates) {
    candidate.gloss = glossBySurface.get(candidate.canonical)
      || (candidate.lemma ? glossBySurface.get(candidate.lemma) : null)
      || null;
  }
}

async function buildLexicalImmersionCandidates(executor, userId, sourceText) {
  const vocabulary = [];
  const grammar = [];
  const grammarInternals = new Map();
  try {
    const { rawTokens } = await parseJapanese(sourceText);
    const adapted = adaptTokens(rawTokens, sourceText, engineMetadata());
    const { candidates: lexicalCandidates } = buildLexicalCandidates(adapted);
    try {
      await matchOwnedVocabulary(executor, userId, lexicalCandidates);
    } catch (_) {
      // Ownership lookup failure cannot mark everything "new" safely; with a
      // boolean contract we degrade to known=false. The create flow re-checks
      // ownership inside its transaction, so no duplicates can be inserted.
    }
    await attachVocabularyGlosses(executor, lexicalCandidates);
    const seenVocabularyIds = new Set();
    for (const candidate of lexicalCandidates) {
      const reading = candidate.lemmaReading || candidate.surfaceReading || null;
      const id = `vocabulary::${candidate.canonical}::${reading || ''}`;
      if (seenVocabularyIds.has(id)) continue; // same word+reading across POS tags
      seenVocabularyIds.add(id);
      vocabulary.push({
        id,
        display: candidate.canonical,
        reading,
        meaning: candidate.gloss || null,
        jlpt: null, // JMdict carries no JLPT band; vocabulary level stays null
        known: candidate.match?.state === 'existing'
      });
    }
    const hydrated = await hydrateGrammarMatches(userId, detectGrammar(adapted), executor);
    for (const match of hydrated) {
      // AMBIGUOUS families need user disambiguation and are never selectable.
      if (match.status !== 'DETERMINATE' || !match.reference) continue;
      const reference = match.reference;
      const id = `grammar::${reference.sourceSlug}`;
      if (grammarInternals.has(id)) continue;
      grammarInternals.set(id, {
        referenceId: reference.referenceId,
        grammarPoint: reference.grammarPoint,
        meaning: reference.meaning || reference.summary || null,
        jlpt: normalizeJlpt(reference.jlptLevel)
      });
      grammar.push({
        id,
        display: reference.grammarPoint,
        reading: reference.kana || null,
        meaning: reference.meaning || null,
        jlpt: normalizeJlpt(reference.jlptLevel),
        known: match.collection?.inGrammar === true
      });
    }
  } catch (_) {
    // Parser/hydration failure: vocabulary/grammar degrade to empty; kanji
    // candidates (engine-independent) are still returned.
    return { vocabulary: [], grammar: [], grammarInternals: new Map() };
  }
  return { vocabulary, grammar, grammarInternals };
}

// Internal full analysis. `internals` carries the reference rows needed by
// the create flow without trusting any client payload.
async function runAnalysis(executor, userId, text) {
  const sourceText = normalizeImmersionText(text);
  const totalCharacters = Array.from(sourceText).length;
  const hanOccurrences = extractHanOccurrences(sourceText);
  const uniqueHan = hanOccurrences.map((entry) => entry.character);

  const referenceByCharacter = new Map();
  const ownedCharacters = new Set();
  if (uniqueHan.length) {
    const placeholders = uniqueHan.map(() => '?').join(', ');
    const [referenceResult, ownedResult] = await Promise.all([
      executor.execute(
        `SELECT id_kanji_reference, character, jlpt_level, onyomi, kunyomi, meanings, stroke_count FROM kanji_reference WHERE character IN (${placeholders})`,
        uniqueHan
      ),
      executor.execute(
        `SELECT id_kanji, character_kanji, jlpt_level, status FROM kanji WHERE user_id = ? AND character_kanji IN (${placeholders})`,
        [userId, ...uniqueHan]
      )
    ]);
    for (const row of referenceResult[0] || []) {
      if (row && typeof row.character === 'string') referenceByCharacter.set(row.character, row);
    }
    for (const row of ownedResult[0] || []) {
      if (row && typeof row.character_kanji === 'string') ownedCharacters.add(row.character_kanji);
    }
  }

  const kanji = hanOccurrences.map(({ character }) => {
    const reference = referenceByCharacter.get(character) || null;
    const onyomi = Array.isArray(reference?.onyomi) ? reference.onyomi : [];
    const meanings = Array.isArray(reference?.meanings) ? reference.meanings : [];
    return {
      id: `kanji::${character}`,
      display: character,
      reading: onyomi[0] || null,
      meaning: meanings[0] || null,
      jlpt: normalizeJlpt(reference?.jlpt_level),
      known: ownedCharacters.has(character)
    };
  });

  const lexical = sourceText.length <= MAX_LEXICAL_TEXT_LENGTH
    ? await buildLexicalImmersionCandidates(executor, userId, sourceText)
    : { vocabulary: [], grammar: [], grammarInternals: new Map() };

  const estimatedLevel = estimateDifficultyLevel(uniqueHan, [...referenceByCharacter.values()], ownedCharacters);
  return {
    candidates: { vocabulary: lexical.vocabulary, kanji, grammar: lexical.grammar },
    estimatedLevel,
    stats: {
      characters: totalCharacters,
      uniqueKanji: uniqueHan.length,
      candidateCount: lexical.vocabulary.length + kanji.length + lexical.grammar.length
    },
    internals: { referenceByCharacter, grammarInternals: lexical.grammarInternals }
  };
}

// Read-only analysis for POST /api/immersion/analyze. Never persists.
async function analyzeTextForImmersion(pool, userId, text) {
  const { internals, ...result } = await runAnalysis(pool, userId, text);
  return result;
}

// Intersect the fresh deterministic analysis with client-selected id keys;
// ids not produced by the fresh analysis are ignored by construction.
function intersectSelected(candidates, selectedKeys) {
  return candidates.filter((candidate) => selectedKeys.has(candidate.id));
}

// Idempotent per user: a trimmed word/character/grammar_point already in the
// user's collection is reused, never duplicated.
async function ensureVocabularyEntities(connection, userId, candidates) {
  const ids = new Map();
  let created = 0;
  if (!candidates.length) return { ids, created };
  const words = [...new Set(candidates.map((candidate) => truncateCodePoints(candidate.display, 100)))];
  const [existing] = await connection.execute(
    `SELECT id_vocabulary, word FROM vocabulary WHERE user_id = ? AND word IN (${words.map(() => '?').join(', ')})`,
    [userId, ...words]
  );
  const existingByWord = new Map((existing || []).map((row) => [row.word, Number(row.id_vocabulary)]));
  for (const candidate of candidates) {
    const word = truncateCodePoints(candidate.display, 100);
    if (existingByWord.has(word)) {
      ids.set(candidate.id, existingByWord.get(word));
      continue;
    }
    const [result] = await connection.execute(
      "INSERT INTO vocabulary (word, reading, meaning, jlpt_level, status, user_id) VALUES (?, ?, ?, ?, 'New', ?) RETURNING id_vocabulary AS insertId",
      [
        word,
        candidate.reading ? truncateCodePoints(candidate.reading, 150) : null,
        // meaning is NOT NULL in the schema; reference glosses are attached
        // when the dictionary has the word, otherwise meaning stays empty —
        // a fabricated translation is never written.
        candidate.meaning || '',
        candidate.jlpt,
        userId
      ]
    );
    const id = extractInsertId(result);
    if (!id) throw new Error('Failed to create vocabulary entry.');
    existingByWord.set(word, id);
    ids.set(candidate.id, id);
    created += 1;
  }
  return { ids, created };
}

async function ensureKanjiEntities(connection, userId, candidates, referenceByCharacter) {
  const ids = new Map();
  let created = 0;
  if (!candidates.length) return { ids, created };
  const characters = [...new Set(candidates.map((candidate) => candidate.display))];
  const [existing] = await connection.execute(
    `SELECT id_kanji, character_kanji FROM kanji WHERE user_id = ? AND character_kanji IN (${characters.map(() => '?').join(', ')})`,
    [userId, ...characters]
  );
  const existingByCharacter = new Map((existing || []).map((row) => [row.character_kanji, Number(row.id_kanji)]));
  for (const candidate of candidates) {
    if (existingByCharacter.has(candidate.display)) {
      ids.set(candidate.id, existingByCharacter.get(candidate.display));
      continue;
    }
    const reference = referenceByCharacter.get(candidate.display) || null;
    const onyomi = Array.isArray(reference?.onyomi) && reference.onyomi.length
      ? truncateCodePoints(reference.onyomi.join('、'), 255) : null;
    const kunyomi = Array.isArray(reference?.kunyomi) && reference.kunyomi.length
      ? truncateCodePoints(reference.kunyomi.join('、'), 255) : null;
    const [result] = await connection.execute(
      "INSERT INTO kanji (character_kanji, meaning, onyomi, kunyomi, jlpt_level, status, user_id, reference_id) VALUES (?, ?, ?, ?, ?, 'New', ?, ?) RETURNING id_kanji AS insertId",
      [
        candidate.display,
        // meaning is NOT NULL (varchar(255)); first reference meaning or empty.
        truncateCodePoints((Array.isArray(reference?.meanings) ? reference.meanings[0] : null) || '', 255),
        onyomi,
        kunyomi,
        normalizeJlpt(reference?.jlpt_level),
        userId,
        reference?.id_kanji_reference ?? null
      ]
    );
    const id = extractInsertId(result);
    if (!id) throw new Error('Failed to create kanji entry.');
    existingByCharacter.set(candidate.display, id);
    ids.set(candidate.id, id);
    created += 1;
  }
  return { ids, created };
}

async function ensureGrammarEntities(connection, userId, candidates, grammarInternals) {
  const ids = new Map();
  let created = 0;
  if (!candidates.length) return { ids, created };
  const grammarPoints = [...new Set(candidates.map((candidate) => truncateCodePoints(candidate.display, 100)))];
  const [existing] = await connection.execute(
    `SELECT id_grammar, grammar_point FROM grammar_points WHERE user_id = ? AND grammar_point IN (${grammarPoints.map(() => '?').join(', ')})`,
    [userId, ...grammarPoints]
  );
  const existingByPoint = new Map((existing || []).map((row) => [row.grammar_point, Number(row.id_grammar)]));
  for (const candidate of candidates) {
    const grammarPoint = truncateCodePoints(candidate.display, 100);
    if (existingByPoint.has(grammarPoint)) {
      ids.set(candidate.id, existingByPoint.get(grammarPoint));
      continue;
    }
    const internal = grammarInternals.get(candidate.id) || {};
    const [result] = await connection.execute(
      "INSERT INTO grammar_points (grammar_point, meaning, jlpt_level, status, user_id, reference_id) VALUES (?, ?, ?, 'New', ?, ?) RETURNING id_grammar AS insertId",
      [
        grammarPoint,
        // meaning is NOT NULL (varchar(255)); reference meaning/summary gloss
        // or empty, never fabricated.
        truncateCodePoints(internal.meaning || '', 255),
        internal.jlpt ?? null,
        userId,
        internal.referenceId ?? null
      ]
    );
    const id = extractInsertId(result);
    if (!id) throw new Error('Failed to create grammar entry.');
    existingByPoint.set(grammarPoint, id);
    ids.set(candidate.id, id);
    created += 1;
  }
  return { ids, created };
}

// review_items enrolment: exact createReviewItem pattern from
// reviewController (target column is an internal constant, never user input).
async function createReviewItem(executor, targetColumn, targetId) {
  await executor.execute(
    `INSERT INTO review_items (${targetColumn}, due_on, interval_days) VALUES (?, CURRENT_DATE, 0) ON CONFLICT (${targetColumn}) DO NOTHING`,
    [targetId]
  );
}

const REVIEW_TARGET_COLUMN = { vocabulary: 'id_vocabulary', kanji: 'id_kanji', grammar: 'id_grammar' };

async function createImmersionSession(pool, userId, { text, selected } = {}) {
  if (!Array.isArray(selected)) {
    throw new ValidationError('selected must be an array of candidate id strings.');
  }
  const selectedKeys = new Set();
  for (const key of selected) {
    if (typeof key !== 'string' || !key) {
      throw new ValidationError('selected must contain only non-empty candidate id strings.');
    }
    selectedKeys.add(key);
  }
  const sourceText = normalizeImmersionText(text);
  // NEVER trust client word/meaning payloads: re-run the deterministic
  // analysis and intersect by candidate id keys.
  const analysis = await runAnalysis(pool, userId, sourceText);
  const chosen = {
    vocabulary: intersectSelected(analysis.candidates.vocabulary, selectedKeys),
    kanji: intersectSelected(analysis.candidates.kanji, selectedKeys),
    grammar: intersectSelected(analysis.candidates.grammar, selectedKeys)
  };

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Upsert missing user entities (idempotent per trimmed key + user).
    const vocabularyResult = await ensureVocabularyEntities(connection, userId, chosen.vocabulary);
    const kanjiResult = await ensureKanjiEntities(connection, userId, chosen.kanji, analysis.internals.referenceByCharacter);
    const grammarResult = await ensureGrammarEntities(connection, userId, chosen.grammar, analysis.internals.grammarInternals);

    // 2. Review session for today.
    const [reviewSessionResult] = await connection.execute(
      'INSERT INTO review_sessions (user_id, source_from, source_to) VALUES (?, CURRENT_DATE, CURRENT_DATE) RETURNING id_review_session AS insertId',
      [userId]
    );
    const reviewSessionId = extractInsertId(reviewSessionResult);
    if (!reviewSessionId) throw new Error('Failed to create review session.');

    // 3. Review items for every selected entity (idempotent ON CONFLICT).
    const reviewTargets = ['vocabulary', 'kanji', 'grammar'].flatMap((entityType) => {
      const ids = { vocabulary: vocabularyResult.ids, kanji: kanjiResult.ids, grammar: grammarResult.ids }[entityType];
      return [...ids.values()].map((entityId) => [REVIEW_TARGET_COLUMN[entityType], entityType, entityId]);
    });
    for (const [targetColumn, , targetId] of reviewTargets) {
      await createReviewItem(connection, targetColumn, targetId);
    }

    // 4. Immersion session record (truncated to the accepted maximum).
    const storedText = truncateCodePoints(sourceText, MAX_IMMERSION_TEXT_LENGTH);
    const [immersionResult] = await connection.execute(
      'INSERT INTO immersion_sessions (user_id, source_text, estimated_level, confidence) VALUES (?, ?, ?, ?) RETURNING id_immersion_session AS insertId',
      [userId, storedText, analysis.estimatedLevel.level, analysis.estimatedLevel.confidence]
    );
    const immersionSessionId = extractInsertId(immersionResult);
    if (!immersionSessionId) throw new Error('Failed to create immersion session.');

    // 5. Session item rows (duplicate entity keys are collapsed defensively;
    // the UNIQUE constraint would otherwise roll back on a logic bug).
    if (reviewTargets.length) {
      const itemRows = new Map();
      for (const [, entityType, entityId] of reviewTargets) {
        itemRows.set(`${entityType}::${entityId}`, [entityType, entityId]);
      }
      const rows = [...itemRows.values()];
      await connection.execute(
        `INSERT INTO immersion_session_items (id_immersion_session, entity_type, entity_id) VALUES ${rows.map(() => '(?, ?, ?)').join(', ')}`,
        rows.flatMap(([entityType, entityId]) => [immersionSessionId, entityType, entityId])
      );
    }

    // 6. Kanji encounters for all Han found in the text, via the existing
    // recorder (migration 007 semantics: only kanji already in the user's
    // collection can gain encounter rows, since kanji_encounters references
    // kanji.id_kanji).
    await recordKanjiEncounters(connection, userId, storedText, {
      type: ENCOUNTER_SOURCE_TYPES.IMMERSION_SESSION,
      sourceId: Number(immersionSessionId)
    });

    await connection.commit();
    // Hand-off queue: the resolved entities with their display data so the
    // Review page can start REVIEWING against the freshly created (open)
    // review session. Entity ids are the authoritative server-resolved ones.
    const sessionItems = [
      ...chosen.vocabulary.map((candidate) => ({ entityType: 'vocabulary', entityId: vocabularyResult.ids.get(candidate.id), display: candidate.display, reading: candidate.reading || null, meaning: candidate.meaning || null })),
      ...chosen.kanji.map((candidate) => ({ entityType: 'kanji', entityId: kanjiResult.ids.get(candidate.id), display: candidate.display, reading: candidate.reading || null, meaning: candidate.meaning || null })),
      ...chosen.grammar.map((candidate) => ({ entityType: 'grammar', entityId: grammarResult.ids.get(candidate.id), display: candidate.display, reading: candidate.reading || null, meaning: candidate.meaning || null }))
    ].filter((item) => Number.isInteger(item.entityId)).map((item) => ({ ...item, entityId: Number(item.entityId) }));
    return {
      immersionSessionId: Number(immersionSessionId),
      reviewSessionId: Number(reviewSessionId),
      createdCounts: {
        vocabulary: vocabularyResult.created,
        kanji: kanjiResult.created,
        grammar: grammarResult.created,
        reviewItems: reviewTargets.length
      },
      items: sessionItems
    };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

async function listImmersionSessions(pool, userId, { from, to, level, page, limit, offset } = {}) {
  if (from !== undefined && !isValidDateString(from)) {
    throw new ValidationError('from must use YYYY-MM-DD format.');
  }
  if (to !== undefined && !isValidDateString(to)) {
    throw new ValidationError('to must use YYYY-MM-DD format.');
  }
  validateAllowedValues(level, JLPT_LEVELS, 'level');
  const conditions = ['s.user_id = ?'];
  const params = [userId];
  if (from !== undefined) {
    conditions.push('s.created_at >= CAST(? AS date)');
    params.push(from);
  }
  if (to !== undefined) {
    conditions.push("s.created_at < CAST(? AS date) + INTERVAL '1 day'");
    params.push(to);
  }
  if (level !== undefined) {
    conditions.push('s.estimated_level = ?');
    params.push(level);
  }
  const where = conditions.join(' AND ');
  const [countRows] = await pool.execute(`SELECT COUNT(*) AS total FROM immersion_sessions s WHERE ${where}`, params);
  const total = Number(countRows?.[0]?.total) || 0;
  // Entity-type FILTER literals are inlined (constants, never user input) so
  // the placeholder order stays exactly [filters..., limit, offset]; passing
  // them as parameters would bind them to the earlier WHERE ? slots.
  const [rows] = await pool.execute(
    `SELECT s.id_immersion_session AS id, s.estimated_level AS "estimatedLevel", s.confidence, s.created_at AS "createdAt",
      COUNT(i.id) AS items,
      COUNT(i.id) FILTER (WHERE i.entity_type = 'vocabulary') AS vocabulary,
      COUNT(i.id) FILTER (WHERE i.entity_type = 'kanji') AS kanji,
      COUNT(i.id) FILTER (WHERE i.entity_type = 'grammar') AS grammar
     FROM immersion_sessions s
     LEFT JOIN immersion_session_items i ON i.id_immersion_session = s.id_immersion_session
     WHERE ${where}
     GROUP BY s.id_immersion_session, s.estimated_level, s.confidence, s.created_at
     ORDER BY s.created_at DESC, s.id_immersion_session DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const items = (rows || []).map((row) => ({
    id: Number(row.id),
    estimatedLevel: row.estimatedLevel ?? null,
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    createdAt: row.createdAt ?? null,
    items: {
      total: Number(row.items) || 0,
      vocabulary: Number(row.vocabulary) || 0,
      kanji: Number(row.kanji) || 0,
      grammar: Number(row.grammar) || 0
    }
  }));
  return { items, total, page, limit, offset };
}

module.exports = {
  MAX_IMMERSION_TEXT_LENGTH,
  analyzeTextForImmersion,
  // Reused by the graded-reading service (V5.3a Prompt 2A) so the kanji
  // level heuristic, JMdict gloss lookup, JLPT normalization, and code-point
  // truncation stay single-sourced.
  attachVocabularyGlosses,
  createImmersionSession,
  estimateDifficultyLevel,
  listImmersionSessions,
  normalizeJlpt,
  truncateCodePoints
};
