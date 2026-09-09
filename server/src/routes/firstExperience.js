const express = require('express');
const controller = require('../controllers/firstExperienceController');

const router = express.Router();

router.route('/').get(controller.getFirstExperienceState);
router.route('/onboarding').put(controller.putOnboarding);

module.exports = router;
