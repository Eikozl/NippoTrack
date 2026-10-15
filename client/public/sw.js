// NippoTrack shell service worker (online-first, no data caching).
// - Navigations: network first, offline.html fallback when unreachable.
// - Same-origin static GETs: stale-while-revalidate into a versioned cache.
// - NEVER cached: /api/* (auth flows and study data must stay live),
//   non-GET requests, cross-origin requests.
// Bump SHELL_CACHE on shell-breaking releases; old caches are purged on
// activate. Not registered inside Capacitor (see index.html guard).
const SHELL_CACHE = 'nippotrack-shell-v1';
const SHELL_CORE = ['/', '/index.html', '/offline.html', '/theme-init.js', '/favicon.png', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_CORE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function isApiRequest(url) {
  return url.pathname === '/api' || url.pathname.startsWith('/api/');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin || isApiRequest(url)) return;
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/offline.html', { ignoreSearch: true }))
    );
    return;
  }
  event.respondWith(
    caches.match(request, { ignoreSearch: false }).then((cached) => {
      const network = fetch(request).then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
