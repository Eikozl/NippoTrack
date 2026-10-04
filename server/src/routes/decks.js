const express = require('express');
const controller = require('../controllers/deckPublicationsController');

const router = express.Router();
router.post('/', controller.postPublish);
router.get('/', controller.listDecks);
router.get('/:id', controller.getDeck);
router.post('/:id/follow', controller.postFollow);
router.delete('/:id/follow', controller.deleteFollow);

module.exports = router;
