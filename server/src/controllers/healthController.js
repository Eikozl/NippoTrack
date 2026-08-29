const pool = require('../config/db');

async function getHealth(req, res) {
  try {
    const [rows] = await pool.query('SELECT DATABASE() AS database_name');
    const connected = rows?.[0]?.database_name === 'jlt';
    return res.json({
      ok: connected,
      status: connected ? 'healthy' : 'database_unavailable',
      database: connected ? 'jlt' : 'unavailable'
    });
  } catch (error) {
    return res.json({ ok: false, status: 'database_unavailable', database: 'unavailable' });
  }
}

module.exports = { getHealth };
