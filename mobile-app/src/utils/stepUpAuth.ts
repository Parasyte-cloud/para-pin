// "Step-up" re-authentication for a specific sensitive action — approving a
// new device, changing billing, etc. — distinct from the app-unlock gate
// (session.ts's unlockWithBiometric/isLocked): the app is already unlocked
// and in active use, this is a SECOND, narrower confirmation right before
// one consequential action, the same pattern iOS/Android apps use before
// a payment or an account-recovery change.
//
// LocalAuthentication.authenticateAsync with disableDeviceFallback:false
// already does the right thing on its own — Face ID/Touch ID/fingerprint
// first, falling back to the device's own passcode automatically if
// biometrics aren't available or fail. There's no separate PIN-entry UI to
// build here; the OS owns that fallback UI already (see
// DEVICE_TRUST_ARCHITECTURE-equivalent report's "OS owns the biometric
// prompt" note — this app cannot skin it, only trigger it).
import * as LocalAuthentication from 'expo-local-authentication';

export interface StepUpResult {
  ok: boolean;
  // True if there was nothing to authenticate against at all (no biometric
  // AND no device passcode configured) — the caller decides whether to
  // proceed anyway or block, since this app has no server-side way to
  // enforce step-up (see worker.js: securityPolicy.requireStepUpForSensitive
  // is informational/UX-level, not a server-enforced gate, same caveat as
  // the inactivity-timeout policy).
  unavailable: boolean;
}

export async function requireStepUpAuth(reason: string): Promise<StepUpResult> {
  const hasHardware = await LocalAuthentication.hasHardwareAsync().catch(() => false);
  const enrolledLevel = await LocalAuthentication.getEnrolledLevelAsync().catch(() => LocalAuthentication.SecurityLevel.NONE);
  if (!hasHardware && enrolledLevel === LocalAuthentication.SecurityLevel.NONE) {
    return { ok: true, unavailable: true };
  }
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: reason,
    fallbackLabel: 'Use device passcode',
    disableDeviceFallback: false,
  });
  return { ok: result.success, unavailable: false };
}
