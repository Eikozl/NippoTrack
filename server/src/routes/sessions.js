const express = require('express');
const controller = require('../controllers/sessionsController');

const router = express.Router();
router.route('/').get(controller.listSessions).post(controller.createSession);
router.route('/:id').get(controller.getSession).put(controller.updateSession).delete(controller.deleteSession);

module.exports = router;
