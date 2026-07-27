// PArA PIN — minimal offline app-shell cache
const CACHE = 'para-pin-v1';
const ASSETS = ['/', '/index.html', '/icon-192.png', '/icon-512.png', '/favicon.png'];

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
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fetchPromise = fetch(e.request)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
          return res;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

// ---- App icon badge count, persisted across service-worker restarts ----
// The Service Worker gets evicted between events, so a plain in-memory
// variable would forget the count between pushes. IndexedDB is the one
// storage API available in this scope that survives that.
function badgeDb(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('para-pin-badge', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function getBadgeCount(){
  try {
    const db = await badgeDb();
    return await new Promise((resolve) => {
      const tx = db.transaction('kv', 'readonly');
      const r = tx.objectStore('kv').get('count');
      r.onsuccess = () => resolve(r.result || 0);
      r.onerror = () => resolve(0);
    });
  } catch (e) { return 0; }
}
async function setBadgeCount(count){
  try {
    const db = await badgeDb();
    await new Promise((resolve) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(count, 'count');
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  } catch (e) {}
  if ('setAppBadge' in self.navigator) {
    try {
      if (count > 0) await self.navigator.setAppBadge(count);
      else await self.navigator.clearAppBadge();
    } catch (e) {}
  }
}

// ---- Web Push: fires even when no PArA PIN tab is open at all ----
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  const title = data.title || 'PArA PIN';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.chatId ? 'parapin-' + data.chatId : 'parapin',
    data: { chatId: data.chatId || null },
  };
  event.waitUntil((async () => {
    await self.registration.showNotification(title, options);
    // A page that's actually open and visible keeps its own accurate badge
    // count already (see index.html's updateTitleBadge) and will stomp on
    // whatever we set here the moment it handles the message itself — so
    // only take over the icon badge when nothing visible is around to do it.
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const hasVisible = clientList.some((c) => c.visibilityState === 'visible');
    if (!hasVisible) {
      const next = (await getBadgeCount()) + 1;
      await setBadgeCount(next);
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      if ('focus' in client) { await client.focus(); return; }
    }
    if (self.clients.openWindow) await self.clients.openWindow('/');
  })());
});

// The open app tells us its real unread total whenever it changes (see
// syncBadgeToServiceWorker in index.html) — that's the source of truth;
// this just keeps our own counter from drifting once the app is closed
// again and push events start incrementing it on their own.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'set-badge-count') {
    event.waitUntil(setBadgeCount(Number(event.data.count) || 0));
  }
});
