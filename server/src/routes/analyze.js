const express = require('express');
const controller = require('../controllers/analyzeController');

const router = express.Router();
router.route('/text').post(controller.analyzeText);

module.exports = router;
