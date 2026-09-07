// Phase 12-B — lexical candidate construction + owned-vocabulary matching.
//
 // ALL TOKENS != VOCABULARY CANDIDATES. This module derives the small,
 // conservative product surface P12-B shows in the Analyzer from the full
 // normalized token stream:
 //
 // - CANDIDATES: content-word aggregates (noun/verb/i-adjective/na-adjective/
 //   adverb/interjection) safe to offer as "Add to Vocabulary".
 // - UNVERIFIED: proper nouns + unknown spans. Visible as "needs verification"
 //   material, never offered as trusted imports, never given readings.
 // - Everything else (particles, auxiliaries, copulas, symbols, affixes,
 //   numerals, conjunctions, adnominals) is excluded from the candidate UI
 //   entirely. The full token stream is preserved in the API for future work.
 //
 // Matching is server-side, user-scoped (user_id = req.user.id), set-based
 // (max 2 bounded queries, never N+1). Lemma/surface exact hits are confident
 // ("existing"); reading-only hits are "ambiguous" (never confident — false
 // negative beats incorrect linking); lookup failure propagates so the caller
 // can mark matching "unavailable" instead of falsely claiming "new".

 const { classifyCandidate } = require('./lexicalTokenAdapter');
 const { katakanaToHiragana, hiraganaToKatakana } = require('../search/japaneseSearch');

 // Safe inflection continuation POS tags that can be appended to a content-word
 // head to reconstruct the observed inflected surface. Only these categories
 // are considered safe continuations; everything else stops composition.
 const INFLECTION_CONTINUATION_POS = new Set(['auxiliary', 'copula']);

 // Check if token B can be a safe inflection continuation of token A.
 function isSafeInflectionContinuation(headToken, nextToken) {
   if (!headToken || !nextToken) return false;
   if (nextToken.start !== headToken.end) return false; // must be contiguous
   return INFLECTION_CONTINUATION_POS.has(nextToken.pos);
 }

 // Reconstruct the full observed inflected surface for a candidate by walking
 // forward from the head token through contiguous safe inflection continuations.
 function reconstructObservedSurface(tokens, headIndex) {
   const head = tokens[headIndex];
   if (!head) return { surface: head?.surface || '', surfaceReading: head?.surfaceReading || null };
   let surface = head.surface;
   let surfaceReading = head.surfaceReading;
   let allHaveReading = !!head.surfaceReading;
   let i = headIndex + 1;
   while (i < tokens.length) {
     const next = tokens[i];
     if (!isSafeInflectionContinuation(tokens[i - 1], next)) break;
     surface += next.surface;
     if (next.surfaceReading) {
       surfaceReading = (surfaceReading || '') + next.surfaceReading;
     } else {
       allHaveReading = false;
     }
     i += 1;
   }
   return { surface, surfaceReading: allHaveReading ? surfaceReading : null };
 }

 function candidateIdentity(token) {
   return `${token.pos}::${token.lemma || token.surface}`;
 }

 function pushObserved(aggregate, token) {
   const seen = aggregate.observed.find((entry) => entry.surface === token.surface);
   if (seen) {
     seen.occurrences += 1;
     return;
   }
   aggregate.observed.push({
     surface: token.surface,
     surfaceReading: token.surfaceReading || null,
     occurrences: 1,
     firstStart: token.start
   });
 }

 // Build a map from lemma+pos to all observed inflected forms (reconstructed
 // from contiguous auxiliary/copula chains). This is called after the full
 // token stream is available.
 function buildObservedFormsMap(tokens) {
   const map = new Map();
   for (let i = 0; i < tokens.length; i++) {
     const token = tokens[i];
     if (!token || typeof token.surface !== 'string') continue;
     const key = candidateIdentity(token);
     // Only reconstruct inflection chains for content words. For other tokens
     // (proper nouns, unknowns, etc.), just use their individual surface.
     let surface, surfaceReading;
     if (token.isContentWord) {
       const reconstructed = reconstructObservedSurface(tokens, i);
       surface = reconstructed.surface;
       surfaceReading = reconstructed.surfaceReading;
     } else {
       surface = token.surface;
       surfaceReading = token.surfaceReading || null;
     }
     if (!map.has(key)) {
       map.set(key, []);
     }
     const list = map.get(key);
     const existing = list.find((entry) => entry.surface === surface);
     if (existing) {
       existing.occurrences += 1;
     } else {
       list.push({
         surface,
         surfaceReading,
         occurrences: 1,
         firstStart: token.start
       });
     }
   }
   return map;
 }

 // Aggregate content-word tokens into product candidates. Pure, no I/O.
 function buildLexicalCandidates(tokens) {
   const byKey = new Map();
   const unverifiedByKey = new Map();
   const list = Array.isArray(tokens) ? tokens : [];
 
   // First pass: build observed forms map from the full token stream
   const observedFormsMap = buildObservedFormsMap(list);
 
   for (const token of list) {
     if (!token || typeof token !== 'object' || typeof token.surface !== 'string') continue;
     const verdict = classifyCandidate(token);
     if (verdict.candidate) {
       const key = candidateIdentity(token);
       let aggregate = byKey.get(key);
       if (!aggregate) {
         const observedForms = observedFormsMap.get(key) || [];
         aggregate = {
           key,
           canonical: token.lemma || token.surface,
           lemma: token.lemma || null,
           pos: token.pos,
           lemmaReading: token.lemmaReading || null,
           surfaceReading: token.surfaceReading || null,
           observed: observedForms,
           occurrences: 0,
           firstStart: token.start,
           match: { state: 'new', ownedCount: 0, possibleMatches: [] }
         };
         byKey.set(key, aggregate);
       }
       aggregate.occurrences += 1;
       if (typeof token.start === 'number' && (typeof aggregate.firstStart !== 'number' || token.start < aggregate.firstStart)) {
         aggregate.firstStart = token.start;
       }
       if (!aggregate.lemmaReading && token.lemmaReading) aggregate.lemmaReading = token.lemmaReading;
       if (!aggregate.surfaceReading && token.surfaceReading) aggregate.surfaceReading = token.surfaceReading;
     } else if (token.pos === 'proper-noun' || token.isUnknown) {
       // Visible but untrusted: no readings, no import offer.
       const key = `${token.pos}::${token.surface}`;
       let aggregate = unverifiedByKey.get(key);
       if (!aggregate) {
         const observedForms = observedFormsMap.get(key) || [];
         aggregate = {
           key,
           canonical: token.surface,
           lemma: null,
           pos: token.pos,
           lemmaReading: null,
           surfaceReading: null,
           observed: observedForms,
           occurrences: 0,
           firstStart: token.start,
           match: { state: 'unsupported', ownedCount: 0, possibleMatches: [] }
         };
         unverifiedByKey.set(key, aggregate);
       }
       aggregate.occurrences += 1;
       if (typeof token.start === 'number' && (typeof aggregate.firstStart !== 'number' || token.start < aggregate.firstStart)) {
         aggregate.firstStart = token.start;
       }
     }
   }
   const candidates = [...byKey.values()].sort((a, b) => (a.firstStart ?? 0) - (b.firstStart ?? 0));
   const unverified = [...unverifiedByKey.values()].sort((a, b) => (a.firstStart ?? 0) - (b.firstStart ?? 0));
   return { candidates, unverified };
 }

function readingVariants(value) {
  const out = new Set();
  if (typeof value !== 'string' || !value) return [];
  out.add(value);
  try {
    out.add(katakanaToHiragana(value));
  } catch (_) {
    // Keep the raw value only.
  }
  try {
    out.add(hiraganaToKatakana(value));
  } catch (_) {
    // Keep existing variants only.
  }
  return [...out];
}

// Match candidates against the requesting user's vocabulary. Exactly two
// bounded queries maximum: (1) word IN (lemmas + surfaces), (2) reading IN
// (candidate reading variants) for the ambiguous fallback. Throws on DB
// failure so callers mark matching unavailable (never "all new").
async function matchOwnedVocabulary(pool, userId, candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) return { matched: 0, ambiguous: 0, queries: 0 };
  const wordKeys = new Set();
  for (const candidate of list) {
    if (candidate.lemma) wordKeys.add(candidate.lemma);
    wordKeys.add(candidate.canonical);
    for (const entry of candidate.observed || []) wordKeys.add(entry.surface);
  }
  const words = [...wordKeys].filter((value) => typeof value === 'string' && value !== '');
  let queries = 0;
  const byWord = new Map();
  if (words.length) {
    const placeholders = words.map(() => '?').join(', ');
    const [rows] = await pool.execute(
      `SELECT word, reading FROM vocabulary WHERE user_id = ? AND word IN (${placeholders})`,
      [userId, ...words]
    );
    queries += 1;
    for (const row of rows || []) {
      if (!row || typeof row.word !== 'string') continue;
      const bucket = byWord.get(row.word) || [];
      bucket.push(row);
      byWord.set(row.word, bucket);
    }
  }
  let matched = 0;
  const unmatched = [];
  for (const candidate of list) {
    const hits = [];
    const seenRows = new Set();
    const collect = (word) => {
      for (const row of byWord.get(word) || []) {
        if (seenRows.has(row)) continue;
        seenRows.add(row);
        hits.push(row);
      }
    };
    if (candidate.lemma) collect(candidate.lemma);
    collect(candidate.canonical);
    for (const entry of candidate.observed || []) collect(entry.surface);
    if (hits.length) {
      candidate.match = { state: 'existing', ownedCount: hits.length, possibleMatches: [] };
      matched += 1;
    } else {
      unmatched.push(candidate);
    }
  }
  // Reading-only fallback: possible (ambiguous) matches only, never confident.
  const readingKeys = new Set();
  const readingToCandidates = new Map();
  for (const candidate of unmatched) {
    for (const value of [candidate.lemmaReading, candidate.surfaceReading]) {
      for (const variant of readingVariants(value)) {
        readingKeys.add(variant);
        const bucket = readingToCandidates.get(variant) || new Set();
        bucket.add(candidate);
        readingToCandidates.set(variant, bucket);
      }
    }
  }
  let ambiguous = 0;
  const readings = [...readingKeys];
  if (readings.length) {
    const placeholders = readings.map(() => '?').join(', ');
    const [rows] = await pool.execute(
      `SELECT word, reading FROM vocabulary WHERE user_id = ? AND reading IN (${placeholders})`,
      [userId, ...readings]
    );
    queries += 1;
    const flagged = new Set();
    for (const row of rows || []) {
      if (!row || typeof row.reading !== 'string' || typeof row.word !== 'string') continue;
      for (const variant of readingVariants(row.reading)) {
        for (const candidate of readingToCandidates.get(variant) || []) {
          if (candidate.match.state !== 'new' || flagged.has(candidate)) continue;
          flagged.add(candidate);
          candidate.match.possibleMatches.push({ word: row.word });
          if (candidate.match.possibleMatches.length > 3) candidate.match.possibleMatches.length = 3;
        }
      }
    }
    for (const candidate of flagged) {
      candidate.match.state = 'ambiguous';
      ambiguous += 1;
    }
  }
  return { matched, ambiguous, queries };
}

function summarizeLexical(candidates, unverified, matchingAvailable) {
  const list = Array.isArray(candidates) ? candidates : [];
  const extra = Array.isArray(unverified) ? unverified : [];
  let existing = 0;
  let ambiguous = 0;
  let unavailable = 0;
  for (const candidate of list) {
    const state = candidate.match && candidate.match.state;
    if (state === 'existing') existing += 1;
    else if (state === 'ambiguous') ambiguous += 1;
    else if (state === 'unavailable') unavailable += 1;
  }
  return {
    candidates: list.length,
    existing,
    new: matchingAvailable ? list.length - existing - ambiguous - unavailable : 0,
    ambiguous,
    unavailable,
    unverified: extra.length
  };
}

module.exports = {
  buildLexicalCandidates,
  matchOwnedVocabulary,
  summarizeLexical
};
