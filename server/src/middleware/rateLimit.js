function clientKey(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function createRateLimiter({ windowMs, max, message }) {
  const entries = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = clientKey(req);
    const current = entries.get(key);
    const entry = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
    entry.count += 1;
    entries.set(key, entry);

    if (entries.size > 10_000) {
      for (const [storedKey, storedEntry] of entries) if (storedEntry.resetAt <= now) entries.delete(storedKey);
    }
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    if (entry.count <= max) return next();
    res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
    return res.status(429).json({ error: message });
  };
}

module.exports = { createRateLimiter };
