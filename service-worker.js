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

// ---- Shared IndexedDB kv store ----
// The Service Worker gets evicted between events, so plain in-memory
// variables would forget everything between pushes. IndexedDB is the one
// storage API available in this scope that survives that AND is reachable
// from the page too (unlike localStorage, which a SW can't touch) — used
// here for the icon badge count and for a copy of the current pin hash.
function swDb(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('para-pin-badge', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function kvGet(key, fallback){
  try {
    const db = await swDb();
    return await new Promise((resolve) => {
      const tx = db.transaction('kv', 'readonly');
      const r = tx.objectStore('kv').get(key);
      r.onsuccess = () => resolve(r.result === undefined ? fallback : r.result);
      r.onerror = () => resolve(fallback);
    });
  } catch (e) { return fallback; }
}
async function kvSet(key, val){
  try {
    const db = await swDb();
    await new Promise((resolve) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(val, key);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  } catch (e) {}
}
async function getBadgeCount(){ return kvGet('count', 0); }
async function setBadgeCount(count){
  await kvSet('count', count);
  if ('setAppBadge' in self.navigator) {
    try {
      if (count > 0) await self.navigator.setAppBadge(count);
      else await self.navigator.clearAppBadge();
    } catch (e) {}
  }
}

function urlBase64ToUint8Array(base64String){
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const out = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) out[i] = rawData.charCodeAt(i);
  return out;
}

// A browser can silently rotate or invalidate a push subscription at any
// time (key rotation, storage pressure, etc.) — without this listener the
// app would never notice, and push would just quietly stop working until
// someone happened to reopen it (which is exactly what "sometimes doesn't
// come unless I open the app" looks like from the outside). This re-
// subscribes and re-registers with the server on its own, using a copy of
// the pin hash the open page keeps synced into IndexedDB for this purpose
// (see syncPinHashToServiceWorker in index.html) since a SW has no other way
// to authenticate itself to the API.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const pinHash = await kvGet('pinHash', null);
      if (!pinHash) return;
      const keyRes = await fetch('/api/push/vapid-public-key');
      if (!keyRes.ok) return;
      const { key } = await keyRes.json();
      if (!key) return;
      const newSub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-para-pin-hash': pinHash },
        body: JSON.stringify({ subscription: newSub.toJSON() }),
      });
    } catch (e) {}
  })());
});

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
