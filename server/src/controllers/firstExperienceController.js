const pool = require('../config/db');
const { sendRouteError } = require('../errors/http');
const { completeOnboarding, getFirstExperience } = require('../services/firstExperience');
const { getPlacementQuestionsForUser, selfReportPlacement, skipPlacement, submitPlacement } = require('../services/placement');

// NippoTrack v5.1-A.2 — first-experience state. GET returns the combined
// onboarding + placement + target shape; PUT /onboarding completes onboarding
// atomically (target + 014 upsert in one transaction, see the service).
// Ownership always derives from req.user.id; body user ids are never read.
//
// NippoTrack v5.1-A.3 — Quick Placement quiz. GET /placement/questions serves
// the public question payload (band + answer key stripped in the service);
// POST /placement/submit validates + scores + persists the estimate;
// POST /placement/skip preserves any stored estimate/timestamp.

// POST /placement/skip preserves any stored estimate/timestamp and never
// downgrades a completed placement. One-time quiz: questions 409 after
// completion (PLACEMENT_ALREADY_COMPLETED); the persisted result stays
// available via GET.
//
// POST /placement/self-report persists a self-reported starting level
// ({level: N5..N1} only; anything else is 400) as a completed placement with
// source 'self_reported' and NULL counts, then returns the full GET shape.
// One-time across both sources: 409 PLACEMENT_ALREADY_COMPLETED when already
// completed via quiz or self-report. Ownership always derives from
// req.user.id; body user ids and spoofed estimate/source/result fields are
// never read.

async function getFirstExperienceState(req, res) {
  try {
    return res.json(await getFirstExperience(pool, req.user.id));
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load first-experience state.' });
  }
}

async function putOnboarding(req, res) {
  try {
    return res.json(await completeOnboarding(pool, req.user.id, req.body));
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to save onboarding.' });
  }
}

async function getPlacementQuestionsState(req, res) {
  try {
    return res.json(await getPlacementQuestionsForUser(pool, req.user.id));
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load placement questions.' });
  }
}

async function postPlacementSubmit(req, res) {
  try {
    return res.json(await submitPlacement(pool, req.user.id, req.body));
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to save placement result.' });
  }
}

async function postPlacementSkip(req, res) {
  try {
    return res.json(await skipPlacement(pool, req.user.id));
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to skip placement.' });
  }
}

async function postPlacementSelfReport(req, res) {
  try {
    await selfReportPlacement(pool, req.user.id, req.body);
    return res.json(await getFirstExperience(pool, req.user.id));
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to save starting level.' });
  }
}

module.exports = { getFirstExperienceState, getPlacementQuestionsState, postPlacementSelfReport, postPlacementSkip, postPlacementSubmit, putOnboarding };
