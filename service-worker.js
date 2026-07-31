// PArA PIN — minimal offline app-shell cache
const CACHE = 'para-pin-v2';
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

  // The app shell (the HTML document itself) must be NETWORK-FIRST. It used
  // to be cache-first like everything else, which meant an installed PWA kept
  // serving whatever index.html it first cached and never picked up a new
  // deploy until its storage was cleared by hand, every fix looking like it
  // simply hadn't shipped. Falling back to cache on failure keeps it working
  // offline, which was the point of caching it in the first place.
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
        .catch(() => caches.match(e.request).then((cached) => cached || caches.match('/index.html')))
    );
    return;
  }

  // Static assets (icons, etc.) stay cache-first with a background refresh,
  // they're immutable enough that serving instantly matters more.
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fetchPromise = fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
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
  // A real chat message (chatId set) has an in-app equivalent already
  // (index.html's notify-socket handler dings/decrypts/previews it live
  // while a tab is open); a call or meeting invite (chatId null) doesn't,
  // and is time-sensitive enough that it should always alert even with a
  // visible tab (see worker.js's /call-signal comment: a backgrounded tab's
  // JS timers/audio can get throttled even with a live socket, so this OS
  // push is the only thing that reliably still rings).
  const isChatMessage = !!data.chatId;
  const options = {
    body: data.body || '',
    // A DM push carries the sender's own photo (see worker.js's /notify
    // handler), showing their avatar in the banner instead of the generic
    // app icon, the way a phone's native contact notifications look. Falls
    // back to the app icon for group chats, calls, and anything else that
    // has no single "from" person's photo to show.
    icon: data.avatarUrl || '/icon-192.png',
    badge: '/icon-192.png',
    // One notification per chat (tag), but `renotify` is what makes a second
    // message in that same chat actually alert again (sound/vibration)
    // instead of silently swapping the text of the existing one, which is
    // exactly what "sometimes there's no ping" looked like.
    tag: data.chatId ? 'parapin-' + data.chatId : 'parapin',
    renotify: true,
    vibrate: [200, 100, 200],
    timestamp: Date.now(),
    data: { chatId: data.chatId || null },
  };
  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const hasVisible = clientList.some((c) => c.visibilityState === 'visible');

    // Previously this showed a banner for EVERY push unconditionally, even
    // with a tab open and visible, while the badge below correctly stayed
    // put in that same situation, that mismatch (banner fires, badge
    // doesn't) is exactly what looked "inconsistent" between the two. Now a
    // plain chat message only bangs out its own OS banner when nothing
    // visible is around to show it in-app already, or the user explicitly
    // opted into always-on banners (see settingsAlwaysBannerInput in
    // index.html, synced here via syncAlwaysBannerToServiceWorker), the
    // exact same rule the in-app path already applies to itself.
    const alwaysBanner = await kvGet('alwaysBanner', false);
    const shouldShowBanner = !isChatMessage || !hasVisible || alwaysBanner;
    if (shouldShowBanner) {
      await self.registration.showNotification(title, options);
    }

    // A page that's actually open and visible keeps its own accurate badge
    // count already (see index.html's updateTitleBadge) and will stomp on
    // whatever we set here the moment it handles the message itself, so
    // only take over the icon badge when nothing visible is around to do it.
    // When the app does come back to the foreground it immediately resyncs
    // the real unread total from the server and posts it here (see the
    // 'set-badge-count' message handler below), so this counter self-corrects
    // rather than drifting further with every push while away.
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
