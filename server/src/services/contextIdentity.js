// CA-B2 — safe dictionary-identity construction for Context-Aware lookup.
//
// HARD INVARIANTS (frozen):
// - Identity keys come ONLY from safe dictionary-form identity: candidate
//   lemma + canonical (deduplicated). Reconstructed/inflected observed
//   surfaces (行った, 行きました, 食べなかった, 来なかった, 高かった, …)
//   MUST NEVER become Q1 identity keys; they are display/occurrence evidence.
// - A surface may participate ONLY when proven dictionary-form/uninflected.
//   The implemented proof is `surface === lemma` (in which case the key is
//   identical to the lemma key — the rule is enforced structurally, not by
//   string trust).
// - Strategy is chosen BEFORE Q1: ORTHOGRAPHIC (Han-bearing identity → keb
//   cohort; readings validate within the cohort, never expand it) vs
//   READING_FALLBACK (kana-only identity → reb cohort; homographs stay
//   MULTIPLE). A failed Han lookup NEVER silently falls back to a reading
//   search (that would import homophones such as 逝く/往く for 行く).
// - Keys are normalized with EXACTLY normalizeJmdictForm() so importer keys
//   and query keys agree byte-for-byte. Never a generic reading normalizer.

const { hasHanCharacter, normalizeJmdictForm } = require('./jmdictReference');

const CONTEXT_MAX_CANDIDATES = 30;
const CONTEXT_MAX_KEYS_PER_CANDIDATE = 4;

// Phase 12 candidate POS values admitted to dictionary lookup. Mirrors
// classifyCandidate()'s content-word set: proper nouns, unknowns, symbols,
// particles, auxiliaries, copulas, affixes, numerals and friends are
// intentionally UNSUPPORTED (JMnedict is out of scope for v1).
const CONTEXT_ELIGIBLE_POS = new Set([
  'noun',
  'verb',
  'i-adjective',
  'na-adjective',
  'adverb',
  'interjection'
]);

function eligibleCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return { eligible: false, reason: 'invalid-candidate' };
  if (!CONTEXT_ELIGIBLE_POS.has(candidate.pos)) return { eligible: false, reason: 'unsupported-pos' };
  return { eligible: true, reason: null };
}

// Safe identity strings for one candidate: lemma + canonical, deduplicated,
// plus observed surfaces ONLY when surface === lemma (proven uninflected —
// the key then equals the lemma key by construction). Returns raw strings;
// normalization to lookup keys happens in identityKeysFor().
function safeIdentityStrings(candidate) {
  const out = [];
  const push = (value) => {
    if (typeof value !== 'string' || value === '') return;
    if (!out.includes(value)) out.push(value);
  };
  push(candidate.lemma);
  push(candidate.canonical);
  const lemma = typeof candidate.lemma === 'string' && candidate.lemma !== '' ? candidate.lemma : null;
  for (const entry of candidate.observed || []) {
    if (!entry || typeof entry.surface !== 'string') continue;
    // Proven dictionary-form ONLY: an inflected surface (行った vs 行く)
    // never passes this gate.
    if (lemma !== null && entry.surface === lemma) push(entry.surface);
  }
  return out;
}

function identityStrategy(rawKeys) {
  return rawKeys.some((key) => hasHanCharacter(key)) ? 'ORTHOGRAPHIC' : 'READING_FALLBACK';
}

// Strategy is driven by the LEMMA alone, never by a Han canonical that the
// observation never asserted. Phase 12 always mirrors lemma into canonical,
// so this is a no-op on real inputs — but a kana lemma with a Han canonical
// (hand-built or future caller) must NEVER upgrade to an ORTHOGRAPHIC keb
// lookup on an unobserved spelling: that would drop the true kana cohort
// (e.g. あつい → 暑い only, losing 熱い/厚い ambiguity) and manufacture a
// false UNIQUE.
function strategyFor(candidate, rawKeys) {
  if (typeof candidate.lemma === 'string' && candidate.lemma !== '') {
    return hasHanCharacter(candidate.lemma) ? 'ORTHOGRAPHIC' : 'READING_FALLBACK';
  }
  return identityStrategy(rawKeys);
}

// Build the bounded, normalized Q1 identity for one candidate. Returns null
// when no safe identity exists (H6 at the source: nothing to look up).
// Shape: { strategy, kind, keys: [{ value, normalized }], lemmaReading }.
// In ORTHOGRAPHIC mode only Han-bearing keys participate (a kana string can
// never be a keb identity; the parser lemmaReading is retained separately as
// reading evidence so nothing is lost).
function identityKeysFor(candidate) {
  const raw = safeIdentityStrings(candidate);
  if (!raw.length) return null;
  const strategy = strategyFor(candidate, raw);
  const scoped = strategy === 'ORTHOGRAPHIC' ? raw.filter((key) => hasHanCharacter(key)) : raw;
  if (!scoped.length) return null;
  const keys = [];
  for (const value of scoped.slice(0, CONTEXT_MAX_KEYS_PER_CANDIDATE)) {
    let normalized;
    try {
      normalized = normalizeJmdictForm(value);
    } catch (_) {
      continue;
    }
    if (!keys.some((key) => key.normalized === normalized)) keys.push({ value, normalized });
  }
  if (!keys.length) return null;
  return {
    strategy,
    kind: strategy === 'ORTHOGRAPHIC' ? 'keb' : 'reb',
    keys,
    lemmaReading: typeof candidate.lemmaReading === 'string' && candidate.lemmaReading !== ''
      ? candidate.lemmaReading
      : null,
    surfaceReading: typeof candidate.surfaceReading === 'string' && candidate.surfaceReading !== ''
      ? candidate.surfaceReading
      : null
  };
}

// Recover Kuromoji inflection evidence for a candidate from the Phase 12
// token stream (candidate aggregates do not carry inflectionType). Matches
// the head token via the same identity Phase 12 aggregates on:
// `${pos}::${lemma || surface}`. Returns { inflectionType, inflectionForm }
// or null when unavailable — callers treat null as UNKNOWN (never exclude).
function headTokenFor(candidate, tokens) {
  if (!candidate || !Array.isArray(tokens)) return null;
  const identity = `${candidate.pos}::${candidate.lemma || candidate.canonical || ''}`;
  for (const token of tokens) {
    if (!token || typeof token !== 'object') continue;
    if (`${token.pos}::${token.lemma || token.surface || ''}` !== identity) continue;
    return {
      inflectionType: typeof token.inflectionType === 'string' ? token.inflectionType : null,
      inflectionForm: typeof token.inflectionForm === 'string' ? token.inflectionForm : null
    };
  }
  return null;
}

module.exports = {
  CONTEXT_MAX_CANDIDATES,
  CONTEXT_MAX_KEYS_PER_CANDIDATE,
  CONTEXT_ELIGIBLE_POS,
  eligibleCandidate,
  safeIdentityStrings,
  identityStrategy,
  strategyFor,
  identityKeysFor,
  headTokenFor
};
