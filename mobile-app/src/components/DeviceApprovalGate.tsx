// Mobile's side of web's device-link request flow (index.html:3404-3441 /
// #deviceApprovalOverlay). This was previously entirely missing on mobile —
// worker.js's device-trust gate (worker.js:1904-1913) already applied to
// mobile sign-ins (any account with one or more trusted devices rejects an
// unrecognized deviceId with `device_approval_required`), but mobile could
// only ever display that as a dead-end error message with no way to act on
// it. This component is the requesting-device half: generate a keypair
// (so the approving device has something to wrap chat keys against),
// request a 6-digit code, show it, and poll until an already-trusted
// device approves it.
import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { useTheme } from '../hooks/useTheme';
import { apiFetch } from '../api/client';
import { ensureMyE2eeKeyPair } from '../state/e2ee';

type Phase = 'intro' | 'requesting' | 'waiting' | 'expired' | 'error';

interface Props {
  pinHash: string;
  deviceId: string;
  onApproved: () => void;
  onCancel: () => void;
}

export function DeviceApprovalGate({ pinHash, deviceId, onApproved, onCancel }: Props) {
  const theme = useTheme();
  const [phase, setPhase] = useState<Phase>('intro');
  const [code, setCode] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, []);

  const startPolling = useCallback(() => {
    if (pollTimer.current) clearInterval(pollTimer.current);
    pollTimer.current = setInterval(async () => {
      const sr = await apiFetch<{ status: 'approved' | 'pending' | 'expired' | 'none' }>(
        `/device-link/status?deviceId=${encodeURIComponent(deviceId)}`,
        { headers: { 'X-Para-Pin-Hash': pinHash } }
      );
      if (!sr.ok) return;
      if (sr.body.status === 'approved') {
        if (pollTimer.current) clearInterval(pollTimer.current);
        onApproved();
      } else if (sr.body.status === 'expired' || sr.body.status === 'none') {
        if (pollTimer.current) clearInterval(pollTimer.current);
        setPhase('expired');
      }
    }, 4000);
  }, [deviceId, pinHash, onApproved]);

  const requestApproval = useCallback(async () => {
    setPhase('requesting');
    setErrorText(null);
    // Upload this device's public key BEFORE asking for approval — the
    // approving device needs it on hand to hand this device a chat-key
    // wrap the moment it approves (see rewrapAllChatsForDevice in
    // src/state/e2ee.ts), same ordering as web's requestApproval handler.
    await ensureMyE2eeKeyPair();
    const r = await apiFetch<{ code: string; expiresInSec: number }>('/device-link/request', {
      method: 'POST',
      headers: { 'X-Para-Pin-Hash': pinHash },
      body: JSON.stringify({ deviceId }),
    });
    if (!r.ok) {
      setPhase('error');
      setErrorText(
        r.body?.error === 'no_trusted_devices'
          ? "There's no trusted device to ask — an admin will need to reset this account's devices instead."
          : "Couldn't start that. Try again."
      );
      return;
    }
    setCode(r.body.code);
    setPhase('waiting');
    startPolling();
  }, [pinHash, deviceId, startPolling]);

  return (
    <View style={styles.container}>
      <Text style={[styles.title, { color: theme.textHi }]}>New device</Text>
      <Text style={[styles.body, { color: theme.textMid }]}>
        This PIN is already set up on another device. Ask whoever has it to approve this one from
        Settings.
      </Text>

      {phase === 'intro' || phase === 'error' ? (
        <>
          {errorText && <Text style={[styles.error, { color: theme.danger }]}>{errorText}</Text>}
          <Pressable
            onPress={requestApproval}
            style={({ pressed }) => [styles.primaryBtn, { backgroundColor: theme.ice, opacity: pressed ? 0.7 : 1 }]}
          >
            <Text style={styles.primaryBtnText}>Request approval</Text>
          </Pressable>
        </>
      ) : phase === 'requesting' ? (
        <ActivityIndicator color={theme.ice} style={{ marginTop: 8 }} />
      ) : phase === 'waiting' ? (
        <View style={styles.center}>
          <Text style={[styles.code, { color: theme.textHi }]}>{code}</Text>
          <View style={styles.waitingRow}>
            <ActivityIndicator color={theme.ice} />
            <Text style={[styles.hint, { color: theme.textMid }]}>Waiting for approval…</Text>
          </View>
        </View>
      ) : (
        <View style={styles.center}>
          <Text style={[styles.hint, { color: theme.textMid }]}>
            That request expired. Tap below to try again.
          </Text>
          <Pressable
            onPress={requestApproval}
            style={({ pressed }) => [styles.primaryBtn, { backgroundColor: theme.ice, opacity: pressed ? 0.7 : 1 }]}
          >
            <Text style={styles.primaryBtnText}>Request approval</Text>
          </Pressable>
        </View>
      )}

      <Pressable onPress={onCancel} hitSlop={8} style={{ marginTop: 18 }}>
        <Text style={[styles.cancel, { color: theme.textLow }]}>Cancel</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', gap: 10, maxWidth: 320 },
  title: { fontSize: 17, fontWeight: '700' },
  body: { fontSize: 13, textAlign: 'center', lineHeight: 19, marginBottom: 6 },
  error: { fontSize: 12.5, textAlign: 'center' },
  primaryBtn: { borderRadius: 999, paddingVertical: 12, paddingHorizontal: 28, marginTop: 4 },
  primaryBtnText: { color: '#0a0d12', fontWeight: '700', fontSize: 14 },
  center: { alignItems: 'center', gap: 10 },
  code: { fontSize: 34, fontWeight: '700', letterSpacing: 8 },
  waitingRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  hint: { fontSize: 12.5, textAlign: 'center' },
  cancel: { fontSize: 12.5, fontWeight: '600' },
});
