// Phase 9 — Estimated study level (conservative, explainable heuristic).
//
// PRODUCT GOAL: a conservative estimate of the user's current Japanese study
// level, based ONLY on evidence JLT actually owns. The result is a study-band
// suggestion (N5..N1), NEVER an official JLPT result, certification, or proof
// of passing an exam.
//
// CRITICAL PRINCIPLE: "Added to My Kanji" != "user knows this kanji". Users
// can bulk-import kanji (Analyzer, session discovery, batch import) without
// learning them, so mere collection membership is NOT evidence. Pasted
// Analyzer text is not evidence either (analysis is read-only and the user
// may not understand what they pasted).
//
// EVIDENCE MODEL (from the Phase 9 audit — no invented semantics):
// - Eligible evidence: an OWNED kanji row with >= 1 review_events row (any
//   result). review_items rows are auto-created for every new entity, so the
//   mere existence of a review_item means nothing; only recorded review
//   EVENTS (POST /api/review/:id with Again/Hard/Good) prove the user
//   actually sat down and reviewed the item.
// - "Retained" signal: >= 2 review events for the same kanji (repeated
//   review activity). JLT has NO pass/fail semantics — Again/Hard/Good all
//   reschedule (1/3/7 days) and all insert one event — so we deliberately do
//   NOT treat Good as "correct". Repetition is the only longitudinal signal.
// - Band source: COALESCE(kanji_reference.jlpt_level via reference_id,
//   kanji.jlpt_level). The reference overlay (OpenJLPT) is community data,
//   not an official syllabus; the owned column is user metadata that imports
//   copy from the reference. Unclassified (both NULL) kanji are counted but
//   never mapped to a band.
// - Explicitly NOT evidence: collection membership, status (New/Learning/
//   Familiar/Mastered is self-reported and review never changes it),
//   encounters (exposure only), session links/writings (active study but
//   ungraded), Analyzer text or imports, reference availability, vocab/grammar
//   jlpt_level (user metadata; never inferred from component kanji), other
//   users' data.
//
// HEURISTIC (deterministic, plain-language):
// 1. Count eligible classified kanji per band (+ retained subset).
// 2. Estimate = highest band B such that EVERY band N5..B holds at least
//    MIN_EVIDENCE_PER_BAND eligible kanji (cumulative foundation: a handful
//    of N1 kanji can never yield N1 without the lower bands).
// 3. Fewer than MIN_TOTAL_EVIDENCE eligible classified kanji overall (or N5
//    below the per-band minimum) => INSUFFICIENT_EVIDENCE, level null. New
//    users are NEVER defaulted to N5.
// 4. approachingBand: the next band above the estimate when it has 1..MIN-1
//    eligible kanji ("N4, approaching N3").
// 5. Confidence describes confidence in JLT's ESTIMATE (evidence volume and
//    repetition), not in the user's ability. No fake percentages.
//
// Thresholds are product heuristics, not JLPT facts. Centralized below,
// documented, boundary-tested.

const JLPT_ORDER = Object.freeze(['N5', 'N4', 'N3', 'N2', 'N1']);

// Minimum reviewed classified kanji IN a band to hold it. Rationale: a
// single kanji (or 2-4) must never promote a band; the spec requires "4
// reviewed kanji -> insufficient". Uniform across bands keeps the rule
// explainable ("5 reviewed kanji per band, every lower band included").
const MIN_EVIDENCE_PER_BAND = 5;

// Minimum eligible classified kanji overall for any estimate. Equals the
// per-band minimum so the N5 rule and the total rule agree.
const MIN_TOTAL_EVIDENCE = 5;

// Confidence cutoffs (evidence volume / repetition, deliberately coarse).
const CONF_MODERATE_MIN_TOTAL = 15;
const CONF_HIGH_MIN_TOTAL = 50;
const CONF_HIGH_MIN_RETAINED = 25;

const ESTIMATE_DISCLAIMER = 'This is a JLT study estimate based on reviewed kanji only — not an official JLPT assessment, certification, or proof of passing.';

function normalizeBand(value) {
  if (typeof value !== 'string') return null;
  const band = value.trim().toUpperCase();
  return JLPT_ORDER.includes(band) ? band : null;
}

// Pure: bandRows = [{ band, eligible, retained }]. Returns
// { level, status, confidence, approachingBand }.
function estimateBand(bandRows) {
  const counts = { N5: 0, N4: 0, N3: 0, N2: 0, N1: 0 };
  for (const row of Array.isArray(bandRows) ? bandRows : []) {
    const band = normalizeBand(row && row.band);
    if (band) counts[band] += Math.max(0, Number(row.eligible) || 0);
  }
  const total = JLPT_ORDER.reduce((sum, band) => sum + counts[band], 0);
  if (total < MIN_TOTAL_EVIDENCE) {
    return { level: null, status: 'insufficient_evidence', confidence: null, approachingBand: null };
  }
  let level = null;
  for (const band of JLPT_ORDER) {
    if (counts[band] >= MIN_EVIDENCE_PER_BAND) {
      level = band;
    } else {
      break;
    }
  }
  if (!level) {
    return { level: null, status: 'insufficient_evidence', confidence: null, approachingBand: null };
  }
  const nextIndex = JLPT_ORDER.indexOf(level) + 1;
  let approachingBand = null;
  if (nextIndex < JLPT_ORDER.length) {
    const next = counts[JLPT_ORDER[nextIndex]];
    if (next > 0 && next < MIN_EVIDENCE_PER_BAND) approachingBand = JLPT_ORDER[nextIndex];
  }
  return { level, status: 'estimated', confidence: null, approachingBand };
}

function estimateConfidence(eligibleTotal, retainedTotal) {
  if (eligibleTotal >= CONF_HIGH_MIN_TOTAL && retainedTotal >= CONF_HIGH_MIN_RETAINED) return 'high';
  if (eligibleTotal >= CONF_MODERATE_MIN_TOTAL) return 'moderate';
  return 'low';
}

// Pure assembly of the full response contract from aggregate inputs:
// bandRows = [{ band, eligible, retained }], totals = { collected, reviewed,
// exposure }, unclassifiedEligible = number.
function estimateStudyLevel({ bandRows, totals, unclassifiedEligible }) {
  const rows = Array.isArray(bandRows) ? bandRows : [];
  const safeTotals = {
    collected: Math.max(0, Number(totals && totals.collected) || 0),
    reviewed: Math.max(0, Number(totals && totals.reviewed) || 0),
    exposure: Math.max(0, Number(totals && totals.exposure) || 0)
  };
  const distribution = {};
  let eligibleTotal = 0;
  let retainedTotal = 0;
  for (const row of rows) {
    const band = normalizeBand(row && row.band);
    if (!band) continue;
    const eligible = Math.max(0, Number(row.eligible) || 0);
    const retained = Math.min(eligible, Math.max(0, Number(row.retained) || 0));
    distribution[band] = { eligible, retained };
    eligibleTotal += eligible;
    retainedTotal += retained;
  }
  for (const band of JLPT_ORDER) {
    if (!distribution[band]) distribution[band] = { eligible: 0, retained: 0 };
  }
  const unclassified = Math.max(0, Number(unclassifiedEligible) || 0);
  const decided = estimateBand(rows);
  if (decided.status === 'insufficient_evidence') {
    return {
      estimate: { level: null, status: 'insufficient_evidence', confidence: null, approachingBand: null },
      evidence: {
        eligibleKanji: eligibleTotal,
        retainedKanji: retainedTotal,
        reviewedKanji: safeTotals.reviewed,
        exposureKanji: safeTotals.exposure,
        collectedKanji: safeTotals.collected,
        unreviewedKanji: Math.max(0, safeTotals.collected - safeTotals.reviewed),
        classifiedEligibleKanji: eligibleTotal,
        unclassifiedEligibleKanji: unclassified
      },
      distribution,
      reasoning: [
        `Only ${eligibleTotal} reviewed kanji with a reference JLPT classification found (${MIN_TOTAL_EVIDENCE} needed for an estimate).`,
        'Imported or merely discovered kanji without review history do not count.'
      ],
      limitations: buildLimitations({ unclassified, exposure: safeTotals.exposure }),
      disclaimer: ESTIMATE_DISCLAIMER
    };
  }
  const confidence = estimateConfidence(eligibleTotal, retainedTotal);
  const reasoning = [
    `${eligibleTotal} reviewed kanji with reference JLPT classifications (${retainedTotal} reviewed more than once).`,
    `Reviewed-kanji foundation meets the minimum threshold through ${decided.level} (${MIN_EVIDENCE_PER_BAND}+ reviewed kanji in each band from N5 up).`
  ];
  if (decided.approachingBand) {
    reasoning.push(
      `${distribution[decided.approachingBand].eligible} reviewed ${decided.approachingBand} kanji so far — below the ${MIN_EVIDENCE_PER_BAND} needed to support a ${decided.approachingBand} estimate (approaching ${decided.approachingBand}).`
    );
  }
  return {
    estimate: { level: decided.level, status: 'estimated', confidence, approachingBand: decided.approachingBand },
    evidence: {
      eligibleKanji: eligibleTotal,
      retainedKanji: retainedTotal,
      reviewedKanji: safeTotals.reviewed,
      exposureKanji: safeTotals.exposure,
      collectedKanji: safeTotals.collected,
      unreviewedKanji: Math.max(0, safeTotals.collected - safeTotals.reviewed),
      classifiedEligibleKanji: eligibleTotal,
      unclassifiedEligibleKanji: unclassified
    },
    distribution,
    reasoning,
    limitations: buildLimitations({ unclassified, exposure: safeTotals.exposure }),
    disclaimer: ESTIMATE_DISCLAIMER
  };
}

function buildLimitations({ unclassified, exposure }) {
  const limitations = [
    'JLT study estimate only — not an official JLPT assessment, certification, or proof of passing an exam.',
    'Reference JLPT classifications come from the community OpenJLPT overlay, not an official JLPT syllabus.',
    'Only reviewed kanji count: imports, collection size, status labels, and pasted Analyzer text are not evidence of knowledge.',
    'Review results (Again/Hard/Good) carry no pass/fail meaning in JLT, so repetition — not grades — is the retention signal.'
  ];
  if (unclassified > 0) {
    limitations.push(`${unclassified} reviewed kanji have no reference JLPT classification and were excluded from band counts.`);
  }
  if (exposure > 0) {
    limitations.push(`Encounter history (${exposure} kanji seen in vocabulary or writings) indicates exposure only, not mastery.`);
  }
  return limitations;
}

// Bounded aggregates only: one grouped query for per-band eligible/retained
// counts plus one single-row totals query. No per-kanji loops, no event
// scans, no reference-table audit. All rows scoped to userId; the reference
// join is shared read-only metadata.
async function getLevelEstimateData(database, userId) {
  const [bandResult] = await database.execute(
    'SELECT band, COUNT(*) AS eligible, SUM(CASE WHEN event_count >= 2 THEN 1 ELSE 0 END) AS retained ' +
    'FROM (SELECT COALESCE(kr.jlpt_level, k.jlpt_level) AS band, COUNT(re.id_review_event) AS event_count ' +
    'FROM kanji k ' +
    'JOIN review_items ri ON ri.id_kanji = k.id_kanji ' +
    'JOIN review_events re ON re.id_review_item = ri.id_review_item ' +
    'LEFT JOIN kanji_reference kr ON kr.id_kanji_reference = k.reference_id ' +
    'WHERE k.user_id = ? ' +
    'GROUP BY k.id_kanji, COALESCE(kr.jlpt_level, k.jlpt_level)) AS evidence ' +
    'GROUP BY band',
    [userId]
  );
  const [totalResult] = await database.execute(
    'SELECT ' +
    '(SELECT COUNT(*) FROM kanji WHERE user_id = ?) AS collected, ' +
    '(SELECT COUNT(DISTINCT k.id_kanji) FROM kanji k ' +
    'JOIN review_items ri ON ri.id_kanji = k.id_kanji ' +
    'JOIN review_events re ON re.id_review_item = ri.id_review_item ' +
    'WHERE k.user_id = ?) AS reviewed, ' +
    '(SELECT COUNT(DISTINCT ke.id_kanji) FROM kanji_encounters ke WHERE ke.user_id = ?) AS exposure',
    [userId, userId, userId]
  );
  const totals = totalResult && totalResult[0] ? totalResult[0] : {};
  let unclassifiedEligible = 0;
  const bandRows = (bandResult || []).map((row) => {
    const band = normalizeBand(row.band);
    const eligible = Number(row.eligible) || 0;
    const retained = Number(row.retained) || 0;
    if (!band) {
      unclassifiedEligible += eligible;
      return null;
    }
    return { band, eligible, retained };
  }).filter(Boolean);
  return {
    bandRows,
    totals: {
      collected: Number(totals.collected) || 0,
      reviewed: Number(totals.reviewed) || 0,
      exposure: Number(totals.exposure) || 0
    },
    unclassifiedEligible
  };
}

module.exports = {
  CONF_HIGH_MIN_RETAINED,
  CONF_HIGH_MIN_TOTAL,
  CONF_MODERATE_MIN_TOTAL,
  ESTIMATE_DISCLAIMER,
  JLPT_ORDER,
  MIN_EVIDENCE_PER_BAND,
  MIN_TOTAL_EVIDENCE,
  estimateBand,
  estimateConfidence,
  estimateStudyLevel,
  getLevelEstimateData,
  normalizeBand
};
