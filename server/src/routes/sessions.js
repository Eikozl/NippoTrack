const express = require('express');
const controller = require('../controllers/sessionsController');

const router = express.Router();
router.route('/').get(controller.listSessions).post(controller.createSession);
// Static day-items route must precede '/:id' so 'day-items' is not parsed
// as a numeric session id (parseIdParam would 400 it).
router.route('/day-items').get(controller.getDayItems);
router.route('/:id').get(controller.getSession).put(controller.updateSession).delete(controller.deleteSession);

module.exports = router;
