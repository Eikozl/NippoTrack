const express = require('express');
const controller = require('../controllers/shareController');

const router = express.Router();
router.post('/deck', controller.postDeck);
router.post('/deck/preview', controller.postDeckPreview);
router.post('/deck/import', controller.postDeckImport);
router.get('/deck/:code', controller.getDeck);
router.post('/deck/:code/import', controller.postDeckImportByCode);

module.exports = router;
