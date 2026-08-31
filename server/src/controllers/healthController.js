const pool = require('../config/db');

async function getHealth(req, res) {
  try {
    const [rows] = await pool.query('SELECT current_database() AS database_name');
    const connected = ['jlt', 'jlt_postgres', 'postgres'].includes(rows?.[0]?.database_name);
    return res.json({
      ok: connected,
      status: connected ? 'healthy' : 'database_unavailable',
      database: connected ? 'jlt' : 'unavailable'
    });
  } catch (error) {
    console.error('[health] database check failed', {
      name: error?.name || 'Error',
      code: error?.code || null,
      message: error?.message || 'Unknown database error'
    });
    return res.json({ ok: false, status: 'database_unavailable', database: 'unavailable' });
  }
}

module.exports = { getHealth };
