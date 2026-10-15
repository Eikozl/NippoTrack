import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');

function pngSize(path) {
  const buffer = readFileSync(join(root, path));
  assert.equal(buffer.subarray(1, 4).toString(), 'PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test('PWA manifest is valid and references installable icons', () => {
  const manifest = JSON.parse(readSource('public/manifest.webmanifest'));
  assert.equal(manifest.name.includes('NippoTrack'), true);
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  const sizes = new Set();
  for (const icon of manifest.icons) {
    assert.ok(existsSync(join(root, 'public', icon.src.replace(/^\//, ''))), `icon file exists: ${icon.src}`);
    const { width, height } = pngSize(join('public', icon.src.replace(/^\//, '')));
    const [w, h] = icon.sizes.split('x').map(Number);
    assert.equal(width, w);
    assert.equal(height, h);
    sizes.add(`${icon.sizes}+${icon.purpose}`);
  }
  assert.ok(sizes.has('192x192+any'));
  assert.ok(sizes.has('512x512+any'));
  assert.ok([...sizes].some((entry) => entry.endsWith('+maskable')), 'maskable icon present');
});

test('service worker caches shell only and never the API', () => {
  const source = readSource('public/sw.js');
  assert.ok(source.includes('addEventListener'), 'lifecycle handlers present');
  assert.ok(source.includes('/offline.html'), 'offline fallback present');
  assert.ok(source.includes('/api'), 'API referenced');
  assert.ok(/isApiRequest|startsWith\(['"]\/api/.test(source), 'API requests bypass the cache');
  assert.ok(/request\.method !== ['"]GET['"]/.test(source), 'only GET requests intercepted');
  assert.match(source, /nippotrack-shell-v\d+/, 'versioned cache name');
});

test('index.html wires PWA without touching the native shell', () => {
  const html = readSource('index.html');
  assert.ok(html.includes('rel="manifest"'), 'manifest linked');
  assert.ok(html.includes('apple-touch-icon'), 'iOS icon linked');
  assert.ok(html.includes('serviceWorker'), 'registration snippet present');
  assert.ok(html.includes('window.Capacitor'), 'Capacitor builds skip registration');
  assert.ok(html.includes("https:"), 'insecure origins skipped');
});
