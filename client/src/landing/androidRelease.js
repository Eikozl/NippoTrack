// Hydrates the landing Android section with the latest GitHub release:
// download URL, version, size and date. Fail-open: the static skeleton
// (link to /releases/latest) keeps working when the API is unreachable.
import { RELEASES_URL } from '../appUpdate.js';

function formatBytes(size) {
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function formatDate(iso) {
  const time = Date.parse(String(iso || ''));
  if (Number.isNaN(time)) return null;
  return new Date(time).toISOString().slice(0, 10);
}

function pickApkAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  return assets.find((asset) => typeof asset?.browser_download_url === 'string' && /\.apk$/i.test(asset.name || '')) || null;
}

export async function initAndroidDownload(root, fetchImpl = fetch) {
  const scope = root?.querySelector ? root.querySelector('#android-app') : null;
  if (!scope) return;
  const link = scope.querySelector('[data-android-download]');
  const meta = scope.querySelector('[data-android-meta]');
  let release = null;
  try {
    const response = await fetchImpl(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' } });
    if (response && response.ok) release = await response.json();
  } catch {
    release = null;
  }
  if (!release) return;
  const asset = pickApkAsset(release);
  if (!asset) return;
  if (link) link.setAttribute('href', asset.browser_download_url);
  if (!meta) return;
  const parts = [];
  const version = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : '';
  if (version) parts.push(`v${version}`);
  const size = formatBytes(asset.size);
  if (size) parts.push(size);
  const date = formatDate(asset.updated_at);
  if (date) parts.push(date);
  if (parts.length) meta.textContent = `Latest: ${parts.join(' · ')}`;
}
