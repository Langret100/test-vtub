/* Simple cache for same-origin assets.
 * Improves repeat-visit load times (VRM + motion GLB are large).
 * Note: third-party CDN module imports are cross-origin and won't be cached here.
 */

const CACHE_NAME = 'vtuber-room-v6';
const PRECACHE_URLS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './assets/avatar.vrm',
  './assets/motions/quaternius_animlib.glb'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(PRECACHE_URLS);
      self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => (k === CACHE_NAME ? null : caches.delete(k))));
      self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Same-origin only
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      // Cache-first for precached core
      const isPrecached = PRECACHE_URLS.some((p) => url.pathname.endsWith(p.replace('./', '/')));
      if (isPrecached){
        const hit = await cache.match(req);
        if (hit) return hit;
      }

      // Stale-while-revalidate for everything else
      const cached = await cache.match(req);
      const fetchPromise = fetch(req)
        .then((res) => {
          // Only cache successful basic responses
          if (res && res.ok && res.type === 'basic'){
            cache.put(req, res.clone());
          }
          return res;
        })
        .catch(() => null);

      return cached || (await fetchPromise) || Response.error();
    })()
  );
});
