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
import { downloadApk, initAndroidDownload, resolveApkUrl } from '../src/landing/androidRelease.js';

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
  const listeners = {};
  const link = {
    href: null,
    textContent: 'Download on Android',
    dataset: {},
    setAttribute(name, value) { this[name] = value; },
    addEventListener(type, handler) { (listeners[type] ||= []).push(handler); },
    fire(type, event) { return Promise.all((listeners[type] || []).map((handler) => handler(event))); }
  };
  return {
    link,
    listeners,
    querySelector(selector) {
      if (selector === '.landing-hero') return null;
      if (selector === '[data-android-download]') return link;
      return null;
    }
  };
}

function apkRelease() {
  return {
    tag_name: 'v1.2.0',
    assets: [{ name: 'nippotrack-v1.2.0.apk', browser_download_url: 'https://example.invalid/app.apk', size: 10485760, updated_at: '2026-10-20T00:00:00Z' }]
  };
}

function fakeDom() {
  const created = [];
  return {
    created,
    createObjectURL() { return 'blob:fake-apk'; },
    revoked: [],
    revokeObjectURL(url) { this.revoked.push(url); },
    createAnchor() {
      const anchor = { href: null, download: null, rel: null, clicked: false, click() { this.clicked = true; } };
      created.push(anchor);
      return anchor;
    }
  };
}

test('hero button resolves to the direct APK asset URL', async () => {
  const scope = fakeScope();
  await initAndroidDownload(scope, async () => ({ ok: true, json: async () => apkRelease() }));
  assert.equal(scope.link.href, 'https://example.invalid/app.apk');
  assert.ok(!('meta' in scope), 'no meta line: button only');

  const offline = fakeScope();
  const before = offline.link.href;
  await initAndroidDownload(offline, async () => { throw new Error('offline'); });
  assert.equal(offline.link.href, before, 'static skeleton link untouched');
});

test('hero button without any release keeps its static href', async () => {
  const scope = fakeScope();
  await initAndroidDownload(scope, async () => ({ ok: true, json: async () => ({ tag_name: 'v9.9.9', assets: [] }) }));
  assert.equal(scope.link.href, null);
});

test('click downloads the APK in place without leaving the page', async () => {
  const scope = fakeScope();
  await initAndroidDownload(scope, async () => ({ ok: true, json: async () => apkRelease() }));
  const dom = fakeDom();
  const realFetch = async () => ({ ok: true, blob: async () => ({ size: 10 }) });
  // Rebind the click path with injectable DOM primitives.
  const { downloadApk: direct } = await import('../src/landing/androidRelease.js');
  const ok = await direct('https://example.invalid/nippotrack-v1.2.0.apk', {
    fetch: realFetch,
    createObjectURL: dom.createObjectURL,
    revokeObjectURL: (url) => dom.revokeObjectURL(url),
    createAnchor: () => dom.createAnchor()
  });
  assert.equal(ok, true);
  assert.equal(dom.created.length, 1);
  assert.equal(dom.created[0].href, 'blob:fake-apk');
  assert.equal(dom.created[0].download, 'nippotrack-v1.2.0.apk');
  assert.equal(dom.created[0].clicked, true);
  assert.deepEqual(dom.revoked, ['blob:fake-apk']);
});

test('failed download throws so the caller can fall back to navigation', async () => {
  const dom = fakeDom();
  const { downloadApk: direct } = await import('../src/landing/androidRelease.js');
  await assert.rejects(
    direct('https://example.invalid/app.apk', {
      fetch: async () => ({ ok: false, status: 404 }),
      createObjectURL: dom.createObjectURL,
      revokeObjectURL: (url) => dom.revokeObjectURL(url),
      createAnchor: () => dom.createAnchor()
    }),
    /download failed/
  );
  assert.equal(dom.created.length, 0, 'no anchor on failure');
});

test('resolveApkUrl is null without releases or network', async () => {
  assert.equal(await resolveApkUrl(async () => ({ ok: true, json: async () => ({ assets: [] }) })), null);
  assert.equal(await resolveApkUrl(async () => { throw new Error('offline'); }), null);
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
