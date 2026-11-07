/* Bump VERSION whenever an application asset changes before publishing. */
const VERSION = 'v2';
const CACHE_PREFIX = `yohaku:${self.registration.scope}:`;
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;
const assetPaths = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './store.js',
  './manifest.webmanifest',
  './assets/icon.svg',
  './assets/icon-180.png',
  './assets/icon-192.png',
  './assets/icon-512.png',
];
const assetURLs = new Set(assetPaths.map((path) => new URL(path, self.registration.scope).href));
const indexURL = new URL('./index.html', self.registration.scope).href;
const scopeURL = new URL(self.registration.scope);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll([...assetURLs].map((url) => new Request(url, { cache: 'reload' })));
    // An existing open app keeps its worker until it is closed or explicitly updated.
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== scopeURL.origin || !url.pathname.startsWith(scopeURL.pathname)) return;
  const canonicalURL = new URL(url.pathname, url.origin).href;
  const appNavigation = request.mode === 'navigate' && (canonicalURL === scopeURL.href || canonicalURL === indexURL);
  if (!appNavigation && !assetURLs.has(canonicalURL)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cacheKey = appNavigation ? indexURL : canonicalURL;
    try {
      const response = await fetch(new Request(request, { cache: 'no-cache' }));
      if (response.ok && response.type !== 'opaque') {
        // A full device cache must not prevent the online application from opening.
        await cache.put(cacheKey, response.clone()).catch(() => {});
        return response;
      }
      const cached = await cache.match(cacheKey);
      return cached || response;
    } catch (error) {
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
      throw error;
    }
  })());
});
