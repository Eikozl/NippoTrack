const express = require('express');
const controller = require('../controllers/communityController');

const router = express.Router();

router.get('/feed', controller.listFeed);
router.get('/search', controller.searchCommunity);
router.post('/posts', controller.createPost);
router.get('/posts/:id', controller.getPost);
router.put('/posts/:id', controller.updatePost);
router.delete('/posts/:id', controller.deletePost);
router.post('/posts/:id/like', controller.toggleLike);
router.get('/posts/:id/comments', controller.listComments);
router.post('/posts/:id/comments', controller.createComment);
router.put('/comments/:id', controller.updateComment);
router.delete('/comments/:id', controller.deleteComment);
router.post('/follow', controller.followUser);
router.post('/unfollow', controller.unfollowUser);
router.get('/users/:username/:direction', controller.listFollows);
router.get('/profile/:username', controller.getProfile);
router.get('/notifications', controller.listNotifications);
router.get('/notifications/summary', controller.notificationSummary);
router.post('/notifications/read-all', controller.markAllNotificationsRead);
router.post('/notifications/:id/read', controller.markNotificationRead);
router.post('/reports', controller.createReport);
router.post('/blocks', controller.blockUser);
router.delete('/blocks', controller.unblockUser);
router.get('/blocks', controller.listBlockedUsers);

module.exports = router;
