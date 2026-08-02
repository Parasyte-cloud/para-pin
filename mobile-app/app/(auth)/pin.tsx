import { useCallback, useState } from 'react';
import { View, Text, Pressable, StyleSheet, TextInput, KeyboardAvoidingView, Platform, Image } from 'react-native';
import { useTheme } from '../../src/hooks/useTheme';
import { useSessionStore } from '../../src/state/session';
import { PinKeypad } from '../../src/components/PinKeypad';
import { authErrorMessage } from '../../src/utils/authErrors';
import { AuthBackdrop } from '../../src/components/AuthBackdrop';

// lock-logo.png is the same badge+wordmark asset extracted from web's
// #lockLogoImg (index.html:1526), 640x502 transparent PNG — keeps the two
// clients showing the literal same artwork instead of a redrawn approximation.
const LOGO_ASPECT = 640 / 502;

export default function PinScreen() {
  const theme = useTheme();
  const submitPin = useSessionStore((s) => s.submitPin);
  const isLoading = useSessionStore((s) => s.isLoading);
  const [showName, setShowName] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const onComplete = useCallback(
    async (pin: string) => {
      setError(null);
      const result = await submitPin(pin, { displayName: name.trim() || undefined });
      if (!result.ok) {
        // Real status now (was hardcoded to 0), which masked every
        // non-network error as "Couldn't reach PArA" regardless of what
        // actually went wrong.
        setError(authErrorMessage(result.error, result.status));
      }
      // On success, app/_layout.tsx's Slot re-renders under (tabs) once
      // pinHash is set in the store — no manual navigation needed here.
    },
    [submitPin, name]
  );

  return (
    <AuthBackdrop>
      <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}>
          <Image source={require('../../assets/lock-logo.png')} style={styles.logo} resizeMode="contain" />
          {/* Matches web's persistent lock-screen tagline (index.html:1532) verbatim. */}
          <Text style={[styles.tagline, { color: theme.textMid }]}>
            Your number is for everyone.{'\n'}Your PArA PIN is for the ones that matter.
          </Text>
          <Text style={[styles.instruction, { color: theme.textHi }]}>
            Enter your 7-digit PIN. New here? Just make one up — it creates your account.
          </Text>
          <Pressable onPress={() => setShowName((s) => !s)} hitSlop={8}>
            <Text style={[styles.nameToggle, { color: theme.ice }]}>
              {showName ? 'Hide name field' : 'First time? Add your name'}
            </Text>
          </Pressable>
        </View>

        {showName && (
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Your name (first time only)"
            placeholderTextColor={theme.textLow}
            style={[
              styles.nameInput,
              { color: theme.textHi, borderColor: theme.glassBrd, backgroundColor: theme.glass },
            ]}
            autoCapitalize="words"
            editable={!isLoading}
          />
        )}

        <PinKeypad onComplete={onComplete} loading={isLoading} error={error} />

        {/* Web's lock screen also offers "Reset local PIN" (clears a
            LOCAL-only vault PIN) and "Sign in with email instead" (SSO/SAML
            for branded workspace domains — index.html:3814-3820). Neither
            maps onto mobile's architecture: there's no local vault-PIN
            concept here, and SSO/SAML sign-in isn't implemented in the app
            yet. Omitted rather than faked; revisit if/when mobile grows an
            SSO flow. */}
      </KeyboardAvoidingView>
    </AuthBackdrop>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 24, padding: 24 },
  header: { alignItems: 'center', gap: 8 },
  logo: { width: 168, height: 168 / LOGO_ASPECT, marginBottom: 4 },
  tagline: { fontSize: 13, textAlign: 'center', maxWidth: 300, lineHeight: 19 },
  instruction: { fontSize: 13.5, fontWeight: '600', textAlign: 'center', maxWidth: 300, marginTop: 6 },
  nameToggle: { fontSize: 12.5, fontWeight: '600', marginTop: 4 },
  nameInput: {
    width: '100%',
    maxWidth: 320,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 11,
    paddingHorizontal: 16,
    fontSize: 14,
  },
});
