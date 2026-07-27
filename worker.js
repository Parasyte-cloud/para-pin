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
      return json({ ok: true, chat });
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
      const cleanup = () => this.sessions.delete(server);
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
      return json({ ok: true, delivered: this.sessions.size });
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
      const { fromUserId, fromName, text } = await request.json();
      if (!text || !text.trim()) return json({ error: 'empty' }, 400);
      const msgs = await this.loadMessages();
      const msg = {
        id: crypto.randomUUID(),
        fromUserId,
        fromName: fromName || null,
        text: String(text).slice(0, 4000),
        ts: Date.now(),
      };
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
        return res;
      }

      // /api/chats/:id/messages/:messageId  (DELETE a message)
      const deleteMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/messages\/([^/]+)$/);
      if (deleteMatch && request.method === 'DELETE') {
        const [, chatId, messageId] = deleteMatch;
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const verifyRes = await registryStub.fetch(
          `https://internal/verify-member?pinHash=${encodeURIComponent(pinHash)}&chatId=${encodeURIComponent(chatId)}`
        );
        const verify = await verifyRes.json();
        if (!verify.ok) return json({ error: 'forbidden' }, 403);
        const roomStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId));
        const res = await roomStub.fetch('https://internal/delete', {
          method: 'POST',
          body: JSON.stringify({ userId: verify.userId, messageId }),
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
          const { text } = await request.json();
          const res = await roomStub.fetch('https://internal/messages', {
            method: 'POST',
            body: JSON.stringify({ fromUserId: verify.userId, fromName: verify.displayName, text }),
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
