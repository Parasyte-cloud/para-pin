import { useCallback, useState } from 'react';
import { View, Text, Pressable, StyleSheet, TextInput, KeyboardAvoidingView, Platform } from 'react-native';
import { useTheme } from '../../src/hooks/useTheme';
import { useSessionStore } from '../../src/state/session';
import { PinKeypad } from '../../src/components/PinKeypad';
import { authErrorMessage } from '../../src/utils/authErrors';

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
        setError(authErrorMessage(result.error, 0));
      }
      // On success, app/_layout.tsx's Slot re-renders under (tabs) once
      // pinHash is set in the store — no manual navigation needed here.
    },
    [submitPin, name]
  );

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: theme.bg0 }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.header}>
        <Text style={[styles.logo, { color: theme.textHi }]}>PArA PIN</Text>
        <Text style={[styles.tagline, { color: theme.textMid }]}>
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
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 24, padding: 24 },
  header: { alignItems: 'center', gap: 8 },
  logo: { fontSize: 22, fontWeight: '700', letterSpacing: 2 },
  tagline: { fontSize: 13, textAlign: 'center', maxWidth: 300, lineHeight: 19 },
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
