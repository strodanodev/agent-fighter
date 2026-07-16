/**
 * Agent Fighter service worker — makes the game installable and resilient
 * offline without ever serving a stale build.
 *
 * Strategy (deliberately conservative — the game streams ~20MB of media):
 *   - navigations + scripts  -> network-first, fall back to cached shell
 *   - icons / fonts / ui svg -> cache-first (immutable, tiny)
 *   - everything else        -> straight to network (video Range requests,
 *                               /api JSON, characters/stages, cross-origin)
 *
 * Bump CACHE_VERSION whenever the shell changes; the old cache is purged on
 * activate so a new deploy is picked up on the next launch.
 */
const CACHE_VERSION = 'af-v2';
const SHELL = '/';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_VERSION).then((c) => c.add(SHELL)).catch(() => {}));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

const isPrecacheable = (url) => /\/assets\/(icons|fonts|ui)\//.test(url.pathname);

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                       // never touch POSTs (/api/shot)
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;         // cross-origin (AIR/CDN) — passthrough
  if (req.headers.has('range')) return;                    // <video> partial content — passthrough
  if (url.pathname.startsWith('/api/')) return;            // dynamic lists — always fresh

  // Small immutable assets: cache-first for instant loads.
  if (isPrecacheable(url)) {
    event.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) { const c = await caches.open(CACHE_VERSION); c.put(req, res.clone()); }
      return res;
    })());
    return;
  }

  // Navigations + scripts (the built bundle): network-first so deploys land,
  // cache as offline fallback.
  const isShell = req.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html');
  if (isShell) {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) { const c = await caches.open(CACHE_VERSION); c.put(SHELL, res.clone()); }
        return res;
      } catch {
        return (await caches.match(SHELL)) || (await caches.match(req)) || Response.error();
      }
    })());
  }
});
