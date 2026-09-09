const express = require('express');
const controller = require('../controllers/profileController');

const router = express.Router();

router.route('/').get(controller.getProfileState).put(controller.putProfile);

module.exports = router;
