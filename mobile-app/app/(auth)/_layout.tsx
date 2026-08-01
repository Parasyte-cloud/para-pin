import { Redirect, Stack } from 'expo-router';
import { useSessionStore } from '../../src/state/session';

export default function AuthLayout() {
  const pinHash = useSessionStore((s) => s.pinHash);
  const isLocked = useSessionStore((s) => s.isLocked);
  // Fully authenticated AND unlocked — nothing to do in this group.
  if (pinHash && !isLocked) return <Redirect href="/(tabs)" />;
  return <Stack screenOptions={{ headerShown: false }} />;
}
