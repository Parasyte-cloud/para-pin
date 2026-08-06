// Auto-lock after the app has been backgrounded for longer than the
// effective timeout — mirrors index.html's startInactivityTimer, adapted
// to mobile's app-lifecycle model instead of the DOM's visibilitychange +
// mouse/keyboard listeners.
//
// Deliberately background-time-based rather than true foreground-idle-time
// (no touch/keystroke for N seconds while the screen stays on): catching
// every touch across every screen would mean wrapping the entire app tree
// in a capture-phase touch listener, a much bigger change for a case the
// OS already partially covers on its own (the device's own screen-lock
// timeout already dims/locks the physical screen during real inactivity).
// "How long was this left unattended in the background" is the scenario
// that actually matters for a workspace chat app — someone else picking up
// an unlocked phone — and this covers it precisely. Noted as a scoping
// decision, not an oversight, in the architecture report.
import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useSessionStore, getEffectiveLockTimeoutSec } from '../state/session';

export function useInactivityAutoLock() {
  const pinHash = useSessionStore((s) => s.pinHash);
  const isLocked = useSessionStore((s) => s.isLocked);
  const lockNow = useSessionStore((s) => s.lockNow);
  const backgroundedAtRef = useRef<number | null>(null);

  useEffect(() => {
    const active = !!pinHash && !isLocked;
    if (!active) {
      backgroundedAtRef.current = null;
      return;
    }

    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'background') {
        // Only the transition INTO 'background' starts the clock — iOS
        // fires a transient 'inactive' for things like the app switcher
        // preview or Control Center that shouldn't count as "left
        // unattended," and background-timer coalescing on real background
        // means this timestamp is the only reliable clock anyway.
        backgroundedAtRef.current = Date.now();
      } else if (state === 'active' && backgroundedAtRef.current !== null) {
        const elapsedMs = Date.now() - backgroundedAtRef.current;
        const timeoutMs = getEffectiveLockTimeoutSec() * 1000;
        backgroundedAtRef.current = null;
        if (elapsedMs >= timeoutMs) lockNow();
      }
    });

    return () => sub.remove();
  }, [pinHash, isLocked, lockNow]);
}
