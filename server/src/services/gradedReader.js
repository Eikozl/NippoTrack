// V5.3a — graded reading analysis and storage.
//
// The level estimate is intentionally deterministic and approximate. Kanji
// level is the base band from immersionPipeline. Grammar density and average
// sentence length may move that band up by at most one level in total. Text
// without classifiable kanji has no level and confidence 0: grammar-only
// evidence is not enough to claim a JLPT band. All counts and offsets use
// Unicode code points. Lexical/grammar parsing is sentence-segmented and no
// call to Kuromoji receives more than its documented 2000-character limit.

const poolDefault = require('../config/db');
const { ValidationError } = require('../errors/http');
const { JLPT_LEVELS } = require('../constants');
const {
  attachVocabularyGlosses,
  estimateDifficultyLevel,
  normalizeJlpt,
  truncateCodePoints
} = require('./immersionPipeline');
const { extractHanOccurrences } = require('./textKanjiAnalysis');
const { MAX_LEXICAL_TEXT_LENGTH, engineMetadata, parseJapanese } = require('./japaneseParser');
const { adaptTokens } = require('./lexicalTokenAdapter');
const { buildLexicalCandidates, matchOwnedVocabulary } = require('./lexicalCandidates');
const { detectGrammar } = require('./grammarDetector');
const { hydrateGrammarMatches } = require('./grammarReferenceStore');
const { isValidDateString } = require('../validation');

const MAX_READING_TEXT_LENGTH = 100000;
const MAX_READING_TITLE_LENGTH = 200;
const MAX_ANNOTATIONS = 500;
const MAX_LIBRARY_LIMIT = 50;
const MAX_IMPORT_ITEMS = 20;
const MAX_DATABASE_IN_VALUES = 1000;
const SOURCE_TIMEOUT_MS = 8000;
const NHK_RSS_URL = 'https://www3.nhk.or.jp/rss/news/easy.xml';
const AOZORA_LISTING_URL = 'https://www.aozora.gr.jp/index_pages/sakuhin_top.html';
const LEVEL_RANK = Object.freeze({ N5: 1, N4: 2, N3: 3, N2: 4, N1: 5 });
const LEVEL_BY_RANK = Object.freeze(['N5', 'N4', 'N3', 'N2', 'N1']);

function codePointLength(value) {
  return Array.from(value).length;
}

function normalizeReadingText(text) {
  if (typeof text !== 'string') throw new ValidationError('text is required and must be a string.');
  const normalized = text.trim();
  if (!normalized) throw new ValidationError('text is required.');
  if (codePointLength(normalized) > MAX_READING_TEXT_LENGTH) {
    throw new ValidationError(`text must not exceed ${MAX_READING_TEXT_LENGTH} characters.`);
  }
  return normalized;
}

function normalizeAnalysisText(text) {
  if (typeof text !== 'string') throw new ValidationError('text is required and must be a string.');
  const normalized = text.trim();
  if (codePointLength(normalized) > MAX_READING_TEXT_LENGTH) {
    throw new ValidationError(`text must not exceed ${MAX_READING_TEXT_LENGTH} characters.`);
  }
  return normalized;
}

function normalizeTitle(title) {
  if (title === undefined || title === null || title === '') return 'Untitled reading';
  if (typeof title !== 'string') throw new ValidationError('title must be a string.');
  const value = title.trim();
  if (!value) throw new ValidationError('title is required.');
  if (codePointLength(value) > MAX_READING_TITLE_LENGTH) {
    throw new ValidationError(`title must not exceed ${MAX_READING_TITLE_LENGTH} characters.`);
  }
  return value;
}

function extractInsertId(result) {
  const first = Array.isArray(result) ? result[0] : result;
  const row = Array.isArray(first) ? first[0] : first;
  if (!row || typeof row !== 'object') return null;
  const value = row.insertId ?? row.insertid ?? row.id ?? row.id_reading_text ?? row.id_reading_source;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function splitSentences(text) {
  const points = Array.from(text);
  if (!points.length) return [];
  const sentences = [];
  let start = 0;
  for (let index = 0; index < points.length; index += 1) {
    if (!/[。！？!?\n\r]/u.test(points[index])) continue;
    const end = index + 1;
    const sentencePoints = points.slice(start, end);
    let leading = 0;
    while (leading < sentencePoints.length && /\s/u.test(sentencePoints[leading])) leading += 1;
    let trailing = sentencePoints.length;
    while (trailing > leading && /\s/u.test(sentencePoints[trailing - 1])) trailing -= 1;
    const sentence = sentencePoints.slice(leading, trailing).join('');
    if (sentence) sentences.push({ text: sentence, start: start + leading });
    start = end;
  }
  if (start < points.length) {
    const tailPoints = points.slice(start);
    let leading = 0;
    while (leading < tailPoints.length && /\s/u.test(tailPoints[leading])) leading += 1;
    let trailing = tailPoints.length;
    while (trailing > leading && /\s/u.test(tailPoints[trailing - 1])) trailing -= 1;
    const tail = tailPoints.slice(leading, trailing).join('');
    if (tail) sentences.push({ text: tail, start: start + leading });
  }
  return sentences;
}

// Keep sentence boundaries where possible; very long sentences are split by
// code point without ever crossing MAX_LEXICAL_TEXT_LENGTH UTF-16 code units.
function parserSegments(sentences) {
  const segments = [];
  for (const sentence of sentences) {
    let content = '';
    let segmentStart = sentence.start;
    let offset = sentence.start;
    for (const character of Array.from(sentence.text)) {
      if (content && content.length + character.length > MAX_LEXICAL_TEXT_LENGTH) {
        segments.push({ text: content, start: segmentStart });
        segmentStart = offset;
        content = '';
      }
      content += character;
      offset += 1;
    }
    if (content) segments.push({ text: content, start: segmentStart });
  }
  return segments;
}

function firstKanjiPositions(text) {
  const positions = new Map();
  let position = 0;
  for (const character of text) {
    if (/\p{Script=Han}/u.test(character) && !positions.has(character)) positions.set(character, position);
    position += 1;
  }
  return positions;
}

function batches(values, size = MAX_DATABASE_IN_VALUES) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function loadKanjiData(executor, userId, characters) {
  const referenceByCharacter = new Map();
  const ownedCharacters = new Set();
  for (const group of batches(characters)) {
    const placeholders = group.map(() => '?').join(', ');
    const [referenceRows, ownedRows] = await Promise.all([
      executor.execute(
        `SELECT id_kanji_reference, character, jlpt_level, onyomi, kunyomi, meanings FROM kanji_reference WHERE character IN (${placeholders})`,
        group
      ),
      executor.execute(
        `SELECT id_kanji, character_kanji FROM kanji WHERE user_id = ? AND character_kanji IN (${placeholders})`,
        [userId, ...group]
      )
    ]);
    for (const row of referenceRows[0] || []) {
      if (row && typeof row.character === 'string') referenceByCharacter.set(row.character, row);
    }
    for (const row of ownedRows[0] || []) {
      if (row && typeof row.character_kanji === 'string') ownedCharacters.add(row.character_kanji);
    }
  }
  return { referenceByCharacter, ownedCharacters };
}

function mergeVocabularyCandidates(target, candidate, offset) {
  const key = candidate.key || `${candidate.pos}::${candidate.canonical}`;
  const position = (Number.isInteger(candidate.firstStart) ? candidate.firstStart : 0) + offset;
  const existing = target.get(key);
  if (!existing) {
    target.set(key, { ...candidate, firstStart: position });
    return;
  }
  existing.firstStart = Math.min(existing.firstStart, position);
  existing.occurrences += candidate.occurrences || 0;
  if (candidate.match?.state === 'existing') existing.match = candidate.match;
  if (!existing.lemmaReading && candidate.lemmaReading) existing.lemmaReading = candidate.lemmaReading;
  if (!existing.surfaceReading && candidate.surfaceReading) existing.surfaceReading = candidate.surfaceReading;
}

function grammarMatchKey(match) {
  return `${match.sourceSlug || (match.sourceSlugs || []).join(',') || match.familyId || match.ruleId}:${match.detected?.start}:${match.detected?.end}`;
}

async function collectLexicalAnalysis(executor, userId, sentences) {
  const vocabularyByKey = new Map();
  const grammarByKey = new Map();
  for (const segment of parserSegments(sentences)) {
    let tokens;
    try {
      const { rawTokens } = await parseJapanese(segment.text);
      tokens = adaptTokens(rawTokens, segment.text, engineMetadata());
    } catch (_) {
      // A parser failure only degrades lexical/grammar annotations for this
      // bounded segment. Kanji analysis remains independent and authoritative.
      continue;
    }
    const { candidates } = buildLexicalCandidates(tokens);
    if (candidates.length) {
      // Ownership query failures are not parser degradation: propagate them
      // rather than falsely implying that every word is unknown.
      await matchOwnedVocabulary(executor, userId, candidates);
      for (const candidate of candidates) mergeVocabularyCandidates(vocabularyByKey, candidate, segment.start);
    }
    try {
      for (const match of detectGrammar(tokens)) {
        const translated = {
          ...match,
          detected: {
            ...match.detected,
            start: match.detected.start + segment.start,
            end: match.detected.end + segment.start
          }
        };
        grammarByKey.set(grammarMatchKey(translated), translated);
      }
    } catch (_) {
      // Grammar rules are best-effort; lexical analysis and kanji results stay.
    }
  }
  const vocabulary = [...vocabularyByKey.values()].sort((a, b) => a.firstStart - b.firstStart);
  await attachVocabularyGlosses(executor, vocabulary);
  const grammarMatches = [...grammarByKey.values()];
  const grammar = await hydrateGrammarMatches(userId, grammarMatches, executor);
  return { vocabulary, grammar };
}

function buildStats(text, kanjiPositions, kanjiEstimate, vocabulary, grammar) {
  const sentences = splitSentences(text);
  const sentenceLengths = sentences.map((sentence) => codePointLength(sentence.text));
  const average = sentenceLengths.length
    ? sentenceLengths.reduce((total, length) => total + length, 0) / sentenceLengths.length
    : 0;
  const grammarByLevel = { N5: 0, N4: 0, N3: 0, N2: 0, N1: 0, unclassified: 0 };
  for (const match of grammar) {
    if (match.status !== 'DETERMINATE' || !match.reference) continue;
    const level = normalizeJlpt(match.reference.jlptLevel);
    grammarByLevel[level || 'unclassified'] += 1;
  }
  const grammarMatches = Object.values(grammarByLevel).reduce((sum, count) => sum + count, 0);
  const characters = codePointLength(text);
  return {
    characters,
    uniqueKanji: kanjiPositions.size,
    knownKanjiPct: kanjiEstimate.stats.kanjiKnownPct,
    byLevel: kanjiEstimate.stats.byLevel,
    sentences: sentences.length,
    avgSentenceLength: Math.round(average * 10) / 10,
    vocabUnknown: vocabulary.filter((candidate) => candidate.match?.state !== 'existing').length,
    grammarMatches,
    grammarMatchesPer1000: characters ? Math.round((grammarMatches / characters) * 100000) / 100 : 0,
    grammarByLevel
  };
}

function deriveBlendedLevel(kanjiLevel, baseConfidence, stats) {
  if (!kanjiLevel) return { level: null, confidence: 0 };
  const baseRank = LEVEL_RANK[kanjiLevel];
  const grammarAdjustment = Math.min(0.5, stats.grammarMatchesPer1000 / 10);
  const sentenceAdjustment = Math.min(0.5, Math.max(0, stats.avgSentenceLength - 20) / 80);
  const blendedRank = Math.max(1, Math.min(5, Math.round(baseRank + grammarAdjustment + sentenceAdjustment)));
  const textEvidence = Math.min(1, stats.characters / 1000);
  const confidence = Math.round(Math.min(1, baseConfidence * 0.75 + textEvidence * 0.25) * 100) / 100;
  return { level: LEVEL_BY_RANK[blendedRank - 1], confidence };
}

function makeAnnotations(kanjiPositions, kanjiData, vocabulary, grammar) {
  const annotations = [];
  for (const [character, position] of kanjiPositions) {
    const reference = kanjiData.referenceByCharacter.get(character);
    const readings = Array.isArray(reference?.onyomi) ? reference.onyomi : [];
    const meanings = Array.isArray(reference?.meanings) ? reference.meanings : [];
    annotations.push({
      type: 'kanji',
      char: character,
      position,
      level: normalizeJlpt(reference?.jlpt_level),
      known: kanjiData.ownedCharacters.has(character),
      reading: readings[0] || null,
      meaning: meanings[0] || null,
      info: reference ? {
        onyomi: readings,
        kunyomi: Array.isArray(reference.kunyomi) ? reference.kunyomi : []
      } : null
    });
  }
  for (const candidate of vocabulary) {
    annotations.push({
      type: 'vocabulary',
      word: candidate.canonical,
      position: candidate.firstStart,
      level: null,
      known: candidate.match?.state === 'existing',
      reading: candidate.lemmaReading || candidate.surfaceReading || null,
      meaning: candidate.gloss || null
    });
  }
  for (const match of grammar) {
    if (match.status !== 'DETERMINATE' || !match.reference) continue;
    const reference = match.reference;
    annotations.push({
      type: 'grammar',
      pattern: reference.grammarPoint,
      position: match.detected.start,
      level: normalizeJlpt(reference.jlptLevel),
      known: match.collection?.inGrammar === true,
      reading: reference.kana || null,
      meaning: reference.meaning || reference.summary || null,
      explanation: reference.summary || reference.meaning || null,
      info: { structures: reference.structures || [], pitfalls: reference.pitfalls || [] }
    });
  }
  const priority = { kanji: 0, vocabulary: 1, grammar: 2 };
  annotations.sort((a, b) => a.position - b.position || priority[a.type] - priority[b.type]);
  return annotations.slice(0, MAX_ANNOTATIONS);
}

async function analyzeReading(executor, userId, rawText) {
  const text = normalizeAnalysisText(rawText);
  const sentences = splitSentences(text);
  const positions = firstKanjiPositions(text);
  const kanjiCharacters = [...positions.keys()];
  const kanjiData = await loadKanjiData(executor, userId, kanjiCharacters);
  const kanjiEstimate = estimateDifficultyLevel(
    kanjiCharacters,
    [...kanjiData.referenceByCharacter.values()],
    kanjiData.ownedCharacters
  );
  const lexical = await collectLexicalAnalysis(executor, userId, sentences);
  const stats = buildStats(text, positions, kanjiEstimate, lexical.vocabulary, lexical.grammar);
  const blended = deriveBlendedLevel(kanjiEstimate.level, kanjiEstimate.confidence, stats);
  return {
    level: blended.level,
    confidence: blended.confidence,
    stats,
    annotations: makeAnnotations(positions, kanjiData, lexical.vocabulary, lexical.grammar)
  };
}

async function analyzeTextForReading(executor = poolDefault, userId, text) {
  return analyzeReading(executor, userId, text);
}

async function classifyLevel(executor = poolDefault, userId, text) {
  const { level, confidence, stats } = await analyzeReading(executor, userId, text);
  return { level, confidence, stats };
}

async function buildAnnotations(executor = poolDefault, userId, text) {
  return (await analyzeReading(executor, userId, text)).annotations;
}

async function listReadingLibrary(executor, userId, {
  level,
  source,
  date,
  page = 1,
  limit = 20,
  offset = (page - 1) * limit
} = {}) {
  if (level !== undefined && level !== '' && !JLPT_LEVELS.includes(level)) {
    throw new ValidationError(`level must be one of: ${JLPT_LEVELS.join(', ')}`);
  }
  if (source !== undefined && source !== '' && !['aozora', 'nhk', 'user'].includes(source)) {
    throw new ValidationError('source must be one of: aozora, nhk, user.');
  }
  if (date !== undefined && date !== '' && !isValidDateString(date)) {
    throw new ValidationError('date must use YYYY-MM-DD format.');
  }
  if (!Number.isSafeInteger(page) || page < 1) throw new ValidationError('page must be a positive integer.');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIBRARY_LIMIT) {
    throw new ValidationError(`limit must be a positive integer no greater than ${MAX_LIBRARY_LIMIT}.`);
  }
  if (!Number.isSafeInteger(offset) || offset < 0) throw new ValidationError('page is too large.');

  const where = ['(rt.user_id IS NULL OR rt.user_id = ?)'];
  const params = [userId];
  if (level) { where.push('rt.level = ?'); params.push(level); }
  if (source) { where.push('rs.type = ?'); params.push(source); }
  if (date) { where.push('rt.created_at::date = CAST(? AS date)'); params.push(date); }
  const whereSql = where.join(' AND ');
  const [countRows] = await executor.execute(
    `SELECT COUNT(*) AS total FROM reading_texts rt LEFT JOIN reading_sources rs ON rs.id_reading_source = rt.source_id WHERE ${whereSql}`,
    params
  );
  const [rows] = await executor.execute(
    `SELECT rt.id_reading_text AS id, rt.title, rt.level, COALESCE(rs.type, 'user') AS "sourceType", rt.text, rt.created_at AS "createdAt"
     FROM reading_texts rt LEFT JOIN reading_sources rs ON rs.id_reading_source = rt.source_id
     WHERE ${whereSql} ORDER BY rt.created_at DESC, rt.id_reading_text DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const itemRows = rows || [];
  const characterSets = itemRows.map((row) => new Set(extractHanOccurrences(row.text || '').map(({ character }) => character)));
  const allCharacters = [...new Set(characterSets.flatMap((set) => [...set]))];
  const ownedCharacters = new Set();
  for (const group of batches(allCharacters)) {
    const placeholders = group.map(() => '?').join(', ');
    const [ownedRows] = await executor.execute(
      `SELECT character_kanji FROM kanji WHERE user_id = ? AND character_kanji IN (${placeholders})`,
      [userId, ...group]
    );
    for (const row of ownedRows || []) if (row?.character_kanji) ownedCharacters.add(row.character_kanji);
  }
  const items = itemRows.map((row, index) => {
    const characters = characterSets[index];
    const known = [...characters].filter((character) => ownedCharacters.has(character)).length;
    return {
      id: Number(row.id),
      title: row.title,
      level: normalizeJlpt(row.level),
      sourceType: row.sourceType || 'user',
      characterCount: codePointLength(row.text || ''),
      knownKanjiPct: characters.size ? Math.round((known / characters.size) * 1000) / 10 : 0
    };
  });
  return { items, total: Number(countRows?.[0]?.total) || 0, page, limit, totalPages: Number(countRows?.[0]?.total) ? Math.ceil(Number(countRows[0].total) / limit) : 0 };
}

function parseMetadata(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

async function getReadingText(executor, userId, id) {
  const [rows] = await executor.execute(
    `SELECT rt.id_reading_text AS id, rt.title, rt.level, COALESCE(rs.type, 'user') AS "sourceType", rs.metadata,
       rt.text, p.position, p.completed_at AS "completedAt", p.time_spent_seconds AS "timeSpentSeconds"
     FROM reading_texts rt LEFT JOIN reading_sources rs ON rs.id_reading_source = rt.source_id
     LEFT JOIN user_reading_progress p ON p.text_id = rt.id_reading_text AND p.user_id = ?
     WHERE rt.id_reading_text = ? AND (rt.user_id IS NULL OR rt.user_id = ?)`,
    [userId, id, userId]
  );
  const row = rows?.[0];
  if (!row) return null;
  const annotations = await buildAnnotations(executor, userId, row.text);
  const progress = row.position === null || row.position === undefined ? null : {
    position: Number(row.position),
    timeSpentSeconds: Number(row.timeSpentSeconds) || 0,
    completed: Boolean(row.completedAt),
    completedAt: row.completedAt || null
  };
  return {
    id: Number(row.id),
    title: row.title,
    level: normalizeJlpt(row.level),
    sourceType: row.sourceType || 'user',
    metadata: parseMetadata(row.metadata),
    text: row.text,
    annotations,
    progress
  };
}

async function createUserReadingText(executor, userId, { text: rawText, title: rawTitle } = {}) {
  const text = normalizeReadingText(rawText);
  const title = normalizeTitle(rawTitle);
  const analysis = await analyzeReading(executor, userId, text);
  const connection = await executor.getConnection();
  try {
    await connection.beginTransaction();
    const [sourceResult] = await connection.execute(
      "INSERT INTO reading_sources (type, url, title, metadata, fetched_at) VALUES ('user', NULL, ?, '{}'::jsonb, CURRENT_TIMESTAMP) RETURNING id_reading_source AS insertId",
      [title]
    );
    const sourceId = extractInsertId(sourceResult);
    if (!sourceId) throw new Error('Failed to create reading source.');
    const [textResult] = await connection.execute(
      'INSERT INTO reading_texts (source_id, user_id, text, title, level, annotations_json) VALUES (?, ?, ?, ?, ?, ?::jsonb) RETURNING id_reading_text AS insertId',
      [sourceId, userId, text, title, analysis.level, JSON.stringify(analysis.annotations)]
    );
    const id = extractInsertId(textResult);
    if (!id) throw new Error('Failed to create reading text.');
    await connection.commit();
    return { id, title, ...analysis };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

async function upsertReadingProgress(executor, userId, textId, {
  position,
  timeSpentSeconds,
  completed
} = {}) {
  const [textRows] = await executor.execute(
    'SELECT id_reading_text, text FROM reading_texts WHERE id_reading_text = ? AND (user_id IS NULL OR user_id = ?)',
    [textId, userId]
  );
  const textRow = textRows?.[0];
  if (!textRow) return null;
  if (!Number.isSafeInteger(position) || position < 1 || position > codePointLength(textRow.text)) {
    throw new ValidationError('position must be a positive integer within the text length.');
  }
  if (timeSpentSeconds !== undefined && (!Number.isSafeInteger(timeSpentSeconds) || timeSpentSeconds < 1 || timeSpentSeconds > 86400)) {
    throw new ValidationError('timeSpentSeconds must be a positive integer no greater than 86400.');
  }
  if (completed !== undefined && typeof completed !== 'boolean') throw new ValidationError('completed must be a boolean.');
  // PUT replaces the progress state: omitted optional values reset to their
  // schema defaults, making retries deterministic rather than additive.
  const [result] = await executor.execute(
    `INSERT INTO user_reading_progress (user_id, text_id, position, time_spent_seconds, completed_at)
     SELECT ?, rt.id_reading_text, ?, ?, CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END
     FROM reading_texts rt
     WHERE rt.id_reading_text = ? AND (rt.user_id IS NULL OR rt.user_id = ?)
     ON CONFLICT (user_id, text_id) DO UPDATE SET
       position = EXCLUDED.position,
       time_spent_seconds = EXCLUDED.time_spent_seconds,
       completed_at = EXCLUDED.completed_at
     RETURNING id AS insertId`,
    [userId, position, timeSpentSeconds ?? 0, completed ?? false, textId, userId]
  );
  if (!extractInsertId(result)) return null;
  return {
    position,
    timeSpentSeconds: timeSpentSeconds ?? 0,
    completed: completed ?? false
  };
}

// User-scoped reading progress listing (library/stats feed). Joins text
// metadata + source type so the client can aggregate without extra round
// trips; foreign rows are never visible because the query starts from the
// user's own progress rows.
async function listReadingProgress(executor, userId, { page, limit, offset } = {}) {
  const [countRows] = await executor.execute(
    'SELECT COUNT(*) AS total FROM user_reading_progress WHERE user_id = ?',
    [userId]
  );
  const total = Number(countRows?.[0]?.total || 0);
  const [rows] = await executor.execute(
    `SELECT p.text_id AS "textId",
       t.title, t.level,
       length(t.text) AS "characters",
       s.type AS "sourceType",
       p.position, p.completed_at AS "completedAt",
       p.time_spent_seconds AS "timeSpentSeconds",
       p.updated_at AS "updatedAt"
      FROM user_reading_progress p
      JOIN reading_texts t ON t.id_reading_text = p.text_id
      LEFT JOIN reading_sources s ON s.id_reading_source = t.source_id
      WHERE p.user_id = ?
      ORDER BY p.updated_at DESC, p.text_id DESC
      LIMIT ? OFFSET ?`,
    [userId, limit, offset]
  );
  const items = (rows || []).map((row) => ({
    textId: Number(row.textId),
    title: row.title,
    level: row.level || null,
    characters: Number(row.characters || 0),
    sourceType: row.sourceType || null,
    position: Number(row.position || 0),
    completedAt: row.completedAt || null,
    timeSpentSeconds: Number(row.timeSpentSeconds || 0),
    updatedAt: row.updatedAt || null
  }));
  return { items, total, page, limit, totalPages: total ? Math.ceil(total / limit) : 0 };
}

function decodeEntities(value) {
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
    const key = entity.toLowerCase();
    if (key === 'amp') return '&';
    if (key === 'lt') return '<';
    if (key === 'gt') return '>';
    if (key === 'quot') return '"';
    if (key === 'apos') return "'";
    if (key === 'nbsp') return ' ';
    const number = key.startsWith('#x') ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    if (!Number.isInteger(number) || number < 1 || number > 0x10ffff || (number >= 0xd800 && number <= 0xdfff)) return match;
    return String.fromCodePoint(number);
  });
}

function plainTextFromMarkup(value) {
  const source = decodeEntities(String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  );
  return decodeEntities(source
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\/(p|div|br|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' '))
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function xmlTag(xml, tagName) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(xml).match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}\\s*>`, 'i'));
  return match ? plainTextFromMarkup(match[1]) : '';
}

function safeExternalUrl(value, allowedHost) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.hostname !== allowedHost || url.port || url.username || url.password) return null;
    return url;
  } catch (_) {
    return null;
  }
}

async function readResponseBody(response, maxBytes) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    try { await response.body?.cancel?.(); } catch (_) { /* source response is already over the accepted limit */ }
    throw new Error('response_too_large');
  }
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel();
          throw new Error('response_too_large');
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > maxBytes) throw new Error('response_too_large');
  return body;
}

async function fetchFixedText(fetchImpl, rawUrl, host, maxBytes) {
  const url = safeExternalUrl(rawUrl, host);
  if (!url || typeof fetchImpl !== 'function') throw new Error('invalid_source');
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), SOURCE_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const response = await fetchImpl(url.toString(), {
      signal: abort.signal,
      redirect: 'error',
      headers: { 'User-Agent': 'NippoTrack/graded-reading source import' }
    });
    if (!response?.ok) throw new Error('source_unavailable');
    return await readResponseBody(response, maxBytes);
  } finally {
    clearTimeout(timer);
  }
}

function nhkItemsFromXml(xml) {
  const items = [];
  const itemPattern = /<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi;
  let match;
  while ((match = itemPattern.exec(xml)) && items.length < MAX_IMPORT_ITEMS) {
    const itemXml = match[1];
    const title = truncateCodePoints(xmlTag(itemXml, 'title'), MAX_READING_TITLE_LENGTH);
    const url = safeExternalUrl(xmlTag(itemXml, 'link'), 'www3.nhk.or.jp');
    if (!title || !url) continue;
    const pubDate = xmlTag(itemXml, 'pubDate');
    const parsedDate = pubDate && Number.isFinite(Date.parse(pubDate)) ? new Date(pubDate).toISOString() : null;
    const description = xmlTag(itemXml, 'description');
    const audioMatch = itemXml.match(/<(?:enclosure|media:content)\b[^>]*\burl=["']([^"']+)["'][^>]*\/?\s*>/i);
    const audioUrl = audioMatch ? safeExternalUrl(decodeEntities(audioMatch[1]), 'www3.nhk.or.jp') : null;
    items.push({
      title,
      url: url.toString(),
      date: parsedDate,
      text: description ? truncateCodePoints(description, MAX_READING_TEXT_LENGTH) : null,
      audio: audioUrl ? audioUrl.toString() : null
    });
  }
  return items;
}

async function loadNHKEasySources(fetchImpl = globalThis.fetch) {
  try {
    const xml = await fetchFixedText(fetchImpl, NHK_RSS_URL, 'www3.nhk.or.jp', 1024 * 1024);
    return { status: 'ok', items: nhkItemsFromXml(xml) };
  } catch (error) {
    return { status: 'unavailable', reason: error?.message === 'response_too_large' ? 'Source response exceeded the size limit.' : 'Source request failed.' };
  }
}

function aozoraListingItems(html) {
  const items = [];
  const anchors = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi;
  let match;
  while ((match = anchors.exec(html)) && items.length < 10) {
    let resolved;
    try { resolved = new URL(decodeEntities(match[2]), AOZORA_LISTING_URL); } catch (_) { continue; }
    const url = safeExternalUrl(resolved.toString(), 'www.aozora.gr.jp');
    if (!url || !/^\/cards\/\d+\/card\d+\.html$/i.test(url.pathname)) continue;
    const title = truncateCodePoints(plainTextFromMarkup(match[3]), MAX_READING_TITLE_LENGTH);
    if (!title) continue;
    if (!items.some((item) => item.url === url.toString())) items.push({ title, url: url.toString(), date: null, text: null, audio: null });
  }
  return items;
}

function aozoraTextUrlFromCard(cardHtml, baseUrl) {
  const anchors = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi;
  let match;
  while ((match = anchors.exec(cardHtml))) {
    const label = plainTextFromMarkup(match[3]);
    if (!/テキスト|本文|html|text/i.test(label + ' ' + match[2])) continue;
    let resolved;
    try { resolved = new URL(decodeEntities(match[2]), baseUrl); } catch (_) { continue; }
    if (!safeExternalUrl(resolved.toString(), 'www.aozora.gr.jp')) continue;
    if (/^\/files\/[\w./%-]+\.(?:html?|txt)$/i.test(resolved.pathname)) return resolved.toString();
  }
  return null;
}

function extractAozoraText(html) {
  const main = html.match(/<div\b[^>]*class=["'][^"']*main_text[^"']*["'][^>]*>([\s\S]*?)<\/div\s*>/i);
  const article = main ? main[1] : html;
  const cleaned = plainTextFromMarkup(article)
    .replace(/［＃[^］]*］/g, '')
    .replace(/《[^》]*》/g, '')
    .replace(/｜/g, '');
  return truncateCodePoints(cleaned, MAX_READING_TEXT_LENGTH);
}

async function loadAozoraArticle(fetchImpl, item) {
  try {
    const card = await fetchFixedText(fetchImpl, item.url, 'www.aozora.gr.jp', 2 * 1024 * 1024);
    const articleUrl = aozoraTextUrlFromCard(card, item.url);
    if (!articleUrl) return item;
    const article = await fetchFixedText(fetchImpl, articleUrl, 'www.aozora.gr.jp', 2 * 1024 * 1024);
    const text = extractAozoraText(article);
    return { ...item, text: text || null };
  } catch (_) {
    return item;
  }
}

// Aozora has no stable API. This loader intentionally reads one fixed
// work-index listing, accepts only same-host card URLs, and fetches at most
// ten card/article pairs; unavailable or differently structured pages remain
// metadata-only instead of guessing at site markup.
async function loadAozoraSources(fetchImpl = globalThis.fetch) {
  try {
    const html = await fetchFixedText(fetchImpl, AOZORA_LISTING_URL, 'www.aozora.gr.jp', 2 * 1024 * 1024);
    const items = aozoraListingItems(html);
    const enriched = [];
    for (let index = 0; index < items.length; index += 3) {
      const group = await Promise.all(items.slice(index, index + 3).map((item) => loadAozoraArticle(fetchImpl, item)));
      enriched.push(...group);
    }
    return { status: 'ok', items: enriched };
  } catch (error) {
    return { status: 'unavailable', reason: error?.message === 'response_too_large' ? 'Source response exceeded the size limit.' : 'Source request failed.' };
  }
}

async function syncReadingSources(executor, userId, sourceType, { fetch: fetchImpl = globalThis.fetch } = {}) {
  if (!['aozora', 'nhk'].includes(sourceType)) throw new ValidationError('sourceType must be aozora or nhk.');
  const sourceResult = sourceType === 'nhk'
    ? await loadNHKEasySources(fetchImpl)
    : await loadAozoraSources(fetchImpl);
  if (sourceResult.status !== 'ok') return sourceResult;
  const items = sourceResult.items.slice(0, MAX_IMPORT_ITEMS);
  if (!items.length) return { status: 'ok', imported: 0, textsImported: 0 };

  const prepared = [];
  for (const item of items) {
    const text = typeof item.text === 'string' && item.text.trim()
      ? truncateCodePoints(item.text.trim(), MAX_READING_TEXT_LENGTH)
      : null;
    const analysis = text ? await analyzeReading(executor, userId, text) : null;
    prepared.push({ item, text, analysis });
  }

  const connection = await executor.getConnection();
  let textsImported = 0;
  try {
    await connection.beginTransaction();
    for (const { item, text, analysis } of prepared) {
      // Migration 022 intentionally has no UNIQUE(type,url). A transaction
      // advisory lock serializes check/insert for this stable key without
      // requiring an unreviewed database change.
      await connection.execute('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', [sourceType, item.url]);
      const [existingRows] = await connection.execute(
        'SELECT id_reading_source FROM reading_sources WHERE type = ? AND url = ? ORDER BY id_reading_source LIMIT 1',
        [sourceType, item.url]
      );
      let sourceId = Number(existingRows?.[0]?.id_reading_source) || null;
      const metadata = JSON.stringify({ date: item.date || null, audio: item.audio || null });
      if (sourceId) {
        await connection.execute(
          'UPDATE reading_sources SET title = ?, metadata = ?::jsonb, fetched_at = CURRENT_TIMESTAMP WHERE id_reading_source = ?',
          [item.title, metadata, sourceId]
        );
      } else {
        const [insertResult] = await connection.execute(
          'INSERT INTO reading_sources (type, url, title, metadata, fetched_at) VALUES (?, ?, ?, ?::jsonb, CURRENT_TIMESTAMP) RETURNING id_reading_source AS insertId',
          [sourceType, item.url, item.title, metadata]
        );
        sourceId = extractInsertId(insertResult);
        if (!sourceId) throw new Error('Failed to save reading source.');
      }
      if (!text) continue;
      const [existingTextRows] = await connection.execute(
        'SELECT id_reading_text FROM reading_texts WHERE source_id = ? AND user_id IS NULL ORDER BY id_reading_text LIMIT 1',
        [sourceId]
      );
      const existingTextId = Number(existingTextRows?.[0]?.id_reading_text) || null;
      if (existingTextId) {
        await connection.execute(
          "UPDATE reading_texts SET text = ?, title = ?, level = ?, annotations_json = '[]'::jsonb WHERE id_reading_text = ? AND user_id IS NULL",
          [text, item.title, analysis.level, existingTextId]
        );
      } else {
        const [textResult] = await connection.execute(
          "INSERT INTO reading_texts (source_id, user_id, text, title, level, annotations_json) VALUES (?, NULL, ?, ?, ?, '[]'::jsonb) RETURNING id_reading_text AS insertId",
          [sourceId, text, item.title, analysis.level]
        );
        if (!extractInsertId(textResult)) throw new Error('Failed to save reading text.');
      }
      textsImported += 1;
    }
    await connection.commit();
    return { status: 'ok', imported: items.length, textsImported };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = {
  AOZORA_LISTING_URL,
  MAX_ANNOTATIONS,
  MAX_IMPORT_ITEMS,
  MAX_LIBRARY_LIMIT,
  MAX_READING_TEXT_LENGTH,
  MAX_READING_TITLE_LENGTH,
  NHK_RSS_URL,
  buildAnnotations,
  analyzeTextForReading,
  classifyLevel,
  createUserReadingText,
  extractAozoraText,
  getReadingText,
  loadAozoraSources,
  loadNHKEasySources,
  listReadingLibrary,
  listReadingProgress,
  normalizeReadingText,
  normalizeAnalysisText,
  normalizeTitle,
  syncReadingSources,
  upsertReadingProgress
};
