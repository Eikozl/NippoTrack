// CA-B2 — centralized Kuromoji/JLT ↔ JMdict POS compatibility layer.
//
// Verdicts: EXACT_COMPATIBLE | BROAD_COMPATIBLE | INCOMPATIBLE | UNKNOWN.
// ONLY INCOMPATIBLE may hard-exclude a sense (H5). Everything uncertain
// preserves ambiguity.
//
// Wildcards (can never strike, so can never exclude):
// - 'unc' (frozen: the measured unknown code — unknown is not incompatible)
// - any code the family table does not recognize (DTD evolution surfaces as
//   ambiguity, never as silent exclusion)
// - an empty/absent code list (no evidence either way)
//
// A sense is INCOMPATIBLE iff it carries ≥1 code AND every code strikes
// (recognized, and outside the candidate class's compatible set). Mixed sets
// such as ['n','adj-na'] survive via their compatible member — the measured
// 3,348-entry n/adj-na overlap is the reason this rule is conjunctive.
// vi/vt are orthogonal transitivity metadata: they never exclude on their
// own, and particles never prove transitivity (so transitivity is never
// demanded of the parser side either).
//
// Inflection corroboration (Kuromoji conjugated_type → JMdict verb family)
// may ADD the INFLECTION_FAMILY_COMPATIBLE evidence code. It may NEVER
// exclude: an unmapped inflectionType yields null (UNKNOWN), and a mapped
// type that disagrees with the sense family is ignored, not a veto.

const { classifyPosCode } = require('./jmdictReference');

const POS_EXACT = 'EXACT_COMPATIBLE';
const POS_BROAD = 'BROAD_COMPATIBLE';
const POS_INCOMPATIBLE = 'INCOMPATIBLE';
const POS_UNKNOWN = 'UNKNOWN';

// Compatible code matchers per JLT candidate POS. `exact` feeds the POS_EXACT
// evidence code, `broad` feeds POS_BROAD; the union feeds exclusion safety.
// Review-driven conservative choices (CA-B2 audit):
// - exp is broad for EVERY class: expressions are cross-category; excluding
//   on exp manufactures false NO_MATCH (e.g. verb idioms, しょうがない).
// - aux-v is broad for verbs: subsidiary uses (てみる/てしまう/ておく) are
//   real verb senses; pure aux/aux-adj/cop still strike (JLT function tokens
//   never become verb candidates, and main-verb words always carry v* too).
// - vs is broad for na-adjective/noun: suru-nouns (安心/心配/勉強) are
//   genuinely verbal; excluding vs narrows to the nominal reading falsely.
// - adv is broad for nouns (adverbial nouns/pronouns: 何も〜ない, 明日) and
//   n/n-adv are broad for adverbs (明日/朝 tagged adverbially); int is broad
//   for nouns and adv/n broad for interjections (まあ adv/int variance).
//   The 何/なに live case stays AMBIGUOUS across n+adv, never COMPATIBLE.
// - ctr/suf/pref/num are broad for nouns and na-adjectives (counters and
//   affixes attach to nominals: 三杯の杯): excluding them promotes niche
//   senses or false NO_MATCH. pn still strikes: proper names are out of v1
//   scope (JMnedict excluded) and a pn-only entry is honestly NO_MATCH for
//   a common-noun observation — the true common entry still matches by keb.
const COMPATIBLE_POS = {
  verb: {
    exact: [/^v[15]/i, /^vk/i, /^vs/i, /^vz/i, /^v[ti]$/i],
    broad: [/^v[24]/i, /^vn/i, /^vr/i, /^v-unspec/i, /^aux-v/i, /^exp/i]
  },
  'i-adjective': {
    exact: [/^adj-i($|x)/i],
    broad: [/^aux-adj/i, /^exp/i]
  },
  'na-adjective': {
    exact: [/^adj-na($|-)/i],
    broad: [/^adj-(no|pn|f)($|-)/i, /^n($|-)/i, /^vs/i, /^exp/i, /^(ctr|suf|pref|num)($|-)/i]
  },
  noun: {
    exact: [/^n($|-)/i],
    // adv is BROAD (not a strike) for nouns: adverbial nouns/pronouns
    // systematically carry adv senses (何も〜ない "(not) at all", 明日 used
    // adverbially). Excluding them inverts certainty — a niche noun sense
    // would be promoted COMPATIBLE while the common adverbial sense is
    // filtered. Proven live: 何/なに (JMdict 1577100) must stay AMBIGUOUS
    // across its n and adv senses, never COMPATIBLE on the n sense alone.
    broad: [/^adj-no($|-)/i, /^adj-na($|-)/i, /^exp/i, /^adv/i, /^vs/i, /^int/i, /^(ctr|suf|pref|num)($|-)/i]
  },
  adverb: {
    exact: [/^adv($|-)/i],
    broad: [/^n($|-)/i, /^exp/i]
  },
  interjection: {
    exact: [/^int$/i],
    broad: [/^exp/i, /^adv/i, /^n($|-)/i]
  }
};

// Proven Kuromoji conjugated_type → JMdict verb-family prefix. Matched by
// prefix against sense codes (v5k covers v5k and v5k-s). Anything unmapped
// (including 特殊・ザ行変格 and future IPADIC types) yields null.
const INFLECTION_FAMILY_MAP = [
  ['一段', 'v1'],
  ['五段・カ行', 'v5k'],
  ['五段・ガ行', 'v5g'],
  ['五段・サ行', 'v5s'],
  ['五段・タ行', 'v5t'],
  ['五段・ナ行', 'v5n'],
  ['五段・バ行', 'v5b'],
  ['五段・マ行', 'v5m'],
  ['五段・ラ行', 'v5r'],
  ['五段・ワ行', 'v5u'],
  ['カ変', 'vk'],
  ['サ変', 'vs']
];

function normalizeCodes(pos) {
  if (!Array.isArray(pos)) return [];
  return pos.filter((code) => typeof code === 'string' && code !== '');
}

// Classify ONE JMdict code for a JLT candidate POS: 'ok-exact',
// 'ok-broad', 'wildcard' (unc / unrecognized / never excludes), 'strike'.
function classifyCodeFor(jltPos, code) {
  if (code === 'unc') return 'wildcard';
  if (classifyPosCode(code) === null) return 'wildcard';
  const table = COMPATIBLE_POS[jltPos];
  if (!table) return 'wildcard';
  if (table.exact.some((pattern) => pattern.test(code))) return 'ok-exact';
  if (table.broad.some((pattern) => pattern.test(code))) return 'ok-broad';
  return 'strike';
}

// Sense-level H5 verdict for a JLT candidate POS against a JMdict pos array.
function posCompatibility(jltPos, sensePos) {
  const codes = normalizeCodes(sensePos);
  if (!codes.length) return POS_UNKNOWN;
  let sawExact = false;
  let sawBroad = false;
  let sawWildcard = false;
  for (const code of codes) {
    const verdict = classifyCodeFor(jltPos, code);
    if (verdict === 'ok-exact') sawExact = true;
    else if (verdict === 'ok-broad') sawBroad = true;
    else if (verdict === 'wildcard') sawWildcard = true;
  }
  // A compatible member proves compatibility even beside an unknown code;
  // a wildcard only blocks the INCOMPATIBLE proof (unknown ≠ incompatible).
  if (sawExact) return POS_EXACT;
  if (sawBroad) return POS_BROAD;
  if (sawWildcard) return POS_UNKNOWN;
  return POS_INCOMPATIBLE;
}

// Inflection corroboration only. Returns 'INFLECTION_FAMILY_COMPATIBLE' when
// the head token's conjugated_type provably maps onto a family present in
// the sense codes, else null. Never excludes.
function inflectionEvidence(inflectionType, sensePos) {
  if (typeof inflectionType !== 'string' || inflectionType === '') return null;
  const mapping = INFLECTION_FAMILY_MAP.find(([prefix]) => inflectionType.startsWith(prefix));
  if (!mapping) return null;
  const family = mapping[1].toLowerCase();
  for (const code of normalizeCodes(sensePos)) {
    if (code.toLowerCase().startsWith(family)) return 'INFLECTION_FAMILY_COMPATIBLE';
  }
  return null;
}

module.exports = {
  POS_EXACT,
  POS_BROAD,
  POS_INCOMPATIBLE,
  POS_UNKNOWN,
  COMPATIBLE_POS,
  INFLECTION_FAMILY_MAP,
  classifyCodeFor,
  posCompatibility,
  inflectionEvidence
};
