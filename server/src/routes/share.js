const express = require('express');
const controller = require('../controllers/shareController');

const router = express.Router();
router.post('/deck', controller.postDeck);
router.get('/deck/:code', controller.getDeck);
router.post('/deck/:code/import', controller.postDeckImport);

module.exports = router;
