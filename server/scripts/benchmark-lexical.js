// Phase 12-A — bounded lexical benchmark (direct service calls, no server).
// Usage: node scripts/benchmark-lexical.js
// Prints one JSON summary to stdout. No writes, no network, no persistence.
const { parseJapanese, engineMetadata, resetParserForTests } = require('../src/services/japaneseParser');
const { adaptTokens } = require('../src/services/lexicalTokenAdapter');

function repeatTo(text, targetChars) {
  const unit = Array.from(text).length;
  const times = Math.max(1, Math.ceil(targetChars / unit));
  return Array.from(text.repeat(times)).slice(0, targetChars).join('');
}

const SEEDS = {
  // Kana-heavy: mostly hiragana/katakana with light kanji.
  kana: 'これはとてもおもしろかったです。きのうともだちとえいがをみました。コンピューターをつかっています。',
  // Kanji-heavy: dense nouns/compounds.
  kanji: '日本語能力試験対策勉強計画実行報告書作成会議資料確認連絡事項伝達完了報告',
  // Mixed realistic: sentences with verbs, particles, loans, names.
  mixed: '俺は学校に行った。昨日は何も食べなかった。田中さんは大阪で寿司を食べた。コンピューターを使っています。お願いします。'
};

function rssMb() {
  const m = process.memoryUsage();
  return { rss: m.rss / 1048576, heapUsed: m.heapUsed / 1048576, heapTotal: m.heapTotal / 1048576 };
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { n: values.length, min: sorted[0], median: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

(async () => {
  const out = { engine: engineMetadata(), fixtures: {}, packageFootprint: null };
  resetParserForTests();

  const beforeInit = rssMb();
  // Cold init measured in a fresh process (this script IS the fresh process).
  const initStart = Date.now();
  const first = await parseJapanese('学校に行った。');
  const initMs = Date.now() - initStart;
  // Best-effort GC to separate retained dictionary memory from transient parse garbage.
  if (global.gc) global.gc();
  const afterInit = rssMb();
  out.cold = {
    initMs,
    firstParseMs: first.durationMs,
    rssBeforeMb: round3(beforeInit.rss),
    rssAfterMb: round3(afterInit.rss),
    rssDeltaMb: round3(afterInit.rss - beforeInit.rss),
    heapUsedDeltaMb: round3(afterInit.heapUsed - beforeInit.heapUsed)
  };

  const ITERATIONS = 15;
  for (const [kind, seed] of Object.entries(SEEDS)) {
    out.fixtures[kind] = {};
    for (const size of [100, 1000, 5000, 10000]) {
      const text = repeatTo(seed, size);
      const durations = [];
      let tokenCount = 0;
      let payloadBytes = 0;
      for (let i = 0; i < ITERATIONS; i++) {
        const { rawTokens, durationMs } = await parseJapanese(text);
        durations.push(durationMs);
        if (i === 0) {
          const tokens = adaptTokens(rawTokens, text, out.engine);
          tokenCount = tokens.length;
          payloadBytes = Buffer.byteLength(JSON.stringify(tokens), 'utf8');
        }
      }
      out.fixtures[kind][size] = {
        ...mapStats(stats(durations), 'Ms'),
        tokenCount,
        payloadBytes,
        payloadKb: Math.round(payloadBytes / 1024)
      };
    }
  }

  // Concurrency probe: 5 parallel 10k mixed parses on this warm process.
  const concurrent = repeatTo(SEEDS.mixed, 10000);
  const concStart = Date.now();
  const concLatencies = await Promise.all(
    Array.from({ length: 5 }, async () => {
      const t0 = Date.now();
      await parseJapanese(concurrent);
      return Date.now() - t0;
    })
  );
  out.concurrency = { parallel: 5, chars: 10000, wallMs: Date.now() - concStart, ...mapStats(stats(concLatencies), 'Ms') };
  out.memoryAfterMb = mapRss(rssMb());

  // Package/dictionary footprint of the pinned dependency.
  const fs = require('fs');
  const path = require('path');
  const pkgDir = path.dirname(require.resolve('@sglkc/kuromoji/package.json'));
  let total = 0;
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const size = fs.statSync(full).size;
        total += size;
        if (entry.name.endsWith('.dat.gz')) files.push({ file: path.relative(pkgDir, full), bytes: size });
      }
    }
  })(pkgDir);
  out.packageFootprint = { packageDir: pkgDir, totalBytes: total, totalMb: round3(total / 1048576), dictionaries: files };

  console.log(JSON.stringify(out, null, 1));
})().catch((error) => {
  console.error(JSON.stringify({ benchmarkFailed: error && error.code ? error.code : 'UNKNOWN' }));
  process.exit(1);
});

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function mapStats(s, suffix) {
  const mapped = {};
  for (const [k, v] of Object.entries(s)) mapped[`${k}${suffix}`] = typeof v === 'number' ? round3(v) : v;
  return mapped;
}

function mapRss(m) {
  return { rssMb: round3(m.rss), heapUsedMb: round3(m.heapUsed), heapTotalMb: round3(m.heapTotal) };
}
