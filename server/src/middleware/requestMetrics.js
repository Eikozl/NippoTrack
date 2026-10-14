// Minimal in-process request metrics (no dependencies, no behavior change).
// Records per-route counts, error buckets and latency sums; SQL statements
// counted via AsyncLocalStorage in postgresAdapter. Bounded (MAX_ROUTES) and
// aggregate-only: no user data, bodies, tokens or query text ever stored.
const { AsyncLocalStorage } = require('node:async_hooks');

const MAX_ROUTES = 200;

const storage = new AsyncLocalStorage();
const routes = new Map();
let sqlTotal = 0;

function routeKey(req) {
  const method = String(req.method || 'GET').toUpperCase();
  const raw = typeof req.originalUrl === 'string' ? req.originalUrl : String(req.url || '/');
  const path = raw.split('?')[0] || '/';
  const normalized = path.replace(/\/\d+(?=\/|$)/g, '/:id').slice(0, 160);
  return `${method} ${normalized}`;
}

// Template key resolved at finish time, when routing has completed:
// Express exposes the matched template (e.g. `/posts/:id`) via req.route,
// so dynamic segments (usernames, codes) never land in the stored keys.
// Unmatched requests (404) fall back to the normalized raw path.
function templateKey(req) {
  const method = String(req.method || 'GET').toUpperCase();
  const route = req.route && typeof req.route.path === 'string' ? req.route.path : null;
  if (!route) return routeKey(req);
  const base = typeof req.baseUrl === 'string' ? req.baseUrl : '';
  return `${method} ${`${base}${route}`.slice(0, 160)}`;
}

function snapshotRoute(key) {
  let entry = routes.get(key);
  if (!entry) {
    entry = { n: 0, ok: 0, err4xx: 0, err5xx: 0, sumMs: 0, maxMs: 0, sql: 0 };
    if (routes.size >= MAX_ROUTES) {
      const oldest = routes.keys().next().value;
      routes.delete(oldest);
    }
    routes.set(key, entry);
  }
  return entry;
}

function requestMetrics(req, res, next) {
  const started = process.hrtime.bigint();
  const context = { sql: 0 };
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const entry = snapshotRoute(templateKey(req));
    entry.n += 1;
    if (res.statusCode >= 500) entry.err5xx += 1;
    else if (res.statusCode >= 400) entry.err4xx += 1;
    else entry.ok += 1;
    entry.sumMs += ms;
    if (ms > entry.maxMs) entry.maxMs = ms;
    entry.sql += context.sql;
    sqlTotal += context.sql;
  });
  storage.run(context, () => next());
}

function countSql() {
  // Attributed to the route on finish; the global total grows there too.
  const context = storage.getStore();
  if (context) context.sql += 1;
}

function getSnapshot() {
  const out = {};
  for (const [key, entry] of routes) {
    out[key] = {
      ...entry,
      avgMs: entry.n ? Math.round((entry.sumMs / entry.n) * 100) / 100 : 0,
      avgSql: entry.n ? Math.round((entry.sql / entry.n) * 100) / 100 : 0,
      maxMs: Math.round(entry.maxMs * 100) / 100
    };
    delete out[key].sumMs;
  }
  return { routes: out, sqlTotal };
}

module.exports = { requestMetrics, countSql, getSnapshot, routeKey, templateKey, MAX_ROUTES };
