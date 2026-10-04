const express = require('express');
const controller = require('../controllers/deckPublicationsController');

const router = express.Router();
router.post('/', controller.postPublish);
router.get('/', controller.listDecks);
router.get('/:id', controller.getDeck);
router.delete('/:id', controller.deleteDeck);
router.get('/:id/analytics', controller.getAnalytics);
router.post('/:id/follow', controller.postFollow);
router.delete('/:id/follow', controller.deleteFollow);
router.post('/:id/suggest', controller.postSuggest);
router.get('/:id/suggestions', controller.listSuggest);
router.post('/suggestions/:id/decision', controller.postDecide);

module.exports = router;
