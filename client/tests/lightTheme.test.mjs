import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'src/styles.css'), 'utf8');
const tokens = readFileSync(join(root, 'src/tokens.css'), 'utf8');
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

function ntToken(name) {
  const match = tokens.match(new RegExp(`${name}:\\s*([^;]+);`));
  assert.ok(match, `canonical ${name} exists in tokens.css`);
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

// --- canonical tokens -------------------------------------------------------

test('Canonical NippoTrack tokens match the study-ledger palette', () => {
  assert.equal(ntToken('--nt-canvas'), '#F5F0E8');
  assert.equal(ntToken('--nt-surface'), '#FFFCF7');
  assert.equal(ntToken('--nt-surface-muted'), '#ECE5D8');
  assert.equal(ntToken('--nt-text'), '#1B1713');
  assert.equal(ntToken('--nt-accent'), '#B3402E');
  assert.equal(ntToken('--nt-accent-hover'), '#93331F');
  assert.equal(ntToken('--nt-accent-soft'), '#F3DDD6');
  assert.equal(ntToken('--nt-sumi'), '#1C1A18');
  assert.equal(ntToken('--nt-sumi-contrast'), '#FFFCF7');
  assert.ok(tokens.includes('--nt-surface-raised'));
  assert.ok(tokens.includes('--nt-text-secondary'));
  assert.ok(tokens.includes('--nt-border'));
  assert.ok(tokens.includes('--nt-focus-ring'));
  assert.ok(tokens.includes('--nt-space-1'));
  assert.ok(tokens.includes('--nt-transition-base'));
  assert.ok(tokens.includes('--nt-radius-sm'));
  assert.ok(tokens.includes('--nt-radius-full'));
  // Dark canonical values.
  for (const dark of ['#1C1A18', '#24211E', '#2B2723', '#F5F0E8', '#B8AEA4', '#3A3530', '#D98A6F']) {
    assert.ok(tokens.toLowerCase().includes(dark.toLowerCase()), 'dark canonical present: ' + dark);
  }
});

// --- light aliases ----------------------------------------------------------

test('Light theme: app tokens alias the canonical layer (sumi + hanko)', () => {
  const block = lightBlock();
  assert.equal(token(block, '--jlt-bg'), 'var(--nt-canvas)');
  assert.equal(token(block, '--jlt-surface'), 'var(--nt-surface)');
  assert.equal(token(block, '--jlt-surface-soft'), 'var(--nt-surface-muted)');
  assert.equal(token(block, '--jlt-border'), 'var(--nt-border)');
  assert.equal(token(block, '--jlt-ink'), 'var(--nt-text)');
  assert.equal(token(block, '--jlt-primary'), 'var(--nt-accent)');
  assert.equal(token(block, '--jlt-primary-strong'), 'var(--nt-accent-hover)');
  assert.equal(token(block, '--jlt-primary-soft'), 'var(--nt-accent-soft)');
  // No Almond/Mocha literals remain in the app theme.
  assert.doesNotMatch(block, /#EDD9C0|#FFF4E3|#EAD9C1|#C9AF94|#78564A|#6B4A3F|#EBD6BC/);
});

test('Light theme: secondary soft surfaces use the centralized token', () => {
  assert.match(css, /\.kanji-reference-candidates \{[^}]*background:\s*var\(--jlt-surface-soft\)/);
});

test('Light theme: white-on-white hover rows keep visible feedback (centralized)', () => {
  assert.match(css, /:root:not\(\[data-theme="dark"\]\) \.hover\\:bg-paper:hover \{\s*background-color:\s*var\(--jlt-surface-soft\);/);
  assert.match(css, /:root:not\(\[data-theme="dark"\]\) \.hover\\:bg-white:hover \{\s*background-color:\s*var\(--jlt-surface-soft\);/);
});

test('Light theme: browser chrome tint follows the NippoTrack canvas', () => {
  const appTheme = readFileSync(join(root, 'src/appTheme.js'), 'utf8');
  assert.ok(appTheme.includes('#F5F0E8') && appTheme.includes('#1C1A18'), 'canonical meta pair lives in appTheme');
  assert.ok(mainSource.includes('APP_THEME_META'), 'shell meta follows the canonical pair');
  assert.doesNotMatch(mainSource, /'#EDD9C0'/);
  assert.doesNotMatch(mainSource, /'#eef1f7'/);
});

// --- light contrast ----------------------------------------------------------

test('Light theme: text contrast meets WCAG AA on canonical surfaces', () => {
  const bg = '#F5F0E8';
  const surface = '#FFFCF7';
  const soft = '#ECE5D8';
  const ink = '#1B1713';
  const muted = '#5C5853';
  const primary = '#B3402E';
  const strong = '#93331F';
  assert.ok(contrastRatio(ink, surface) >= 7, `primary text on cards: ${contrastRatio(ink, surface).toFixed(2)}`);
  assert.ok(contrastRatio(ink, bg) >= 7, `primary text on page: ${contrastRatio(ink, bg).toFixed(2)}`);
  assert.ok(contrastRatio(muted, surface) >= 4.5, `secondary text on cards: ${contrastRatio(muted, surface).toFixed(2)}`);
  assert.ok(contrastRatio(muted, bg) >= 4.5, `secondary text on page: ${contrastRatio(muted, bg).toFixed(2)}`);
  assert.ok(contrastRatio(muted, soft) >= 4.5, `secondary text on soft surfaces: ${contrastRatio(muted, soft).toFixed(2)}`);
  assert.ok(contrastRatio(primary, surface) >= 4.5, `hanko accents/links on cards: ${contrastRatio(primary, surface).toFixed(2)}`);
  assert.ok(contrastRatio(primary, bg) >= 4.5, `hanko accents on page: ${contrastRatio(primary, bg).toFixed(2)}`);
  assert.ok(contrastRatio('#ffffff', strong) >= 4.5, `white button text on hover hanko: ${contrastRatio('#ffffff', strong).toFixed(2)}`);
  assert.ok(contrastRatio('#ffffff', primary) >= 4.5, `white text on hanko: ${contrastRatio('#ffffff', primary).toFixed(2)}`);
  // Destructive actions keep their Tailwind red on light surfaces.
  assert.ok(contrastRatio('#b91c1c', '#ffffff') >= 4.5, `destructive red on white: ${contrastRatio('#b91c1c', '#ffffff').toFixed(2)}`);
});

// --- dark aliases ------------------------------------------------------------

test('Dark theme: app tokens alias the canonical dark layer', () => {
  const block = darkBlock();
  assert.equal(token(block, '--jlt-bg'), 'var(--nt-canvas)');
  assert.equal(token(block, '--jlt-surface'), 'var(--nt-surface)');
  assert.equal(token(block, '--jlt-surface-soft'), 'var(--nt-surface-muted)');
  assert.equal(token(block, '--jlt-primary'), 'var(--nt-accent)');
  assert.equal(token(block, '--jlt-primary-strong'), 'var(--nt-accent-hover)');
  assert.equal(token(block, '--jlt-primary-soft'), 'var(--nt-accent-soft)');
  assert.doesNotMatch(block, /#202428[^;]*#202428[^;]*#30363c/);
});

test('Dark theme: canonical hanko accents stay readable on sumi', () => {
  const bg = '#1C1A18';
  const soft = '#2B2723';
  const muted = '#B8AEA4';
  const primary = '#D98A6F';
  assert.ok(contrastRatio(muted, soft) >= 4.5, `dark secondary text on soft surfaces: ${contrastRatio(muted, soft).toFixed(2)}`);
  assert.ok(contrastRatio(primary, bg) >= 4.5, `dark accent on canvas: ${contrastRatio(primary, bg).toFixed(2)}`);
  assert.ok(contrastRatio('#1C1A18', primary) >= 4.5, `dark button text on accent: ${contrastRatio('#1C1A18', primary).toFixed(2)}`);
  assert.match(css, /:root\[data-theme="dark"\] \.button-primary \{[^}]*background:\s*var\(--jlt-sumi\)/);
});

// --- blue audit + semantic preservation ---------------------------------------

test('Theme: no leftover Almond/Mocha or cool-blue brand tokens', () => {
  // Auth brand panel is frozen (auth visuals untouched) and keeps its own
  // gradient; audit only the theme token layer + @theme mapping.
  const themeLayer = css.slice(0, css.indexOf('@layer components'));
  assert.doesNotMatch(themeLayer, /#EDD9C0|#FFF4E3|#EAD9C1|#C9AF94|#78564A|#6B4A3F|#EBD6BC|#C9AEA6|#D8C2B9|#3B2F29/);
  assert.doesNotMatch(themeLayer, /#1f56d2|#dde7ff|#9db4ff|#b7c9ff|#3559b3|#121a32|#1746b1|#2b385b|#b9c9ff|#b7c8ff|#eef1f7/i);
  assert.doesNotMatch(themeLayer, /145,\s*157,\s*181|150,\s*163,\s*181|128,\s*141,\s*169/);
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
  assert.match(css, /\.jlpt-progress-track \{[^}]*background:\s*var\(--jlt-surface-soft\)/);
  assert.match(css, /\.jlpt-progress-fill \{[^}]*background:\s*var\(--jlt-primary\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.jlpt-progress-fill \{ transition: none; \} \}/);
  assert.match(css, /\.level-estimate-morph \{[^}]*background:\s*var\(--jlt-surface\)/);
  assert.match(css, /\.level-estimate-face \{[^}]*color:\s*var\(--jlt-ink\)/);
});
