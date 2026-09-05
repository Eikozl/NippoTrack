// Phase 10 — JLPT reference Kanji progress (transparent counts, no scores).
//
// PRODUCT GOAL: show how much REVIEWED Kanji evidence the user has in each
// reference JLPT band (N5..N1) plus cumulative "coverage through band X".
// This is progress toward JLT's reference Kanji universe — NEVER official
// JLPT completion, exam readiness, passing probability, or full proficiency.
//
// EVIDENCE MODEL: reused 1:1 from Phase 9 (services/levelEstimate.js):
// - COLLECTED (informational only): an owned kanji row. Bulk imports
//   (Analyzer, discovery, batch) create these without learning anything.
// - REVIEWED (valid progress evidence): owned classified kanji with >= 1
//   review_events row. review_items alone mean nothing; only recorded review
//   EVENTS prove the user actually reviewed.
// - REPEATED (stronger longitudinal signal): >= 2 review events for the
//   same kanji. JLT has no pass/fail semantics, so Again/Hard/Good all
//   count equally — repetition, not grades, is the signal.
// - Band source: COALESCE(kanji_reference.jlpt_level via reference_id,
//   kanji.jlpt_level). Unclassified kanji are counted separately and NEVER
//   assigned to a band.
// - Explicitly NOT progress: collection membership, status labels,
//   encounters (exposure only), session links, Analyzer text/imports without
//   reviews, vocab/grammar levels, other users' data.
// - Denominators come from the CURRENT kanji_reference dataset
//   (OpenJLPT overlay: community reference metadata, not an official
//   syllabus) — counted dynamically, never hardcoded.
//
// No composite mastery score: simple transparent counts per band.

const { JLPT_ORDER, normalizeBand } = require('./levelEstimate');

const PROGRESS_DISCLAIMER = 'Reference Kanji coverage only — reviewed kanji counted against the shared reference set. Not official JLPT completion, exam readiness, certification, or proof of passing.';

// Percent with one decimal, e.g. 72.5. Null when the reference band is
// empty so callers never divide by zero.
function reviewedPercent(reviewed, referenceTotal) {
  if (!referenceTotal || referenceTotal <= 0) return null;
  return Math.round((Math.max(0, reviewed) / referenceTotal) * 1000) / 10;
}

// Pure assembly of the full progress contract from aggregate inputs:
// referenceTotals = { N5: n, ... } (shared global denominators),
// bandRows = [{ band, collected, reviewed, repeated }] (user-scoped),
// unclassified = { collected, reviewed, repeated } (never mapped to a band).
function buildJlptProgress({ referenceTotals, bandRows, unclassified }) {
  const totals = referenceTotals && typeof referenceTotals === 'object' ? referenceTotals : {};
  const perBand = {};
  for (const band of JLPT_ORDER) {
    perBand[band] = { collected: 0, reviewed: 0, repeated: 0 };
  }
  for (const row of Array.isArray(bandRows) ? bandRows : []) {
    const band = normalizeBand(row && row.band);
    if (!band) continue;
    perBand[band].collected += Math.max(0, Number(row.collected) || 0);
    perBand[band].reviewed += Math.max(0, Number(row.reviewed) || 0);
    perBand[band].repeated += Math.max(0, Number(row.repeated) || 0);
  }

  const bands = {};
  let cumulativeReference = 0;
  let cumulativeReviewed = 0;
  let cumulativeRepeated = 0;
  const cumulative = {};
  for (const band of JLPT_ORDER) {
    const referenceTotal = Math.max(0, Number(totals[band]) || 0);
    const collected = perBand[band].collected;
    const reviewed = Math.min(collected, perBand[band].reviewed);
    const repeated = Math.min(reviewed, perBand[band].repeated);
    bands[band] = {
      referenceTotal,
      collected,
      reviewed,
      repeated,
      unreviewedCollected: Math.max(0, collected - reviewed),
      reviewedPercent: reviewedPercent(reviewed, referenceTotal)
    };
    cumulativeReference += referenceTotal;
    cumulativeReviewed += reviewed;
    cumulativeRepeated += repeated;
    cumulative[band] = {
      referenceTotal: cumulativeReference,
      reviewed: cumulativeReviewed,
      repeated: cumulativeRepeated,
      reviewedPercent: reviewedPercent(cumulativeReviewed, cumulativeReference)
    };
  }

  const safeUnclassified = {
    collected: Math.max(0, Number(unclassified && unclassified.collected) || 0),
    reviewed: Math.max(0, Number(unclassified && unclassified.reviewed) || 0),
    repeated: Math.max(0, Number(unclassified && unclassified.repeated) || 0)
  };
  const summary = {
    referenceTotal: cumulativeReference,
    reviewed: cumulativeReviewed,
    repeated: cumulativeRepeated,
    reviewedPercent: reviewedPercent(cumulativeReviewed, cumulativeReference)
  };
  return {
    bands,
    cumulative,
    summary,
    unclassified: safeUnclassified,
    limitations: buildLimitations(safeUnclassified),
    disclaimer: PROGRESS_DISCLAIMER
  };
}

function buildLimitations(unclassified) {
  const limitations = [
    'Reference Kanji coverage only — not official JLPT completion, exam readiness, or proof of passing an exam.',
    'Reference totals come from the community OpenJLPT overlay and may change as reference data is updated; they are not an official JLPT syllabus.',
    'Only reviewed kanji count as progress: imports, collection size, status labels, encounters, and pasted Analyzer text are not evidence of knowledge.',
    'Review results (Again/Hard/Good) carry no pass/fail meaning in JLT, so repeated reviews — not grades — are the stronger signal.'
  ];
  if (unclassified.reviewed > 0) {
    limitations.push(`${unclassified.reviewed} reviewed kanji have no reference JLPT classification and are excluded from band counts.`);
  }
  return limitations;
}

// Bounded aggregates only: one grouped reference-totals query (shared
// global denominators) plus one grouped user-evidence query (collected /
// reviewed / repeated per band via LEFT JOINs so unreviewed owned kanji
// still count as collected). No per-kanji loops, no event scans. All user
// rows scoped to userId; kanji_reference is shared read-only metadata.
async function getJlptProgressData(database, userId) {
  const [referenceResult] = await database.execute(
    'SELECT jlpt_level AS band, COUNT(*) AS total FROM kanji_reference ' +
    "WHERE jlpt_level IN ('N5', 'N4', 'N3', 'N2', 'N1') GROUP BY jlpt_level"
  );
  const [bandResult] = await database.execute(
    'SELECT band, COUNT(*) AS collected, ' +
    'SUM(CASE WHEN event_count >= 1 THEN 1 ELSE 0 END) AS reviewed, ' +
    'SUM(CASE WHEN event_count >= 2 THEN 1 ELSE 0 END) AS repeated ' +
    'FROM (SELECT COALESCE(kr.jlpt_level, k.jlpt_level) AS band, COUNT(re.id_review_event) AS event_count ' +
    'FROM kanji k ' +
    'LEFT JOIN review_items ri ON ri.id_kanji = k.id_kanji ' +
    'LEFT JOIN review_events re ON re.id_review_item = ri.id_review_item ' +
    'LEFT JOIN kanji_reference kr ON kr.id_kanji_reference = k.reference_id ' +
    'WHERE k.user_id = ? ' +
    'GROUP BY k.id_kanji, COALESCE(kr.jlpt_level, k.jlpt_level)) AS evidence ' +
    'GROUP BY band',
    [userId]
  );
  const referenceTotals = {};
  for (const row of referenceResult || []) {
    const band = normalizeBand(row.band);
    if (band) referenceTotals[band] = Number(row.total) || 0;
  }
  const bandRows = [];
  const unclassified = { collected: 0, reviewed: 0, repeated: 0 };
  for (const row of bandResult || []) {
    const band = normalizeBand(row.band);
    const collected = Number(row.collected) || 0;
    const reviewed = Number(row.reviewed) || 0;
    const repeated = Number(row.repeated) || 0;
    if (!band) {
      unclassified.collected += collected;
      unclassified.reviewed += reviewed;
      unclassified.repeated += repeated;
      continue;
    }
    bandRows.push({ band, collected, reviewed, repeated });
  }
  return { referenceTotals, bandRows, unclassified };
}

module.exports = {
  PROGRESS_DISCLAIMER,
  buildJlptProgress,
  getJlptProgressData,
  reviewedPercent
};
