// Mobile's counterpart to web's #mfaVerifyOverlay / openMfaVerifyFlow
// (index.html:3444-3533). Reached the same way device approval is: a
// failed /session call whose error body is `mfa_required`, carrying
// `methods: { totp, webauthn }` (worker.js:1926) so the UI only offers
// factors this account actually has configured.
//
// Scope cut: passkey/WebAuthn *verification* isn't built — web's passkey
// verify uses the browser's native `navigator.credentials.get()`, which
// has no built-in React Native equivalent (would need a native module
// like react-native-passkey, a separate piece of work). Instead of a dead
// end for a passkey-only account, this offers to set up TOTP right here:
// `/mfa/setup` and `/mfa/confirm` (worker.js:2113-2142) only require
// knowing the PIN (pinHash), not an already-established session or a
// trusted/MFA-cleared device — apiFetch already sends X-Para-Pin-Hash the
// moment a PIN's been typed in, well before /session ever succeeds, same
// as device approval's flow. So a stuck-on-passkey-only account can add
// TOTP without ever touching the web app.
import { useState } from 'react';
import { View, Text, Pressable, StyleSheet, TextInput, ActivityIndicator } from 'react-native';
import { useTheme } from '../hooks/useTheme';
import { apiFetch } from '../api/client';

interface Props {
  pinHash: string;
  deviceId: string;
  methods: { totp?: boolean; webauthn?: boolean };
  onVerified: () => void;
  onCancel: () => void;
}

type Phase = 'code' | 'passkeyOnly' | 'confirmSetup' | 'backupCodes' | 'verifyNewDevice';

export function MfaVerifyGate({ pinHash, deviceId, methods, onVerified, onCancel }: Props) {
  const theme = useTheme();
  const [phase, setPhase] = useState<Phase>(methods.totp !== false ? 'code' : 'passkeyOnly');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);

  const authedFetch = <T,>(path: string, body: Record<string, unknown>) =>
    apiFetch<T>(path, { method: 'POST', headers: { 'X-Para-Pin-Hash': pinHash }, body: JSON.stringify(body) });

  const verifyLogin = async (): Promise<boolean> => {
    const trimmed = code.trim();
    if (!trimmed) {
      setError('Enter a code.');
      return false;
    }
    setBusy(true);
    setError(null);
    const r = await authedFetch<{ ok: true; backupCodesRemaining: number }>('/mfa/verify-login', { deviceId, code: trimmed });
    setBusy(false);
    if (!r.ok) {
      setError(
        r.body?.error === 'invalid_code'
          ? "That code didn't work. Check the app and try again, or use a backup code."
          : r.body?.error === 'rate_limited'
            ? `Too many attempts. Try again in ${r.body.retryAfterMs ? Math.ceil(r.body.retryAfterMs / 1000) : 'a bit'}s.`
            : "Couldn't verify that. Try again."
      );
      return false;
    }
    return true;
  };

  const submitCode = async () => {
    if (await verifyLogin()) onVerified();
  };

  const startSetup = async () => {
    setBusy(true);
    setError(null);
    const r = await authedFetch<{ secret: string; otpauthUrl: string }>('/mfa/setup', {});
    setBusy(false);
    if (!r.ok) {
      setError(r.body?.error === 'already_enabled' ? 'An authenticator is already set up on this account.' : "Couldn't start setup. Try again.");
      return;
    }
    setSecret(r.body.secret);
    setCode('');
    setPhase('confirmSetup');
  };

  const confirmSetup = async () => {
    const trimmed = code.trim();
    if (!/^\d{6}$/.test(trimmed)) {
      setError('Enter the 6-digit code your authenticator app is showing.');
      return;
    }
    setBusy(true);
    setError(null);
    const r = await authedFetch<{ ok: true; backupCodes: string[] }>('/mfa/confirm', { code: trimmed });
    setBusy(false);
    if (!r.ok) {
      setError(r.body?.error === 'invalid_code' ? "That code didn't match. Check the time on your phone and try again." : "Couldn't confirm that. Try again.");
      return;
    }
    // Shown exactly once, right now — same as web's mfaSetupBackupCodes
    // step (index.html:9374), never retrievable again after this.
    setBackupCodes(r.body.backupCodes || []);
    setCode('');
    setPhase('backupCodes');
  };

  const continueToDeviceVerify = () => {
    // Confirming enables TOTP account-wide but doesn't itself clear THIS
    // device's mfaVerifiedDeviceIds entry (see /mfa/confirm, worker.js:
    // 2126-2142 — it has no deviceId in its request at all, deliberately
    // symmetric with web's flow, which always runs setup from an already-
    // signed-in session and never needed to). One more fresh code (the
    // just-used one may already be inside its 30s window and re-submitting
    // the identical string is asking for a redundant failure) via
    // /mfa/verify-login finishes clearing this specific device.
    setPhase('verifyNewDevice');
  };

  const finishVerifyNewDevice = async () => {
    if (await verifyLogin()) onVerified();
  };

  if (phase === 'passkeyOnly') {
    return (
      <View style={styles.container}>
        <Text style={[styles.title, { color: theme.textHi }]}>Verification needed</Text>
        <Text style={[styles.body, { color: theme.textMid }]}>
          This account only has passkey verification set up, which isn't available in the app yet.
        </Text>
        <Pressable
          onPress={startSetup}
          disabled={busy}
          style={({ pressed }) => [styles.primaryBtn, { backgroundColor: theme.ice, opacity: busy ? 0.5 : pressed ? 0.7 : 1 }]}
        >
          {busy ? <ActivityIndicator color="#0a0d12" /> : <Text style={styles.primaryBtnText}>Set up an authenticator app instead</Text>}
        </Pressable>
        {error && <Text style={[styles.error, { color: theme.danger }]}>{error}</Text>}
        <Pressable onPress={onCancel} hitSlop={8} style={{ marginTop: 14 }}>
          <Text style={[styles.cancel, { color: theme.textLow }]}>Sign in from web instead</Text>
        </Pressable>
      </View>
    );
  }

  if (phase === 'confirmSetup') {
    return (
      <View style={styles.container}>
        <Text style={[styles.title, { color: theme.textHi }]}>Set up your authenticator</Text>
        <Text style={[styles.body, { color: theme.textMid }]}>
          Add this key to an authenticator app (Google Authenticator, Authy, 1Password, etc.) — look
          for "Enter setup key manually" if it can't scan a code.
        </Text>
        <Text selectable style={[styles.secret, { color: theme.textHi, borderColor: theme.glassBrd, backgroundColor: theme.bg1 }]}>
          {secret}
        </Text>
        <Text style={[styles.body, { color: theme.textMid, marginTop: 8 }]}>Then enter the 6-digit code it shows:</Text>
        <TextInput
          value={code}
          onChangeText={(t) => {
            setCode(t.replace(/[^0-9]/g, '').slice(0, 6));
            setError(null);
          }}
          placeholder="123456"
          placeholderTextColor={theme.textLow}
          keyboardType="number-pad"
          maxLength={6}
          style={[styles.input, { color: theme.textHi, borderColor: theme.glassBrd, backgroundColor: theme.bg1 }]}
          onSubmitEditing={confirmSetup}
          returnKeyType="done"
          editable={!busy}
        />
        {error && <Text style={[styles.error, { color: theme.danger }]}>{error}</Text>}
        <Pressable
          onPress={confirmSetup}
          disabled={busy}
          style={({ pressed }) => [styles.primaryBtn, { backgroundColor: theme.ice, opacity: busy ? 0.5 : pressed ? 0.7 : 1 }]}
        >
          <Text style={styles.primaryBtnText}>Confirm</Text>
        </Pressable>
        <Pressable onPress={onCancel} hitSlop={8} style={{ marginTop: 14 }}>
          <Text style={[styles.cancel, { color: theme.textLow }]}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  if (phase === 'backupCodes') {
    return (
      <View style={styles.container}>
        <Text style={[styles.title, { color: theme.textHi }]}>Save your backup codes</Text>
        <Text style={[styles.body, { color: theme.textMid }]}>
          Each works once, if you ever lose access to your authenticator app. Shown only this once —
          save them somewhere safe now.
        </Text>
        <View style={[styles.codesBox, { borderColor: theme.glassBrd, backgroundColor: theme.bg1 }]}>
          {backupCodes.map((c) => (
            <Text key={c} selectable style={[styles.codeRow, { color: theme.textHi }]}>
              {c}
            </Text>
          ))}
        </View>
        <Pressable
          onPress={continueToDeviceVerify}
          style={({ pressed }) => [styles.primaryBtn, { backgroundColor: theme.ice, opacity: pressed ? 0.7 : 1 }]}
        >
          <Text style={styles.primaryBtnText}>I've saved them, continue</Text>
        </Pressable>
      </View>
    );
  }

  if (phase === 'verifyNewDevice') {
    return (
      <View style={styles.container}>
        <Text style={[styles.title, { color: theme.textHi }]}>Almost done</Text>
        <Text style={[styles.body, { color: theme.textMid }]}>
          Authenticator set up. Enter one more fresh code to finish verifying this device.
        </Text>
        <TextInput
          value={code}
          onChangeText={(t) => {
            setCode(t.replace(/[^0-9]/g, '').slice(0, 6));
            setError(null);
          }}
          placeholder="123456"
          placeholderTextColor={theme.textLow}
          keyboardType="number-pad"
          maxLength={6}
          style={[styles.input, { color: theme.textHi, borderColor: theme.glassBrd, backgroundColor: theme.bg1 }]}
          onSubmitEditing={finishVerifyNewDevice}
          returnKeyType="done"
          editable={!busy}
        />
        {error && <Text style={[styles.error, { color: theme.danger }]}>{error}</Text>}
        <Pressable
          onPress={finishVerifyNewDevice}
          disabled={busy}
          style={({ pressed }) => [styles.primaryBtn, { backgroundColor: theme.ice, opacity: busy ? 0.5 : pressed ? 0.7 : 1 }]}
        >
          <Text style={styles.primaryBtnText}>Verify</Text>
        </Pressable>
        <Pressable onPress={onCancel} hitSlop={8} style={{ marginTop: 14 }}>
          <Text style={[styles.cancel, { color: theme.textLow }]}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  // phase === 'code' — normal TOTP/backup-code entry for an account that
  // already has TOTP configured.
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
        onSubmitEditing={submitCode}
        returnKeyType="done"
        editable={!busy}
      />
      {error && <Text style={[styles.error, { color: theme.danger }]}>{error}</Text>}
      <Pressable
        onPress={submitCode}
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
  secret: {
    width: '100%',
    maxWidth: 280,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'center',
    letterSpacing: 1.5,
    marginTop: 4,
  },
  codesBox: {
    width: '100%',
    maxWidth: 280,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    gap: 6,
    marginTop: 4,
  },
  codeRow: { fontSize: 14, fontWeight: '700', textAlign: 'center', letterSpacing: 1.5 },
  error: { fontSize: 12.5, textAlign: 'center' },
  primaryBtn: { borderRadius: 999, paddingVertical: 12, paddingHorizontal: 28, marginTop: 4, alignItems: 'center', minWidth: 120 },
  primaryBtnText: { color: '#0a0d12', fontWeight: '700', fontSize: 14, textAlign: 'center' },
  hint: { fontSize: 11.5, textAlign: 'center', lineHeight: 16, marginTop: 6, maxWidth: 280 },
  cancel: { fontSize: 12.5, fontWeight: '600' },
});
