// In-app update check for the sideloaded Android APK (no Play Store).
// Compares the compiled APP_VERSION against the latest GitHub release and
// returns download info when the release is newer. Fail-open by design:
// network or shape surprises resolve to null (no banner, no error).
// Pure and DOM-free so it is unit-testable under node:test.
export const UPDATE_REPO = 'Eikozl/NippoTrack';
export const RELEASES_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;

export function appVersion() {
  try {
    const value = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
    return typeof value === 'string' && value ? value : 'dev';
  } catch {
    return 'dev';
  }
}

export function parseVersionTag(tag) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(tag || '').trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isNewerRelease(current, latest) {
  const from = parseVersionTag(current);
  const to = parseVersionTag(latest);
  if (!from || !to) return false;
  for (let index = 0; index < 3; index += 1) {
    if (to[index] !== from[index]) return to[index] > from[index];
  }
  return false;
}

function pickApkAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  return assets.find((asset) => typeof asset?.browser_download_url === 'string' && /\.apk$/i.test(asset.name || '')) || null;
}

export async function checkForUpdate(fetchImpl = fetch) {
  try {
    const current = appVersion();
    if (current === 'dev') return null;
    const response = await fetchImpl(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' } });
    if (!response || !response.ok) return null;
    const release = await response.json();
    const tag = typeof release?.tag_name === 'string' ? release.tag_name : '';
    if (!isNewerRelease(current, tag)) return null;
    const asset = pickApkAsset(release);
    if (!asset) return null;
    return {
      version: tag.replace(/^v/, ''),
      url: asset.browser_download_url,
      size: Number(asset.size) || null,
      notes: typeof release?.body === 'string' ? release.body.slice(0, 500) : ''
    };
  } catch {
    return null;
  }
}
