const express = require('express');
const controller = require('../controllers/gradedReaderController');
const publications = require('../controllers/readingPublicationsController');

const router = express.Router();
router.get('/library', controller.listLibrary);
router.get('/import/preview', controller.previewImports);
router.get('/progress', controller.listProgress);
router.get('/publications', publications.listPublications);
router.post('/publications', publications.postPublish);
router.get('/publications/:id', publications.getPublication);
router.delete('/publications/:id', publications.deletePublication);
router.post('/publications/:id/import', publications.postImport);
router.get('/text/:id', controller.getText);
router.delete('/text/:id', controller.deleteText);
router.post('/analyze', controller.analyzeText);
router.post('/user-text', controller.createUserText);
router.put('/text/:id/progress', controller.updateProgress);
router.post('/text/:id/enroll', controller.enrollText);
router.put('/text/:id/translations', controller.putTranslations);
router.post('/import', controller.importSources);
router.post('/import/url', controller.importFromUrl);

module.exports = router;
