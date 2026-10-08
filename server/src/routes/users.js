const express = require('express');
const controller = require('../controllers/deckPublicationsController');

const router = express.Router();
router.get('/:username/public', controller.getPublicUser);
router.get('/:username/decks', controller.listPublicUserDecks);
router.get('/me', controller.getOwnProfile);
router.put('/me', controller.putOwnProfile);
// Avatar upload parses multipart in-route (dependency-free): express.raw
// buffers multipart/form-data so services/profileAvatar can extract the
// single `avatar` field. 3mb covers the 2MB file ceiling plus framing;
// larger payloads fall through to the 413 branch in errors/http.
router.post('/me/avatar', express.raw({ type: 'multipart/form-data', limit: '3mb' }), controller.postOwnAvatar);
router.delete('/me/avatar', controller.deleteOwnAvatar);

module.exports = router;
