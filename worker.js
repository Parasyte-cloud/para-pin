// PArA PIN backend, Cloudflare Worker + Durable Objects
// Two DO classes:
//   Registry  (singleton), users, chat membership index
//   ChatRoom  (one per chat id), messages + realtime WebSocket fan-out

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

// Avatar URLs (profile photos, group photos) are always produced by this
// app's own /api/upload, which returns exactly `/api/media/<uuid>`. They get
// interpolated client-side into a CSS `url("...")`, so a stored value
// containing a quote could break out of that and inject arbitrary CSS for
// everyone who views that profile or group. Rather than escaping at every
// render site, reject anything that isn't the one shape we ever legitimately
// produce. Returns null for "no avatar" and for anything malformed.
function sanitizeAvatarUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  return /^\/api\/media\/[A-Za-z0-9_-]{1,100}$/.test(value) ? value : null;
}

// ================= Rate limiting (PIN brute-force / enumeration defense) =================
// A PIN is this app's ONLY credential, a flat ~9,000,000-value numeric space
// (see the /roster generator below) with no separate password. Two endpoints
// turn that into a brute-forceable oracle if left unthrottled:
//   /session  - logging in with a PIN that happens to belong to someone else
//               IS account takeover, and any never-before-seen PIN silently
//               gets a fresh account created for it, so this doubles as a
//               "does this PIN exist yet" oracle too.
//   /contact and /group - confirm whether a given PIN belongs to a real
//               account at all (used to add them as a contact / group member).
// A sliding window counter per key (caller IP pre-login, caller's own user id
// once authenticated) with an escalating lockout on top makes scripted
// enumeration of the PIN space impractically slow while staying invisible to
// normal usage, a real person never comes close to these thresholds.
async function checkRateLimit(storage, key, { maxAttempts, windowMs, lockoutMs, cost = 1 }) {
  const now = Date.now();
  const storeKey = `ratelimit:${key}`;
  const rec = (await storage.get(storeKey)) || { count: 0, windowStart: now, lockedUntil: 0 };
  if (rec.lockedUntil && now < rec.lockedUntil) {
    return { allowed: false, retryAfterMs: rec.lockedUntil - now };
  }
  if (now - rec.windowStart > windowMs) {
    rec.count = 0;
    rec.windowStart = now;
    rec.lockedUntil = 0;
  }
  rec.count += cost;
  if (rec.count > maxAttempts) {
    rec.lockedUntil = now + lockoutMs;
    await storage.put(storeKey, rec);
    return { allowed: false, retryAfterMs: lockoutMs };
  }
  await storage.put(storeKey, rec);
  return { allowed: true };
}

// ================= Organizations / workspaces =================
// A workspace is a genuinely separate space (its own directory, its own
// chats), same idea as a Slack workspace, layered on top of the exact same
// Registry storage rather than a new Durable Object per org, everyone's
// existing personal space (orgId = null/undefined on a chat) keeps working
// completely unchanged. A user's account (PIN, display name, avatar) is
// shared across every workspace they're in, only the chat lists and
// directories are walled off from each other.
async function addUserToOrg(storage, orgId, userId) {
  const org = await storage.get(`org:${orgId}`);
  if (!org) return false;
  const members = (await storage.get(`orgMembers:${orgId}`)) || [];
  if (!members.includes(userId)) {
    await storage.put(`orgMembers:${orgId}`, [...members, userId]);
  }
  const userOrgs = (await storage.get(`userOrgs:${userId}`)) || [];
  if (!userOrgs.includes(orgId)) {
    await storage.put(`userOrgs:${userId}`, [...userOrgs, orgId]);
  }
  return true;
}

async function isOrgMember(storage, orgId, userId) {
  const members = (await storage.get(`orgMembers:${orgId}`)) || [];
  return members.includes(userId);
}

async function isOrgAdmin(storage, orgId, userId) {
  const org = await storage.get(`org:${orgId}`);
  if (!org) return false;
  if (Array.isArray(org.admins) && org.admins.includes(userId)) return true;
  // App-wide admins (the same list /admin/promote manages) can manage any
  // workspace too, useful for support/ops without needing to be personally
  // added to every org that gets created.
  const appAdmins = (await storage.get('admins')) || [];
  return appAdmins.includes(userId);
}

// Builds the cached "public view" of a user that other people's clients can
// look up via GET /users, kept in its own function so every place that
// writes it (session, profile edits, key uploads, device resets, admin
// promotion, etc.) stays in sync instead of each hand-rolling the same
// object and inevitably drifting out of sync with each other (which is
// exactly how a previous round's `hasDeviceLock` bug happened).
function userByIdSnapshot(user, admins) {
  const deviceIds = Array.isArray(user.deviceIds) ? user.deviceIds : [];
  const allKeys = (user.devicePublicKeys && typeof user.devicePublicKeys === 'object') ? user.devicePublicKeys : {};
  const trustedKeys = {};
  for (const did of deviceIds) if (allKeys[did]) trustedKeys[did] = allKeys[did];
  return {
    id: user.id,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl || null,
    e2eePublicKey: user.e2eePublicKey || null,
    devicePublicKeys: trustedKeys,
    hasDeviceLock: deviceIds.length > 0,
    deviceCount: deviceIds.length,
    isAdmin: Array.isArray(admins) ? admins.includes(user.id) : undefined,
  };
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
  // Web Crypto's ECDSA signature is raw r||s (IEEE P1363), exactly what JWS ES256 wants, no DER conversion needed.
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

  // The secret has to be the JWK object's JSON text, e.g. {"kty":"EC",...}.
  // If whatever generated it JSON-stringified it TWICE (a string containing
  // escaped JSON, rather than the object itself), one JSON.parse only undoes
  // one layer and leaves privateKeyJwk as a plain string, importKey then
  // fails with an opaque "parameter 2 is not of type JsonWebKey" that gives
  // no hint why. Auto-unwrapping a second layer recovers from that common
  // copy/paste mistake instead of silently failing every single push.
  let privateKeyJwk;
  try {
    privateKeyJwk = JSON.parse(env.VAPID_PRIVATE_KEY_JWK);
    if (typeof privateKeyJwk === 'string') privateKeyJwk = JSON.parse(privateKeyJwk);
  } catch (e) {
    return { ok: false, status: 0, error: 'vapid_key_not_valid_json' };
  }
  if (!privateKeyJwk || typeof privateKeyJwk !== 'object' || !privateKeyJwk.d) {
    return { ok: false, status: 0, error: 'vapid_key_missing_private_component' };
  }

  const jwt = await signVapidJWT(privateKeyJwk, audience, env.VAPID_SUBJECT || 'mailto:admin@example.com');

  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '86400',
      // Without an explicit Urgency, push services fall back to "normal",
      // and Apple's implementation in particular is known to sit on
      // normal/unspecified-priority pushes and deliver them late (or not at
      // all) once the device is in Low Power Mode or the browser/PWA hasn't
      // been used in a while, which looks exactly like "sometimes it just
      // doesn't come." Marking every message notification "high" is the
      // documented fix, it tells the OS this is worth waking up for.
      'Urgency': 'high',
      'Authorization': `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
    },
    body,
  });
  return { ok: res.ok, status: res.status };
}

// A single transient failure (a network blip, or a 5xx from the push
// service itself) previously meant that one notification was just gone,
// nothing anywhere retried it, which is exactly the kind of thing that adds
// up to "notifications come sometimes, not every time" without ever
// throwing an error worth noticing. One short retry covers that without
// meaningfully delaying delivery. 404/410 (subscription gone for good)
// still isn't retried, that's not a transient failure, retrying can't help.
async function sendWebPushWithRetry(subscription, payloadObj, env) {
  let result = await sendWebPush(subscription, payloadObj, env);
  if (!result.ok && result.status !== 404 && result.status !== 410) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    result = await sendWebPush(subscription, payloadObj, env);
  }
  return result;
}

// ================= Transactional email (Resend) =================
// Used only by the lightweight HR-linked onboarding roster: emails a newly
// added person their PIN instead of (or alongside) an admin handing it over
// directly. Cleanly no-ops if RESEND_API_KEY / RESEND_FROM_EMAIL aren't
// configured, the roster feature works fine without email, this is optional.
async function sendOnboardingEmail(env, { to, name, pin }) {
  if (!env.RESEND_API_KEY) return { sent: false, error: 'resend_not_configured' };
  if (!env.RESEND_FROM_EMAIL) return { sent: false, error: 'resend_from_not_configured' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.RESEND_FROM_EMAIL,
        to: [to],
        subject: "You're set up on PArA PIN",
        text: `Hi ${name || 'there'},\n\nYou've been added to PArA PIN, the team chat app.\n\nYour PIN is: ${pin}\n\nOpen chat.parasyte.cloud and enter this PIN to get in, that's it, no username or password to remember. Keep it to yourself the way you'd keep any PIN.\n\nThe PArA PIN team`,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { sent: false, error: `status ${res.status}${body ? ': ' + body.slice(0, 200) : ''}` };
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, error: e && e.message ? e.message : 'unknown error' };
  }
}

export class Registry {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/session') {
      const { pinHash, displayName, deviceId, ip } = await request.json();
      if (!pinHash) return json({ error: 'missing_pin_hash' }, 400);

      // Every login attempt counts against this IP's budget, whether it
      // guesses right, guesses wrong, or lands on a never-claimed PIN (which
      // is itself a successful "account exists / doesn't" oracle, see the
      // checkRateLimit comment above). 20 tries per 5 minutes is generous for
      // a real person mistyping a PIN a few times, and hopeless for anyone
      // scripting a sweep through the ~9,000,000-value PIN space.
      const rl = await checkRateLimit(this.state.storage, `session:${ip || 'unknown'}`, {
        maxAttempts: 20, windowMs: 5 * 60 * 1000, lockoutMs: 15 * 60 * 1000,
      });
      if (!rl.allowed) return json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, 429);

      // A roster entry pre-provisioned by an admin (see /admin/roster) claims
      // itself the first time its PIN is actually used, the person gets
      // their name/department pre-filled instead of the free-text "what
      // should we call you" step, and the entry is marked claimed so the
      // admin can see who's actually signed on.
      const rosterId = await this.state.storage.get(`rosterByPin:${pinHash}`);
      let roster = rosterId ? await this.state.storage.get(`roster:${rosterId}`) : null;
      if (roster && roster.status === 'disabled') {
        return json({ error: 'pin_disabled' }, 403);
      }

      let user = await this.state.storage.get(`user:${pinHash}`);
      if (!user) {
        user = {
          id: crypto.randomUUID(),
          pinHash,
          displayName: (roster && roster.name) || displayName || null,
          department: (roster && roster.department) || null,
          avatarUrl: null,
          e2eePublicKey: null,
          deviceIds: [],
          // A roster-issued PIN is a shared secret the admin who created it
          // also knows, if it doubled as the permanent credential, whoever
          // uses it FIRST (which could be that admin, testing it, or anyone
          // they showed it to) would permanently claim the account. Forcing
          // a mandatory PIN change before the account is usable means the
          // admin-known PIN only ever works for this one bootstrap step,
          // once changed, only the real person knows the PIN that matters.
          mustChangePin: !!roster,
          pendingDeviceLink: null,
          createdAt: Date.now(),
        };
        await this.state.storage.put(`user:${pinHash}`, user);
        await this.state.storage.put(`userChats:${user.id}`, []);
        await this.state.storage.put(`userById:${user.id}`, userByIdSnapshot(user));
        await this.state.storage.put(`userIdToPinHash:${user.id}`, pinHash);

        // Bootstrap: nobody is admin yet, so whoever this very first account
        // turns out to be becomes the admin, there's no HR system to source
        // that decision from, so "first person to ever open this deployment"
        // is the least-surprising stand-in for "whoever set this up."
        const admins = (await this.state.storage.get('admins')) || [];
        const anyUserExists = await this.state.storage.get('anyUserExists');
        if (!anyUserExists && admins.length === 0) {
          await this.state.storage.put('admins', [user.id]);
        }
        await this.state.storage.put('anyUserExists', true);
      }
      if (!Array.isArray(user.deviceIds)) {
        // migrate the old single-deviceId shape from before multi-device trust existed
        user.deviceIds = user.deviceId ? [user.deviceId] : [];
        delete user.deviceId;
        await this.state.storage.put(`user:${pinHash}`, user);
      }
      if (displayName && !user.displayName) {
        user.displayName = displayName;
        await this.state.storage.put(`user:${pinHash}`, user);
        await this.state.storage.put(`userById:${user.id}`, userByIdSnapshot(user));
      }

      // Device trust: the PIN alone isn't enough to sign in from a device
      // that isn't already trusted, this is what actually answers "someone
      // has my PIN now, so what." `deviceId` is a random id the client
      // generates once and keeps in localStorage; it's a deterrent against
      // casual PIN sharing/leaks, not a cryptographic guarantee (a client
      // that skips sending it, or sends a fake one, isn't stopped by this).
      // A brand-new account's first device is auto-trusted (nothing to
      // approve against yet); after that, a new device needs an existing
      // trusted device to approve it (see /device-link/request+approve)
      // rather than being turned away with no recourse but an admin reset.
      if (!user.mustChangePin && deviceId && !user.deviceIds.includes(deviceId)) {
        if (user.deviceIds.length === 0) {
          user.deviceIds = [deviceId];
          await this.state.storage.put(`user:${pinHash}`, user);
          await this.state.storage.put(`userById:${user.id}`, userByIdSnapshot(user));
          await this.state.storage.put(`userIdToPinHash:${user.id}`, pinHash);
        } else {
          return json({ error: 'device_approval_required' }, 403);
        }
      }

      if (roster && roster.status !== 'claimed') {
        roster.status = 'claimed';
        roster.userId = user.id;
        roster.claimedAt = Date.now();
        await this.state.storage.put(`roster:${roster.id}`, roster);

        // Let admins know someone from the roster actually showed up, the
        // "notifications" half of HR-linked onboarding. Best-effort, never
        // blocks login if a push fails.
        const admins = (await this.state.storage.get('admins')) || [];
        if (admins.length && this.env.USER_CHANNEL) {
          const payload = JSON.stringify({ title: 'PArA PIN', body: `${user.displayName || 'Someone'} just joined PArA PIN`, chatId: null });
          for (const adminId of admins) {
            if (adminId === user.id) continue;
            try {
              const stub = this.env.USER_CHANNEL.get(this.env.USER_CHANNEL.idFromName(adminId));
              await stub.fetch('https://internal/push-direct', { method: 'POST', body: payload });
            } catch (e) {}
          }
        }

        // A roster entry provisioned via /org/roster (as opposed to the
        // app-wide /admin/roster) is how someone brand-new to PArA PIN gets
        // into a specific workspace, claiming that PIN for the first time is
        // this person's actual "join the org" moment, so it happens here
        // rather than needing a separate acceptance step.
        if (roster.orgId) {
          await addUserToOrg(this.state.storage, roster.orgId, user.id);
        }
      }

      const chatIds = (await this.state.storage.get(`userChats:${user.id}`)) || [];
      const chats = [];
      for (const cid of chatIds) {
        const c = await this.state.storage.get(`chat:${cid}`);
        if (c) chats.push(c);
      }

      // Last message + unread count per chat, fetched in one pass so the chat
      // list can show accurate previews and "N unread" the instant the app
      // opens, otherwise a chat only ever looked unread if the app happened
      // to be open (with a live socket) when the message arrived.
      const summaries = {};
      if (this.env.CHAT_ROOM) {
        await Promise.all(chats.map(async (c) => {
          try {
            const stub = this.env.CHAT_ROOM.get(this.env.CHAT_ROOM.idFromName(c.id));
            const res = await stub.fetch(`https://internal/summary?userId=${encodeURIComponent(user.id)}`);
            if (res.ok) summaries[c.id] = await res.json();
          } catch (e) {}
        }));
      }

      // Chats this user removed from their own list ("Remove chat") stay
      // hidden only until something new happens in them, comparing each
      // hidden chat's last-message time against the moment it was hidden
      // means a fresh message from the other person brings it back on its
      // own, without either side needing to do anything.
      const hidden = (await this.state.storage.get(`hiddenChats:${user.id}`)) || {};
      let hiddenChanged = false;
      const visibleChats = [];
      for (const c of chats) {
        const hiddenAt = hidden[c.id];
        if (hiddenAt) {
          const summary = summaries[c.id];
          const lastTs = summary && summary.lastMessage ? summary.lastMessage.ts : 0;
          if (lastTs > hiddenAt) {
            delete hidden[c.id];
            hiddenChanged = true;
            visibleChats.push(c);
          }
          continue;
        }
        visibleChats.push(c);
      }
      if (hiddenChanged) await this.state.storage.put(`hiddenChats:${user.id}`, hidden);
      const pinnedChatIds = (await this.state.storage.get(`pinnedChats:${user.id}`)) || [];

      const admins = (await this.state.storage.get('admins')) || [];

      // "Personal" (id: null) always exists implicitly for everyone, it's
      // exactly today's single shared space, unchanged. Anything else here
      // is a real workspace this user has been added to.
      const myOrgIds = (await this.state.storage.get(`userOrgs:${user.id}`)) || [];
      const orgs = [{ id: null, name: 'Personal' }];
      for (const oid of myOrgIds) {
        const org = await this.state.storage.get(`org:${oid}`);
        if (org) orgs.push({ id: org.id, name: org.name, logoUrl: org.logoUrl || null, isAdmin: await isOrgAdmin(this.state.storage, org.id, user.id) });
      }

      return json({
        userId: user.id,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl || null,
        department: user.department || null,
        isAdmin: admins.includes(user.id),
        e2eePublicKey: user.e2eePublicKey || null,
        mustChangePin: !!user.mustChangePin,
        // Reaching this response at all means the current device already
        // passed the trust check above, the count is just so the person can
        // see, e.g., "2 devices" after approving a second one, without
        // needing admin access.
        trustedDeviceCount: user.deviceIds.length,
        chats: visibleChats,
        summaries,
        pinnedChatIds,
        orgs,
      });
    }

    if (request.method === 'POST' && url.pathname === '/profile') {
      const { pinHash, displayName, avatarUrl, department } = await request.json();
      const user = await this.state.storage.get(`user:${pinHash}`);
      if (!user) return json({ error: 'not_registered' }, 401);
      if (typeof displayName === 'string' && displayName.trim()) user.displayName = displayName.trim().slice(0, 40);
      if (typeof avatarUrl === 'string' || avatarUrl === null) user.avatarUrl = sanitizeAvatarUrl(avatarUrl);
      if (typeof department === 'string') user.department = department.trim().slice(0, 60) || null;
      await this.state.storage.put(`user:${user.pinHash}`, user);
      await this.state.storage.put(`userById:${user.id}`, userByIdSnapshot(user));
      return json({ ok: true, displayName: user.displayName, avatarUrl: user.avatarUrl || null, department: user.department || null });
    }

    // Uploads THIS device's E2EE public key (ECDH P-256, raw bytes,
    // base64url) for the account. Safe to call on every login, it just
    // keeps the server's copy in sync with whatever's actually in this
    // browser's IndexedDB. The matching private key never leaves the device.
    //
    // Two fields get written here, for backward-compatibility reasons:
    //  - `devicePublicKeys[deviceId]` is the current, authoritative record,
    //    every trusted device gets its own entry, which is what makes
    //    multi-device E2EE (a message wrapped separately for each of a
    //    person's devices) possible at all.
    //  - `e2eePublicKey` (singular) is the OLD pre-multi-device field. DMs
    //    created before multi-device shipped were encrypted with a key
    //    derived directly from this single field, with no wrap stored
    //    anywhere, so it's the only way old DM history stays decryptable.
    //    It keeps updating for as long as the account only has one trusted
    //    device (the common case, and exactly the situation the old scheme
    //    assumed), then freezes the moment a second device joins, from
    //    that point on it just serves as a fixed fallback key for whichever
    //    device was original, rather than a live "latest device" pointer
    //    that would otherwise silently break DMs every time someone signs
    //    into a new device (which is the bug this replaces).
    if (request.method === 'POST' && url.pathname === '/e2ee/public-key') {
      const { pinHash, publicKey, deviceId } = await request.json();
      const user = await this.state.storage.get(`user:${pinHash}`);
      if (!user) return json({ error: 'not_registered' }, 401);
      if (typeof publicKey !== 'string' || !publicKey || publicKey.length > 500) {
        return json({ error: 'invalid_key' }, 400);
      }
      if (!Array.isArray(user.deviceIds)) user.deviceIds = user.deviceId ? [user.deviceId] : [];
      if (!user.devicePublicKeys || typeof user.devicePublicKeys !== 'object') user.devicePublicKeys = {};
      if (deviceId) user.devicePublicKeys[deviceId] = publicKey;
      if (user.deviceIds.length <= 1) user.e2eePublicKey = publicKey;
      await this.state.storage.put(`user:${user.pinHash}`, user);
      await this.state.storage.put(`userById:${user.id}`, userByIdSnapshot(user));
      return json({ ok: true });
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
      const { pinHash, targetPinHash, orgId } = await request.json();
      const me = await this.state.storage.get(`user:${pinHash}`);
      if (!me) return json({ error: 'not_registered' }, 401);

      // Rate-limited per account rather than per IP, this caller is already
      // authenticated so their user id is a stabler identity than an IP that
      // could rotate. Shared bucket with /group's memberPinHashes checks
      // below, both are "does this PIN belong to someone" lookups and
      // shouldn't add up to double the effective budget.
      const rl = await checkRateLimit(this.state.storage, `contact:${me.id}`, {
        maxAttempts: 15, windowMs: 10 * 60 * 1000, lockoutMs: 30 * 60 * 1000,
      });
      if (!rl.allowed) return json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, 429);

      if (orgId && !(await isOrgMember(this.state.storage, orgId, me.id))) {
        return json({ error: 'not_org_member' }, 403);
      }

      const other = await this.state.storage.get(`user:${targetPinHash}`);
      if (!other) return json({ error: 'pin_not_found' }, 404);
      if (other.id === me.id) return json({ error: 'cannot_add_self' }, 400);

      // A workspace is a genuinely separate space, per the earlier design
      // decision, so starting a chat "inside" one requires the other person
      // to actually be a member of it, otherwise this would be a backdoor
      // for reaching people outside the workspace from within it.
      if (orgId && !(await isOrgMember(this.state.storage, orgId, other.id))) {
        return json({ error: 'not_org_member' }, 403);
      }

      const myChatIds = (await this.state.storage.get(`userChats:${me.id}`)) || [];
      for (const cid of myChatIds) {
        const c = await this.state.storage.get(`chat:${cid}`);
        if (c && c.type === 'dm' && c.memberIds.includes(other.id) && (c.orgId || null) === (orgId || null)) {
          // Re-adding someone whose chat you'd previously removed from your
          // own list should bring it back, you clearly want to talk to them
          // again, so there's no reason to leave it hidden.
          const hidden = (await this.state.storage.get(`hiddenChats:${me.id}`)) || {};
          if (hidden[cid]) {
            delete hidden[cid];
            await this.state.storage.put(`hiddenChats:${me.id}`, hidden);
          }
          return json({ chat: c, existing: true });
        }
      }

      // Not in *my* list, but "Delete chat" only ever removes a DM from the
      // deleter's own userChats, the other side (and the underlying
      // ChatRoom/message history) is untouched. So before minting a brand
      // new chat (and a brand new, empty history) for this pair, check
      // whether the *other* person still has one, if so, just re-join that
      // same chat instead. Skipping this check is exactly how the earlier
      // "duplicate account/chat" bug happened.
      const otherChatIds = (await this.state.storage.get(`userChats:${other.id}`)) || [];
      for (const cid of otherChatIds) {
        const c = await this.state.storage.get(`chat:${cid}`);
        if (c && c.type === 'dm' && c.memberIds.includes(me.id) && (c.orgId || null) === (orgId || null)) {
          await this.state.storage.put(`userChats:${me.id}`, [...myChatIds, cid]);
          return json({ chat: c, existing: true });
        }
      }

      const chatId = crypto.randomUUID();
      const chat = { id: chatId, type: 'dm', name: null, memberIds: [me.id, other.id], createdAt: Date.now(), orgId: orgId || null };
      await this.state.storage.put(`chat:${chatId}`, chat);
      await this.state.storage.put(`userChats:${me.id}`, [...myChatIds, chatId]);
      await this.state.storage.put(`userChats:${other.id}`, [...otherChatIds, chatId]);
      const allChatIds = (await this.state.storage.get('allChatIds')) || [];
      await this.state.storage.put('allChatIds', [...allChatIds, chatId]);

      return json({ chat, existing: false });
    }

    if (request.method === 'POST' && url.pathname === '/group') {
      const { pinHash, name, memberPinHashes, memberIds: directMemberIds, orgId } = await request.json();
      const me = await this.state.storage.get(`user:${pinHash}`);
      if (!me) return json({ error: 'not_registered' }, 401);

      if (orgId && !(await isOrgMember(this.state.storage, orgId, me.id))) {
        return json({ error: 'not_org_member' }, 403);
      }

      // memberPinHashes is a batch of "does this PIN belong to someone"
      // checks, exactly what /contact's rate limit exists to throttle, a
      // single unbounded array here would let one call check thousands of
      // PINs before that limit ever saw more than one request. Hard-cap the
      // batch size (40 invitees is already generous for one group) and
      // charge the whole batch against the same per-account budget /contact
      // uses, so the two surfaces can't be combined to double it.
      if (Array.isArray(memberPinHashes) && memberPinHashes.length > 40) {
        return json({ error: 'too_many_members_at_once', max: 40 }, 400);
      }
      const lookupCost = Array.isArray(memberPinHashes) ? memberPinHashes.length : 0;
      if (lookupCost > 0) {
        const rl = await checkRateLimit(this.state.storage, `contact:${me.id}`, {
          maxAttempts: 15, windowMs: 10 * 60 * 1000, lockoutMs: 30 * 60 * 1000, cost: lookupCost,
        });
        if (!rl.allowed) return json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, 429);
      }

      const memberIds = [me.id];
      const notFound = [];
      const notOrgMember = [];

      for (const id of directMemberIds || []) {
        if (id === me.id || memberIds.includes(id)) continue;
        const rec = await this.state.storage.get(`userById:${id}`);
        if (!rec) continue;
        if (orgId && !(await isOrgMember(this.state.storage, orgId, id))) { notOrgMember.push(id); continue; }
        memberIds.push(id);
      }

      for (const ph of memberPinHashes || []) {
        const u = await this.state.storage.get(`user:${ph}`);
        if (!u) { notFound.push(ph); continue; }
        if (memberIds.includes(u.id)) continue;
        if (orgId && !(await isOrgMember(this.state.storage, orgId, u.id))) { notOrgMember.push(u.id); continue; }
        memberIds.push(u.id);
      }
      if (memberIds.length < 2) return json({ error: 'need_at_least_one_member', notFound, notOrgMember }, 400);

      const chatId = crypto.randomUUID();
      const chat = { id: chatId, type: 'group', name: name || 'Group', memberIds, createdAt: Date.now(), createdBy: me.id, avatarUrl: null, orgId: orgId || null };
      await this.state.storage.put(`chat:${chatId}`, chat);
      for (const uid of memberIds) {
        const list = (await this.state.storage.get(`userChats:${uid}`)) || [];
        await this.state.storage.put(`userChats:${uid}`, [...list, chatId]);
      }
      const allChatIds = (await this.state.storage.get('allChatIds')) || [];
      await this.state.storage.put('allChatIds', [...allChatIds, chatId]);
      return json({ chat, notFound, notOrgMember });
    }

    // Group photo, restricted to whoever created the group and to app-wide
    // admins (the same "admins" list /admin/promote already manages), a
    // regular member can't reach in and change how the group looks for
    // everyone else, same reasoning as e.g. only the creator/an admin being
    // able to rename a shared Slack channel.
    if (request.method === 'POST' && url.pathname === '/group/avatar') {
      const { pinHash, chatId, avatarUrl } = await request.json();
      const me = await this.state.storage.get(`user:${pinHash}`);
      if (!me) return json({ error: 'not_registered' }, 401);
      const chat = await this.state.storage.get(`chat:${chatId}`);
      if (!chat || chat.type !== 'group' || !chat.memberIds.includes(me.id)) {
        return json({ error: 'not_found' }, 404);
      }
      const admins = (await this.state.storage.get('admins')) || [];
      const canEdit = chat.createdBy === me.id || admins.includes(me.id);
      if (!canEdit) return json({ error: 'not_allowed' }, 403);
      chat.avatarUrl = sanitizeAvatarUrl(avatarUrl);
      await this.state.storage.put(`chat:${chatId}`, chat);
      return json({ ok: true, chat });
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

    // Removes a DM from just this user's own chat list, purely a per-user
    // preference (like notify-prefs), never touches the shared chat record
    // or the other person's list, so it's safe for one side of a duplicate
    // conversation to clean up without affecting the other. It automatically
    // comes back the next time a new message arrives (see /session, which
    // compares each hidden chat's lastMessage timestamp against the time it
    // was hidden) or the moment either side re-adds the contact.
    if (request.method === 'POST' && url.pathname === '/hide-chat') {
      const { pinHash, chatId } = await request.json();
      const user = await this.state.storage.get(`user:${pinHash}`);
      if (!user) return json({ ok: false, error: 'not_registered' }, 401);
      const myChatIds = (await this.state.storage.get(`userChats:${user.id}`)) || [];
      if (!myChatIds.includes(chatId)) return json({ ok: false, error: 'not_found' }, 404);
      const hidden = (await this.state.storage.get(`hiddenChats:${user.id}`)) || {};
      hidden[chatId] = Date.now();
      await this.state.storage.put(`hiddenChats:${user.id}`, hidden);
      return json({ ok: true });
    }

    // Permanently removes a DM from just this user's own chat list, unlike
    // /hide-chat, it does NOT come back on a new message. Still only ever
    // touches the caller's own userChats: the other person's list, the
    // shared chat record, and the message history are all untouched, and
    // /contact's own-list-first-then-other's-list check (above) means
    // re-adding this same person later reuses the same chat instead of
    // quietly starting a second, empty one.
    if (request.method === 'POST' && url.pathname === '/delete-chat') {
      const { pinHash, chatId } = await request.json();
      const user = await this.state.storage.get(`user:${pinHash}`);
      if (!user) return json({ ok: false, error: 'not_registered' }, 401);
      const myChatIds = (await this.state.storage.get(`userChats:${user.id}`)) || [];
      if (!myChatIds.includes(chatId)) return json({ ok: false, error: 'not_found' }, 404);
      await this.state.storage.put(`userChats:${user.id}`, myChatIds.filter((id) => id !== chatId));
      const hidden = (await this.state.storage.get(`hiddenChats:${user.id}`)) || {};
      if (hidden[chatId]) { delete hidden[chatId]; await this.state.storage.put(`hiddenChats:${user.id}`, hidden); }
      const pinned = (await this.state.storage.get(`pinnedChats:${user.id}`)) || [];
      if (pinned.includes(chatId)) await this.state.storage.put(`pinnedChats:${user.id}`, pinned.filter((id) => id !== chatId));
      return json({ ok: true });
    }

    // A purely per-user display preference (sorted to the top client-side),
    // doesn't affect the other person's view of the same chat at all.
    if (request.method === 'POST' && url.pathname === '/pin-chat') {
      const { pinHash, chatId, pinned: shouldPin } = await request.json();
      const user = await this.state.storage.get(`user:${pinHash}`);
      if (!user) return json({ ok: false, error: 'not_registered' }, 401);
      const myChatIds = (await this.state.storage.get(`userChats:${user.id}`)) || [];
      if (!myChatIds.includes(chatId)) return json({ ok: false, error: 'not_found' }, 404);
      let pinned = (await this.state.storage.get(`pinnedChats:${user.id}`)) || [];
      pinned = pinned.filter((id) => id !== chatId);
      if (shouldPin) pinned.push(chatId);
      await this.state.storage.put(`pinnedChats:${user.id}`, pinned);
      return json({ ok: true, pinnedChatIds: pinned });
    }

    if (request.method === 'GET' && url.pathname === '/whoami') {
      const pinHash = url.searchParams.get('pinHash');
      const user = await this.state.storage.get(`user:${pinHash}`);
      if (!user) return json({ ok: false });
      const admins = (await this.state.storage.get('admins')) || [];
      return json({ ok: true, userId: user.id, displayName: user.displayName, avatarUrl: user.avatarUrl || null, isAdmin: admins.includes(user.id) });
    }

    // Per-user call history, each client writes its own side of a call
    // independently once it ends (see /api/calls/log), so no cross-user name
    // lookup is needed here: the caller already knows who they dialed, and
    // the callee already got the caller's name/avatar in the incoming offer.
    if (request.method === 'GET' && url.pathname === '/call-log') {
      const userId = url.searchParams.get('userId');
      if (!userId) return json({ error: 'missing_user_id' }, 400);
      const log = (await this.state.storage.get(`callLog:${userId}`)) || [];
      return json({ log });
    }

    if (request.method === 'POST' && url.pathname === '/call-log') {
      const { userId, entry } = await request.json();
      if (!userId || !entry || !entry.withUserId || !entry.direction || !entry.outcome) {
        return json({ error: 'invalid' }, 400);
      }
      const log = (await this.state.storage.get(`callLog:${userId}`)) || [];
      log.unshift({
        id: crypto.randomUUID(),
        withUserId: entry.withUserId,
        withName: entry.withName || 'Someone',
        withAvatarUrl: entry.withAvatarUrl || null,
        direction: entry.direction === 'incoming' ? 'incoming' : 'outgoing',
        outcome: ['answered', 'missed', 'declined', 'busy'].includes(entry.outcome) ? entry.outcome : 'answered',
        durationSec: Math.max(0, Math.round(Number(entry.durationSec) || 0)),
        isVideo: !!entry.isVideo,
        ts: Date.now(),
      });
      const capped = log.slice(0, 50);
      await this.state.storage.put(`callLog:${userId}`, capped);
      return json({ ok: true, log: capped });
    }

    // ---- Organizations / workspaces ----
    // Admin-invited only: no email-domain detection, no self-serve joining.
    // Someone who already has a PArA PIN account gets added by PIN (like
    // /contact). Someone brand new gets provisioned a PIN via /org/roster,
    // reusing the exact same generate-PIN-and-email-it flow as /admin/roster,
    // just tagged with an orgId so claiming it also joins that workspace
    // (see the roster-claim block in /session above).
    if (request.method === 'POST' && url.pathname === '/org/create') {
      const { pinHash, name } = await request.json();
      const me = await this.state.storage.get(`user:${pinHash}`);
      if (!me) return json({ error: 'not_registered' }, 401);
      if (!name || !name.trim()) return json({ error: 'missing_name' }, 400);

      const orgId = crypto.randomUUID();
      const org = { id: orgId, name: name.trim().slice(0, 60), logoUrl: null, createdAt: Date.now(), createdBy: me.id, admins: [me.id] };
      await this.state.storage.put(`org:${orgId}`, org);
      await addUserToOrg(this.state.storage, orgId, me.id);
      return json({ org });
    }

    // Org-admin-only branding: rename the workspace and/or set its logo.
    // logoUrl goes through the same sanitizer as profile/group avatars (must
    // be exactly this app's own /api/media/<uuid> shape), since it gets
    // interpolated client-side into a CSS url("...") the same way those do.
    if (request.method === 'POST' && url.pathname === '/org/update') {
      const { pinHash, orgId, name, logoUrl } = await request.json();
      const me = await this.state.storage.get(`user:${pinHash}`);
      if (!me) return json({ error: 'not_registered' }, 401);
      if (!orgId || !(await isOrgAdmin(this.state.storage, orgId, me.id))) {
        return json({ error: 'forbidden' }, 403);
      }
      const org = await this.state.storage.get(`org:${orgId}`);
      if (!org) return json({ error: 'not_found' }, 404);
      if (typeof name === 'string' && name.trim()) org.name = name.trim().slice(0, 60);
      if (logoUrl !== undefined) org.logoUrl = sanitizeAvatarUrl(logoUrl);
      await this.state.storage.put(`org:${orgId}`, org);
      return json({ org });
    }

    if (request.method === 'POST' && url.pathname === '/org/invite') {
      const { pinHash, orgId, targetPinHash } = await request.json();
      const me = await this.state.storage.get(`user:${pinHash}`);
      if (!me) return json({ error: 'not_registered' }, 401);
      if (!orgId || !(await isOrgAdmin(this.state.storage, orgId, me.id))) {
        return json({ error: 'forbidden' }, 403);
      }

      // Same "does this PIN belong to someone" surface as /contact, sharing
      // its rate-limit bucket so this can't be used to get extra lookups.
      const rl = await checkRateLimit(this.state.storage, `contact:${me.id}`, {
        maxAttempts: 15, windowMs: 10 * 60 * 1000, lockoutMs: 30 * 60 * 1000,
      });
      if (!rl.allowed) return json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, 429);

      const other = await this.state.storage.get(`user:${targetPinHash}`);
      if (!other) return json({ error: 'pin_not_found' }, 404);
      await addUserToOrg(this.state.storage, orgId, other.id);
      return json({ ok: true, userId: other.id, displayName: other.displayName, avatarUrl: other.avatarUrl || null });
    }

    if (request.method === 'GET' && url.pathname === '/org/members') {
      const pinHash = url.searchParams.get('pinHash');
      const orgId = url.searchParams.get('orgId');
      const me = await this.state.storage.get(`user:${pinHash}`);
      if (!me) return json({ error: 'not_registered' }, 401);
      if (!orgId || !(await isOrgMember(this.state.storage, orgId, me.id))) {
        return json({ error: 'forbidden' }, 403);
      }
      const memberIds = (await this.state.storage.get(`orgMembers:${orgId}`)) || [];
      const members = [];
      for (const id of memberIds) {
        const rec = await this.state.storage.get(`userById:${id}`);
        if (rec) members.push(rec);
      }
      return json({ members });
    }

    if (request.method === 'POST' && url.pathname === '/org/leave') {
      const { pinHash, orgId } = await request.json();
      const me = await this.state.storage.get(`user:${pinHash}`);
      if (!me) return json({ error: 'not_registered' }, 401);
      const userOrgs = (await this.state.storage.get(`userOrgs:${me.id}`)) || [];
      await this.state.storage.put(`userOrgs:${me.id}`, userOrgs.filter((id) => id !== orgId));
      const members = (await this.state.storage.get(`orgMembers:${orgId}`)) || [];
      await this.state.storage.put(`orgMembers:${orgId}`, members.filter((id) => id !== me.id));
      return json({ ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/org/roster') {
      const { pinHash, orgId, name, department, email, force } = await request.json();
      const me = await this.state.storage.get(`user:${pinHash}`);
      if (!me) return json({ error: 'not_registered' }, 401);
      if (!orgId || !(await isOrgAdmin(this.state.storage, orgId, me.id))) {
        return json({ error: 'forbidden' }, 403);
      }
      if (!name || !name.trim()) return json({ error: 'missing_name' }, 400);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'invalid_email' }, 400);

      if (!force) {
        const trimmedName = name.trim().toLowerCase();
        const list = (await this.state.storage.get('rosterList')) || [];
        for (const id of list) {
          const e = await this.state.storage.get(`roster:${id}`);
          if (e && e.status !== 'disabled' && e.name.trim().toLowerCase() === trimmedName) {
            return json({ error: 'duplicate_name', existingStatus: e.status }, 409);
          }
        }
      }

      let pin = null;
      let pinHashOut = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        const candidate = String(Math.floor(1000000 + Math.random() * 9000000));
        const candidateHash = await sha256Hex(candidate);
        const existingUser = await this.state.storage.get(`user:${candidateHash}`);
        const existingRoster = await this.state.storage.get(`rosterByPin:${candidateHash}`);
        if (!existingUser && !existingRoster) { pin = candidate; pinHashOut = candidateHash; break; }
      }
      if (!pin) return json({ error: 'could_not_generate_pin' }, 500);

      const id = crypto.randomUUID();
      const entry = {
        id,
        name: name.trim().slice(0, 60),
        department: (department || '').trim().slice(0, 60) || null,
        email: email ? String(email).trim().slice(0, 200) : null,
        status: 'pending',
        userId: null,
        orgId,
        createdAt: Date.now(),
        claimedAt: null,
      };
      await this.state.storage.put(`roster:${id}`, entry);
      await this.state.storage.put(`rosterByPin:${pinHashOut}`, id);
      const list = (await this.state.storage.get('rosterList')) || [];
      await this.state.storage.put('rosterList', [...list, id]);

      let emailResult = { sent: false, error: 'no_email_provided' };
      if (entry.email) {
        emailResult = await sendOnboardingEmail(this.env, { to: entry.email, name: entry.name, pin });
      }
      return json({ entry, pin: emailResult.sent ? undefined : pin, emailSent: emailResult.sent, emailError: emailResult.sent ? undefined : emailResult.error });
    }

    // ---- Admin roster: lightweight stand-in for "HR-linked onboarding" ----
    // No real HR system exists to source this from, so an admin pre-adds a
    // person by name/department, gets a freshly generated PIN back exactly
    // once (never stored in plaintext, same as every other PIN in this
    // app), and hands it to them directly. The first time that PIN is
    // actually used, /session claims the entry and pre-fills their profile.
    if (request.method === 'GET' && url.pathname === '/admin/roster') {
      const requesterId = url.searchParams.get('requesterId');
      const admins = (await this.state.storage.get('admins')) || [];
      if (!requesterId || !admins.includes(requesterId)) return json({ error: 'forbidden' }, 403);
      const list = (await this.state.storage.get('rosterList')) || [];
      const entries = [];
      for (const id of list) {
        const e = await this.state.storage.get(`roster:${id}`);
        if (e) entries.push(e);
      }
      entries.sort((a, b) => b.createdAt - a.createdAt);
      return json({ entries });
    }

    if (request.method === 'POST' && url.pathname === '/admin/roster') {
      const { requesterId, name, department, email, force } = await request.json();
      const admins = (await this.state.storage.get('admins')) || [];
      if (!requesterId || !admins.includes(requesterId)) return json({ error: 'forbidden' }, 403);
      if (!name || !name.trim()) return json({ error: 'missing_name' }, 400);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'invalid_email' }, 400);

      // Generating a second PIN for a name that's already on the roster
      // creates a genuinely separate account, not a second way in for the
      // same person, because everything (chats, keys, message history) is
      // keyed off whoever claims each PIN. If that PIN reaches the same
      // person again, they end up as two different identities with their
      // history split across both, which looks exactly like "their messages
      // disappeared." This won't silently do that, it asks first, unless
      // the admin explicitly confirms they mean to (e.g. two people who
      // happen to share a name).
      if (!force) {
        const trimmedName = name.trim().toLowerCase();
        const list = (await this.state.storage.get('rosterList')) || [];
        for (const id of list) {
          const e = await this.state.storage.get(`roster:${id}`);
          if (e && e.status !== 'disabled' && e.name.trim().toLowerCase() === trimmedName) {
            return json({ error: 'duplicate_name', existingStatus: e.status }, 409);
          }
        }
      }

      let pin = null;
      let pinHash = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        const candidate = String(Math.floor(1000000 + Math.random() * 9000000));
        const candidateHash = await sha256Hex(candidate);
        const existingUser = await this.state.storage.get(`user:${candidateHash}`);
        const existingRoster = await this.state.storage.get(`rosterByPin:${candidateHash}`);
        if (!existingUser && !existingRoster) { pin = candidate; pinHash = candidateHash; break; }
      }
      if (!pin) return json({ error: 'could_not_generate_pin' }, 500);

      const id = crypto.randomUUID();
      const entry = {
        id,
        name: name.trim().slice(0, 60),
        department: (department || '').trim().slice(0, 60) || null,
        email: email ? String(email).trim().slice(0, 200) : null,
        status: 'pending',
        userId: null,
        createdAt: Date.now(),
        claimedAt: null,
      };
      await this.state.storage.put(`roster:${id}`, entry);
      await this.state.storage.put(`rosterByPin:${pinHash}`, id);
      const list = (await this.state.storage.get('rosterList')) || [];
      await this.state.storage.put('rosterList', [...list, id]);

      let emailResult = { sent: false, error: 'no_email_provided' };
      if (entry.email) {
        emailResult = await sendOnboardingEmail(this.env, { to: entry.email, name: entry.name, pin });
      }

      // Once the PIN has actually been emailed to the person, there's no
      // reason for it to also sit in this API response / the admin's own
      // screen, the fewer places a shared secret is displayed, the better,
      // and the person will also be forced to change it on first login
      // anyway (see /session's mustChangePin), so the admin never needs it
      // again after this point. If email delivery failed (or wasn't
      // configured), the admin still needs to see and hand over the PIN
      // themselves, so it's included in that case.
      return json({ entry, pin: emailResult.sent ? undefined : pin, emailSent: emailResult.sent, emailError: emailResult.sent ? undefined : emailResult.error });
    }

    if (request.method === 'POST' && url.pathname === '/admin/roster/disable') {
      const { requesterId, id } = await request.json();
      const admins = (await this.state.storage.get('admins')) || [];
      if (!requesterId || !admins.includes(requesterId)) return json({ error: 'forbidden' }, 403);
      const entry = await this.state.storage.get(`roster:${id}`);
      if (!entry) return json({ error: 'not_found' }, 404);
      entry.status = 'disabled';
      await this.state.storage.put(`roster:${id}`, entry);
      return json({ ok: true, entry });
    }

    // ---- Global message retention ----
    // A single admin-set window applies everywhere, 0/absent means "keep
    // forever" (the default, no behavior change unless an admin opts in).
    // The actual purge happens on a daily Cron Trigger (see the `scheduled`
    // export), which reads this value and asks every ChatRoom to drop
    // anything older than the cutoff.
    if (request.method === 'GET' && url.pathname === '/admin/retention') {
      const requesterId = url.searchParams.get('requesterId');
      const admins = (await this.state.storage.get('admins')) || [];
      if (!requesterId || !admins.includes(requesterId)) return json({ error: 'forbidden' }, 403);
      const retentionDays = (await this.state.storage.get('retentionDays')) || 0;
      return json({ retentionDays });
    }
    if (request.method === 'POST' && url.pathname === '/admin/retention') {
      const { requesterId, retentionDays } = await request.json();
      const admins = (await this.state.storage.get('admins')) || [];
      if (!requesterId || !admins.includes(requesterId)) return json({ error: 'forbidden' }, 403);
      const days = Number(retentionDays) || 0;
      if (![0, 30, 90, 365].includes(days)) return json({ error: 'invalid_value' }, 400);
      await this.state.storage.put('retentionDays', days);
      return json({ ok: true, retentionDays: days });
    }

    // ---- Device lock management ----
    // Lists everyone who's ever logged in (not just admin-roster invites,
    // this covers self-created PINs too) with whether their PIN is currently
    // bound to a device, so an admin can find and reset anyone's lock.
    if (request.method === 'GET' && url.pathname === '/admin/users') {
      const requesterId = url.searchParams.get('requesterId');
      const admins = (await this.state.storage.get('admins')) || [];
      if (!requesterId || !admins.includes(requesterId)) return json({ error: 'forbidden' }, 403);
      const map = await this.state.storage.list({ prefix: 'userById:' });
      const users = [];
      for (const rec of map.values()) {
        users.push({ id: rec.id, displayName: rec.displayName || 'Unnamed', hasDeviceLock: !!rec.hasDeviceLock, deviceCount: rec.deviceCount || (rec.hasDeviceLock ? 1 : 0), isAdmin: admins.includes(rec.id) });
      }
      return json({ users });
    }

    // Admin status is account-level (controls access to this Admin Console)
    // and is completely separate from who created a given group, creating
    // a group doesn't make you its "admin" in any special sense here; every
    // member of a group has the same abilities (see /leave-group etc.).
    // Anyone already an admin can promote or demote anyone else, including
    // themselves, EXCEPT the last remaining admin can't demote themselves,
    // otherwise the account roster/retention/device panel would become
    // permanently unreachable with no way back in short of editing storage
    // directly.
    // Recovery hatch for "I should be admin but I'm not, and there's no
    // admin left who can promote me", e.g. testing with a different PIN
    // than whichever one happened to be first through the door when this
    // was originally deployed. Gated entirely by ADMIN_BOOTSTRAP_KEY, a
    // secret only settable via `wrangler secret put`, nobody without
    // Cloudflare access to this project can ever call this successfully,
    // regardless of whether they know this endpoint exists. If the secret
    // was never set, this always fails closed.
    if (request.method === 'POST' && url.pathname === '/admin/bootstrap') {
      const { pinHash, key } = await request.json();
      if (!this.env.ADMIN_BOOTSTRAP_KEY || !key || key !== this.env.ADMIN_BOOTSTRAP_KEY) {
        return json({ error: 'forbidden' }, 403);
      }
      const user = await this.state.storage.get(`user:${pinHash}`);
      if (!user) return json({ error: 'not_registered' }, 401);
      const admins = (await this.state.storage.get('admins')) || [];
      if (!admins.includes(user.id)) {
        admins.push(user.id);
        await this.state.storage.put('admins', admins);
      }
      return json({ ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/admin/promote') {
      const { requesterId, userId } = await request.json();
      const admins = (await this.state.storage.get('admins')) || [];
      if (!requesterId || !admins.includes(requesterId)) return json({ error: 'forbidden' }, 403);
      if (!userId) return json({ error: 'missing_fields' }, 400);
      const pinHash = await this.state.storage.get(`userIdToPinHash:${userId}`);
      if (!pinHash) return json({ error: 'not_found' }, 404);
      if (!admins.includes(userId)) {
        admins.push(userId);
        await this.state.storage.put('admins', admins);
      }
      return json({ ok: true });
    }
    if (request.method === 'POST' && url.pathname === '/admin/demote') {
      const { requesterId, userId } = await request.json();
      let admins = (await this.state.storage.get('admins')) || [];
      if (!requesterId || !admins.includes(requesterId)) return json({ error: 'forbidden' }, 403);
      if (!userId) return json({ error: 'missing_fields' }, 400);
      if (admins.length <= 1 && admins.includes(userId)) {
        return json({ error: 'last_admin' }, 400);
      }
      admins = admins.filter((id) => id !== userId);
      await this.state.storage.put('admins', admins);
      return json({ ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/admin/reset-device') {
      const { requesterId, userId } = await request.json();
      const admins = (await this.state.storage.get('admins')) || [];
      if (!requesterId || !admins.includes(requesterId)) return json({ error: 'forbidden' }, 403);
      const pinHash = await this.state.storage.get(`userIdToPinHash:${userId}`);
      if (!pinHash) return json({ error: 'not_found' }, 404);
      const user = await this.state.storage.get(`user:${pinHash}`);
      if (!user) return json({ error: 'not_found' }, 404);
      // Clears ALL trusted devices, not just one, after this, the very next
      // device to log in with the (still-unchanged) PIN is auto-trusted again,
      // same as a brand-new account. That's the intentional "lost every
      // device" escape hatch; if only one of several devices was lost, the
      // person is generally better served by staying signed in on the others
      // and just not approving the lost one for anything new.
      user.deviceIds = [];
      user.pendingDeviceLink = null;
      user.devicePublicKeys = {};
      await this.state.storage.put(`user:${pinHash}`, user);
      await this.state.storage.put(`userById:${user.id}`, userByIdSnapshot(user));
      return json({ ok: true });
    }

    // ---- Mandatory PIN change (closes the "admin already knows the PIN"
    // window for roster-issued accounts) ----
    // Authenticated by knowing the CURRENT pin hash (same trust model as
    // every other endpoint here), the point isn't stronger auth, it's that
    // completing this step is what finally binds a device and stops the
    // admin-issued PIN from being usable as a permanent credential at all.
    if (request.method === 'POST' && url.pathname === '/change-pin') {
      const { oldPinHash, newPinHash, deviceId } = await request.json();
      if (!oldPinHash || !newPinHash) return json({ error: 'missing_fields' }, 400);
      if (oldPinHash === newPinHash) return json({ error: 'pin_unchanged' }, 400);
      const user = await this.state.storage.get(`user:${oldPinHash}`);
      if (!user) return json({ error: 'not_found' }, 404);

      // The `pin_taken` check below is exactly the kind of oracle the
      // /session, /contact, and /group rate limits exist to close off (it
      // answers "does this PIN belong to someone" for any candidate you
      // hand it), but this endpoint had no throttle of its own, so a signed-in
      // account could hammer it with candidate newPinHash values to enumerate
      // other people's PINs at full speed, no lockout, ever. Rate-limit it
      // the same way, keyed by the caller's own account so switching accounts
      // doesn't reset the budget.
      const rl = await checkRateLimit(this.state.storage, `changepin:${user.id}`, {
        maxAttempts: 10, windowMs: 10 * 60 * 1000, lockoutMs: 30 * 60 * 1000,
      });
      if (!rl.allowed) return json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, 429);

      const clash = await this.state.storage.get(`user:${newPinHash}`);
      if (clash) return json({ error: 'pin_taken' }, 409);

      user.pinHash = newPinHash;
      user.mustChangePin = false;
      user.deviceIds = deviceId ? [deviceId] : [];
      await this.state.storage.delete(`user:${oldPinHash}`);
      await this.state.storage.put(`user:${newPinHash}`, user);
      await this.state.storage.put(`userIdToPinHash:${user.id}`, newPinHash);
      await this.state.storage.put(`userById:${user.id}`, userByIdSnapshot(user));

      // The roster entry (if any) was keyed by the OLD pin hash for lookup
      // purposes; that mapping is now dead weight since the account is
      // already claimed and the old PIN no longer works for anything.
      const rosterId = await this.state.storage.get(`rosterByPin:${oldPinHash}`);
      if (rosterId) await this.state.storage.delete(`rosterByPin:${oldPinHash}`);

      return json({ ok: true });
    }

    // ---- Multi-device trust: linking a new device ----
    // A device that already knows the correct PIN but isn't yet trusted
    // can't just be let in (that's the whole "I know their PIN" problem the
    // user asked to mitigate), it has to be vouched for by a device that's
    // already trusted. This endpoint starts that: it generates a short code
    // and pushes an approval prompt to every device already signed in on
    // this account. The new device displays the SAME code on its own screen
    // and asks the person to read it aloud / show it to whoever has a
    // trusted device, who then types it in over there to approve.
    if (request.method === 'POST' && url.pathname === '/device-link/request') {
      const { pinHash, deviceId } = await request.json();
      if (!pinHash || !deviceId) return json({ error: 'missing_fields' }, 400);
      const user = await this.state.storage.get(`user:${pinHash}`);
      if (!user) return json({ error: 'not_found' }, 404);
      if (!Array.isArray(user.deviceIds)) user.deviceIds = [];
      if (user.deviceIds.includes(deviceId)) return json({ ok: true, alreadyTrusted: true });
      if (user.deviceIds.length === 0) return json({ error: 'no_trusted_devices' }, 400);

      const code = String(Math.floor(100000 + Math.random() * 900000));
      user.pendingDeviceLink = { code, deviceId, requestedAt: Date.now() };
      await this.state.storage.put(`user:${pinHash}`, user);

      if (this.env.USER_CHANNEL) {
        const payload = JSON.stringify({ title: 'PArA PIN', body: 'A new device wants to sign in. Open the app to approve it.', chatId: null, deviceLink: true });
        try {
          const stub = this.env.USER_CHANNEL.get(this.env.USER_CHANNEL.idFromName(user.id));
          await stub.fetch('https://internal/push-direct', { method: 'POST', body: payload });
        } catch (e) {}
      }
      // The code is returned here so the REQUESTING device can display it,
      // it's the one that needs to show it to whoever holds a trusted
      // device, not the other way around. It's already tied to this one
      // pending request/deviceId pair and expires in 10 minutes, so handing
      // it back over the same authenticated channel that started the
      // request isn't a meaningfully bigger exposure than the request itself.
      return json({ ok: true, code, expiresInSec: 600 });
    }

    if (request.method === 'POST' && url.pathname === '/device-link/approve') {
      // Called from an ALREADY-trusted device, pinHash here is that
      // device's own (current, working) credential, not the new device's.
      //
      // CRITICAL: pinHash alone does NOT prove that. Every device signed
      // into an account shares the exact same pinHash (it's derived from the
      // shared PIN, not per-device), so without also checking deviceId here,
      // the untrusted device that just called /device-link/request could
      // immediately call THIS endpoint itself with the code it was handed
      // back in that same response, self-approving with zero involvement
      // from any real trusted device. That defeats the entire point of
      // device-lock ("protect against someone who merely knows the PIN").
      // deviceId is a random UUID generated once and kept only in that
      // device's own localStorage, it's never sent to any other device or
      // included in the push payload, so requiring it here (and checking
      // it's already trusted) actually ties this call to a specific,
      // previously-approved browser instead of just "whoever knows the PIN".
      const { pinHash, code, deviceId } = await request.json();
      if (!pinHash || !code || !deviceId) return json({ error: 'missing_fields' }, 400);
      const user = await this.state.storage.get(`user:${pinHash}`);
      if (!user) return json({ error: 'not_found' }, 404);
      if (!Array.isArray(user.deviceIds) || !user.deviceIds.includes(deviceId)) {
        return json({ error: 'not_a_trusted_device' }, 403);
      }
      // Defense in depth on top of the trusted-device check above: the code
      // is only 6 digits (~900k values), no reason to allow unlimited guesses.
      const dlrl = await checkRateLimit(this.state.storage, `devicelink:${user.id}`, {
        maxAttempts: 10, windowMs: 10 * 60 * 1000, lockoutMs: 30 * 60 * 1000,
      });
      if (!dlrl.allowed) return json({ error: 'rate_limited', retryAfterMs: dlrl.retryAfterMs }, 429);
      const pending = user.pendingDeviceLink;
      if (!pending) return json({ error: 'no_pending_request' }, 400);
      if (Date.now() - pending.requestedAt > 10 * 60 * 1000) {
        user.pendingDeviceLink = null;
        await this.state.storage.put(`user:${pinHash}`, user);
        return json({ error: 'expired' }, 400);
      }
      if (String(code).trim() !== pending.code) return json({ error: 'wrong_code' }, 400);

      if (!Array.isArray(user.deviceIds)) user.deviceIds = [];
      if (!user.deviceIds.includes(pending.deviceId)) user.deviceIds.push(pending.deviceId);
      const approvedDeviceId = pending.deviceId;
      user.pendingDeviceLink = null;
      await this.state.storage.put(`user:${pinHash}`, user);
      await this.state.storage.put(`userById:${user.id}`, userByIdSnapshot(user));
      // Returned so the APPROVING device can immediately re-wrap its chat
      // keys for the newly-trusted device (see rewrapAllChatsForDevice on
      // the client), without this, the new device would sit there able to
      // sign in but unable to decrypt anything until someone happened to
      // send a fresh message in every chat.
      return json({ ok: true, approvedDeviceId });
    }

    // Lets a device that's waiting after /device-link/request poll for the
    // outcome without needing its own push subscription (it isn't trusted
    // yet, so the server won't push directly to it).
    if (request.method === 'GET' && url.pathname === '/device-link/status') {
      const pinHash = url.searchParams.get('pinHash');
      const deviceId = url.searchParams.get('deviceId');
      const user = await this.state.storage.get(`user:${pinHash}`);
      if (!user) return json({ error: 'not_found' }, 404);
      if (Array.isArray(user.deviceIds) && user.deviceIds.includes(deviceId)) {
        return json({ status: 'approved' });
      }
      if (!user.pendingDeviceLink || user.pendingDeviceLink.deviceId !== deviceId) {
        return json({ status: 'none' });
      }
      if (Date.now() - user.pendingDeviceLink.requestedAt > 10 * 60 * 1000) {
        return json({ status: 'expired' });
      }
      return json({ status: 'pending' });
    }

    // Internal-only, used by the scheduled retention purge to enumerate
    // every chat that's ever been created without needing to scan every
    // user's chat list individually.
    if (request.method === 'GET' && url.pathname === '/internal/all-chat-ids') {
      const allChatIds = (await this.state.storage.get('allChatIds')) || [];
      return json({ chatIds: allChatIds });
    }
    if (request.method === 'GET' && url.pathname === '/internal/retention-days') {
      const retentionDays = (await this.state.storage.get('retentionDays')) || 0;
      return json({ retentionDays });
    }

    return new Response('not found', { status: 404 });
  }
}

// One instance per user (keyed by userId), holds a live WebSocket per open
// tab/device for that user, independent of which single chat's ChatRoom
// socket they're connected to. Used purely to push "you have a message"
// notifications so a message in a chat you're not currently looking at
// still dings / badges / shows a browser notification.
// A mobile connection dying without ever firing 'close' or 'error' is the
// one case the old Set-of-sockets model couldn't handle: the client
// eventually notices (its own 40s dead-socket check) and reconnects, but the
// *old* dead socket was never removed server-side, so `sessions.size > 0`
// kept reporting "online" for someone who'd been gone for minutes, exactly
// what "sometimes it says online when they're not" looks like. Tracking a
// last-ping timestamp per socket and sweeping anything stale before every
// presence check (and periodically via alarm, so a socket that nobody ever
// asks about doesn't linger forever either) closes that gap without
// depending on the close/error events actually firing.
const PRESENCE_STALE_MS = 50000; // > 2x the client's 20s ping interval, with margin

export class UserChannel {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // WebSocket -> last-ping-received timestamp
  }

  // Closes and forgets any socket that hasn't pinged in a while. Returns
  // true if the set went from non-empty to empty as a result, so the caller
  // can record `lastSeen` at the moment presence actually flips to offline.
  sweepStaleSessions() {
    const now = Date.now();
    const hadSessions = this.sessions.size > 0;
    for (const [ws, lastPing] of this.sessions) {
      if (now - lastPing > PRESENCE_STALE_MS) {
        try { ws.close(); } catch (e) {}
        this.sessions.delete(ws);
      }
    }
    return hadSessions && this.sessions.size === 0;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      this.sessions.set(server, Date.now());
      const cleanup = async () => {
        this.sessions.delete(server);
        // Only the *last* tab/device closing counts as "going offline",
        // someone with two tabs open shouldn't flicker to offline when one closes.
        if (this.sessions.size === 0) {
          await this.state.storage.put('lastSeen', Date.now());
        }
      };
      server.addEventListener('close', cleanup);
      server.addEventListener('error', cleanup);
      // Heartbeat only, this socket is otherwise server-to-client-only
      // (it exists purely to push "you have a message" pings). The client
      // uses the pong to detect a mobile connection that's silently died
      // while still reporting itself as open; the timestamp recorded here
      // is what lets the *server* detect the same thing independently (see
      // sweepStaleSessions above), instead of trusting close/error to fire.
      server.addEventListener('message', (ev) => {
        let data;
        try { data = JSON.parse(ev.data); } catch (e) { return; }
        if (data.type === 'ping') {
          this.sessions.set(server, Date.now());
          try { server.send(JSON.stringify({ type: 'pong' })); } catch (e) {}
        }
      });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === 'POST' && url.pathname === '/notify') {
      const payload = await request.text();
      for (const ws of this.sessions.keys()) {
        try {
          ws.send(payload);
        } catch (e) {
          this.sessions.delete(ws);
        }
      }

      // Also fan out a real OS push to every registered device, so a message
      // still surfaces even if the app/tab isn't open anywhere at all. This
      // fires regardless of whether a live WS session also got the in-app
      // ding, a phone with the app closed and a desktop with it open are
      // both "this user", and we can't tell from here which subscription
      // belongs to which without a lot more bookkeeping, so we accept the
      // occasional double notification on a device that has it open.
      let data = null;
      try { data = JSON.parse(payload); } catch (e) {}
      if (data && data.type === 'notify' && data.message) {
        const notifyPrefs = (await this.state.storage.get('notifyPrefs')) || {};
        const pref = notifyPrefs[data.chatId] || 'all';

        // Messages are end-to-end encrypted now, this Durable Object only
        // ever sees ciphertext, so it can no longer read message text to
        // build a real preview or test the "mentions only" pref against it.
        // Mute still fully suppresses (that's just a boolean, no content
        // needed); "mentions only" degrades to "all" for a background OS
        // push specifically, the in-app path (still open, socket connected)
        // decrypts client-side and applies the real mention check there.
        const shouldPush = pref !== 'mute';

        const subs = shouldPush ? (await this.state.storage.get('pushSubs')) || [] : [];
        if (subs.length) {
          const senderLabel = data.message.fromName || 'Someone';
          const title = data.chatType === 'group' ? (data.chatName || 'Group') : 'PArA PIN';
          const body = data.chatType === 'group' ? `${senderLabel} sent a message` : `New message from ${senderLabel}`;
          const pushPayload = { title, body, chatId: data.chatId };
          const stillValid = [];
          for (const sub of subs) {
            try {
              const result = await sendWebPushWithRetry(sub, pushPayload, this.env);
              // 404/410 = the browser/OS has permanently unsubscribed this endpoint, drop it.
              if (result.status !== 404 && result.status !== 410) stillValid.push(sub);
            } catch (e) {
              stillValid.push(sub); // transient failure (network, etc.), keep it, don't churn subscriptions on a blip
            }
          }
          if (stillValid.length !== subs.length) {
            await this.state.storage.put('pushSubs', stillValid);
          }
        }
      }

      return json({ ok: true, delivered: this.sessions.size, hadNoLiveSession: this.sessions.size === 0 });
    }

    // Call signaling relay, this DO is keyed by the *recipient's* userId, so
    // whichever side (caller or callee) wants to reach the other posts here
    // via /api/calls/signal and it fans out over the same always-open notify
    // socket already used for message pings. No new connection, no new
    // Durable Object type: the WebRTC offer/answer/ICE candidates and the
    // ringing/hangup/decline/busy signals all ride this one pipe.
    if (request.method === 'POST' && url.pathname === '/call-signal') {
      const payload = await request.text();
      let data = null;
      try { data = JSON.parse(payload); } catch (e) {}
      for (const ws of this.sessions.keys()) {
        try {
          ws.send(payload);
        } catch (e) {
          this.sessions.delete(ws);
        }
      }
      const delivered = this.sessions.size;

      // Always push for an incoming call, even when a WebSocket session is
      // technically still open, "delivered > 0" only means some tab has a
      // live socket, not that it's actually foregrounded. A backgrounded or
      // unfocused tab gets its JS timers/AudioContext throttled by the
      // browser, so the in-page ringtone can die silently while the socket
      // stays connected; a real OS push is the only thing that reliably
      // still rings in that case. Unlike a chat message (which can just wait
      // for next-open), a call is time-sensitive enough to accept the
      // occasional double-alert on a device that has the app open and
      // focused too. Same retry/cleanup logic /notify already uses for pushSubs.
      if (data && data.type === 'call-signal' && data.signal && (data.signal.kind === 'offer' || data.signal.kind === 'meeting-invite')) {
        const subs = (await this.state.storage.get('pushSubs')) || [];
        if (subs.length) {
          const pushPayload = data.signal.kind === 'meeting-invite'
            ? {
                title: 'PArA PIN',
                body: `${data.signal.fromName || 'Someone'} started a meeting${data.signal.meetingName ? `: ${data.signal.meetingName}` : ''}`,
                chatId: null,
              }
            : {
                title: 'PArA PIN',
                body: `Incoming call from ${data.signal.fromName || 'Someone'}`,
                chatId: null,
              };
          const stillValid = [];
          for (const sub of subs) {
            try {
              const result = await sendWebPushWithRetry(sub, pushPayload, this.env);
              if (result.status !== 404 && result.status !== 410) stillValid.push(sub);
            } catch (e) {
              stillValid.push(sub);
            }
          }
          if (stillValid.length !== subs.length) await this.state.storage.put('pushSubs', stillValid);
        }
      }

      return json({ ok: true, delivered });
    }

    if (request.method === 'GET' && url.pathname === '/presence') {
      if (this.sweepStaleSessions()) {
        await this.state.storage.put('lastSeen', Date.now());
      }
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

    // Direct self-test, sends to every registered subscription regardless
    // of notifyPrefs, and reports back per-subscription success/failure
    // instead of swallowing it, so a bad push service response is visible
    // instead of just "nothing arrived."
    if (request.method === 'POST' && url.pathname === '/push-test') {
      const subs = (await this.state.storage.get('pushSubs')) || [];
      if (!subs.length) return json({ delivered: 0, total: 0, error: 'no_subscriptions' });
      const payload = { title: 'PArA PIN', body: 'Test notification, if you see this, push works.', chatId: null };
      let delivered = 0;
      const errors = [];
      const stillValid = [];
      for (const sub of subs) {
        try {
          const result = await sendWebPushWithRetry(sub, payload, this.env);
          if (result.ok) { delivered++; stillValid.push(sub); }
          else {
            errors.push(`status ${result.status}${result.error ? ': ' + result.error : ''}`);
            if (result.status !== 404 && result.status !== 410) stillValid.push(sub);
          }
        } catch (e) {
          errors.push(e && e.message ? e.message : 'unknown error');
          stillValid.push(sub);
        }
      }
      if (stillValid.length !== subs.length) await this.state.storage.put('pushSubs', stillValid);
      return json({ delivered, total: subs.length, errors: errors.length ? errors : undefined });
    }

    // Generic "send this exact push to this user" primitive, used for things
    // that aren't a chat message at all, like alerting admins when someone
    // claims their HR-onboarding roster PIN for the first time.
    if (request.method === 'POST' && url.pathname === '/push-direct') {
      const { title, body, chatId } = await request.json().catch(() => ({}));
      const subs = (await this.state.storage.get('pushSubs')) || [];
      if (!subs.length) return json({ delivered: 0, total: 0 });
      const payload = { title: title || 'PArA PIN', body: body || '', chatId: chatId || null };
      let delivered = 0;
      const stillValid = [];
      for (const sub of subs) {
        try {
          const result = await sendWebPushWithRetry(sub, payload, this.env);
          if (result.ok) delivered++;
          if (result.status !== 404 && result.status !== 410) stillValid.push(sub);
        } catch (e) {
          stillValid.push(sub);
        }
      }
      if (stillValid.length !== subs.length) await this.state.storage.put('pushSubs', stillValid);
      return json({ delivered, total: subs.length });
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

      // The only things a client pushes *to* us over this socket are an
      // ephemeral "I'm typing" ping and a heartbeat ping (the client uses the
      // pong to tell a genuinely dead-but-still-"open" mobile connection
      // apart from one that's just quiet), everything else (send, delete,
      // read) goes through HTTP so it's reliable/persisted even if the socket
      // happens to be reconnecting at that moment.
      server.addEventListener('message', (ev) => {
        let data;
        try { data = JSON.parse(ev.data); } catch (e) { return; }
        if (data.type === 'typing' && userId) {
          this.broadcast(JSON.stringify({ type: 'typing', userId, name }), server);
        } else if (data.type === 'ping') {
          try { server.send(JSON.stringify({ type: 'pong' })); } catch (e) {}
        }
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === 'GET' && url.pathname === '/messages') {
      const msgs = await this.loadMessages();
      return json({ messages: msgs });
    }

    // Lets a caller learn "what would this chat show in a chat list", last
    // message plus how many are unread for a given user, without pulling the
    // full history. Used at login to seed every chat's preview/unread count in
    // one shot instead of only ever learning about new messages from a live
    // socket while the app happens to be open.
    if (request.method === 'GET' && url.pathname === '/summary') {
      const userId = url.searchParams.get('userId');
      const msgs = await this.loadMessages();
      const lastMessage = msgs.length ? msgs[msgs.length - 1] : null;
      let unreadCount = 0;
      if (userId) {
        const lastRead = (await this.state.storage.get(`lastRead:${userId}`)) || 0;
        // System messages ("X left the group") have no fromUserId, so
        // `!== userId` would count every one of them as unread from
        // someone, exclude them explicitly rather than relying on that.
        unreadCount = msgs.filter((m) => m.ts > lastRead && m.type !== 'system' && m.fromUserId !== userId).length;
      }
      return json({ lastMessage, unreadCount });
    }

    if (request.method === 'GET' && url.pathname === '/read-state') {
      const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
      const reads = {};
      for (const id of ids) {
        reads[id] = (await this.state.storage.get(`lastRead:${id}`)) || 0;
      }
      return json({ reads });
    }

    // Called once a day by the top-level `scheduled` handler when an admin
    // has set a retention window. Drops anything older than the cutoff and
    // hands back the R2 keys of any attachments that went with them, since
    // only the caller (which holds the MEDIA binding context) can delete
    // those, this Durable Object only manages the message list itself.
    if (request.method === 'POST' && url.pathname === '/purge-old') {
      const { cutoffTs } = await request.json();
      if (!cutoffTs) return json({ error: 'missing_cutoff' }, 400);
      const msgs = await this.loadMessages();
      const toRemove = msgs.filter((m) => m.ts < cutoffTs);
      if (toRemove.length) {
        const kept = msgs.filter((m) => m.ts >= cutoffTs);
        this.messages = kept;
        await this.state.storage.put('messages', kept);
        this.broadcast(JSON.stringify({ type: 'purged', cutoffTs }), null);
      }
      const mediaKeys = toRemove
        .filter((m) => m.attachment && m.attachment.url)
        .map((m) => (m.attachment.url.match(/\/api\/media\/([^/]+)$/) || [])[1])
        .filter(Boolean);
      return json({ removed: toRemove.length, mediaKeys });
    }

    // Messages are end-to-end encrypted client-side, this Durable Object
    // only ever stores/relays opaque ciphertext (+ IV) it cannot read.
    // `alg` is just metadata for the client ('dm' vs 'group', which key to
    // use) and carries no security weight on its own. Messages sent before
    // E2EE shipped kept their old plaintext `text` field as-is; nothing here
    // retroactively touches old history.
    if (request.method === 'POST' && url.pathname === '/messages') {
      const { fromUserId, fromName, ciphertext, iv, alg, attachment, replyTo, protected: isProtected } = await request.json();
      const hasCiphertext = ciphertext && iv;
      const hasAttachment = attachment && attachment.url;
      if (!hasCiphertext && !hasAttachment) return json({ error: 'empty' }, 400);
      // Ciphertext is base64 and ~1.33x the encrypted byte length, and a 4000
      // "character" plaintext cap can be up to ~12KB of UTF-8 bytes once
      // heavy-Unicode (CJK, emoji, etc.) is accounted for, slicing a base64
      // string to fit an undersized cap would silently corrupt it (breaks
      // GCM auth, decrypt just fails with no clear reason), so this rejects
      // oversized input outright instead of truncating it.
      if (hasCiphertext && String(ciphertext).length > 20000) return json({ error: 'text_too_long' }, 400);
      if (hasAttachment && attachment.nameCiphertext && String(attachment.nameCiphertext).length > 2000) {
        return json({ error: 'name_too_long' }, 400);
      }
      const msgs = await this.loadMessages();
      const msg = {
        id: crypto.randomUUID(),
        fromUserId,
        fromName: fromName || null,
        ts: Date.now(),
      };
      // Secure Vault: this is purely a client-side render gate (the message
      // is already E2EE, this server never sees plaintext either way), the
      // flag just travels with the message so every client knows to keep it
      // behind a "tap to unlock" placeholder instead of showing it automatically.
      if (isProtected) msg.protected = true;
      if (hasCiphertext) {
        msg.ciphertext = String(ciphertext);
        msg.iv = String(iv).slice(0, 50);
        msg.alg = alg === 'group' ? 'group' : 'dm';
      }
      if (hasAttachment) {
        msg.attachment = {
          url: String(attachment.url).slice(0, 500),
          width: Number(attachment.width) || null,
          height: Number(attachment.height) || null,
          mime: attachment.mime ? String(attachment.mime).slice(0, 100) : 'image/jpeg',
          nameCiphertext: attachment.nameCiphertext ? String(attachment.nameCiphertext).slice(0, 2000) : null,
          nameIv: attachment.nameIv ? String(attachment.nameIv).slice(0, 50) : null,
          size: Number(attachment.size) || null,
          kind: ['image', 'voice', 'video', 'file'].includes(attachment.kind) ? attachment.kind : 'image',
          duration: attachment.duration ? Number(attachment.duration) : null,
          fileIv: attachment.fileIv ? String(attachment.fileIv).slice(0, 50) : null,
        };
      }
      // Only the id is stored now, the server can no longer read the
      // original message to snapshot a plaintext quote, so the client
      // re-derives the quoted name/text from its own already-decrypted copy.
      if (replyTo && replyTo.id) {
        msg.replyTo = { id: String(replyTo.id).slice(0, 100) };
      }
      msgs.push(msg);
      if (msgs.length > 500) msgs.splice(0, msgs.length - 500);
      await this.state.storage.put('messages', msgs);

      this.broadcast(JSON.stringify({ type: 'message', message: msg }), null);
      return json({ message: msg });
    }

    // ---- E2EE group key wraps ----
    // For a group chat, one AES-256 key is generated client-side and wrapped
    // (encrypted) once per member via a fresh ECDH exchange with that
    // member's public key. This Durable Object just stores/serves those
    // opaque wrapped copies, it never sees the real group key. Any current
    // member may contribute wraps for members who don't have one yet (that's
    // how the group key gets bootstrapped the first time everyone's public
    // key is available).
    if (request.method === 'GET' && url.pathname === '/e2ee-wraps') {
      const wraps = (await this.state.storage.get('e2eeWraps')) || {};
      return json({ wraps });
    }
    if (request.method === 'POST' && url.pathname === '/e2ee-wraps') {
      const { wraps: incoming, ifEmpty } = await request.json();
      if (!incoming || typeof incoming !== 'object') return json({ error: 'invalid' }, 400);
      const wraps = (await this.state.storage.get('e2eeWraps')) || {};

      // `ifEmpty` is set when a client is establishing a chat's key for the
      // very first time (a random key it just generated locally). Two
      // people can both reach that moment for the same chat at once, a
      // Durable Object processes requests one at a time, so checking
      // "is this chat still keyless RIGHT NOW" here is a genuinely atomic
      // gate, unlike anything a client could coordinate on its own. First
      // one through wins; whoever loses gets back the winner's wraps
      // instead of having their own (different, incompatible) key silently
      // saved over/alongside it.
      if (ifEmpty && Object.keys(wraps).length > 0) {
        return json({ ok: true, wraps, alreadyEstablished: true });
      }

      const isWrapObj = (w) => w && typeof w.ephemeralPub === 'string' && typeof w.iv === 'string' && typeof w.wrapped === 'string';
      const sanitizeWrap = (w) => ({ ephemeralPub: w.ephemeralPub.slice(0, 200), iv: w.iv.slice(0, 50), wrapped: w.wrapped.slice(0, 500) });
      for (const [memberId, entry] of Object.entries(incoming)) {
        if (!entry || typeof entry !== 'object') continue;
        if (isWrapObj(entry)) {
          // Legacy flat shape, kept for compatibility, but current clients
          // always send the nested per-device shape below.
          wraps[memberId] = sanitizeWrap(entry);
          continue;
        }
        // Nested shape: { deviceId: wrapObj, ... }. Merged per-device so
        // adding a wrap for one newly-approved device never disturbs a
        // member's other, already-working devices.
        const existing = (wraps[memberId] && typeof wraps[memberId] === 'object' && !isWrapObj(wraps[memberId])) ? wraps[memberId] : {};
        for (const [deviceId, wrap] of Object.entries(entry)) {
          if (isWrapObj(wrap)) existing[deviceId] = sanitizeWrap(wrap);
        }
        wraps[memberId] = existing;
      }
      await this.state.storage.put('e2eeWraps', wraps);
      return json({ ok: true, wraps });
    }

    // Escape hatch for a chat that's permanently stuck "waiting for
    // encryption", usually leftover/partial wrap data from some past
    // failure mode that satisfies `Object.keys(wraps).length > 0` (blocking
    // the `ifEmpty` establish gate above) without actually containing a
    // usable wrap for every member's current device. Wiping it lets the
    // next `ensureChatKey` call on any member's device start over cleanly;
    // any member of the chat may trigger this (self-service, no admin
    // needed), same as they already can read/write the wraps themselves.
    if (request.method === 'POST' && url.pathname === '/e2ee-wraps/reset') {
      await this.state.storage.delete('e2eeWraps');
      return json({ ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/read') {
      const { userId, upToTs, silent } = await request.json();
      if (!userId) return json({ error: 'missing_user' }, 400);
      const ts = Number(upToTs) || Date.now();
      const prev = (await this.state.storage.get(`lastRead:${userId}`)) || 0;
      // lastRead is what unread counts/badges are computed from (see
      // /summary), it has to advance every time someone actually reads a
      // chat, independent of whether read receipts are turned on. `silent`
      // is what actually implements the privacy setting: it's the ONLY
      // thing that's conditional, so the sender's client (which listens for
      // this broadcast to light up the blue ticks) never finds out, while
      // the reader's own unread count still correctly clears.
      if (ts > prev) await this.state.storage.put(`lastRead:${userId}`, ts);
      if (!silent) {
        this.broadcast(JSON.stringify({ type: 'read_receipt', userId, upToTs: Math.max(ts, prev) }), null);
      }
      return json({ ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/delete') {
      const { userId, messageId } = await request.json();
      const msgs = await this.loadMessages();
      const msg = msgs.find((m) => m.id === messageId);
      if (!msg) return json({ error: 'not_found' }, 404);
      if (msg.fromUserId !== userId) return json({ error: 'forbidden' }, 403);
      msg.text = '';
      delete msg.ciphertext;
      delete msg.iv;
      msg.deleted = true;
      await this.state.storage.put('messages', msgs);
      this.broadcast(JSON.stringify({ type: 'delete', messageId }), null);
      return json({ ok: true, message: msg });
    }

    if (request.method === 'POST' && url.pathname === '/edit') {
      const { userId, messageId, ciphertext, iv } = await request.json();
      if (!ciphertext || !iv) return json({ error: 'empty' }, 400);
      if (String(ciphertext).length > 20000) return json({ error: 'text_too_long' }, 400);
      const msgs = await this.loadMessages();
      const msg = msgs.find((m) => m.id === messageId);
      if (!msg) return json({ error: 'not_found' }, 404);
      if (msg.fromUserId !== userId) return json({ error: 'forbidden' }, 403);
      if (msg.deleted) return json({ error: 'already_deleted' }, 400);
      msg.ciphertext = String(ciphertext);
      msg.iv = String(iv).slice(0, 50);
      delete msg.text; // upgrades a pre-E2EE plaintext message to encrypted the moment it's edited
      msg.edited = true;
      await this.state.storage.put('messages', msgs);
      this.broadcast(JSON.stringify({ type: 'edit', messageId, ciphertext: msg.ciphertext, iv: msg.iv }), null);
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
      // (i.e. tapping your own current reaction again clears it, a toggle).
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

    // A chat-level property changed (currently just the group photo), tell
    // anyone with this chat open right now so their local copy updates
    // immediately instead of only picking it up on next full reload. The
    // system message posted alongside this (see /api/groups/avatar) covers
    // the "what happened" text; this covers the actual new value.
    if (request.method === 'POST' && url.pathname === '/meta-broadcast') {
      const meta = await request.json().catch(() => ({}));
      this.broadcast(JSON.stringify({ type: 'chat-meta', ...meta }), null);
      return json({ ok: true });
    }

    return new Response('not found', { status: 404 });
  }
}

// Group meeting rooms ride Cloudflare Realtime's SFU for the actual media
// (see the /api/meeting/sfu/* proxy in the default export), but the SFU
// itself has no concept of a "room", it only knows Sessions (roughly one per
// participant's PeerConnection) and Tracks. This Durable Object, one per
// meetingId, is the presence/room layer Cloudflare's docs say is entirely
// the caller's job: who's currently in the room, what their SFU sessionId
// is, and which of their tracks are live, so every other participant knows
// what to go pull. Same WebSocket-fan-out shape as ChatRoom, just keyed by
// meetingId instead of chatId, and carrying presence/track events instead
// of chat messages.
export class MeetingRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // ws -> { userId, name, avatarUrl, sfuSessionId, tracks: Map(trackName -> kind) }
  }

  roster() {
    return [...this.sessions.values()].map((p) => ({
      userId: p.userId,
      name: p.name,
      avatarUrl: p.avatarUrl || null,
      sfuSessionId: p.sfuSessionId || null,
      tracks: [...p.tracks.entries()].map(([trackName, kind]) => ({ trackName, kind })),
    }));
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
      const name = url.searchParams.get('name') || 'Someone';
      const avatarUrl = url.searchParams.get('avatarUrl') || null;
      const me = { userId, name, avatarUrl, sfuSessionId: null, tracks: new Map() };
      this.sessions.set(server, me);

      // Bring the new joiner up to speed on who's already here (including
      // their published tracks), then tell everyone else about the new face.
      try {
        server.send(JSON.stringify({ type: 'roster', participants: this.roster().filter((p) => p.userId !== userId) }));
      } catch (e) {}
      this.broadcast(JSON.stringify({ type: 'participant-joined', userId, name, avatarUrl }), server);

      const cleanup = () => {
        this.sessions.delete(server);
        if (userId) this.broadcast(JSON.stringify({ type: 'participant-left', userId }), null);
      };
      server.addEventListener('close', cleanup);
      server.addEventListener('error', cleanup);

      server.addEventListener('message', (ev) => {
        let data;
        try { data = JSON.parse(ev.data); } catch (e) { return; }

        if (data.type === 'ping') {
          try { server.send(JSON.stringify({ type: 'pong' })); } catch (e) {}
          return;
        }

        // A participant tells the room "this is my SFU session", so anyone
        // who joins after can go pull tracks from it.
        if (data.type === 'set-session' && data.sfuSessionId) {
          me.sfuSessionId = data.sfuSessionId;
          return;
        }

        // A participant published a track (mic, camera, screen-share, ...),
        // fan it out so everyone else knows to go pull it from that session.
        if (data.type === 'publish' && data.trackName && data.kind) {
          me.tracks.set(data.trackName, data.kind);
          this.broadcast(JSON.stringify({
            type: 'participant-track', userId, sfuSessionId: me.sfuSessionId, trackName: data.trackName, kind: data.kind,
          }), server);
          return;
        }

        if (data.type === 'unpublish' && data.trackName) {
          me.tracks.delete(data.trackName);
          this.broadcast(JSON.stringify({ type: 'participant-untrack', userId, trackName: data.trackName }), server);
          return;
        }
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === 'GET' && url.pathname === '/roster') {
      return json({ participants: this.roster() });
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

      // Image upload, client sends already-resized/compressed bytes directly
      // as the request body. Auth required so randoms can't fill your bucket;
      // the resulting key is an unguessable UUID, serving is unauthenticated
      // (same trust model as e.g. a signed CDN link).
      if (request.method === 'POST' && url.pathname === '/api/upload') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        // The comment above claims "auth required so randoms can't fill your
        // bucket", but authHash() only reads whatever string the caller sent,
        // it was never actually checked against a real account. That left
        // this endpoint uploading (up to 20MB, R2-billed) for literally any
        // request with a non-empty header, registered or not. Actually enforce
        // the claim: the hash has to belong to a real, already-registered user.
        const whoRes = await registryStub.fetch(`https://internal/whoami?pinHash=${encodeURIComponent(pinHash)}`);
        const who = await whoRes.json();
        if (!who.ok) return json({ error: 'not_registered' }, 401);
        if (!env.MEDIA) return json({ error: 'media_not_configured' }, 501);

        let contentType = request.headers.get('content-type') || 'application/octet-stream';
        // Anything that a browser would treat as *active* content (executes script,
        // renders as a page in the current origin) gets rejected outright, this is
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
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const res = await registryStub.fetch('https://internal/session', {
          method: 'POST',
          body: JSON.stringify({ pinHash, displayName: body.displayName || null, deviceId: body.deviceId || null, ip }),
        });
        return res;
      }

      // Authenticated by the OLD pin hash, you have to actually know the
      // current PIN to change it, same as any other authenticated call here.
      if (request.method === 'POST' && url.pathname === '/api/change-pin') {
        const oldPinHash = authHash(request, url);
        if (!oldPinHash) return json({ error: 'missing_pin_hash' }, 401);
        const body = await request.json().catch(() => ({}));
        if (!body.newPinHash) return json({ error: 'missing_fields' }, 400);
        return registryStub.fetch('https://internal/change-pin', {
          method: 'POST',
          body: JSON.stringify({ oldPinHash, newPinHash: body.newPinHash, deviceId: body.deviceId || null }),
        });
      }

      // The requesting (not-yet-trusted) device's own pinHash, it already
      // knows the correct PIN, that's not in question; what it doesn't have
      // yet is a trusted device to vouch for it.
      if (request.method === 'POST' && url.pathname === '/api/device-link/request') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const body = await request.json().catch(() => ({}));
        if (!body.deviceId) return json({ error: 'missing_fields' }, 400);
        return registryStub.fetch('https://internal/device-link/request', {
          method: 'POST',
          body: JSON.stringify({ pinHash, deviceId: body.deviceId }),
        });
      }

      // Called FROM an already-trusted, already-signed-in device.
      if (request.method === 'POST' && url.pathname === '/api/device-link/approve') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const body = await request.json().catch(() => ({}));
        if (!body.code || !body.deviceId) return json({ error: 'missing_fields' }, 400);
        return registryStub.fetch('https://internal/device-link/approve', {
          method: 'POST',
          body: JSON.stringify({ pinHash, code: body.code, deviceId: body.deviceId }),
        });
      }

      if (request.method === 'GET' && url.pathname === '/api/device-link/status') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const deviceId = url.searchParams.get('deviceId') || '';
        return registryStub.fetch(`https://internal/device-link/status?pinHash=${encodeURIComponent(pinHash)}&deviceId=${encodeURIComponent(deviceId)}`);
      }

      if (request.method === 'POST' && url.pathname === '/api/profile') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const body = await request.json().catch(() => ({}));
        const res = await registryStub.fetch('https://internal/profile', {
          method: 'POST',
          body: JSON.stringify({ pinHash, displayName: body.displayName, avatarUrl: body.avatarUrl, department: body.department }),
        });
        return res;
      }

      if (url.pathname === '/api/admin/roster') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const whoRes = await registryStub.fetch(`https://internal/whoami?pinHash=${encodeURIComponent(pinHash)}`);
        const who = await whoRes.json();
        if (!who.ok) return json({ error: 'not_registered' }, 401);
        if (request.method === 'GET') {
          return registryStub.fetch(`https://internal/admin/roster?requesterId=${encodeURIComponent(who.userId)}`);
        }
        if (request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          return registryStub.fetch('https://internal/admin/roster', {
            method: 'POST',
            body: JSON.stringify({ requesterId: who.userId, name: body.name, department: body.department, email: body.email, force: !!body.force }),
          });
        }
      }

      if (url.pathname === '/api/admin/retention') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const whoRes = await registryStub.fetch(`https://internal/whoami?pinHash=${encodeURIComponent(pinHash)}`);
        const who = await whoRes.json();
        if (!who.ok) return json({ error: 'not_registered' }, 401);
        if (request.method === 'GET') {
          return registryStub.fetch(`https://internal/admin/retention?requesterId=${encodeURIComponent(who.userId)}`);
        }
        if (request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          return registryStub.fetch('https://internal/admin/retention', {
            method: 'POST',
            body: JSON.stringify({ requesterId: who.userId, retentionDays: body.retentionDays }),
          });
        }
      }

      if (request.method === 'GET' && url.pathname === '/api/admin/users') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const whoRes = await registryStub.fetch(`https://internal/whoami?pinHash=${encodeURIComponent(pinHash)}`);
        const who = await whoRes.json();
        if (!who.ok) return json({ error: 'not_registered' }, 401);
        return registryStub.fetch(`https://internal/admin/users?requesterId=${encodeURIComponent(who.userId)}`);
      }

      if (request.method === 'POST' && url.pathname === '/api/admin/reset-device') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const whoRes = await registryStub.fetch(`https://internal/whoami?pinHash=${encodeURIComponent(pinHash)}`);
        const who = await whoRes.json();
        if (!who.ok) return json({ error: 'not_registered' }, 401);
        const body = await request.json().catch(() => ({}));
        return registryStub.fetch('https://internal/admin/reset-device', {
          method: 'POST',
          body: JSON.stringify({ requesterId: who.userId, userId: body.userId }),
        });
      }

      // Not gated by an existing admin session on purpose, see the Registry
      // handler's comment. The pinHash still has to belong to a real,
      // already-registered account; the ADMIN_BOOTSTRAP_KEY check is what
      // actually protects this.
      if (request.method === 'POST' && url.pathname === '/api/admin/bootstrap') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const body = await request.json().catch(() => ({}));
        return registryStub.fetch('https://internal/admin/bootstrap', {
          method: 'POST',
          body: JSON.stringify({ pinHash, key: body.key }),
        });
      }

      if (request.method === 'POST' && (url.pathname === '/api/admin/promote' || url.pathname === '/api/admin/demote')) {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const whoRes = await registryStub.fetch(`https://internal/whoami?pinHash=${encodeURIComponent(pinHash)}`);
        const who = await whoRes.json();
        if (!who.ok) return json({ error: 'not_registered' }, 401);
        const body = await request.json().catch(() => ({}));
        const action = url.pathname.endsWith('promote') ? 'promote' : 'demote';
        return registryStub.fetch(`https://internal/admin/${action}`, {
          method: 'POST',
          body: JSON.stringify({ requesterId: who.userId, userId: body.userId }),
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/admin/roster/disable') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const whoRes = await registryStub.fetch(`https://internal/whoami?pinHash=${encodeURIComponent(pinHash)}`);
        const who = await whoRes.json();
        if (!who.ok) return json({ error: 'not_registered' }, 401);
        const body = await request.json().catch(() => ({}));
        return registryStub.fetch('https://internal/admin/roster/disable', {
          method: 'POST',
          body: JSON.stringify({ requesterId: who.userId, id: body.id }),
        });
      }

      if (request.method === 'GET' && url.pathname === '/api/presence') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        // Every other per-user lookup in this file confirms the hash belongs
        // to a real account before answering; this one didn't, so anyone who
        // knew (or guessed) a userId could poll their online/offline status
        // with no account of their own at all.
        const whoRes = await registryStub.fetch(`https://internal/whoami?pinHash=${encodeURIComponent(pinHash)}`);
        const who = await whoRes.json();
        if (!who.ok) return json({ error: 'not_registered' }, 401);
        const userId = url.searchParams.get('userId');
        if (!userId) return json({ error: 'missing_user_id' }, 400);
        const channelStub = env.USER_CHANNEL.get(env.USER_CHANNEL.idFromName(userId));
        const res = await channelStub.fetch('https://internal/presence');
        return res;
      }

      // 1:1 voice calling, relays a WebRTC offer/answer/ice-candidate/end
      // signal from the caller to the callee (or back), over the target's
      // UserChannel notify socket. The Worker never sees any audio, this is
      // purely signaling, same trust boundary as everything else here.
      if (request.method === 'POST' && url.pathname === '/api/calls/signal') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const whoRes = await registryStub.fetch(`https://internal/whoami?pinHash=${encodeURIComponent(pinHash)}`);
        const who = await whoRes.json();
        if (!who.ok) return json({ error: 'not_registered' }, 401);
        const { toUserId, signal } = await request.json().catch(() => ({}));
        if (!toUserId || !signal || !signal.kind) return json({ error: 'invalid' }, 400);
        if (toUserId === who.userId) return json({ error: 'cannot_call_self' }, 400);
        const channelStub = env.USER_CHANNEL.get(env.USER_CHANNEL.idFromName(toUserId));
        const res = await channelStub.fetch('https://internal/call-signal', {
          method: 'POST',
          body: JSON.stringify({
            type: 'call-signal',
            signal: {
              ...signal,
              fromUserId: who.userId,
              fromName: who.displayName,
              fromAvatarUrl: who.avatarUrl || null,
            },
          }),
        });
        return res;
      }

      // Self-scoped call history, each side of a call writes its own log
      // entry once the call ends, so this never needs to look up the other
      // party's name/avatar server-side (the caller already knows who they
      // dialed; the callee already got the caller's name in the offer).
      if (request.method === 'GET' && url.pathname === '/api/calls/log') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const whoRes = await registryStub.fetch(`https://internal/whoami?pinHash=${encodeURIComponent(pinHash)}`);
        const who = await whoRes.json();
        if (!who.ok) return json({ error: 'not_registered' }, 401);
        const res = await registryStub.fetch(`https://internal/call-log?userId=${encodeURIComponent(who.userId)}`);
        return res;
      }

      if (request.method === 'POST' && url.pathname === '/api/calls/log') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const whoRes = await registryStub.fetch(`https://internal/whoami?pinHash=${encodeURIComponent(pinHash)}`);
        const who = await whoRes.json();
        if (!who.ok) return json({ error: 'not_registered' }, 401);
        const entry = await request.json().catch(() => ({}));
        const res = await registryStub.fetch('https://internal/call-log', {
          method: 'POST',
          body: JSON.stringify({ userId: who.userId, entry }),
        });
        return res;
      }

      // ICE server list for the WebRTC call. STUN alone (Google's public
      // servers) gets two peers connected directly whenever their NATs allow
      // it, which covers most home/office networks. Symmetric NAT or a
      // locked-down corporate firewall needs a TURN relay to work at all,
      // Cloudflare Realtime's TURN service is the intended fit here (same
      // Cloudflare account, pay-per-GB, short-lived credentials), wired up as
      // soon as CF_TURN_KEY_ID + CF_TURN_API_TOKEN secrets exist. Until then
      // this just serves STUN, so calls work everywhere except the small
      // slice of networks that genuinely require a relay.
      if (request.method === 'GET' && url.pathname === '/api/calls/ice-servers') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const whoRes = await registryStub.fetch(`https://internal/whoami?pinHash=${encodeURIComponent(pinHash)}`);
        const who = await whoRes.json();
        if (!who.ok) return json({ error: 'not_registered' }, 401);
        const iceServers = [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ];
        let turnError = null;
        if (env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN) {
          try {
            // generate-ice-servers returns a ready-to-use iceServers ARRAY
            // (the older /generate returns a single object). Handling both
            // shapes keeps this working whichever endpoint Cloudflare serves.
            const turnRes = await fetch(
              `https://rtc.live.cloudflare.com/v1/turn/keys/${env.CF_TURN_KEY_ID}/credentials/generate-ice-servers`,
              {
                method: 'POST',
                headers: {
                  authorization: `Bearer ${env.CF_TURN_API_TOKEN}`,
                  'content-type': 'application/json',
                },
                body: JSON.stringify({ ttl: 86400 }),
              }
            );
            if (turnRes.ok) {
              const turnData = await turnRes.json();
              const entries = turnData && turnData.iceServers
                ? (Array.isArray(turnData.iceServers) ? turnData.iceServers : [turnData.iceServers])
                : [];
              for (const entry of entries) {
                if (!entry) continue;
                // Cloudflare's docs warn that the alternate port 53 URLs are
                // blocked by browsers and will simply time out. Without
                // trickle ICE that stalls connection setup, so drop them.
                const urls = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
                const filtered = urls.filter((u) => typeof u === 'string' && !u.includes(':53'));
                if (filtered.length) iceServers.push({ ...entry, urls: filtered });
              }
            } else {
              turnError = `turn_http_${turnRes.status}`;
            }
          } catch (e) {
            turnError = 'turn_request_failed';
          }
        } else {
          turnError = 'turn_not_configured';
        }
        // Surfaced so the client can say "calls will fail on some networks
        // because TURN isn't set up" instead of just timing out mysteriously.
        return json({ iceServers, turnError });
      }

      // ---- Meeting Room (group calls, Cloudflare Realtime SFU) ----
      // The App Secret must never reach the client, so every SFU call is a
      // thin authenticated proxy: check the caller's pinHash, then forward
      // to https://rtc.live.cloudflare.com/v1/apps/{appId}/... with the
      // secret attached server-side. The room/presence layer (who's in the
      // meeting, whose track is whose) is handled separately by the
      // MeetingRoom Durable Object below, this block is purely the media
      // plane pass-through.
      const meetingSfuMatch = url.pathname.match(/^\/api\/meeting\/sfu\/(.+)$/);
      if (meetingSfuMatch) {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const whoRes = await registryStub.fetch(`https://internal/whoami?pinHash=${encodeURIComponent(pinHash)}`);
        const who = await whoRes.json();
        if (!who.ok) return json({ error: 'not_registered' }, 401);
        if (!env.CF_REALTIME_APP_ID || !env.CF_REALTIME_APP_SECRET) {
          return json({ error: 'sfu_not_configured' }, 501);
        }
        const cfPath = meetingSfuMatch[1]; // e.g. "sessions/new" or "sessions/{id}/tracks/new"
        const cfUrl = `https://rtc.live.cloudflare.com/v1/apps/${env.CF_REALTIME_APP_ID}/${cfPath}`;
        const init = {
          method: request.method,
          headers: {
            authorization: `Bearer ${env.CF_REALTIME_APP_SECRET}`,
            'content-type': 'application/json',
          },
        };
        if (request.method !== 'GET') {
          init.body = await request.text();
        }
        const cfRes = await fetch(cfUrl, init);
        const cfBody = await cfRes.text();
        return new Response(cfBody, {
          status: cfRes.status,
          headers: { 'content-type': 'application/json' },
        });
      }

      // Room presence WebSocket, one connection per open meeting screen.
      // Keyed by meetingId (client-generated UUID), not by user, everyone in
      // the same meeting lands in the same MeetingRoom Durable Object.
      if (url.pathname === '/api/meeting/room/ws') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const whoRes = await registryStub.fetch(`https://internal/whoami?pinHash=${encodeURIComponent(pinHash)}`);
        const who = await whoRes.json();
        if (!who.ok) return json({ error: 'not_registered' }, 401);
        const meetingId = url.searchParams.get('meetingId');
        if (!meetingId) return json({ error: 'missing_meeting_id' }, 400);
        const roomStub = env.MEETING_ROOM.get(env.MEETING_ROOM.idFromName(meetingId));
        const roomUrl = new URL(request.url);
        roomUrl.searchParams.set('userId', who.userId);
        roomUrl.searchParams.set('name', who.displayName || 'Someone');
        if (who.avatarUrl) roomUrl.searchParams.set('avatarUrl', who.avatarUrl);
        return roomStub.fetch(new Request(roomUrl.toString(), request));
      }

      // Invites one person to an already-created (or about-to-be-joined)
      // meeting, riding the same per-user notify channel as 1:1 calls, so it
      // gets both the in-app ding and a real OS push if they're not looking.
      if (request.method === 'POST' && url.pathname === '/api/meeting/invite') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const whoRes = await registryStub.fetch(`https://internal/whoami?pinHash=${encodeURIComponent(pinHash)}`);
        const who = await whoRes.json();
        if (!who.ok) return json({ error: 'not_registered' }, 401);
        const { toUserId, meetingId, meetingName } = await request.json().catch(() => ({}));
        if (!toUserId || !meetingId) return json({ error: 'invalid' }, 400);
        if (toUserId === who.userId) return json({ error: 'cannot_invite_self' }, 400);
        const channelStub = env.USER_CHANNEL.get(env.USER_CHANNEL.idFromName(toUserId));
        const res = await channelStub.fetch('https://internal/call-signal', {
          method: 'POST',
          body: JSON.stringify({
            type: 'call-signal',
            signal: {
              kind: 'meeting-invite',
              meetingId,
              meetingName: meetingName || null,
              fromUserId: who.userId,
              fromName: who.displayName,
              fromAvatarUrl: who.avatarUrl || null,
            },
          }),
        });
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

      // Sends a real push straight to whatever's registered for the caller,
      // bypassing the whole notify/mute pipeline, a direct way to answer
      // "did the browser subscribe, and did the push actually arrive" without
      // guessing from a chat message that might be getting muted/filtered.
      if (request.method === 'POST' && url.pathname === '/api/push/test') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const whoRes = await registryStub.fetch(`https://internal/whoami?pinHash=${encodeURIComponent(pinHash)}`);
        const who = await whoRes.json();
        if (!who.ok) return json({ error: 'not_registered' }, 401);
        const channelStub = env.USER_CHANNEL.get(env.USER_CHANNEL.idFromName(who.userId));
        const res = await channelStub.fetch('https://internal/push-test', { method: 'POST' });
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
      // well as in-app ding/badge, not just a local toggle that a push
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
        // Same gap as /api/presence: this had no auth check at all, so
        // anyone who knew a userId could pull their display name, avatar,
        // and E2EE public keys with no account of their own. The client
        // always sends the pin hash header once logged in, so requiring it
        // here doesn't change legitimate behavior.
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const whoRes = await registryStub.fetch(`https://internal/whoami?pinHash=${encodeURIComponent(pinHash)}`);
        const who = await whoRes.json();
        if (!who.ok) return json({ error: 'not_registered' }, 401);
        const ids = url.searchParams.get('ids') || '';
        const res = await registryStub.fetch(`https://internal/users?ids=${encodeURIComponent(ids)}`);
        return res;
      }

      if (request.method === 'POST' && url.pathname === '/api/e2ee/public-key') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const { publicKey, deviceId } = await request.json();
        const res = await registryStub.fetch('https://internal/e2ee/public-key', {
          method: 'POST',
          body: JSON.stringify({ pinHash, publicKey, deviceId: deviceId || null }),
        });
        return res;
      }

      if (request.method === 'POST' && url.pathname === '/api/contacts') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const { targetPinHash, orgId } = await request.json();
        const res = await registryStub.fetch('https://internal/contact', {
          method: 'POST',
          body: JSON.stringify({ pinHash, targetPinHash, orgId: orgId || null }),
        });
        return res;
      }

      if (request.method === 'POST' && url.pathname === '/api/groups') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const { name, memberPinHashes, memberIds, orgId } = await request.json();
        const res = await registryStub.fetch('https://internal/group', {
          method: 'POST',
          body: JSON.stringify({ pinHash, name, memberPinHashes, memberIds, orgId: orgId || null }),
        });
        return res;
      }

      // ---- Organizations / workspaces: thin authenticated proxy to Registry ----
      if (request.method === 'POST' && url.pathname === '/api/org/create') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const { name } = await request.json().catch(() => ({}));
        return registryStub.fetch('https://internal/org/create', {
          method: 'POST',
          body: JSON.stringify({ pinHash, name }),
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/org/invite') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const { orgId, targetPinHash } = await request.json().catch(() => ({}));
        return registryStub.fetch('https://internal/org/invite', {
          method: 'POST',
          body: JSON.stringify({ pinHash, orgId, targetPinHash }),
        });
      }

      if (request.method === 'GET' && url.pathname === '/api/org/members') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const orgId = url.searchParams.get('orgId') || '';
        return registryStub.fetch(`https://internal/org/members?pinHash=${encodeURIComponent(pinHash)}&orgId=${encodeURIComponent(orgId)}`);
      }

      // Org-admin-only: rename the workspace and/or set its logo (uploaded
      // separately via the existing /api/upload, this just points the org
      // record at the resulting /api/media/<uuid> URL).
      if (request.method === 'POST' && url.pathname === '/api/org/update') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const body = await request.json().catch(() => ({}));
        if (!body.orgId) return json({ error: 'missing_org_id' }, 400);
        return registryStub.fetch('https://internal/org/update', {
          method: 'POST',
          body: JSON.stringify({ pinHash, orgId: body.orgId, name: body.name, logoUrl: body.logoUrl }),
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/org/leave') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const { orgId } = await request.json().catch(() => ({}));
        return registryStub.fetch('https://internal/org/leave', {
          method: 'POST',
          body: JSON.stringify({ pinHash, orgId }),
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/org/roster') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const body = await request.json().catch(() => ({}));
        return registryStub.fetch('https://internal/org/roster', {
          method: 'POST',
          body: JSON.stringify({ pinHash, orgId: body.orgId, name: body.name, department: body.department, email: body.email, force: !!body.force }),
        });
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

      // Group photo, gated to the group's creator or an app-wide admin (see
      // the permission check in Registry's /group/avatar handler). Posts a
      // system message into the chat so everyone currently looking at it
      // sees the change happen live, same pattern as the "left the group"
      // message above.
      if (request.method === 'POST' && url.pathname === '/api/groups/avatar') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const { chatId, avatarUrl } = await request.json().catch(() => ({}));
        if (!chatId) return json({ error: 'missing_chat_id' }, 400);
        const whoRes = await registryStub.fetch(`https://internal/whoami?pinHash=${encodeURIComponent(pinHash)}`);
        const who = await whoRes.json();
        if (!who.ok) return json({ error: 'not_registered' }, 401);
        const res = await registryStub.fetch('https://internal/group/avatar', {
          method: 'POST',
          body: JSON.stringify({ pinHash, chatId, avatarUrl }),
        });
        const resBody = await res.json();
        if (res.ok && resBody.ok) {
          const roomStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId));
          const sysText = avatarUrl ? `${who.displayName || 'Someone'} changed the group photo` : `${who.displayName || 'Someone'} removed the group photo`;
          const sysPromise = roomStub.fetch('https://internal/system-message', {
            method: 'POST',
            body: JSON.stringify({ text: sysText }),
          }).catch(() => {});
          const metaPromise = roomStub.fetch('https://internal/meta-broadcast', {
            method: 'POST',
            body: JSON.stringify({ chatId, avatarUrl: avatarUrl || null }),
          }).catch(() => {});
          if (ctx && ctx.waitUntil) { ctx.waitUntil(sysPromise); ctx.waitUntil(metaPromise); } else { await sysPromise; await metaPromise; }
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

        // PATCH, edit
        const { ciphertext, iv } = await request.json();
        const res = await roomStub.fetch('https://internal/edit', {
          method: 'POST',
          body: JSON.stringify({ userId: verify.userId, messageId, ciphertext, iv }),
        });
        const resBody = await res.json();
        return json(resBody, res.status);
      }

      // /api/chats/:id/messages, /api/chats/:id/ws, /api/chats/:id/read, /api/chats/:id/read-state
      // /api/chats/:id/e2ee-wraps, stores/serves the per-member wrapped
      // copies of a group's E2EE key. See ChatRoom's own handler for how the
      // wrap/unwrap scheme works; this route just gates it to chat members.
      const e2eeWrapsMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/e2ee-wraps$/);
      if (e2eeWrapsMatch) {
        const [, chatId] = e2eeWrapsMatch;
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const verifyRes = await registryStub.fetch(
          `https://internal/verify-member?pinHash=${encodeURIComponent(pinHash)}&chatId=${encodeURIComponent(chatId)}`
        );
        const verify = await verifyRes.json();
        if (!verify.ok) return json({ error: 'forbidden' }, 403);
        const roomStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId));
        if (request.method === 'GET') return roomStub.fetch('https://internal/e2ee-wraps');
        if (request.method === 'POST') {
          const body = await request.text();
          return roomStub.fetch('https://internal/e2ee-wraps', { method: 'POST', body });
        }
      }

      // /api/chats/:id/e2ee-wraps/reset, clears a chat's stored key wraps so
      // it can freshly re-establish, for the (thankfully rare) case where a
      // chat is permanently stuck "waiting for encryption" because of
      // partial/stale wrap data. Self-service: any member can trigger it.
      const e2eeResetMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/e2ee-wraps\/reset$/);
      if (e2eeResetMatch && request.method === 'POST') {
        const [, chatId] = e2eeResetMatch;
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const verifyRes = await registryStub.fetch(
          `https://internal/verify-member?pinHash=${encodeURIComponent(pinHash)}&chatId=${encodeURIComponent(chatId)}`
        );
        const verify = await verifyRes.json();
        if (!verify.ok) return json({ error: 'forbidden' }, 403);
        const roomStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId));
        return roomStub.fetch('https://internal/e2ee-wraps/reset', { method: 'POST' });
      }

      // /api/chats/:id/hide, removes a chat from just this user's own list
      // (see Registry's /hide-chat for the per-user semantics).
      const hideMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/hide$/);
      if (hideMatch && request.method === 'POST') {
        const [, chatId] = hideMatch;
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        return registryStub.fetch('https://internal/hide-chat', {
          method: 'POST',
          body: JSON.stringify({ pinHash, chatId }),
        });
      }

      // /api/chats/:id/delete, permanent (for this user only), unlike /hide.
      const deleteMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/delete$/);
      if (deleteMatch && request.method === 'POST') {
        const [, chatId] = deleteMatch;
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        return registryStub.fetch('https://internal/delete-chat', {
          method: 'POST',
          body: JSON.stringify({ pinHash, chatId }),
        });
      }

      // /api/chats/:id/pin, per-user pin-to-top preference.
      const pinMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/pin$/);
      if (pinMatch && request.method === 'POST') {
        const [, chatId] = pinMatch;
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const body = await request.json().catch(() => ({}));
        return registryStub.fetch('https://internal/pin-chat', {
          method: 'POST',
          body: JSON.stringify({ pinHash, chatId, pinned: !!body.pinned }),
        });
      }

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
          const { upToTs, silent } = await request.json().catch(() => ({}));
          const res = await roomStub.fetch('https://internal/read', {
            method: 'POST',
            body: JSON.stringify({ userId: verify.userId, upToTs: upToTs || Date.now(), silent: !!silent }),
          });
          return res;
        }

        if (action === 'messages' && request.method === 'GET') {
          return roomStub.fetch('https://internal/messages');
        }

        if (action === 'messages' && request.method === 'POST') {
          const { ciphertext, iv, alg, attachment, replyTo, protected: isProtected } = await request.json();
          const res = await roomStub.fetch('https://internal/messages', {
            method: 'POST',
            body: JSON.stringify({ fromUserId: verify.userId, fromName: verify.displayName, ciphertext, iv, alg, attachment, replyTo, protected: !!isProtected }),
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

  // Runs once a day (see wrangler.jsonc's triggers.crons). A no-op unless an
  // admin has explicitly set a retention window, the default is "keep
  // everything forever," matching how this worked before retention existed.
  async scheduled(event, env, ctx) {
    try {
      const registryStub = env.REGISTRY.get(env.REGISTRY.idFromName('global-registry-v1'));
      const retRes = await registryStub.fetch('https://internal/internal/retention-days');
      const { retentionDays } = await retRes.json();
      if (!retentionDays) return;

      const cutoffTs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      const listRes = await registryStub.fetch('https://internal/internal/all-chat-ids');
      const { chatIds } = await listRes.json();

      for (const chatId of chatIds || []) {
        try {
          const roomStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId));
          const res = await roomStub.fetch('https://internal/purge-old', {
            method: 'POST',
            body: JSON.stringify({ cutoffTs }),
          });
          const { mediaKeys } = await res.json();
          if (env.MEDIA && mediaKeys && mediaKeys.length) {
            await Promise.all(mediaKeys.map((key) => env.MEDIA.delete(key).catch(() => {})));
          }
        } catch (e) {
          // One chat failing shouldn't stop the rest of the sweep, it'll be
          // retried on tomorrow's run regardless.
        }
      }
    } catch (e) {
      // Never let a retention-sweep failure affect anything else this worker does.
    }
  },
};
