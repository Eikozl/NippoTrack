const express = require('express');
const controller = require('../controllers/deckCollectionsController');

const router = express.Router();
router.post('/', controller.postCollection);
router.get('/', controller.listCollections);
router.post('/import', controller.postCollectionImport);
router.get('/:id', controller.getCollectionDetail);
router.post('/:id/decks', controller.postCollectionDeck);
router.delete('/:id/decks/:deckId', controller.deleteCollectionDeck);
router.put('/:id/decks', controller.putCollectionOrder);
router.post('/:id/share', controller.postCollectionShare);

module.exports = router;
