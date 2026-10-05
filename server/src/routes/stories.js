const express = require('express');
const controller = require('../controllers/storiesController');

const router = express.Router();
router.post('/extract-preview', controller.postExtractPreview);
router.post('/', controller.postStory);
router.post('/:id/extract', controller.postExtract);
router.post('/:id/enroll-srs', controller.postEnrollSrs);
router.get('/:id/embed', controller.getEmbed);

module.exports = router;
