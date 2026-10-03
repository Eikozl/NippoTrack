const express = require('express');
const controller = require('../controllers/gradedReaderController');

const router = express.Router();
router.get('/library', controller.listLibrary);
router.get('/import/preview', controller.previewImports);
router.get('/progress', controller.listProgress);
router.get('/text/:id', controller.getText);
router.delete('/text/:id', controller.deleteText);
router.post('/analyze', controller.analyzeText);
router.post('/user-text', controller.createUserText);
router.put('/text/:id/progress', controller.updateProgress);
router.post('/import', controller.importSources);

module.exports = router;
