import { Redirect } from 'expo-router';
import { useSessionStore } from '../src/state/session';

// Root layout only renders once isHydrated is true (see app/_layout.tsx),
// so by the time this evaluates, pinHash/isLocked reflect real state —
// safe to route on directly. Three destinations: no credential at all →
// full PIN/create-account screen; credential present but device-locked
// behind biometrics → lock screen; credential present and unlocked →
// straight into the app.
export default function Index() {
  const pinHash = useSessionStore((s) => s.pinHash);
  const isLocked = useSessionStore((s) => s.isLocked);
  if (pinHash && isLocked) return <Redirect href="/(auth)/lock" />;
  return <Redirect href={pinHash ? '/(tabs)' : '/(auth)/pin'} />;
}
