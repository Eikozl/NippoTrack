const express = require('express');
const controller = require('../controllers/kanjiController');

const router = express.Router();
router.get('/options', controller.listKanjiOptions);
router.get('/reference', controller.listKanjiReferences);
router.get('/lookup/:character', controller.lookupKanjiReference);
router.route('/').get(controller.listKanji).post(controller.createKanji);
router.route('/:id').get(controller.getKanji).put(controller.updateKanji).delete(controller.deleteKanji);

module.exports = router;
