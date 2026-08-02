// Device keypair persistence + chat-key resolution/establishment.
// Mirrors index.html's ensureMyE2eeKeyPair/ensureChatKey (index.html:
// ~10395-10645) as closely as possible so mobile and web establish and
// unwrap the exact same chat keys.
//
// Known, deliberate scope cut vs. the web app: this does NOT merge in a
// peer's legacy pre-multi-device single public key (`_legacy` slot /
// fetchPeerEffectiveDeviceKeys in index.html) when ESTABLISHING a brand
// new chat key. In practice that only matters for a chat whose other
// member(s) have never once opened any client since multi-device E2EE
// shipped — vanishingly rare for anyone actively using the product, and
// self-heals the moment they do open any client. Unwrapping (reading an
// already-established key) is unaffected either way.

import * as SecureStore from 'expo-secure-store';
import { apiFetch } from '../api/client';
import { useSessionStore } from './session';
import {
  generateKeyPair,
  generateRawChatKey,
  wrapRawKeyForDevice,
  unwrapRawKey,
  deriveLegacyDmKey,
  bufToB64,
  b64ToBuf,
  type KeyPair,
  type Wrap,
} from '../crypto/e2ee';
import type { ChatSummary } from '../types';

const SECRET_KEY_STORAGE = 'parapin_e2ee_secret_key';
const PUBLIC_KEY_STORAGE = 'parapin_e2ee_public_key';

let myKeyPairPromise: Promise<KeyPair> | null = null;
let publishedThisSession = false;

async function loadOrCreateKeyPair(): Promise<KeyPair> {
  const [storedSecret, storedPublic] = await Promise.all([
    SecureStore.getItemAsync(SECRET_KEY_STORAGE),
    SecureStore.getItemAsync(PUBLIC_KEY_STORAGE),
  ]);
  if (storedSecret && storedPublic) {
    return { secretKey: b64ToBuf(storedSecret), publicKeyB64: storedPublic };
  }
  const kp = generateKeyPair();
  await Promise.all([
    SecureStore.setItemAsync(SECRET_KEY_STORAGE, bufToB64(kp.secretKey)),
    SecureStore.setItemAsync(PUBLIC_KEY_STORAGE, kp.publicKeyB64),
  ]);
  return kp;
}

// Idempotent, safe to call repeatedly — matches index.html:10410's
// "keeps the server's copy of our public key in sync" comment. Only
// actually POSTs once per app session (the server call itself is cheap
// and idempotent too, but no reason to redo it on every ensureChatKey()).
export async function ensureMyE2eeKeyPair(): Promise<KeyPair> {
  if (!myKeyPairPromise) myKeyPairPromise = loadOrCreateKeyPair();
  const kp = await myKeyPairPromise;
  if (!publishedThisSession) {
    publishedThisSession = true;
    const deviceId = useSessionStore.getState().deviceId;
    apiFetch('/e2ee/public-key', {
      method: 'POST',
      body: JSON.stringify({ publicKey: kp.publicKeyB64, deviceId }),
    }).catch(() => {});
  }
  return kp;
}

interface PeerDeviceKeys {
  [deviceId: string]: string; // deviceId -> publicKeyB64
}

const peerDeviceKeysCache = new Map<string, PeerDeviceKeys>();

async function fetchPeerDeviceKeys(userId: string): Promise<PeerDeviceKeys> {
  const cached = peerDeviceKeysCache.get(userId);
  if (cached) return cached;
  const res = await apiFetch<{ users?: Array<{ id: string; devicePublicKeys?: PeerDeviceKeys }> }>(
    `/users?ids=${encodeURIComponent(userId)}`
  );
  const rec = res.ok ? res.body.users?.[0] : undefined;
  const keys = rec?.devicePublicKeys || {};
  if (Object.keys(keys).length) peerDeviceKeysCache.set(userId, keys);
  return keys;
}

interface WrapsResponse {
  [userId: string]: { [deviceId: string]: Wrap } | Wrap; // nested (current) or flat (legacy groups)
}

function resolveMyWrap(wraps: WrapsResponse, myUserId: string, myDeviceId: string): Wrap | null {
  const mine = wraps[myUserId];
  if (!mine) return null;
  if (typeof (mine as Wrap).ephemeralPub === 'string') return mine as Wrap; // legacy flat shape
  const nested = mine as { [deviceId: string]: Wrap };
  return nested[myDeviceId] || null;
}

const chatKeyCache = new Map<string, Uint8Array>();
const chatKeyLastAttempt = new Map<string, number>();
const RETRY_COOLDOWN_MS = 5000;

// Resolves (and caches) the raw AES-256-GCM key for a chat, establishing
// one if nothing exists yet for anyone. Returns null when it's not
// possible RIGHT NOW (still waiting on a wrap from another of my own
// devices, or a member's key isn't published anywhere yet) — callers
// should treat null as "try again shortly," not a hard failure.
export async function ensureChatKey(chat: ChatSummary): Promise<Uint8Array | null> {
  if (!chat) return null;
  const cached = chatKeyCache.get(chat.id);
  if (cached) return cached;

  const lastTry = chatKeyLastAttempt.get(chat.id) || 0;
  if (Date.now() - lastTry < RETRY_COOLDOWN_MS) return null;
  chatKeyLastAttempt.set(chat.id, Date.now());

  const myKeyPair = await ensureMyE2eeKeyPair();
  const { userId: myUserId, deviceId: myDeviceId } = useSessionStore.getState();
  if (!myUserId || !myDeviceId) return null;

  const wrapsRes = await apiFetch<{ wraps?: WrapsResponse }>(`/chats/${chat.id}/e2ee-wraps`);
  const wraps = (wrapsRes.ok && wrapsRes.body.wraps) || {};
  const myWrap = resolveMyWrap(wraps, myUserId, myDeviceId);
  if (myWrap) {
    try {
      const rawKey = unwrapRawKey(myWrap, myKeyPair.secretKey);
      chatKeyCache.set(chat.id, rawKey);
      return rawKey;
    } catch {
      return null;
    }
  }

  if (Object.keys(wraps).length > 0) {
    // Someone else already established this chat's key; I just don't have
    // a wrap for this device yet (new device, or joined a group after
    // creation). Only an already-trusted device handing this device a
    // fresh wrap fixes that — nothing to do here but wait and retry.
    return null;
  }

  // Nothing established yet anywhere — safe (and my job) to create it.
  const memberIds = chat.memberIds || [];
  const memberDeviceKeys: Record<string, PeerDeviceKeys> = {};
  for (const id of memberIds) {
    memberDeviceKeys[id] = id === myUserId ? { [myDeviceId]: myKeyPair.publicKeyB64 } : await fetchPeerDeviceKeys(id);
  }
  const missing = memberIds.filter((id) => !Object.keys(memberDeviceKeys[id] || {}).length);
  if (missing.length) return null; // nobody's ever published a key for this person yet

  const rawKey = generateRawChatKey();
  const newWraps: WrapsResponse = {};
  for (const id of memberIds) {
    const perDevice: { [deviceId: string]: Wrap } = {};
    for (const [deviceId, pub] of Object.entries(memberDeviceKeys[id])) {
      perDevice[deviceId] = wrapRawKeyForDevice(rawKey, pub);
    }
    newWraps[id] = perDevice;
  }

  const establishRes = await apiFetch<{ alreadyEstablished?: boolean; wraps?: WrapsResponse }>(
    `/chats/${chat.id}/e2ee-wraps`,
    { method: 'POST', body: JSON.stringify({ wraps: newWraps, ifEmpty: true }) }
  );
  if (establishRes.ok && establishRes.body.alreadyEstablished) {
    // Lost the race — unwrap the winner's key straight out of this same
    // response instead of another round trip.
    const theirWrap = resolveMyWrap(establishRes.body.wraps || {}, myUserId, myDeviceId);
    if (!theirWrap) return null;
    try {
      const rawFromWinner = unwrapRawKey(theirWrap, myKeyPair.secretKey);
      chatKeyCache.set(chat.id, rawFromWinner);
      return rawFromWinner;
    } catch {
      return null;
    }
  }

  chatKeyCache.set(chat.id, rawKey);
  return rawKey;
}

// Called right after THIS (already-trusted) device approves a new device
// on the same account, via DeviceApprovalGate's counterpart in
// settings.tsx. Mirrors index.html's rewrapAllChatsForDevice
// (index.html:10697-10710): the new device generated a keypair and
// uploaded its public key before requesting approval, but has no way to
// get the actual chat keys — only a device that already holds them can
// hand out a wrap for a new one. Best-effort/fire-and-forget: if this
// fails partway, the new device just waits for a fresh message in each
// still-unwrapped chat instead (ensureChatKey retries automatically).
export async function rewrapAllChatsForDevice(newDeviceId: string): Promise<void> {
  try {
    const { userId: myUserId, chats } = useSessionStore.getState();
    if (!myUserId) return;
    peerDeviceKeysCache.delete(myUserId); // force a fresh lookup — the new key was likely just uploaded moments ago
    const mine = await fetchPeerDeviceKeys(myUserId);
    const newDevicePub = mine[newDeviceId];
    if (!newDevicePub) return; // hasn't uploaded its key yet, nothing to wrap against
    for (const chat of chats) {
      const key = await ensureChatKey(chat);
      if (!key) continue;
      const wrap = wrapRawKeyForDevice(key, newDevicePub);
      await apiFetch(`/chats/${chat.id}/e2ee-wraps`, {
        method: 'POST',
        body: JSON.stringify({ wraps: { [myUserId]: { [newDeviceId]: wrap } } }),
      });
    }
  } catch {
    // best-effort, see comment above
  }
}

// Legacy pre-multi-device pairwise DM key — decrypt-only fallback for old
// DM history (index.html:10467-10506's fetchPeerLegacyPublicKey /
// ensureLegacyDmKey). `e2eePublicKey` on the /users record is the OTHER
// party's single key, frozen server-side the moment their account first
// trusted a second device — it is NOT the same thing as devicePublicKeys.
//
// Important limitation, unavoidable by construction: this derives a key
// from MY device's private key + their frozen public key. That only
// reproduces the original ciphertext's key if MY private key is the same
// one that was active back when that DM was encrypted. Mobile always
// generates a brand-new keypair the first time it runs, so on any account
// that had already exchanged pre-multi-device DMs on the web app before
// ever opening mobile, this fallback will resolve to a *different* key
// than the original — it can't retroactively decrypt that history, the
// same way approving any other new device can't either. It only actually
// helps if mobile itself happens to be an account's very first device.
const peerLegacyKeyCache = new Map<string, string | null>();
const legacyDmKeyCache = new Map<string, Uint8Array | null>();

async function fetchPeerLegacyPublicKey(userId: string): Promise<string | null> {
  if (peerLegacyKeyCache.has(userId)) return peerLegacyKeyCache.get(userId) ?? null;
  const res = await apiFetch<{ users?: Array<{ id: string; e2eePublicKey?: string | null }> }>(
    `/users?ids=${encodeURIComponent(userId)}`
  );
  const rec = res.ok ? res.body.users?.[0] : undefined;
  const key = rec?.e2eePublicKey ?? null;
  peerLegacyKeyCache.set(userId, key);
  return key;
}

export async function ensureLegacyDmKey(chat: ChatSummary): Promise<Uint8Array | null> {
  if (!chat || chat.type !== 'dm') return null;
  if (legacyDmKeyCache.has(chat.id)) return legacyDmKeyCache.get(chat.id) ?? null;
  const myKeyPair = await ensureMyE2eeKeyPair();
  const { userId: myUserId } = useSessionStore.getState();
  const otherId = chat.memberIds?.find((mid) => mid !== myUserId) || null;
  const otherPub = otherId ? await fetchPeerLegacyPublicKey(otherId) : null;
  const key = otherPub ? deriveLegacyDmKey(myKeyPair.secretKey, otherPub) : null;
  legacyDmKeyCache.set(chat.id, key);
  return key;
}
