const express = require('express');
const controller = require('../controllers/insightsController');

const router = express.Router();
router.get('/weekly', controller.getWeekly);
router.get('/history', controller.getHistory);
router.post('/generate', controller.postGenerate);

module.exports = router;
