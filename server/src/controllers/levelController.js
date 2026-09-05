const pool = require('../config/db');
const { sendRouteError } = require('../errors/http');
const { estimateStudyLevel, getLevelEstimateData } = require('../services/levelEstimate');
const { buildJlptProgress, getJlptProgressData } = require('../services/jlptProgress');
const { getJlptTarget, setJlptTarget } = require('../services/jlptTarget');

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

module.exports = { getJlptProgress, getJlptTargetLevel, getLevelEstimate, putJlptTargetLevel };

// Phase 11 — Target JLPT level. GET returns { targetLevel: 'N3' | null };
// PUT accepts { target_level: 'N5'..'N1' | null } (null clears). Ownership
// always derives from req.user.id; strict enum validation rejects anything
// else with 400. Only user_jlpt_target is ever written — changing the
// target never mutates review state, progress evidence, goals, or sessions.
async function getJlptTargetLevel(req, res) {
  try {
    const targetLevel = await getJlptTarget(pool, req.user.id);
    return res.json({ targetLevel });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load target level.' });
  }
}

async function putJlptTargetLevel(req, res) {
  try {
    if (!req.body || !Object.prototype.hasOwnProperty.call(req.body, 'target_level')) {
      return res.status(400).json({ error: 'target_level is required (N5..N1, or null to clear).' });
    }
    const targetLevel = await setJlptTarget(pool, req.user.id, req.body.target_level);
    return res.json({ targetLevel });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to save target level.' });
  }
}
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
