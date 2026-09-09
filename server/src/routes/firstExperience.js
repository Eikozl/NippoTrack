const express = require('express');
const controller = require('../controllers/firstExperienceController');

const router = express.Router();

router.route('/').get(controller.getFirstExperienceState);
router.route('/onboarding').put(controller.putOnboarding);
router.route('/placement/questions').get(controller.getPlacementQuestionsState);
router.route('/placement/submit').post(controller.postPlacementSubmit);
router.route('/placement/self-report').post(controller.postPlacementSelfReport);
router.route('/placement/skip').post(controller.postPlacementSkip);

module.exports = router;
