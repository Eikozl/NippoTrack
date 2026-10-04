const express = require('express');
const { exportBackup, exportTabular } = require('../controllers/exportController');

const router = express.Router();
// Plain /api/export keeps the legacy JSON backup; ?format=csv|xlsx selects
// the tabular export. Backward compatible by construction.
router.get('/', (req, res) => (req.query && req.query.format ? exportTabular(req, res) : exportBackup(req, res)));

module.exports = router;
