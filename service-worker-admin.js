// PArA Admin — minimal offline app-shell cache. Separate from
// service-worker.js (used by index.html) because that file's precache list
// and offline fallback both hardcode '/index.html' — reusing it here would
// precache the wrong document. Same network-first-for-the-document,
// cache-first-for-everything-else strategy, just pointed at admin.html.
const CACHE = 'para-admin-v1';
const ASSETS = ['/admin.html', '/icon-192.png', '/icon-512.png', '/favicon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  // Never cache API calls — an admin console showing stale data (or worse,
  // a cached "forbidden" from before a promote took effect) is actively
  // harmful, unlike the main app's read-mostly chat data.
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return;

  const isDocument = e.request.mode === 'navigate' ||
    (e.request.headers.get('accept') || '').includes('text/html');
  if (isDocument) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => caches.match(e.request).then((cached) => cached || caches.match('/admin.html')))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
