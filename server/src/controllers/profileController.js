const pool = require('../config/db');
const { sendRouteError } = require('../errors/http');
const { getProfile, setProfile } = require('../services/profile');

async function getProfileState(req, res) {
  try {
    return res.json(await getProfile(pool, req.user.id, req.user.email));
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load profile.' });
  }
}

async function putProfile(req, res) {
  try {
    if (!req.body || !Object.prototype.hasOwnProperty.call(req.body, 'display_name')) {
      return res.status(400).json({ error: 'display_name is required (text or null).' });
    }
    return res.json(await setProfile(pool, req.user.id, req.user.email, req.body.display_name));
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to save profile.' });
  }
}

module.exports = { getProfileState, putProfile };
