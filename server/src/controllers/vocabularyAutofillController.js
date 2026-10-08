// VAF-B — Vocabulary Auto-Fill controllers (standalone file; the frozen
// vocabularyController.js is untouched).
//
// POST /api/vocabulary/autofill       { word, includeOwnership? }
// POST /api/vocabulary/autofill/entry { sourceId, entryId, senseCursor? }
// Auth is inherited from the /api gate (401/403 real). Dictionary failures
// degrade in-payload (HTTP 200); only auth/validation stay real errors.

const pool = require('../config/db');
const { ValidationError, sendRouteError } = require('../errors/http');
const { normalizeText } = require('../validation');
const {
  validateAutofillPayload,
  validateAutofillEntryPayload
} = require('../validation');
const {
  resolveAutofill,
  resolveAutofillEntry
} = require('../services/vocabularyAutofillService');

async function postAutofill(req, res) {
  try {
    const { word, includeOwnership } = validateAutofillPayload(req.body || {});
    void normalizeText;
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'Authentication is required.' });
    const payload = await resolveAutofill({
      pool,
      word,
      userId: req.user.id,
      includeOwnership
    });
    return res.json(payload);
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to complete autofill.' });
  }
}

async function postAutofillEntry(req, res) {
  try {
    const { sourceId, entryId, senseCursor } = validateAutofillEntryPayload(req.body || {});
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'Authentication is required.' });
    const result = await resolveAutofillEntry({
      pool,
      sourceId,
      entryId,
      senseCursor
    });
    if (result.status === 'not-found') {
      return res.status(404).json({ error: 'JMdict entry not found for the pinned snapshot.' });
    }
    return res.json(result);
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load JMdict entry.' });
  }
}

module.exports = {
  postAutofill,
  postAutofillEntry
};
