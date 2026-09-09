const pool = require('../config/db');
const { sendRouteError } = require('../errors/http');
const { completeOnboarding, getFirstExperience } = require('../services/firstExperience');

// NippoTrack v5.1-A.2 — first-experience state. GET returns the combined
// onboarding + placement + target shape; PUT /onboarding completes onboarding
// atomically (target + 014 upsert in one transaction, see the service).
// Ownership always derives from req.user.id; body user ids are never read.

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

module.exports = { getFirstExperienceState, putOnboarding };
