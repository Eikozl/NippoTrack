const pool = require('../config/db');
const { sendRouteError } = require('../errors/http');
const { estimateStudyLevel, getLevelEstimateData } = require('../services/levelEstimate');
const { buildJlptProgress, getJlptProgressData } = require('../services/jlptProgress');

// Phase 9 — Estimated study level. GET /api/level/estimate computes a
// conservative, explainable JLPT study-band estimate from the requesting
// user's OWNED review evidence only. Read-only: two bounded aggregate
// SELECTs (per-band eligible/retained counts + collection totals), no
// writes, no encounters, no sessions, no analytics rows. Ownership always
// derives from req.user.id; kanji_reference is shared read-only metadata.
// Pasted Analyzer text never reaches this endpoint.
async function getLevelEstimate(req, res) {
  try {
    const data = await getLevelEstimateData(pool, req.user.id);
    return res.json(estimateStudyLevel(data));
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to estimate study level.' });
  }
}

module.exports = { getJlptProgress, getLevelEstimate };

// Phase 10 — JLPT reference Kanji progress. GET /api/level/progress reports
// transparent reviewed-vs-reference counts per band plus cumulative
// "coverage through band X". Read-only: two bounded aggregate SELECTs
// (reference totals + per-band collected/reviewed/repeated), no writes.
// Ownership always derives from req.user.id; kanji_reference is shared
// read-only metadata. Collection membership alone never counts as progress.
async function getJlptProgress(req, res) {
  try {
    const data = await getJlptProgressData(pool, req.user.id);
    return res.json(buildJlptProgress(data));
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load JLPT progress.' });
  }
}
