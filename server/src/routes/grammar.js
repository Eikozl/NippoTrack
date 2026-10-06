const express = require('express');
const controller = require('../controllers/grammarController');

const router = express.Router();
router.get('/options', controller.listGrammarOptions);
router.get('/reference', controller.listGrammarReferences);
router.get('/:id/vocabulary-context', controller.getGrammarVocabularyContext);
router.get('/:id/encounters', controller.getGrammarEncounters);
router.route('/').get(controller.listGrammar).post(controller.createGrammar);
router.post('/:id/examples', controller.createGrammarExample);
router.put('/:id/examples/:exampleId', controller.updateGrammarExample);
router.delete('/:id/examples/:exampleId', controller.deleteGrammarExample);
router.route('/:id').get(controller.getGrammar).put(controller.updateGrammar).delete(controller.deleteGrammar);

module.exports = router;
