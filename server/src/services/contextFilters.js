// CA-B2 — deterministic compatibility filtering (H1–H6), dictionary reading
// resolution, and frozen two-axis finalization. Pure: no I/O, no SQL.
//
// Hard constraints eliminate entry/sense combinations; no weak evidence may
// override a hard veto. Commonness, sense order and priority NEVER promote
// AMBIGUOUS → COMPATIBLE — they are display order only (contextResponse).
//
// H1 STAGK: sense.stagk non-empty → a Han identity key must be a member.
//   Kana observations assert no spelling → stagk cannot exclude them.
// H2 STAGR: sense.stagr non-empty AND a safe reading known → the reading
//   must be a member. Safe reading = parser lemmaReading ONLY (dictionary
//   form observed; occurrence fragments such as いった for 行った are never
//   used — comparing them would manufacture false exclusions). No reading
//   evidence → keep (unknown preserves ambiguity, never excludes).
// H3 RE_RESTR: a reb form with non-empty restr applies only to those keb.
//   Applies at reading resolution, and only for orthographic observations
//   (kana observations assert no spelling).
// H4 NOKANJI: a nokanji reading can never be claimed for a Han-bearing
//   observation; kana observations may use it.
// H5 POS: exclusion ONLY via posCompatibility() === INCOMPATIBLE. 'unc',
//   unrecognized codes and empty code lists are wildcards (never exclude).
// H6 IDENTITY FAILURE: structural — entries outside the Q1 cohort are never
//   considered; homophones never enter an orthographic cohort (kind = keb).
//
// Reading certainty is independent from sense certainty: UNIQUE +
// exactly-one-applicable-reading yields a suggested dictionary reading even
// when interpretation stays AMBIGUOUS. Parser readings are never mutated;
// dictionary readings carry provenance 'dictionary'.

const { normalizeJmdictForm, hasHanCharacter } = require('./jmdictReference');
const { POS_EXACT, POS_BROAD, posCompatibility, inflectionEvidence } = require('./contextPos');

const MATCH = {
  UNIQUE: 'UNIQUE',
  MULTIPLE: 'MULTIPLE',
  NO_MATCH: 'NO_MATCH',
  UNSUPPORTED: 'UNSUPPORTED',
  UNAVAILABLE: 'UNAVAILABLE'
};
const INTERP = {
  COMPATIBLE: 'COMPATIBLE',
  AMBIGUOUS: 'AMBIGUOUS',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  UNAVAILABLE: 'UNAVAILABLE'
};

const EVIDENCE_ORDER = [
  'LEMMA_EXACT',
  'ORTHOGRAPHIC_EXACT',
  'READING_COMPATIBLE',
  'READING_RESTRICTED',
  'POS_EXACT',
  'POS_BROAD',
  'INFLECTION_FAMILY_COMPATIBLE'
];

function normalizedSet(values) {
  const out = new Set();
  for (const value of values || []) {
    if (typeof value !== 'string' || value === '') continue;
    try {
      out.add(normalizeJmdictForm(value));
    } catch (_) {
      // Unnormalizable target: ignore for membership (import validation
      // already guarantees stored targets are sane).
    }
  }
  return out;
}

// Han identity keys of the candidate (raw values) for H1 membership.
function hanKeys(identity) {
  return (identity.keys || []).map((key) => key.value).filter((value) => hasHanCharacter(value));
}

// Normalized safe lemma reading for H2 membership, or null.
function safeReading(identity) {
  if (!identity || typeof identity.lemmaReading !== 'string' || identity.lemmaReading === '') return null;
  try {
    return normalizeJmdictForm(identity.lemmaReading);
  } catch (_) {
    return null;
  }
}

// Evaluate every sense of one entry. Returns { surviving, excludedBy }.
// excludedBy counts veto codes across this entry's senses.
function evaluateSenses(candidate, identity, entrySenses, evidence) {
  const han = hanKeys(identity);
  const reading = safeReading(identity);
  const surviving = [];
  const excludedBy = {};
  const veto = (code) => {
    excludedBy[code] = (excludedBy[code] || 0) + 1;
    evidence.excludedBy[code] = (evidence.excludedBy[code] || 0) + 1;
  };
  for (const sense of entrySenses) {
    // H1 — stagk needs a Han identity member; kana observations keep.
    // Membership is compared on normalized keys (same fold as H2) so an
    // NFKC/katakana variant can never manufacture a false exclusion.
    if (Array.isArray(sense.stagk) && sense.stagk.length && han.length) {
      const targets = normalizedSet(sense.stagk);
      let member = false;
      for (const key of han) {
        try {
          if (targets.has(normalizeJmdictForm(key))) {
            member = true;
            break;
          }
        } catch (_) {
          // Unnormalizable key: ignore for membership (importer keys are
          // normalized, so this path is defensive only).
        }
      }
      if (!member) {
        veto('STAGK_INCOMPATIBLE');
        continue;
      }
    }
    // H2 — stagr needs the safe reading; absent reading evidence keeps.
    if (Array.isArray(sense.stagr) && sense.stagr.length && reading !== null) {
      if (!normalizedSet(sense.stagr).has(reading)) {
        veto('STAGR_INCOMPATIBLE');
        continue;
      }
    }
    // H5 — POS exclusion only on proven incompatibility.
    const posVerdict = posCompatibility(candidate.pos, sense.pos);
    if (posVerdict === POS_EXACT || posVerdict === POS_BROAD) {
      evidence.codes.add(posVerdict === POS_EXACT ? 'POS_EXACT' : 'POS_BROAD');
    } else if (posVerdict === 'INCOMPATIBLE') {
      veto('POS_INCOMPATIBLE');
      continue;
    }
    const inflectionCode = inflectionEvidence(evidence.inflectionType, sense.pos);
    if (inflectionCode) evidence.codes.add(inflectionCode);
    surviving.push({ ...sense, posVerdict });
  }
  return { surviving, excludedBy };
}

// Resolve applicable dictionary readings for one surviving entry.
// ORTHOGRAPHIC: every reb form passing H3 (restr ⊇ observed keb) and H4
// (nokanji excluded for Han observations). READING_FALLBACK: exactly the
// matched reb rows (the observation IS that reading; sibling readings of
// the entry are not claimed).
function resolveReadings(identity, entryForms, matchedRows) {
  const restrictedOut = { READING_FORM_RESTRICTED: 0, NOKANJI_INCOMPATIBLE: 0 };
  let applicable;
  if (identity.strategy === 'ORTHOGRAPHIC') {
    const observedKeb = normalizedSet(hanKeys(identity));
    applicable = [];
    for (const form of entryForms) {
      if (form.kind !== 'reb') continue;
      if (Array.isArray(form.restr) && form.restr.length) {
        // H3 — the reading applies only to its restr spellings. Compared
        // normalized (same fold as H1/H2) for consistency.
        const targets = normalizedSet(form.restr);
        let hit = false;
        for (const keb of observedKeb) {
          if (targets.has(keb)) {
            hit = true;
            break;
          }
        }
        if (!hit) {
          restrictedOut.READING_FORM_RESTRICTED += 1;
          continue;
        }
      }
      if (form.nokanji === true) {
        restrictedOut.NOKANJI_INCOMPATIBLE += 1;
        continue;
      }
      applicable.push(form.surface);
    }
  } else {
    applicable = [];
    for (const row of matchedRows) {
      if (row.kind !== 'reb') continue;
      if (!applicable.includes(row.surface)) applicable.push(row.surface);
    }
  }
  const distinct = [...new Set(applicable)];
  const suggested = distinct.length === 1 ? distinct[0] : null;
  return { suggested, alternatives: distinct.slice(0, 5), provenance: distinct.length ? 'dictionary' : null, restrictedOut };
}

// Finalize one candidate. Input bundles everything the service resolved:
// { candidate, identity, cohortRows, lookupTruncated, entries: Map<entryId,
//   { senses, evaluationTruncated, formsTruncated, posSummary, isCommon }> }.
// Output is the full evaluated (pre-display-cap) result.
function finalizeCandidate(input) {
  const { candidate, identity, cohortRows, lookupTruncated } = input;
  // Cohort present but Q2 budget exhausted: matches exist and are simply
  // unevaluated — MULTIPLE + truncated, never NO_MATCH (which would assert
  // that a completed lookup found nothing compatible).
  if (input.unevaluated === true) {
    return {
      candidateKey: candidate.key,
      canonical: candidate.canonical,
      matchStatus: MATCH.MULTIPLE,
      matchReason: 'lookup-truncated',
      identityStrategy: identity.strategy,
      lookupTruncated: true,
      evaluationTruncated: false,
      selectedEntryId: null,
      survivingEntries: [],
      itemReadings: { suggested: null, alternatives: [], provenance: null },
      interpretationStatus: INTERP.AMBIGUOUS,
      interpretationReason: 'lookup-truncated',
      selectedSense: null,
      compatibleSenses: [],
      evidenceSummary: { codes: [], excludedBy: {} }
    };
  }
  const evidence = { codes: new Set(), excludedBy: {} };
  const evidenceBag = { codes: evidence.codes, excludedBy: evidence.excludedBy, inflectionType: input.inflectionType || null };

  // Identity provenance evidence from the cohort match itself.
  const matchedLemma = (cohortRows || []).some((row) => {
    try {
      return candidate.lemma && row.normalized === normalizeJmdictForm(candidate.lemma);
    } catch (_) {
      return false;
    }
  });
  if (matchedLemma) evidence.codes.add('LEMMA_EXACT');
  if (identity.strategy === 'ORTHOGRAPHIC' && (cohortRows || []).some((row) => row.kind === 'keb')) {
    evidence.codes.add('ORTHOGRAPHIC_EXACT');
  }
  if (identity.strategy === 'READING_FALLBACK' && (cohortRows || []).some((row) => row.kind === 'reb')) {
    evidence.codes.add('READING_COMPATIBLE');
  }

  // Evaluate every entry: all fetched senses first, filters second.
  // Truncation is tracked across ALL entries (even fully-excluded ones): an
  // unevaluated tail may hide a compatible sense, so zero evaluated
  // survivors + a tripped valve is MULTIPLE + truncated — never NO_MATCH
  // (which asserts a completed lookup found nothing).
  const survivingEntries = [];
  let anyEvaluationTruncated = false;
  for (const [entryId, data] of input.entries) {
    if (data.evaluationTruncated === true) anyEvaluationTruncated = true;
    const { surviving } = evaluateSenses(candidate, identity, data.senses, evidenceBag);
    if (!surviving.length) continue;
    const matchedForEntry = (cohortRows || []).filter((row) => row.entryId === entryId);
    const readings = resolveReadings(identity, data.forms, matchedForEntry);
    const restrictedTotal = readings.restrictedOut.READING_FORM_RESTRICTED + readings.restrictedOut.NOKANJI_INCOMPATIBLE;
    if (restrictedTotal > 0) {
      // Restriction evidence shaped the answer: count the vetoes, and mark
      // the surviving suggestion as restriction-tested when one remains.
      for (const [code, count] of Object.entries(readings.restrictedOut)) {
        if (count > 0) evidence.excludedBy[code] = (evidence.excludedBy[code] || 0) + count;
      }
      if (readings.suggested) evidence.codes.add('READING_RESTRICTED');
    }
    survivingEntries.push({
      entryId,
      posSummary: data.posSummary,
      isCommon: data.isCommon,
      senses: surviving,
      evaluationTruncated: data.evaluationTruncated === true,
      formsTruncated: data.formsTruncated === true,
      matchedForms: matchedForEntry,
      allForms: data.forms,
      readings
    });
  }
  // Deterministic order: common entries first, then entry id.
  survivingEntries.sort((a, b) => Number(b.isCommon) - Number(a.isCommon) || Number(a.entryId) - Number(b.entryId));

  const anyFormsTruncated = survivingEntries.some((entry) => entry.formsTruncated);
  const truncated = lookupTruncated === true || anyFormsTruncated;
  // A tripped valve on a FULLY-EXCLUDED entry still hides a tail that may
  // contain a compatible sense (which would resurrect a second entry): it
  // forbids UNIQUE and COMPATIBLE exactly like visible truncation does.
  const survivorIds = new Set(survivingEntries.map((entry) => entry.entryId));
  const excludedTruncated = [...input.entries].some(
    ([entryId, data]) => data.evaluationTruncated === true && !survivorIds.has(entryId)
  );

  let matchStatus;
  let matchReason;
  let selectedEntryId = null;
  if (!survivingEntries.length && !anyEvaluationTruncated) {
    matchStatus = MATCH.NO_MATCH;
    matchReason = 'no-compatible-entry';
  } else if (!survivingEntries.length) {
    matchStatus = MATCH.MULTIPLE;
    matchReason = 'evaluation-truncated';
  } else if (survivingEntries.length === 1 && !truncated && !excludedTruncated) {
    matchStatus = MATCH.UNIQUE;
    matchReason = 'single-compatible-entry';
    selectedEntryId = survivingEntries[0].entryId;
  } else {
    matchStatus = MATCH.MULTIPLE;
    matchReason = truncated
      ? 'lookup-truncated'
      : (excludedTruncated ? 'evaluation-truncated' : 'multiple-compatible-entries');
    if (survivingEntries.length === 1) selectedEntryId = survivingEntries[0].entryId;
  }

  // Readings at item level come from the selected entry when UNIQUE,
  // otherwise no authoritative reading is claimed.
  let itemReadings = { suggested: null, alternatives: [], provenance: null };
  if (matchStatus === MATCH.UNIQUE) {
    const entry = survivingEntries[0];
    itemReadings = { suggested: entry.readings.suggested, alternatives: entry.readings.alternatives, provenance: entry.readings.provenance };
    const lemmaReading = safeReading(identity);
    if (lemmaReading && entry.readings.alternatives.some((surface) => {
      try {
        return normalizeJmdictForm(surface) === lemmaReading;
      } catch (_) {
        return false;
      }
    })) {
      evidence.codes.add('READING_COMPATIBLE');
    }
  }

  // interpretation resolves strictly AFTER dictionaryMatch.
  let interpretationStatus;
  let interpretationReason;
  let selectedSense = null;
  let compatibleSenses = [];
  const finalEvalTruncated = anyEvaluationTruncated || survivingEntries.some((entry) => entry.evaluationTruncated);
  if (matchStatus === MATCH.NO_MATCH) {
    interpretationStatus = INTERP.NOT_APPLICABLE;
    interpretationReason = 'nothing-to-interpret';
  } else if (matchStatus === MATCH.MULTIPLE) {
    interpretationStatus = INTERP.AMBIGUOUS;
    interpretationReason = truncated
      ? 'lookup-truncated'
      : (finalEvalTruncated ? 'evaluation-truncated' : 'multiple-compatible-entries');
    for (const entry of survivingEntries) {
      for (const sense of entry.senses) {
        compatibleSenses.push({ entryId: entry.entryId, senseNo: sense.senseNo, pos: sense.pos, glossEn: sense.glossEn });
      }
    }
  } else {
    const entry = survivingEntries[0];
    const valid = entry.senses.filter((sense) => Array.isArray(sense.glossEn) && sense.glossEn.length > 0);
    if (valid.length !== entry.senses.length) {
      interpretationStatus = INTERP.UNAVAILABLE;
      interpretationReason = 'sense-data-invalid';
    } else if (entry.senses.length === 1 && !truncated && !entry.evaluationTruncated && !excludedTruncated) {
      interpretationStatus = INTERP.COMPATIBLE;
      interpretationReason = 'single-compatible-sense';
      const sense = entry.senses[0];
      selectedSense = { entryId: entry.entryId, senseNo: sense.senseNo, pos: sense.pos, glossEn: sense.glossEn };
      compatibleSenses = [{ entryId: entry.entryId, senseNo: sense.senseNo, pos: sense.pos, glossEn: sense.glossEn }];
    } else {
      interpretationStatus = INTERP.AMBIGUOUS;
      interpretationReason = entry.evaluationTruncated ? 'evaluation-truncated' : 'multiple-compatible-senses';
      for (const sense of entry.senses) {
        compatibleSenses.push({ entryId: entry.entryId, senseNo: sense.senseNo, pos: sense.pos, glossEn: sense.glossEn });
      }
    }
  }

  const evidenceSummary = {
    codes: EVIDENCE_ORDER.filter((code) => evidence.codes.has(code)),
    excludedBy: evidence.excludedBy
  };
  return {
    candidateKey: candidate.key,
    canonical: candidate.canonical,
    matchStatus,
    matchReason,
    identityStrategy: identity.strategy,
    lookupTruncated: truncated,
    evaluationTruncated: finalEvalTruncated,
    selectedEntryId,
    survivingEntries,
    itemReadings,
    interpretationStatus,
    interpretationReason,
    selectedSense,
    compatibleSenses,
    evidenceSummary
  };
}

module.exports = {
  MATCH,
  INTERP,
  EVIDENCE_ORDER,
  evaluateSenses,
  resolveReadings,
  finalizeCandidate
};
