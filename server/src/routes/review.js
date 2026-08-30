const express = require('express');
const controller = require('../controllers/reviewController');

const router = express.Router();
router.get('/', controller.listDueReviews);
router.post('/:id', controller.recordReview);
module.exports = router;
