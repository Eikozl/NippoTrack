const express = require('express');
const controller = require('../controllers/levelController');

const router = express.Router();

router.route('/estimate').get(controller.getLevelEstimate);

module.exports = router;
