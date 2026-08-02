import { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView, Switch, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { useTheme } from '../../src/hooks/useTheme';
import { useSessionStore } from '../../src/state/session';
import { ensurePushRegistered } from '../../src/state/push';

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
    await ensurePushRegistered();
    const p = await Notifications.getPermissionsAsync().catch(() => null);
    setPushGranted(p ? !!p.granted : null);
    setPushBusy(false);
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
});
