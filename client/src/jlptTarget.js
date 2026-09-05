// Phase 11 — Target JLPT level (client model).
//
// Pure, DOM-free helpers for the study-target selector. The target is a
// USER GOAL / STUDY INTENTION, kept strictly distinct from:
// - Estimated study level (Phase 9, evidence-derived)
// - Reference progress (Phase 10, evidence-derived)
//
// Product language rules:
// - The selector label is always "Target JLPT level", never bare "JLPT Level".
// - No-target is first-class: "No target selected" with guidance copy.
// - Estimate/target comparisons are neutral facts ("Estimated study band:
//   N4 · Study target: N3") — never judgments, never recommendations.
// - Progress context says "coverage toward your selected {band} study
//   target", never readiness/completion/passing.

const BAND_ORDER = ['N5', 'N4', 'N3', 'N2', 'N1'];

const NO_TARGET_VALUE = '';

function isValidTargetLevel(value) {
  return value === null || BAND_ORDER.includes(value);
}

function targetLevelOptions() {
  return [
    { value: NO_TARGET_VALUE, label: 'No target selected' },
    ...BAND_ORDER.map((band) => ({ value: band, label: band }))
  ];
}

// targetContextLine(target, cumulativeEntry) -> highlighted progress line
// for the selected target, or null when no target is selected. cumulativeEntry
// is the Phase 10 cumulative band ({ reviewed, referenceTotal }).
function targetContextLine(target, cumulativeEntry) {
  if (target === null || target === NO_TARGET_VALUE || target === undefined) return null;
  if (!BAND_ORDER.includes(target)) return null;
  const reviewed = Math.max(0, Number(cumulativeEntry?.reviewed) || 0);
  const referenceTotal = Math.max(0, Number(cumulativeEntry?.referenceTotal) || 0);
  return `Reference Kanji coverage toward your selected ${target} study target: ${reviewed} / ${referenceTotal} reviewed`;
}

// estimateTargetLine(estimateLevel, target) -> neutral comparison line, or
// null when no target is selected. Deliberately judgment-free in every
// ordering (estimate below, equal, or above the target).
function estimateTargetLine(estimateLevel, target) {
  if (target === null || target === NO_TARGET_VALUE || target === undefined) return null;
  if (!BAND_ORDER.includes(target)) return null;
  const estimateText = BAND_ORDER.includes(estimateLevel) ? estimateLevel : 'not enough evidence yet';
  return `Estimated study band: ${estimateText} · Study target: ${target}`;
}

export { BAND_ORDER, NO_TARGET_VALUE, estimateTargetLine, isValidTargetLevel, targetContextLine, targetLevelOptions };
