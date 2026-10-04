const express = require('express');
const controller = require('../controllers/deckPublicationsController');

const router = express.Router();
router.get('/:username/public', controller.getPublicUser);
router.get('/:username/decks', controller.listPublicUserDecks);

module.exports = router;
