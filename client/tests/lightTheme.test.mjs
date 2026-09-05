import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'src/styles.css'), 'utf8');
const mainSource = readFileSync(join(root, 'src/main.js'), 'utf8');
const entityPageSource = readFileSync(join(root, 'src/pages/entityPage.js'), 'utf8');

// --- helpers ---------------------------------------------------------------

function lightBlock() {
  const match = css.match(/:root\s*\{([\s\S]*?)\}\s*:root\[data-theme="dark"\]/);
  assert.ok(match, 'light :root block exists before the dark override');
  return match[1];
}

function darkBlock() {
  const match = css.match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\}/);
  assert.ok(match, 'dark :root block exists');
  return match[1];
}

function token(block, name) {
  const match = block.match(new RegExp(`${name}:\\s*([^;]+);`));
  assert.ok(match, `${name} token exists`);
  return match[1].trim();
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((ch) => ch + ch).join('') : clean;
  return [0, 2, 4].map((offset) => parseInt(full.slice(offset, offset + 2), 16));
}

function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground, background) {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

// Warm-neutral guard: red dominates, blue is lowest (no cool gray, no blue
// tint), and saturation stays modest (no yellow/sepia/mud).
function isWarmNeutral(hex, maxSaturation) {
  const [r, g, b] = hexToRgb(hex);
  if (!(r >= g && g >= b)) return false;
  return (r - b) / r <= maxSaturation;
}

// Yellow guard: in true yellows green sits almost as high as red while blue
// collapses; creams keep green roughly midway between red and blue.
function isNotYellow(hex) {
  const [r, g, b] = hexToRgb(hex);
  if (r === b) return true;
  return (g - b) / (r - b) <= 0.75;
}

// --- light palette ----------------------------------------------------------

test('Light theme: Almond/Mocha layered tokens', () => {
  const block = lightBlock();
  assert.equal(token(block, '--jlt-bg'), '#EDD9C0');
  assert.equal(token(block, '--jlt-surface'), '#FFF4E3');
  assert.equal(token(block, '--jlt-surface-soft'), '#EAD9C1');
  assert.equal(token(block, '--jlt-border'), '#C9AF94');
  assert.equal(token(block, '--jlt-ink'), '#2A2522');
  assert.equal(token(block, '--jlt-muted'), '#6A564D');
  assert.equal(token(block, '--jlt-primary'), '#78564A');
  assert.equal(token(block, '--jlt-primary-strong'), '#6B4A3F');
  assert.equal(token(block, '--jlt-primary-soft'), '#EBD6BC');
  assert.notEqual(token(block, '--jlt-bg'), token(block, '--jlt-surface'), 'page and cards differ');
  assert.ok(luminance('#EDD9C0') < luminance('#FFF4E3'), 'cards elevate above the page');
});

test('Light theme: warm, desaturated neutrals — never yellow, sepia, or cool gray', () => {
  const block = lightBlock();
  for (const name of ['--jlt-bg', '--jlt-surface', '--jlt-surface-soft', '--jlt-border']) {
    const value = token(block, name);
    assert.ok(isWarmNeutral(value, 0.28), `${name} (${value}) is a soft warm neutral`);
    assert.ok(isNotYellow(value), `${name} (${value}) has no yellow cast`);
  }
  for (const name of ['--jlt-ink', '--jlt-muted', '--jlt-primary', '--jlt-primary-strong']) {
    const [r, g, b] = hexToRgb(token(block, name));
    assert.ok(r >= g && g >= b, `${name} stays in the warm family`);
  }
});

test('Light theme: secondary soft surfaces use the centralized token', () => {
  assert.match(css, /\.kanji-reference-candidates \{[^}]*background:\s*var\(--jlt-surface-soft\)/);
});

test('Light theme: white-on-white hover rows keep visible feedback (centralized)', () => {
  assert.match(css, /:root:not\(\[data-theme="dark"\]\) \.hover\\:bg-paper:hover \{\s*background-color:\s*var\(--jlt-surface-soft\);/);
  assert.match(css, /:root:not\(\[data-theme="dark"\]\) \.hover\\:bg-white:hover \{\s*background-color:\s*var\(--jlt-surface-soft\);/);
});

test('Light theme: browser chrome tint follows the Almond page', () => {
  assert.match(mainSource, /'#EDD9C0'/);
  assert.doesNotMatch(mainSource, /'#eef1f7'/);
});

// --- light contrast ----------------------------------------------------------

test('Light theme: text contrast meets WCAG AA on warm surfaces', () => {
  const block = lightBlock();
  const bg = token(block, '--jlt-bg');
  const surface = token(block, '--jlt-surface');
  const soft = token(block, '--jlt-surface-soft');
  const ink = token(block, '--jlt-ink');
  const muted = token(block, '--jlt-muted');
  const primary = token(block, '--jlt-primary');
  const strong = token(block, '--jlt-primary-strong');
  assert.ok(contrastRatio(ink, surface) >= 7, `primary text on cards: ${contrastRatio(ink, surface).toFixed(2)}`);
  assert.ok(contrastRatio(ink, bg) >= 7, `primary text on page: ${contrastRatio(ink, bg).toFixed(2)}`);
  assert.ok(contrastRatio(muted, surface) >= 4.5, `secondary text on cards: ${contrastRatio(muted, surface).toFixed(2)}`);
  assert.ok(contrastRatio(muted, bg) >= 4.5, `secondary text on page: ${contrastRatio(muted, bg).toFixed(2)}`);
  assert.ok(contrastRatio(muted, soft) >= 4.5, `secondary text on soft surfaces: ${contrastRatio(muted, soft).toFixed(2)}`);
  assert.ok(contrastRatio(primary, surface) >= 4.5, `mocha accents/links on cards: ${contrastRatio(primary, surface).toFixed(2)}`);
  assert.ok(contrastRatio(primary, bg) >= 4.5, `mocha accents on page: ${contrastRatio(primary, bg).toFixed(2)}`);
  assert.ok(contrastRatio('#ffffff', strong) >= 4.5, `white button text on strong mocha: ${contrastRatio('#ffffff', strong).toFixed(2)}`);
  assert.ok(contrastRatio('#ffffff', primary) >= 4.5, `white text on mocha: ${contrastRatio('#ffffff', primary).toFixed(2)}`);
  assert.ok(contrastRatio('#FFF7ED', strong) >= 4.5, `cream calendar text on strong mocha: ${contrastRatio('#FFF7ED', strong).toFixed(2)}`);
  // Destructive actions keep their Tailwind red on light surfaces.
  assert.ok(contrastRatio('#b91c1c', '#ffffff') >= 4.5, `destructive red on white: ${contrastRatio('#b91c1c', '#ffffff').toFixed(2)}`);
});

// --- dark accents ------------------------------------------------------------

test('Dark theme: surfaces unchanged, accent shifts blue → light Mocha', () => {
  const block = darkBlock();
  assert.ok(block.includes('--jlt-bg: #202428; --jlt-surface: #202428; --jlt-border: #30363c;'));
  assert.ok(block.includes('--jlt-ink: #f4f7fb; --jlt-muted: #c3cedd;'));
  assert.equal(token(block, '--jlt-primary'), '#C9AEA6');
  assert.equal(token(block, '--jlt-primary-strong'), '#D8C2B9');
  assert.equal(token(block, '--jlt-primary-soft'), '#3B2F29');
  const [r, g, b] = hexToRgb(token(block, '--jlt-primary'));
  assert.ok(r >= g && g >= b, 'dark accent joins the warm family');
});

test('Dark theme: light Mocha accents stay readable on charcoal', () => {
  const block = darkBlock();
  const bg = token(block, '--jlt-bg');
  const primary = token(block, '--jlt-primary');
  assert.ok(contrastRatio(primary, bg) >= 4.5, `dark accent on charcoal: ${contrastRatio(primary, bg).toFixed(2)}`);
  assert.ok(contrastRatio('#241F1C', primary) >= 4.5, `dark button/calendar text on accent: ${contrastRatio('#241F1C', primary).toFixed(2)}`);
  assert.match(css, /:root\[data-theme="dark"\] \.button-primary \{[^}]*background:\s*var\(--jlt-primary\)/);
  assert.match(css, /#app-content \.activity-calendar-day\.bg-vermilion \{[^}]*background:\s*var\(--jlt-primary-strong\)[^}]*color:\s*#FFF7ED/);
  assert.match(css, /:root\[data-theme="dark"\] #app-content \.activity-calendar-day\.bg-vermilion \{[^}]*background:\s*var\(--jlt-primary\)[^}]*color:\s*#241F1C/);
});

// --- blue audit + semantic preservation ---------------------------------------

test('Theme: no leftover cool-blue brand tokens', () => {
  assert.doesNotMatch(css, /#1f56d2|#dde7ff|#9db4ff|#b7c9ff|#3559b3|#121a32|#1746b1|#2b385b|#b9c9ff|#b7c8ff|#eef1f7/i);
  assert.doesNotMatch(css, /145,\s*157,\s*181|150,\s*163,\s*181|128,\s*141,\s*169/);
});

test('Theme: semantic colors preserved (destructive, warning, status, streak)', () => {
  assert.match(css, /\.button-danger/);
  assert.match(css, /amber/);
  assert.match(css, /#e03145/);
  assert.match(entityPageSource, /bg-emerald/);
});

test('Theme: focus indicators and disabled states remain visible', () => {
  assert.match(css, /button:focus-visible[^{]*\{[^}]*outline-vermilion/);
  assert.match(css, /disabled:opacity-55/);
  assert.match(css, /disabled:cursor-not-allowed/);
});

test('Theme: global loading overlay stays readable (dark scrim, white card)', () => {
  assert.match(css, /\.global-loading-overlay \{[^}]*background:\s*rgb\(0 0 0 \/ 0\.45\)/);
  assert.match(css, /\.global-loading-card \{[^}]*color:\s*#fff/);
});

test('Theme: level-estimate morph follows the token system', () => {
  assert.match(css, /\.level-estimate-morph \{[^}]*background:\s*var\(--jlt-surface\)/);
  assert.match(css, /\.level-estimate-face \{[^}]*color:\s*var\(--jlt-ink\)/);
});
