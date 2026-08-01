import { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useTheme } from '../../src/hooks/useTheme';
import { useSessionStore } from '../../src/state/session';
import { PinKeypad } from '../../src/components/PinKeypad';
import { authErrorMessage } from '../../src/utils/authErrors';

export default function LockScreen() {
  const theme = useTheme();
  const displayName = useSessionStore((s) => s.displayName);
  const isLoading = useSessionStore((s) => s.isLoading);
  const unlockWithBiometric = useSessionStore((s) => s.unlockWithBiometric);
  const unlockWithPin = useSessionStore((s) => s.unlockWithPin);
  const [showPinFallback, setShowPinFallback] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempting, setAttempting] = useState(false);

  const tryBiometric = useCallback(async () => {
    setAttempting(true);
    setError(null);
    const ok = await unlockWithBiometric();
    setAttempting(false);
    if (!ok) {
      // Don't show a scary error for a simple cancel/dismiss — just offer
      // the PIN fallback quietly, same as how a normal phone lock screen
      // behaves when Face ID doesn't land.
      setShowPinFallback(true);
    }
  }, [unlockWithBiometric]);

  // Auto-prompt once on mount so unlocking is a single glance, not an
  // extra tap, for the common case.
  useEffect(() => {
    tryBiometric();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPinComplete = useCallback(
    async (pin: string) => {
      setError(null);
      const result = await unlockWithPin(pin);
      if (!result.ok) {
        setError(authErrorMessage(result.error, 0));
      }
    },
    [unlockWithPin]
  );

  return (
    <View style={[styles.container, { backgroundColor: theme.bg0 }]}>
      <View style={styles.header}>
        <Text style={[styles.logo, { color: theme.textHi }]}>PArA PIN</Text>
        <Text style={[styles.tagline, { color: theme.textMid }]}>
          {displayName ? `Welcome back, ${displayName}` : 'Locked'}
        </Text>
      </View>

      {!showPinFallback ? (
        <View style={styles.center}>
          <Pressable
            onPress={tryBiometric}
            disabled={attempting || isLoading}
            style={({ pressed }) => [
              styles.faceBtn,
              { borderColor: theme.glassBrdHi, backgroundColor: theme.glass, opacity: pressed ? 0.7 : 1 },
            ]}
          >
            <Text style={styles.faceEmoji}>🔓</Text>
          </Pressable>
          <Text style={[styles.hint, { color: theme.textMid }]}>Tap to unlock</Text>
          <Pressable onPress={() => setShowPinFallback(true)} hitSlop={8} style={{ marginTop: 8 }}>
            <Text style={[styles.pinFallbackLink, { color: theme.ice }]}>Use PIN instead</Text>
          </Pressable>
        </View>
      ) : (
        <PinKeypad onComplete={onPinComplete} loading={isLoading} error={error} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 32, padding: 24 },
  header: { alignItems: 'center', gap: 8 },
  logo: { fontSize: 22, fontWeight: '700', letterSpacing: 2 },
  tagline: { fontSize: 13, textAlign: 'center' },
  center: { alignItems: 'center', gap: 10 },
  faceBtn: {
    width: 88,
    height: 88,
    borderRadius: 44,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  faceEmoji: { fontSize: 34 },
  hint: { fontSize: 12.5 },
  pinFallbackLink: { fontSize: 12.5, fontWeight: '600' },
});
