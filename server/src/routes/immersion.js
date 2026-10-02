const express = require('express');
const controller = require('../controllers/immersionController');

const router = express.Router();
router.post('/analyze', controller.analyzeImmersionText);
router.post('/create-session', controller.createSession);
router.get('/history', controller.listHistory);
module.exports = router;
