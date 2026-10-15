// Hero "Download on Android": points at the latest APK asset and downloads
// it in place (blob fetch) so the visitor never leaves the landing. Falls
// back to plain navigation when the fetch fails (offline, CORS, no release).
// Fail-open everywhere: without JS or without a release, the static href
// (releases/latest) still works. DOM/URL primitives are injectable for tests.
import { RELEASES_URL } from '../appUpdate.js';

function pickApkAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  return assets.find((asset) => typeof asset?.browser_download_url === 'string' && /\.apk$/i.test(asset.name || '')) || null;
}

function fileNameFromUrl(url, fallback) {
  try {
    const last = String(url).split('?')[0].split('/').pop();
    return last && last.toLowerCase().endsWith('.apk') ? last : fallback;
  } catch {
    return fallback;
  }
}

export async function resolveApkUrl(fetchImpl = fetch) {
  try {
    const response = await fetchImpl(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' } });
    if (!response || !response.ok) return null;
    const asset = pickApkAsset(await response.json());
    return asset ? asset.browser_download_url : null;
  } catch {
    return null;
  }
}

export async function downloadApk(url, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const createUrl = deps.createObjectURL || ((blob) => URL.createObjectURL(blob));
  const revokeUrl = deps.revokeObjectURL || ((objectUrl) => URL.revokeObjectURL(objectUrl));
  const createAnchor = deps.createAnchor || (() => document.createElement('a'));
  const response = await fetchImpl(url);
  if (!response || !response.ok) throw new Error(`download failed: ${response?.status || 'network'}`);
  const blob = await response.blob();
  const objectUrl = createUrl(blob);
  try {
    const anchor = createAnchor();
    anchor.href = objectUrl;
    anchor.download = fileNameFromUrl(url, 'nippotrack-android.apk');
    anchor.rel = 'noopener';
    anchor.click();
  } finally {
    if (typeof queueMicrotask === 'function') queueMicrotask(() => revokeUrl(objectUrl));
    else setTimeout(() => revokeUrl(objectUrl), 0);
  }
  return true;
}

export async function initAndroidDownload(root, fetchImpl = fetch) {
  const scope = root?.querySelector ? root.querySelector('.landing-hero') || root : root;
  const button = scope?.querySelector ? scope.querySelector('[data-android-download]') : null;
  if (!button) return;
  const url = await resolveApkUrl(fetchImpl);
  if (!url) return;
  button.setAttribute('href', url);
  button.addEventListener('click', (event) => {
    event.preventDefault();
    if (button.dataset.downloading) return;
    button.dataset.downloading = '1';
    const original = button.textContent;
    button.textContent = 'Downloading…';
    downloadApk(url, { fetch: fetchImpl })
      .catch(() => {
        // Fallback: let the browser navigate to the asset directly.
        window.location.assign(url);
      })
      .finally(() => {
        delete button.dataset.downloading;
        button.textContent = original;
      });
  }, { once: false });
}
