import type { ApiErrorBody } from '../types';

// Shared between app/(auth)/pin.tsx (fresh login) and app/(auth)/lock.tsx
// (PIN fallback when biometrics fail/aren't used) so the two screens give
// identical wording for identical server responses.
export function authErrorMessage(error: ApiErrorBody | null, status: number): string {
  if (!error) return "Couldn't reach PArA. Check your connection and try again.";
  switch (error.error) {
    case 'rate_limited': {
      const secs = error.retryAfterMs ? Math.ceil(error.retryAfterMs / 1000) : null;
      return secs ? `Too many attempts. Try again in ${secs}s.` : 'Too many attempts. Try again shortly.';
    }
    case 'pin_disabled':
      return 'This PIN has been disabled. Contact your workspace admin.';
    case 'device_approval_required':
      return 'New device. Approve this device from one you already trust, then try again.';
    case 'mfa_required':
      return 'This account needs a verification code (MFA). That flow isn’t built into the app yet — sign in from the web app to complete it.';
    case 'wrong_pin':
      return "That's not the PIN this device is locked with.";
    default:
      return status === 0
        ? "Couldn't reach PArA. Check your connection and try again."
        : 'Something went wrong. Try again.';
  }
}
