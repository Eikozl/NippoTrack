const pool = require('../config/db');
const { getSnapshot } = require('../middleware/requestMetrics');

// Keep this health check intentionally minimal; DB failures are logged server-side only.
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

async function getMetrics(req, res) {
  // Aggregate-only operational snapshot for load runs and ops: per-route
  // counts, error buckets, latency averages and SQL counts, plus pool
  // pressure. No user data, bodies, tokens or query text. Authenticated
  // like every other /api route (see app.js); pool read is best-effort.
  let poolStats = null;
  try {
    // eslint-disable-next-line global-require
    const runtimePool = require('../config/postgresRuntime');
    poolStats = {
      total: runtimePool.totalCount,
      idle: runtimePool.idleCount,
      waiting: runtimePool.waitingCount,
      max: runtimePool.options?.max ?? null
    };
  } catch {
    poolStats = { unavailable: true };
  }
  return res.json({ ...getSnapshot(), pool: poolStats });
}

module.exports = { getHealth, getMetrics };
