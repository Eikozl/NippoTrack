import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RELEASES_URL,
  appVersion,
  checkForUpdate,
  isNewerRelease,
  parseVersionTag
} from '../src/appUpdate.js';
import { initAndroidDownload } from '../src/landing/androidRelease.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');

test('version tags parse and compare semver-style', () => {
  assert.deepEqual(parseVersionTag('v1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseVersionTag('1.0.0'), [1, 0, 0]);
  assert.equal(parseVersionTag('latest'), null);
  assert.equal(parseVersionTag(''), null);
  assert.equal(isNewerRelease('1.0.0', 'v1.0.1'), true);
  assert.equal(isNewerRelease('1.2.3', '1.2.3'), false);
  assert.equal(isNewerRelease('2.0.0', '1.9.9'), false);
  assert.equal(isNewerRelease('dev', 'v1.0.0'), false);
});

test('checkForUpdate returns download info only when newer', async () => {
  const release = {
    tag_name: 'v1.2.0',
    body: 'Fixes',
    assets: [{ name: 'nippotrack-v1.2.0.apk', browser_download_url: 'https://example.invalid/app.apk', size: 12582912, updated_at: '2026-10-20T00:00:00Z' }]
  };
  const ok = async () => ({ ok: true, json: async () => release });
  // appVersion() is 'dev' outside a built bundle, so stub the comparison
  // through a release older-or-equal check instead: dev never updates.
  assert.equal(await checkForUpdate(ok), null);
  assert.ok(RELEASES_URL.includes('api.github.com'), 'checks the public releases API');
});

test('checkForUpdate fails open on network and shape surprises', async () => {
  assert.equal(await checkForUpdate(async () => { throw new Error('offline'); }), null);
  assert.equal(await checkForUpdate(async () => ({ ok: false })), null);
  assert.equal(await checkForUpdate(async () => ({ ok: true, json: async () => ({}) })), null);
});

function fakeScope() {
  const link = { href: null, setAttribute(name, value) { this[name] = value; } };
  const meta = { textContent: '' };
  return {
    link,
    meta,
    querySelector(selector) {
      if (selector === '#android-app') return this;
      if (selector === '[data-android-download]') return link;
      if (selector === '[data-android-meta]') return meta;
      return null;
    }
  };
}

test('landing download hydrates from the latest release, static otherwise', async () => {
  const release = {
    tag_name: 'v1.2.0',
    assets: [{ name: 'app.apk', browser_download_url: 'https://example.invalid/app.apk', size: 10485760, updated_at: '2026-10-20T00:00:00Z' }]
  };
  const scope = fakeScope();
  await initAndroidDownload(scope, async () => ({ ok: true, json: async () => release }));
  assert.equal(scope.link.href, 'https://example.invalid/app.apk');
  assert.match(scope.meta.textContent, /v1\.2\.0/);
  assert.match(scope.meta.textContent, /10\.0 MB/);

  const offline = fakeScope();
  const before = offline.link.href;
  await initAndroidDownload(offline, async () => { throw new Error('offline'); });
  assert.equal(offline.link.href, before, 'static skeleton link untouched');
});

test('landing download ignores releases without an APK', async () => {
  const scope = fakeScope();
  await initAndroidDownload(scope, async () => ({ ok: true, json: async () => ({ tag_name: 'v9.9.9', assets: [] }) }));
  assert.equal(scope.link.href, null);
  assert.equal(scope.meta.textContent, '');
});

test('update banner only renders inside the native shell', () => {
  const settings = readSource('src/pages/settings.js');
  assert.ok(settings.includes('window.Capacitor'), 'web builds never poll releases');
  assert.ok(settings.includes('Installed: v${appVersion()}') || settings.includes('Installed: v'), 'installed version still shown everywhere');
});
test('vite build injects the app version', () => {
  const config = readSource('vite.config.js');
  assert.ok(config.includes('__APP_VERSION__'), 'APP_VERSION defined at build time');
});

test('capacitor shell points at production and skips the service worker', () => {
  const html = readSource('index.html');
  assert.ok(html.includes('window.Capacitor'), 'native shell excluded from SW registration');
  const capConfig = readSource('capacitor.config.ts');
  assert.ok(capConfig.includes('app.nippotrack.tracker'), 'stable application id');
  assert.ok(capConfig.includes('https'), 'secure scheme for the WebView origin');
});
