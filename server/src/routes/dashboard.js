const express = require('express');
const { getActivity, getDashboard, getNewItems, getStudyNow } = require('../controllers/dashboardController');

const router = express.Router();
router.get('/study-now', getStudyNow);
router.get('/study-now/new-items', getNewItems);
router.get('/', getDashboard);
router.get('/activity', getActivity);

module.exports = router;
