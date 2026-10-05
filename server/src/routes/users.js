const express = require('express');
const controller = require('../controllers/deckPublicationsController');

const router = express.Router();
router.get('/:username/public', controller.getPublicUser);
router.get('/:username/decks', controller.listPublicUserDecks);
router.get('/me', controller.getOwnProfile);
router.put('/me', controller.putOwnProfile);

module.exports = router;
