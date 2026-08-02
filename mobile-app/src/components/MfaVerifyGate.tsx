// Mobile's counterpart to web's #mfaVerifyOverlay / openMfaVerifyFlow
// (index.html:3444-3533). Reached the same way device approval is: a
// failed /session call whose error body is `mfa_required`, carrying
// `methods: { totp, webauthn }` (worker.js:1926) so the UI only offers
// factors this account actually has configured.
//
// Scope cut: TOTP + backup codes only, not passkeys/WebAuthn. Web's
// passkey verify uses the browser's native `navigator.credentials.get()`
// WebAuthn API, which has no built-in React Native equivalent — it'd need
// a native module (e.g. react-native-passkey) wired through Face
// ID/fingerprint's platform authenticator, which is a separate, bigger
// piece of work than closing this sign-in dead end. An account with ONLY
// passkeys configured (no TOTP) still has no path forward on mobile;
// that's surfaced honestly below rather than shown a code box it can't
// satisfy, matching web's own `methods.totp !== false` gating.
import { useState } from 'react';
import { View, Text, Pressable, StyleSheet, TextInput } from 'react-native';
import { useTheme } from '../hooks/useTheme';
import { apiFetch } from '../api/client';

interface Props {
  pinHash: string;
  deviceId: string;
  methods: { totp?: boolean; webauthn?: boolean };
  onVerified: () => void;
  onCancel: () => void;
}

export function MfaVerifyGate({ pinHash, deviceId, methods, onVerified, onCancel }: Props) {
  const theme = useTheme();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Matches web's default: show the code box unless explicitly told
  // there's no TOTP (methods.totp === false) — backup codes go in the
  // same field, so it also covers a TOTP-configured account that lost
  // its authenticator.
  const showCode = methods.totp !== false;

  const submit = async () => {
    const trimmed = code.trim();
    if (!trimmed) {
      setError('Enter a code.');
      return;
    }
    setBusy(true);
    setError(null);
    const r = await apiFetch<{ ok: true; backupCodesRemaining: number }>('/mfa/verify-login', {
      method: 'POST',
      headers: { 'X-Para-Pin-Hash': pinHash },
      body: JSON.stringify({ deviceId, code: trimmed }),
    });
    setBusy(false);
    if (!r.ok) {
      setError(
        r.body?.error === 'invalid_code'
          ? "That code didn't work. Check the app and try again, or use a backup code."
          : r.body?.error === 'rate_limited'
            ? `Too many attempts. Try again in ${r.body.retryAfterMs ? Math.ceil(r.body.retryAfterMs / 1000) : 'a bit'}s.`
            : "Couldn't verify that. Try again."
      );
      return;
    }
    onVerified();
  };

  if (!showCode) {
    return (
      <View style={styles.container}>
        <Text style={[styles.title, { color: theme.textHi }]}>Verification code needed</Text>
        <Text style={[styles.body, { color: theme.textMid }]}>
          This account only has passkey verification set up, which isn't available in the app yet.
          Sign in from the web app to continue.
        </Text>
        <Pressable onPress={onCancel} hitSlop={8} style={{ marginTop: 14 }}>
          <Text style={[styles.cancel, { color: theme.textLow }]}>Back</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={[styles.title, { color: theme.textHi }]}>Verification code</Text>
      <Text style={[styles.body, { color: theme.textMid }]}>
        Enter the 6-digit code from your authenticator app, or one of your backup codes.
      </Text>
      <TextInput
        value={code}
        onChangeText={(t) => {
          setCode(t.toUpperCase());
          setError(null);
        }}
        placeholder="Code"
        placeholderTextColor={theme.textLow}
        autoCapitalize="characters"
        autoCorrect={false}
        maxLength={10}
        style={[styles.input, { color: theme.textHi, borderColor: theme.glassBrd, backgroundColor: theme.bg1 }]}
        onSubmitEditing={submit}
        returnKeyType="done"
        editable={!busy}
      />
      {error && <Text style={[styles.error, { color: theme.danger }]}>{error}</Text>}
      <Pressable
        onPress={submit}
        disabled={busy}
        style={({ pressed }) => [styles.primaryBtn, { backgroundColor: theme.ice, opacity: busy ? 0.5 : pressed ? 0.7 : 1 }]}
      >
        <Text style={styles.primaryBtnText}>Verify</Text>
      </Pressable>
      {methods.webauthn && (
        <Text style={[styles.hint, { color: theme.textLow }]}>
          This account also has a passkey set up — passkey sign-in isn't available in the app yet, but
          a code works too.
        </Text>
      )}
      <Pressable onPress={onCancel} hitSlop={8} style={{ marginTop: 14 }}>
        <Text style={[styles.cancel, { color: theme.textLow }]}>Cancel</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', gap: 10, maxWidth: 320 },
  title: { fontSize: 17, fontWeight: '700' },
  body: { fontSize: 13, textAlign: 'center', lineHeight: 19, marginBottom: 4 },
  input: {
    width: '100%',
    maxWidth: 260,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 12,
    paddingHorizontal: 18,
    fontSize: 18,
    textAlign: 'center',
    letterSpacing: 3,
    marginTop: 4,
  },
  error: { fontSize: 12.5, textAlign: 'center' },
  primaryBtn: { borderRadius: 999, paddingVertical: 12, paddingHorizontal: 28, marginTop: 4 },
  primaryBtnText: { color: '#0a0d12', fontWeight: '700', fontSize: 14 },
  hint: { fontSize: 11.5, textAlign: 'center', lineHeight: 16, marginTop: 6, maxWidth: 280 },
  cancel: { fontSize: 12.5, fontWeight: '600' },
});
