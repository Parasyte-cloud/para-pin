import { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Image } from 'react-native';
import { useTheme } from '../../src/hooks/useTheme';
import { useSessionStore } from '../../src/state/session';
import { PinKeypad } from '../../src/components/PinKeypad';
import { authErrorMessage } from '../../src/utils/authErrors';
import { AuthBackdrop } from '../../src/components/AuthBackdrop';

// Same badge+wordmark asset as pin.tsx — see the comment there.
const LOGO_ASPECT = 640 / 502;

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
        // Real status now (was hardcoded to 0) — see pin.tsx's onComplete.
        setError(authErrorMessage(result.error, result.status));
      }
    },
    [unlockWithPin]
  );

  return (
    <AuthBackdrop>
      <View style={styles.container}>
        <View style={styles.header}>
          <Image source={require('../../assets/lock-logo.png')} style={styles.logo} resizeMode="contain" />
          {/* Matches web's persistent lock-screen tagline (index.html:1532) verbatim. */}
          <Text style={[styles.tagline, { color: theme.textMid }]}>
            Your number is for everyone.{'\n'}Your PArA PIN is for the ones that matter.
          </Text>
          <Text style={[styles.status, { color: theme.textHi }]}>
            {displayName ? `Welcome back, ${displayName}` : 'Enter your PArA PIN'}
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

        {/* "Reset local PIN" / "Sign in with email instead" omitted here too
            — see pin.tsx's comment for why. */}
      </View>
    </AuthBackdrop>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 32, padding: 24 },
  header: { alignItems: 'center', gap: 8 },
  logo: { width: 168, height: 168 / LOGO_ASPECT, marginBottom: 4 },
  tagline: { fontSize: 13, textAlign: 'center', maxWidth: 300, lineHeight: 19 },
  status: { fontSize: 13.5, fontWeight: '600', textAlign: 'center', marginTop: 6 },
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
