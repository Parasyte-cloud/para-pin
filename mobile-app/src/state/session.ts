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
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { create } from 'zustand';
import { apiFetch } from '../api/client';
import type { ApiErrorBody, ChatMessage, ChatSummary, OrgSummary } from '../types';

// manufacturer/model/isEmulator are only ever knowable on native — a
// browser can't report them at all (see worker.js's parseDeviceInfo
// fallback for the web path), this is the one genuine advantage a native
// client has for device-trust display/risk-scoring over a browser tab.
// Device.isDevice is expo-device's own real/simulator check, no additional
// heuristic needed (unlike VPN/hosting detection, which has no equivalent
// authoritative source and stays a keyword heuristic server-side).
function getNativeDeviceInfo() {
  return {
    platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'other',
    osVersion: Device.osVersion ?? null,
    manufacturer: Device.manufacturer ?? null,
    model: Device.modelName ?? null,
    isEmulator: Device.isDevice === false,
    appVersion: Constants.expoConfig?.version ?? null,
  };
}

const DEVICE_ID_KEY = 'parapin_device_id';
const PIN_HASH_KEY = 'parapin_pin_hash';
const BIOMETRIC_ENABLED_KEY = 'parapin_biometric_enabled';
const LOCK_TIMEOUT_KEY = 'parapin_lock_timeout_sec';
const HIGH_CONTRAST_KEY = 'parapin_high_contrast';
const ONE_HANDED_KEY = 'parapin_one_handed_mode';

// Mirrors index.html's LOCK_TIMEOUT_TIERS/DEFAULT_LOCK_TIMEOUT_SEC exactly —
// see that file's "Inactivity auto-lock" comment for the full reasoning.
export const LOCK_TIMEOUT_TIERS = [0, 30, 60, 300] as const;
export const DEFAULT_LOCK_TIMEOUT_SEC = 300;

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
  // This person's own preferred auto-lock timeout (seconds since
  // backgrounded before the app requires re-authentication). The ACTUAL
  // enforced value may be stricter — see getEffectiveLockTimeoutSec, which
  // also factors in every org's securityPolicy.minTimeoutSec.
  lockTimeoutSec: number;
  setLockTimeoutSec: (sec: number) => Promise<void>;
  // Accessibility preferences — same SecureStore-and-mirror-into-state
  // pattern as lockTimeoutSec above, just booleans. Neither is
  // security-sensitive (unlike pinHash/biometric), they just live here
  // because this is already the one store every screen reads theme/settings
  // state from, and useTheme() (see hooks/useTheme.ts) needs
  // highContrastEnabled on every render.
  highContrastEnabled: boolean;
  setHighContrastEnabled: (enabled: boolean) => Promise<void>;
  oneHandedModeEnabled: boolean;
  setOneHandedModeEnabled: (enabled: boolean) => Promise<void>;
  // Mirrors index.html's profileSaveBtn handler (index.html:8530-8566).
  // `avatarUrl` here is the ALREADY-UPLOADED result — this action never
  // touches the file picker or /api/upload itself (see
  // ProfileModal.tsx/utils/profilePhotoUpload.ts for that), it only saves
  // the final {displayName, avatarUrl} pair. Passing `avatarUrl: undefined`
  // keeps the existing photo; there's no "remove photo" affordance here,
  // same as web.
  // avatarMediaKey is the companion private-tier key from
  // uploadPrivateAvatarPhoto (undefined = leave whatever's already saved
  // untouched, matching worker.js's /profile handler semantics exactly).
  updateProfile: (
    displayName: string,
    avatarUrl?: string,
    avatarMediaKey?: string
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
}

// The org sets a CEILING (loosest acceptable), not a fixed value — same
// model as index.html's effectiveLockTimeoutSec(). A workspace with no
// policy set (securityPolicy null/minTimeoutSec null) doesn't constrain
// this at all; the strictest applicable value wins.
export function getEffectiveLockTimeoutSec(): number {
  const { lockTimeoutSec, orgs } = useSessionStore.getState();
  let effective = lockTimeoutSec;
  for (const org of orgs) {
    const min = org.securityPolicy?.minTimeoutSec;
    if (min !== null && min !== undefined && min < effective) effective = min;
  }
  return effective;
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
  lockTimeoutSec: DEFAULT_LOCK_TIMEOUT_SEC,
  setLockTimeoutSec: async (sec) => {
    await SecureStore.setItemAsync(LOCK_TIMEOUT_KEY, String(sec));
    set({ lockTimeoutSec: sec });
  },
  highContrastEnabled: false,
  setHighContrastEnabled: async (enabled) => {
    await SecureStore.setItemAsync(HIGH_CONTRAST_KEY, enabled ? 'true' : 'false');
    set({ highContrastEnabled: enabled });
  },
  oneHandedModeEnabled: false,
  setOneHandedModeEnabled: async (enabled) => {
    await SecureStore.setItemAsync(ONE_HANDED_KEY, enabled ? 'true' : 'false');
    set({ oneHandedModeEnabled: enabled });
  },

  hydrate: async () => {
    const [deviceId, pinHash, biometricPref, biometricSupported, lockTimeoutPref, highContrastPref, oneHandedPref] = await Promise.all([
      getOrCreateDeviceId(),
      SecureStore.getItemAsync(PIN_HASH_KEY),
      SecureStore.getItemAsync(BIOMETRIC_ENABLED_KEY),
      checkBiometricSupport(),
      SecureStore.getItemAsync(LOCK_TIMEOUT_KEY),
      SecureStore.getItemAsync(HIGH_CONTRAST_KEY),
      SecureStore.getItemAsync(ONE_HANDED_KEY),
    ]);
    const biometricEnabled = biometricPref === 'true' && biometricSupported;
    const parsedTimeout = parseInt(lockTimeoutPref || '', 10);
    const lockTimeoutSec = (LOCK_TIMEOUT_TIERS as readonly number[]).includes(parsedTimeout) ? parsedTimeout : DEFAULT_LOCK_TIMEOUT_SEC;
    const highContrastEnabled = highContrastPref === 'true';
    const oneHandedModeEnabled = oneHandedPref === 'true';
    set({ deviceId, pinHash, biometricEnabled, biometricSupported, lockTimeoutSec, highContrastEnabled, oneHandedModeEnabled });

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
      body: JSON.stringify({ pinHash, deviceId, ...getNativeDeviceInfo() }),
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
      body: JSON.stringify({ pinHash, deviceId, displayName: opts?.displayName, ...getNativeDeviceInfo() }),
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
      body: JSON.stringify({ pinHash: attemptedHash, deviceId: deviceId ?? (await getOrCreateDeviceId()), ...getNativeDeviceInfo() }),
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

  // Face ID/Touch ID/fingerprint verification is entirely on-device (Secure
  // Enclave on iOS, Android Keystore-backed biometric APIs on Android) —
  // it never touches the network. Previously this function ALSO required
  // refreshSession() (a network round trip) to succeed before unlocking,
  // meaning a successful Face ID scan with no signal — on a plane, in a
  // basement, anywhere offline — still left the person locked out of chats
  // that were already fully cached on-device. The local biometric result
  // is now trusted on its own for the unlock decision; refreshSession()
  // still runs right after, in the background, to pull fresh data AND to
  // catch a real revocation (device removed/lost/compromised, PIN
  // disabled) — same async-detection model as useDeviceStatusSelfCheck's
  // periodic poll, not a new weaker guarantee: this app already can't do
  // instant server-forced logout (see DEVICE_TRUST_ARCHITECTURE.md), and
  // this doesn't change that boundary, it just stops making offline access
  // to already-local data depend on a network call that has nothing to do
  // with whether the fingerprint matched.
  unlockWithBiometric: async () => {
    const supported = get().biometricSupported;
    if (!supported) return false;
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Unlock PArA PIN',
      fallbackLabel: 'Use PIN',
      disableDeviceFallback: false,
    });
    if (!result.success) return false;
    set({ isLocked: false });
    get().refreshSession(); // fire-and-forget — see comment above
    return true;
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

  updateProfile: async (displayName, avatarUrl, avatarMediaKey) => {
    const name = displayName.trim();
    if (!name) return { ok: false, error: 'Enter a display name.' };
    const res = await apiFetch<{ displayName?: string; avatarUrl?: string | null }>('/profile', {
      method: 'POST',
      body: JSON.stringify({ displayName: name, avatarUrl, ...(avatarMediaKey !== undefined ? { avatarMediaKey } : {}) }),
    });
    if (!res.ok) return { ok: false, error: "Couldn't save your profile. Try again." };
    set({
      displayName: res.body.displayName ?? name,
      avatarUrl: res.body.avatarUrl ?? avatarUrl ?? get().avatarUrl,
    });
    return { ok: true };
  },

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
