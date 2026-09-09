export const MAX_DISPLAY_NAME_LENGTH = 50;

export function normalizeDisplayName(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new TypeError('Display name must be text or null.');
  const trimmed = value.trim();
  if (Array.from(trimmed).length > MAX_DISPLAY_NAME_LENGTH) {
    throw new RangeError(`Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.`);
  }
  return trimmed || null;
}

export function initialsForDisplayName(value) {
  const normalized = normalizeDisplayName(value);
  if (!normalized) return '';
  const words = normalized.split(/\s+/u).filter(Boolean);
  if (words.length === 1) return Array.from(words[0])[0] || '';
  const first = Array.from(words[0])[0] || '';
  const last = Array.from(words.at(-1))[0] || '';
  return `${first}${last}`;
}

export function normalizeProfile(value = {}) {
  let displayName = null;
  try { displayName = normalizeDisplayName(value?.displayName ?? value?.display_name); } catch { displayName = null; }
  const email = typeof value?.email === 'string' && value.email.trim() ? value.email.trim() : null;
  return {
    displayName,
    initials: initialsForDisplayName(displayName),
    email,
    updatedAt: value?.updatedAt ?? value?.updated_at ?? null
  };
}

export function createProfileStore(request) {
  if (typeof request !== 'function') throw new TypeError('Profile store requires a request function.');
  let profile = null;
  let loaded = false;
  let pending = null;

  function load({ force = false } = {}) {
    if (!force && loaded) return Promise.resolve(profile);
    if (pending && !force) return pending;
    pending = Promise.resolve(request('/api/profile')).then((payload) => {
      profile = normalizeProfile(payload);
      loaded = true;
      return profile;
    }).finally(() => { pending = null; });
    return pending;
  }

  function save(displayName) {
    const normalized = normalizeDisplayName(displayName);
    return Promise.resolve(request('/api/profile', {
      method: 'PUT',
      body: { display_name: normalized }
    })).then((payload) => {
      profile = normalizeProfile(payload);
      loaded = true;
      return profile;
    });
  }

  return {
    load,
    save,
    setEmail: (email) => {
      profile = normalizeProfile({ ...(profile || {}), email });
      return profile;
    },
    get: () => profile,
    reset: () => { profile = null; loaded = false; pending = null; }
  };
}

// Keep the profile model usable in DOM-free tests and avoid eagerly pulling
// the network client into routes that do not open the account surface.
const defaultRequest = (...args) => import('./api.js').then(({ apiRequest }) => apiRequest(...args));
export const profileStore = createProfileStore(defaultRequest);
