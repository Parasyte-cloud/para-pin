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

// A personal (non-workspace) group call is a lighter, free-tier feature:
// capped headcount, no recording, no AI meeting assistant. Workspace
// membership (verified server-side, see /api/meeting/room/ws) lifts the cap
// entirely and unlocks both.
const PERSONAL_MEETING_CAP = 6;

function authHash(request, url) {
  return request.headers.get('X-Para-Pin-Hash') || url.searchParams.get('pinHash') || null;
}

// CSV, not JSON, for the HR/audit data exports — this is specifically for
// compliance requests (GDPR-style "give us all our people data"), and
// whoever's asking for that wants something they can open directly in
// Excel/Sheets, not a file they need a developer to parse. RFC 4180 quoting
// (wrap in quotes + double any embedded quotes) any field containing a
// comma, quote, or newline — HR free-text fields (reason, comment, address)
// can easily contain any of those.
function csvEscape(val) {
  const s = val === null || val === undefined ? '' : String(val);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function toCsv(rows) {
  return rows.map((row) => row.map(csvEscape).join(',')).join('\r\n');
}

// Whisper's binding wants the raw audio as a base64 string, not bytes.
// btoa(String.fromCharCode(...bytes)) blows the call stack on anything past
// a few tens of KB (spread arg limit), so this builds the binary string in
// small chunks instead, same technique as any browser-side version of this.
function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
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
  // Arrivo People (HR module) uses this as the default hire date for anyone
  // who hasn't been given a real one by HR yet, only set once so a later
  // re-add (e.g. leave-then-rejoin) doesn't reset someone's tenure.
  const joinKey = `orgJoinedAt:${orgId}:${userId}`;
  if (!(await storage.get(joinKey))) await storage.put(joinKey, Date.now());
  return true;
}

// ================= Workspace billing (Paystack) =================
// A workspace only works while its subscription is active. Orgs created
// before this went in have no billingStatus field at all, those are
// grandfathered as active rather than retroactively locking out every
// workspace that already existed, only NEW workspaces (and any that later
// lapse) actually get stopped at the door. Personal space (orgId null) is
// never gated, it was never a paid thing to begin with.
async function isOrgBillingActive(storage, orgId) {
  if (!orgId) return true;
  const org = await storage.get(`org:${orgId}`);
  if (!org) return false;
  if (org.billingStatus === undefined) return true;
  return org.billingStatus === 'active';
}

async function isOrgMember(storage, orgId, userId) {
  if (!(await isOrgBillingActive(storage, orgId))) return false;
  const members = (await storage.get(`orgMembers:${orgId}`)) || [];
  return members.includes(userId);
}

async function isOrgAdmin(storage, orgId, userId) {
  const org = await storage.get(`org:${orgId}`);
  if (!org) return false;
  if (org.billingStatus !== undefined && org.billingStatus !== 'active') return false;
  if (Array.isArray(org.admins) && org.admins.includes(userId)) return true;
  // App-wide admins (the same list /admin/promote manages) can manage any
  // workspace too, useful for support/ops without needing to be personally
  // added to every org that gets created.
  const appAdmins = (await storage.get('admins')) || [];
  return appAdmins.includes(userId);
}

// Same admin check as above but WITHOUT the billing gate, only ever used by
// the billing endpoints themselves (checking status, starting a reactivation
// payment). Everything else must go through the gated isOrgAdmin, otherwise
// a lapsed workspace's admin could still reach into the actual workspace
// (chats, roster, etc.) through any endpoint that used this instead.
async function isOrgAdminIgnoringBilling(storage, orgId, userId) {
  const org = await storage.get(`org:${orgId}`);
  if (!org) return false;
  if (Array.isArray(org.admins) && org.admins.includes(userId)) return true;
  const appAdmins = (await storage.get('admins')) || [];
  return appAdmins.includes(userId);
}

// ================= Workspace RBAC (per-feature permission grants) =================
// A workspace admin already has every capability; these are narrower grants
// an admin can hand to (or withhold from) a specific, otherwise-ordinary
// member without making them a full admin. Deliberately a flat list of
// feature toggles rather than named roles: no role CRUD to build, no "which
// role am I" indirection, an admin just checks boxes per person in the
// Members modal.
//
// manage_workspace - rename/rebrand the workspace, email-auth domain settings (/org/update)
// manage_members   - invite existing users and onboard new ones (/org/invite, /org/roster)
// manage_hr        - edit others' HR profile/job records, decide leave requests, view others' leave history
// start_meetings   - start/join the unlimited workspace Meeting Room (recording + AI assistant)
const ORG_PERMISSIONS = ['manage_workspace', 'manage_members', 'manage_hr', 'start_meetings'];

// Whether an ordinary (non-admin) member has each permission before any
// explicit admin override. manage_* default OFF, they were always
// admin-only, this system only ever ADDS capability for them. start_meetings
// defaults ON: every workspace member could already start/join a meeting
// before this system existed, introducing per-feature toggles shouldn't
// silently strip that from everyone who isn't individually re-granted, an
// admin who wants to restrict it now has a way to (explicitly turn it off
// per person), but nobody loses access just because this feature shipped.
const ORG_PERMISSION_DEFAULTS = {
  manage_workspace: false,
  manage_members: false,
  manage_hr: false,
  start_meetings: true,
};

// Raw admin-set overrides for one member, `{ [permission]: true|false }`.
// Only permissions someone has ever explicitly toggled appear here, anything
// absent falls back to ORG_PERMISSION_DEFAULTS.
async function getOrgPermissionOverrides(storage, orgId, userId) {
  return (await storage.get(`orgPermissions:${orgId}:${userId}`)) || {};
}

// The full effective list (defaults + overrides applied) a non-admin member
// currently has, used to seed the admin toggle UI and the member's own
// self-check endpoint.
async function getEffectiveOrgPermissions(storage, orgId, userId) {
  const overrides = await getOrgPermissionOverrides(storage, orgId, userId);
  return ORG_PERMISSIONS.filter((p) =>
    Object.prototype.hasOwnProperty.call(overrides, p) ? overrides[p] : ORG_PERMISSION_DEFAULTS[p]
  );
}

// The one check every gated route below should use instead of isOrgAdmin
// directly: an admin passes unconditionally, anyone else falls through to
// their effective grant (explicit override, or the feature's default).
// Never used to gate /org/permissions/set itself, that stays isOrgAdmin-only
// on purpose, otherwise a member holding one delegable permission could hand
// out others (including to themselves), which defeats the point of a narrow
// grant.
async function hasOrgPermission(storage, orgId, userId, permission) {
  if (await isOrgAdmin(storage, orgId, userId)) return true;
  const overrides = await getOrgPermissionOverrides(storage, orgId, userId);
  return Object.prototype.hasOwnProperty.call(overrides, permission)
    ? !!overrides[permission]
    : !!ORG_PERMISSION_DEFAULTS[permission];
}

// ==================== Arrivo People (HR module, Phase 1) ====================
// Workspace-scoped like everything else org-related: Ride Arrivo's employee
// data never crosses into another workspace or into Personal. Org admins
// double as "HR" for permission purposes (same isOrgAdmin gate the rest of
// the workspace features use), a direct manager gets a narrower slice
// (approve their own reports' leave) via employee.job.current.managerId.

// Lazily created on first touch rather than at org-join time, most org
// members will never fill in HR fields at all in Phase 1, forcing a full
// record to exist immediately would just be empty rows nobody asked for.
function emptyCompensation(effectiveDate) {
  return { current: { effectiveDate, baseSalary: null, currency: null, payFrequency: null }, history: [] };
}
async function getEmployee(storage, orgId, userId) {
  const rec = await storage.get(`employee:${orgId}:${userId}`);
  if (rec) {
    // Backfills a field added after some employee records already existed —
    // an old stored record simply won't have this key at all, and every
    // caller below assumes employee.compensation.current exists. Patched in
    // memory here rather than a one-time migration script (nothing else in
    // this Durable Object has a migration runner), gets actually persisted
    // the next time anything writes this record via POST /org/hr/profile.
    if (!rec.compensation) rec.compensation = emptyCompensation(rec.hireDate || Date.now());
    return rec;
  }
  const joinedAt = (await storage.get(`orgJoinedAt:${orgId}:${userId}`)) || Date.now();
  return {
    orgId, userId,
    personal: {
      firstName: null, middleName: null, lastName: null, preferredName: null,
      dob: null, gender: null, maritalStatus: null, nationalId: null,
      homeAddress: { street: null, city: null, state: null, postal: null, country: null },
      workPhone: null, personalMobile: null, personalEmail: null,
      officeLocation: null, employmentType: 'full_time',
    },
    hireDate: joinedAt,
    job: { current: { effectiveDate: joinedAt, entity: null, department: null, jobTitle: null, managerId: null }, history: [] },
    // HR-only to ever set (see POST /org/hr/profile), visible to the employee
    // themselves same as everything else here, but — unlike job title/dept,
    // which the directory/org chart show to any colleague — never shown to
    // anyone else at all, redacted alongside address/national ID in GET.
    compensation: emptyCompensation(joinedAt),
    createdAt: joinedAt, updatedAt: joinedAt,
  };
}

// Defaults match the original Phase 1 spec exactly (20 annual/10 sick), so
// an org that's never touched this setting behaves identically to before it
// existed — same "grandfathered" pattern as org.billingStatus/country.
const DEFAULT_LEAVE_ENTITLEMENTS = { annual: 20, sick: 10 };

async function getOrgLeaveEntitlements(storage, orgId) {
  const org = await storage.get(`org:${orgId}`);
  const annual = org && Number.isFinite(org.annualEntitlement) ? org.annualEntitlement : DEFAULT_LEAVE_ENTITLEMENTS.annual;
  const sick = org && Number.isFinite(org.sickEntitlement) ? org.sickEntitlement : DEFAULT_LEAVE_ENTITLEMENTS.sick;
  return { annual, sick };
}

// Annual leave: pro-rated by whole months remaining in the hire year, full
// entitlement every Jan 1 after (per spec). Sick leave: flat per year, no
// proration, resets every calendar year (tracked as "used year-to-date").
// Carryover/caps are deliberately out of scope for Phase 1. `entitlements`
// is this org's own {annual, sick} policy (see getOrgLeaveEntitlements),
// not a hardcoded constant — every caller already needs one storage read
// for orgId anyway, so this doesn't add a real extra cost.
function entitlementForYear(hireDate, type, year, entitlements) {
  const hireYear = new Date(hireDate).getUTCFullYear();
  if (type === 'sick') return year < hireYear ? 0 : entitlements.sick;
  if (year < hireYear) return 0;
  if (year > hireYear) return entitlements.annual;
  const hireMonth = new Date(hireDate).getUTCMonth(); // 0-11
  const monthsRemaining = 12 - hireMonth;
  return Math.round(entitlements.annual * monthsRemaining / 12);
}

// Ledger rows are the ONLY source of truth for usage/adjustments (nothing is
// mutated in place), so the balance is always re-derivable and the history
// table (below) is just this same ledger rendered, not a separate log.
async function getLeaveLedger(storage, orgId, userId) {
  return (await storage.get(`leaveLedger:${orgId}:${userId}`)) || [];
}
async function appendLeaveLedger(storage, orgId, userId, entry) {
  const ledger = await getLeaveLedger(storage, orgId, userId);
  ledger.push({ id: crypto.randomUUID(), ts: Date.now(), ...entry });
  await storage.put(`leaveLedger:${orgId}:${userId}`, ledger);
}

// ---- Admin audit log ----
// Same append-only ledger shape as leave/billing history, one list per org,
// newest last. Capped rather than unbounded: this is "who changed what
// recently" for a live admin console, not a permanent compliance archive
// (that's what the data export in task #26 is for) — an org that's been
// live for years shouldn't carry an ever-growing list into every future
// read of it. `actor` is null for system/webhook-driven entries (Paystack
// activating/deactivating billing isn't any one person's action).
const AUDIT_LOG_MAX_ENTRIES = 500;
async function appendAuditLog(storage, orgId, entry) {
  const key = `auditLog:${orgId}`;
  const log = (await storage.get(key)) || [];
  log.push({ id: crypto.randomUUID(), ts: Date.now(), ...entry });
  if (log.length > AUDIT_LOG_MAX_ENTRIES) log.splice(0, log.length - AUDIT_LOG_MAX_ENTRIES);
  await storage.put(key, log);
}
// Annual leave doesn't reset, so its balance nets the WHOLE ledger; sick
// leave resets every calendar year, so only this year's rows count.
function computeLeaveBalance(ledger, type, hireDate, entitlements, now = Date.now()) {
  const year = new Date(now).getUTCFullYear();
  const entitlement = entitlementForYear(hireDate, type, year, entitlements);
  const relevant = ledger.filter((e) => e.type === type && (type === 'annual' || new Date(e.ts).getUTCFullYear() === year));
  const net = relevant.reduce((sum, e) => sum + e.delta, 0);
  return Math.round((entitlement + net) * 100) / 100;
}

function daysBetweenInclusive(startDate, endDate, halfDay) {
  const start = new Date(startDate + 'T00:00:00Z').getTime();
  const end = new Date(endDate + 'T00:00:00Z').getTime();
  if (isNaN(start) || isNaN(end) || end < start) return 0;
  const days = Math.round((end - start) / 86400000) + 1;
  return halfDay ? 0.5 : days;
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

// Same Resend setup as sendOnboardingEmail above, a short numeric code to
// prove control of an address someone is attaching to their existing
// account (see /account/email/request-code).
async function sendVerificationCodeEmail(env, { to, name, code }) {
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
        subject: 'Your PArA PIN verification code',
        text: `Hi ${name || 'there'},\n\nYour verification code is: ${code}\n\nIt expires in 15 minutes. If you didn't request this, you can ignore this email.\n\nThe PArA PIN team`,
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

// The magic-link sign-in email (see /auth/email/request). When this also
// doubles as a brand-new account's very first contact (a company-domain
// self-signup), it carries the freshly minted PIN too, same as the roster
// onboarding email above, just folded into one message instead of two.
async function sendMagicLinkEmail(env, { to, token, origin }) {
  if (!env.RESEND_API_KEY) return { sent: false, error: 'resend_not_configured' };
  if (!env.RESEND_FROM_EMAIL) return { sent: false, error: 'resend_from_not_configured' };
  const base = origin || 'https://chat.parasyte.cloud';
  const link = `${base}/auth/confirm?token=${encodeURIComponent(token)}`;
  // No PIN ever travels in this email, even for a brand-new account
  // self-provisioned off a matching company domain: the client forces a
  // fresh, person-chosen PIN immediately after this link is used (see
  // forcePinChangeOverlay), so a temporary generated one is never
  // meaningful to show anyone.
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
        subject: 'Sign in to PArA PIN',
        text: `Hi,\n\nClick below to sign in:\n${link}\n\nThis link expires in 15 minutes and works once. If you didn't request this, you can ignore this email.\n\nThe PArA PIN team`,
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

// Sent once a workspace's Paystack subscription clears, from the webhook
// handler (see /api/billing/webhook). Deliberately a rich inline HTML email
// rather than a generated .docx attachment: Workers has no good native way
// to build a real Word file at request time the way a desktop tool can, an
// email is the reliable "this reaches them automatically, no manual step"
// delivery method. The full written manual (with the same content plus
// everything else in the app) can still be handed out separately as a file.
async function sendAdminWelcomeEmail(env, { to, name, orgName }) {
  if (!env.RESEND_API_KEY) return { sent: false, error: 'resend_not_configured' };
  if (!env.RESEND_FROM_EMAIL) return { sent: false, error: 'resend_from_not_configured' };
  const html = `
    <div style="font-family:sans-serif; max-width:520px; margin:0 auto; color:#12161b;">
      <h2>Welcome to Admin, ${escapeHtmlEmail(name || 'there')}</h2>
      <p>Your payment for <strong>${escapeHtmlEmail(orgName || 'your workspace')}</strong> went through, it's live now.</p>
      <h3>Quick start</h3>
      <ul>
        <li><strong>Invite people:</strong> Settings &rarr; Workspace &rarr; Invite, by PIN or by email.</li>
        <li><strong>Set permissions:</strong> Settings &rarr; Workspace &rarr; Members lets you grant or withhold specific abilities per person, without making everyone a full admin.</li>
        <li><strong>Meeting Room:</strong> the icon next to your workspace name in the sidebar, unlimited participants, recording, and AI summaries.</li>
        <li><strong>Billing:</strong> this is a recurring subscription, if a payment ever fails, the workspace locks until it's brought current, from the same Settings screen.</li>
      </ul>
      <p>The PArA PIN team</p>
    </div>`;
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
        subject: `You're an Admin on PArA PIN`,
        html,
        text: `Welcome to Admin, ${name || 'there'}. Your payment for ${orgName || 'your workspace'} went through, it's live now. Invite people and set permissions from Settings > Workspace. Meeting Room lives next to your workspace name in the sidebar. This is a recurring subscription, if a payment fails the workspace locks until you bring it current.`,
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
function escapeHtmlEmail(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ================= Paystack (workspace admin billing) =================
// Verifies the x-paystack-signature header: HMAC-SHA512 of the exact raw
// request body, using the Paystack secret key. This MUST run on the raw
// bytes before any JSON.parse, and MUST pass before anything in the webhook
// body is trusted, otherwise anyone who finds the webhook URL could activate
// a workspace for free by POSTing a fake charge.success themselves.
async function verifyPaystackSignature(rawBody, signatureHeader, secretKey) {
  if (!signatureHeader || !secretKey) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secretKey), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  const computed = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (computed.length !== signatureHeader.length) return false;
  // Constant-time-ish compare, a webhook signature check shouldn't leak
  // timing information about how much of the guess was right.
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  return diff === 0;
}

// Starts a Paystack transaction. Two shapes: a recurring Plan (workspace
// subscriptions, and Premium's monthly option, `planCode` is a Plan created
// in the Paystack dashboard, that's where the actual price/interval live,
// changeable there without touching this code) or a one-time fixed `amount`
// (Premium's lifetime unlock, no Plan/subscription involved at all, just a
// single charge, Paystack never sends subscription.create/disable for these).
// `amount` is in the smallest unit of whatever currency the Paystack account
// is configured for (kobo for NGN, cents for USD, etc.), set via
// PAYSTACK_PREMIUM_LIFETIME_AMOUNT to match that account's currency.
async function paystackInitTransaction(env, { email, orgId, userId, purpose, callbackUrl, planCode, amount }) {
  if (!env.PAYSTACK_SECRET_KEY) return { ok: false, error: 'paystack_not_configured' };
  if (!planCode && !amount) return { ok: false, error: 'paystack_plan_not_configured' };
  const body = { email, callback_url: callbackUrl, metadata: { orgId: orgId || null, userId: userId || null, purpose } };
  if (planCode) body.plan = planCode; else body.amount = amount;
  const res = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const respBody = await res.json().catch(() => ({}));
  if (!res.ok || !respBody.status) {
    return { ok: false, error: (respBody && respBody.message) || `status ${res.status}` };
  }
  return { ok: true, authorizationUrl: respBody.data.authorization_url, reference: respBody.data.reference };
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
        if (org) orgs.push({ id: org.id, name: org.name, logoUrl: org.logoUrl || null, allowEmailAuth: !!org.allowEmailAuth, emailDomain: org.emailDomain || null, country: org.country || null, isAdmin: await isOrgAdmin(this.state.storage, org.id, user.id) });
      }

      return json({
        userId: user.id,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl || null,
        department: user.department || null,
        email: user.email || null,
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

    // Message a workspace member directly by their userId, not their PIN.
    // The Members list only ever exposes userIds (a PIN is sensitive, never
    // handed out just because two people share a workspace), so /contact's
    // PIN-based lookup doesn't work from there, this is the same
    // get-or-create-DM logic, just keyed off userId and gated on both sides
    // actually being members of the given workspace (same as /contact's own
    // orgId check) rather than one side proving they know the other's PIN.
    if (request.method === 'POST' && url.pathname === '/org/member-dm') {
      const { pinHash, orgId, targetUserId } = await request.json();
      const me = await this.state.storage.get(`user:${pinHash}`);
      if (!me) return json({ error: 'not_registered' }, 401);
      if (!targetUserId || targetUserId === me.id) return json({ error: 'invalid_target' }, 400);
      if (!orgId || !(await isOrgMember(this.state.storage, orgId, me.id))) {
        return json({ error: 'not_org_member' }, 403);
      }
      if (!(await isOrgMember(this.state.storage, orgId, targetUserId))) {
        return json({ error: 'not_org_member' }, 403);
      }
      const otherPinHash = await this.state.storage.get(`userIdToPinHash:${targetUserId}`);
      const other = otherPinHash ? await this.state.storage.get(`user:${otherPinHash}`) : null;
      if (!other) return json({ error: 'not_found' }, 404);

      const myChatIds = (await this.state.storage.get(`userChats:${me.id}`)) || [];
      for (const cid of myChatIds) {
        const c = await this.state.storage.get(`chat:${cid}`);
        if (c && c.type === 'dm' && c.memberIds.includes(other.id) && (c.orgId || null) === orgId) {
          const hidden = (await this.state.storage.get(`hiddenChats:${me.id}`)) || {};
          if (hidden[cid]) {
            delete hidden[cid];
            await this.state.storage.put(`hiddenChats:${me.id}`, hidden);
          }
          return json({ chat: c, existing: true });
        }
      }
      const otherChatIds = (await this.state.storage.get(`userChats:${other.id}`)) || [];
      for (const cid of otherChatIds) {
        const c = await this.state.storage.get(`chat:${cid}`);
        if (c && c.type === 'dm' && c.memberIds.includes(me.id) && (c.orgId || null) === orgId) {
          await this.state.storage.put(`userChats:${me.id}`, [...myChatIds, cid]);
          return json({ chat: c, existing: true });
        }
      }
      const chatId = crypto.randomUUID();
      const chat = { id: chatId, type: 'dm', name: null, memberIds: [me.id, other.id], createdAt: Date.now(), orgId };
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
      // A workspace chat is still keyed off chat.memberIds, not the org's own
      // member list, so it needs its own billing check here too, otherwise a
      // lapsed workspace's chats would keep working even though everything
      // else (roster, Meeting Room, RBAC) is locked.
      if (chat.orgId && !(await isOrgBillingActive(this.state.storage, chat.orgId))) {
        return json({ ok: false, error: 'workspace_payment_required' });
      }
      return json({ ok: true, userId: user.id, displayName: user.displayName, avatarUrl: user.avatarUrl || null, chat });
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

    // Explicit "Unarchive" action (as opposed to /hide-chat's automatic
    // un-hide on new activity), for the Archived filter's own context menu.
    if (request.method === 'POST' && url.pathname === '/unhide-chat') {
      const { pinHash, chatId } = await request.json();
      const user = await this.state.storage.get(`user:${pinHash}`);
      if (!user) return json({ ok: false, error: 'not_registered' }, 401);
      const hidden = (await this.state.storage.get(`hiddenChats:${user.id}`)) || {};
      if (hidden[chatId]) {
        delete hidden[chatId];
        await this.state.storage.put(`hiddenChats:${user.id}`, hidden);
      }
      return json({ ok: true });
    }

    // Lists chats currently hidden ("archived") for this user, for the
    // Chats screen's own Archived filter pill. /session already lazily
    // prunes hiddenChats the moment a hidden chat gets new activity (see
    // above), so by the time this runs the map is always current truth,
    // no need to redo that comparison here.
    if (request.method === 'GET' && url.pathname === '/archived-chats') {
      const pinHash = url.searchParams.get('pinHash');
      const user = await this.state.storage.get(`user:${pinHash}`);
      if (!user) return json({ error: 'not_registered' }, 401);
      const hidden = (await this.state.storage.get(`hiddenChats:${user.id}`)) || {};
      const chats = [];
      for (const cid of Object.keys(hidden)) {
        const c = await this.state.storage.get(`chat:${cid}`);
        if (c) chats.push(c);
      }
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
      return json({ chats, summaries });
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
      return json({ ok: true, userId: user.id, displayName: user.displayName, avatarUrl: user.avatarUrl || null, isAdmin: admins.includes(user.id), premiumStatus: user.premiumStatus || 'none' });
    }

    // Per-user call history, each client writes its own side of a call
    // independently once it ends (see /api/calls/log), so no cross-user name
    // lookup is needed here: the caller already knows who they dialed, and
    // the callee already got the caller's name/avatar in the incoming offer.
    if (request.method === 'GET' && url.pathname === '/call-log') {
      const userId = url.searchParams.get('userId');
      if (!userId) return json({ error: 'missing_user_id' }, 400);
      const log = (await this.state.storage.get(`callLog:${userId}`)) || [];
      // Workspace/personal separation: a call made from inside a workspace
      // shouldn't show up in the Calls tab back on Personal, and vice versa.
      // orgId is optional on the query (personal = no orgId at all), and on
      // older entries logged before this field existed (treated as personal,
      // same grandfathering approach used for billingStatus elsewhere).
      const orgId = url.searchParams.get('orgId') || null;
      const scoped = log.filter(e => (e.orgId || null) === orgId);
      return json({ log: scoped });
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
        orgId: entry.orgId || null,
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
      // Starts locked (billingStatus 'pending'): the creator is wired up as
      // admin/member right away so no separate limbo bookkeeping is needed,
      // but isOrgMember/isOrgAdmin won't actually let anyone use it (chats,
      // roster, Meeting Room, all of it) until the Paystack webhook flips
      // this to 'active'. See isOrgBillingActive.
      const org = { id: orgId, name: name.trim().slice(0, 60), logoUrl: null, allowEmailAuth: false, emailDomain: null, createdAt: Date.now(), createdBy: me.id, admins: [me.id], billingStatus: 'pending' };
      await this.state.storage.put(`org:${orgId}`, org);
      await addUserToOrg(this.state.storage, orgId, me.id);
      return json({ org });
    }

    // ---- Workspace billing (Paystack) ----
    // Called by the outer worker right after it initializes a Paystack
    // transaction, so the webhook (which only ever gets Paystack's own
    // `reference` back, not our orgId) has a way to find its way back to the
    // right workspace once payment actually clears.
    if (request.method === 'POST' && url.pathname === '/billing/store-ref') {
      const { reference, orgId, purpose } = await request.json();
      if (!reference || !orgId) return json({ error: 'missing_fields' }, 400);
      await this.state.storage.put(`billingRef:${reference}`, { orgId, purpose: purpose || 'workspace_admin' });
      return json({ ok: true });
    }

    // Marks a workspace active. Called only from the outer worker's Paystack
    // webhook handler, after it has independently verified the
    // x-paystack-signature, this endpoint itself trusts whatever it's given,
    // all the actual fraud-prevention happens before this is ever reached.
    if (request.method === 'POST' && url.pathname === '/billing/activate') {
      const { reference, orgId: directOrgId, customerCode, subscriptionCode, payerEmail } = await request.json();
      let orgId = directOrgId || null;
      if (!orgId && reference) {
        const ref = await this.state.storage.get(`billingRef:${reference}`);
        orgId = ref ? ref.orgId : null;
      }
      // subscription.create fires as its own separate webhook event, after
      // the charge.success that already resolved+activated the org via
      // reference, all it carries is the customer code, not our reference or
      // orgId, so it falls back to the index charge.success just wrote.
      if (!orgId && customerCode) {
        orgId = await this.state.storage.get(`orgByCustomerCode:${customerCode}`);
      }
      if (!orgId) return json({ error: 'unknown_reference' }, 404);
      const org = await this.state.storage.get(`org:${orgId}`);
      if (!org) return json({ error: 'not_found' }, 404);
      org.billingStatus = 'active';
      org.paystackCustomerCode = customerCode || org.paystackCustomerCode || null;
      if (subscriptionCode) org.paystackSubscriptionCode = subscriptionCode;
      org.payerEmail = payerEmail || org.payerEmail || null;
      org.billingActivatedAt = Date.now();
      await this.state.storage.put(`org:${orgId}`, org);
      // Indexed both ways so a later subscription.disable / invoice event
      // (which only ever carries Paystack's own codes, never our orgId) can
      // still find its way back to this workspace.
      if (org.paystackCustomerCode) await this.state.storage.put(`orgByCustomerCode:${org.paystackCustomerCode}`, orgId);
      if (org.paystackSubscriptionCode) await this.state.storage.put(`orgBySubscriptionCode:${org.paystackSubscriptionCode}`, orgId);
      // actorId null: this is Paystack's webhook telling us a payment
      // cleared, not any person in the app clicking anything.
      await appendAuditLog(this.state.storage, orgId, {
        actorId: null, actorName: 'Paystack', action: 'billing_activated',
        details: payerEmail ? `Billing activated (${payerEmail})` : 'Billing activated',
      });
      const admins = Array.isArray(org.admins) ? org.admins : [];
      const adminUserId = admins[0] || org.createdBy;
      let adminPinHash = null, adminDisplayName = null;
      if (adminUserId) {
        adminPinHash = await this.state.storage.get(`userIdToPinHash:${adminUserId}`);
        const adminUser = adminPinHash ? await this.state.storage.get(`user:${adminPinHash}`) : null;
        adminDisplayName = adminUser ? adminUser.displayName : null;
      }
      return json({ ok: true, org, adminUserId, adminDisplayName });
    }

    // Called from subscription.disable / invoice.payment_failed. Looks the
    // workspace up by whichever Paystack code the event carries, since those
    // events never include our own orgId or reference.
    if (request.method === 'POST' && url.pathname === '/billing/deactivate') {
      const { customerCode, subscriptionCode, status } = await request.json();
      let orgId = null;
      if (subscriptionCode) orgId = await this.state.storage.get(`orgBySubscriptionCode:${subscriptionCode}`);
      if (!orgId && customerCode) orgId = await this.state.storage.get(`orgByCustomerCode:${customerCode}`);
      if (!orgId) return json({ error: 'unknown_subscription' }, 404);
      const org = await this.state.storage.get(`org:${orgId}`);
      if (!org) return json({ error: 'not_found' }, 404);
      org.billingStatus = status === 'canceled' ? 'canceled' : 'past_due';
      await this.state.storage.put(`org:${orgId}`, org);
      await appendAuditLog(this.state.storage, orgId, {
        actorId: null, actorName: 'Paystack', action: 'billing_deactivated',
        details: `Billing status changed to ${org.billingStatus}`,
      });
      return json({ ok: true, orgId });
    }

    // ---- Premium (per-user) billing ----
    // Mirrors the workspace billing endpoints above almost exactly, just
    // keyed by userId instead of orgId, and stored on the user record
    // instead of the org record. Two purposes share this: 'premium_monthly'
    // (a real subscription, gets subscription.create/disable events later)
    // and 'premium_lifetime' (a single charge.success and nothing else ever
    // follows it, no subscription exists to disable).
    if (request.method === 'POST' && url.pathname === '/billing/premium/store-ref') {
      const { reference, userId, purpose } = await request.json();
      if (!reference || !userId) return json({ error: 'missing_fields' }, 400);
      await this.state.storage.put(`premiumBillingRef:${reference}`, { userId, purpose: purpose || 'premium_monthly' });
      return json({ ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/billing/premium/activate') {
      const { reference, userId: directUserId, customerCode, subscriptionCode, lifetime } = await request.json();
      let userId = directUserId || null;
      if (!userId && reference) {
        const ref = await this.state.storage.get(`premiumBillingRef:${reference}`);
        userId = ref ? ref.userId : null;
      }
      if (!userId && customerCode) {
        userId = await this.state.storage.get(`userByPremiumCustomerCode:${customerCode}`);
      }
      if (!userId) return json({ ok: false, error: 'unknown_reference' }, 404);
      const pinHash = await this.state.storage.get(`userIdToPinHash:${userId}`);
      if (!pinHash) return json({ ok: false, error: 'user_not_found' }, 404);
      const user = await this.state.storage.get(`user:${pinHash}`);
      if (!user) return json({ ok: false, error: 'user_not_found' }, 404);
      user.premiumStatus = lifetime ? 'lifetime' : 'active';
      user.premiumCustomerCode = customerCode || user.premiumCustomerCode || null;
      if (subscriptionCode) user.premiumSubscriptionCode = subscriptionCode;
      user.premiumActivatedAt = Date.now();
      await this.state.storage.put(`user:${pinHash}`, user);
      if (user.premiumCustomerCode) await this.state.storage.put(`userByPremiumCustomerCode:${user.premiumCustomerCode}`, userId);
      if (user.premiumSubscriptionCode) await this.state.storage.put(`userByPremiumSubscriptionCode:${user.premiumSubscriptionCode}`, userId);
      return json({ ok: true, userId });
    }

    if (request.method === 'POST' && url.pathname === '/billing/premium/deactivate') {
      const { customerCode, subscriptionCode, status } = await request.json();
      let userId = null;
      if (subscriptionCode) userId = await this.state.storage.get(`userByPremiumSubscriptionCode:${subscriptionCode}`);
      if (!userId && customerCode) userId = await this.state.storage.get(`userByPremiumCustomerCode:${customerCode}`);
      if (!userId) return json({ ok: false, error: 'unknown_subscription' }, 404);
      const pinHash = await this.state.storage.get(`userIdToPinHash:${userId}`);
      if (!pinHash) return json({ ok: false, error: 'user_not_found' }, 404);
      const user = await this.state.storage.get(`user:${pinHash}`);
      if (!user) return json({ ok: false, error: 'user_not_found' }, 404);
      // A lifetime unlock has no subscription behind it to lapse, this only
      // ever downgrades someone who was on the monthly plan.
      if (user.premiumStatus !== 'lifetime') {
        user.premiumStatus = status === 'canceled' ? 'none' : 'past_due';
        await this.state.storage.put(`user:${pinHash}`, user);
      }
      return json({ ok: true, userId });
    }

    if (request.method === 'GET' && url.pathname === '/billing/premium/status') {
      const pinHash = url.searchParams.get('pinHash');
      const user = await this.state.storage.get(`user:${pinHash}`);
      if (!user) return json({ error: 'not_registered' }, 401);
      return json({ ok: true, premiumStatus: user.premiumStatus || 'none' });
    }

    // Client-facing status check, deliberately NOT gated by isOrgMember (that
    // would make a lapsed workspace's own lock screen unreachable, the one
    // place billing status needs to be readable regardless of billing status
    // itself). Only a real member (or an app admin) can see it though.
    if (request.method === 'GET' && url.pathname === '/billing/status') {
      const pinHash = url.searchParams.get('pinHash');
      const orgId = url.searchParams.get('orgId');
      const me = await this.state.storage.get(`user:${pinHash}`);
      if (!me || !orgId) return json({ error: 'not_registered' }, 401);
      const org = await this.state.storage.get(`org:${orgId}`);
      if (!org) return json({ error: 'not_found' }, 404);
      const members = (await this.state.storage.get(`orgMembers:${orgId}`)) || [];
      const appAdmins = (await this.state.storage.get('admins')) || [];
      const isMember = members.includes(me.id) || appAdmins.includes(me.id);
      if (!isMember) return json({ error: 'forbidden' }, 403);
      const canReactivate = await isOrgAdminIgnoringBilling(this.state.storage, orgId, me.id);
      return json({
        ok: true,
        billingStatus: org.billingStatus === undefined ? 'active' : org.billingStatus,
        orgName: org.name,
        canReactivate,
      });
    }

    // Org-admin-only branding: rename the workspace and/or set its logo.
    // logoUrl goes through the same sanitizer as profile/group avatars (must
    // be exactly this app's own /api/media/<uuid> shape), since it gets
    // interpolated client-side into a CSS url("...") the same way those do.
    if (request.method === 'POST' && url.pathname === '/org/update') {
      const { pinHash, orgId, name, logoUrl, allowEmailAuth, emailDomain, country } = await request.json();
      const me = await this.state.storage.get(`user:${pinHash}`);
      if (!me) return json({ error: 'not_registered' }, 401);
      if (!orgId || !(await hasOrgPermission(this.state.storage, orgId, me.id, 'manage_workspace'))) {
        return json({ error: 'forbidden' }, 403);
      }
      const org = await this.state.storage.get(`org:${orgId}`);
      if (!org) return json({ error: 'not_found' }, 404);
      if (typeof name === 'string' && name.trim()) org.name = name.trim().slice(0, 60);
      if (logoUrl !== undefined) org.logoUrl = sanitizeAvatarUrl(logoUrl);
      if (allowEmailAuth !== undefined) org.allowEmailAuth = !!allowEmailAuth;
      // Country drives the public-holidays calendar in People & HR (see
      // /org/holidays below), a 2-letter ISO 3166-1 code so it maps directly
      // onto the holidays API's own country codes with no translation layer.
      if (country !== undefined) org.country = country ? String(country).trim().toUpperCase().slice(0, 2) : null;
      // The domain is a global claim (whoever's it's set on decides who can
      // self-provision with a matching address), so it needs its own
      // uniqueness index the same way emailIndex does for individual
      // addresses, one workspace can't silently steal another's domain by
      // typing it into their own settings.
      if (emailDomain !== undefined) {
        const normalizedDomain = emailDomain ? String(emailDomain).trim().toLowerCase().replace(/^@/, '') : null;
        if (normalizedDomain && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(normalizedDomain)) {
          return json({ error: 'invalid_domain' }, 400);
        }
        if (normalizedDomain) {
          const claimedBy = await this.state.storage.get(`orgDomainIndex:${normalizedDomain}`);
          if (claimedBy && claimedBy !== org.id) return json({ error: 'domain_taken' }, 409);
        }
        if (org.emailDomain && org.emailDomain !== normalizedDomain) {
          const owner = await this.state.storage.get(`orgDomainIndex:${org.emailDomain}`);
          if (owner === org.id) await this.state.storage.delete(`orgDomainIndex:${org.emailDomain}`);
        }
        if (normalizedDomain) await this.state.storage.put(`orgDomainIndex:${normalizedDomain}`, org.id);
        org.emailDomain = normalizedDomain;
      }
      await this.state.storage.put(`org:${orgId}`, org);
      const changedFields = [
        name !== undefined && 'name', logoUrl !== undefined && 'logo', allowEmailAuth !== undefined && 'email sign-in',
        country !== undefined && 'country', emailDomain !== undefined && 'email domain',
      ].filter(Boolean);
      if (changedFields.length) {
        await appendAuditLog(this.state.storage, orgId, {
          actorId: me.id, actorName: me.displayName || 'Someone', action: 'workspace_settings_changed',
          details: `Updated: ${changedFields.join(', ')}`,
        });
      }
      return json({ org });
    }

    // Public holidays for the org's country, keyed off org.country (set via
    // /org/update above). Cached per country+year rather than fetched fresh
    // every time, a given year's public holidays for a country never change
    // once published, so there's no freshness concern with caching
    // indefinitely, this just avoids hammering the upstream API on every
    // People & HR Calendar tab open. Source: Nager.Holidays' free, keyless
    // public API (github.com/nager/Nager.Date), no account/billing involved.
    if (request.method === 'GET' && url.pathname === '/org-holidays') {
      const orgId = url.searchParams.get('orgId');
      const userId = url.searchParams.get('userId');
      const year = parseInt(url.searchParams.get('year'), 10) || new Date().getUTCFullYear();
      if (!orgId || !userId) return json({ error: 'missing_org_id' }, 400);
      if (!(await isOrgMember(this.state.storage, orgId, userId))) return json({ error: 'forbidden' }, 403);
      const org = await this.state.storage.get(`org:${orgId}`);
      if (!org) return json({ error: 'not_found' }, 404);
      if (!org.country) return json({ ok: true, country: null, holidays: [] });

      const cacheKey = `holidaysCache:${org.country}:${year}`;
      const cached = await this.state.storage.get(cacheKey);
      if (cached) return json({ ok: true, country: org.country, holidays: cached });

      try {
        const upstream = await fetch(`https://nagerholidays.com/api/v4/Holidays/${encodeURIComponent(org.country)}/${year}`);
        if (!upstream.ok) {
          // A 404 here means Nager.Holidays doesn't recognize this country
          // code for this year (unsupported country, or a typo'd code that
          // slipped past the client's dropdown), not a transient failure,
          // so this caches the empty result too rather than re-hitting the
          // upstream API on every load.
          await this.state.storage.put(cacheKey, []);
          return json({ ok: true, country: org.country, holidays: [], unsupported: upstream.status === 404 });
        }
        const raw = await upstream.json();
        const holidays = (Array.isArray(raw) ? raw : []).map(h => ({
          date: h.date,
          name: h.name,
          nationalHoliday: !!h.nationalHoliday,
        })).filter(h => h.date && h.name);
        await this.state.storage.put(cacheKey, holidays);
        return json({ ok: true, country: org.country, holidays });
      } catch (e) {
        // Upstream unreachable, don't cache a failure, next request just
        // tries again rather than getting stuck on an empty result forever.
        return json({ ok: true, country: org.country, holidays: [], fetchError: true });
      }
    }

    // ================= Self-service email verification =================
    // Lets an existing account attach a verified email address. Once set,
    // that address doubles as a magic-link sign-in credential (see
    // /auth/email/request below) alongside the PIN, never instead of it.
    if (request.method === 'POST' && url.pathname === '/account/email/request-code') {
      const { pinHash, email } = await request.json();
      const me = await this.state.storage.get(`user:${pinHash}`);
      if (!me) return json({ error: 'not_registered' }, 401);
      const normalized = (email || '').trim().toLowerCase();
      if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return json({ error: 'invalid_email' }, 400);

      const rl = await checkRateLimit(this.state.storage, `emailcode:${me.id}`, {
        maxAttempts: 8, windowMs: 15 * 60 * 1000, lockoutMs: 30 * 60 * 1000,
      });
      if (!rl.allowed) return json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, 429);

      const existingOwner = await this.state.storage.get(`emailIndex:${normalized}`);
      if (existingOwner && existingOwner !== me.id) return json({ error: 'email_taken' }, 409);

      const code = String(Math.floor(100000 + Math.random() * 900000));
      await this.state.storage.put(`emailVerify:${me.id}`, { email: normalized, code, expires: Date.now() + 15 * 60 * 1000 });
      const result = await sendVerificationCodeEmail(this.env, { to: normalized, name: me.displayName, code });
      return json({ ok: true, emailSent: result.sent, emailError: result.sent ? undefined : result.error });
    }

    if (request.method === 'POST' && url.pathname === '/account/email/confirm-code') {
      const { pinHash, code } = await request.json();
      const me = await this.state.storage.get(`user:${pinHash}`);
      if (!me) return json({ error: 'not_registered' }, 401);

      const rl = await checkRateLimit(this.state.storage, `emailcodeconfirm:${me.id}`, {
        maxAttempts: 10, windowMs: 15 * 60 * 1000, lockoutMs: 30 * 60 * 1000,
      });
      if (!rl.allowed) return json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, 429);

      const pending = await this.state.storage.get(`emailVerify:${me.id}`);
      if (!pending || Date.now() > pending.expires) return json({ error: 'code_expired' }, 400);
      if (String(code || '') !== pending.code) return json({ error: 'invalid_code' }, 400);

      // The address could've been claimed by someone else between request
      // and confirm, re-check right before committing rather than trusting
      // the check done at request time.
      const existingOwner = await this.state.storage.get(`emailIndex:${pending.email}`);
      if (existingOwner && existingOwner !== me.id) return json({ error: 'email_taken' }, 409);

      if (me.email && me.email !== pending.email) {
        const oldOwner = await this.state.storage.get(`emailIndex:${me.email}`);
        if (oldOwner === me.id) await this.state.storage.delete(`emailIndex:${me.email}`);
      }

      me.email = pending.email;
      await this.state.storage.put(`user:${pinHash}`, me);
      await this.state.storage.put(`emailIndex:${pending.email}`, me.id);
      await this.state.storage.delete(`emailVerify:${me.id}`);
      return json({ ok: true, email: me.email });
    }

    // ================= Magic-link sign-in =================
    // A second credential path alongside the PIN: prove control of a
    // verified email (or, for someone brand-new, a company email matching a
    // workspace's registered domain) and get back this account's pinHash,
    // the same thing typing the PIN into the unlock screen hands the
    // client. Deliberately a two-step request/confirm exchange rather than
    // the emailed link completing sign-in on GET, mail providers routinely
    // prefetch/scan links sitting in an inbox, which would silently burn a
    // single-use token before the real person ever clicks it.
    if (request.method === 'POST' && url.pathname === '/auth/email/request') {
      const { email, ip, origin } = await request.json();
      const normalized = (email || '').trim().toLowerCase();
      if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return json({ error: 'invalid_email' }, 400);

      const ipRl = await checkRateLimit(this.state.storage, `emaillink-ip:${ip || 'unknown'}`, {
        maxAttempts: 20, windowMs: 15 * 60 * 1000, lockoutMs: 30 * 60 * 1000,
      });
      if (!ipRl.allowed) return json({ error: 'rate_limited', retryAfterMs: ipRl.retryAfterMs }, 429);
      const addrRl = await checkRateLimit(this.state.storage, `emaillink-addr:${normalized}`, {
        maxAttempts: 5, windowMs: 15 * 60 * 1000, lockoutMs: 30 * 60 * 1000,
      });
      if (!addrRl.allowed) return json({ error: 'rate_limited', retryAfterMs: addrRl.retryAfterMs }, 429);

      const userId = await this.state.storage.get(`emailIndex:${normalized}`);
      // Deliberately NOT creating a new-account record here, only a request
      // for one. Anyone can POST an address they don't control (that's the
      // whole reason this is rate-limited), if the account/org-membership
      // were created right now, that alone would be enough to pollute a
      // workspace's roster with accounts nobody ever proved they could
      // actually receive mail at. Materializing the account is deferred to
      // /auth/email/confirm, which only ever runs off a token that came
      // from an email that actually reached this address.
      let pendingSignupOrgId = null;
      if (!userId) {
        const domain = normalized.split('@')[1] || '';
        const orgId = domain ? await this.state.storage.get(`orgDomainIndex:${domain}`) : null;
        const org = orgId ? await this.state.storage.get(`org:${orgId}`) : null;
        if (org && org.allowEmailAuth) pendingSignupOrgId = orgId;
      }

      // Always the same generic response either way, revealing whether an
      // address is registered (or domain-eligible) here would be a
      // user-enumeration oracle, the same thing already avoided at /contact
      // and /session.
      if (userId || pendingSignupOrgId) {
        const token = crypto.randomUUID() + crypto.randomUUID();
        const record = userId
          ? { userId, expires: Date.now() + 15 * 60 * 1000 }
          : { pendingSignupEmail: normalized, pendingSignupOrgId, expires: Date.now() + 15 * 60 * 1000 };
        await this.state.storage.put(`magicLink:${token}`, record);
        await sendMagicLinkEmail(this.env, { to: normalized, token, origin });
      }
      return json({ ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/auth/email/confirm') {
      const { token } = await request.json();
      if (!token) return json({ error: 'invalid_token' }, 400);
      const record = await this.state.storage.get(`magicLink:${token}`);
      // One-time use: delete on the very first read regardless of whether
      // it's still valid, a retried/duplicated confirm should never
      // succeed twice off the same token.
      if (record) await this.state.storage.delete(`magicLink:${token}`);
      if (!record || Date.now() > record.expires) return json({ error: 'invalid_or_expired_token' }, 400);

      let userId = record.userId;
      if (!userId && record.pendingSignupEmail) {
        // Clicking the link IS the proof of mailbox access this deferred,
        // create the account now, mirroring /org/roster's PIN-generation
        // pattern. Re-check the address hasn't been claimed in the
        // meantime (two links requested back-to-back, first one confirmed
        // already) rather than trusting the snapshot taken at request time.
        const existingOwner = await this.state.storage.get(`emailIndex:${record.pendingSignupEmail}`);
        if (existingOwner) {
          userId = existingOwner;
        } else {
          let pin = null, pinHashOut = null;
          for (let attempt = 0; attempt < 20; attempt++) {
            const candidate = String(Math.floor(1000000 + Math.random() * 9000000));
            const candidateHash = await sha256Hex(candidate);
            const existingUser = await this.state.storage.get(`user:${candidateHash}`);
            const existingRoster = await this.state.storage.get(`rosterByPin:${candidateHash}`);
            if (!existingUser && !existingRoster) { pin = candidate; pinHashOut = candidateHash; break; }
          }
          if (!pin) return json({ error: 'could_not_provision' }, 500);
          const newUser = {
            id: crypto.randomUUID(),
            pinHash: pinHashOut,
            displayName: record.pendingSignupEmail.split('@')[0].replace(/[._]+/g, ' ').trim().slice(0, 40) || null,
            department: null,
            avatarUrl: null,
            e2eePublicKey: null,
            deviceIds: [],
            email: record.pendingSignupEmail,
            // Freshly minted for this one sign-in, the client forces a real
            // PIN choice right after (see the client's forced-change flow
            // for any magic-link login), so this value is never actually
            // shown to anyone, it just satisfies the "every account has a
            // pinHash" invariant until it's immediately replaced.
            mustChangePin: true,
            pendingDeviceLink: null,
            createdAt: Date.now(),
          };
          await this.state.storage.put(`user:${pinHashOut}`, newUser);
          await this.state.storage.put(`userChats:${newUser.id}`, []);
          await this.state.storage.put(`userById:${newUser.id}`, userByIdSnapshot(newUser));
          await this.state.storage.put(`userIdToPinHash:${newUser.id}`, pinHashOut);
          await this.state.storage.put(`emailIndex:${record.pendingSignupEmail}`, newUser.id);
          await addUserToOrg(this.state.storage, record.pendingSignupOrgId, newUser.id);
          userId = newUser.id;
        }
      }
      if (!userId) return json({ error: 'invalid_or_expired_token' }, 400);

      const pinHash = await this.state.storage.get(`userIdToPinHash:${userId}`);
      const user = pinHash ? await this.state.storage.get(`user:${pinHash}`) : null;
      if (!user) return json({ error: 'account_not_found' }, 404);
      return json({ ok: true, pinHash });
    }

    if (request.method === 'POST' && url.pathname === '/org/invite') {
      const { pinHash, orgId, targetPinHash } = await request.json();
      const me = await this.state.storage.get(`user:${pinHash}`);
      if (!me) return json({ error: 'not_registered' }, 401);
      if (!orgId || !(await hasOrgPermission(this.state.storage, orgId, me.id, 'manage_members'))) {
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
      // Only an admin needs (or gets) each member's permission grants, this
      // is what feeds the toggle UI, a plain member doesn't need to see
      // anyone else's grants just to render a member list.
      const requesterIsAdmin = await isOrgAdmin(this.state.storage, orgId, me.id);
      const org = requesterIsAdmin ? await this.state.storage.get(`org:${orgId}`) : null;
      const orgAdmins = (org && org.admins) || [];
      const memberIds = (await this.state.storage.get(`orgMembers:${orgId}`)) || [];
      const members = [];
      for (const id of memberIds) {
        const rec = await this.state.storage.get(`userById:${id}`);
        if (!rec) continue;
        if (requesterIsAdmin) {
          members.push({ ...rec, isAdmin: orgAdmins.includes(id), permissions: await getEffectiveOrgPermissions(this.state.storage, orgId, id) });
        } else {
          members.push(rec);
        }
      }
      return json({ members });
    }

    // The caller's own effective permissions in this workspace, used
    // client-side to decide which admin-flavored UI (invite, HR editing,
    // workspace settings, starting the unlimited meeting) to even show.
    // Server-side routes never trust this, they each re-check
    // hasOrgPermission for themselves, this is purely a UI convenience.
    if (request.method === 'GET' && url.pathname === '/org/permissions') {
      const pinHash = url.searchParams.get('pinHash');
      const orgId = url.searchParams.get('orgId');
      const me = await this.state.storage.get(`user:${pinHash}`);
      if (!me) return json({ error: 'not_registered' }, 401);
      if (!orgId || !(await isOrgMember(this.state.storage, orgId, me.id))) return json({ error: 'forbidden' }, 403);
      const isAdmin = await isOrgAdmin(this.state.storage, orgId, me.id);
      const permissions = isAdmin ? ORG_PERMISSIONS.slice() : await getEffectiveOrgPermissions(this.state.storage, orgId, me.id);
      return json({ isAdmin, permissions });
    }

    // Admin-only: grant or revoke one specific permission for one member.
    // Deliberately isOrgAdmin, not hasOrgPermission, a member holding a
    // delegable permission still can't hand out permissions themselves
    // (including to themselves), only a real admin controls the matrix.
    if (request.method === 'POST' && url.pathname === '/org/permissions/set') {
      const { pinHash, orgId, targetUserId, permission, granted } = await request.json();
      const me = await this.state.storage.get(`user:${pinHash}`);
      if (!me) return json({ error: 'not_registered' }, 401);
      if (!orgId || !(await isOrgAdmin(this.state.storage, orgId, me.id))) return json({ error: 'forbidden' }, 403);
      if (!ORG_PERMISSIONS.includes(permission)) return json({ error: 'unknown_permission' }, 400);
      if (!targetUserId || !(await isOrgMember(this.state.storage, orgId, targetUserId))) {
        return json({ error: 'not_a_member' }, 400);
      }
      const key = `orgPermissions:${orgId}:${targetUserId}`;
      const current = (await this.state.storage.get(key)) || {};
      await this.state.storage.put(key, { ...current, [permission]: !!granted });
      const targetRec = await this.state.storage.get(`userById:${targetUserId}`);
      await appendAuditLog(this.state.storage, orgId, {
        actorId: me.id, actorName: me.displayName || 'Someone', action: granted ? 'permission_granted' : 'permission_revoked',
        details: `${permission} ${granted ? 'granted to' : 'revoked from'} ${targetRec ? targetRec.displayName : 'someone'}`,
      });
      return json({ ok: true, permissions: await getEffectiveOrgPermissions(this.state.storage, orgId, targetUserId) });
    }

    // Real-admin-only, deliberately isOrgAdmin rather than any delegable
    // permission — seeing every change across billing/roles/HR in one feed
    // is a different, higher-trust thing than being allowed to make any one
    // of those changes yourself (someone with just manage_hr shouldn't
    // thereby also see every workspace-settings/permission change). Newest
    // first, capped at AUDIT_LOG_MAX_ENTRIES total (see appendAuditLog).
    if (request.method === 'GET' && url.pathname === '/org/audit-log') {
      const pinHash = url.searchParams.get('pinHash');
      const orgId = url.searchParams.get('orgId');
      const me = await this.state.storage.get(`user:${pinHash}`);
      if (!me) return json({ error: 'not_registered' }, 401);
      if (!orgId || !(await isOrgAdmin(this.state.storage, orgId, me.id))) return json({ error: 'forbidden' }, 403);
      const log = (await this.state.storage.get(`auditLog:${orgId}`)) || [];
      return json({ entries: log.slice().reverse() });
    }

    // Cheap membership check for the outer worker to call before letting a
    // client into a workspace-gated resource (currently: the unlimited/
    // recording+AI Meeting Room). Doesn't need pinHash to belong to an
    // admin, any org member can confirm their own membership, that's all
    // this is checking.
    if (request.method === 'GET' && url.pathname === '/org-member-check') {
      const pinHash = url.searchParams.get('pinHash');
      const orgId = url.searchParams.get('orgId');
      const permission = url.searchParams.get('permission') || null;
      const me = await this.state.storage.get(`user:${pinHash}`);
      if (!me || !orgId) return json({ ok: false });
      // With a `permission` param this checks a specific delegable grant
      // (admins always pass), otherwise it's the plain "are they in this
      // workspace at all" check other callers already relied on.
      const ok = permission
        ? await hasOrgPermission(this.state.storage, orgId, me.id, permission)
        : await isOrgMember(this.state.storage, orgId, me.id);
      return json({ ok });
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
      if (!orgId || !(await hasOrgPermission(this.state.storage, orgId, me.id, 'manage_members'))) {
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

    // ==================== Arrivo People (HR module, Phase 1) ====================
    if (request.method === 'GET' && url.pathname === '/org/hr/profile') {
      const pinHash = url.searchParams.get('pinHash');
      const orgId = url.searchParams.get('orgId');
      const targetUserId = url.searchParams.get('targetUserId') || null;
      const me = await this.state.storage.get(`user:${pinHash}`);
      if (!me) return json({ error: 'not_registered' }, 401);
      if (!orgId || !(await isOrgMember(this.state.storage, orgId, me.id))) return json({ error: 'forbidden' }, 403);
      const viewingSelf = !targetUserId || targetUserId === me.id;
      const isAdmin = await hasOrgPermission(this.state.storage, orgId, me.id, 'manage_hr');
      // Anyone in the org can look someone up via the People directory (that's
      // the whole point of it), but a plain colleague only ever gets the
      // "public" fields the directory/org-chart are meant to show, not the
      // full record, per the access-control matrix (address, national ID,
      // personal contact info, DOB are self/HR-only).
      let employee = await getEmployee(this.state.storage, orgId, targetUserId || me.id);
      if (!viewingSelf && !isAdmin) {
        employee = {
          orgId, userId: employee.userId,
          personal: {
            firstName: employee.personal.firstName, lastName: employee.personal.lastName,
            preferredName: employee.personal.preferredName, officeLocation: employee.personal.officeLocation,
            middleName: null, dob: null, gender: null, maritalStatus: null, nationalId: null,
            homeAddress: { street: null, city: null, state: null, postal: null, country: null },
            workPhone: null, personalMobile: null, personalEmail: null, employmentType: null,
          },
          hireDate: null,
          job: { current: employee.job.current, history: [] },
          // Never shown to a colleague, only self or HR — stricter than job
          // title/department, which the redacted branch above still passes
          // through since the directory/org chart intentionally show those.
          compensation: null,
        };
      }
      return json({ employee, canEditJob: isAdmin, isSelf: viewingSelf });
    }

    if (request.method === 'POST' && url.pathname === '/org/hr/profile') {
      const { pinHash, orgId, targetUserId, personal, job, hireDate, compensation } = await request.json();
      const me = await this.state.storage.get(`user:${pinHash}`);
      if (!me) return json({ error: 'not_registered' }, 401);
      if (!orgId || !(await isOrgMember(this.state.storage, orgId, me.id))) return json({ error: 'forbidden' }, 403);
      const isAdmin = await hasOrgPermission(this.state.storage, orgId, me.id, 'manage_hr');
      const uid = targetUserId || me.id;
      const editingSelf = uid === me.id;
      if (!editingSelf && !isAdmin) return json({ error: 'forbidden' }, 403);
      const employee = await getEmployee(this.state.storage, orgId, uid);

      // Self-service fields any employee can edit for themselves; HR (org
      // admin) can edit these for anyone. Job history, hire date,
      // employment type, and national ID are HR-only per the access matrix.
      if (personal && typeof personal === 'object') {
        const selfEditable = ['firstName', 'middleName', 'lastName', 'preferredName', 'dob', 'gender', 'maritalStatus', 'homeAddress', 'workPhone', 'personalMobile', 'personalEmail', 'officeLocation'];
        const hrOnly = ['nationalId', 'employmentType'];
        for (const k of selfEditable) if (k in personal) employee.personal[k] = personal[k];
        if (isAdmin) for (const k of hrOnly) if (k in personal) employee.personal[k] = personal[k];
      }
      if (job && typeof job === 'object' && isAdmin) {
        if (job.current) {
          employee.job.history.unshift(employee.job.current);
          employee.job.current = { effectiveDate: Date.now(), entity: job.current.entity || null, department: job.current.department || null, jobTitle: job.current.jobTitle || null, managerId: job.current.managerId || null };
        }
      }
      // HR-only to touch at all — unlike job/personal fields, this has no
      // self-service path even for editingSelf, nobody sets their own
      // salary. Same history-tracking shape as job.current/job.history so a
      // raise shows up as a dated record, not a value silently overwritten.
      if (compensation && typeof compensation === 'object' && isAdmin) {
        if (compensation.current) {
          if (!employee.compensation) employee.compensation = emptyCompensation(employee.hireDate || Date.now());
          employee.compensation.history.unshift(employee.compensation.current);
          const baseSalaryNum = Number(compensation.current.baseSalary);
          employee.compensation.current = {
            effectiveDate: Date.now(),
            baseSalary: Number.isFinite(baseSalaryNum) ? baseSalaryNum : null,
            currency: compensation.current.currency ? String(compensation.current.currency).trim().toUpperCase().slice(0, 3) : null,
            payFrequency: compensation.current.payFrequency || null,
          };
        }
      }
      // Hire date drives tenure/accrual math, changing it retroactively
      // affects both balance calculations, HR-only for exactly that reason.
      if (isAdmin && hireDate){
        const parsed = new Date(hireDate).getTime();
        if (!isNaN(parsed)) employee.hireDate = parsed;
      }
      employee.updatedAt = Date.now();
      await this.state.storage.put(`employee:${orgId}:${uid}`, employee);
      const targetRec = await this.state.storage.get(`userById:${uid}`);
      // Compensation gets its own, always-logged entry (even on one's own
      // record, though that path shouldn't come up often) — this is the
      // single most sensitive kind of change in the whole HR module, worth
      // a distinct, unmissable label rather than folding into the generic
      // "edited a profile" line below.
      if (compensation && compensation.current && isAdmin) {
        await appendAuditLog(this.state.storage, orgId, {
          actorId: me.id, actorName: me.displayName || 'Someone', action: 'compensation_changed',
          details: `Recorded a compensation change for ${targetRec ? targetRec.displayName : 'someone'}`,
        });
      }
      // Only log HR acting on someone ELSE's record — every employee editing
      // their own contact details would flood this with routine self-service
      // noise that isn't what an admin reviewing "who changed HR data"
      // actually wants to see.
      if (!editingSelf) {
        await appendAuditLog(this.state.storage, orgId, {
          actorId: me.id, actorName: me.displayName || 'Someone', action: 'hr_profile_edited',
          details: `Edited ${targetRec ? targetRec.displayName : 'someone'}'s HR profile${job && job.current ? ' (recorded a job change)' : ''}`,
        });
      }
      return json({ employee });
    }

    // People directory: photo/name/title/department only, never the
    // sensitive fields (address, emergency contact, compensation aren't
    // even modeled yet in Phase 1), matching the access-control matrix.
    if (request.method === 'GET' && url.pathname === '/org/hr/directory') {
      const pinHash = url.searchParams.get('pinHash');
      const orgId = url.searchParams.get('orgId');
      const me = await this.state.storage.get(`user:${pinHash}`);
      if (!me) return json({ error: 'not_registered' }, 401);
      if (!orgId || !(await isOrgMember(this.state.storage, orgId, me.id))) return json({ error: 'forbidden' }, 403);
      const memberIds = (await this.state.storage.get(`orgMembers:${orgId}`)) || [];
      const rows = [];
      for (const id of memberIds) {
        const userRec = await this.state.storage.get(`userById:${id}`);
        if (!userRec) continue;
        const employee = await getEmployee(this.state.storage, orgId, id);
        rows.push({
          userId: id, displayName: userRec.displayName, avatarUrl: userRec.avatarUrl || null,
          jobTitle: employee.job.current.jobTitle || null, department: employee.job.current.department || null,
          managerId: employee.job.current.managerId || null,
        });
      }
      return json({ members: rows });
    }

    // ---- Compliance data export ----
    // Returns CSV text inside a normal JSON envelope (not a raw CSV response)
    // so this goes through the exact same apiFetch() every other endpoint
    // in this app already uses — the client turns the string into a Blob
    // and triggers a real file download from there, see the HR overlay's
    // Export buttons. manage_hr-gated: this is the single widest-reaching
    // read of personal data in the whole HR module, full names, addresses,
    // national IDs, DOB all in one file, same bar as viewing any one
    // person's full profile already required.
    if (request.method === 'GET' && url.pathname === '/org/hr/export/employees') {
      const pinHash = url.searchParams.get('pinHash');
      const orgId = url.searchParams.get('orgId');
      const me = await this.state.storage.get(`user:${pinHash}`);
      if (!me) return json({ error: 'not_registered' }, 401);
      if (!orgId || !(await hasOrgPermission(this.state.storage, orgId, me.id, 'manage_hr'))) {
        return json({ error: 'forbidden' }, 403);
      }
      const memberIds = (await this.state.storage.get(`orgMembers:${orgId}`)) || [];
      const header = [
        'User ID', 'Display Name', 'First Name', 'Middle Name', 'Last Name', 'Preferred Name',
        'Date of Birth', 'Gender', 'Marital Status', 'National ID', 'Work Phone', 'Personal Mobile',
        'Personal Email', 'Office Location', 'Street', 'City', 'State/Region', 'Postal Code', 'Country',
        'Employment Type', 'Hire Date', 'Job Title', 'Department', 'Entity/Office', 'Manager',
        'Base Salary', 'Currency', 'Pay Frequency',
      ];
      const rows = [header];
      const namesById = new Map();
      for (const id of memberIds) {
        const userRec = await this.state.storage.get(`userById:${id}`);
        if (userRec) namesById.set(id, userRec.displayName);
      }
      for (const id of memberIds) {
        const userRec = await this.state.storage.get(`userById:${id}`);
        if (!userRec) continue;
        const emp = await getEmployee(this.state.storage, orgId, id);
        const p = emp.personal;
        const cur = emp.job.current;
        rows.push([
          id, userRec.displayName, p.firstName, p.middleName, p.lastName, p.preferredName,
          p.dob ? new Date(p.dob).toISOString().slice(0, 10) : '', p.gender, p.maritalStatus, p.nationalId,
          p.workPhone, p.personalMobile, p.personalEmail, p.officeLocation,
          p.homeAddress.street, p.homeAddress.city, p.homeAddress.state, p.homeAddress.postal, p.homeAddress.country,
          p.employmentType, emp.hireDate ? new Date(emp.hireDate).toISOString().slice(0, 10) : '',
          cur.jobTitle, cur.department, cur.entity, cur.managerId ? (namesById.get(cur.managerId) || cur.managerId) : '',
          emp.compensation.current.baseSalary, emp.compensation.current.currency, emp.compensation.current.payFrequency,
        ]);
      }
      await appendAuditLog(this.state.storage, orgId, {
        actorId: me.id, actorName: me.displayName || 'Someone', action: 'hr_data_exported',
        details: `Exported employee records (${memberIds.length} people)`,
      });
      return json({ ok: true, csv: toCsv(rows), filename: `hr-employees-${orgId}.csv` });
    }

    if (request.method === 'GET' && url.pathname === '/org/hr/export/leave') {
      const pinHash = url.searchParams.get('pinHash');
      const orgId = url.searchParams.get('orgId');
      const me = await this.state.storage.get(`user:${pinHash}`);
      if (!me) return json({ error: 'not_registered' }, 401);
      if (!orgId || !(await hasOrgPermission(this.state.storage, orgId, me.id, 'manage_hr'))) {
        return json({ error: 'forbidden' }, 403);
      }
      const ids = (await this.state.storage.get(`leaveRequestIds:${orgId}`)) || [];
      const header = ['Employee', 'Type', 'Start Date', 'End Date', 'Half Day', 'Days', 'Status', 'Reason', 'Requested At', 'Decided By', 'Decided At', 'Comment'];
      const rows = [header];
      for (const rid of ids) {
        const reqRec = await this.state.storage.get(`leaveRequest:${orgId}:${rid}`);
        if (!reqRec) continue;
        const requesterRec = await this.state.storage.get(`userById:${reqRec.userId}`);
        const deciderRec = reqRec.decidedBy ? await this.state.storage.get(`userById:${reqRec.decidedBy}`) : null;
        rows.push([
          requesterRec ? requesterRec.displayName : reqRec.userId, reqRec.type, reqRec.startDate, reqRec.endDate,
          reqRec.halfDay ? 'Yes' : 'No', reqRec.days, reqRec.status, reqRec.reason || '',
          new Date(reqRec.createdAt).toISOString(), deciderRec ? deciderRec.displayName : '',
          reqRec.decidedAt ? new Date(reqRec.decidedAt).toISOString() : '', reqRec.comment || '',
        ]);
      }
      await appendAuditLog(this.state.storage, orgId, {
        actorId: me.id, actorName: me.displayName || 'Someone', action: 'hr_data_exported',
        details: `Exported leave request history (${ids.length} requests)`,
      });
      return json({ ok: true, csv: toCsv(rows), filename: `leave-history-${orgId}.csv` });
    }

    // Home dashboard: own leave balances/upcoming leave, plus org-wide
    // celebrations, who's out, and welcome-new-hires widgets.
    if (request.method === 'GET' && url.pathname === '/org/hr/home') {
      const pinHash = url.searchParams.get('pinHash');
      const orgId = url.searchParams.get('orgId');
      const me = await this.state.storage.get(`user:${pinHash}`);
      if (!me) return json({ error: 'not_registered' }, 401);
      if (!orgId || !(await isOrgMember(this.state.storage, orgId, me.id))) return json({ error: 'forbidden' }, 403);

      const myEmployee = await getEmployee(this.state.storage, orgId, me.id);
      const myLedger = await getLeaveLedger(this.state.storage, orgId, me.id);
      const entitlements = await getOrgLeaveEntitlements(this.state.storage, orgId);
      const balances = {
        annual: computeLeaveBalance(myLedger, 'annual', myEmployee.hireDate, entitlements),
        sick: computeLeaveBalance(myLedger, 'sick', myEmployee.hireDate, entitlements),
      };
      const isHrAdmin = await hasOrgPermission(this.state.storage, orgId, me.id, 'manage_hr');

      const memberIds = (await this.state.storage.get(`orgMembers:${orgId}`)) || [];
      const now = Date.now();
      const in30Days = now + 30 * 24 * 60 * 60 * 1000;
      const celebrations = [];
      const newHires = [];
      const nowDate = new Date(now);

      for (const id of memberIds) {
        const userRec = await this.state.storage.get(`userById:${id}`);
        if (!userRec) continue;
        const employee = await getEmployee(this.state.storage, orgId, id);
        // Birthdays and work anniversaries: next occurrence of the
        // month/day, whether that's later this year or wraps into next.
        for (const [dateField, label] of [[employee.personal.dob, 'birthday'], [employee.hireDate, 'anniversary']]) {
          if (!dateField) continue;
          const d = new Date(dateField);
          let next = new Date(Date.UTC(nowDate.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
          if (next.getTime() < now - 24 * 60 * 60 * 1000) next = new Date(Date.UTC(nowDate.getUTCFullYear() + 1, d.getUTCMonth(), d.getUTCDate()));
          if (next.getTime() <= in30Days) {
            celebrations.push({
              userId: id, displayName: userRec.displayName, avatarUrl: userRec.avatarUrl || null,
              type: label, date: next.getTime(),
              years: label === 'anniversary' ? next.getUTCFullYear() - d.getUTCFullYear() : null,
            });
          }
        }
        if (userRec.hasOwnProperty('_placeholder')) continue; // never set, keeps this branch harmless if fields shift later
        const hireD = new Date(employee.hireDate);
        if (hireD.getUTCFullYear() === nowDate.getUTCFullYear() && hireD.getUTCMonth() === nowDate.getUTCMonth()) {
          newHires.push({ userId: id, displayName: userRec.displayName, avatarUrl: userRec.avatarUrl || null, hireDate: employee.hireDate });
        }
      }
      celebrations.sort((a, b) => a.date - b.date);

      // Who's out: anyone with an approved leave request overlapping today.
      const requestIds = (await this.state.storage.get(`leaveRequestIds:${orgId}`)) || [];
      const todayStr = new Date(now).toISOString().slice(0, 10);
      const whosOut = [];
      const myUpcoming = [];
      for (const rid of requestIds) {
        const reqRec = await this.state.storage.get(`leaveRequest:${orgId}:${rid}`);
        if (!reqRec || reqRec.status !== 'approved') continue;
        if (reqRec.startDate <= todayStr && reqRec.endDate >= todayStr) {
          const userRec = await this.state.storage.get(`userById:${reqRec.userId}`);
          whosOut.push({ userId: reqRec.userId, displayName: userRec ? userRec.displayName : 'Someone', avatarUrl: userRec ? userRec.avatarUrl : null, type: reqRec.type, endDate: reqRec.endDate });
        }
        if (reqRec.userId === me.id && reqRec.endDate >= todayStr) {
          myUpcoming.push({ id: reqRec.id, type: reqRec.type, startDate: reqRec.startDate, endDate: reqRec.endDate });
        }
      }
      myUpcoming.sort((a, b) => (a.startDate < b.startDate ? -1 : 1));

      return json({ balances, celebrations, whosOut, newHires, myUpcoming: myUpcoming.slice(0, 5), isHrAdmin, entitlements });
    }

    // Time-off policy config: how many annual/sick days a year this org
    // grants, replacing what used to be a flat 20/10 hardcoded for every
    // workspace (see DEFAULT_LEAVE_ENTITLEMENTS, still the default here for
    // anyone who's never touched this). manage_hr-gated rather than folded
    // into /org/update's manage_workspace gate — this is HR policy, not
    // workspace branding, and the only UI for it lives inside People & HR.
    if (request.method === 'POST' && url.pathname === '/org/hr/entitlements') {
      const { pinHash, orgId, annual, sick } = await request.json();
      const me = await this.state.storage.get(`user:${pinHash}`);
      if (!me) return json({ error: 'not_registered' }, 401);
      if (!orgId || !(await hasOrgPermission(this.state.storage, orgId, me.id, 'manage_hr'))) {
        return json({ error: 'forbidden' }, 403);
      }
      const org = await this.state.storage.get(`org:${orgId}`);
      if (!org) return json({ error: 'not_found' }, 404);
      const annualNum = Number(annual);
      const sickNum = Number(sick);
      if (!Number.isFinite(annualNum) || annualNum < 0 || annualNum > 365) return json({ error: 'invalid_annual' }, 400);
      if (!Number.isFinite(sickNum) || sickNum < 0 || sickNum > 365) return json({ error: 'invalid_sick' }, 400);
      org.annualEntitlement = annualNum;
      org.sickEntitlement = sickNum;
      await this.state.storage.put(`org:${orgId}`, org);
      await appendAuditLog(this.state.storage, orgId, {
        actorId: me.id, actorName: me.displayName || 'Someone', action: 'leave_policy_changed',
        details: `Annual leave set to ${annualNum}/yr, sick leave set to ${sickNum}/yr`,
      });
      return json({ ok: true, entitlements: { annual: annualNum, sick: sickNum } });
    }

    if (request.method === 'POST' && url.pathname === '/org/hr/leave/request') {
      const { pinHash, orgId, type, startDate, endDate, halfDay, reason } = await request.json();
      const me = await this.state.storage.get(`user:${pinHash}`);
      if (!me) return json({ error: 'not_registered' }, 401);
      if (!orgId || !(await isOrgMember(this.state.storage, orgId, me.id))) return json({ error: 'forbidden' }, 403);
      if (!['annual', 'sick'].includes(type)) return json({ error: 'invalid_type' }, 400);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(endDate || '')) {
        return json({ error: 'invalid_dates' }, 400);
      }
      const days = daysBetweenInclusive(startDate, endDate, !!halfDay);
      if (days <= 0) return json({ error: 'invalid_dates' }, 400);

      const employee = await getEmployee(this.state.storage, orgId, me.id);
      const ledger = await getLeaveLedger(this.state.storage, orgId, me.id);
      const entitlements = await getOrgLeaveEntitlements(this.state.storage, orgId);
      const currentBalance = computeLeaveBalance(ledger, type, employee.hireDate, entitlements);
      if (days > currentBalance) return json({ error: 'insufficient_balance', balance: currentBalance }, 400);

      const id = crypto.randomUUID();
      const reqRec = {
        id, orgId, userId: me.id, type, startDate, endDate, halfDay: !!halfDay, days,
        reason: (reason || '').toString().slice(0, 500),
        status: 'pending', createdAt: Date.now(), decidedAt: null, decidedBy: null, comment: null,
      };
      await this.state.storage.put(`leaveRequest:${orgId}:${id}`, reqRec);
      const ids = (await this.state.storage.get(`leaveRequestIds:${orgId}`)) || [];
      await this.state.storage.put(`leaveRequestIds:${orgId}`, [...ids, id]);

      // Notify whoever can actually see this in their inbox: real org admins,
      // AND anyone individually granted manage_hr (see hasOrgPermission —
      // org.admins alone misses that second group, they'd never hear about a
      // request they're fully able to decide), plus the requester's direct
      // manager, if set, reusing the same per-user push/in-app channel 1:1
      // calls use.
      const memberIds = (await this.state.storage.get(`orgMembers:${orgId}`)) || [];
      const notifyTargets = new Set();
      for (const uid of memberIds) {
        if (await hasOrgPermission(this.state.storage, orgId, uid, 'manage_hr')) notifyTargets.add(uid);
      }
      if (employee.job.current.managerId) notifyTargets.add(employee.job.current.managerId);
      notifyTargets.delete(me.id);
      if (this.env.USER_CHANNEL) {
        const payload = JSON.stringify({ title: 'PArA PIN', body: `${me.displayName || 'Someone'} requested ${type === 'sick' ? 'sick' : 'annual'} leave (${days}d)`, chatId: null });
        for (const targetId of notifyTargets) {
          try { await this.env.USER_CHANNEL.get(this.env.USER_CHANNEL.idFromName(targetId)).fetch('https://internal/push-direct', { method: 'POST', body: payload }); } catch (e) {}
        }
      }
      return json({ request: reqRec });
    }

    // Pending requests visible to the caller: org admins (HR) see every
    // pending request; a line manager sees only their own reports'.
    if (request.method === 'GET' && url.pathname === '/org/hr/leave/inbox') {
      const pinHash = url.searchParams.get('pinHash');
      const orgId = url.searchParams.get('orgId');
      const me = await this.state.storage.get(`user:${pinHash}`);
      if (!me) return json({ error: 'not_registered' }, 401);
      if (!orgId || !(await isOrgMember(this.state.storage, orgId, me.id))) return json({ error: 'forbidden' }, 403);
      const isAdmin = await hasOrgPermission(this.state.storage, orgId, me.id, 'manage_hr');
      const ids = (await this.state.storage.get(`leaveRequestIds:${orgId}`)) || [];
      const out = [];
      for (const rid of ids) {
        const reqRec = await this.state.storage.get(`leaveRequest:${orgId}:${rid}`);
        if (!reqRec || reqRec.status !== 'pending') continue;
        let visible = isAdmin;
        if (!visible) {
          const requesterEmployee = await getEmployee(this.state.storage, orgId, reqRec.userId);
          visible = requesterEmployee.job.current.managerId === me.id;
        }
        if (!visible) continue;
        const userRec = await this.state.storage.get(`userById:${reqRec.userId}`);
        out.push({ ...reqRec, displayName: userRec ? userRec.displayName : 'Someone', avatarUrl: userRec ? userRec.avatarUrl : null });
      }
      return json({ requests: out });
    }

    if (request.method === 'POST' && url.pathname.match(/^\/org\/hr\/leave\/[^/]+\/decide$/)) {
      const requestId = url.pathname.split('/')[4];
      const { pinHash, orgId, decision, comment } = await request.json();
      const me = await this.state.storage.get(`user:${pinHash}`);
      if (!me) return json({ error: 'not_registered' }, 401);
      if (!orgId || !(await isOrgMember(this.state.storage, orgId, me.id))) return json({ error: 'forbidden' }, 403);
      if (!['approve', 'decline'].includes(decision)) return json({ error: 'invalid_decision' }, 400);
      const reqRec = await this.state.storage.get(`leaveRequest:${orgId}:${requestId}`);
      if (!reqRec) return json({ error: 'not_found' }, 404);
      if (reqRec.status !== 'pending') return json({ error: 'already_decided' }, 400);

      const isAdmin = await hasOrgPermission(this.state.storage, orgId, me.id, 'manage_hr');
      let allowed = isAdmin;
      if (!allowed) {
        const requesterEmployee = await getEmployee(this.state.storage, orgId, reqRec.userId);
        allowed = requesterEmployee.job.current.managerId === me.id;
      }
      if (!allowed) return json({ error: 'forbidden' }, 403);

      reqRec.status = decision === 'approve' ? 'approved' : 'declined';
      reqRec.decidedAt = Date.now();
      reqRec.decidedBy = me.id;
      reqRec.comment = (comment || '').toString().slice(0, 500) || null;
      await this.state.storage.put(`leaveRequest:${orgId}:${requestId}`, reqRec);

      if (decision === 'approve') {
        await appendLeaveLedger(this.state.storage, orgId, reqRec.userId, {
          type: reqRec.type, delta: -reqRec.days, kind: 'used',
          note: `${reqRec.startDate} to ${reqRec.endDate}${reqRec.halfDay ? ' (half day)' : ''}`,
          requestId: reqRec.id,
        });
      }

      {
        const requesterRec = await this.state.storage.get(`userById:${reqRec.userId}`);
        await appendAuditLog(this.state.storage, orgId, {
          actorId: me.id, actorName: me.displayName || 'Someone', action: `leave_${reqRec.status}`,
          details: `${reqRec.status === 'approved' ? 'Approved' : 'Declined'} ${requesterRec ? requesterRec.displayName : 'someone'}'s ${reqRec.type} leave (${reqRec.startDate} to ${reqRec.endDate})`,
        });
      }

      if (this.env.USER_CHANNEL) {
        const payload = JSON.stringify({
          title: 'PArA PIN',
          body: `Your ${reqRec.type === 'sick' ? 'sick' : 'annual'} leave request was ${reqRec.status}${reqRec.comment ? `: ${reqRec.comment}` : ''}`,
          chatId: null,
        });
        try { await this.env.USER_CHANNEL.get(this.env.USER_CHANNEL.idFromName(reqRec.userId)).fetch('https://internal/push-direct', { method: 'POST', body: payload }); } catch (e) {}
      }
      return json({ request: reqRec });
    }

    // History table: ledger rows (accruals/usage/adjustments) merged with
    // the request that caused each usage row, sorted newest first, with a
    // running balance column computed left-to-right in chronological order.
    if (request.method === 'GET' && url.pathname === '/org/hr/leave/history') {
      const pinHash = url.searchParams.get('pinHash');
      const orgId = url.searchParams.get('orgId');
      const targetUserId = url.searchParams.get('targetUserId') || null;
      const me = await this.state.storage.get(`user:${pinHash}`);
      if (!me) return json({ error: 'not_registered' }, 401);
      if (!orgId || !(await isOrgMember(this.state.storage, orgId, me.id))) return json({ error: 'forbidden' }, 403);
      const uid = targetUserId || me.id;
      if (uid !== me.id && !(await hasOrgPermission(this.state.storage, orgId, me.id, 'manage_hr'))) return json({ error: 'forbidden' }, 403);

      const employee = await getEmployee(this.state.storage, orgId, uid);
      const ledger = (await getLeaveLedger(this.state.storage, orgId, uid)).slice().sort((a, b) => a.ts - b.ts);
      let runningAnnual = 0;
      let runningSick = 0;
      const rows = ledger.map((e) => {
        if (e.type === 'annual') runningAnnual += e.delta; else runningSick += e.delta;
        return { ...e, runningBalance: e.type === 'annual' ? runningAnnual : runningSick };
      }).reverse();
      return json({ rows, hireDate: employee.hireDate });
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
          // DMs put the sender's own name in the title (and their photo as
          // the icon, see avatarUrl below), same as a phone's native "from a
          // contact" notification, instead of a flat "PArA PIN" title with
          // the name buried in the body. Groups keep the group name as the
          // title (there's no single "contact" it's from) and name the
          // sender in the body instead.
          const title = data.chatType === 'group' ? (data.chatName || 'Group') : senderLabel;
          const body = data.chatType === 'group' ? `${senderLabel} sent a message` : 'Sent you a message';
          const pushPayload = { title, body, chatId: data.chatId, avatarUrl: data.message.fromAvatarUrl || null };
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
      //
      // A missed call also gets pushed here, since a PWA has no way to add
      // an entry to the phone's actual native call log, this is the closest
      // real substitute: a genuine OS notification even if this device
      // never had the app open at all while it rang. The tricky part is
      // that the *same* 'end'/'no-answer' signal shape gets sent by
      // whichever side's own 30s ring timeout fires first (see
      // startOutgoingCall/declineCall in index.html), so `direction` (that
      // OTHER user's role in the call) is what disambiguates: only push
      // here when the sender's direction was 'outgoing', i.e. the caller
      // gave up waiting, which means the recipient of THIS signal (this DO)
      // is the callee who genuinely missed it. If the callee's own timeout
      // fired first instead, direction is 'incoming' and no push happens,
      // the caller doesn't need a "missed call" alert about their own call.
      const isMissedCall = data && data.signal && data.signal.kind === 'end'
        && data.signal.reason === 'no-answer' && data.signal.direction === 'outgoing';
      if (data && data.type === 'call-signal' && data.signal && (data.signal.kind === 'offer' || data.signal.kind === 'meeting-invite' || isMissedCall)) {
        const subs = (await this.state.storage.get('pushSubs')) || [];
        if (subs.length) {
          let pushPayload;
          if (data.signal.kind === 'meeting-invite') {
            pushPayload = {
              title: 'PArA PIN',
              body: `${data.signal.fromName || 'Someone'} started a meeting${data.signal.meetingName ? `: ${data.signal.meetingName}` : ''}`,
              chatId: null,
            };
          } else if (isMissedCall) {
            pushPayload = {
              title: 'PArA PIN',
              body: `Missed ${data.signal.video ? 'video ' : ''}call from ${data.signal.fromName || 'Someone'}`,
              chatId: null,
            };
          } else {
            pushPayload = {
              title: 'PArA PIN',
              body: `Incoming call from ${data.signal.fromName || 'Someone'}`,
              chatId: null,
            };
          }
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
      const { fromUserId, fromName, fromAvatarUrl, ciphertext, iv, alg, attachment, replyTo, protected: isProtected } = await request.json();
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
        fromAvatarUrl: fromAvatarUrl || null,
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
      // `cap` is set by the outer worker (see /api/meeting/room/ws), never
      // taken from anything the client itself could set directly, real
      // workspace membership was already verified there. 0 = unlimited.
      // This is the one place that actually knows the live session count,
      // so it's the one place that can enforce it for real rather than
      // just hiding a button.
      const cap = parseInt(url.searchParams.get('cap') || '0', 10);
      if (cap > 0 && this.sessions.size >= cap) {
        return json({ error: 'meeting_full', cap }, 403);
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();

      const userId = url.searchParams.get('userId') || null;
      const name = url.searchParams.get('name') || 'Someone';
      const avatarUrl = url.searchParams.get('avatarUrl') || null;
      // Server-verified (by the outer worker, never client-supplied) orgId
      // for this specific join, relayed straight back below so the client's
      // Record/AI UI reacts to what actually got verified, not its own
      // guess at connect time.
      const verifiedOrgId = url.searchParams.get('verifiedOrgId') || null;
      const me = { userId, name, avatarUrl, sfuSessionId: null, tracks: new Map() };
      this.sessions.set(server, me);

      // Bring the new joiner up to speed on who's already here (including
      // their published tracks), then tell everyone else about the new face.
      try {
        server.send(JSON.stringify({ type: 'roster', participants: this.roster().filter((p) => p.userId !== userId), verifiedOrgId }));
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

        // Pure presence relay, no storage here, the room doesn't need to
        // remember "is someone recording" across a reconnect. This just lets
        // every participant's client show a live "Recording" indicator the
        // instant anyone starts or stops, same trust level as any other
        // presence event (whoever's in the room can see it happening).
        if (data.type === 'recording-started') {
          this.broadcast(JSON.stringify({ type: 'recording-started', userId, name }), server);
          return;
        }
        if (data.type === 'recording-stopped') {
          this.broadcast(JSON.stringify({ type: 'recording-stopped', userId }), server);
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
        // PArA Premium's tangible perk today: a real bump in how big a
        // single upload can be, everything else in the Premium column
        // (cloud backup, AI, themes) is still just a status flag until those
        // features actually exist to gate.
        const isPremium = ['active', 'lifetime'].includes(who.premiumStatus);
        const MAX_BYTES = (isPremium ? 100 : 20) * 1024 * 1024;
        if (buf.byteLength === 0) return json({ error: 'empty' }, 400);
        if (buf.byteLength > MAX_BYTES) return json({ error: 'too_large', maxBytes: MAX_BYTES }, 413);

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

      // AI meeting assistant: takes a previously-uploaded audio recording
      // (the client mixes down local mic + every remote participant's track
      // into one file, see recordMeetingAudio in index.html) and returns a
      // transcript + summary + action items. The recording itself is NOT
      // end-to-end encrypted like chat messages are, deliberately, this
      // matches the existing trust model of a group meeting: Cloudflare's
      // Realtime SFU already terminates and re-routes everyone's media in
      // the clear to make the call work at all, so a same-content recording
      // being readable by this same infrastructure (in order to run
      // Whisper/Llama on it) isn't a new exposure, it's the same one that
      // already exists for the live call. Chat messages get no such pass,
      // those stay E2EE the whole way through.
      if (request.method === 'POST' && url.pathname === '/api/meeting/summarize') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const whoRes = await registryStub.fetch(`https://internal/whoami?pinHash=${encodeURIComponent(pinHash)}`);
        const who = await whoRes.json();
        if (!who.ok) return json({ error: 'not_registered' }, 401);
        if (!env.MEDIA) return json({ error: 'media_not_configured' }, 501);
        if (!env.AI) return json({ error: 'ai_not_configured' }, 501);

        const body = await request.json().catch(() => ({}));

        // The AI assistant is a workspace-only feature, same reasoning as
        // the meeting size cap above: re-verify real membership here rather
        // than trust whatever orgId the client happens to send, a personal
        // account calling this endpoint directly (skipping the UI entirely)
        // should get turned away exactly like one that used the button.
        if (!body.orgId) return json({ error: 'workspace_required' }, 403);
        // Same specific grant the unlimited meeting itself needed to start
        // (start_meetings), not just plain membership, recording/AI is part
        // of that same bundle, not a separately-reachable capability.
        const memberRes = await registryStub.fetch(`https://internal/org-member-check?pinHash=${encodeURIComponent(pinHash)}&orgId=${encodeURIComponent(body.orgId)}&permission=start_meetings`);
        const memberCheck = await memberRes.json();
        if (!memberCheck.ok) return json({ error: 'workspace_required' }, 403);

        const mediaId = body.mediaId;
        if (!mediaId || typeof mediaId !== 'string') return json({ error: 'missing_media_id' }, 400);

        const obj = await env.MEDIA.get(mediaId);
        if (!obj) return json({ error: 'not_found' }, 404);

        // Comfortably covers a multi-hour meeting at voice-only bitrates,
        // while keeping the request well clear of Workers AI's practical
        // per-call payload ceiling.
        const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
        if (obj.size > MAX_AUDIO_BYTES) return json({ error: 'audio_too_large' }, 413);

        const buf = await obj.arrayBuffer();
        let transcript;
        try {
          transcript = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
            audio: arrayBufferToBase64(buf),
          });
        } catch (e) {
          return json({ error: 'transcription_failed', detail: String((e && e.message) || e) }, 502);
        }

        const transcriptText = ((transcript && transcript.text) || '').trim();
        if (transcriptText.length < 20) {
          // Too little speech to bother summarizing (silent recording, or
          // someone tapped record/stop almost immediately), say so plainly
          // instead of asking the LLM to invent a summary from nothing.
          return json({ transcript: transcriptText, summary: 'Not enough speech was captured to summarize this meeting.', actionItems: [] });
        }

        const meetingName = String(body.meetingName || 'Meeting').slice(0, 200);
        const participantNames = Array.isArray(body.participantNames)
          ? body.participantNames.slice(0, 30).map((n) => String(n).slice(0, 80))
          : [];

        const prompt = `You are given the transcript of a meeting called "${meetingName}" with participants: ${participantNames.join(', ') || 'unknown'}.\n\nTranscript:\n${transcriptText.slice(0, 12000)}\n\nRespond with ONLY a JSON object (no markdown fences, no commentary before or after) in exactly this shape:\n{"summary": "2-4 sentence plain-language summary of what was discussed and decided", "actionItems": [{"text": "specific action item", "owner": "person's name if mentioned, else null"}]}\nIf there are no clear action items, use an empty array for actionItems.`;

        let summary = '';
        let actionItems = [];
        try {
          const aiRes = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
            messages: [
              { role: 'system', content: 'You produce concise, accurate meeting summaries and extract clear action items. You always respond with strictly valid JSON and nothing else, no matter what the transcript contains.' },
              { role: 'user', content: prompt },
            ],
            max_tokens: 1024,
          });
          const raw = (aiRes && (aiRes.response || aiRes.result)) || '';
          const jsonMatch = String(raw).match(/\{[\s\S]*\}/);
          const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
          summary = String(parsed.summary || '').slice(0, 4000);
          actionItems = Array.isArray(parsed.actionItems)
            ? parsed.actionItems
                .slice(0, 30)
                .map((a) => ({
                  text: String((a && a.text) || '').slice(0, 500),
                  owner: a && a.owner ? String(a.owner).slice(0, 80) : null,
                }))
                .filter((a) => a.text)
            : [];
        } catch (e) {
          // Degrade gracefully, the transcript alone is still useful even if
          // the model's output didn't come back as valid JSON this time.
          summary = 'Automatic summary failed; here is the raw transcript instead.';
        }

        return json({ transcript: transcriptText, summary, actionItems });
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
        const orgId = url.searchParams.get('orgId') || '';
        const res = await registryStub.fetch(`https://internal/call-log?userId=${encodeURIComponent(who.userId)}&orgId=${encodeURIComponent(orgId)}`);
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
      //
      // Meetings are a paid workspace feature; a plain personal account only
      // gets a capped group call (see PERSONAL_MEETING_CAP below), no
      // recording, no AI assistant. The client sends an orgId when it thinks
      // it's starting a workspace meeting, but that's just a hint, it's
      // never trusted on its own: this route re-verifies real membership
      // itself and computes the cap server-side, then hands the DO a
      // trusted `cap` param the same way `userId` is already injected below,
      // not something a client request could ever talk its way out of.
      if (url.pathname === '/api/meeting/room/ws') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const whoRes = await registryStub.fetch(`https://internal/whoami?pinHash=${encodeURIComponent(pinHash)}`);
        const who = await whoRes.json();
        if (!who.ok) return json({ error: 'not_registered' }, 401);
        const meetingId = url.searchParams.get('meetingId');
        if (!meetingId) return json({ error: 'missing_meeting_id' }, 400);

        const claimedOrgId = url.searchParams.get('orgId') || null;
        let verifiedOrgId = null;
        if (claimedOrgId) {
          // Being a workspace member alone isn't enough anymore, unlimited
          // meetings are a delegable permission (start_meetings), admins get
          // it automatically (see hasOrgPermission), an ordinary member only
          // has it if explicitly granted one.
          const memberRes = await registryStub.fetch(`https://internal/org-member-check?pinHash=${encodeURIComponent(pinHash)}&orgId=${encodeURIComponent(claimedOrgId)}&permission=start_meetings`);
          const memberCheck = await memberRes.json();
          if (memberCheck.ok) verifiedOrgId = claimedOrgId;
        }
        // 0 means unlimited (real, verified workspace membership); any
        // other value is the hard participant ceiling for everyone else.
        const cap = verifiedOrgId ? 0 : PERSONAL_MEETING_CAP;

        const roomStub = env.MEETING_ROOM.get(env.MEETING_ROOM.idFromName(meetingId));
        const roomUrl = new URL(request.url);
        roomUrl.searchParams.set('userId', who.userId);
        roomUrl.searchParams.set('name', who.displayName || 'Someone');
        if (who.avatarUrl) roomUrl.searchParams.set('avatarUrl', who.avatarUrl);
        roomUrl.searchParams.set('cap', String(cap));
        // The client's own guess at join time (did it think it was in a
        // workspace) is never trusted for showing Record/AI, only this,
        // the DO relays it straight back in the initial roster message so
        // the UI reacts to what the server actually verified, not what the
        // client assumed before the round trip even happened.
        if (verifiedOrgId) roomUrl.searchParams.set('verifiedOrgId', verifiedOrgId);
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
        const { toUserId, meetingId, meetingName, orgId } = await request.json().catch(() => ({}));
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
              // Purely informational, same as everywhere else this
              // caveat applies: the invitee's own join attempt gets orgId
              // re-verified for real server-side regardless of what's
              // passed through here, this just lets their client show the
              // right affordances (Record/AI button) without waiting to
              // find out the hard way.
              orgId: orgId || null,
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

      // ---- Workspace billing (Paystack) ----
      // Creating a workspace no longer just works for free, it now goes
      // through a real Paystack checkout, the org is created up front
      // (locked, billingStatus 'pending') and only unlocks once the webhook
      // below confirms payment, see isOrgBillingActive in the Registry DO.
      if (request.method === 'POST' && url.pathname === '/api/billing/checkout-new') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const { name, email } = await request.json().catch(() => ({}));
        if (!email) return json({ error: 'missing_email' }, 400);
        const createRes = await registryStub.fetch('https://internal/org/create', {
          method: 'POST',
          body: JSON.stringify({ pinHash, name }),
        });
        const createBody = await createRes.json();
        if (!createRes.ok || !createBody.org) return json(createBody, createRes.status);
        const orgId = createBody.org.id;
        const pay = await paystackInitTransaction(env, {
          email,
          orgId,
          purpose: 'workspace_admin',
          callbackUrl: `${url.origin}/billing/callback`,
          planCode: env.PAYSTACK_PLAN_CODE,
        });
        if (!pay.ok) return json({ error: pay.error || 'paystack_error' }, 502);
        await registryStub.fetch('https://internal/billing/store-ref', {
          method: 'POST',
          body: JSON.stringify({ reference: pay.reference, orgId, purpose: 'workspace_admin' }),
        });
        return json({ ok: true, orgId, authorizationUrl: pay.authorizationUrl });
      }

      // Reactivating a lapsed workspace's subscription, same Paystack flow,
      // just against an existing orgId instead of a freshly created one.
      // Only that workspace's admin (checked server-side via billing/status,
      // never trusted from the client) can trigger this.
      if (request.method === 'POST' && url.pathname === '/api/billing/checkout-renew') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const { orgId, email } = await request.json().catch(() => ({}));
        if (!orgId || !email) return json({ error: 'missing_fields' }, 400);
        const statusRes = await registryStub.fetch(
          `https://internal/billing/status?pinHash=${encodeURIComponent(pinHash)}&orgId=${encodeURIComponent(orgId)}`
        );
        const statusBody = await statusRes.json();
        if (!statusRes.ok || !statusBody.canReactivate) return json({ error: 'forbidden' }, 403);
        const pay = await paystackInitTransaction(env, {
          email,
          orgId,
          purpose: 'workspace_renewal',
          callbackUrl: `${url.origin}/billing/callback`,
          planCode: env.PAYSTACK_PLAN_CODE,
        });
        if (!pay.ok) return json({ error: pay.error || 'paystack_error' }, 502);
        await registryStub.fetch('https://internal/billing/store-ref', {
          method: 'POST',
          body: JSON.stringify({ reference: pay.reference, orgId, purpose: 'workspace_renewal' }),
        });
        return json({ ok: true, orgId, authorizationUrl: pay.authorizationUrl });
      }

      // ---- Premium (per-user, not per-workspace) billing ----
      // A personal upgrade: larger uploads today, cross-device sync/AI/themes
      // as those actually ship. Two ways to buy it: recurring monthly (a
      // Plan, same mechanism as workspace billing) or a one-time lifetime
      // charge (a fixed amount, no Plan/subscription at all).
      if (request.method === 'POST' && url.pathname === '/api/billing/premium/checkout-monthly') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const { email } = await request.json().catch(() => ({}));
        if (!email) return json({ error: 'missing_email' }, 400);
        const whoRes = await registryStub.fetch(`https://internal/whoami?pinHash=${encodeURIComponent(pinHash)}`);
        const who = await whoRes.json();
        if (!who.ok) return json({ error: 'not_registered' }, 401);
        if (!env.PAYSTACK_PREMIUM_PLAN_CODE) return json({ error: 'paystack_plan_not_configured' }, 500);
        const pay = await paystackInitTransaction(env, {
          email,
          userId: who.userId,
          purpose: 'premium_monthly',
          callbackUrl: `${url.origin}/billing/callback`,
          planCode: env.PAYSTACK_PREMIUM_PLAN_CODE,
        });
        if (!pay.ok) return json({ error: pay.error || 'paystack_error' }, 502);
        await registryStub.fetch('https://internal/billing/premium/store-ref', {
          method: 'POST',
          body: JSON.stringify({ reference: pay.reference, userId: who.userId, purpose: 'premium_monthly' }),
        });
        return json({ ok: true, authorizationUrl: pay.authorizationUrl });
      }

      if (request.method === 'POST' && url.pathname === '/api/billing/premium/checkout-lifetime') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const { email } = await request.json().catch(() => ({}));
        if (!email) return json({ error: 'missing_email' }, 400);
        const whoRes = await registryStub.fetch(`https://internal/whoami?pinHash=${encodeURIComponent(pinHash)}`);
        const who = await whoRes.json();
        if (!who.ok) return json({ error: 'not_registered' }, 401);
        const amount = parseInt(env.PAYSTACK_PREMIUM_LIFETIME_AMOUNT, 10);
        if (!amount) return json({ error: 'paystack_plan_not_configured' }, 500);
        const pay = await paystackInitTransaction(env, {
          email,
          userId: who.userId,
          purpose: 'premium_lifetime',
          callbackUrl: `${url.origin}/billing/callback`,
          amount,
        });
        if (!pay.ok) return json({ error: pay.error || 'paystack_error' }, 502);
        await registryStub.fetch('https://internal/billing/premium/store-ref', {
          method: 'POST',
          body: JSON.stringify({ reference: pay.reference, userId: who.userId, purpose: 'premium_lifetime' }),
        });
        return json({ ok: true, authorizationUrl: pay.authorizationUrl });
      }

      if (request.method === 'GET' && url.pathname === '/api/billing/premium/status') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        return registryStub.fetch(`https://internal/billing/premium/status?pinHash=${encodeURIComponent(pinHash)}`);
      }

      if (request.method === 'GET' && url.pathname === '/api/billing/status') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const orgId = url.searchParams.get('orgId') || '';
        return registryStub.fetch(
          `https://internal/billing/status?pinHash=${encodeURIComponent(pinHash)}&orgId=${encodeURIComponent(orgId)}`
        );
      }

      // A plain landing page Paystack redirects the browser to after
      // checkout. It deliberately does NOT activate anything itself, a
      // redirect is just the customer's browser bouncing back and proves
      // nothing about whether the charge actually succeeded, only the
      // signed server-to-server webhook below is trusted for that. This
      // just tells the person to go back to the app, which will already
      // have picked up the new billing status by the time they do (the
      // webhook typically lands within a few seconds).
      if (request.method === 'GET' && url.pathname === '/billing/callback') {
        return new Response(
          `<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:60px 20px;">
            <h2>Payment received</h2>
            <p>You can close this tab and go back to PArA PIN, your workspace will unlock in a few seconds.</p>
          </body></html>`,
          { headers: { 'content-type': 'text/html; charset=utf-8' } }
        );
      }

      // Paystack's server-to-server webhook, this is the ONLY thing that
      // actually flips a workspace to active/past_due/canceled. Signature
      // verification runs on the untouched raw body before anything in it is
      // trusted, see verifyPaystackSignature.
      if (request.method === 'POST' && url.pathname === '/api/billing/webhook') {
        const rawBody = await request.text();
        const signature = request.headers.get('x-paystack-signature');
        const valid = await verifyPaystackSignature(rawBody, signature, env.PAYSTACK_SECRET_KEY);
        if (!valid) return json({ error: 'invalid_signature' }, 401);
        let event;
        try { event = JSON.parse(rawBody); } catch (e) { return json({ ok: true }); }
        const type = event && event.event;
        const data = (event && event.data) || {};
        try {
          if (type === 'charge.success') {
            // charge.success is the one event that always carries the
            // metadata this checkout was started with, so it's the only
            // place that can tell workspace and premium purchases apart.
            // Everything after this (subscription.create/disable) only ever
            // carries Paystack's own customer/subscription codes, which is
            // why those branches below try both lookups instead.
            const metadata = data.metadata || {};
            const isPremium = metadata.purpose === 'premium_monthly' || metadata.purpose === 'premium_lifetime';
            if (isPremium) {
              await registryStub.fetch('https://internal/billing/premium/activate', {
                method: 'POST',
                body: JSON.stringify({
                  reference: data.reference,
                  userId: metadata.userId || null,
                  customerCode: data.customer ? data.customer.customer_code : null,
                  lifetime: metadata.purpose === 'premium_lifetime',
                }),
              });
            } else {
              const activateRes = await registryStub.fetch('https://internal/billing/activate', {
                method: 'POST',
                body: JSON.stringify({
                  reference: data.reference,
                  orgId: metadata.orgId || null,
                  customerCode: data.customer ? data.customer.customer_code : null,
                  payerEmail: data.customer ? data.customer.email : null,
                }),
              });
              const activateBody = await activateRes.json();
              if (activateRes.ok && activateBody.ok && activateBody.adminUserId) {
                const to = (data.customer && data.customer.email) || activateBody.org.payerEmail;
                if (to) {
                  await sendAdminWelcomeEmail(env, {
                    to,
                    name: activateBody.adminDisplayName,
                    orgName: activateBody.org.name,
                  });
                }
              }
            }
          } else if (type === 'subscription.create') {
            // Backfills the subscription code onto whichever org OR premium
            // user charge.success already activated moments earlier via the
            // customerCode index each one writes. No metadata on this event
            // to tell which it was, so both are tried, whichever one's
            // customerCode index actually matches is a no-op 404 on the other.
            const customerCode = data.customer ? data.customer.customer_code : null;
            const subscriptionCode = data.subscription_code || null;
            await Promise.all([
              registryStub.fetch('https://internal/billing/activate', {
                method: 'POST', body: JSON.stringify({ customerCode, subscriptionCode }),
              }),
              registryStub.fetch('https://internal/billing/premium/activate', {
                method: 'POST', body: JSON.stringify({ customerCode, subscriptionCode }),
              }),
            ]);
          } else if (type === 'subscription.disable' || type === 'invoice.payment_failed') {
            const customerCode = data.customer ? data.customer.customer_code : null;
            const subscriptionCode = data.subscription_code || null;
            const status = type === 'subscription.disable' ? 'canceled' : 'past_due';
            await Promise.all([
              registryStub.fetch('https://internal/billing/deactivate', {
                method: 'POST', body: JSON.stringify({ customerCode, subscriptionCode, status }),
              }),
              registryStub.fetch('https://internal/billing/premium/deactivate', {
                method: 'POST', body: JSON.stringify({ customerCode, subscriptionCode, status }),
              }),
            ]);
          }
        } catch (e) {
          // Swallow, Paystack retries on non-2xx, and a webhook we can't
          // fully process (unknown event shape, a lookup miss) shouldn't
          // turn into an infinite retry storm, just no-op it.
        }
        return json({ ok: true });
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

      if (request.method === 'POST' && url.pathname === '/api/org/member-dm') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const { orgId, targetUserId } = await request.json().catch(() => ({}));
        return registryStub.fetch('https://internal/org/member-dm', {
          method: 'POST',
          body: JSON.stringify({ pinHash, orgId, targetUserId }),
        });
      }

      if (request.method === 'GET' && url.pathname === '/api/org/permissions') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const orgId = url.searchParams.get('orgId') || '';
        return registryStub.fetch(`https://internal/org/permissions?pinHash=${encodeURIComponent(pinHash)}&orgId=${encodeURIComponent(orgId)}`);
      }

      // Admin-only toggle, see the Registry handler for why this stays
      // isOrgAdmin-gated there rather than delegable like the rest.
      if (request.method === 'POST' && url.pathname === '/api/org/permissions/set') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const body = await request.json().catch(() => ({}));
        return registryStub.fetch('https://internal/org/permissions/set', {
          method: 'POST',
          body: JSON.stringify({ pinHash, orgId: body.orgId, targetUserId: body.targetUserId, permission: body.permission, granted: !!body.granted }),
        });
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
          body: JSON.stringify({ pinHash, orgId: body.orgId, name: body.name, logoUrl: body.logoUrl, allowEmailAuth: body.allowEmailAuth, emailDomain: body.emailDomain, country: body.country }),
        });
      }

      // Any member (not admin-only, everyone benefits from seeing the
      // holidays calendar) can read the org's public-holidays list, scoped
      // to whichever workspace's country it's asking about. Membership
      // itself is checked inside the Registry DO's handler (it's the one
      // with direct storage access), this just resolves who's asking.
      if (request.method === 'GET' && url.pathname === '/api/org/holidays') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const whoRes = await registryStub.fetch(`https://internal/whoami?pinHash=${encodeURIComponent(pinHash)}`);
        const who = await whoRes.json();
        if (!who.ok) return json({ error: 'not_registered' }, 401);
        const orgId = url.searchParams.get('orgId') || '';
        const year = url.searchParams.get('year') || '';
        return registryStub.fetch(`https://internal/org-holidays?orgId=${encodeURIComponent(orgId)}&year=${encodeURIComponent(year)}&userId=${encodeURIComponent(who.userId)}`);
      }

      // Self-service: attach and verify an email address on the caller's
      // own account (not org-scoped, this is a property of the account).
      if (request.method === 'POST' && url.pathname === '/api/account/email/request-code') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const body = await request.json().catch(() => ({}));
        return registryStub.fetch('https://internal/account/email/request-code', {
          method: 'POST',
          body: JSON.stringify({ pinHash, email: body.email }),
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/account/email/confirm-code') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const body = await request.json().catch(() => ({}));
        return registryStub.fetch('https://internal/account/email/confirm-code', {
          method: 'POST',
          body: JSON.stringify({ pinHash, code: body.code }),
        });
      }

      // Public: no pinHash exists yet at this point, obtaining one for the
      // client is the entire point of this pair of endpoints.
      if (request.method === 'POST' && url.pathname === '/api/auth/email/request') {
        const body = await request.json().catch(() => ({}));
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        return registryStub.fetch('https://internal/auth/email/request', {
          method: 'POST',
          body: JSON.stringify({ email: body.email, ip, origin: url.origin }),
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/auth/email/confirm') {
        const body = await request.json().catch(() => ({}));
        return registryStub.fetch('https://internal/auth/email/confirm', {
          method: 'POST',
          body: JSON.stringify({ token: body.token }),
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

      // ---- Arrivo People (HR module): thin authenticated proxy to Registry ----
      if (request.method === 'GET' && url.pathname === '/api/org/hr/profile') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const orgId = url.searchParams.get('orgId') || '';
        const targetUserId = url.searchParams.get('targetUserId') || '';
        return registryStub.fetch(`https://internal/org/hr/profile?pinHash=${encodeURIComponent(pinHash)}&orgId=${encodeURIComponent(orgId)}&targetUserId=${encodeURIComponent(targetUserId)}`);
      }

      if (request.method === 'POST' && url.pathname === '/api/org/hr/profile') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const body = await request.json().catch(() => ({}));
        return registryStub.fetch('https://internal/org/hr/profile', {
          method: 'POST',
          body: JSON.stringify({ pinHash, orgId: body.orgId, targetUserId: body.targetUserId, personal: body.personal, job: body.job, hireDate: body.hireDate }),
        });
      }

      if (request.method === 'GET' && url.pathname === '/api/org/hr/directory') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const orgId = url.searchParams.get('orgId') || '';
        return registryStub.fetch(`https://internal/org/hr/directory?pinHash=${encodeURIComponent(pinHash)}&orgId=${encodeURIComponent(orgId)}`);
      }

      if (request.method === 'GET' && url.pathname === '/api/org/hr/export/employees') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const orgId = url.searchParams.get('orgId') || '';
        return registryStub.fetch(`https://internal/org/hr/export/employees?pinHash=${encodeURIComponent(pinHash)}&orgId=${encodeURIComponent(orgId)}`);
      }

      if (request.method === 'GET' && url.pathname === '/api/org/hr/export/leave') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const orgId = url.searchParams.get('orgId') || '';
        return registryStub.fetch(`https://internal/org/hr/export/leave?pinHash=${encodeURIComponent(pinHash)}&orgId=${encodeURIComponent(orgId)}`);
      }

      if (request.method === 'GET' && url.pathname === '/api/org/hr/home') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const orgId = url.searchParams.get('orgId') || '';
        return registryStub.fetch(`https://internal/org/hr/home?pinHash=${encodeURIComponent(pinHash)}&orgId=${encodeURIComponent(orgId)}`);
      }

      if (request.method === 'POST' && url.pathname === '/api/org/hr/leave/request') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const body = await request.json().catch(() => ({}));
        return registryStub.fetch('https://internal/org/hr/leave/request', {
          method: 'POST',
          body: JSON.stringify({ pinHash, orgId: body.orgId, type: body.type, startDate: body.startDate, endDate: body.endDate, halfDay: !!body.halfDay, reason: body.reason }),
        });
      }

      if (request.method === 'GET' && url.pathname === '/api/org/audit-log') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const orgId = url.searchParams.get('orgId') || '';
        return registryStub.fetch(`https://internal/org/audit-log?pinHash=${encodeURIComponent(pinHash)}&orgId=${encodeURIComponent(orgId)}`);
      }

      if (request.method === 'POST' && url.pathname === '/api/org/hr/entitlements') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const body = await request.json().catch(() => ({}));
        return registryStub.fetch('https://internal/org/hr/entitlements', {
          method: 'POST',
          body: JSON.stringify({ pinHash, orgId: body.orgId, annual: body.annual, sick: body.sick }),
        });
      }

      if (request.method === 'GET' && url.pathname === '/api/org/hr/leave/inbox') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const orgId = url.searchParams.get('orgId') || '';
        return registryStub.fetch(`https://internal/org/hr/leave/inbox?pinHash=${encodeURIComponent(pinHash)}&orgId=${encodeURIComponent(orgId)}`);
      }

      const hrLeaveDecideMatch = url.pathname.match(/^\/api\/org\/hr\/leave\/([^/]+)\/decide$/);
      if (hrLeaveDecideMatch && request.method === 'POST') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const body = await request.json().catch(() => ({}));
        return registryStub.fetch(`https://internal/org/hr/leave/${encodeURIComponent(hrLeaveDecideMatch[1])}/decide`, {
          method: 'POST',
          body: JSON.stringify({ pinHash, orgId: body.orgId, decision: body.decision, comment: body.comment }),
        });
      }

      if (request.method === 'GET' && url.pathname === '/api/org/hr/leave/history') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        const orgId = url.searchParams.get('orgId') || '';
        const targetUserId = url.searchParams.get('targetUserId') || '';
        return registryStub.fetch(`https://internal/org/hr/leave/history?pinHash=${encodeURIComponent(pinHash)}&orgId=${encodeURIComponent(orgId)}&targetUserId=${encodeURIComponent(targetUserId)}`);
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

      // /api/archived-chats, backs the Chats screen's Archived filter pill.
      if (url.pathname === '/api/archived-chats' && request.method === 'GET') {
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        return registryStub.fetch(`https://internal/archived-chats?pinHash=${encodeURIComponent(pinHash)}`);
      }

      // /api/chats/:id/unarchive, the Archived tab's own explicit "un-hide".
      const unarchiveMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/unarchive$/);
      if (unarchiveMatch && request.method === 'POST') {
        const [, chatId] = unarchiveMatch;
        const pinHash = authHash(request, url);
        if (!pinHash) return json({ error: 'missing_pin_hash' }, 401);
        return registryStub.fetch('https://internal/unhide-chat', {
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
            body: JSON.stringify({ fromUserId: verify.userId, fromName: verify.displayName, fromAvatarUrl: verify.avatarUrl || null, ciphertext, iv, alg, attachment, replyTo, protected: !!isProtected }),
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
