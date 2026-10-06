const express = require('express');
const { getActivity, getDashboard, getStudyNow } = require('../controllers/dashboardController');

const router = express.Router();
router.get('/study-now', getStudyNow);
router.get('/', getDashboard);
router.get('/activity', getActivity);

module.exports = router;
