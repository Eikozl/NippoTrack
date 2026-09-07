// Phase 12-B — lexical-specific abuse guard.
//
// Kuromoji parsing is CPU-heavier than Han scanning (synchronous Viterbi,
// uninterruptible once started), so lexical-enabled Analyzer requests carry
// their own budget on top of the global IP limiter in middleware/rateLimit.js.
//
// - Applies ONLY when lexical.enabled === true; Kanji-only traffic is never
//   charged here.
// - Keyed by authenticated user id (falls back to IP when unauthenticated,
//   e.g. failing-closed probes). Per-user fairness instead of per-IP.
// - In-memory per process: on Vercel serverless this bounds each instance,
//   NOT the fleet. Documented honestly — no distributed quota is claimed and
//   none is needed at this budget (60 parses / 15 min / user / instance).
// - Exhaustion degrades the lexical block (status 'unavailable', retryable),
//   never 429s the whole Analyzer: Kanji results must survive.
// - No DB, no Redis, no secrets, no new infrastructure.

const LEXICAL_LIMIT_MAX = 60;
const LEXICAL_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const BUCKET_CAP = 10_000;

const buckets = new Map();

function bucketKey(userId, fallbackIp) {
  if (typeof userId === 'string' && userId) return `user:${userId}`;
  return `ip:${fallbackIp || 'unknown'}`;
}

function tryConsumeLexical({ userId, ip, now = Date.now() } = {}) {
  const key = bucketKey(userId, ip);
  const current = buckets.get(key);
  const bucket = !current || current.resetAt <= now
    ? { count: 0, resetAt: now + LEXICAL_LIMIT_WINDOW_MS }
    : current;
  bucket.count += 1;
  buckets.set(key, bucket);
  if (buckets.size > BUCKET_CAP) {
    for (const [storedKey, stored] of buckets) {
      if (stored.resetAt <= now) buckets.delete(storedKey);
    }
  }
  if (bucket.count <= LEXICAL_LIMIT_MAX) return { allowed: true, retryAfterSec: 0 };
  return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
}

// Test-only hook: clears in-memory buckets. Not reachable from any route.
function resetLexicalLimitsForTests() {
  buckets.clear();
}

module.exports = {
  LEXICAL_LIMIT_MAX,
  LEXICAL_LIMIT_WINDOW_MS,
  tryConsumeLexical,
  resetLexicalLimitsForTests
};
