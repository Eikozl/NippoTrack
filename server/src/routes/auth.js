const express = require('express');
const { login, logout, sessionStatus } = require('../middleware/authentication');
const { createRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();
const loginRateLimit = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5, message: 'Too many login attempts. Please try again later.' });
router.get('/session', sessionStatus);
router.post('/login', loginRateLimit, login);
router.post('/logout', logout);

module.exports = router;
