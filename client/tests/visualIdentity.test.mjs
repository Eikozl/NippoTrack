// V6 identity: brand brush-mark asset contract. Static source assertions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');

function pngSize(path) {
  const buffer = readFileSync(join(root, path));
  assert.equal(buffer.subarray(1, 4).toString(), 'PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test('brand brush mark ships in both ink directions', () => {
  for (const asset of ['src/assets/logo-mark.png', 'src/assets/logo-mark-light.png']) {
    assert.ok(existsSync(join(root, asset)), `mark asset present: ${asset}`);
    const { width, height } = pngSize(asset);
    assert.equal(width, height, `${asset} is square`);
    assert.ok(width >= 256, `${asset} has icon-grade resolution`);
  }
});

test('landing masthead stays wordmark-only beside the issue line', () => {
  const sections = readSource('src/landing/sections.js');
  assert.ok(!sections.includes('masthead-seal'), 'no seal competes with the wordmark');
  assert.ok(sections.includes('landing-issue'), 'masthead issue line kept');
});

test('shell favicon carries the brand mark', () => {
  const html = readSource('index.html');
  assert.ok(html.includes('href="/favicon.png"'), 'favicon linked from public root');
  const { width } = pngSize('public/favicon.png');
  assert.ok(width >= 64, 'favicon has tab-grade resolution');
});

test('boot stroke-draw videos ship preloaded', () => {
  for (const video of ['public/videos/logo-draw-black.mp4', 'public/videos/logo-draw-orange.mp4']) {
    const buffer = readFileSync(join(root, video));
    assert.ok(buffer.includes('ftyp'), `${video} is a valid MP4`);
    assert.ok(buffer.length > 10000, `${video} carries the full pass`);
  }
  const html = readSource('index.html');
  assert.ok(html.includes('href="/videos/logo-draw-black.mp4"'), 'black pass preloaded');
  assert.ok(html.includes('href="/videos/logo-draw-orange.mp4"'), 'orange pass preloaded');
});

test('brand raster glyphs resolve through the icon API with dark support', () => {
  const icons = readSource('src/icons.js');
  assert.ok(icons.includes('RASTER_ICONS'), 'raster registry present');
  assert.ok(icons.includes('icon-vocabulary.png'), 'vocabulary art bundled');
  assert.ok(icons.includes('icon-grammar.png'), 'grammar art bundled');
  assert.ok(icons.includes("vocabulary: 'raster:vocabulary'"), 'vocabulary wired raster');
  assert.ok(icons.includes("grammar: 'raster:grammar'"), 'grammar wired raster');
  assert.ok(icons.includes('jlt-icon-img'), 'raster class hook present');
  const css = readSource('src/styles.css');
  assert.match(css, /\.jlt-icon-img \{[^}]*object-fit:\s*contain/, 'raster scales inside tiles');
  assert.match(css, /:root\[data-theme="dark"\] \.jlt-icon-img \{[^}]*filter:\s*invert\(1\)/, 'dark restores paper ink');
  for (const asset of ['src/assets/icon-vocabulary.png', 'src/assets/icon-grammar.png']) {
    assert.ok(existsSync(join(root, asset)), `glyph asset present: ${asset}`);
  }
});

test('V6 app-shell: JLPT pills are mini-hanko, streak is a brush tally', () => {
  const css = readSource('src/styles.css');
  assert.match(css, /\.status-pill\.status-jlpt \{[^}]*border-radius:\s*6px/, 'square-ish seal pill');
  assert.match(css, /\.status-pill\.status-jlpt \{[^}]*var\(--font-mono\)/, 'mono JLPT mark');
  assert.match(css, /\.streak-day\.is-active \{[^}]*background:\s*var\(--jlt-sumi\)/, 'active days are sumi dots');
});

test('V6 app-shell: kanji panel carries washi grain, icons use restrained stroke', () => {
  const css = readSource('src/styles.css');
  assert.match(css, /\.kanji-glyph-panel-large \{[^}]*repeating-linear-gradient/, 'ruled-paper grain, no image');
  const icons = readSource('src/icons.js');
  assert.ok(icons.includes("'stroke-width': 1.9"), 'library stroke untouched by the revert');
});

test('V6 app-shell: review Good stamps hanko while Again/Hard stay quiet', () => {
  const css = readSource('src/styles.css');
  assert.match(css, /\.review-grades \[data-grade="Good"\] \{[^}]*background:\s*var\(--jlt-primary\)/, 'Good signs vermilion');
  assert.match(css, /\.review-grades \[data-grade="Good"\] \{[^}]*rotate\(-1\.5deg\)/, 'pressed-stamp tilt');
  const review = readSource('src/pages/review.js');
  assert.ok(review.includes('review-grades'), 'grades row hook present');
  assert.ok(review.includes("'data-grade': result"), 'verdict rides as data, never color alone');
});

test('V6 app-shell: every page opens with a ledger running-head', () => {
  const ui = readSource('src/ui.js');
  assert.ok(ui.includes('ledger-kicker'), 'kicker hook rendered by pageHeader');
  assert.ok(ui.includes('LEDGER_GLOSS'), 'single gloss map, no per-page edits');
  for (const gloss of ['ダッシュボード', '復習', '学習記録', '語彙', '漢字', '統計']) {
    assert.ok(ui.includes(gloss), 'gloss present: ' + gloss);
  }
  assert.ok(!ui.includes("className: 'eyebrow'"), 'kicker never reuses the retired eyebrow');
  const css = readSource('src/styles.css');
  assert.match(css, /\.ledger-kicker \{[^}]*var\(--font-mono\)/, 'mono kicker voice');
  assert.match(css, /\.ledger-kicker::after \{[^}]*var\(--jlt-border\)/, 'hairline rule closes the kicker');
});

test('V6 app-shell: brand refrain rides data panels in statistics and review', () => {
  for (const path of ['src/pages/statistics.js', 'src/pages/review.js']) {
    const source = readSource(path);
    assert.ok(source.includes('ledger-refrain-app'), `refrain present in ${path}`);
    assert.ok(source.includes("text: '≠'"), `refrain marks carry meaning as text in ${path}`);
  }
  const css = readSource('src/styles.css');
  assert.match(css, /\.ledger-refrain-app \{[^}]*var\(--font-mono\)/, 'refrain speaks mono');
  assert.match(css, /\.ledger-refrain-app b \{[^}]*var\(--jlt-primary\)/, 'marks sign hanko');
});

test('V6 app-shell: sidebar stays wordmark-only, streak value sets mono', () => {
  const html = readSource('index.html');
  assert.ok(!html.includes('brand-seal'), 'no seal competes with the wordmark in the sidebar');
  assert.ok(html.includes('id="brand-logo"'), 'wordmark hook intact');
  const css = readSource('src/styles.css');
  assert.match(css, /\.streak-value \{[^}]*var\(--font-mono\)/, 'tally numerals tabular');
});

test('V6 ledger structure: ruled metrics, hairline tiles, calm nav, quiet grades', () => {
  const css = readSource('src/styles.css');
  assert.match(css, /\.dashboard-metrics \{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/, 'metrics ruled, not carded');
  assert.match(css, /\.dashboard-metrics \.metric-card \+ \.metric-card \{[^}]*border-top/, 'hairline dividers');
  assert.match(css, /\.icon-tile \{[^}]*border-radius:\s*10px/, 'square-er tiles');
  assert.match(css, /\.table-header \{[^}]*var\(--font-mono\)/, 'mono table headers');
  assert.ok(!css.includes('inset 3px 0 0'), 'selected sidebar keeps its calm wash, no orange bar');
  assert.match(css, /\.nav-group-label \{[^}]*var\(--font-mono\)/, 'mono group labels');
  assert.match(css, /\.review-grades \[data-grade="Again"\]/, 'Again quieted');
  const html = readSource('index.html');
  assert.ok(!html.includes('nav-index'), 'no enumeration in the sidebar');
  const icons = readSource('src/icons.js');
  assert.ok(icons.includes('quickAdd: Zap'), 'previous icon set fully restored');
  assert.ok(icons.includes('from \'lucide\''), 'single library, no bespoke leftovers');
  assert.ok(!icons.includes('CUSTOM_GLYPHS'), 'bespoke set fully removed');
  const dashboard = readSource('src/pages/dashboard.js');
  assert.ok(dashboard.includes('metric-label'), 'metric labels carry the hook');
  assert.ok(dashboard.includes('metric-card p-5'), 'card shape contract kept');
});

test('V6 app-shell: empty states speak ledger voice in both languages', () => {
  const ui = readSource('src/ui.js');
  assert.ok(ui.includes("title = 'A blank page in the ledger'"), 'ledger empty title');
  assert.ok(ui.includes('The ledger starts with a single entry'), 'ledger empty description');
  const i18n = readSource('src/i18n.js');
  assert.ok(i18n.includes("'A blank page in the ledger':"), 'ES key for the title');
  assert.ok(i18n.includes("'The ledger starts with a single entry"), 'ES key for the description');
});
