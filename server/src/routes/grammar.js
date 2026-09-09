const express = require('express');
const controller = require('../controllers/grammarController');

const router = express.Router();
router.get('/options', controller.listGrammarOptions);
router.get('/reference', controller.listGrammarReferences);
router.get('/:id/vocabulary-context', controller.getGrammarVocabularyContext);
router.route('/').get(controller.listGrammar).post(controller.createGrammar);
router.route('/:id').get(controller.getGrammar).put(controller.updateGrammar).delete(controller.deleteGrammar);

module.exports = router;
