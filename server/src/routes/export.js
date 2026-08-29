const express = require('express');
const { exportBackup } = require('../controllers/exportController');

const router = express.Router();
router.get('/', exportBackup);

module.exports = router;
