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
// - No disk writes, no network calls, no persistence, no logging of user text.
// - Synchronous engine parsing cannot be preempted; per-request protection is
//   the lexical input cap (MAX_LEXICAL_TEXT_LENGTH) plus duration telemetry.

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
// hardcoded relative path), so Vercel's bundled layout keeps working as long
// as the package's JS is traced. The *.dat.gz blobs themselves need explicit
// function bundle inclusion (see vercel.json includeFiles).
function resolveDictionaryPath() {
  let entry;
  try {
    entry = require.resolve('@sglkc/kuromoji');
  } catch (_) {
    throw new ParserError('PARSER_INIT_FAILED', 'Japanese parser engine failed to load.');
  }
  return path.join(path.dirname(entry), '..', 'dict');
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

function buildTokenizer() {
  let kuromoji;
  try {
    kuromoji = require('@sglkc/kuromoji');
  } catch (error) {
    throw new ParserError('PARSER_INIT_FAILED', 'Japanese parser engine failed to load.');
  }
  const dicPath = resolveDictionaryPath();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new ParserError('PARSER_INIT_FAILED', 'Japanese parser engine initialization timed out.'));
      }
    }, PARSE_TIMEOUT_MS * 5);
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
  ENGINE_DICTIONARY,
  ENGINE_NAME,
  ENGINE_PACKAGE,
  MAX_LEXICAL_TEXT_LENGTH,
  PARSE_TIMEOUT_MS,
  ParserError,
  engineMetadata,
  getParserStatus,
  getTokenizer,
  parseJapanese,
  resetParserForTests,
  resolveDictionaryPath,
};
