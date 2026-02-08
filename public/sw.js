const CACHE_NAME = 'pwt-v1';
const STATIC_ASSETS = [
  '/',
  '/node_modules/@xterm/xterm/css/xterm.css',
  '/node_modules/@xterm/xterm/lib/xterm.mjs',
  '/node_modules/@xterm/addon-fit/lib/addon-fit.mjs',
  '/node_modules/@xterm/addon-web-links/lib/addon-web-links.mjs'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Skip WebSocket requests
  if (event.request.url.includes('ws://') || event.request.url.includes('wss://')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((response) => {
      // Return cached response or fetch from network
      return response || fetch(event.request).then((fetchResponse) => {
        // Don't cache API or WebSocket-related requests
        if (event.request.method !== 'GET') {
          return fetchResponse;
        }
        return fetchResponse;
      });
    }).catch(() => {
      // Offline fallback for navigation requests
      if (event.request.mode === 'navigate') {
        return caches.match('/');
      }
    })
  );
});
