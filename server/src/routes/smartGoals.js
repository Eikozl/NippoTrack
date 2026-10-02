const express = require('express');
const controller = require('../controllers/smartGoalsController');

const router = express.Router();
router.get('/smart', controller.getSmart);
router.put('/smart/preferences', controller.putPreferences);
router.post('/smart/adjust', controller.postAdjust);

module.exports = router;
