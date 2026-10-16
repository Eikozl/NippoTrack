// Phase 12-A — Japanese morphological parser access (engine wrapper).
//
// ENGINE ACCESS ONLY: lazy singleton around @sglkc/kuromoji (Kuromoji
// lineage, IPADIC dictionary bundled in the package). This module knows the
// vendor API and owns initialization/timeout/degradation. It performs NO
// linguistic interpretation — raw engine tokens go to lexicalTokenAdapter.js,
// which owns the JLT normalized contract. Never expose the raw tokenizer
// object to routes, controllers, or the API layer.
//
// Constraints honored:
// - Lazy: nothing loads at require() time. The dictionary builds on the first
//   lexical parse request only; Kanji-only traffic never pays init cost.
// - Concurrent first requests share one memoized Promise (no duplicate builds).
// - Init failure clears the memo so a later request may retry (no poison).
// - No network calls and no persistence in local/dev/CI: the vendored dict
//   on disk is used as-is. On serverless (Vercel) the *.dat.gz blobs are NOT
//   bundled (see vercel.json: no includeFiles) — the pinned public npm copy
//   is fetched once per instance into ephemeral /tmp and reused while warm.
//   /tmp holds engine bytes only, never user text.
// - Synchronous engine parsing cannot be preempted; per-request protection is
//   the lexical input cap (MAX_LEXICAL_TEXT_LENGTH) plus duration telemetry.

const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const ENGINE_NAME = 'kuromoji';
const ENGINE_PACKAGE = '@sglkc/kuromoji';
const ENGINE_DICTIONARY = 'ipadic';
const ADAPTER_VERSION = 1;

// Timeout base unit for the ASYNCHRONOUS dictionary build. The synchronous
// engine parse (tokenize()) cannot be preempted once running, so per-request
// protection is MAX_LEXICAL_TEXT_LENGTH (reject oversized input before
// parsing) plus durationMs telemetry — not this constant. Named for what it
// budgets: parse-phase-scale waits during initialization.
const PARSE_TIMEOUT_MS = 3000;

// Cold dictionary load is I/O-bound (10-30s on slow disks / CI contention),
// not parse-bound: it gets its own budget so a slow disk reads as slow, not
// broken. Missing dictionaries still fail fast via the builder error below,
// not via this timer.
const INIT_TIMEOUT_MS = 60000;

// Maximum input accepted for the lexical path. The Kanji path keeps its own
// 10,000-character limit; lexical parsing is heavier (synchronous Viterbi +
// large token payload), so it carries a separate, benchmark-derived cap.
//
// P12-A benchmark (dev machine, Node 24, 15 iterations, cold init 1435ms):
// - mixed/kana 10k chars: warm median ~90-100ms, payload ~2MB (TOO LARGE).
// - kanji-dense adversarial 10k: warm median 2224ms / p95 2714ms (TOO SLOW,
//   blocks the event loop; serverless CPUs are typically slower than this).
// - 2000 chars mixed: warm ~20-40ms each, payload ~300KB.
// Cap 2000 keeps the worst case sub-second and payloads small while covering
// typical analyzer pastes. Revisit only with production telemetry, never by
// raising blindly. The Kanji maximum is NOT reduced by this cap.
const MAX_LEXICAL_TEXT_LENGTH = 2000;

function enginePackageVersion() {
  try {
    return require('@sglkc/kuromoji/package.json').version || null;
  } catch (_) {
    return null;
  }
}

// Resolve the dictionary directory from the required entry point (not from a
// hardcoded relative path), so local/dev/CI layouts keep working as long as
// the package's JS is traced.
function resolveDictionaryPath() {
  let entry;
  try {
    entry = require.resolve('@sglkc/kuromoji');
  } catch (_) {
    throw new ParserError('PARSER_INIT_FAILED', 'Japanese parser engine failed to load.');
  }
  return path.join(path.dirname(entry), '..', 'dict');
}

// IPADIC payload mirrored 1:1 from the pinned npm package (see the jsDelivr
// default in dictBaseUrl). If the package adds/removes a blob in a future
// upgrade, the cold-start check below fails loudly instead of half-loading.
const DICT_FILES = [
  'base.dat.gz', 'cc.dat.gz', 'check.dat.gz', 'tid.dat.gz', 'tid_map.dat.gz',
  'tid_pos.dat.gz', 'unk.dat.gz', 'unk_char.dat.gz', 'unk_compat.dat.gz',
  'unk_invoke.dat.gz', 'unk_map.dat.gz', 'unk_pos.dat.gz'
];

const DICT_DOWNLOAD_TIMEOUT_MS = 30000;
const DICT_MAX_REDIRECTS = 3;

// Public, version-pinned CDN copy of the exact vendored blobs. Overridable
// via KUROMOJI_DICT_URL (trailing slash optional) for air-gapped mirrors;
// no secrets involved — IPADIC ships inside a public npm package.
function dictBaseUrl() {
  const fromEnv = (process.env.KUROMOJI_DICT_URL || '').trim().replace(/\/+$/, '');
  if (fromEnv) return fromEnv;
  const version = enginePackageVersion();
  if (!version) throw new ParserError('PARSER_INIT_FAILED', 'Japanese parser engine failed to load.');
  return `https://cdn.jsdelivr.net/npm/@sglkc/kuromoji@${version}/dict`;
}

function dictComplete(dir) {
  try {
    return DICT_FILES.every((file) => {
      const stat = fs.statSync(path.join(dir, file));
      return stat.isFile() && stat.size > 0;
    });
  } catch (_) {
    return false;
  }
}

function downloadFile(url, dest, redirects = DICT_MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: DICT_DOWNLOAD_TIMEOUT_MS }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects > 0) {
        response.resume();
        resolve(downloadFile(response.headers.location, dest, redirects - 1));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new ParserError('PARSER_INIT_FAILED', 'Japanese parser dictionary unavailable.'));
        return;
      }
      const out = fs.createWriteStream(dest);
      response.pipe(out);
      out.on('finish', () => resolve());
      out.on('error', (error) => {
        fs.unlink(dest, () => undefined);
        reject(error instanceof ParserError ? error : new ParserError('PARSER_INIT_FAILED', 'Japanese parser dictionary unavailable.'));
      });
    });
    request.on('timeout', () => request.destroy(new ParserError('PARSER_INIT_FAILED', 'Japanese parser dictionary unavailable.')));
    request.on('error', () => reject(new ParserError('PARSER_INIT_FAILED', 'Japanese parser dictionary unavailable.')));
  });
}

// Cold-start dictionary source. Local/dev/CI (vendored blobs present) return
// immediately with zero network. Serverless without bundled blobs fetches
// the pinned public copy once per instance into ephemeral /tmp (warm reuse
// via the skip-if-complete check above). Never throws raw errors: callers
// map ParserError to the degraded lexical block.
async function ensureDictionaryPath() {
  const local = resolveDictionaryPath();
  if (dictComplete(local)) return local;
  const version = enginePackageVersion() || 'remote';
  const dir = path.join(os.tmpdir(), `kuromoji-dict-${version}`);
  fs.mkdirSync(dir, { recursive: true });
  if (dictComplete(dir)) return dir;
  const base = dictBaseUrl();
  for (const file of DICT_FILES) {
    const dest = path.join(dir, file);
    try {
      if (fs.statSync(dest).isFile() && fs.statSync(dest).size > 0) continue;
    } catch (_) { /* missing: download below */ }
    await downloadFile(`${base}/${file}`, dest);
  }
  if (!dictComplete(dir)) throw new ParserError('PARSER_INIT_FAILED', 'Japanese parser dictionary unavailable.');
  return dir;
}

function engineMetadata() {
  return {
    name: ENGINE_NAME,
    package: ENGINE_PACKAGE,
    packageVersion: enginePackageVersion(),
    dictionary: ENGINE_DICTIONARY,
    dictionaryVersion: null, // IPADIC build ships no machine-readable version; null is honest.
    adapterVersion: ADAPTER_VERSION,
  };
}

class ParserError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ParserError';
    this.code = code;
  }
}

let tokenizerPromise = null;
let tokenizerReady = false;

async function buildTokenizer() {
  let kuromoji;
  try {
    kuromoji = require('@sglkc/kuromoji');
  } catch (error) {
    throw new ParserError('PARSER_INIT_FAILED', 'Japanese parser engine failed to load.');
  }
  const dicPath = await ensureDictionaryPath();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new ParserError('PARSER_INIT_FAILED', 'Japanese parser engine initialization timed out.'));
      }
    }, INIT_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      kuromoji.builder({ dicPath }).build((error, tokenizer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error || !tokenizer) {
          reject(new ParserError('PARSER_INIT_FAILED', 'Japanese parser engine failed to initialize.'));
        } else {
          resolve(tokenizer);
        }
      });
    } catch (_) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new ParserError('PARSER_INIT_FAILED', 'Japanese parser engine failed to initialize.'));
      }
    }
  });
}

// Side-effect-free status probe: NEVER initializes the engine.
function getParserStatus() {
  return {
    loaded: tokenizerReady,
    loading: tokenizerPromise !== null && !tokenizerReady,
    engine: engineMetadata(),
  };
}

async function getTokenizer() {
  if (tokenizerPromise) return tokenizerPromise;
  tokenizerPromise = buildTokenizer().then(
    (tokenizer) => {
      tokenizerReady = true;
      return tokenizer;
    },
    (error) => {
      // Clear the poisoned memo so a later request may retry initialization.
      tokenizerPromise = null;
      throw error;
    }
  );
  return tokenizerPromise;
}

// Parse raw engine tokens for text. Returns { rawTokens, durationMs }.
// Throws ParserError (never echoes user text). Callers map failure to a
// degraded lexical block; Kanji analysis must proceed regardless.
async function parseJapanese(text) {
  if (typeof text !== 'string') {
    throw new ParserError('PARSER_PARSE_FAILED', 'Japanese parser requires string input.');
  }
  const tokenizer = await getTokenizer();
  let rawTokens;
  const started = Date.now();
  try {
    rawTokens = tokenizer.tokenize(text);
  } catch (_) {
    throw new ParserError('PARSER_PARSE_FAILED', 'Japanese parser failed to tokenize input.');
  }
  const durationMs = Date.now() - started;
  if (!Array.isArray(rawTokens)) {
    throw new ParserError('PARSER_PARSE_FAILED', 'Japanese parser returned an unexpected result.');
  }
  return { rawTokens, durationMs };
}

// Test-only hook: clears the memoized singleton so init-failure recovery can
// be proven without restarting the process. Not reachable from any route.
function resetParserForTests() {
  tokenizerPromise = null;
  tokenizerReady = false;
}

module.exports = {
  ADAPTER_VERSION,
  DICT_FILES,
  ENGINE_DICTIONARY,
  ENGINE_NAME,
  ENGINE_PACKAGE,
  INIT_TIMEOUT_MS,
  MAX_LEXICAL_TEXT_LENGTH,
  PARSE_TIMEOUT_MS,
  ParserError,
  dictBaseUrl,
  dictComplete,
  engineMetadata,
  ensureDictionaryPath,
  getParserStatus,
  getTokenizer,
  parseJapanese,
  resetParserForTests,
  resolveDictionaryPath,
};
