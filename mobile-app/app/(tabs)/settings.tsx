import { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView, Switch, Platform, TextInput } from 'react-native';
import * as Notifications from 'expo-notifications';
import { useTheme } from '../../src/hooks/useTheme';
import { useSessionStore } from '../../src/state/session';
import { ensurePushRegistered, type PushRegisterResult } from '../../src/state/push';
import { apiFetch } from '../../src/api/client';
import { rewrapAllChatsForDevice } from '../../src/state/e2ee';
import type { ApiErrorBody } from '../../src/types';

const BIOMETRIC_LABEL = Platform.OS === 'ios' ? 'Face ID / Touch ID' : 'Fingerprint unlock';

export default function SettingsScreen() {
  const theme = useTheme();
  const displayName = useSessionStore((s) => s.displayName);
  const orgs = useSessionStore((s) => s.orgs);
  const logout = useSessionStore((s) => s.logout);
  const biometricEnabled = useSessionStore((s) => s.biometricEnabled);
  const biometricSupported = useSessionStore((s) => s.biometricSupported);
  const setBiometricEnabled = useSessionStore((s) => s.setBiometricEnabled);
  const [biometricBusy, setBiometricBusy] = useState(false);
  const [pushGranted, setPushGranted] = useState<boolean | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushRegisterResult, setPushRegisterResult] = useState<PushRegisterResult | null>(null);
  const [testPushBusy, setTestPushBusy] = useState(false);
  const [testPushResult, setTestPushResult] = useState<string | null>(null);
  const deviceId = useSessionStore((s) => s.deviceId);
  const [approveCode, setApproveCode] = useState('');
  const [approveBusy, setApproveBusy] = useState(false);
  const [approveMsg, setApproveMsg] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    Notifications.getPermissionsAsync()
      .then((p) => setPushGranted(!!p.granted))
      .catch(() => setPushGranted(null));
  }, []);

  const onToggleBiometric = async (next: boolean) => {
    setBiometricBusy(true);
    await setBiometricEnabled(next);
    setBiometricBusy(false);
  };

  const onEnablePush = async () => {
    setPushBusy(true);
    setPushRegisterResult(await ensurePushRegistered());
    const p = await Notifications.getPermissionsAsync().catch(() => null);
    setPushGranted(p ? !!p.granted : null);
    setPushBusy(false);
  };

  const pushRegisterReasonText = (r: PushRegisterResult | null): string | null => {
    if (!r || r.ok) return null;
    switch (r.reason) {
      case 'permission_denied':
        return "Notifications are blocked for this app — check your phone's system Settings > Notifications > PArA.";
      case 'unsupported_platform':
        return "Push isn't available on this platform.";
      case 'no_token':
        return "Couldn't get a device push token — if this is a simulator, that's expected (simulators can't receive real push).";
      case 'server_rejected':
        return `Server rejected registration (${r.detail || 'no detail'}).`;
      case 'exception':
        return `Registration failed: ${r.detail || 'unknown error'}`;
      default:
        return 'Registration failed for an unknown reason.';
    }
  };

  // Sends a real push straight to whatever's registered for this account
  // (worker.js's /api/push/test → /push-test) and reports exactly what
  // came back — delivered count, total registered targets, and per-target
  // errors (e.g. missing APNS_*/FCM_* secrets server-side, a dead token).
  // This turns "not getting notifications" from a total guessing game into
  // something with an actual answer.
  const onTestPush = async () => {
    setTestPushBusy(true);
    setTestPushResult(null);
    // /push-test (worker.js:5603) replies 200 even for the "nothing
    // registered" case, just with an `error` field alongside delivered:0 —
    // not a 4xx, so this has to be checked inside the ok branch too, not
    // just via !r.ok.
    const r = await apiFetch<{ delivered: number; total: number; errors?: string[]; error?: string }>('/push/test', {
      method: 'POST',
    });
    setTestPushBusy(false);
    if (!r.ok) {
      setTestPushResult("Couldn't run the test.");
      return;
    }
    if (r.body.error === 'no_subscriptions') {
      setTestPushResult('No push registered yet — tap Enable above first.');
      return;
    }
    const parts = [`${r.body.delivered}/${r.body.total} delivered`];
    if (r.body.errors?.length) parts.push(...r.body.errors);
    setTestPushResult(parts.join(' — '));
  };

  // Mirrors index.html's #approveDeviceSubmitBtn handler (index.html:3541-
  // 3573) — this is the counterpart to DeviceApprovalGate on the PIN/lock
  // screens. deviceId (this already-trusted device's own) is what lets the
  // server confirm a real trusted device is vouching, not just that
  // whoever's calling knows the shared PIN; see the server-side comment on
  // /device-link/approve in worker.js for why that distinction matters.
  const onApproveDevice = async () => {
    if (!/^\d{6}$/.test(approveCode.trim())) {
      setApproveMsg({ text: 'Enter the 6-digit code shown on the new device.', ok: false });
      return;
    }
    setApproveBusy(true);
    const r = await apiFetch<{ ok: true; approvedDeviceId?: string }>('/device-link/approve', {
      method: 'POST',
      body: JSON.stringify({ code: approveCode.trim(), deviceId }),
    });
    setApproveBusy(false);
    if (r.ok) {
      setApproveMsg({ text: 'Device approved.', ok: true });
      setApproveCode('');
      if (r.body.approvedDeviceId) rewrapAllChatsForDevice(r.body.approvedDeviceId); // fire-and-forget
      return;
    }
    const err = r.body as ApiErrorBody | null;
    const text =
      err?.error === 'wrong_code'
        ? "That code doesn't match."
        : err?.error === 'expired'
          ? 'That code expired.'
          : err?.error === 'not_a_trusted_device'
            ? "This device isn't trusted yet, so it can't approve others."
            : err?.error === 'rate_limited'
              ? `Too many attempts. Try again in ${err.retryAfterMs ? Math.ceil(err.retryAfterMs / 1000) : 'a bit'}s.`
              : "Couldn't approve that device. Try again.";
    setApproveMsg({ text, ok: false });
  };

  return (
    <ScrollView style={[styles.container, { backgroundColor: theme.bg0 }]} contentContainerStyle={styles.content}>
      <View style={[styles.card, { backgroundColor: theme.glass, borderColor: theme.glassBrd }]}>
        <Text style={[styles.label, { color: theme.textLow }]}>Signed in as</Text>
        <Text style={[styles.value, { color: theme.textHi }]}>{displayName || 'Someone'}</Text>
      </View>

      <View style={[styles.card, { backgroundColor: theme.glass, borderColor: theme.glassBrd }]}>
        <Text style={[styles.label, { color: theme.textLow }]}>Workspaces</Text>
        {orgs.length === 0 ? (
          <Text style={[styles.value, { color: theme.textMid }]}>Personal only</Text>
        ) : (
          orgs.map((org) => (
            <Text key={org.id ?? 'personal'} style={[styles.value, { color: theme.textHi }]}>
              {org.name}
            </Text>
          ))
        )}
      </View>

      <View style={[styles.card, { backgroundColor: theme.glass, borderColor: theme.glassBrd }]}>
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.value, { color: theme.textHi }]}>{BIOMETRIC_LABEL}</Text>
            <Text style={[styles.rowHint, { color: theme.textMid }]}>
              {biometricSupported
                ? 'Skip retyping your PIN on this device. Your PIN is still what’s sent to the server.'
                : 'Not available on this device — no biometric hardware, or none enrolled in system settings.'}
            </Text>
          </View>
          <Switch
            value={biometricEnabled}
            onValueChange={onToggleBiometric}
            disabled={!biometricSupported || biometricBusy}
            trackColor={{ true: theme.ice, false: theme.glassBrd }}
          />
        </View>
      </View>

      <View style={[styles.card, { backgroundColor: theme.glass, borderColor: theme.glassBrd }]}>
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.value, { color: theme.textHi }]}>Push notifications</Text>
            <Text style={[styles.rowHint, { color: theme.textMid }]}>
              {pushGranted
                ? 'Enabled — new messages and calls can reach you even when the app is closed.'
                : 'Off. The app still gets messages live while open (or briefly backgrounded); enable this so calls and messages can wake it up too.'}
            </Text>
          </View>
          {!pushGranted && (
            <Pressable
              onPress={onEnablePush}
              disabled={pushBusy}
              style={({ pressed }) => [
                styles.enableBtn,
                { backgroundColor: theme.ice, opacity: pushBusy ? 0.5 : pressed ? 0.7 : 1 },
              ]}
            >
              <Text style={{ color: '#0a0d12', fontWeight: '700', fontSize: 12.5 }}>Enable</Text>
            </Pressable>
          )}
        </View>
        {pushRegisterReasonText(pushRegisterResult) && (
          <Text style={[styles.rowHint, { color: theme.danger, marginTop: 6 }]}>{pushRegisterReasonText(pushRegisterResult)}</Text>
        )}
        <Pressable onPress={onTestPush} disabled={testPushBusy} hitSlop={8} style={{ marginTop: 8 }}>
          <Text style={{ color: theme.ice, fontSize: 12.5, fontWeight: '600' }}>
            {testPushBusy ? 'Sending test push…' : 'Send test push'}
          </Text>
        </Pressable>
        {testPushResult && (
          <Text style={[styles.rowHint, { color: theme.textMid, marginTop: 4 }]}>{testPushResult}</Text>
        )}
      </View>

      <View style={[styles.card, { backgroundColor: theme.glass, borderColor: theme.glassBrd }]}>
        <Text style={[styles.value, { color: theme.textHi }]}>Approve a new device</Text>
        <Text style={[styles.rowHint, { color: theme.textMid }]}>
          Signing in on another device? Enter the 6-digit code it shows you.
        </Text>
        <TextInput
          value={approveCode}
          onChangeText={(t) => {
            setApproveCode(t.replace(/[^0-9]/g, '').slice(0, 6));
            setApproveMsg(null);
          }}
          placeholder="6-digit code"
          placeholderTextColor={theme.textLow}
          keyboardType="number-pad"
          maxLength={6}
          style={[
            styles.codeInput,
            { color: theme.textHi, borderColor: theme.glassBrd, backgroundColor: theme.bg0 },
          ]}
        />
        {approveMsg && (
          <Text style={[styles.rowHint, { color: approveMsg.ok ? theme.ok : theme.danger }]}>{approveMsg.text}</Text>
        )}
        <Pressable
          onPress={onApproveDevice}
          disabled={approveBusy}
          style={({ pressed }) => [
            styles.approveBtn,
            { backgroundColor: theme.ice, opacity: approveBusy ? 0.5 : pressed ? 0.7 : 1 },
          ]}
        >
          <Text style={{ color: '#0a0d12', fontWeight: '700', fontSize: 13 }}>Approve</Text>
        </Pressable>
      </View>

      <Pressable
        onPress={() => logout()}
        style={({ pressed }) => [
          styles.signOutBtn,
          { borderColor: theme.glassBrd, backgroundColor: theme.glass, opacity: pressed ? 0.7 : 1 },
        ]}
      >
        <Text style={{ color: theme.danger, fontWeight: '600' }}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16, gap: 12 },
  card: { borderWidth: 1, borderRadius: 16, padding: 14, gap: 4 },
  label: { fontSize: 11.5, textTransform: 'uppercase', letterSpacing: 0.5 },
  value: { fontSize: 15, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowHint: { fontSize: 12, marginTop: 3, lineHeight: 16 },
  signOutBtn: { borderWidth: 1, borderRadius: 999, paddingVertical: 12, alignItems: 'center', marginTop: 8 },
  enableBtn: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9 },
  codeInput: {
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 16,
    fontSize: 16,
    textAlign: 'center',
    letterSpacing: 4,
    marginTop: 4,
  },
  approveBtn: { borderRadius: 999, paddingVertical: 10, alignItems: 'center', marginTop: 4 },
});
