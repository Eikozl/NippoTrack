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
  ensureGrammarEntities,
  ensureKanjiEntities,
  ensureVocabularyEntities,
  estimateDifficultyLevel,
  intersectSelected,
  normalizeJlpt,
  truncateCodePoints
} = require('./immersionPipeline');
const { extractHanOccurrences } = require('./textKanjiAnalysis');
const { MAX_LEXICAL_TEXT_LENGTH, engineMetadata, parseJapanese } = require('./japaneseParser');
const { adaptTokens, classifyCandidate } = require('./lexicalTokenAdapter');
const { buildLexicalCandidates, candidateIdentity, matchOwnedVocabulary, reconstructObservedSurface } = require('./lexicalCandidates');
const { detectGrammar } = require('./grammarDetector');
const { hydrateGrammarMatches } = require('./grammarReferenceStore');
const { isValidDateString } = require('../validation');

const MAX_READING_TEXT_LENGTH = 100000;
const MAX_READING_TITLE_LENGTH = 200;
const MAX_ANNOTATIONS = 500;
const MAX_LIBRARY_LIMIT = 50;
const MAX_IMPORT_ITEMS = 20;
const MAX_DATABASE_IN_VALUES = 1000;
const MAX_READING_ENROLL_ITEMS = 200;
// P0 payload bound: per-occurrence tokens scale with text length (tens of
// thousands on 100k-char Aozora imports). The reader degrades explicitly
// past this cap (truncated:true) instead of serving MB-scale JSON.
const MAX_TOKENS = 2000;
// Editorial translations are user-authored content (reader "Tap to reveal
// English"), not parser output: bounded like notes, never fabricated.
const MAX_TRANSLATION_LENGTH = 2000;
const SOURCE_TIMEOUT_MS = 8000;
// Minimum text length for a level estimate. Below ~50 code points (a couple
// of sentences) the sentence-length and grammar adjustments are single-sample
// noise — e.g. one N3 word in an 18-character paste reporting N3 — so short
// texts carry level null instead of a misleading badge. Annotations are still
// computed in full; only the level + confidence are withheld.
const MIN_LEVEL_CHARACTERS = 50;
// Aozora's old works index (sakuhin_top.html) was retired; the per-kana work
// indexes (e.g. sakuhin_a1.html) carry the same /cards/N/cardN.html links the
// listing parser accepts. One fixed index per request keeps the import
// bounded; the picker cycles kana groups for variety.
const AOZORA_KANA_INDEXES = Object.freeze(['a', 'ka', 'sa', 'ta', 'na', 'ha', 'ma', 'ya', 'ra', 'wa']);
function aozoraListingUrl(index = 'a') {
  const group = AOZORA_KANA_INDEXES.includes(index) ? index : 'a';
  return `https://www.aozora.gr.jp/index_pages/sakuhin_${group}1.html`;
}
const AOZORA_LISTING_URL = aozoraListingUrl('a');
// Hukumusume fairy tales (きょうの日本昔話): monthly indexes listing story
// pages. One fixed month per request keeps the import bounded; the picker
// cycles months for variety, exactly like the Aozora kana groups.
const HUKU_MONTHS = Object.freeze(['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']);
function hukuListingUrl(month = '01') {
  const group = HUKU_MONTHS.includes(month) ? month : '01';
  return `https://hukumusume.com/douwa/pc/jap/itiran/${group}gatu.htm`;
}
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

// Token-layer sentences carry stable numeric ids plus code-point bounds so the
// reader can slice with Array.from(text).slice(start, end) (astral-plane
// safe). `start`/`text` keep their legacy meaning; `id`/`end` are additive.
function splitSentences(text) {
  const points = Array.from(text);
  if (!points.length) return [];
  const sentences = [];
  let start = 0;
  let id = 0;
  const pushSentence = (sentenceText, sentenceStart) => {
    sentences.push({ id: id++, text: sentenceText, start: sentenceStart, end: sentenceStart + Array.from(sentenceText).length });
  };
  for (let index = 0; index < points.length; index += 1) {
    if (!/[。！？!?\n\r]/u.test(points[index])) continue;
    const end = index + 1;
    const sentencePoints = points.slice(start, end);
    let leading = 0;
    while (leading < sentencePoints.length && /\s/u.test(sentencePoints[leading])) leading += 1;
    let trailing = sentencePoints.length;
    while (trailing > leading && /\s/u.test(sentencePoints[trailing - 1])) trailing -= 1;
    const sentence = sentencePoints.slice(leading, trailing).join('');
    if (sentence) pushSentence(sentence, start + leading);
    start = end;
  }
  if (start < points.length) {
    const tailPoints = points.slice(start);
    let leading = 0;
    while (leading < tailPoints.length && /\s/u.test(tailPoints[leading])) leading += 1;
    let trailing = tailPoints.length;
    while (trailing > leading && /\s/u.test(tailPoints[trailing - 1])) trailing -= 1;
    const tail = tailPoints.slice(leading, trailing).join('');
    if (tail) pushSentence(tail, start + leading);
  }
  return sentences;
}

// Keep sentence boundaries where possible; very long sentences are split by
// code point without ever crossing MAX_LEXICAL_TEXT_LENGTH UTF-16 code units.
// Segments carry their parent sentenceId so per-occurrence tokens can be
// attributed without re-scanning sentence bounds.
function parserSegments(sentences) {
  const segments = [];
  for (const sentence of sentences) {
    let content = '';
    let segmentStart = sentence.start;
    let offset = sentence.start;
    for (const character of Array.from(sentence.text)) {
      if (content && content.length + character.length > MAX_LEXICAL_TEXT_LENGTH) {
        segments.push({ text: content, start: segmentStart, sentenceId: sentence.id });
        segmentStart = offset;
        content = '';
      }
      content += character;
      offset += 1;
    }
    if (content) segments.push({ text: content, start: segmentStart, sentenceId: sentence.id });
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
  const lexicalTokens = [];
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
    for (const token of tokens) {
      if (!token || typeof token.surface !== 'string') continue;
      lexicalTokens.push({
        ...token,
        start: (Number.isInteger(token.start) ? token.start : 0) + segment.start,
        end: (Number.isInteger(token.end) ? token.end : (Number.isInteger(token.start) ? token.start : 0) + Array.from(token.surface || '').length) + segment.start,
        sentenceId: segment.sentenceId
      });
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
  lexicalTokens.sort((a, b) => (a.start ?? 0) - (b.start ?? 0) || (a.end ?? 0) - (b.end ?? 0));
  const vocabulary = [...vocabularyByKey.values()].sort((a, b) => a.firstStart - b.firstStart);
  await attachVocabularyGlosses(executor, vocabulary);
  const grammarMatches = [...grammarByKey.values()];
  const grammar = await hydrateGrammarMatches(userId, grammarMatches, executor);
  return { vocabulary, grammar, lexicalTokens };
}

// Deterministic candidate id shapes shared by tokens[] and enroll. Vocabulary
// mirrors immersionPipeline (`vocabulary::<canonical>::<reading>`); kanji and
// grammar mirror the immersion/story enroll keys.
function vocabularyCandidateId(canonical, reading) {
  return `vocabulary::${canonical}::${reading || ''}`;
}

function kanjiCandidateId(character) {
  return `kanji::${character}`;
}

function grammarCandidateId(slug) {
  return `grammar::${slug}`;
}

function vocabularyReadingFor(candidateOrToken) {
  if (!candidateOrToken || typeof candidateOrToken !== 'object') return null;
  return candidateOrToken.lemmaReading || candidateOrToken.surfaceReading || null;
}

function findSentenceId(sentences, offset) {
  if (!Array.isArray(sentences) || !sentences.length) return null;
  for (const sentence of sentences) {
    if (Number.isInteger(sentence.start) && Number.isInteger(sentence.end) && offset >= sentence.start && offset < sentence.end) {
      return sentence.id;
    }
  }
  return null;
}

// Per-occurrence vocabulary tokens (1 logical entry per content head, with
// aux/copula continuations folded into the head via the shared
// reconstructObservedSurface — never reinvented here). Continuation tokens
// are skipped so offsets never overlap and Array.from slicing stays exact.
// Non-content tokens (particles/aux/copula/symbols/numerals/proper-nouns/
// suffixes) pass through 1:1 with tappable false.
function buildVocabularyTokens(lexicalTokens, vocabulary) {
  const list = Array.isArray(lexicalTokens) ? lexicalTokens : [];
  const aggregates = Array.isArray(vocabulary) ? vocabulary : [];
  const byKey = new Map();
  const idByKey = new Map();
  for (const candidate of aggregates) {
    const key = candidate.key || `${candidate.pos}::${candidate.canonical}`;
    byKey.set(key, candidate);
    idByKey.set(key, vocabularyCandidateId(candidate.canonical, vocabularyReadingFor(candidate)));
  }
  const tokens = [];
  const skipped = new Set();
  for (let index = 0; index < list.length; index += 1) {
    if (skipped.has(index)) continue;
    const token = list[index];
    if (!token || typeof token.surface !== 'string') continue;
    const verdict = classifyCandidate(token);
    const tappable = verdict.candidate === true;
    if (!token.isContentWord) {
      const canonical = token.lemma || token.surface;
      tokens.push({
        surface: token.surface,
        lemma: token.lemma || null,
        surfaceReading: token.surfaceReading || null,
        lemmaReading: token.lemmaReading || null,
        gloss: null,
        entityKind: 'vocabulary',
        candidateId: vocabularyCandidateId(canonical, vocabularyReadingFor(token)),
        start: token.start,
        end: token.end,
        sentenceId: token.sentenceId,
        tappable: false,
        known: false,
        level: null
      });
      continue;
    }
    const expanded = reconstructObservedSurface(list, index);
    const consumed = Number.isInteger(expanded.consumed) && expanded.consumed > 0 ? expanded.consumed : 1;
    for (let skip = index + 1; skip < index + consumed && skip < list.length; skip += 1) skipped.add(skip);
    const last = list[index + consumed - 1] || token;
    const surface = expanded.surface;
    const surfaceReading = expanded.surfaceReading || null;
    const key = candidateIdentity(token);
    const aggregate = byKey.get(key) || null;
    const hasAggregate = Boolean(aggregate) && tappable;
    const candidateId = hasAggregate
      ? idByKey.get(key)
      : vocabularyCandidateId(token.lemma || token.surface, vocabularyReadingFor(token));
    tokens.push({
      surface,
      lemma: token.lemma || null,
      surfaceReading,
      lemmaReading: token.lemmaReading || null,
      gloss: hasAggregate ? (aggregate.gloss || null) : null,
      entityKind: 'vocabulary',
      candidateId,
      start: token.start,
      end: last && Number.isInteger(last.end) ? last.end : token.start + Array.from(surface).length,
      sentenceId: token.sentenceId,
      tappable,
      known: hasAggregate ? aggregate.match?.state === 'existing' : false,
      level: null
    });
  }
  return tokens;
}

function buildKanjiTokens(text, sentences, kanjiData) {
  const points = Array.from(text || '');
  const tokens = [];
  const referenceByCharacter = kanjiData?.referenceByCharacter || new Map();
  const ownedCharacters = kanjiData?.ownedCharacters || new Set();
  for (let offset = 0; offset < points.length; offset += 1) {
    const character = points[offset];
    if (!/\p{Script=Han}/u.test(character)) continue;
    const reference = referenceByCharacter.get(character) || null;
    const meanings = Array.isArray(reference?.meanings) ? reference.meanings : [];
    tokens.push({
      surface: character,
      lemma: null,
      surfaceReading: null,
      lemmaReading: null,
      gloss: meanings[0] || null,
      entityKind: 'kanji',
      candidateId: kanjiCandidateId(character),
      start: offset,
      end: offset + 1,
      sentenceId: findSentenceId(sentences, offset),
      tappable: true,
      known: ownedCharacters.has(character),
      level: normalizeJlpt(reference?.jlpt_level)
    });
  }
  return tokens;
}

function buildGrammarTokens(text, sentences, grammar) {
  const points = Array.from(text || '');
  const tokens = [];
  for (const match of Array.isArray(grammar) ? grammar : []) {
    if (!match || match.status !== 'DETERMINATE' || !match.reference) continue;
    const start = match.detected?.start;
    const end = match.detected?.end;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > points.length) continue;
    const reference = match.reference;
    const surface = points.slice(start, end).join('');
    if (!surface) continue;
    tokens.push({
      surface,
      lemma: null,
      surfaceReading: null,
      lemmaReading: null,
      gloss: reference.meaning || reference.summary || null,
      entityKind: 'grammar',
      candidateId: grammarCandidateId(reference.sourceSlug),
      start,
      end,
      sentenceId: findSentenceId(sentences, start),
      tappable: true,
      known: match.collection?.inGrammar === true,
      level: normalizeJlpt(reference.jlptLevel)
    });
  }
  return tokens;
}

function buildTokenLayer(text, sentences, lexicalTokens, vocabulary, grammar, kanjiData) {
  const vocabularyTokens = buildVocabularyTokens(lexicalTokens, vocabulary);
  const kanjiTokens = buildKanjiTokens(text, sentences, kanjiData);
  const grammarTokens = buildGrammarTokens(text, sentences, grammar);
  // Spans stay unique per occurrence: a single-char Han already covered by a
  // vocabulary token with the identical span/surface keeps the vocabulary
  // entry (tappable state + JMdict gloss live there); the duplicate kanji
  // entry is dropped so Array.from slicing keys stay 1:1. Multi-char
  // vocabulary (学校 7-9) never collides with its single-char kanji parts
  // (学 7-8, 校 8-9), so those kanji fallbacks are preserved.
  const vocabSpans = new Set(vocabularyTokens.map((entry) => `${entry.start}-${entry.end}-${entry.surface}`));
  const dedupedKanji = kanjiTokens.filter((entry) => !vocabSpans.has(`${entry.start}-${entry.end}-${entry.surface}`));
  const priority = { vocabulary: 0, kanji: 1, grammar: 2 };
  return [...vocabularyTokens, ...dedupedKanji, ...grammarTokens].sort(
    (a, b) => (a.start ?? 0) - (b.start ?? 0) || (b.end ?? 0) - (a.end ?? 0) || (priority[a.entityKind] ?? 9) - (priority[b.entityKind] ?? 9)
  );
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
      // Stable reference identity so the ownership overlay can refresh known
      // without re-running detection+hydration on cache hits.
      referenceSlug: reference.sourceSlug || null,
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
  const leveled = stats.characters >= MIN_LEVEL_CHARACTERS ? blended : { level: null, confidence: 0 };
  const fullTokens = buildTokenLayer(text, sentences, lexical.lexicalTokens || [], lexical.vocabulary, lexical.grammar, kanjiData);
  const truncated = fullTokens.length > MAX_TOKENS;
  return {
    level: leveled.level,
    confidence: leveled.confidence,
    stats,
    annotations: makeAnnotations(positions, kanjiData, lexical.vocabulary, lexical.grammar),
    sentences,
    tokens: truncated ? fullTokens.slice(0, MAX_TOKENS) : fullTokens,
    truncated
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
  if (source !== undefined && source !== '' && !['aozora', 'hukumusume', 'user'].includes(source)) {
    throw new ValidationError('source must be one of: aozora, hukumusume, user.');
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
    `SELECT rt.id_reading_text AS id, rt.title, rt.level, COALESCE(rs.type, 'user') AS "sourceType", rt.text, rt.created_at AS "createdAt",
       (rt.user_id = ?) AS mine
      FROM reading_texts rt LEFT JOIN reading_sources rs ON rs.id_reading_source = rt.source_id
      WHERE ${whereSql} ORDER BY rt.created_at DESC, rt.id_reading_text DESC LIMIT ? OFFSET ?`,
    [...params, userId, limit, offset]
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
      mine: row.mine === true || row.mine === 1,
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

// Editorial sentence translations keyed by sentence id. Stored as a plain
// map ({sentenceId: translation}); only non-empty strings survive, in read
// and in write, so the reader/js can treat "present" as "revealed".
function parseTranslations(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!source) return {};
  const translations = {};
  for (const [key, text] of Object.entries(source)) {
    const sentenceId = Number(key);
    if (!Number.isSafeInteger(sentenceId) || sentenceId < 0) continue;
    if (typeof text !== 'string') continue;
    const translation = text.trim();
    if (!translation) continue;
    translations[sentenceId] = translation.slice(0, MAX_TRANSLATION_LENGTH);
  }
  return translations;
}

async function saveSentenceTranslations(executor, userId, textId, translations) {
  const [rows] = await executor.execute(
    'SELECT id_reading_text, text FROM reading_texts WHERE id_reading_text = ? AND (user_id IS NULL OR user_id = ?)',
    [textId, userId]
  );
  const row = rows?.[0];
  if (!row) return null;
  if (!Array.isArray(translations)) throw new ValidationError('translations must be an array of {sentenceId, translation}.');
  const sentences = splitSentences(row.text || '');
  const validIds = new Set(sentences.map((sentence) => sentence.id));
  const merged = {};
  for (const entry of translations) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ValidationError('each translation must be a {sentenceId, translation} object.');
    }
    if (!Number.isSafeInteger(entry.sentenceId) || entry.sentenceId < 0 || !validIds.has(entry.sentenceId)) {
      throw new ValidationError(`sentenceId ${entry?.sentenceId} does not exist in this text.`);
    }
    if (typeof entry.translation !== 'string') {
      throw new ValidationError('translation must be a string.');
    }
    const text = entry.translation.trim();
    if (!text) continue;
    if (Array.from(text).length > MAX_TRANSLATION_LENGTH) {
      throw new ValidationError(`translation must not exceed ${MAX_TRANSLATION_LENGTH} characters.`);
    }
    merged[entry.sentenceId] = text;
  }
  await executor.execute(
    'UPDATE reading_texts SET sentence_translations_json = ?::jsonb WHERE id_reading_text = ? AND (user_id IS NULL OR user_id = ?)',
    [JSON.stringify(merged), textId, userId]
  );
  return merged;
}

// Token-layer cache: sentences/tokens/annotations are user-independent except
// for the known flags, so GET serves the stored artifact and refreshes ONLY
// known via cheap batched ownership lookups (≤5 queries) instead of
// recomputing kuromoji + gloss + per-segment ownership (~100 queries).
// Baked known flags are never trusted (reset both ways by the overlay).
function parseTokenCache(row) {
  try {
    const annotations = row?.annotations_json;
    const sentences = row?.sentences_json;
    const layer = row?.tokens_json;
    if (!Array.isArray(annotations) || !Array.isArray(sentences)) return null;
    if (!layer || typeof layer !== 'object' || Array.isArray(layer) || !Array.isArray(layer.tokens)) return null;
    return {
      annotations,
      sentences,
      tokens: layer.tokens,
      truncated: layer.truncated === true
    };
  } catch (_) {
    return null;
  }
}

function canonicalFromVocabularyId(candidateId) {
  const prefix = 'vocabulary::';
  const rest = String(candidateId || '');
  if (!rest.startsWith(prefix)) return null;
  const body = rest.slice(prefix.length);
  const separator = body.lastIndexOf('::');
  const canonical = (separator < 0 ? body : body.slice(0, separator)).trim();
  return canonical || null;
}

function slugFromGrammarId(candidateId) {
  const prefix = 'grammar::';
  const rest = String(candidateId || '');
  if (!rest.startsWith(prefix)) return null;
  const slug = rest.slice(prefix.length).trim();
  return slug || null;
}

async function applyOwnershipOverlay(executor, userId, analysis) {
  const annotations = Array.isArray(analysis?.annotations) ? analysis.annotations : [];
  const tokens = Array.isArray(analysis?.tokens) ? analysis.tokens : [];
  // Vocabulary: group cached entries by canonical and reuse the tested
  // matcher once (max 2 bounded queries). Only content-word entries went
  // through candidates in the analyze path (tappable), so only those flip.
  const byCanonical = new Map();
  const trackVocab = (canonical, lemma, surface) => {
    if (!canonical) return null;
    let entry = byCanonical.get(canonical);
    if (!entry) {
      entry = { lemma: lemma || null, canonical, surfaces: new Set(), tokens: [], annotations: [] };
      byCanonical.set(canonical, entry);
    }
    if (lemma && !entry.lemma) entry.lemma = lemma;
    if (surface) entry.surfaces.add(surface);
    return entry;
  };
  for (const token of tokens) {
    if (token?.entityKind !== 'vocabulary' || token.tappable !== true) continue;
    const canonical = canonicalFromVocabularyId(token.candidateId) || token.lemma || token.surface;
    const entry = trackVocab(canonical, token.lemma, token.surface);
    if (entry) entry.tokens.push(token);
  }
  for (const annotation of annotations) {
    if (annotation?.type !== 'vocabulary' || typeof annotation.word !== 'string' || !annotation.word) continue;
    const entry = trackVocab(annotation.word, annotation.word, null);
    if (entry) entry.annotations.push(annotation);
  }
  const pseudos = [...byCanonical.values()].map((entry) => ({
    lemma: entry.lemma,
    canonical: entry.canonical,
    observed: [...entry.surfaces].map((surface) => ({ surface })),
    match: { state: 'new', possibleMatches: [] }
  }));
  for (const group of batches(pseudos, MAX_DATABASE_IN_VALUES)) {
    if (group.length) await matchOwnedVocabulary(executor, userId, group);
  }
  for (const pseudo of pseudos) {
    const known = pseudo.match?.state === 'existing';
    const entry = byCanonical.get(pseudo.canonical);
    if (!entry) continue;
    for (const token of entry.tokens) token.known = known;
    for (const annotation of entry.annotations) annotation.known = known;
  }
  // Kanji: single batched owned-characters lookup.
  const characters = new Set();
  for (const token of tokens) {
    if (token?.entityKind === 'kanji' && typeof token.surface === 'string' && Array.from(token.surface).length === 1) {
      characters.add(token.surface);
    }
  }
  for (const annotation of annotations) {
    if (annotation?.type === 'kanji' && typeof annotation.char === 'string' && annotation.char) characters.add(annotation.char);
  }
  const ownedCharacters = new Set();
  for (const group of batches([...characters])) {
    if (!group.length) break;
    const placeholders = group.map(() => '?').join(', ');
    const [rows] = await executor.execute(
      `SELECT character_kanji FROM kanji WHERE user_id = ? AND character_kanji IN (${placeholders})`,
      [userId, ...group]
    );
    for (const row of rows || []) {
      if (row && typeof row.character_kanji === 'string') ownedCharacters.add(row.character_kanji);
    }
  }
  for (const token of tokens) {
    if (token?.entityKind === 'kanji') token.known = ownedCharacters.has(token.surface);
  }
  for (const annotation of annotations) {
    if (annotation?.type === 'kanji') annotation.known = ownedCharacters.has(annotation.char);
  }
  // Grammar: slug → reference → user ownership (mirrors hydrateGrammarMatches).
  const slugs = new Set();
  for (const token of tokens) {
    if (token?.entityKind !== 'grammar') continue;
    const slug = slugFromGrammarId(token.candidateId);
    if (slug) slugs.add(slug);
  }
  for (const annotation of annotations) {
    if (annotation?.type !== 'grammar') continue;
    if (typeof annotation.referenceSlug === 'string' && annotation.referenceSlug) slugs.add(annotation.referenceSlug);
  }
  const ownedSlugs = new Set();
  for (const group of batches([...slugs])) {
    if (!group.length) break;
    const placeholders = group.map(() => '?').join(', ');
    const [references] = await executor.execute(
      `SELECT id_grammar_reference, source_slug FROM grammar_reference WHERE source = 'nihongo-mono' AND source_slug IN (${placeholders})`,
      group
    );
    const ids = [];
    const idBySlug = new Map();
    for (const row of references || []) {
      if (!row || typeof row.source_slug !== 'string') continue;
      idBySlug.set(row.source_slug, Number(row.id_grammar_reference));
      ids.push(Number(row.id_grammar_reference));
    }
    if (!ids.length) continue;
    const [owned] = await executor.execute(
      `SELECT reference_id FROM grammar_points WHERE user_id = ? AND reference_id IN (${ids.map(() => '?').join(', ')})`,
      [userId, ...ids]
    );
    const ownedIds = new Set((owned || []).map((row) => Number(row?.reference_id)));
    for (const [slug, id] of idBySlug) {
      if (ownedIds.has(id)) ownedSlugs.add(slug);
    }
  }
  for (const token of tokens) {
    if (token?.entityKind !== 'grammar') continue;
    token.known = ownedSlugs.has(slugFromGrammarId(token.candidateId));
  }
  for (const annotation of annotations) {
    if (annotation?.type !== 'grammar') continue;
    annotation.known = typeof annotation.referenceSlug === 'string' && ownedSlugs.has(annotation.referenceSlug);
  }
}

async function persistTokenCache(executor, userId, textId, analysis) {
  await executor.execute(
    'UPDATE reading_texts SET sentences_json = ?::jsonb, tokens_json = ?::jsonb WHERE id_reading_text = ? AND (user_id IS NULL OR user_id = ?)',
    [
      JSON.stringify(Array.isArray(analysis?.sentences) ? analysis.sentences : []),
      JSON.stringify({ tokens: Array.isArray(analysis?.tokens) ? analysis.tokens : [], truncated: analysis?.truncated === true }),
      textId,
      userId
    ]
  );
}

async function getReadingText(executor, userId, id) {
  const [rows] = await executor.execute(
    `SELECT rt.id_reading_text AS id, rt.user_id AS "ownerId", rt.title, rt.level, COALESCE(rs.type, 'user') AS "sourceType", rs.metadata,
       rt.text, rt.annotations_json, rt.sentences_json, rt.tokens_json, rt.sentence_translations_json, p.position, p.completed_at AS "completedAt", p.time_spent_seconds AS "timeSpentSeconds"
      FROM reading_texts rt LEFT JOIN reading_sources rs ON rs.id_reading_source = rt.source_id
     LEFT JOIN user_reading_progress p ON p.text_id = rt.id_reading_text AND p.user_id = ?
     WHERE rt.id_reading_text = ? AND (rt.user_id IS NULL OR rt.user_id = ?)`,
    [userId, id, userId]
  );
  const row = rows?.[0];
  if (!row) return null;
  // Cached artifact when present: sentences/tokens/annotations are
  // user-independent except for known flags, so only the cheap ownership
  // overlay runs per GET. On a miss the full analysis runs once and fills
  // the cache for every later reader (shared rows included).
  let analysis = parseTokenCache(row);
  if (analysis) {
    await applyOwnershipOverlay(executor, userId, analysis);
  } else {
    const fresh = await analyzeReading(executor, userId, row.text);
    analysis = { annotations: fresh.annotations, sentences: fresh.sentences, tokens: fresh.tokens, truncated: fresh.truncated };
    await persistTokenCache(executor, userId, row.id, analysis).catch(() => {
      // Best-effort: a failed cache write only costs a recompute next GET.
    });
  }
  const progress = row.position === null || row.position === undefined ? null : {
    position: Number(row.position),
    timeSpentSeconds: Number(row.timeSpentSeconds) || 0,
    completed: Boolean(row.completedAt),
    completedAt: row.completedAt || null
  };
  return {
    id: Number(row.id),
    title: row.title,
    mine: row.ownerId ? String(row.ownerId) === String(userId) : false,
    level: normalizeJlpt(row.level),
    sourceType: row.sourceType || 'user',
    metadata: parseMetadata(row.metadata),
    text: row.text,
    annotations: analysis.annotations,
    sentences: analysis.sentences,
    tokens: analysis.tokens,
    truncated: analysis.truncated === true,
    translations: parseTranslations(row.sentence_translations_json),
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
      'INSERT INTO reading_texts (source_id, user_id, text, title, level, annotations_json, sentences_json, tokens_json) VALUES (?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb) RETURNING id_reading_text AS insertId',
      [sourceId, userId, text, title, analysis.level, JSON.stringify(analysis.annotations), JSON.stringify(analysis.sentences), JSON.stringify({ tokens: analysis.tokens, truncated: analysis.truncated === true })]
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

async function deleteUserReadingText(executor, userId, textId) {
  const connection = await executor.getConnection();
  try {
    await connection.beginTransaction();
    // Only the owner's own texts are deletable: shared (imported) library
    // rows carry user_id NULL and never match, so they 404 here.
    const [rows] = await connection.execute(
      'SELECT id_reading_text, source_id FROM reading_texts WHERE id_reading_text = ? AND user_id = ?',
      [textId, userId]
    );
    const row = rows?.[0];
    if (!row) {
      await connection.rollback();
      return null;
    }
    // Progress rows follow via ON DELETE CASCADE.
    await connection.execute(
      'DELETE FROM reading_texts WHERE id_reading_text = ? AND user_id = ?',
      [textId, userId]
    );
    // Drop the private per-text user source when orphaned; shared import
    // sources are never user-owned so this cannot remove library data.
    if (row.source_id) {
      await connection.execute(
        `DELETE FROM reading_sources WHERE id_reading_source = ? AND type = 'user'
         AND NOT EXISTS (SELECT 1 FROM reading_texts WHERE source_id = ?)`,
        [row.source_id, row.source_id]
      );
    }
    await connection.commit();
    return { id: textId, deleted: true };
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
  // Position is the one exception: it only ever advances (GREATEST), so a
  // stale or out-of-order save — second tab, re-render before first autosave,
  // retried request — can never move the reader backwards.
  const [result] = await executor.execute(
    `INSERT INTO user_reading_progress (user_id, text_id, position, time_spent_seconds, completed_at)
     SELECT ?, rt.id_reading_text, ?, ?, CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END
     FROM reading_texts rt
     WHERE rt.id_reading_text = ? AND (rt.user_id IS NULL OR rt.user_id = ?)
     ON CONFLICT (user_id, text_id) DO UPDATE SET
       position = GREATEST(user_reading_progress.position, EXCLUDED.position),
       time_spent_seconds = EXCLUDED.time_spent_seconds,
       completed_at = EXCLUDED.completed_at
     RETURNING id AS insertId`,
    [userId, position, timeSpentSeconds ?? 0, completed ?? false, textId, userId]
  );
  if (!extractInsertId(result)) return null;
  // Echo the stored position (post-GREATEST), never the submitted one: the
  // request adapter only surfaces the insert id from RETURNING rows, so read
  // the authoritative value back with one indexed lookup.
  const [storedRows] = await executor.execute(
    'SELECT position FROM user_reading_progress WHERE user_id = ? AND text_id = ?',
    [userId, textId]
  );
  const storedPosition = Number(storedRows?.[0]?.position);
  return {
    position: Number.isSafeInteger(storedPosition) ? storedPosition : position,
    timeSpentSeconds: timeSpentSeconds ?? 0,
    completed: completed ?? false
  };
}

// Reading enroll (mirrors POST /api/stories/:id/enroll-srs): the client only
// supplies stable candidate id keys; the server re-runs the deterministic
// graded-reader analysis on the stored text and intersects by id. Unknown or
// forged ids intersect to nothing and are never written. Vocabulary ids use
// the immersion shape (vocabulary::<canonical>::<reading>), kanji
// (kanji::<char>), grammar (grammar::<slug>).
const REVIEW_TARGET_COLUMN = Object.freeze({ vocabulary: 'id_vocabulary', kanji: 'id_kanji', grammar: 'id_grammar' });

function buildEnrollableReadingCandidates(vocabulary, grammar, kanjiData) {
  const enrollableVocabulary = [];
  const seenVocabularyIds = new Set();
  for (const candidate of Array.isArray(vocabulary) ? vocabulary : []) {
    const reading = vocabularyReadingFor(candidate);
    const id = vocabularyCandidateId(candidate.canonical, reading);
    if (seenVocabularyIds.has(id)) continue;
    seenVocabularyIds.add(id);
    enrollableVocabulary.push({
      id,
      display: candidate.canonical,
      reading: reading || null,
      meaning: candidate.gloss || null,
      jlpt: null,
      known: candidate.match?.state === 'existing'
    });
  }
  const referenceByCharacter = kanjiData?.referenceByCharacter || new Map();
  const ownedCharacters = kanjiData?.ownedCharacters || new Set();
  const enrollableKanji = [];
  const seenKanjiIds = new Set();
  for (const [character] of referenceByCharacter) {
    const id = kanjiCandidateId(character);
    if (seenKanjiIds.has(id)) continue;
    seenKanjiIds.add(id);
    const reference = referenceByCharacter.get(character) || null;
    const onyomi = Array.isArray(reference?.onyomi) ? reference.onyomi : [];
    const meanings = Array.isArray(reference?.meanings) ? reference.meanings : [];
    enrollableKanji.push({
      id,
      display: character,
      reading: onyomi[0] || null,
      meaning: meanings[0] || null,
      jlpt: normalizeJlpt(reference?.jlpt_level),
      known: ownedCharacters.has(character)
    });
  }
  // Characters with no reference row are still enrollable as kanji::char so
  // the reader's kanji tokens stay selectable; reference lookups stay null.
  if (kanjiData && Array.isArray(kanjiData.allCharacters)) {
    for (const character of kanjiData.allCharacters) {
      const id = kanjiCandidateId(character);
      if (seenKanjiIds.has(id)) continue;
      seenKanjiIds.add(id);
      enrollableKanji.push({ id, display: character, reading: null, meaning: null, jlpt: null, known: false });
    }
  }
  const enrollableGrammar = [];
  const grammarInternals = new Map();
  const seenGrammarIds = new Set();
  for (const match of Array.isArray(grammar) ? grammar : []) {
    if (!match || match.status !== 'DETERMINATE' || !match.reference) continue;
    const reference = match.reference;
    const id = grammarCandidateId(reference.sourceSlug);
    if (seenGrammarIds.has(id)) continue;
    seenGrammarIds.add(id);
    grammarInternals.set(id, {
      referenceId: reference.referenceId,
      grammarPoint: reference.grammarPoint,
      meaning: reference.meaning || reference.summary || null,
      jlpt: normalizeJlpt(reference.jlptLevel)
    });
    enrollableGrammar.push({
      id,
      display: reference.grammarPoint,
      reading: reference.kana || null,
      meaning: reference.meaning || null,
      jlpt: normalizeJlpt(reference.jlptLevel),
      known: match.collection?.inGrammar === true
    });
  }
  return { vocabulary: enrollableVocabulary, kanji: enrollableKanji, grammar: enrollableGrammar, grammarInternals, referenceByCharacter };
}

async function enrollReadingItems(executor, userId, textId, selectedIds) {
  if (!Array.isArray(selectedIds) || selectedIds.length < 1 || selectedIds.length > MAX_READING_ENROLL_ITEMS) {
    throw new ValidationError(`selected must be an array of 1 to ${MAX_READING_ENROLL_ITEMS} candidate id strings.`);
  }
  const selectedKeys = new Set();
  for (const key of selectedIds) {
    if (typeof key !== 'string' || !key) {
      throw new ValidationError('selected must contain only non-empty candidate id strings.');
    }
    selectedKeys.add(key);
  }
  const [textRows] = await executor.execute(
    'SELECT id_reading_text, text FROM reading_texts WHERE id_reading_text = ? AND (user_id IS NULL OR user_id = ?)',
    [textId, userId]
  );
  const textRow = textRows?.[0];
  if (!textRow) return null;
  if (typeof textRow.text !== 'string' || !textRow.text.trim()) {
    throw new ValidationError('reading text has no text to enroll from.');
  }
  const text = textRow.text;
  const sentences = splitSentences(text);
  const positions = firstKanjiPositions(text);
  const kanjiCharacters = [...positions.keys()];
  const kanjiData = await loadKanjiData(executor, userId, kanjiCharacters);
  kanjiData.allCharacters = kanjiCharacters;
  const lexical = await collectLexicalAnalysis(executor, userId, sentences);
  const enrollable = buildEnrollableReadingCandidates(lexical.vocabulary, lexical.grammar, kanjiData);
  const chosen = {
    vocabulary: intersectSelected(enrollable.vocabulary, selectedKeys),
    kanji: intersectSelected(enrollable.kanji, selectedKeys),
    grammar: intersectSelected(enrollable.grammar, selectedKeys)
  };
  const connection = typeof executor.getConnection === 'function' ? await executor.getConnection() : executor;
  const db = connection;
  const ownsConnection = connection && connection !== executor && typeof connection.beginTransaction === 'function';
  try {
    if (ownsConnection) await connection.beginTransaction();
    const vocabularyResult = await ensureVocabularyEntities(db, userId, chosen.vocabulary);
    const kanjiResult = await ensureKanjiEntities(db, userId, chosen.kanji, enrollable.referenceByCharacter);
    const grammarResult = await ensureGrammarEntities(db, userId, chosen.grammar, enrollable.grammarInternals);
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
      const [rows] = await db.execute(`SELECT id_review_item FROM review_items WHERE ${targetColumn} = ?`, [targetId]);
      const row = Array.isArray(rows) ? rows[0] : null;
      if (row && Number.isInteger(Number(row.id_review_item))) {
        createdIds.push({ entityType, reviewItemId: Number(row.id_review_item) });
      }
    }
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
      const rawId = sessionResult?.insertId ?? (Array.isArray(sessionResult) ? sessionResult[0]?.insertId : null);
      reviewSessionId = Number(rawId);
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
    if (ownsConnection && typeof connection.commit === 'function') await connection.commit();
    if (ownsConnection && typeof connection.release === 'function') {
      try { await connection.release(); } catch (_) { /* release is best-effort */ }
    }
    return {
      created: createdIds.length,
      reviewItems: createdIds,
      reviewSessionId,
      queueItems,
      items: queueItems.map(({ entityType, entityId, display }) => ({ entityType, entityId, display })),
      entities: { vocabulary: vocabularyResult.created, kanji: kanjiResult.created, grammar: grammarResult.created }
    };
  } catch (error) {
    if (ownsConnection) {
      if (typeof connection.rollback === 'function') {
        try { await connection.rollback(); } catch (_) { /* rollback is best-effort */ }
      }
      if (typeof connection.release === 'function') {
        try { await connection.release(); } catch (_) { /* release is best-effort */ }
      }
    }
    throw error;
  }
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

function safeExternalUrl(value, allowedHost) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.hostname !== allowedHost || url.port || url.username || url.password) return null;
    return url;
  } catch (_) {
    return null;
  }
}

// Aozora serves legacy pages as EUC-JP or Shift_JIS. Sniff the charset from
// the content-type header, else from a meta tag in the first 2KB, and
// transcode; UTF-8 (and pure-ASCII payloads, which decode identically
// everywhere) pass through untouched. Unknown labels fall back to UTF-8.
function decodeSourceBytes(buffer, contentType) {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(String(contentType || ''))?.[1]?.toLowerCase();
  let charset = fromHeader;
  if (!charset) {
    const head = buffer.subarray(0, 2048).toString('latin1');
    charset = (/content\s*=\s*["'][^"']*charset=([\w-]+)/i.exec(head)?.[1]
      || /<meta\b[^>]*charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] || '').toLowerCase() || null;
  }
  if (charset && !['utf-8', 'utf8', 'ascii', 'us-ascii'].includes(charset)) {
    try {
      return new TextDecoder(charset).decode(buffer);
    } catch (_) { /* unknown/unsupported label: fall through to UTF-8 */ }
  }
  return buffer.toString('utf8');
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
    return decodeSourceBytes(Buffer.concat(chunks), response.headers?.get?.('content-type'));
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

// NHK Easy import was retired: NHK migrated the site and discontinued the
// public feed (the pinned RSS returns 404, the replacement page is a
// client-rendered shell with no machine-readable article source), so there is
// no fixed, allowlisted NHK endpoint left to fetch. Aozora remains.

function aozoraListingItems(html, maxItems = 10) {
  const items = [];
  const anchors = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi;
  let match;
  while ((match = anchors.exec(html)) && items.length < maxItems) {
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
    // File links are relative (./files/<name>.html under /cards/<n>/) on real
    // card pages; the absolute /files/ form is kept for older markup.
    if (!/^\/(?:files\/[\w./%-]+\.(?:html?|txt)|cards\/\d+\/files\/[\w.%-]+\.html?)$/i.test(resolved.pathname)) continue;
    return resolved.toString();
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
async function loadAozoraSources(fetchImpl = globalThis.fetch, { index = 'a' } = {}) {
  try {
    const listingUrl = aozoraListingUrl(index);
    const html = await fetchFixedText(fetchImpl, listingUrl, 'www.aozora.gr.jp', 2 * 1024 * 1024);
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

// Preview-only listing: titles + card URLs from one fixed work index, no
// article fetching and no database writes. Powers the import picker so users
// choose WHAT to import instead of a blind bulk pull.
async function previewAozoraSources(fetchImpl = globalThis.fetch, { index = 'a' } = {}) {
  try {
    const listingUrl = aozoraListingUrl(index);
    const html = await fetchFixedText(fetchImpl, listingUrl, 'www.aozora.gr.jp', 2 * 1024 * 1024);
    return { status: 'ok', index: AOZORA_KANA_INDEXES.includes(index) ? index : 'a', items: aozoraListingItems(html, 20) };
  } catch (error) {
    return { status: 'unavailable', reason: error?.message === 'response_too_large' ? 'Source response exceeded the size limit.' : 'Source request failed.' };
  }
}

async function loadHukuArticle(fetchImpl, item) {
  try {
    const page = await fetchFixedText(fetchImpl, item.url, 'hukumusume.com', 2 * 1024 * 1024);
    const text = extractHukuStory(page, item.title);
    return { ...item, text: text || null };
  } catch (_) {
    return item;
  }
}

// Hukumusume has no API. This loader reads one fixed monthly story index,
// accepts only same-host story URLs, and enriches at most ten stories;
// pages with unexpected markup stay metadata-only instead of guessing.
async function loadHukuSources(fetchImpl = globalThis.fetch, { index = '01' } = {}) {
  try {
    const listingUrl = hukuListingUrl(index);
    const html = await fetchFixedText(fetchImpl, listingUrl, 'hukumusume.com', 2 * 1024 * 1024);
    const items = hukuListingItems(html, 10);
    const enriched = [];
    for (let position = 0; position < items.length; position += 3) {
      const group = await Promise.all(items.slice(position, position + 3).map((item) => loadHukuArticle(fetchImpl, item)));
      enriched.push(...group);
    }
    return { status: 'ok', index: HUKU_MONTHS.includes(index) ? index : '01', items: enriched };
  } catch (error) {
    return { status: 'unavailable', reason: error?.message === 'response_too_large' ? 'Source response exceeded the size limit.' : 'Source request failed.' };
  }
}

async function syncReadingSources(executor, userId, sourceType, { fetch: fetchImpl = globalThis.fetch, urls = null, index = null } = {}) {
  if (!['aozora', 'hukumusume'].includes(sourceType)) throw new ValidationError('sourceType must be aozora or hukumusume.');
  const sourceResult = sourceType === 'hukumusume'
    ? await loadHukuSources(fetchImpl, { index: index || '01' })
    : await loadAozoraSources(fetchImpl, { index: index || 'a' });
  if (sourceResult.status !== 'ok') return sourceResult;
  let items = sourceResult.items.slice(0, MAX_IMPORT_ITEMS);
  if (urls !== null && urls !== undefined) {
    // Selective import: keep only the requested entries, matched by
    // normalized URL. Anything not present in the live listing is ignored,
    // so forged or stale URLs can never inject arbitrary fetches — every
    // fetched URL still passes the fixed-host + card-path guards downstream.
    const wanted = new Set(
      urls.filter((entry) => typeof entry === 'string').map((entry) => {
        try { return new URL(entry).href; } catch (_) { return null; }
      }).filter(Boolean)
    );
    items = items.filter((item) => wanted.has(new URL(item.url).href));
    if (!items.length) return { status: 'ok', imported: 0, textsImported: 0 };
  }

  // Texts land one by one: analyze, then commit that item immediately, so a
  // minutes-long import is visible incrementally and a late failure (or a
  // restart) keeps everything saved so far. A failing item rolls back only
  // itself and the loop continues; re-running the import resumes safely
  // because the advisory lock + existing-row checks make items idempotent.
  let textsImported = 0;
  for (const item of items) {
    let text = null;
    let analysis = null;
    try {
      const raw = typeof item.text === 'string' && item.text.trim()
        ? truncateCodePoints(item.text.trim(), MAX_READING_TEXT_LENGTH)
        : null;
        text = raw;
        // Background job, no HTTP clock: afford up to three attempts so two
        // consecutive pooler blips still cannot sink a minutes-long import.
        analysis = text ? await analyzeImportText(executor, userId, text, 3) : null;
    } catch (_) {
      continue;
    }
    try {
      textsImported += await persistImportItemWithRetry(executor, sourceType, item, text, analysis);
    } catch (_) {
      // Per-item failure: the helper already rolled back; keep going.
    }
  }
  return { status: 'ok', imported: items.length, textsImported };
}

// Single-item persist shared by bulk sync and pasted-link import: source
// upsert always, text upsert only when readable text exists. Returns 1 when a
// text row was stored or refreshed, else 0.
function isTransientDbError(error) {
  if (!error || typeof error !== 'object') return false;
  // Parser engine failures are never retried here: a cold dictionary build
  // has its own 15s budget and retrying it just burns another 15s+.
  if (error.name === 'ParserError' || error.code === 'PARSER_INIT_FAILED') return false;
  if (/^(ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|EPIPE)$/i.test(String(error.code || ''))) return true;
  return /terminated|statement timeout|ECONNRESET|ETIMEDOUT|socket hang up|ENOTFOUND|EAI_AGAIN|EPIPE|connection reset/i.test(String(error.message || ''));
}

async function analyzeImportText(executor, userId, text, attempts = 2) {
  let lastError = null;
  const rounds = Math.max(1, attempts);
  for (let attempt = 1; attempt <= rounds; attempt += 1) {
    try {
      return await analyzeReading(executor, userId, text);
    } catch (error) {
      lastError = error;
      if (attempt < rounds && isTransientDbError(error)) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

// Persist with the same transient-only retry: a pooler blip during the few
// commit-phase queries must not discard a just-finished minute of analysis.
// Idempotent via advisory lock + existing-row checks, so a repeated commit is
// safe; non-transient errors throw immediately.
async function persistImportItemWithRetry(executor, sourceType, item, text, analysis, attempts = 2) {
  let lastError = null;
  const rounds = Math.max(1, attempts);
  for (let attempt = 1; attempt <= rounds; attempt += 1) {
    const connection = await executor.getConnection();
    try {
      await connection.beginTransaction();
      const stored = await persistImportItem(connection, sourceType, item, text, analysis);
      await connection.commit();
      return stored;
    } catch (error) {
      await connection.rollback().catch(() => {});
      lastError = error;
      if (attempt < rounds && isTransientDbError(error)) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }
      throw error;
    } finally {
      try { connection.release(); } catch (_) { /* release is best-effort */ }
    }
  }
  throw lastError;
}

async function persistImportItem(connection, sourceType, item, text, analysis) {
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
  if (!text) return 0;
  const [existingTextRows] = await connection.execute(
    'SELECT id_reading_text FROM reading_texts WHERE source_id = ? AND user_id IS NULL ORDER BY id_reading_text LIMIT 1',
    [sourceId]
  );
  const existingTextId = Number(existingTextRows?.[0]?.id_reading_text) || null;
  if (existingTextId) {
    await connection.execute(
      "UPDATE reading_texts SET text = ?, title = ?, level = ?, annotations_json = '[]'::jsonb, sentences_json = NULL, tokens_json = NULL, sentence_translations_json = NULL WHERE id_reading_text = ? AND user_id IS NULL",
      [text, item.title, analysis.level, existingTextId]
    );
  } else {
    const [textResult] = await connection.execute(
      "INSERT INTO reading_texts (source_id, user_id, text, title, level, annotations_json) VALUES (?, NULL, ?, ?, ?, '[]'::jsonb) RETURNING id_reading_text AS insertId",
      [sourceId, text, item.title, analysis.level]
    );
    if (!extractInsertId(textResult)) throw new Error('Failed to save reading text.');
  }
  return 1;
}

function assertAozoraCardUrl(value) {
  const message = 'url must be an Aozora work page URL (https://www.aozora.gr.jp/cards/…/card….html).';
  let url = null;
  try {
    url = new URL(String(value || '').trim());
  } catch (_) {
    throw new ValidationError(message);
  }
  if (url.protocol !== 'https:' || url.hostname !== 'www.aozora.gr.jp' || url.port || url.username || url.password) {
    throw new ValidationError(message);
  }
  if (!/^\/cards\/\d+\/card\d+\.html$/i.test(url.pathname)) throw new ValidationError(message);
  return url.toString();
}

function extractAozoraCardTitle(cardHtml) {
  const match = String(cardHtml || '').match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  if (!match) return null;
  const title = truncateCodePoints(
    plainTextFromMarkup(match[1]).replace(/^図書カード\s*[:：]\s*/u, '').replace(/\s*[-－—]\s*青空文庫\s*$/u, '').trim(),
    MAX_READING_TITLE_LENGTH
  );
  return title || null;
}

function hukuListingItems(html, maxItems = 20) {
  const items = [];
  const anchors = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi;
  let match;
  while ((match = anchors.exec(html)) && items.length < maxItems) {
    let resolved;
    try { resolved = new URL(decodeEntities(match[2]), hukuListingUrl('01')); } catch (_) { continue; }
    const url = safeExternalUrl(resolved.toString(), 'hukumusume.com');
    // Story pages only: /douwa/pc/jap/<month>/<story>.htm. Index, English and
    // special pages never match, so navigation links are skipped by shape.
    if (!url || !/^\/douwa\/pc\/jap\/\d\d\/\d+\.htm$/i.test(url.pathname)) continue;
    const title = truncateCodePoints(plainTextFromMarkup(match[3]), MAX_READING_TITLE_LENGTH);
    if (!title) continue;
    if (!items.some((item) => item.url === url.toString())) items.push({ title, url: url.toString(), date: null, text: null, audio: null });
  }
  return items;
}

function extractHukuColumn(html) {
  // The story column is a <td width="619"> that itself contains nested
  // tables, so a lazy regex would stop at the first inner </td>. Scan
  // balanced open/close td tags from the column start instead.
  const source = String(html || '');
  const open = source.match(/<td\b[^>]*\bwidth\s*=\s*["']?619["']?[^>]*>/i);
  if (!open || open.index === undefined) return null;
  const tagPattern = /<\/?td\b[^>]*>/gi;
  tagPattern.lastIndex = open.index;
  let depth = 0;
  let match = null;
  while ((match = tagPattern.exec(source))) {
    const tag = match[0];
    if (tag[1] === '/') {
      depth -= 1;
      if (depth === 0) return source.slice(open.index + open[0].length, match.index);
    } else if (!/\/>$/.test(tag)) {
      depth += 1;
    }
  }
  return null;
}

function extractHukuStory(html, workTitle) {
  // Main column first: the centered 969 table's 619-wide cell holds the
  // story; header/footer chrome lives outside it. Falls back to the whole
  // page rather than returning nothing.
  const column = extractHukuColumn(html);
  const cleaned = plainTextFromMarkup(column === null ? String(html || '') : column);
  if (!cleaned) return null;
  let text = cleaned;
  // Head trim: the column opens with breadcrumb, credits and quizzes before
  // the story head repeats the work title. Cut at the last title occurrence
  // within the opening stretch so a mid-story repeat can never eat the tale.
  if (workTitle) {
    const indices = [];
    let from = 0;
    let found = text.indexOf(workTitle, from);
    while (found !== -1 && found < 2000) {
      indices.push(found);
      from = found + workTitle.length;
      found = text.indexOf(workTitle, from);
    }
    if (indices.length) text = text.slice(indices[indices.length - 1]);
  }
  // Tail trim: おしまい ("the end") closes every tale; answers, reader
  // illustrations and comments follow and are not reading content.
  const end = text.indexOf('おしまい');
  if (end !== -1) text = text.slice(0, end + 'おしまい'.length);
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return truncateCodePoints(text, MAX_READING_TEXT_LENGTH) || null;
}

function extractHukuTitle(storyHtml, fallback) {
  const match = String(storyHtml || '').match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  if (match) {
    const title = truncateCodePoints(
      plainTextFromMarkup(match[1]).replace(/\s*[＜<][^＞>]*[＞>]\s*$/u, '').trim(),
      MAX_READING_TITLE_LENGTH
    );
    if (title) return title;
  }
  return typeof fallback === 'string' && fallback.trim()
    ? truncateCodePoints(fallback.trim(), MAX_READING_TITLE_LENGTH)
    : null;
}

function assertHukuStoryUrl(value) {
  const message = 'url must be a Hukumusume story page URL (https://hukumusume.com/douwa/pc/jap/…/….htm).';
  let url = null;
  try {
    url = new URL(String(value || '').trim());
  } catch (_) {
    throw new ValidationError(message);
  }
  if (url.protocol !== 'https:' || url.hostname !== 'hukumusume.com' || url.port || url.username || url.password) {
    throw new ValidationError(message);
  }
  if (!/^\/douwa\/pc\/jap\/\d\d\/\d+\.htm$/i.test(url.pathname)) throw new ValidationError(message);
  return url.toString();
}

async function previewHukuSources(fetchImpl = globalThis.fetch, { index = '01' } = {}) {
  try {
    const listingUrl = hukuListingUrl(index);
    const html = await fetchFixedText(fetchImpl, listingUrl, 'hukumusume.com', 2 * 1024 * 1024);
    return { status: 'ok', index: HUKU_MONTHS.includes(index) ? index : '01', items: hukuListingItems(html, 20) };
  } catch (error) {
    return { status: 'unavailable', reason: error?.message === 'response_too_large' ? 'Source response exceeded the size limit.' : 'Source request failed.' };
  }
}

async function importHukuUrl(executor, userId, rawUrl, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const storyUrl = assertHukuStoryUrl(rawUrl);
  try {
    const page = await fetchFixedText(fetchImpl, storyUrl, 'hukumusume.com', 2 * 1024 * 1024);
    const title = extractHukuTitle(page, storyUrl);
    if (!title) return { status: 'unavailable', reason: 'Could not read that story page.' };
    const text = extractHukuStory(page, title);
    if (!text) return { status: 'unavailable', reason: 'Could not extract readable text from that page.' };
    const analysis = await analyzeImportText(executor, userId, text, 3);
    const stored = await persistImportItemWithRetry(executor, 'hukumusume', { title, url: storyUrl, date: null, audio: null }, text, analysis);
    return { status: 'ok', imported: 1, textsImported: stored };
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    return { status: 'unavailable', reason: 'Source request failed.' };
  }
}

// Pasted-link import: one user-chosen Aozora work page, analyzed and stored.
// Same guards as bulk sync (fixed host, card path, byte caps, timeouts) plus
// the shared persist path, so a pasted link cannot reach anywhere the picker
// could not.
async function importAozoraUrl(executor, userId, rawUrl, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const cardUrl = assertAozoraCardUrl(rawUrl);
  try {
    const card = await fetchFixedText(fetchImpl, cardUrl, 'www.aozora.gr.jp', 2 * 1024 * 1024);
    const title = extractAozoraCardTitle(card);
    if (!title) return { status: 'unavailable', reason: 'Could not read that work page.' };
    const enriched = await loadAozoraArticle(fetchImpl, { title, url: cardUrl, date: null, text: null, audio: null });
    const text = typeof enriched.text === 'string' && enriched.text.trim()
      ? truncateCodePoints(enriched.text.trim(), MAX_READING_TEXT_LENGTH)
      : null;
    if (!text) return { status: 'unavailable', reason: 'Could not extract readable text from that page.' };
    const analysis = await analyzeImportText(executor, userId, text, 3);
    const stored = await persistImportItemWithRetry(executor, 'aozora', { title, url: cardUrl, date: null, audio: null }, text, analysis);
    return { status: 'ok', imported: 1, textsImported: stored };
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    return { status: 'unavailable', reason: 'Source request failed.' };
  }
}

module.exports = {
  AOZORA_LISTING_URL,
  MAX_ANNOTATIONS,
  MAX_IMPORT_ITEMS,
  MAX_LIBRARY_LIMIT,
  MAX_READING_ENROLL_ITEMS,
  MAX_READING_TEXT_LENGTH,
  MAX_READING_TITLE_LENGTH,
  MAX_TOKENS,
  MAX_TRANSLATION_LENGTH,
  MIN_LEVEL_CHARACTERS,
  buildAnnotations,
  analyzeTextForReading,
  classifyLevel,
  createUserReadingText,
  deleteUserReadingText,
  enrollReadingItems,
  extractAozoraText,
  extractHukuStory,
  extractHukuTitle,
  getReadingText,
  importAozoraUrl,
  importHukuUrl,
  isTransientDbError,
  loadAozoraSources,
  loadHukuSources,
  listReadingLibrary,
  listReadingProgress,
  normalizeAnalysisText,
  normalizeReadingText,
  normalizeTitle,
  parseMetadata,
  parseTranslations,
  previewAozoraSources,
  previewHukuSources,
  saveSentenceTranslations,
  splitSentences,
  syncReadingSources,
  upsertReadingProgress
};
