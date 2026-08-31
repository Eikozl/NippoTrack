const ALLOWED_ORIGINS = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173'
]);

for (const origin of (process.env.JLT_ALLOWED_ORIGINS || '').split(',')) {
  if (origin.trim()) ALLOWED_ORIGINS.add(origin.trim());
}

function cors(req, res, next) {
  const origin = req.get('origin');
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return origin && !ALLOWED_ORIGINS.has(origin) ? res.sendStatus(403) : res.sendStatus(204);
  return next();
}

module.exports = cors;
