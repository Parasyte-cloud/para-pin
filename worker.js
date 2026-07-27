// PArA PIN backend — Cloudflare Worker + Durable Objects
// Two DO classes:
//   Registry  (singleton) — users, chat membership index
//   ChatRoom  (one per chat id) — messages + realtime WebSocket fan-out

async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function authHash(request, url) {
  return request.headers.get('X-Para-Pin-Hash') || url.searchParams.get('pinHash') || null;
}

// ================= Web Push (RFC 8291 payload encryption + VAPID) =================
// No npm 'web-push' library available in the Workers runtime, so this implements
// the spec directly against Web Crypto: ECDH key agreement + two-stage HKDF to
// derive an AES-128-GCM content-encryption key, framed per RFC 8188 (aes128gcm),
// plus an ES256-signed VAPID JWT for the Authorization header. Verified locally
// with an independent round-trip encrypt/decrypt + signature-verify test before
// shipping, but real push services (FCM/Mozilla/Apple) are the true test.

function toU8(x) { return x instanceof Uint8Array ? x : new Uint8Array(x); }

function concatBuffers(arrs) {
  const parts = arrs.map(toU8);
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

function bufToB64url(buf) {
  const bytes = toU8(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBuf(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

async function hkdf(ikm, salt, info, lengthBits) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, lengthBits);
}

async function encryptWebPushPayload(payloadBytes, p256dhB64url, authB64url) {
  const subscriberPubKeyRaw = b64urlToBuf(p256dhB64url);
  const authSecret = b64urlToBuf(authB64url);

  const subscriberPubKey = await crypto.subtle.importKey(
    'raw', subscriberPubKeyRaw, { name: 'ECDH', namedCurve: 'P-256' }, true, []
  );
  const ephemeralKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  );
  const ephemeralPubKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeralKeyPair.publicKey));

  const sharedSecretBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: subscriberPubKey }, ephemeralKeyPair.privateKey, 256
  );

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const uaPublic = subscriberPubKeyRaw;
  const asPublic = ephemeralPubKeyRaw;

  const infoKeyLabel = concatBuffers([new TextEncoder().encode('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = await hkdf(sharedSecretBits, authSecret, infoKeyLabel, 256);

  const cek = await hkdf(ikm, salt, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 128);
  const nonce = await hkdf(ikm, salt, new TextEncoder().encode('Content-Encoding: nonce\0'), 96);

  const paddedPayload = concatBuffers([payloadBytes, new Uint8Array([2])]); // delimiter, no extra padding needed for single-record
  const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cekKey, paddedPayload);

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  const idLen = new Uint8Array([asPublic.byteLength]);
  const header = concatBuffers([salt, recordSize, idLen, asPublic]);

  return concatBuffers([header, new Uint8Array(ciphertext)]);
}

async function signVapidJWT(privateKeyJwk, audience, subject) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = { aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject };
  const unsigned = `${bufToB64url(new TextEncoder().encode(JSON.stringify(header)))}.${bufToB64url(new TextEncoder().encode(JSON.stringify(payload)))}`;
  const key = await crypto.subtle.importKey('jwk', privateKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  // Web Crypto's ECDSA signature is raw r||s (IEEE P1363) — exactly what JWS ES256 wants, no DER conversion needed.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${bufToB64url(sig)}`;
}

async function sendWebPush(subscription, payloadObj, env) {
  if (!env.VAPID_PRIVATE_KEY_JWK || !env.VAPID_PUBLIC_KEY) {
    return { ok: false, status: 0, error: 'vapid_not_configured' };
  }
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payloadObj));
  const body = await encryptWebPushPayload(payloadBytes, subscription.keys.p256dh, subscription.keys.auth);
  const endpointUrl = new URL(subscription.endpoint);
  const audience = `${endpointUrl.protocol}//${endpointUrl.host}`;
  const privateKeyJwk = JSON.parse(env.VAPID_PRIVATE_KEY_JWK);
  const jwt = await signVapidJWT(privateKeyJwk, audience, env.VAPID_SUBJECT || 'mailto:admin@example.com');

  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '86400',
      'Authorization': `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
    },
    body,
  });
  return { ok: res.ok, status: res.status };
}

export class Registry {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/session') {
      const { pinHash, displayName } = await request.json();
      if (!pinHash) return json({ error: 'missing_pin_hash' }, 400);

      let user = await this.state.storage.get(`user:${pinHash}`);
      if (!user) {
        user = {
          id: crypto.randomUUID(),
          pinHash,
          displayName: displayName || null,
          createdAt: Date.now(),
        };
        await this.state.storage.put(`user:${pinHash}`, user);
        await this.state.storage.put(`userChats:${user.id}`, []);
        await this.state.storage.put(`userById:${user.id}`, { id: user.id, displayName: user.displayName });
      } else if (displayName && !user.displayName) {
        user.displayName = displayName;
        await this.state.storage.put(`user:${pinHash}`, user);
        await this.state.storage.put(`userById:${user.id}`, { id: user.id, displayName: user.displayName });
      }

      const chatIds = (await this.state.storage.get(`userChats:${user.id}`)) || [];
      const chats = [];
      for (const cid of chatIds) {
        const c = await this.state.storage.get(`chat:${cid}`);
        if (c) chats.push(c);
      }
      return json({ userId: user.id, displayName: user.displayName, chats });
    }

    if (request.method === 'GET' && url.pathname === '/users') {
      const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
      const out = [];
      for (const id of ids) {
        const rec = await this.state.storage.get(`userById:${id}`);
        if (rec) out.push(rec);
      }
      return json({ users: out });
    }

    if (request.method === 'POST' && url.pathname === '/contact') {
      const { pinHash, targetPinHash } = await request.json();
      const me = await this.state.storage.get(`user:${pinHash}`);
      if (!me) return json({ error: 'not_registered' }, 401);
      const other = await this.state.storage.get(`user:${targetPinHash}`);
      if (!other) return json({ error: 'pin_not_found' }, 404);
      if (other.id === me.id) return json({ error: 'cannot_add_self' }, 400);

      const myChatIds = (await this.state.storage.get(`userChats:${me.id}`)) || [];
      for (const cid of myChatIds) {
        const c = await this.state.storage.get(`chat:${cid}`);
        if (c && c.type === 'dm' && c.memberIds.includes(other.id)) {
          return json({ chat: c, existing: true });
        }
      }

      const chatId = crypto.randomUUID();
      const chat = { id: chatId, type: 'dm', name: null, memberIds: [me.id, other.id], createdAt: Date.now() };
      await this.state.storage.put(`chat:${chatId}`, chat);
      await this.state.storage.put(`userChats:${me.id}`, [...myChatIds, chatId]);
      const otherChatIds = (await this.state.storage.get(`userChats:${other.id}`)) || [];
      await this.state.storage.put(`userChats:${other.id}`, [...otherChatIds, chatId]);

      return json({ chat, existing: false });
    }

    if (request.method === 'POST' && url.pathname === '/group') {
      const { pinHash, name, memberPinHashes, memberIds: directMemberIds } = await request.json();
      const me = await this.state.storage.get(`user:${pinHash}`);
      if (!me) return json({ error: 'not_registered' }, 401);

      const memberIds = [me.id];
      const notFound = [];

      for (const id of directMemberIds || []) {
        if (id === me.id || memberIds.includes(id)) continue;
        const rec = await this.state.storage.get(`userById:${id}`);
        if (rec) memberIds.push(id);
      }

      for (const ph of memberPinHashes || []) {
        const u = await this.state.storage.get(`user:${ph}`);
        if (u && !memberIds.includes(u.id)) memberIds.push(u.id);
        else if (!u) notFound.push(ph);
      }
      if (memberIds.length < 2) return json({ error: 'need_at_least_one_member', notFound }, 400);

      const chatId = crypto.randomUUID();
      const chat = { id: chatId, type: 'group', name: name || 'Group', memberIds, createdAt: Date.now() };
      await this.state.storage.put(`chat:${chatId}`, chat);
      for (const uid of memberIds) {
        const list = (await this.state.storage.get(`userChats:${uid}`)) || [];
        await this.state.storage.put(`userChats:${uid}`, [...list, chatId]);
      }
      return json({ chat, notFound });
    }

    if (request.method === 'GET' && url.pathname === '/verify-member') {
      const pinHash = url.searchParams.get('pinHash');
      const chatId = url.searchParams.get('chatId');
      const user = await this.state.storage.get(`user:${pinHash}`);
      if (!user) return json({ ok: false });
      const chat = await this.state.storage.get(`chat:${chatId}`);
      if (!chat || !chat.memberIds.includes(user.id)) return json({ ok: false });
      return json({ ok: true, userId: user.id, displayName: user.displayName, chat });
    }

    if (request.method === 'POST' && url.pathname === '/leave-group') {
      const { pinHash, chatId } = await request.json();
      const user = await this.state.storage.get(`user:${pinHash}`);
      if (!user) return json({ ok: false, error: 'not_registered' }, 401);
      const chat = await this.state.storage.get(`chat:${chatId}`);
      if (!chat || chat.type !== 'group' || !chat.memberIds.includes(user.id)) {
        return json({ ok: false, error: 'not_found' }, 404);
      }
      chat.memberIds = chat.memberIds.filter((id) => id !== user.id);
      await this.state.storage.put(`chat:${chatId}`, chat);
      const myChats = (await this.state.storage.get(`userChats:${user.id}`)) || [];
      await this.state.storage.put(`userChats:${user.id}`, myChats.filter((id) => id !== chatId));
      return json({ ok: true, chat, leaverName: user.displayName });
    }

    if (request.method === 'GET' && url.pathname === '/whoami') {
      const pinHash = url.searchParams.get('pinHash');
      const user = await this.state.storage.get(`user:${pinHash}`);
      if (!user) return json({ ok: false });
      return json({ ok: true, userId: user.id, displayName: user.displayName });
    }

    return new Response('not found', { status: 404 });
  }
}

// One instance per user (keyed by userId) — holds a live WebSocket per open
// tab/device for that user, independent of which single chat's ChatRoom
// socket they're connected to. Used purely to push "you have a message"
// notifications so a message in a chat you're not currently looking at
// still dings / badges / shows a browser notification.
export class UserChannel {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Set();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      this.sessions.add(server);
      const cleanup = async () => {
        this.sessions.delete(server);
        // Only the *last* tab/device closing counts as "going offline" —
        // someone with two tabs open shouldn't flicker to offline when one closes.
        if (this.sessions.size === 0) {
          await this.state.storage.put('lastSeen', Date.now());
        }
      };
      server.addEventListener('close', cleanup);
      server.addEventListener('error', cleanup);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === 'POST' && url.pathname === '/notify') {
      const payload = await request.text();
      for (const ws of this.sessions) {
        try {
          ws.send(payload);
        } catch (e) {
          this.sessions.delete(ws);
        }
      }

      // Also fan out a real OS push to every registered device, so a message
      // still surfaces even if the app/tab isn't open anywhere at all. This
      // fires regardless of whether a live WS session also got the in-app
      // ding — a phone with the app closed and a desktop with it open are
      // both "this user", and we can't tell from here which subscription
      // belongs to which without a lot more bookkeeping, so we accept the
      // occasional double notification on a device that has it open.
      let data = null;
      try { data = JSON.parse(payload); } catch (e) {}
      if (data && data.type === 'notify' && data.message) {
        const notifyPrefs = (await this.state.storage.get('notifyPrefs')) || {};
        const pref = notifyPrefs[data.chatId] || 'all';
        const attKind = data.message.attachment && data.message.attachment.kind;
        const msgText = data.message.text || (data.message.attachment ? (attKind === 'file' ? `📄 ${data.message.attachment.name || 'File'}` : attKind === 'voice' ? '🎤 Voice message' : '📷 Photo') : '');

        // Muted chats never generate a push — the whole point is silence, even
        // when the app is fully closed and there's no client left to filter it.
        // Mentions-only needs a name to look for, so fall through to 'all' if
        // we don't have one cached yet (e.g. push was set up before any pref
        // was ever touched for this chat).
        let shouldPush = pref !== 'mute';
        if (shouldPush && pref === 'mentions') {
          const myName = (await this.state.storage.get('displayName')) || '';
          shouldPush = myName ? new RegExp(`@${myName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(msgText) : true;
        }

        const subs = shouldPush ? (await this.state.storage.get('pushSubs')) || [] : [];
        if (subs.length) {
          const title = data.chatType === 'group' ? (data.chatName || 'Group') : (data.message.fromName || 'PArA PIN');
          const body = data.chatType === 'group' && data.message.fromName ? `${data.message.fromName}: ${msgText}` : msgText;
          const pushPayload = { title, body, chatId: data.chatId };
          const stillValid = [];
          for (const sub of subs) {
            try {
              const result = await sendWebPush(sub, pushPayload, this.env);
              // 404/410 = the browser/OS has permanently unsubscribed this endpoint — drop it.
              if (result.status !== 404 && result.status !== 410) stillValid.push(sub);
            } catch (e) {
              stillValid.push(sub); // transient failure (network, etc.) — keep it, don't churn subscriptions on a blip
            }
          }
          if (stillValid.length !== subs.length) {
            await this.state.storage.put('pushSubs', stillValid);
          }
        }
      }

      return json({ ok: true, delivered: this.sessions.size, hadNoLiveSession: this.sessions.size === 0 });
    }

    if (request.method === 'GET' && url.pathname === '/presence') {
      const online = this.sessions.size > 0;
      const lastSeen = (await this.state.storage.get('lastSeen')) || 0;
      return json({ online, lastSeen });
    }

    if (request.method === 'POST' && url.pathname === '/subscribe') {
      const { subscription, displayName } = await request.json();
      if (!subscription || !subscription.endpoint) return json({ error: 'invalid_subscription' }, 400);
      const subs = (await this.state.storage.get('pushSubs')) || [];
      if (!subs.some((s) => s.endpoint === subscription.endpoint)) {
        subs.push(subscription);
        await this.state.storage.put('pushSubs', subs);
      }
      if (displayName) await this.state.storage.put('displayName', displayName);
      return json({ ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/unsubscribe') {
      const { endpoint } = await request.json();
      const subs = (await this.state.storage.get('pushSubs')) || [];
      await this.state.storage.put('pushSubs', subs.filter((s) => s.endpoint !== endpoint));
      return json({ ok: true });
    }

    if (request.method === 'GET' && url.pathname === '/notify-prefs') {
      const notifyPrefs = (await this.state.storage.get('notifyPrefs')) || {};
      return json({ notifyPrefs });
    }

    if (request.method === 'POST' && url.pathname === '/notify-pref') {
      const { chatId, pref, displayName } = await request.json();
      if (!chatId || !['all', 'mentions', 'mute'].includes(pref)) return json({ error: 'invalid' }, 400);
      const notifyPrefs = (await this.state.storage.get('notifyPrefs')) || {};
      if (pref === 'all') delete notifyPrefs[chatId];
      else notifyPrefs[chatId] = pref;
      await this.state.storage.put('notifyPrefs', notifyPrefs);
      if (displayName) await this.state.storage.put('displayName', displayName);
      return json({ ok: true, notifyPrefs });
    }

    return new Response('not found', { status: 404 });
  }
}


export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // ws -> { userId, name }
    this.messages = null;
  }

  async loadMessages() {
    if (this.messages === null) {
      this.messages = (await this.state.storage.get('messages')) || [];
    }
    return this.messages;
  }

  broadcast(payload, exceptWs) {
    for (const [ws] of this.sessions) {
      if (ws === exceptWs) continue;
      try {
        ws.send(payload);
      } catch (e) {
        this.sessions.delete(ws);
      }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      const userId = url.searchParams.get('userId') || null;
      const name = url.searchParams.get('name') || null;
      this.sessions.set(server, { userId, name });

      const cleanup = () => this.sessions.delete(server);
      server.addEventListener('close', cleanup);
      server.addEventListener('error', cleanup);

      // The only thing a client pushes *to* us over this socket is an
      // ephemeral "I'm typing" ping — everything else (send, delete, read)
      // goes through HTTP so it's reliable/persisted even if the socket
      // happens to be reconnecting at that moment.
      server.addEventListener('message', (ev) => {
        let data;
        try { data = JSON.parse(ev.data); } catch (e) { return; }
        if (data.type === 'typing' && userId) {
          this.broadcast(JSON.stringify({ type: 'typing', userId, name }), server);
        }
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === 'GET' && url.pathname === '/messages') {
      const msgs = await this.loadMessages();
      return json({ messages: msgs });
    }

    if (request.method === 'GET' && url.pathname === '/read-state') {
      const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
      const reads = {};
      for (const id of ids) {
        reads[id] = (await this.state.storage.get(`lastRead:${id}`)) || 0;
      }
      return json({ reads });
    }

    if (request.method === 'POST' && url.pathname === '/messages') {
      const { fromUserId, fromName, text, attachment } = await request.json();
      const hasText = text && text.trim();
      const hasAttachment = attachment && attachment.url;
      if (!hasText && !hasAttachment) return json({ error: 'empty' }, 400);
      const msgs = await this.loadMessages();
      const msg = {
        id: crypto.randomUUID(),
        fromUserId,
        fromName: fromName || null,
        text: hasText ? String(text).slice(0, 4000) : '',
        ts: Date.now(),
      };
      if (hasAttachment) {
        msg.attachment = {
          url: String(attachment.url).slice(0, 500),
          width: Number(attachment.width) || null,
          height: Number(attachment.height) || null,
          mime: attachment.mime ? String(attachment.mime).slice(0, 100) : 'image/jpeg',
          name: attachment.name ? String(attachment.name).slice(0, 200) : null,
          size: Number(attachment.size) || null,
          kind: ['image', 'voice', 'file'].includes(attachment.kind) ? attachment.kind : 'image',
          duration: attachment.duration ? Number(attachment.duration) : null,
        };
      }
      msgs.push(msg);
      if (msgs.length > 500) msgs.splice(0, msgs.length - 500);
      await this.state.storage.put('messages', msgs);

      this.broadcast(JSON.stringify({ type: 'message', message: msg }), null);
      return json({ message: msg });
    }

    if (request.method === 'POST' && url.pathname === '/read') {
      const { userId, upToTs } = await request.json();
      if (!userId) return json({ error: 'missing_user' }, 400);
      const ts = Number(upToTs) || Date.now();
      const prev = (await this.state.storage.get(`lastRead:${userId}`)) || 0;
      if (ts > prev) await this.state.storage.put(`lastRead:${userId}`, ts);
      this.broadcast(JSON.stringify({ type: 'read_receipt', userId, upToTs: Math.max(ts, prev) }), null);
      return json({ ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/delete') {
      const { userId, messageId } = await request.json();
      const msgs = await this.loadMessages();
      const msg = msgs.find((m) => m.id === messageId);
      if (!msg) return json({ error: 'not_found' }, 404);
      if (msg.fromUserId !== userId) return json({ error: 'forbidden' }, 403);
      msg.text = '';
      msg.deleted = true;
      await this.state.storage.put('messages', msgs);
      this.broadcast(JSON.stringify({ type: 'delete', messageId }), null);
      return json({ ok: true, message: msg });
    }

    if (request.method === 'POST' && url.pathname === '/edit') {
      const { userId, messageId, text } = await request.json();
      if (!text || !text.trim()) return json({ error: 'empty' }, 400);
      const msgs = await this.loadMessages();
      const msg = msgs.find((m) => m.id === messageId);
      if (!msg) return json({ error: 'not_found' }, 404);
      if (msg.fromUserId !== userId) return json({ error: 'forbidden' }, 403);
      if (msg.deleted) return json({ error: 'already_deleted' }, 400);
      msg.text = String(text).slice(0, 4000);
      msg.edited = true;
      await this.state.storage.put('messages', msgs);
      this.broadcast(JSON.stringify({ type: 'edit', messageId, text: msg.text }), null);
      return json({ ok: true, message: msg });
    }

    if (request.method === 'POST' && url.pathname === '/react') {
      const { userId, messageId, emoji } = await request.json();
      if (!userId || !emoji) return json({ error: 'missing_fields' }, 400);
      const msgs = await this.loadMessages();
      const msg = msgs.find((m) => m.id === messageId);
      if (!msg) return json({ error: 'not_found' }, 404);
      msg.reactions = msg.reactions || {};

      // One reaction per user per message. Figure out what they had *before*
      // touching anything, then remove it from wherever it lives, then only
      // re-add the new emoji if it's different from what they just had
      // (i.e. tapping your own current reaction again clears it — a toggle).
      const hadThisEmoji = (msg.reactions[emoji] || []).includes(userId);
      for (const key of Object.keys(msg.reactions)) {
        msg.reactions[key] = msg.reactions[key].filter((id) => id !== userId);
        if (msg.reactions[key].length === 0) delete msg.reactions[key];
      }
      if (!hadThisEmoji) {
        msg.reactions[emoji] = msg.reactions[emoji] || [];
        msg.reactions[emoji].push(userId);
      }

      await this.state.storage.put('messages', msgs);
      this.broadcast(JSON.stringify({ type: 'reaction', messageId, reactions: msg.reactions }), null);
      return json({ ok: true, reactions: msg.reactions });
    }

    if (request.method === 'POST' && url.pathname === '/system-message') {
      const { text } = await request.json();
      if (!text) return json({ error: 'empty' }, 400);
      const msgs = await this.loadMessages();
      const msg = {
        id: crypto.randomUUID(),
        type: 'system',
        fromUserId: null,
        fromName: null,
        text: String(text).slice(0, 500),
        ts: Date.now(),
      };
      msgs.push(msg);
      if (msgs.length > 500) msgs.splice(0, msgs.length - 500);
      await this.state.storage.put('messages', msgs);
      this.broadcast(JSON.stringify({ type: 'message', message: msg }), null);
      return json({ ok: true, message: msg });
    }

    return new Response('not found', { status: 404 });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    const registryStub = env.REGISTRY.get(env.REGISTRY.idFromName('global-registry-v1'));

    try {
      // Per-user live channel: one persistent socket per open tab/device,
      // used only to push cross-chat "new message" notifications.
      if (url.pathname === '/api/notify/ws') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const whoRes = await registryStub.fetch(`https://internal/whoami?pinHash=${encodeURIComponent(pinHash)}`);
        const who = await whoRes.json();
        if (!who.ok) return json({ error: 'not_registered' }, 401);
        const channelStub = env.USER_CHANNEL.get(env.USER_CHANNEL.idFromName(who.userId));
        return channelStub.fetch(request);
      }

      // Image upload — client sends already-resized/compressed bytes directly
      // as the request body. Auth required so randoms can't fill your bucket;
      // the resulting key is an unguessable UUID, serving is unauthenticated
      // (same trust model as e.g. a signed CDN link).
      if (request.method === 'POST' && url.pathname === '/api/upload') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        if (!env.MEDIA) return json({ error: 'media_not_configured' }, 501);

        let contentType = request.headers.get('content-type') || 'application/octet-stream';
        // Anything that a browser would treat as *active* content (executes script,
        // renders as a page in the current origin) gets rejected outright — this is
        // a shared-file box, not a place to host HTML/SVG that could carry a script.
        const BLOCKED_TYPES = ['text/html', 'application/xhtml+xml', 'image/svg+xml', 'text/javascript', 'application/javascript', 'application/x-javascript'];
        if (BLOCKED_TYPES.some((t) => contentType.toLowerCase().startsWith(t))) {
          return json({ error: 'unsupported_type' }, 400);
        }

        const fileNameHeader = request.headers.get('x-file-name') || '';
        let fileName = 'file';
        try { fileName = decodeURIComponent(fileNameHeader).slice(0, 200) || 'file'; } catch (e) {}

        const buf = await request.arrayBuffer();
        const MAX_BYTES = 20 * 1024 * 1024; // 20MB ceiling
        if (buf.byteLength === 0) return json({ error: 'empty' }, 400);
        if (buf.byteLength > MAX_BYTES) return json({ error: 'too_large' }, 413);

        const key = crypto.randomUUID();
        await env.MEDIA.put(key, buf, {
          httpMetadata: { contentType },
          customMetadata: { fileName },
        });
        return json({ id: key, url: `/api/media/${key}`, name: fileName, size: buf.byteLength, mime: contentType });
      }

      const mediaMatch = url.pathname.match(/^\/api\/media\/([^/]+)$/);
      if (mediaMatch && request.method === 'GET') {
        if (!env.MEDIA) return new Response('not found', { status: 404 });
        const obj = await env.MEDIA.get(mediaMatch[1]);
        if (!obj) return new Response('not found', { status: 404 });
        const contentType = obj.httpMetadata?.contentType || 'application/octet-stream';
        const fileName = obj.customMetadata?.fileName || 'file';
        // Images, audio (voice notes play inline via an <audio> element), and PDFs
        // (browsers preview those in a sandboxed viewer, not the page origin) render
        // inline; everything else forces a download instead of whatever the browser
        // might otherwise try to do with it.
        const inlineOk = contentType.startsWith('image/') || contentType.startsWith('audio/') || contentType === 'application/pdf';
        const headers = {
          'content-type': contentType,
          'cache-control': 'public, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff',
          'content-disposition': `${inlineOk ? 'inline' : 'attachment'}; filename="${fileName.replace(/["\r\n]/g, '_')}"`,
        };
        return new Response(obj.body, { headers });
      }

      if (request.method === 'POST' && url.pathname === '/api/session') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const body = await request.json().catch(() => ({}));
        const res = await registryStub.fetch('https://internal/session', {
          method: 'POST',
          body: JSON.stringify({ pinHash, displayName: body.displayName || null }),
        });
        return res;
      }

      if (request.method === 'GET' && url.pathname === '/api/presence') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const userId = url.searchParams.get('userId');
        if (!userId) return json({ error: 'missing_user_id' }, 400);
        const channelStub = env.USER_CHANNEL.get(env.USER_CHANNEL.idFromName(userId));
        const res = await channelStub.fetch('https://internal/presence');
        return res;
      }

      if (request.method === 'GET' && url.pathname === '/api/push/vapid-public-key') {
        if (!env.VAPID_PUBLIC_KEY) return json({ error: 'not_configured' }, 501);
        return json({ key: env.VAPID_PUBLIC_KEY });
      }

      if (request.method === 'POST' && url.pathname === '/api/push/subscribe') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const whoRes = await registryStub.fetch(`https://internal/whoami?pinHash=${encodeURIComponent(pinHash)}`);
        const who = await whoRes.json();
        if (!who.ok) return json({ error: 'not_registered' }, 401);
        const { subscription } = await request.json();
        const channelStub = env.USER_CHANNEL.get(env.USER_CHANNEL.idFromName(who.userId));
        const res = await channelStub.fetch('https://internal/subscribe', {
          method: 'POST',
          body: JSON.stringify({ subscription, displayName: who.displayName }),
        });
        return res;
      }

      if (request.method === 'POST' && url.pathname === '/api/push/unsubscribe') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const whoRes = await registryStub.fetch(`https://internal/whoami?pinHash=${encodeURIComponent(pinHash)}`);
        const who = await whoRes.json();
        if (!who.ok) return json({ error: 'not_registered' }, 401);
        const { endpoint } = await request.json();
        const channelStub = env.USER_CHANNEL.get(env.USER_CHANNEL.idFromName(who.userId));
        const res = await channelStub.fetch('https://internal/unsubscribe', {
          method: 'POST',
          body: JSON.stringify({ endpoint }),
        });
        return res;
      }

      // Per-chat notification preference ('all' | 'mentions' | 'mute'), stored
      // server-side per user so it applies to real push (app fully closed) as
      // well as in-app ding/badge — not just a local toggle that a push
      // notification would ignore.
      if (request.method === 'GET' && url.pathname === '/api/notify-prefs') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const whoRes = await registryStub.fetch(`https://internal/whoami?pinHash=${encodeURIComponent(pinHash)}`);
        const who = await whoRes.json();
        if (!who.ok) return json({ error: 'not_registered' }, 401);
        const channelStub = env.USER_CHANNEL.get(env.USER_CHANNEL.idFromName(who.userId));
        const res = await channelStub.fetch('https://internal/notify-prefs');
        return res;
      }

      const notifyPrefMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/notify-pref$/);
      if (notifyPrefMatch && request.method === 'PUT') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const whoRes = await registryStub.fetch(`https://internal/whoami?pinHash=${encodeURIComponent(pinHash)}`);
        const who = await whoRes.json();
        if (!who.ok) return json({ error: 'not_registered' }, 401);
        const { pref } = await request.json().catch(() => ({}));
        if (!['all', 'mentions', 'mute'].includes(pref)) return json({ error: 'invalid_pref' }, 400);
        const channelStub = env.USER_CHANNEL.get(env.USER_CHANNEL.idFromName(who.userId));
        const res = await channelStub.fetch('https://internal/notify-pref', {
          method: 'POST',
          body: JSON.stringify({ chatId: notifyPrefMatch[1], pref, displayName: who.displayName }),
        });
        return res;
      }

      if (request.method === 'GET' && url.pathname === '/api/users') {
        const ids = url.searchParams.get('ids') || '';
        const res = await registryStub.fetch(`https://internal/users?ids=${encodeURIComponent(ids)}`);
        return res;
      }

      if (request.method === 'POST' && url.pathname === '/api/contacts') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const { targetPinHash } = await request.json();
        const res = await registryStub.fetch('https://internal/contact', {
          method: 'POST',
          body: JSON.stringify({ pinHash, targetPinHash }),
        });
        return res;
      }

      if (request.method === 'POST' && url.pathname === '/api/groups') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const { name, memberPinHashes, memberIds } = await request.json();
        const res = await registryStub.fetch('https://internal/group', {
          method: 'POST',
          body: JSON.stringify({ pinHash, name, memberPinHashes, memberIds }),
        });
        return res;
      }

      if (request.method === 'POST' && url.pathname === '/api/groups/leave') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const { chatId } = await request.json();
        const res = await registryStub.fetch('https://internal/leave-group', {
          method: 'POST',
          body: JSON.stringify({ pinHash, chatId }),
        });
        const resBody = await res.json();
        if (res.ok && resBody.ok && resBody.chat) {
          const roomStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId));
          const sysText = `${resBody.leaverName || 'Someone'} left the group`;
          const sysPromise = roomStub.fetch('https://internal/system-message', {
            method: 'POST',
            body: JSON.stringify({ text: sysText }),
          }).catch(() => {});
          if (ctx && ctx.waitUntil) ctx.waitUntil(sysPromise); else await sysPromise;
        }
        return json(resBody, res.status);
      }

      // /api/chats/:id/messages/:messageId/react  (toggle a reaction)
      const reactMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/messages\/([^/]+)\/react$/);
      if (reactMatch && request.method === 'POST') {
        const [, chatId, messageId] = reactMatch;
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const verifyRes = await registryStub.fetch(
          `https://internal/verify-member?pinHash=${encodeURIComponent(pinHash)}&chatId=${encodeURIComponent(chatId)}`
        );
        const verify = await verifyRes.json();
        if (!verify.ok) return json({ error: 'forbidden' }, 403);
        const { emoji } = await request.json();
        const roomStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId));
        const res = await roomStub.fetch('https://internal/react', {
          method: 'POST',
          body: JSON.stringify({ userId: verify.userId, messageId, emoji }),
        });
        const resBody = await res.json();
        return json(resBody, res.status);
      }

      // /api/chats/:id/messages/:messageId  (DELETE, or PATCH to edit)
      const msgIdMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/messages\/([^/]+)$/);
      if (msgIdMatch && (request.method === 'DELETE' || request.method === 'PATCH')) {
        const [, chatId, messageId] = msgIdMatch;
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const verifyRes = await registryStub.fetch(
          `https://internal/verify-member?pinHash=${encodeURIComponent(pinHash)}&chatId=${encodeURIComponent(chatId)}`
        );
        const verify = await verifyRes.json();
        if (!verify.ok) return json({ error: 'forbidden' }, 403);
        const roomStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId));

        if (request.method === 'DELETE') {
          const res = await roomStub.fetch('https://internal/delete', {
            method: 'POST',
            body: JSON.stringify({ userId: verify.userId, messageId }),
          });
          const resBody = await res.json();
          return json(resBody, res.status);
        }

        // PATCH — edit
        const { text } = await request.json();
        const res = await roomStub.fetch('https://internal/edit', {
          method: 'POST',
          body: JSON.stringify({ userId: verify.userId, messageId, text }),
        });
        const resBody = await res.json();
        return json(resBody, res.status);
      }

      // /api/chats/:id/messages, /api/chats/:id/ws, /api/chats/:id/read, /api/chats/:id/read-state
      const chatMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/(messages|ws|read|read-state)$/);
      if (chatMatch) {
        const [, chatId, action] = chatMatch;
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);

        const verifyRes = await registryStub.fetch(
          `https://internal/verify-member?pinHash=${encodeURIComponent(pinHash)}&chatId=${encodeURIComponent(chatId)}`
        );
        const verify = await verifyRes.json();
        if (!verify.ok) return json({ error: 'forbidden' }, 403);

        const roomStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId));

        if (action === 'ws') {
          // Inject the verified identity as query params so the ChatRoom DO
          // knows who owns this socket (needed for typing pings) without
          // trusting anything the client itself claims.
          const wsUrl = new URL(request.url);
          wsUrl.searchParams.set('userId', verify.userId);
          wsUrl.searchParams.set('name', verify.displayName || '');
          const wsRequest = new Request(wsUrl.toString(), request);
          return roomStub.fetch(wsRequest);
        }

        if (action === 'read-state') {
          return roomStub.fetch(`https://internal/read-state?ids=${encodeURIComponent((verify.chat.memberIds || []).join(','))}`);
        }

        if (action === 'read' && request.method === 'POST') {
          const { upToTs } = await request.json().catch(() => ({}));
          const res = await roomStub.fetch('https://internal/read', {
            method: 'POST',
            body: JSON.stringify({ userId: verify.userId, upToTs: upToTs || Date.now() }),
          });
          return res;
        }

        if (action === 'messages' && request.method === 'GET') {
          return roomStub.fetch('https://internal/messages');
        }

        if (action === 'messages' && request.method === 'POST') {
          const { text, attachment } = await request.json();
          const res = await roomStub.fetch('https://internal/messages', {
            method: 'POST',
            body: JSON.stringify({ fromUserId: verify.userId, fromName: verify.displayName, text, attachment }),
          });
          const resBody = await res.json();

          if (res.ok && resBody.message) {
            const chat = verify.chat;
            const notifyPayload = JSON.stringify({
              type: 'notify',
              chatId,
              chatType: chat.type,
              chatName: chat.type === 'group' ? chat.name : null,
              message: resBody.message,
            });
            const notifyOthers = (chat.memberIds || [])
              .filter((memberId) => memberId !== verify.userId)
              .map((memberId) => {
                const channelStub = env.USER_CHANNEL.get(env.USER_CHANNEL.idFromName(memberId));
                return channelStub.fetch('https://internal/notify', { method: 'POST', body: notifyPayload }).catch(() => {});
              });
            if (ctx && ctx.waitUntil) ctx.waitUntil(Promise.all(notifyOthers));
            else await Promise.all(notifyOthers);
          }

          return json(resBody, res.status);
        }
      }

      return json({ error: 'not_found' }, 404);
    } catch (err) {
      return json({ error: 'server_error', message: String(err && err.message || err) }, 500);
    }
  },
};
