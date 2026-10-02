const express = require('express');
const controller = require('../controllers/reviewController');

const router = express.Router();
router.get('/candidates', controller.listCandidates);
router.get('/difficult', controller.listDifficultItems);
router.get('/sessions', controller.listReviewSessions);
router.get('/sessions/:id', controller.getReviewSession);
router.post('/sessions', controller.createReviewSession);
router.post('/sessions/:id/complete', controller.completeReviewSession);
router.post('/grade', controller.gradeEntity);
router.get('/', controller.listDueReviews);
router.post('/:id', controller.recordReview);
module.exports = router;
