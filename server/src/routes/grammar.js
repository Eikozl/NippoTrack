const express = require('express');
const controller = require('../controllers/grammarController');

const router = express.Router();
router.route('/').get(controller.listGrammar).post(controller.createGrammar);
router.route('/:id').get(controller.getGrammar).put(controller.updateGrammar).delete(controller.deleteGrammar);

module.exports = router;
