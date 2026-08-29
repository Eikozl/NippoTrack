const express = require('express');
const controller = require('../controllers/vocabularyController');

const router = express.Router();
router.get('/options', controller.listVocabularyOptions);
router.route('/').get(controller.listVocabulary).post(controller.createVocabulary);
router.route('/:id').get(controller.getVocabulary).put(controller.updateVocabulary).delete(controller.deleteVocabulary);

module.exports = router;
