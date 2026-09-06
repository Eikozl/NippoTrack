// Phase 10 — JLPT reference Kanji progress (client model).
//
// Pure, DOM-free mapping from the GET /api/level/progress payload to
// display data. Rendering lives in pages/statistics.js; this module only
// shapes copy so wording stays consistent and unit-testable.
//
// Product language rules (Phase 10 gate):
// - Every percentage travels with its numerator/denominator and the words
//   "Reviewed" + "reference Kanji". Never a bare "N5 progress: 72%".
// - Never "exam readiness", "completion", or "passing". The disclaimer
//   travels with every state.
// - Cumulative entries read "{band}: {reviewed} / {referenceTotal} reviewed"
//   under a "Reference Kanji coverage through each band" lead-in.

const BAND_ORDER = ['N5', 'N4', 'N3', 'N2', 'N1'];

const FALLBACK_DISCLAIMER =
  'Reference Kanji coverage only — reviewed kanji counted against the shared reference set. Not official JLPT completion, exam readiness, certification, or proof of passing.';

const FALLBACK_LIMITATIONS = [
  'Reference totals come from the community OpenJLPT overlay, not an official JLPT syllabus.',
  'Only reviewed kanji count as progress: imports, collection size, status labels, encounters, and pasted Analyzer text are not evidence of knowledge.'
];

function bandEntry(source, band) {
  const row = source && typeof source === 'object' ? source[band] : null;
  const referenceTotal = Math.max(0, Number(row?.referenceTotal) || 0);
  const collected = Math.max(0, Number(row?.collected) || 0);
  const reviewed = Math.min(collected, Math.max(0, Number(row?.reviewed) || 0));
  const repeated = Math.min(reviewed, Math.max(0, Number(row?.repeated) || 0));
  const percent = referenceTotal > 0 ? Math.round((reviewed / referenceTotal) * 1000) / 10 : null;
  return {
    band,
    referenceTotal,
    collected,
    reviewed,
    repeated,
    unreviewedCollected: Math.max(0, collected - reviewed),
    reviewedPercent: percent,
    countLine: `${reviewed} / ${referenceTotal} reviewed`,
    barPercent: percent === null ? 0 : Math.min(100, percent)
  };
}

// jlptProgressModel(payload) -> plain display model, or null when the
// progress payload is unusable (statistics then shows an error with retry).
function jlptProgressModel(payload) {
  if (!payload || typeof payload !== 'object' || !payload.bands) return null;
  const rows = BAND_ORDER.map((band) => bandEntry(payload.bands, band));
  const cumulativeSource = payload.cumulative && typeof payload.cumulative === 'object' ? payload.cumulative : {};
  const cumulative = BAND_ORDER.map((band) => {
    const row = cumulativeSource[band] || {};
    const referenceTotal = Math.max(0, Number(row.referenceTotal) || 0);
    const reviewed = Math.max(0, Number(row.reviewed) || 0);
    return {
      band,
      referenceTotal,
      reviewed,
      line: `${band}: ${reviewed} / ${referenceTotal} reviewed`
    };
  });
  const unclassified = payload.unclassified && typeof payload.unclassified === 'object' ? payload.unclassified : {};
  const summary = payload.summary && typeof payload.summary === 'object' ? payload.summary : {};
  const disclaimer = typeof payload.disclaimer === 'string' && payload.disclaimer
    ? payload.disclaimer
    : FALLBACK_DISCLAIMER;
  const limitationLines = Array.isArray(payload.limitations) && payload.limitations.length
    ? payload.limitations
    : FALLBACK_LIMITATIONS;
  return {
    rows,
    cumulative,
    summary: {
      referenceTotal: Math.max(0, Number(summary.referenceTotal) || 0),
      reviewed: Math.max(0, Number(summary.reviewed) || 0)
    },
    unclassifiedReviewed: Math.max(0, Number(unclassified.reviewed) || 0),
    limitationLines,
    disclaimer
  };
}

export { BAND_ORDER, FALLBACK_DISCLAIMER, jlptProgressModel };
