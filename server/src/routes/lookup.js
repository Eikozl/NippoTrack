const express = require('express');
const controller = require('../controllers/lookupController');

const router = express.Router();
router.post('/define-sentence', controller.defineSentence);
module.exports = router;
