// Detects the device's OWN security enrollment being weakened — biometrics
// turned off, or the device passcode/screen-lock removed entirely — and
// reports it via POST /devices/local-security-event (worker.js). See that
// endpoint's comment for why this can only ever be client-reported: the
// server has no independent way to observe local device-lock state.
//
// expo-local-authentication's getEnrolledLevelAsync() is the one honest
// signal available here — SecurityLevel.NONE means no device passcode/
// pattern/PIN *and* no biometric is enrolled at all (this is what "the
// passcode was removed" actually looks like from an app's perspective on
// both iOS and Android; there's no separate "passcode specifically" event
// either platform's public API exposes). A drop from BIOMETRIC_* to SECRET
// means biometrics specifically were turned off but a passcode remains.
import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { apiFetch } from '../api/client';
import { useSessionStore } from '../state/session';

const LAST_LEVEL_KEY = 'parapin_last_security_level';

// BIOMETRIC_WEAK (2) and BIOMETRIC_STRONG (3) are both "some biometric is
// enrolled"; SECRET (1) is passcode/PIN/pattern only; NONE (0) is nothing.
function levelIsBiometric(level: LocalAuthentication.SecurityLevel): boolean {
  return level === LocalAuthentication.SecurityLevel.BIOMETRIC_WEAK
    || level === LocalAuthentication.SecurityLevel.BIOMETRIC_STRONG;
}

async function checkAndReport() {
  const { pinHash, deviceId, biometricEnabled, setBiometricEnabled } = useSessionStore.getState();
  if (!pinHash || !deviceId) return;

  let current: LocalAuthentication.SecurityLevel;
  try {
    current = await LocalAuthentication.getEnrolledLevelAsync();
  } catch {
    return;
  }

  const lastRaw = await SecureStore.getItemAsync(LAST_LEVEL_KEY);
  const last = lastRaw !== null ? (parseInt(lastRaw, 10) as LocalAuthentication.SecurityLevel) : null;
  await SecureStore.setItemAsync(LAST_LEVEL_KEY, String(current));
  if (last === null) return; // first observation ever — nothing to compare against yet

  if (last !== current && current === LocalAuthentication.SecurityLevel.NONE) {
    // Passcode/screen-lock removed entirely — the strongest signal, worth
    // reporting regardless of whether Face ID/fingerprint was in use.
    if (biometricEnabled) await setBiometricEnabled(false);
    await apiFetch('/devices/local-security-event', {
      method: 'POST',
      body: JSON.stringify({ deviceId, event: 'passcode_removed' }),
    }).catch(() => {});
    return;
  }

  if (levelIsBiometric(last) && !levelIsBiometric(current) && current !== LocalAuthentication.SecurityLevel.NONE) {
    // Biometric enrollment specifically cleared (Face ID/fingerprint
    // removed from system settings) while a passcode/PIN remains.
    if (biometricEnabled) await setBiometricEnabled(false);
    await apiFetch('/devices/local-security-event', {
      method: 'POST',
      body: JSON.stringify({ deviceId, event: 'biometric_disabled' }),
    }).catch(() => {});
  }
}

export function useBiometricEnrollmentWatcher() {
  const pinHash = useSessionStore((s) => s.pinHash);
  const isLocked = useSessionStore((s) => s.isLocked);
  const ranOnceRef = useRef(false);

  useEffect(() => {
    if (!pinHash || isLocked) return;
    if (!ranOnceRef.current) {
      ranOnceRef.current = true;
      checkAndReport();
    }
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') checkAndReport();
    });
    return () => sub.remove();
  }, [pinHash, isLocked]);
}
