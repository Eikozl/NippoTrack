const LEGACY_APP_ROUTES = new Set([
  'dashboard', 'review', 'sessions', 'goals', 'vocabulary', 'kanji',
  'grammar', 'notes', 'content', 'analyzer', 'statistics', 'settings', 'tags'
]);

export function authViewFromSearch(search = '') {
  return new URLSearchParams(search).get('auth') === 'sign-up' ? 'sign-up' : 'sign-in';
}

export function resolveExperience({ pathname = '/', hash = '' } = {}) {
  const normalizedPath = pathname.replace(/\/+$/, '') || '/';
  if (normalizedPath === '/app') return 'app';

  const legacyRoute = hash.replace(/^#/, '').split('?')[0];
  if (LEGACY_APP_ROUTES.has(legacyRoute) || legacyRoute.startsWith('kanji-reference/')) return 'app';
  return 'landing';
}
