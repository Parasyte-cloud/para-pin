// Auth/session state. Deliberately NOT using zustand's `persist` middleware
// for the whole store — SecureStore (iOS Keychain / Android Keystore) has
// tight per-item size limits and is meant for credentials, not a chat-list
// cache. So: only `deviceId`, `pinHash`, and the biometric-unlock
// preference live in SecureStore; everything else (orgs, chats, summaries)
// is refetched from POST /session on app boot using that stored hash, same
// as index.html re-hitting /session on every page load rather than
// trusting stale localStorage state.

import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import * as LocalAuthentication from 'expo-local-authentication';
import { create } from 'zustand';
import { apiFetch } from '../api/client';
import type { ApiErrorBody, ChatMessage, ChatSummary, OrgSummary } from '../types';

const DEVICE_ID_KEY = 'parapin_device_id';
const PIN_HASH_KEY = 'parapin_pin_hash';
const BIOMETRIC_ENABLED_KEY = 'parapin_biometric_enabled';

async function getOrCreateDeviceId(): Promise<string> {
  const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  if (existing) return existing;
  const id = Crypto.randomUUID();
  await SecureStore.setItemAsync(DEVICE_ID_KEY, id);
  return id;
}

// Matches index.html's sha256Hex(pin) exactly (index.html:2991) — the raw
// PIN never leaves the device, only this hash does.
export async function hashPin(pin: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, pin, {
    encoding: Crypto.CryptoEncoding.HEX,
  });
}

async function checkBiometricSupport(): Promise<boolean> {
  try {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const isEnrolled = await LocalAuthentication.isEnrolledAsync();
    return hasHardware && isEnrolled;
  } catch {
    return false;
  }
}

interface SessionState {
  isHydrated: boolean;
  isLoading: boolean;
  // True when the app has a stored credential but is device-locked behind
  // Face ID/fingerprint (or its PIN fallback) — distinct from having no
  // credential at all, which routes to the full PIN/create-account screen
  // instead of the lock screen. Note this is purely a LOCAL re-entry gate
  // (mirrors the web app's own local-only "Secure Vault" PIN concept) —
  // the server-side credential is still the sha256'd PIN either way.
  isLocked: boolean;
  biometricEnabled: boolean;
  biometricSupported: boolean;
  deviceId: string | null;
  pinHash: string | null;
  userId: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
  orgs: OrgSummary[];
  chats: ChatSummary[];
  // See types.ts's SessionResponse['summaries'] comment — lastMessage was
  // always present in the server response, just never typed through here.
  summaries: Record<string, { unreadCount?: number; lastMessageAt?: number | null; lastMessage?: ChatMessage | null }>;
  pinnedChatIds: string[];
  // Which workspace's chats/calls are currently in view — `null` means
  // Personal, matching every `orgId` field on the wire (chats, call log
  // entries, etc. all use `null`/absent for Personal, never a sentinel
  // string). Mirrors web's `activeOrgId` (index.html:3067). In-memory only
  // for now (not persisted across app restarts like web's localStorage
  // copy) — always reopens on Personal, which is a reasonable default and
  // avoids a SecureStore round trip on every switch.
  activeOrgId: string | null;
  setActiveOrgId: (orgId: string | null) => void;

  hydrate: () => Promise<void>;
  submitPin: (
    pin: string,
    opts?: { displayName?: string }
  ) => Promise<{ ok: true } | { ok: false; error: ApiErrorBody | null; status: number }>;
  refreshSession: () => Promise<boolean>;
  unlockWithBiometric: () => Promise<boolean>;
  unlockWithPin: (pin: string) => Promise<{ ok: true } | { ok: false; error: ApiErrorBody | null; status: number }>;
  setBiometricEnabled: (enabled: boolean) => Promise<boolean>;
  // Manual re-lock, e.g. tapping the nav bar's lock medallion (mirrors
  // web's lock button — index.html's medallion taps call lock(), see the
  // nav research notes in mobile-app/README.md). Works the same whether
  // biometricEnabled is on or not — app/(auth)/lock.tsx already has a PIN
  // fallback path either way, this just reuses the existing isLocked gate
  // app/(tabs)/_layout.tsx already redirects on.
  lockNow: () => void;
  logout: () => Promise<void>;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  isHydrated: false,
  isLoading: false,
  isLocked: false,
  biometricEnabled: false,
  biometricSupported: false,
  deviceId: null,
  pinHash: null,
  userId: null,
  displayName: null,
  avatarUrl: null,
  isAdmin: false,
  orgs: [],
  chats: [],
  summaries: {},
  pinnedChatIds: [],
  activeOrgId: null,
  setActiveOrgId: (orgId) => set({ activeOrgId: orgId }),

  hydrate: async () => {
    const [deviceId, pinHash, biometricPref, biometricSupported] = await Promise.all([
      getOrCreateDeviceId(),
      SecureStore.getItemAsync(PIN_HASH_KEY),
      SecureStore.getItemAsync(BIOMETRIC_ENABLED_KEY),
      checkBiometricSupport(),
    ]);
    const biometricEnabled = biometricPref === 'true' && biometricSupported;
    set({ deviceId, pinHash, biometricEnabled, biometricSupported });

    if (pinHash) {
      if (biometricEnabled) {
        // Don't hit the network or reveal chat data until the local lock
        // gate clears — app/(auth)/lock.tsx calls unlockWithBiometric()/
        // unlockWithPin(), which is what actually triggers refreshSession().
        set({ isLocked: true });
      } else {
        await get().refreshSession();
      }
    }
    set({ isHydrated: true });
  },

  refreshSession: async () => {
    const { pinHash, deviceId } = get();
    if (!pinHash || !deviceId) return false;
    set({ isLoading: true });
    const res = await apiFetch('/session', {
      method: 'POST',
      body: JSON.stringify({ pinHash, deviceId }),
    });
    set({ isLoading: false });
    if (!res.ok) {
      // Session no longer valid (PIN disabled, device revoked, etc.) — drop
      // the stored hash so the app falls back to the PIN screen instead of
      // silently retrying a dead credential forever.
      if (res.status === 401 || res.status === 403) {
        await SecureStore.deleteItemAsync(PIN_HASH_KEY);
        set({ pinHash: null, isLocked: false });
      }
      return false;
    }
    const body = res.body as any;
    set({
      userId: body.userId,
      displayName: body.displayName,
      avatarUrl: body.avatarUrl ?? null,
      isAdmin: !!body.isAdmin,
      orgs: body.orgs ?? [],
      chats: body.chats ?? [],
      summaries: body.summaries ?? {},
      pinnedChatIds: body.pinnedChatIds ?? [],
    });
    return true;
  },

  submitPin: async (pin, opts) => {
    const deviceId = get().deviceId ?? (await getOrCreateDeviceId());
    const pinHash = await hashPin(pin);
    set({ isLoading: true });
    const res = await apiFetch('/session', {
      method: 'POST',
      // worker.js's authHash() (see worker.js:830) only ever reads the
      // X-Para-Pin-Hash header or a ?pinHash= query param — it never looks
      // at the request body. apiFetch's own automatic header injection
      // only pulls from the ALREADY-STORED session pinHash, which doesn't
      // exist yet on a fresh submit (this hash IS what's about to become
      // that stored value). The old `skipAuth: true` here just skipped
      // sending the header entirely and relied on the body alone, which
      // the server never looks at for auth — every submit was rejected
      // with a 401 missing_pin_hash before ever reaching real account
      // logic. Send it explicitly instead, same as web's initSession()
      // (index.html:3235-3240) setting myPinHash before its own /session
      // call so its header-injection has something to pick up.
      headers: { 'X-Para-Pin-Hash': pinHash },
      body: JSON.stringify({ pinHash, deviceId, displayName: opts?.displayName }),
    });
    set({ isLoading: false });
    if (!res.ok) {
      return { ok: false, error: res.body, status: res.status };
    }
    await SecureStore.setItemAsync(PIN_HASH_KEY, pinHash);
    const body = res.body as any;
    set({
      pinHash,
      deviceId,
      isLocked: false,
      userId: body.userId,
      displayName: body.displayName,
      avatarUrl: body.avatarUrl ?? null,
      isAdmin: !!body.isAdmin,
      orgs: body.orgs ?? [],
      chats: body.chats ?? [],
      summaries: body.summaries ?? {},
      pinnedChatIds: body.pinnedChatIds ?? [],
    });
    return { ok: true };
  },

  // Re-entry path when the app is locked behind biometrics/PIN but a
  // pinHash is already on file — reuses the same POST /session call as a
  // fresh login (cheap, also conveniently re-validates the credential
  // server-side and refreshes chats/orgs), just without touching
  // SecureStore's stored hash since it's already correct.
  unlockWithPin: async (pin) => {
    const { pinHash: storedHash, deviceId } = get();
    const attemptedHash = await hashPin(pin);
    if (storedHash && attemptedHash !== storedHash) {
      // Fail fast locally for an obviously-wrong PIN rather than spending a
      // server rate-limit attempt on it — this is a LOCAL re-entry check
      // only (mirrors the web app's local vault gate); the real
      // authenticated request below still uses the correct stored hash.
      return { ok: false, error: { error: 'wrong_pin' }, status: 0 };
    }
    set({ isLoading: true });
    const res = await apiFetch('/session', {
      method: 'POST',
      // Same fix as submitPin above — send the hash explicitly rather than
      // relying on skipAuth's now-removed body-only behavior, which the
      // server never actually reads for auth.
      headers: { 'X-Para-Pin-Hash': attemptedHash },
      body: JSON.stringify({ pinHash: attemptedHash, deviceId: deviceId ?? (await getOrCreateDeviceId()) }),
    });
    set({ isLoading: false });
    if (!res.ok) return { ok: false, error: res.body, status: res.status };
    const body = res.body as any;
    set({
      isLocked: false,
      userId: body.userId,
      displayName: body.displayName,
      avatarUrl: body.avatarUrl ?? null,
      isAdmin: !!body.isAdmin,
      orgs: body.orgs ?? [],
      chats: body.chats ?? [],
      summaries: body.summaries ?? {},
      pinnedChatIds: body.pinnedChatIds ?? [],
    });
    return { ok: true };
  },

  unlockWithBiometric: async () => {
    const supported = get().biometricSupported;
    if (!supported) return false;
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Unlock PArA PIN',
      fallbackLabel: 'Use PIN',
      disableDeviceFallback: false,
    });
    if (!result.success) return false;
    const ok = await get().refreshSession();
    if (ok) set({ isLocked: false });
    return ok;
  },

  setBiometricEnabled: async (enabled) => {
    if (enabled) {
      const supported = await checkBiometricSupport();
      if (!supported) return false;
      await SecureStore.setItemAsync(BIOMETRIC_ENABLED_KEY, 'true');
      set({ biometricEnabled: true, biometricSupported: true });
      return true;
    }
    await SecureStore.setItemAsync(BIOMETRIC_ENABLED_KEY, 'false');
    set({ biometricEnabled: false });
    return true;
  },

  lockNow: () => set({ isLocked: true }),

  logout: async () => {
    await SecureStore.deleteItemAsync(PIN_HASH_KEY);
    set({
      pinHash: null,
      isLocked: false,
      userId: null,
      displayName: null,
      avatarUrl: null,
      isAdmin: false,
      orgs: [],
      chats: [],
      summaries: {},
      pinnedChatIds: [],
    });
  },
}));
