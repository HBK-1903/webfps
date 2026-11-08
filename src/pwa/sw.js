// Service worker: makes the installed app work with no network at all.
//
// Two caches so a half-finished update can never brick the game:
//   PRECACHE  — the files we need on the very first offline launch
//   RUNTIME   — anything else the page asked for (icons, css, js)
// Strategy: cache-first with a background refresh. The game has no API and no
// dynamic content, so serving from cache is always correct; the refresh only
// matters when a new build has been deployed.
const VERSION = 'sifirnokta-v1';
const PRECACHE = `${VERSION}-precache`;
const RUNTIME = `${VERSION}-runtime`;

const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './SifirNokta.html',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PRECACHE);
      // addAll rejects the whole install if a single file 404s, which would
      // leave the user with no offline support at all. Add them one by one.
      await Promise.all(CORE.map((url) => cache.add(url).catch(() => null)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([PRECACHE, RUNTIME]);
      const names = await caches.keys();
      await Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: network-first so a deploy is picked up while online, cache as
  // the offline fallback. Everything else: cache-first + background refresh.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(PRECACHE);
          cache.put('./index.html', fresh.clone()).catch(() => null);
          return fresh;
        } catch {
          const cached = (await caches.match(req)) || (await caches.match('./index.html'));
          return cached || new Response('Çevrimdışı ve önbellek boş.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) {
        // Refresh quietly; failures here must not affect the response.
        fetch(req)
          .then(async (fresh) => {
            if (fresh && fresh.ok) {
              const cache = await caches.open(RUNTIME);
              await cache.put(req, fresh);
            }
          })
          .catch(() => null);
        return cached;
      }
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) {
          const cache = await caches.open(RUNTIME);
          cache.put(req, fresh.clone()).catch(() => null);
        }
        return fresh;
      } catch {
        return new Response('', { status: 504, statusText: 'Çevrimdışı' });
      }
    })(),
  );
});
