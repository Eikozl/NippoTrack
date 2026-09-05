const express = require('express');
const controller = require('../controllers/levelController');

const router = express.Router();

router.route('/estimate').get(controller.getLevelEstimate);
router.route('/progress').get(controller.getJlptProgress);
router.route('/target').get(controller.getJlptTargetLevel).put(controller.putJlptTargetLevel);

module.exports = router;
