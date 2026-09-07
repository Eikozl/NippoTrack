// CA-B2 unit tests: identity safety, POS compatibility, hard filters,
// two-axis finalization, evidence codes, and payload diet. Pure logic only —
// no database, no network. Every test names the wrong implementation it
// would catch.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CONTEXT_MAX_CANDIDATES,
  CONTEXT_MAX_KEYS_PER_CANDIDATE,
  eligibleCandidate,
  safeIdentityStrings,
  identityStrategy,
  identityKeysFor,
  headTokenFor
} = require('../src/services/contextIdentity');
const {
  POS_EXACT,
  POS_BROAD,
  POS_INCOMPATIBLE,
  POS_UNKNOWN,
  classifyCodeFor,
  posCompatibility,
  inflectionEvidence
} = require('../src/services/contextPos');
const {
  MATCH,
  INTERP,
  evaluateSenses,
  resolveReadings,
  finalizeCandidate
} = require('../src/services/contextFilters');
const {
  DISPLAY_MAX_ENTRIES,
  DISPLAY_MAX_SENSES,
  DISPLAY_MAX_GLOSSES,
  CONTEXT_PAYLOAD_MAX_BYTES,
  MATCH_STATUSES,
  INTERPRETATION_STATUSES,
  dietEntry,
  buildItem,
  enforcePayloadCap,
  buildBlock,
  lexicalRequiredBlock,
  unavailableBlock
} = require('../src/services/contextResponse');

function candidate(overrides = {}) {
  return {
    key: 'verb::行く',
    canonical: '行く',
    lemma: '行く',
    pos: 'verb',
    lemmaReading: null,
    surfaceReading: null,
    observed: [],
    ...overrides
  };
}

function identity(overrides = {}) {
  return {
    strategy: 'ORTHOGRAPHIC',
    kind: 'keb',
    keys: [{ value: '行く', normalized: '行く' }],
    lemmaReading: null,
    surfaceReading: null,
    ...overrides
  };
}

// --- §7 candidate eligibility -------------------------------------------

test('proper nouns, unknowns and function words are UNSUPPORTED, never looked up', () => {
  // Would fail if eligibility were broadened to JMnedict territory or if
  // particles/auxiliaries reached Q1 (unbounded junk cohorts).
  for (const pos of ['proper-noun', 'unknown', 'symbol', 'particle', 'auxiliary', 'copula', 'conjunction', 'adnominal', 'prefix', 'suffix']) {
    assert.equal(eligibleCandidate(candidate({ pos })).eligible, false, pos);
  }
  for (const pos of ['noun', 'verb', 'i-adjective', 'na-adjective', 'adverb', 'interjection']) {
    assert.equal(eligibleCandidate(candidate({ pos })).eligible, true, pos);
  }
  assert.equal(eligibleCandidate(null).eligible, false);
});

// --- §8 safe identity keys -----------------------------------------------

test('inflected observed surfaces never become identity keys', () => {
  // Would fail if observed surfaces fed Q1: 行った as a key would miss the
  // 行く cohort entirely (H6 by accident) or match a wrong entry.
  const keys = identityKeysFor(candidate({
    lemma: '行く',
    canonical: '行く',
    observed: [
      { surface: '行った', surfaceReading: 'いった' },
      { surface: '行きました', surfaceReading: 'いきました' }
    ]
  }));
  assert.deepEqual(keys.keys.map((key) => key.value), ['行く']);
  const tabenai = identityKeysFor(candidate({
    key: 'verb::食べる', canonical: '食べる', lemma: '食べる',
    observed: [{ surface: '食べなかった', surfaceReading: 'たべなかった' }]
  }));
  assert.ok(tabenai.keys.every((key) => key.value !== '食べなかった'));
  const konakatta = identityKeysFor(candidate({
    key: 'verb::来る', canonical: '来る', lemma: '来る',
    observed: [{ surface: '来なかった', surfaceReading: 'こなかった' }]
  }));
  assert.ok(konakatta.keys.every((key) => key.value !== '来なかった'));
});

test('surface participates only when proven dictionary-form (surface === lemma)', () => {
  // Would fail if the surface exception were widened to "observed often" or
  // dropped: 学校 observed as 学校 adds no new key (identical to lemma key).
  const keys = identityKeysFor(candidate({
    key: 'noun::学校', canonical: '学校', lemma: '学校', pos: 'noun',
    observed: [{ surface: '学校', surfaceReading: 'がっこう' }]
  }));
  assert.deepEqual(keys.keys.map((key) => key.value), ['学校']);
});

test('lemma and canonical deduplicate; empty identity yields null (H6 source)', () => {
  // Would fail on duplicate Q1 keys (wasted budget) or on a crash/empty-key
  // query for degenerates.
  const keys = identityKeysFor(candidate({ lemma: '学校', canonical: '学校', pos: 'noun', key: 'noun::学校' }));
  assert.equal(keys.keys.length, 1);
  assert.equal(identityKeysFor(candidate({ lemma: '', canonical: '', observed: [] })), null);
  assert.equal(identityKeysFor(candidate({ lemma: null, canonical: null })), null);
  // safeIdentityStrings can only emit lemma + canonical (≤2): the 4-key cap
  // is defense-in-depth, and the 30-candidate cap is enforced in the service
  // (proven by the 35-candidate test below), not here.
  assert.ok(safeIdentityStrings(candidate({ lemma: '学校', canonical: '学校' })).length <= 2);
});

test('identity keys are capped at 4 and normalized with the importer contract', () => {
  // Would fail if a pathological candidate built an unbounded key list, or
  // if query keys drifted from importer keys (katakana folding).
  assert.equal(CONTEXT_MAX_KEYS_PER_CANDIDATE, 4);
  const keys = identityKeysFor(candidate({ lemma: 'ガッコウ', canonical: 'ガッコウ', pos: 'noun', key: 'noun::ガッコウ' }));
  assert.equal(keys.keys[0].normalized, 'がっこう');
  assert.equal(keys.strategy, 'READING_FALLBACK');
  assert.equal(keys.kind, 'reb');
});

test('orthographic strategy drops non-Han keys; readings stay as evidence', () => {
  // Would fail if a kana string were searched as a keb identity (wasted
  // lookup that can never match) or if lemmaReading were lost with it.
  const keys = identityKeysFor({
    ...candidate({ lemma: '行く' }),
    lemmaReading: 'いく'
  });
  assert.equal(keys.strategy, 'ORTHOGRAPHIC');
  assert.equal(keys.kind, 'keb');
  assert.ok(keys.keys.every((key) => /[一-鿿]/.test(key.value) || key.value === '行く'));
  assert.equal(keys.lemmaReading, 'いく');
});

test('strategy follows the lemma, never an unobserved Han canonical', () => {
  // Would fail if a kana lemma with a Han canonical upgraded to an
  // ORTHOGRAPHIC keb lookup on an unobserved spelling (dropping the true
  // kana cohort and manufacturing a false UNIQUE on one spelling).
  const mixed = identityKeysFor(candidate({
    key: 'noun::あつい', canonical: '暑い', lemma: 'あつい', pos: 'noun'
  }));
  assert.equal(mixed.strategy, 'READING_FALLBACK');
  assert.equal(mixed.kind, 'reb');
  assert.ok(mixed.keys.some((key) => key.value === 'あつい'));
  const hanLemma = identityKeysFor(candidate({
    key: 'verb::行く', canonical: 'いく', lemma: '行く', pos: 'verb'
  }));
  assert.equal(hanLemma.strategy, 'ORTHOGRAPHIC');
  assert.deepEqual(hanLemma.keys.map((key) => key.value), ['行く']);
  const kanaOnly = identityKeysFor(candidate({
    key: 'noun::はし', canonical: 'はし', lemma: 'はし', pos: 'noun'
  }));
  assert.equal(kanaOnly.strategy, 'READING_FALLBACK');
  assert.equal(kanaOnly.kind, 'reb');
});

test('head-token inflection recovery matches Phase 12 aggregation identity', () => {
  // Would fail if inflection evidence attached to the wrong candidate
  // (e.g. first token of the sentence regardless of lemma).
  const tokens = [
    { pos: 'noun', lemma: '学校', surface: '学校', inflectionType: null, inflectionForm: null },
    { pos: 'verb', lemma: '行く', surface: '行っ', inflectionType: '五段・カ行', inflectionForm: '連用タ接続' }
  ];
  const head = headTokenFor(candidate({}), tokens);
  assert.equal(head.inflectionType, '五段・カ行');
  assert.equal(headTokenFor(candidate({ key: 'noun::学校', canonical: '学校', lemma: '学校', pos: 'noun' }), tokens).inflectionType, null);
  assert.equal(headTokenFor(candidate({}), []), null);
});

// --- §22 POS compatibility ------------------------------------------------

test('verb family accepts v1/v5/vk/vs/vi/vt and archaic/unspecified as broad', () => {
  // Would fail if godan subtypes (v5k-s) or suru verbs stopped matching, or
  // if archaic classes were treated as proven-incompatible.
  assert.equal(posCompatibility('verb', ['v1', 'vt']), POS_EXACT);
  assert.equal(posCompatibility('verb', ['v5k-s', 'vi']), POS_EXACT);
  assert.equal(posCompatibility('verb', ['vs-i']), POS_EXACT);
  assert.equal(posCompatibility('verb', ['vk']), POS_EXACT);
  assert.equal(posCompatibility('verb', ['v2a-s']), POS_BROAD);
  assert.equal(posCompatibility('verb', ['vn']), POS_BROAD);
  // Subsidiary verbs (てみる/てしまう/ておく) are real verb senses: aux-v
  // must keep, never exclude. Pure aux/cop still strike (JLT function
  // tokens never become verb candidates).
  assert.equal(posCompatibility('verb', ['aux-v']), POS_BROAD);
  assert.equal(posCompatibility('verb', ['v1', 'aux-v']), POS_EXACT);
  assert.equal(posCompatibility('verb', ['aux']), POS_INCOMPATIBLE);
  assert.equal(posCompatibility('verb', ['exp']), POS_BROAD);
});

test('verb excludes clean nominal/adjectival senses but never transitivity alone', () => {
  // Would fail if noun-only senses survived for verbs (false MULTIPLE that
  // hides UNIQUE), or if vi/vt mismatch excluded (transitivity is metadata —
  // particles do not prove it).
  assert.equal(posCompatibility('verb', ['n']), POS_INCOMPATIBLE);
  assert.equal(posCompatibility('verb', ['adj-i']), POS_INCOMPATIBLE);
  assert.equal(posCompatibility('verb', ['v5k', 'vt']), POS_EXACT);
  assert.equal(posCompatibility('verb', ['v5k', 'vi']), POS_EXACT);
});

test('i-adjective is exact only for adj-i/adj-ix; na-adjective keeps noun overlap', () => {
  // Would fail if adj-na bled into i-adjectives, or if the measured
  // 3,348-entry n/adj-na overlap were over-filtered for na-adjectives.
  assert.equal(posCompatibility('i-adjective', ['adj-i']), POS_EXACT);
  assert.equal(posCompatibility('i-adjective', ['adj-ix']), POS_EXACT);
  assert.equal(posCompatibility('i-adjective', ['adj-na']), POS_INCOMPATIBLE);
  assert.equal(posCompatibility('na-adjective', ['adj-na']), POS_EXACT);
  assert.equal(posCompatibility('na-adjective', ['n', 'adj-na']), POS_EXACT);
  assert.equal(posCompatibility('na-adjective', ['n']), POS_BROAD);
  assert.equal(posCompatibility('na-adjective', ['adj-i']), POS_INCOMPATIBLE);
  // Suru-nouns (安心/心配/勉強: n, adj-na, vs, vi) are genuinely verbal:
  // excluding vs narrows falsely to the nominal reading for 安心する.
  assert.equal(posCompatibility('na-adjective', ['vs']), POS_BROAD);
  assert.equal(posCompatibility('na-adjective', ['n', 'adj-na', 'vs', 'vi']), POS_EXACT);
  assert.equal(posCompatibility('na-adjective', ['exp']), POS_BROAD);
  assert.equal(posCompatibility('i-adjective', ['aux-adj']), POS_BROAD);
  assert.equal(posCompatibility('i-adjective', ['exp']), POS_BROAD);
});

test('unc, unknown codes and empty lists are wildcards — never exclusions', () => {
  // Would fail if the measured 'unc' code or future DTD codes hard-excluded
  // (F14), silently deleting valid interpretations.
  assert.equal(posCompatibility('verb', ['unc']), POS_UNKNOWN);
  assert.equal(posCompatibility('noun', ['unc']), POS_UNKNOWN);
  assert.equal(posCompatibility('verb', ['v9future']), POS_UNKNOWN);
  assert.equal(posCompatibility('verb', []), POS_UNKNOWN);
  assert.equal(posCompatibility('verb', null), POS_UNKNOWN);
  assert.equal(posCompatibility('verb', ['n', 'unc']), POS_UNKNOWN);
  assert.equal(posCompatibility('verb', ['v5k', 'unc']), POS_EXACT);
  assert.equal(classifyCodeFor('verb', 'unc'), 'wildcard');
});

test('noun/adverb/interjection classes exclude clean cross-class mismatches', () => {
  // Would fail if proper-noun-only or verb-only senses survived for nouns.
  assert.equal(posCompatibility('noun', ['n', 'adj-na']), POS_EXACT);
  assert.equal(posCompatibility('noun', ['adj-no']), POS_BROAD);
  assert.equal(posCompatibility('noun', ['pn']), POS_INCOMPATIBLE);
  assert.equal(posCompatibility('noun', ['v5k']), POS_INCOMPATIBLE);
  assert.equal(posCompatibility('noun', ['adv']), POS_BROAD);
  assert.equal(posCompatibility('noun', ['vs']), POS_BROAD);
  assert.equal(posCompatibility('noun', ['int']), POS_BROAD);
  assert.equal(posCompatibility('noun', ['ctr']), POS_BROAD);
  assert.equal(posCompatibility('noun', ['suf']), POS_BROAD);
  assert.equal(posCompatibility('noun', ['exp']), POS_BROAD);
  assert.equal(posCompatibility('adverb', ['adv-to']), POS_EXACT);
  assert.equal(posCompatibility('adverb', ['adj-i']), POS_INCOMPATIBLE);
  // Temporal/adverbial nouns (明日/朝/昨日: n-t) tagged adverbially must
  // keep: adverb-vs-noun is porous in both directions.
  assert.equal(posCompatibility('adverb', ['n-t']), POS_BROAD);
  assert.equal(posCompatibility('adverb', ['n']), POS_BROAD);
  assert.equal(posCompatibility('interjection', ['int']), POS_EXACT);
  // まあ adv/int variance: neither side may exclude the other.
  assert.equal(posCompatibility('interjection', ['adv']), POS_BROAD);
  assert.equal(posCompatibility('interjection', ['n']), POS_BROAD);
});

test('noun keeps adverbial senses broad: 何 must stay AMBIGUOUS, never vulgar-COMPATIBLE', () => {
  // Would fail if adv were a strike for nouns: JMdict 何/なに (senses pn×3,
  // n "penis", adv "(not) at all", int×3) would collapse to UNIQUE +
  // COMPATIBLE on the niche noun sense for 何も食べなかった, whose true
  // sense is adverbial. Live-data regression from the adversarial corpus.
  assert.equal(posCompatibility('noun', ['adv']), POS_BROAD);
  const senses = [
    { senseNo: 1, pos: ['pn'], glossEn: ['what'], stagk: [], stagr: [] },
    { senseNo: 2, pos: ['n'], glossEn: ['penis'], stagk: [], stagr: [] },
    { senseNo: 3, pos: ['adv'], glossEn: ['(not) at all'], stagk: [], stagr: [] },
    { senseNo: 4, pos: ['int'], glossEn: ['what?'], stagk: [], stagr: [] }
  ];
  const result = finalizeCandidate({
    candidate: candidate({ key: 'noun::何', canonical: '何', lemma: '何', pos: 'noun' }),
    identity: { strategy: 'ORTHOGRAPHIC', kind: 'keb', keys: [{ value: '何', normalized: '何' }], lemmaReading: 'なに' },
    cohortRows: [{ entryId: '1577100', surface: '何', normalized: '何', kind: 'keb' }],
    lookupTruncated: false,
    entries: new Map([['1577100', {
      senses,
      evaluationTruncated: false,
      forms: [{ surface: 'なに', normalized: 'なに', kind: 'reb', restr: [], isCommon: true, nokanji: false }],
      formsTruncated: false,
      posSummary: ['pn', 'n', 'adv', 'int'],
      isCommon: true
    }]]),
    inflectionType: null
  });
  assert.equal(result.matchStatus, MATCH.UNIQUE);
  assert.equal(result.interpretationStatus, INTERP.AMBIGUOUS);
  assert.equal(result.selectedSense, null);
  // pn excluded (names out of scope); n + adv + int all survive → ambiguity
  // preserved across genuinely possible readings, never collapsed.
  assert.deepEqual(result.compatibleSenses.map((sense) => sense.senseNo).sort(), [2, 3, 4]);
});

test('inflection mapping corroborates only; never vetoes', () => {
  // Would fail if an unmapped type excluded, or if a family mismatch
  // (一段 token vs v5 sense) became a veto — strengthening only.
  assert.equal(inflectionEvidence('一段', ['v1', 'vt']), 'INFLECTION_FAMILY_COMPATIBLE');
  assert.equal(inflectionEvidence('五段・カ行', ['v5k-s', 'vi']), 'INFLECTION_FAMILY_COMPATIBLE');
  assert.equal(inflectionEvidence('カ変', ['vk']), 'INFLECTION_FAMILY_COMPATIBLE');
  assert.equal(inflectionEvidence('サ変・スル', ['vs-i']), 'INFLECTION_FAMILY_COMPATIBLE');
  assert.equal(inflectionEvidence('一段', ['v5k']), null);
  assert.equal(inflectionEvidence('特殊・ザ行変格', ['v5k']), null);
  assert.equal(inflectionEvidence(null, ['v1']), null);
});

// --- H1/H2 reading applicability ------------------------------------------

test('H1 stagk keeps only spelling members; kana observations keep all', () => {
  // Would fail if あつい/熱い matched the 暑い-restricted sense (F3), or if
  // a kana observation lost senses to a spelling it never asserted.
  const senses = [
    { senseNo: 1, pos: ['adj-i'], glossEn: ['hot (weather)'], stagk: ['暑い'], stagr: [] },
    { senseNo: 2, pos: ['adj-i'], glossEn: ['hot (object)'], stagk: ['熱い'], stagr: [] }
  ];
  const kanji = evaluateSenses(
    candidate({ key: 'i-adjective::暑い', canonical: '暑い', lemma: '暑い', pos: 'i-adjective' }),
    { strategy: 'ORTHOGRAPHIC', kind: 'keb', keys: [{ value: '暑い', normalized: '暑い' }], lemmaReading: null },
    senses,
    { codes: new Set(), excludedBy: {} }
  );
  assert.deepEqual(kanji.surviving.map((sense) => sense.senseNo), [1]);
  assert.equal(kanji.excludedBy.STAGK_INCOMPATIBLE, 1);
  const kana = evaluateSenses(
    candidate({ key: 'i-adjective::あつい', canonical: 'あつい', lemma: 'あつい', pos: 'i-adjective' }),
    { strategy: 'READING_FALLBACK', kind: 'reb', keys: [{ value: 'あつい', normalized: 'あつい' }], lemmaReading: null },
    senses,
    { codes: new Set(), excludedBy: {} }
  );
  assert.equal(kana.surviving.length, 2);
});

test('H2 stagr respects safe lemma readings; absent reading keeps ambiguity', () => {
  // Would fail if 開く/ひらく evidence were ignored (F4), or if a missing
  // reading invented incompatibility out of nothing.
  const senses = [
    { senseNo: 1, pos: ['v5k', 'vt'], glossEn: ['to open (transitive)'], stagk: [], stagr: ['ひらく'] },
    { senseNo: 2, pos: ['v5k', 'vi'], glossEn: ['to open (intransitive)'], stagk: [], stagr: ['あく'] }
  ];
  const known = evaluateSenses(
    candidate({}),
    { strategy: 'ORTHOGRAPHIC', kind: 'keb', keys: [{ value: '開く', normalized: '開く' }], lemmaReading: 'ひらく' },
    senses,
    { codes: new Set(), excludedBy: {} }
  );
  assert.deepEqual(known.surviving.map((sense) => sense.senseNo), [1]);
  assert.equal(known.excludedBy.STAGR_INCOMPATIBLE, 1);
  const unknown = evaluateSenses(
    candidate({}),
    { strategy: 'ORTHOGRAPHIC', kind: 'keb', keys: [{ value: '開く', normalized: '開く' }], lemmaReading: null },
    senses,
    { codes: new Set(), excludedBy: {} }
  );
  assert.equal(unknown.surviving.length, 2);
});

test('H3/H4 shape orthographic readings; fallback claims only matched rows', () => {
  // Would fail if a nokanji reading were suggested for a kanji observation
  // (F5), if restr were ignored, or if あく observation suggested ひらく.
  const forms = [
    { surface: 'ひらく', normalized: 'ひらく', kind: 'reb', restr: [], isCommon: true, nokanji: false },
    { surface: 'あく', normalized: 'あく', kind: 'reb', restr: [], isCommon: true, nokanji: false },
    { surface: 'け', normalized: 'け', kind: 'reb', restr: [], isCommon: false, nokanji: true }
  ];
  const ortho = resolveReadings(
    { strategy: 'ORTHOGRAPHIC', kind: 'keb', keys: [{ value: '開く', normalized: '開く' }] },
    forms,
    []
  );
  assert.equal(ortho.suggested, null);
  assert.deepEqual(ortho.alternatives, ['ひらく', 'あく']);
  assert.equal(ortho.provenance, 'dictionary');
  assert.equal(ortho.restrictedOut.NOKANJI_INCOMPATIBLE, 1);
  const restricted = resolveReadings(
    { strategy: 'ORTHOGRAPHIC', kind: 'keb', keys: [{ value: '行く', normalized: '行く' }] },
    [{ surface: 'いく', normalized: 'いく', kind: 'reb', restr: ['逝く'], isCommon: false, nokanji: false }],
    []
  );
  assert.deepEqual(restricted.alternatives, []);
  assert.equal(restricted.restrictedOut.READING_FORM_RESTRICTED, 1);
  const fallback = resolveReadings(
    { strategy: 'READING_FALLBACK', kind: 'reb', keys: [{ value: 'あく', normalized: 'あく' }] },
    forms,
    [{ entryId: '1000004', surface: 'あく', normalized: 'あく', kind: 'reb' }]
  );
  assert.deepEqual(fallback.alternatives, ['あく']);
  const single = resolveReadings(
    { strategy: 'ORTHOGRAPHIC', kind: 'keb', keys: [{ value: '行く', normalized: '行く' }] },
    [{ surface: 'いく', normalized: 'いく', kind: 'reb', restr: [], isCommon: true, nokanji: false }],
    []
  );
  assert.equal(single.suggested, 'いく');
});

// --- two-axis finalization --------------------------------------------------

function finalized(overrides = {}) {
  return finalizeCandidate({
    candidate: candidate({ key: 'noun::学校', canonical: '学校', lemma: '学校', pos: 'noun' }),
    identity: { strategy: 'ORTHOGRAPHIC', kind: 'keb', keys: [{ value: '学校', normalized: '学校' }], lemmaReading: 'がっこう' },
    cohortRows: [{ entryId: '1000001', surface: '学校', normalized: '学校', kind: 'keb' }],
    lookupTruncated: false,
    entries: new Map([['1000001', {
      senses: [{ senseNo: 1, pos: ['n'], glossEn: ['school'], stagk: [], stagr: [] }],
      evaluationTruncated: false,
      forms: [
        { surface: '学校', normalized: '学校', kind: 'keb', restr: [], isCommon: true, nokanji: false },
        { surface: 'がっこう', normalized: 'がっこう', kind: 'reb', restr: [], isCommon: true, nokanji: false }
      ],
      formsTruncated: false,
      posSummary: ['n'],
      isCommon: true
    }]]),
    inflectionType: null,
    ...overrides
  });
}

test('F1 single entry single sense resolves UNIQUE + COMPATIBLE', () => {
  // Would fail if the happy path could not reach certainty at all.
  const result = finalized();
  assert.equal(result.matchStatus, MATCH.UNIQUE);
  assert.equal(result.selectedEntryId, '1000001');
  assert.equal(result.interpretationStatus, INTERP.COMPATIBLE);
  assert.deepEqual(result.selectedSense.glossEn, ['school']);
  assert.equal(result.itemReadings.suggested, 'がっこう');
  assert.ok(result.evidenceSummary.codes.includes('LEMMA_EXACT'));
});

test('UNIQUE entry with two senses stays AMBIGUOUS but keeps the reading (F2 core)', () => {
  // Would fail if sense multiplicity collapsed to one meaning, or if the
  // dictionary reading were withheld just because senses are ambiguous.
  const two = {
    senses: [
      { senseNo: 1, pos: ['v5k-s', 'vi'], glossEn: ['to go'], stagk: [], stagr: [] },
      { senseNo: 2, pos: ['v5k-s', 'vi'], glossEn: ['to proceed'], stagk: [], stagr: [] }
    ],
    evaluationTruncated: false,
    forms: [{ surface: 'いく', normalized: 'いく', kind: 'reb', restr: [], isCommon: true, nokanji: false }],
    formsTruncated: false,
    posSummary: ['v5k-s', 'vi'],
    isCommon: true
  };
  const result = finalizeCandidate({
    candidate: candidate({}),
    identity: identity(),
    cohortRows: [{ entryId: '1000006', surface: '行く', normalized: '行く', kind: 'keb' }],
    lookupTruncated: false,
    entries: new Map([['1000006', two]]),
    inflectionType: null
  });
  assert.equal(result.matchStatus, MATCH.UNIQUE);
  assert.equal(result.itemReadings.suggested, 'いく');
  assert.equal(result.interpretationStatus, INTERP.AMBIGUOUS);
  assert.equal(result.selectedSense, null);
  assert.equal(result.compatibleSenses.length, 2);
});

test('zero survivors is NO_MATCH with NOT_APPLICABLE interpretation', () => {
  // Would fail if an empty cohort were reported as ambiguous identity.
  const result = finalized({ cohortRows: [], entries: new Map() });
  assert.equal(result.matchStatus, MATCH.NO_MATCH);
  assert.equal(result.matchReason, 'no-compatible-entry');
  assert.equal(result.interpretationStatus, INTERP.NOT_APPLICABLE);
});

test('lookup truncation forbids UNIQUE even with a single survivor (F11)', () => {
  // Would fail if a 6th unseen row could still yield certainty — the exact
  // CA-A.2 race this sentinel exists to prevent.
  const result = finalized({ lookupTruncated: true });
  assert.equal(result.matchStatus, MATCH.MULTIPLE);
  assert.equal(result.matchReason, 'lookup-truncated');
  assert.equal(result.lookupTruncated, true);
  assert.equal(result.interpretationStatus, INTERP.AMBIGUOUS);
  assert.equal(result.selectedSense, null);
});

test('late sense #6 is discovered: evaluation precedes display truncation (F8)', () => {
  // Would fail if senses were display-truncated (LIMIT 3) BEFORE restriction
  // filtering — the surviving late sense would be cut off unseen.
  const senses = [];
  for (let senseNo = 1; senseNo <= 6; senseNo += 1) {
    senses.push({
      senseNo,
      pos: senseNo === 6 ? ['n'] : ['v5k'],
      glossEn: [`sense ${senseNo}`],
      stagk: [],
      stagr: []
    });
  }
  const result = finalizeCandidate({
    candidate: candidate({ key: 'noun::学校', canonical: '学校', lemma: '学校', pos: 'noun' }),
    identity: { strategy: 'ORTHOGRAPHIC', kind: 'keb', keys: [{ value: '学校', normalized: '学校' }], lemmaReading: null },
    cohortRows: [{ entryId: '9', surface: '学校', normalized: '学校', kind: 'keb' }],
    lookupTruncated: false,
    entries: new Map([['9', {
      senses,
      evaluationTruncated: false,
      forms: [],
      formsTruncated: false,
      posSummary: ['n'],
      isCommon: false
    }]]),
    inflectionType: null
  });
  assert.equal(result.matchStatus, MATCH.UNIQUE);
  assert.equal(result.interpretationStatus, INTERP.COMPATIBLE);
  assert.equal(result.selectedSense.senseNo, 6);
  assert.deepEqual(result.selectedSense.glossEn, ['sense 6']);
});

test('exact-64 fetch stays clean (F9); 65th row trips the valve and forbids COMPATIBLE (F10)', () => {
  // Would fail if exactly-64 tripped the sentinel, or if a tripped valve
  // still yielded COMPATIBLE. The row-counting itself is proven at the DB
  // layer; here the finalization honors the flag.
  const clean = finalized();
  assert.equal(clean.evaluationTruncated, false);
  assert.equal(clean.interpretationStatus, INTERP.COMPATIBLE);
  const tripped = finalizeCandidate({
    candidate: candidate({ key: 'noun::学校', canonical: '学校', lemma: '学校', pos: 'noun' }),
    identity: { strategy: 'ORTHOGRAPHIC', kind: 'keb', keys: [{ value: '学校', normalized: '学校' }], lemmaReading: null },
    cohortRows: [{ entryId: '9', surface: '学校', normalized: '学校', kind: 'keb' }],
    lookupTruncated: false,
    entries: new Map([['9', {
      senses: [{ senseNo: 1, pos: ['n'], glossEn: ['x'], stagk: [], stagr: [] }],
      evaluationTruncated: true,
      forms: [],
      formsTruncated: false,
      posSummary: ['n'],
      isCommon: false
    }]]),
    inflectionType: null
  });
  assert.equal(tripped.evaluationTruncated, true);
  assert.equal(tripped.interpretationStatus, INTERP.AMBIGUOUS);
  assert.equal(tripped.interpretationReason, 'evaluation-truncated');
  assert.equal(tripped.selectedSense, null);
});

test('single survivor beside an excluded-but-truncated entry stays MULTIPLE/AMBIGUOUS', () => {
  // Would fail if a hidden 65th-sense tail on a fully-excluded entry still
  // allowed UNIQUE/COMPATIBLE on the visible survivor — the tail may hide
  // a compatible sense that resurrects a second entry.
  const oneSense = (senseNo, pos, gloss) => ({ senseNo, pos, glossEn: [gloss], stagk: [], stagr: [] });
  const result = finalizeCandidate({
    candidate: candidate({ key: 'noun::学校', canonical: '学校', lemma: '学校', pos: 'noun' }),
    identity: { strategy: 'ORTHOGRAPHIC', kind: 'keb', keys: [{ value: '学校', normalized: '学校' }], lemmaReading: null },
    cohortRows: [
      { entryId: '1', surface: '学校', normalized: '学校', kind: 'keb' },
      { entryId: '2', surface: '学校', normalized: '学校', kind: 'keb' }
    ],
    lookupTruncated: false,
    entries: new Map([
      ['1', {
        senses: [oneSense(1, ['n'], 'school')],
        evaluationTruncated: false, forms: [], formsTruncated: false, posSummary: ['n'], isCommon: true
      }],
      ['2', {
        senses: [oneSense(1, ['v5k'], 'to school (verb?)')],
        evaluationTruncated: true, forms: [], formsTruncated: false, posSummary: ['v5k'], isCommon: false
      }]
    ]),
    inflectionType: null
  });
  assert.equal(result.matchStatus, MATCH.MULTIPLE);
  assert.equal(result.matchReason, 'evaluation-truncated');
  assert.equal(result.evaluationTruncated, true);
  assert.equal(result.interpretationStatus, INTERP.AMBIGUOUS);
  assert.equal(result.selectedSense, null);
});

test('unevaluated tail with zero evaluated survivors refuses NO_MATCH', () => {
  // Would fail if a tripped valve with all-evaluated-senses-excluded claimed
  // "nothing compatible remains" — the unevaluated tail may hide a match.
  const result = finalizeCandidate({
    candidate: candidate({ key: 'noun::丙', canonical: '丙', lemma: '丙', pos: 'noun' }),
    identity: { strategy: 'ORTHOGRAPHIC', kind: 'keb', keys: [{ value: '丙', normalized: '丙' }], lemmaReading: null },
    cohortRows: [{ entryId: '9', surface: '丙', normalized: '丙', kind: 'keb' }],
    lookupTruncated: false,
    entries: new Map([['9', {
      senses: [{ senseNo: 1, pos: ['v5k'], glossEn: ['x'], stagk: [], stagr: [] }],
      evaluationTruncated: true,
      forms: [],
      formsTruncated: false,
      posSummary: ['v5k'],
      isCommon: false
    }]]),
    inflectionType: null
  });
  assert.equal(result.matchStatus, MATCH.MULTIPLE);
  assert.equal(result.matchReason, 'evaluation-truncated');
  assert.equal(result.evaluationTruncated, true);
  assert.equal(result.interpretationStatus, INTERP.AMBIGUOUS);
});

test('unevaluated cohort is MULTIPLE + truncated, never NO_MATCH', () => {
  // Would fail if Q2-budget exhaustion were misreported as "no match".
  const result = finalizeCandidate({
    candidate: candidate({}), identity: identity(),
    cohortRows: [{ entryId: '1', surface: 'x', normalized: 'x', kind: 'keb' }],
    lookupTruncated: true, entries: new Map(), unevaluated: true, inflectionType: null
  });
  assert.equal(result.matchStatus, MATCH.MULTIPLE);
  assert.equal(result.lookupTruncated, true);
  assert.equal(result.interpretationStatus, INTERP.AMBIGUOUS);
});

test('glossless surviving sense cannot be COMPATIBLE', () => {
  // Would fail if malformed reference data produced a confident empty meaning.
  const result = finalizeCandidate({
    candidate: candidate({ key: 'noun::学校', canonical: '学校', lemma: '学校', pos: 'noun' }),
    identity: { strategy: 'ORTHOGRAPHIC', kind: 'keb', keys: [{ value: '学校', normalized: '学校' }], lemmaReading: null },
    cohortRows: [{ entryId: '1', surface: '学校', normalized: '学校', kind: 'keb' }],
    lookupTruncated: false,
    entries: new Map([['1', {
      senses: [{ senseNo: 1, pos: ['n'], glossEn: [], stagk: [], stagr: [] }],
      evaluationTruncated: false, forms: [], formsTruncated: false, posSummary: ['n'], isCommon: false
    }]]),
    inflectionType: null
  });
  assert.equal(result.interpretationStatus, INTERP.UNAVAILABLE);
  assert.equal(result.interpretationReason, 'sense-data-invalid');
});

// --- evidence + diet ----------------------------------------------------------

test('status sets are closed: no LIKELY, no scores on the wire', () => {
  // Would fail if any code path emitted the removed confidence gate.
  assert.ok(!MATCH_STATUSES.has('LIKELY'));
  assert.ok(!INTERPRETATION_STATUSES.has('LIKELY'));
  assert.deepEqual([...MATCH_STATUSES].sort(), ['MULTIPLE', 'NO_MATCH', 'UNAVAILABLE', 'UNIQUE', 'UNSUPPORTED']);
  assert.deepEqual([...INTERPRETATION_STATUSES].sort(), ['AMBIGUOUS', 'COMPATIBLE', 'NOT_APPLICABLE', 'UNAVAILABLE']);
  const block = buildBlock({ status: 'ok', reason: null, dictionary: null, items: [], warnings: [], retryable: false, durationMs: 1 });
  assert.ok(!JSON.stringify(block).toLowerCase().includes('likely'));
  assert.ok(!JSON.stringify(block).includes('confidence'));
});

test('diet caps entries, senses, glosses and never leaks entry docs', () => {
  // Would fail if CA-B3 received unbounded docs or a 200-form entry dump.
  const big = finalized();
  big.survivingEntries[0].allForms = Array.from({ length: 30 }, (_, index) => ({
    surface: `形${index}`, normalized: `形${index}`, kind: index % 2 ? 'reb' : 'keb', restr: [], isCommon: false, nokanji: false
  }));
  const item = buildItem(big);
  assert.ok(item.dictionaryMatch.entries[0].kanji.length <= 10);
  assert.ok(item.dictionaryMatch.entries[0].kana.length <= 10);
  assert.ok(!('doc' in item.dictionaryMatch.entries[0]));
  assert.ok(item.interpretation.compatibleSenses.length <= DISPLAY_MAX_SENSES);
  for (const sense of item.interpretation.compatibleSenses) {
    assert.ok(sense.glosses.length <= DISPLAY_MAX_GLOSSES);
  }
});

test('diet enforces every display cap with totals retained', () => {
  // Would fail if DISPLAY_MAX_ENTRIES grew, the sense/gloss slices were
  // dropped, or kanjiCount/kanaCount stopped reporting true totals.
  const entries = [];
  for (let entry = 1; entry <= 6; entry += 1) {
    const senses = [];
    for (let senseNo = 1; senseNo <= 4; senseNo += 1) {
      senses.push({
        senseNo,
        pos: ['n'],
        glossEn: [`g${senseNo}a`, `g${senseNo}b`, `g${senseNo}c`, `g${senseNo}d`, `g${senseNo}e`],
        stagk: [],
        stagr: []
      });
    }
    entries.push({
      entryId: String(entry),
      posSummary: ['n'],
      isCommon: entry === 1,
      senses,
      evaluationTruncated: false,
      formsTruncated: false,
      matchedForms: [{ surface: `語${entry}` }],
      allForms: [{ surface: `語${entry}`, kind: 'keb' }],
      readings: { suggested: null, alternatives: [`よみ${entry}a`, `よみ${entry}b`, `よみ${entry}c`, `よみ${entry}d`, `よみ${entry}e`, `よみ${entry}f`], provenance: 'dictionary' }
    });
  }
  const result = {
    candidateKey: 'noun::語',
    canonical: '語',
    matchStatus: MATCH.MULTIPLE,
    matchReason: 'multiple-compatible-entries',
    identityStrategy: 'ORTHOGRAPHIC',
    lookupTruncated: false,
    evaluationTruncated: false,
    selectedEntryId: null,
    survivingEntries: entries,
    itemReadings: { suggested: null, alternatives: [], provenance: null },
    interpretationStatus: INTERP.AMBIGUOUS,
    interpretationReason: 'multiple-compatible-entries',
    selectedSense: null,
    compatibleSenses: entries.flatMap((entry) => entry.senses.map((sense) => ({ entryId: entry.entryId, ...sense }))),
    evidenceSummary: { codes: [], excludedBy: {} }
  };
  const item = buildItem(result);
  assert.equal(item.dictionaryMatch.entries.length, DISPLAY_MAX_ENTRIES);
  assert.equal(item.dictionaryMatch.entryCount, 6);
  assert.equal(item.interpretation.compatibleSenses.length, DISPLAY_MAX_SENSES);
  assert.equal(item.interpretation.remainingCount, 6 * 4 - DISPLAY_MAX_SENSES);
  for (const sense of item.interpretation.compatibleSenses) {
    assert.equal(sense.glosses.length, DISPLAY_MAX_GLOSSES);
    assert.equal(sense.glossCount, 5);
  }
});

test('payload cap trims display only and flags truncated:true', () => {
  // Would fail if an oversized block shipped raw (>100 KB) or if trimming
  // rewrote statuses (presentation-only rule).
  const items = [];
  for (let index = 0; index < 40; index += 1) {
    const result = finalized({ candidate: candidate({ key: `noun::語${index}`, canonical: `語${index}`, lemma: `語${index}`, pos: 'noun' }) });
    items.push(buildItem(result));
  }
  for (const item of items) {
    item.dictionaryMatch.entries[0].kanji = Array.from({ length: 200 }, (_, i) => `漢字表記その${i}番目の長い語彙`);
  }
  const before = items.map((item) => ({
    match: item.dictionaryMatch.status,
    reason: item.dictionaryMatch.reason,
    selected: item.dictionaryMatch.selectedEntryId,
    interp: item.interpretation.status,
    sense: item.interpretation.selectedSense
  }));
  const block = buildBlock({ status: 'ok', reason: null, dictionary: null, items, warnings: [], retryable: false, durationMs: 5 });
  assert.ok(Buffer.byteLength(JSON.stringify(block), 'utf8') <= CONTEXT_PAYLOAD_MAX_BYTES);
  assert.equal(block.truncated, true);
  // Status invariance: trimming must not rewrite a single semantic field —
  // and must preserve items (surface inventories trim first, wipe last).
  assert.equal(block.items.length, before.length);
  const after = block.items.map((item) => ({
    match: item.dictionaryMatch.status,
    reason: item.dictionaryMatch.reason,
    selected: item.dictionaryMatch.selectedEntryId,
    interp: item.interpretation.status,
    sense: item.interpretation.selectedSense
  }));
  assert.deepEqual(after, before);
  for (const item of block.items) {
    assert.ok(MATCH_STATUSES.has(item.dictionaryMatch.status));
    assert.ok(INTERPRETATION_STATUSES.has(item.interpretation.status));
  }
});

test('dietEntry exposes counts alongside capped surfaces', () => {
  const entry = dietEntry({
    entryId: '1',
    posSummary: ['n'],
    isCommon: 1,
    matchedForms: [{ surface: '学校' }],
    allForms: [
      { surface: '学校', kind: 'keb' },
      { surface: 'がっこう', kind: 'reb' }
    ]
  });
  assert.deepEqual(entry.kanji, ['学校']);
  assert.deepEqual(entry.kana, ['がっこう']);
  assert.equal(entry.isCommon, true);
  assert.equal(entry.kanjiCount, 1);
  assert.equal(entry.kanaCount, 1);
  assert.deepEqual(entry.matchedSurfaces, ['学校']);
  // Totals survive capping: 15 keb cap to 10 surfaces but count 15.
  const many = dietEntry({
    entryId: '2',
    posSummary: [],
    isCommon: 0,
    matchedForms: [],
    allForms: Array.from({ length: 20 }, (_, index) => ({
      surface: index < 15 ? `漢${index}` : `か${index}`,
      kind: index < 15 ? 'keb' : 'reb'
    }))
  });
  assert.equal(many.kanji.length, 10);
  assert.equal(many.kanjiCount, 15);
  assert.equal(many.kana.length, 5);
  assert.equal(many.kanaCount, 5);
});

test('lexical-required and generic unavailable blocks carry stable reasons', () => {
  const required = lexicalRequiredBlock();
  assert.equal(required.status, 'unavailable');
  assert.equal(required.reason, 'lexical-required');
  assert.equal(required.retryable, false);
  const failed = unavailableBlock('reference-query-failed', true);
  assert.equal(failed.reason, 'reference-query-failed');
  assert.equal(failed.retryable, true);
  assert.deepEqual(failed.summary.dictionary, { UNIQUE: 0, MULTIPLE: 0, NO_MATCH: 0, UNSUPPORTED: 0, UNAVAILABLE: 0 });
});

test('candidate cap constant matches the frozen 30-request bound', () => {
  assert.equal(CONTEXT_MAX_CANDIDATES, 30);
});

test('built SQL placeholder counts match params (adapter ?->$N safety)', () => {
  // Would fail if a builder emitted a different number of `?` than params
  // (the runtime adapter rewrites positionally — a mismatch silently binds
  // the wrong value). Also freezes adapter-rewrite safety: no LIKE/CONCAT
  // that convertSql would transform under our feet.
  const { buildQ1, buildQ2Senses, buildQ2Forms } = require('../src/services/contextReference');
  const shapes = [
    buildQ1([{ candidateIdx: 0, normalized: '学校', kind: 'keb' }]),
    buildQ1(Array.from({ length: 120 }, (_, index) => ({ candidateIdx: index, normalized: `語${index}`, kind: index % 2 ? 'reb' : 'keb' }))),
    buildQ2Senses('7', ['1000001']),
    buildQ2Senses('7', Array.from({ length: 150 }, (_, index) => String(1000000 + index))),
    buildQ2Forms('7', ['1000001'])
  ];
  for (const built of shapes) {
    const marks = (built.sql.match(/\?/g) || []).length;
    assert.equal(marks, built.params.length, `placeholder/param mismatch in ${built.sql.slice(0, 60)}`);
    assert.ok(!/\sLIKE\s/i.test(built.sql), 'LIKE would be rewritten by the adapter');
    assert.ok(!built.sql.includes('CONCAT('), 'CONCAT would be rewritten by the adapter');
  }
  // Absolute shapes (not just self-consistency): a dropped kind column with
  // freshly-consistent params would still fail these counts.
  const reference = require('../src/services/contextReference');
  assert.equal(reference.buildQ1(Array.from({ length: 120 }, (_, index) => ({ candidateIdx: index, normalized: 'x', kind: 'keb' }))).params.length, 360);
  assert.equal(reference.buildQ2Senses('7', ['1', '2']).params.length, 3);
  assert.equal(reference.buildQ2Forms('7', ['1', '2']).params.length, 3);
  assert.equal(reference.Q1_USABLE_PER_KEY, 5);
  assert.equal(reference.Q1_PER_KEY_LIMIT, 6);
  assert.equal(reference.Q2_SENSE_FETCH, 65);
  assert.throws(() => reference.buildQ1([]), /at least one key/);
  assert.throws(() => reference.buildQ1(Array.from({ length: 121 }, (_, index) => ({ candidateIdx: index, normalized: 'x', kind: 'keb' }))), /cap 120/);
  assert.throws(() => reference.buildQ2Senses('7', []), /at least one entry/);
  assert.throws(() => reference.buildQ2Senses('7', Array.from({ length: 151 }, (_, index) => String(index))), /cap 150/);
});

test('unsupported candidates resolve without any database query', async () => {
  // Would fail if proper nouns/particles reached Q1 (service must not need
  // a pool at all when nothing is eligible — zero dictionary assertion).
  const { resolveContext } = require('../src/services/contextService');
  let queries = 0;
  const pool = {
    execute: async () => {
      queries += 1;
      return [[]];
    }
  };
  const block = await resolveContext({
    pool,
    candidates: [
      { key: 'proper-noun::田中', canonical: '田中', lemma: null, pos: 'proper-noun', lemmaReading: null, surfaceReading: null, observed: [] },
      { key: 'particle::は', canonical: 'は', lemma: 'は', pos: 'particle', lemmaReading: null, surfaceReading: null, observed: [] }
    ],
    tokens: []
  });
  assert.equal(queries, 0);
  assert.equal(block.status, 'ok');
  assert.equal(block.dictionary, null);
  assert.deepEqual(block.items.map((item) => item.dictionaryMatch.status), ['UNSUPPORTED', 'UNSUPPORTED']);
  assert.deepEqual(block.items.map((item) => item.interpretation.status), ['NOT_APPLICABLE', 'NOT_APPLICABLE']);
  assert.deepEqual(block.summary.dictionary, { UNIQUE: 0, MULTIPLE: 0, NO_MATCH: 0, UNSUPPORTED: 2, UNAVAILABLE: 0 });
});

test('resolveContext enforces the 30-candidate cap with an honest warning', async () => {
  // Would fail if the slice/warning were deleted: 35 candidates would all
  // resolve (request amplification) with no disclosure.
  const { resolveContext } = require('../src/services/contextService');
  const calls = [];
  const pool = {
    execute: async () => {
      calls.push(1);
      // Pin present, zero matches: cohorts stay empty, items go NO_MATCH.
      return [[{
        source_id: '7', source_name: 'JMdict', converter_version: '3.6.2', file_date: '2026-08-31',
        candidate_idx: 0, key_normalized: 'x', key_kind: 'keb', entry_id: null,
        surface: null, form_normalized: null, form_kind: null, is_common: 0, nokanji: 0, restr: []
      }]];
    }
  };
  const candidates = Array.from({ length: 35 }, (_, index) => ({
    key: `noun::語${index}`, canonical: `語${index}`, lemma: `語${index}`, pos: 'noun',
    lemmaReading: null, surfaceReading: null, observed: []
  }));
  const block = await resolveContext({ pool, candidates, tokens: [] });
  assert.equal(block.items.length, 30);
  assert.ok(block.warnings.includes('candidate-cap-reached'));
  assert.equal(block.status, 'partial');
  assert.ok(calls.length <= 3);
});

test('H2 applies symmetrically: a wrong parser reading narrows to the other sense (pinned frozen risk)', () => {
  // Would fail if H2 were dropped or made asymmetric. Documents the accepted
  // frozen risk explicitly: H2 trusts the IPADIC dictionary-form reading, so
  // a parser misreading propagates. Absent reading evidence (null) always
  // keeps both senses — unknown never excludes.
  const senses = [
    { senseNo: 1, pos: ['v5k', 'vt'], glossEn: ['to open (transitive)'], stagk: [], stagr: ['ひらく'] },
    { senseNo: 2, pos: ['v5k', 'vi'], glossEn: ['to open (intransitive)'], stagk: [], stagr: ['あく'] }
  ];
  const bag = () => ({ codes: new Set(), excludedBy: {} });
  const base = { strategy: 'ORTHOGRAPHIC', kind: 'keb', keys: [{ value: '開く', normalized: '開く' }] };
  const wrong = evaluateSenses(candidate({}), { ...base, lemmaReading: 'あく' }, senses, bag());
  assert.deepEqual(wrong.surviving.map((sense) => sense.senseNo), [2]);
  const right = evaluateSenses(candidate({}), { ...base, lemmaReading: 'ひらく' }, senses, bag());
  assert.deepEqual(right.surviving.map((sense) => sense.senseNo), [1]);
  const absent = evaluateSenses(candidate({}), { ...base, lemmaReading: null }, senses, bag());
  assert.equal(absent.surviving.length, 2);
});

test('resolveContext never throws, even with a hostile pool', async () => {
  // Would fail if any internal bug 500'd the Analyzer instead of degrading.
  const { resolveContext } = require('../src/services/contextService');
  const block = await resolveContext({
    pool: { execute: async () => { throw new Error('down'); } },
    candidates: [{ key: 'noun::学校', canonical: '学校', lemma: '学校', pos: 'noun', lemmaReading: null, surfaceReading: null, observed: [] }],
    tokens: []
  });
  assert.equal(block.status, 'unavailable');
  assert.equal(block.reason, 'reference-query-failed');
  const empty = await resolveContext({ pool: null, candidates: [], tokens: [] });
  assert.equal(empty.status, 'ok');
  assert.deepEqual(empty.items, []);
  assert.equal(empty.dictionary, null);
});
