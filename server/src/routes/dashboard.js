const express = require('express');
const { getActivity, getDashboard } = require('../controllers/dashboardController');

const router = express.Router();
router.get('/', getDashboard);
router.get('/activity', getActivity);

module.exports = router;
