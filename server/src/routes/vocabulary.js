const express = require('express');
const controller = require('../controllers/vocabularyController');
const autofillController = require('../controllers/vocabularyAutofillController');

const router = express.Router();
// VAF-B drill-down mounts BEFORE '/:id' so literal paths are never captured.
router.post('/autofill/entry', autofillController.postAutofillEntry);
router.post('/autofill', autofillController.postAutofill);
router.get('/options', controller.listVocabularyOptions);
router.route('/').get(controller.listVocabulary).post(controller.createVocabulary);
router.post('/:id/examples', controller.createVocabularyExample);
router.put('/:id/examples/:exampleId', controller.updateVocabularyExample);
router.delete('/:id/examples/:exampleId', controller.deleteVocabularyExample);
router.route('/:id').get(controller.getVocabulary).put(controller.updateVocabulary).delete(controller.deleteVocabulary);

module.exports = router;
