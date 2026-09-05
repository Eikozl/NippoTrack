// Phase 9 — Estimated study level (client model).
//
// Pure, DOM-free mapping from the GET /api/level/estimate payload to
// dashboard-ready display data. Rendering lives in pages/dashboard.js; this
// module only shapes copy so wording stays consistent and unit-testable.
//
// Product language rules (reviewed by the Phase 9 gate):
// - Never present the band as an official result, certification, or pass
//   proof. The disclaimer travels with every state.
// - No evidence is never N5: insufficient evidence has its own first-class
//   copy and guidance.

const BAND_ORDER = ['N5', 'N4', 'N3', 'N2', 'N1'];

const CONFIDENCE_LABELS = { low: 'Low estimate confidence', moderate: 'Moderate estimate confidence', high: 'High estimate confidence' };

const NOT_USED_LINES = [
  'Imported kanji that have not been reviewed yet',
  'Pasted Smart Text Analyzer text',
  'Status labels such as New, Learning, Familiar, or Mastered',
  'Encounter counts beyond exposure context',
  'Reference data availability or other users’ data'
];

const FALLBACK_DISCLAIMER = 'This is a JLT study estimate based on reviewed kanji only — not an official JLPT assessment, certification, or proof of passing.';

const FALLBACK_OPENJLPT_LIMITATION =
  'Reference JLPT classifications come from the community OpenJLPT overlay, not an official JLPT syllabus.';

const INSUFFICIENT_GUIDANCE =
  'Keep studying and reviewing. JLT needs at least 5 reviewed kanji with a reference JLPT classification before it can estimate your study band.';

function bandRows(distribution) {
  const source = distribution && typeof distribution === 'object' ? distribution : {};
  return BAND_ORDER.map((band) => ({
    band,
    eligible: Math.max(0, Number(source[band]?.eligible) || 0),
    retained: Math.max(0, Number(source[band]?.retained) || 0)
  }));
}

// levelEstimateModel(payload) -> plain display model, or null when the
// estimate fetch failed (dashboard then hides the section gracefully).
function levelEstimateModel(payload) {
  if (!payload || typeof payload !== 'object' || !payload.estimate) return null;
  const { estimate, evidence = {}, distribution, reasoning = [], limitations = [] } = payload;
  const rows = bandRows(distribution);
  const counts = {
    eligible: Math.max(0, Number(evidence.eligibleKanji) || 0),
    retained: Math.max(0, Number(evidence.retainedKanji) || 0),
    reviewed: Math.max(0, Number(evidence.reviewedKanji) || 0),
    collected: Math.max(0, Number(evidence.collectedKanji) || 0),
    unreviewed: Math.max(0, Number(evidence.unreviewedKanji) || 0),
    exposure: Math.max(0, Number(evidence.exposureKanji) || 0),
    unclassified: Math.max(0, Number(evidence.unclassifiedEligibleKanji) || 0)
  };
  const disclaimer = typeof payload.disclaimer === 'string' && payload.disclaimer
    ? payload.disclaimer
    : FALLBACK_DISCLAIMER;
  const limitationLines = Array.isArray(limitations) && limitations.length
    ? limitations
    : [FALLBACK_OPENJLPT_LIMITATION];
  if (estimate.status !== 'estimated' || !estimate.level) {
    return {
      status: 'insufficient_evidence',
      level: null,
      confidence: null,
      approachingBand: null,
      metricValue: '—',
      metricNote: 'Not enough evidence yet',
      headline: 'Not enough evidence yet',
      subline: INSUFFICIENT_GUIDANCE,
      evidenceLines: counts.reviewed > 0 || counts.collected > 0
        ? [`${counts.reviewed} of ${counts.collected} collected kanji reviewed so far — imported or discovered kanji do not count until reviewed.`]
        : ['No reviewed kanji yet — imported or discovered kanji do not count until reviewed.'],
      notUsedLines: NOT_USED_LINES,
      limitationLines,
      disclaimer,
      bandRows: rows,
      counts
    };
  }
  const confidenceLabel = CONFIDENCE_LABELS[estimate.confidence] || 'Low estimate confidence';
  const approaching = BAND_ORDER.includes(estimate.approachingBand) ? estimate.approachingBand : null;
  return {
    status: 'estimated',
    level: estimate.level,
    confidence: estimate.confidence || 'low',
    approachingBand: approaching,
    metricValue: estimate.level,
    metricNote: `${confidenceLabel} · JLT estimate`,
    headline: `Estimated study level: ${estimate.level}`,
    subline: `Your reviewed-kanji evidence is most consistent with ${estimate.level}-band kanji study (reference bands, kanji only).` +
      (approaching ? ` Approaching ${approaching}.` : ''),
    evidenceLines: Array.isArray(reasoning) && reasoning.length ? reasoning : [`${counts.eligible} reviewed kanji with reference JLPT classifications.`],
    notUsedLines: NOT_USED_LINES,
    limitationLines,
    disclaimer,
    bandRows: rows,
    counts
  };
}

export { BAND_ORDER, CONFIDENCE_LABELS, INSUFFICIENT_GUIDANCE, NOT_USED_LINES, levelEstimateModel };
