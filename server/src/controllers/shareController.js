// Shared decks: signed export codes plus verified import. The signing
// secret comes from JLT_DECK_SHARE_SECRET; without it the endpoints stay
// closed (503) instead of signing with a worthless default.
const pool = require('../config/db');
const { ValidationError, sendRouteError } = require('../errors/http');
const {
  createDeckShare,
  fetchOwnedItems,
  importDeckItems,
  parseDeckShare,
  sanitizeDeckInput
} = require('../services/deckSharing');

function signingSecret() {
  const secret = String(process.env.JLT_DECK_SHARE_SECRET || '').trim();
  return secret || null;
}

async function postDeck(req, res) {
  try {
    const secret = signingSecret();
    if (!secret) {
      return res.status(503).json({ error: 'Deck sharing is not configured on this server.' });
    }
    const { error, value } = sanitizeDeckInput(req.body || {});
    if (error) throw new ValidationError(error);
    const items = await fetchOwnedItems(pool, value.entityType, value.ids, req.user.id);
    if (!items.length) return res.status(404).json({ error: 'No owned items match the requested ids.' });
    const shareCode = createDeckShare(
      { entityType: value.entityType, items, title: value.title, description: value.description, creatorId: req.user.id },
      secret
    );
    return res.json({ shareCode, itemCount: items.length, entityType: value.entityType });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to create the share deck.' });
  }
}

async function getDeck(req, res) {
  try {
    const secret = signingSecret();
    if (!secret) {
      return res.status(503).json({ error: 'Deck sharing is not configured on this server.' });
    }
    const deck = parseDeckShare(req.params.code, secret);
    if (!deck) return res.status(404).json({ error: 'Share code is invalid or expired.' });
    return res.json(deck);
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to read the share deck.' });
  }
}

async function postDeckImport(req, res) {
  try {
    const secret = signingSecret();
    if (!secret) {
      return res.status(503).json({ error: 'Deck sharing is not configured on this server.' });
    }
    const deck = parseDeckShare(req.params.code, secret);
    if (!deck) return res.status(404).json({ error: 'Share code is invalid or expired.' });
    const result = await importDeckItems(pool, deck, req.user.id);
    return res.json({ entityType: deck.entityType, ...result });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to import the share deck.' });
  }
}

module.exports = { getDeck, postDeck, postDeckImport };
