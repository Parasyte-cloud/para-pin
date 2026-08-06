import { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView, Switch, Platform, TextInput, Alert, Image } from 'react-native';
import * as Notifications from 'expo-notifications';
import { useTheme } from '../../src/hooks/useTheme';
import { useSessionStore, getEffectiveLockTimeoutSec, LOCK_TIMEOUT_TIERS } from '../../src/state/session';
import { ensurePushRegistered, type PushRegisterResult } from '../../src/state/push';
import { apiFetch } from '../../src/api/client';
import { rewrapAllChatsForDevice, resyncAllMyDevices } from '../../src/state/e2ee';
import { AuthBackdrop } from '../../src/components/AuthBackdrop';
import { requireStepUpAuth } from '../../src/utils/stepUpAuth';
import { resolveNames, getCachedName } from '../../src/state/names';
import AvatarViewer from '../../src/components/AvatarViewer';
import type { ApiErrorBody } from '../../src/types';

const AVATAR_VISIBILITY_OPTIONS: { key: string; label: string }[] = [
  { key: 'everyone', label: 'Everyone' },
  { key: 'contacts', label: 'Contacts' },
  { key: 'workspace', label: 'Workspace' },
  { key: 'nobody', label: 'Nobody' },
  { key: 'custom', label: 'Custom' },
];

interface AvatarHistoryEntry {
  url: string;
  uploadedAt: number | null;
  orgId: string | null;
}

const BIOMETRIC_LABEL = Platform.OS === 'ios' ? 'Face ID / Touch ID' : 'Fingerprint unlock';

interface DeviceRecord {
  id: string;
  label: string;
  platform: string;
  browser: string | null;
  osVersion: string | null;
  manufacturer: string | null;
  model: string | null;
  isEmulator: boolean | null;
  ip: string | null;
  country: string | null;
  city: string | null;
  addedAt: number | null;
  lastSeenAt: number | null;
  sessionCount: number;
  riskScore: number;
  status: string;
  trustLevel: string;
  expiresAt: number | null;
  oneTimeUse: boolean;
}

interface UnknownDeviceRecord {
  id: string;
  label: string;
  platform: string;
  ip: string | null;
  country: string | null;
  city: string | null;
  requestedAt: number;
}

const TRUST_BADGE: Record<string, { label: string; color: string }> = {
  trusted: { label: 'Trusted', color: '#7ee08a' },
  temporary: { label: 'Temporary', color: '#ffd166' },
  revoked: { label: 'Revoked', color: '#8a93a3' },
  lost: { label: 'Lost', color: '#ff9a4a' },
  compromised: { label: 'Compromised', color: '#ff6a6a' },
};

function formatLastSeen(ts: number | null): string {
  if (!ts) return 'never';
  const diffMs = Date.now() - ts;
  if (diffMs < 5 * 60000) return 'just now';
  if (diffMs < 60 * 60000) return `${Math.floor(diffMs / 60000)}m ago`;
  if (diffMs < 24 * 60 * 60000) return `${Math.floor(diffMs / (60 * 60000))}h ago`;
  return `${Math.floor(diffMs / (24 * 60 * 60000))}d ago`;
}

function riskColor(score: number, theme: { danger: string; textMid: string; ok: string }): string {
  if (score >= 60) return theme.danger;
  if (score >= 30) return '#ffd166';
  return theme.ok;
}

function locationLine(d: { city: string | null; country: string | null; ip: string | null }): string {
  const parts = [d.city, d.country].filter(Boolean);
  return parts.length ? parts.join(', ') : d.ip || 'Unknown location';
}

function lockTimeoutLabel(sec: number): string {
  if (sec === 0) return 'Immediately';
  if (sec < 60) return `${sec}s`;
  return `${Math.round(sec / 60)}m`;
}

export default function SettingsScreen() {
  const theme = useTheme();
  const displayName = useSessionStore((s) => s.displayName);
  const orgs = useSessionStore((s) => s.orgs);
  const logout = useSessionStore((s) => s.logout);
  const biometricEnabled = useSessionStore((s) => s.biometricEnabled);
  const biometricSupported = useSessionStore((s) => s.biometricSupported);
  const setBiometricEnabled = useSessionStore((s) => s.setBiometricEnabled);
  const [biometricBusy, setBiometricBusy] = useState(false);
  const lockTimeoutSec = useSessionStore((s) => s.lockTimeoutSec);
  const setLockTimeoutSec = useSessionStore((s) => s.setLockTimeoutSec);
  // Recomputed on every render off the live store (orgs/lockTimeoutSec are
  // both already subscribed in this component, so this stays in sync
  // without its own effect) — cheap enough (a handful of comparisons) not
  // to worry about memoizing.
  const effectiveLockTimeout = getEffectiveLockTimeoutSec();
  const [pushGranted, setPushGranted] = useState<boolean | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushRegisterResult, setPushRegisterResult] = useState<PushRegisterResult | null>(null);
  const [testPushBusy, setTestPushBusy] = useState(false);
  const [testPushResult, setTestPushResult] = useState<string | null>(null);
  const deviceId = useSessionStore((s) => s.deviceId);
  const [approveCode, setApproveCode] = useState('');
  const [approveBusy, setApproveBusy] = useState(false);
  const [approveMsg, setApproveMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [resyncBusy, setResyncBusy] = useState(false);
  const [resyncMsg, setResyncMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [approveMode, setApproveMode] = useState<'permanent' | 'temporary' | 'one-time'>('permanent');
  const [approveDuration, setApproveDuration] = useState('24');
  const [rejectBusy, setRejectBusy] = useState(false);
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [unknownDevices, setUnknownDevices] = useState<UnknownDeviceRecord[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [deviceActionBusyId, setDeviceActionBusyId] = useState<string | null>(null);
  const [rejectUnknownBusyId, setRejectUnknownBusyId] = useState<string | null>(null);

  // ---------------- profile photo privacy ----------------
  const myUserId = useSessionStore((s) => s.userId);
  const myAvatarUrl = useSessionStore((s) => s.avatarUrl);
  const chats = useSessionStore((s) => s.chats);
  const [avatarVisibility, setAvatarVisibility] = useState('everyone');
  const [avatarCustomIds, setAvatarCustomIds] = useState<Set<string>>(new Set());
  const [avatarPrivacyLoading, setAvatarPrivacyLoading] = useState(true);
  const [avatarPrivacySaving, setAvatarPrivacySaving] = useState(false);
  const [avatarPrivacyMsg, setAvatarPrivacyMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [namesVersion, setNamesVersion] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<AvatarHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [ownViewerOpen, setOwnViewerOpen] = useState(false);
  const [historyViewerUri, setHistoryViewerUri] = useState<string | null>(null);

  // DM contacts, same source the Chats tab already resolves names from —
  // this is the pool a "custom list" pick can draw from, since personal
  // accounts have no other browsable directory (see MembersModal.tsx's own
  // scope note for the same limitation).
  const dmContactIds = chats.filter((c) => c.type === 'dm').map((c) => c.memberIds?.find((id) => id !== myUserId)).filter((id): id is string => !!id);

  useEffect(() => {
    if (dmContactIds.length === 0) return;
    let cancelled = false;
    resolveNames(dmContactIds).then(() => {
      if (!cancelled) setNamesVersion((v) => v + 1);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats.length]);

  useEffect(() => {
    setAvatarPrivacyLoading(true);
    apiFetch<{ visibility?: string; customListUserIds?: string[] }>('/profile/avatar-privacy')
      .then((r) => {
        if (r.ok && r.body) {
          setAvatarVisibility(r.body.visibility || 'everyone');
          setAvatarCustomIds(new Set(r.body.customListUserIds || []));
        }
      })
      .finally(() => setAvatarPrivacyLoading(false));
  }, []);

  const toggleCustomId = (id: string) => {
    setAvatarCustomIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const saveAvatarPrivacy = async () => {
    setAvatarPrivacySaving(true);
    setAvatarPrivacyMsg(null);
    const body: { visibility: string; customListUserIds?: string[] } = { visibility: avatarVisibility };
    if (avatarVisibility === 'custom') body.customListUserIds = [...avatarCustomIds];
    const r = await apiFetch('/profile/avatar-privacy', { method: 'POST', body: JSON.stringify(body) });
    setAvatarPrivacySaving(false);
    setAvatarPrivacyMsg(r.ok ? { text: 'Saved.', ok: true } : { text: "Couldn't save. Try again.", ok: false });
  };

  const openHistory = async () => {
    setHistoryOpen(true);
    setHistoryLoading(true);
    const r = await apiFetch<{ history?: AvatarHistoryEntry[] }>('/profile/avatar-history');
    setHistoryLoading(false);
    if (r.ok && r.body?.history) setHistoryEntries(r.body.history);
  };

  const refreshDevices = async () => {
    setDevicesLoading(true);
    const r = await apiFetch<{ devices?: DeviceRecord[]; unknownDevices?: UnknownDeviceRecord[] }>('/devices');
    setDevicesLoading(false);
    if (r.ok && r.body) {
      setDevices(Array.isArray(r.body.devices) ? r.body.devices : []);
      setUnknownDevices(Array.isArray(r.body.unknownDevices) ? r.body.unknownDevices : []);
    }
  };

  useEffect(() => {
    Notifications.getPermissionsAsync()
      .then((p) => setPushGranted(!!p.granted))
      .catch(() => setPushGranted(null));
    refreshDevices();
  }, []);

  const onDeviceStatusAction = async (id: string, action: 'mark-lost' | 'mark-compromised' | 'remove') => {
    setDeviceActionBusyId(id);
    const path = action === 'remove' ? '/devices/remove' : `/devices/${action}`;
    const r = await apiFetch(path, { method: 'POST', body: JSON.stringify({ id }) });
    setDeviceActionBusyId(null);
    if (r.ok) refreshDevices();
  };

  const onRejectUnknown = async (targetDeviceId: string) => {
    setRejectUnknownBusyId(targetDeviceId);
    const r = await apiFetch('/device-link/reject', {
      method: 'POST',
      body: JSON.stringify({ deviceId, targetDeviceId }),
    });
    setRejectUnknownBusyId(null);
    if (r.ok) refreshDevices();
  };

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
    // Step-up confirmation — unconditional, not gated by any workspace
    // policy, since granting a brand-new device full account access is
    // high-value enough to warrant it regardless of org settings. Skips
    // silently (unavailable:true) only if this device itself has neither
    // biometrics nor a passcode configured — nothing to confirm against.
    const stepUp = await requireStepUpAuth('Confirm approving this device');
    if (!stepUp.ok && !stepUp.unavailable) {
      setApproveMsg({ text: 'Confirmation failed — try again.', ok: false });
      return;
    }
    setApproveBusy(true);
    const durationHours = approveMode === 'temporary' ? parseInt(approveDuration, 10) || 24 : null;
    const r = await apiFetch<{ ok: true; approvedDeviceId?: string }>('/device-link/approve', {
      method: 'POST',
      body: JSON.stringify({ code: approveCode.trim(), deviceId, mode: approveMode, durationHours }),
    });
    setApproveBusy(false);
    if (r.ok) {
      setApproveMsg({ text: 'Device approved.', ok: true });
      setApproveCode('');
      if (r.body.approvedDeviceId) rewrapAllChatsForDevice(r.body.approvedDeviceId); // fire-and-forget
      refreshDevices();
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

  // Reject shares the same code-entry box as approve — declining still
  // needs the physical-proximity proof (the code), same as approving does;
  // the codeless one-click path (targetDeviceId, no code) is reserved for
  // the Unknown devices list below, see onRejectUnknown and worker.js's
  // /device-link/reject comment for why that split is safe.
  const onRejectDevice = async () => {
    if (!/^\d{6}$/.test(approveCode.trim())) {
      setApproveMsg({ text: 'Enter the 6-digit code shown on the device to reject it.', ok: false });
      return;
    }
    setRejectBusy(true);
    const r = await apiFetch('/device-link/reject', {
      method: 'POST',
      body: JSON.stringify({ code: approveCode.trim(), deviceId }),
    });
    setRejectBusy(false);
    if (r.ok) {
      setApproveMsg({ text: 'Request rejected.', ok: true });
      setApproveCode('');
      refreshDevices();
      return;
    }
    const err = r.body as ApiErrorBody | null;
    setApproveMsg({
      text: err?.error === 'wrong_code' ? "That code doesn't match." : err?.error === 'expired' ? 'That code already expired.' : "Couldn't reject that. Try again.",
      ok: false,
    });
  };

  // Mobile-native version of web's Settings > Devices "Re-sync keys" button
  // (index.html:9174-9176) — see resyncAllMyDevices's own header comment in
  // state/e2ee.ts for the full reasoning. Without this, a device stuck
  // missing a chat-key wrap (e.g. the automatic rewrap right after approval
  // silently dropped one request) had no self-service fix at all unless
  // someone on the account also happened to have a web session open.
  const onResync = async () => {
    setResyncBusy(true);
    setResyncMsg(null);
    const r = await resyncAllMyDevices();
    setResyncBusy(false);
    if (r.devicesWrapped === 0) {
      setResyncMsg({ text: 'No other devices on this account to sync with yet.', ok: true });
      return;
    }
    if (r.failed > 0) {
      setResyncMsg({
        text: `Synced what it could (${r.chatsAttempted - r.failed}/${r.chatsAttempted} chat keys across ${r.devicesWrapped} device${r.devicesWrapped === 1 ? '' : 's'}) — ${r.failed} failed. Try again in a bit.`,
        ok: false,
      });
      return;
    }
    setResyncMsg({
      text: `Done — synced ${r.chatsAttempted} chat key${r.chatsAttempted === 1 ? '' : 's'} across ${r.devicesWrapped} other device${r.devicesWrapped === 1 ? '' : 's'} on this account.`,
      ok: true,
    });
  };

  return (
    <AuthBackdrop>
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
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
            accessibilityLabel={`${BIOMETRIC_LABEL} unlock`}
            accessibilityHint={biometricSupported ? undefined : 'Not available on this device'}
          />
        </View>
      </View>

      <View style={[styles.card, { backgroundColor: theme.glass, borderColor: theme.glassBrd }]}>
        <Text style={[styles.value, { color: theme.textHi }]}>Auto-lock</Text>
        <Text style={[styles.rowHint, { color: theme.textMid }]}>
          How long the app can sit in the background before it requires {BIOMETRIC_LABEL.toLowerCase()} or your PIN again.
        </Text>
        <View style={styles.modeRow}>
          {LOCK_TIMEOUT_TIERS.map((sec) => (
            <Pressable
              key={sec}
              onPress={() => setLockTimeoutSec(sec)}
              accessibilityRole="button"
              accessibilityLabel={lockTimeoutLabel(sec)}
              accessibilityState={{ selected: lockTimeoutSec === sec }}
              style={[
                styles.modePill,
                { borderColor: lockTimeoutSec === sec ? theme.ice : theme.glassBrd, backgroundColor: lockTimeoutSec === sec ? theme.ice : 'transparent' },
              ]}
            >
              <Text style={{ color: lockTimeoutSec === sec ? '#0a0d12' : theme.textMid, fontSize: 11.5, fontWeight: '700' }}>
                {lockTimeoutLabel(sec)}
              </Text>
            </Pressable>
          ))}
        </View>
        {effectiveLockTimeout < lockTimeoutSec && (
          <Text style={[styles.rowHint, { color: theme.textMid, marginTop: 6 }]}>
            A workspace you're in requires {lockTimeoutLabel(effectiveLockTimeout).toLowerCase()} — that stricter setting is what's actually enforced.
          </Text>
        )}
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
        <Text style={[styles.rowHint, { color: theme.textMid, marginTop: 10 }]}>Access level</Text>
        <View style={styles.modeRow}>
          {(['permanent', 'temporary', 'one-time'] as const).map((m) => (
            <Pressable
              key={m}
              onPress={() => setApproveMode(m)}
              style={[
                styles.modePill,
                {
                  borderColor: approveMode === m ? theme.ice : theme.glassBrd,
                  backgroundColor: approveMode === m ? theme.ice : 'transparent',
                },
              ]}
            >
              <Text style={{ color: approveMode === m ? '#0a0d12' : theme.textMid, fontSize: 11.5, fontWeight: '700' }}>
                {m === 'permanent' ? 'Permanent' : m === 'temporary' ? 'Temporary' : 'One-time'}
              </Text>
            </Pressable>
          ))}
        </View>
        {approveMode === 'temporary' && (
          <TextInput
            value={approveDuration}
            onChangeText={(t) => setApproveDuration(t.replace(/[^0-9]/g, '').slice(0, 3))}
            placeholder="Hours"
            placeholderTextColor={theme.textLow}
            keyboardType="number-pad"
            style={[styles.codeInput, { color: theme.textHi, borderColor: theme.glassBrd, backgroundColor: theme.bg0, letterSpacing: 0, marginTop: 8 }]}
          />
        )}
        {approveMsg && (
          <Text style={[styles.rowHint, { color: approveMsg.ok ? theme.ok : theme.danger }]}>{approveMsg.text}</Text>
        )}
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
          <Pressable
            onPress={onRejectDevice}
            disabled={rejectBusy}
            style={({ pressed }) => [
              styles.approveBtn,
              { flex: 1, borderWidth: 1, borderColor: theme.danger, opacity: rejectBusy ? 0.5 : pressed ? 0.7 : 1 },
            ]}
          >
            <Text style={{ color: theme.danger, fontWeight: '700', fontSize: 13 }}>Reject</Text>
          </Pressable>
          <Pressable
            onPress={onApproveDevice}
            disabled={approveBusy}
            style={({ pressed }) => [
              styles.approveBtn,
              { flex: 1, backgroundColor: theme.ice, opacity: approveBusy ? 0.5 : pressed ? 0.7 : 1 },
            ]}
          >
            <Text style={{ color: '#0a0d12', fontWeight: '700', fontSize: 13 }}>Approve</Text>
          </Pressable>
        </View>
      </View>

      {unknownDevices.length > 0 && (
        <View style={[styles.card, { backgroundColor: theme.glass, borderColor: theme.glassBrd }]}>
          <Text style={[styles.value, { color: theme.textHi }]}>Unknown devices — waiting for approval</Text>
          {unknownDevices.map((d) => (
            <View key={d.id} style={[styles.deviceRow, { borderColor: 'rgba(255,209,102,0.4)' }]}>
              <View style={styles.row}>
                <Text style={[styles.value, { color: theme.textHi, flex: 1 }]}>{d.label}</Text>
                <View style={[styles.badge, { borderColor: '#ffd166' }]}>
                  <Text style={{ color: '#ffd166', fontSize: 10.5, fontWeight: '700' }}>Unknown</Text>
                </View>
              </View>
              <Text style={[styles.rowHint, { color: theme.textMid }]}>
                {locationLine(d)} · requested {formatLastSeen(d.requestedAt)}
              </Text>
              <Pressable
                onPress={() =>
                  Alert.alert('Reject this device?', undefined, [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Reject', style: 'destructive', onPress: () => onRejectUnknown(d.id) },
                  ])
                }
                disabled={rejectUnknownBusyId === d.id}
                style={{ marginTop: 6, alignSelf: 'flex-start' }}
              >
                <Text style={{ color: theme.danger, fontSize: 12.5, fontWeight: '600' }}>
                  {rejectUnknownBusyId === d.id ? 'Rejecting…' : 'Reject'}
                </Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}

      <View style={[styles.card, { backgroundColor: theme.glass, borderColor: theme.glassBrd }]}>
        <View style={styles.row}>
          <Text style={[styles.value, { color: theme.textHi, flex: 1 }]}>Devices signed in to this account</Text>
          {devicesLoading && <Text style={[styles.rowHint, { color: theme.textMid }]}>Loading…</Text>}
        </View>
        {devices.length === 0 && !devicesLoading && (
          <Text style={[styles.rowHint, { color: theme.textMid }]}>No devices found.</Text>
        )}
        {devices.map((d) => {
          const isCurrent = d.id === deviceId;
          const badge = TRUST_BADGE[d.trustLevel] || TRUST_BADGE.trusted;
          const revoked = d.status === 'revoked' || d.status === 'lost' || d.status === 'compromised';
          const detailBits = [d.browser, d.osVersion, [d.manufacturer, d.model].filter(Boolean).join(' ') || null, d.isEmulator ? 'Emulator' : null]
            .filter(Boolean)
            .join(' · ');
          return (
            <View key={d.id} style={[styles.deviceRow, { borderColor: theme.glassBrd }]}>
              <View style={styles.row}>
                <Text style={[styles.value, { color: theme.textHi, flex: 1 }]}>
                  {d.label}{isCurrent ? ' (this device)' : ''}
                </Text>
                <View style={[styles.badge, { borderColor: badge.color }]}>
                  <Text style={{ color: badge.color, fontSize: 10.5, fontWeight: '700' }}>{badge.label}</Text>
                </View>
              </View>
              <Text style={[styles.rowHint, { color: theme.textMid }]}>
                {detailBits ? `${detailBits} · ` : ''}{locationLine(d)}
              </Text>
              <Text style={[styles.rowHint, { color: theme.textMid }]}>
                Active {formatLastSeen(d.lastSeenAt)} · {d.sessionCount} session{d.sessionCount === 1 ? '' : 's'} ·{' '}
                Risk <Text style={{ color: riskColor(d.riskScore, theme), fontWeight: '700' }}>{d.riskScore}</Text>
                {d.expiresAt ? ` · expires ${new Date(d.expiresAt).toLocaleDateString()}` : ''}
                {d.oneTimeUse ? ' · one-time' : ''}
              </Text>
              {!isCurrent && (
                <View style={styles.deviceActions}>
                  <Pressable
                    onPress={async () => {
                      setDeviceActionBusyId(d.id);
                      await rewrapAllChatsForDevice(d.id);
                      setDeviceActionBusyId(null);
                    }}
                    disabled={deviceActionBusyId === d.id}
                  >
                    <Text style={{ color: theme.ice, fontSize: 12, fontWeight: '600' }}>Re-sync keys</Text>
                  </Pressable>
                  {!revoked && (
                    <>
                      <Pressable
                        onPress={() =>
                          Alert.alert('Mark this device lost?', 'It will be blocked from signing in again until you restore it.', [
                            { text: 'Cancel', style: 'cancel' },
                            { text: 'Mark lost', style: 'destructive', onPress: () => onDeviceStatusAction(d.id, 'mark-lost') },
                          ])
                        }
                        disabled={deviceActionBusyId === d.id}
                      >
                        <Text style={{ color: '#ff9a4a', fontSize: 12, fontWeight: '600' }}>Mark lost</Text>
                      </Pressable>
                      <Pressable
                        onPress={() =>
                          Alert.alert(
                            'Mark this device compromised?',
                            'It will be permanently blocked from signing in. Consider changing your PIN too.',
                            [
                              { text: 'Cancel', style: 'cancel' },
                              { text: 'Mark compromised', style: 'destructive', onPress: () => onDeviceStatusAction(d.id, 'mark-compromised') },
                            ]
                          )
                        }
                        disabled={deviceActionBusyId === d.id}
                      >
                        <Text style={{ color: theme.danger, fontSize: 12, fontWeight: '600' }}>Mark compromised</Text>
                      </Pressable>
                    </>
                  )}
                  <Pressable
                    onPress={() =>
                      Alert.alert(revoked ? 'Remove this device?' : 'Log this device out?', 'It will need to be re-approved to sign back in.', [
                        { text: 'Cancel', style: 'cancel' },
                        { text: revoked ? 'Remove' : 'Log out', style: 'destructive', onPress: () => onDeviceStatusAction(d.id, 'remove') },
                      ])
                    }
                    disabled={deviceActionBusyId === d.id}
                  >
                    <Text style={{ color: theme.textMid, fontSize: 12, fontWeight: '600' }}>{revoked ? 'Remove' : 'Revoke / log out'}</Text>
                  </Pressable>
                </View>
              )}
            </View>
          );
        })}
      </View>

      <View style={[styles.card, { backgroundColor: theme.glass, borderColor: theme.glassBrd }]}>
        <Text style={[styles.value, { color: theme.textHi }]}>Re-sync encryption keys</Text>
        <Text style={[styles.rowHint, { color: theme.textMid }]}>
          If messages aren't decrypting on one of your other devices (another phone, or the web app), tap this on a
          device that already has them working. It re-sends this device's copy of every chat key to your other
          devices — safe to run any time.
        </Text>
        <Pressable
          onPress={onResync}
          disabled={resyncBusy}
          style={({ pressed }) => [
            styles.approveBtn,
            { backgroundColor: theme.ice, opacity: resyncBusy ? 0.5 : pressed ? 0.7 : 1 },
          ]}
        >
          <Text style={{ color: '#0a0d12', fontWeight: '700', fontSize: 13 }}>{resyncBusy ? 'Syncing…' : 'Re-sync now'}</Text>
        </Pressable>
        {resyncMsg && (
          <Text style={[styles.rowHint, { color: resyncMsg.ok ? theme.ok : theme.danger }]}>{resyncMsg.text}</Text>
        )}
      </View>

      <View style={[styles.card, { backgroundColor: theme.glass, borderColor: theme.glassBrd }]}>
        <View style={styles.row}>
          {myAvatarUrl ? (
            <Pressable onPress={() => setOwnViewerOpen(true)}>
              <Image source={{ uri: myAvatarUrl }} style={{ width: 40, height: 40, borderRadius: 20 }} />
            </Pressable>
          ) : null}
          <View style={{ flex: 1 }}>
            <Text style={[styles.value, { color: theme.textHi }]}>Profile photo privacy</Text>
            <Text style={[styles.rowHint, { color: theme.textMid }]}>
              Who can view your full-size photo in the full-screen viewer. Small thumbnails in chat rows and member
              lists you're already sharing into a chat aren't covered by this setting.
            </Text>
          </View>
        </View>
        <View style={styles.modeRow}>
          {AVATAR_VISIBILITY_OPTIONS.map((opt) => (
            <Pressable
              key={opt.key}
              onPress={() => setAvatarVisibility(opt.key)}
              disabled={avatarPrivacyLoading}
              style={[
                styles.modePill,
                { borderColor: avatarVisibility === opt.key ? theme.ice : theme.glassBrd, backgroundColor: avatarVisibility === opt.key ? theme.ice : 'transparent' },
              ]}
            >
              <Text style={{ color: avatarVisibility === opt.key ? '#0a0d12' : theme.textMid, fontSize: 11, fontWeight: '700' }}>
                {opt.label}
              </Text>
            </Pressable>
          ))}
        </View>
        {avatarVisibility === 'custom' && (
          <View style={{ marginTop: 8 }}>
            <Text style={[styles.rowHint, { color: theme.textMid }]}>Only these people can view your full-size photo:</Text>
            {dmContactIds.length === 0 ? (
              <Text style={[styles.rowHint, { color: theme.textMid, marginTop: 4 }]}>
                No contacts yet — DM someone first to add them to a custom list.
              </Text>
            ) : (
              dmContactIds.map((id) => {
                const checked = avatarCustomIds.has(id);
                return (
                  <Pressable
                    key={id}
                    onPress={() => toggleCustomId(id)}
                    style={[styles.row, { paddingVertical: 6 }]}
                  >
                    <View
                      style={{
                        width: 18, height: 18, borderRadius: 5, borderWidth: 1.5,
                        borderColor: checked ? theme.ice : theme.glassBrd,
                        backgroundColor: checked ? theme.ice : 'transparent',
                        alignItems: 'center', justifyContent: 'center',
                      }}
                    >
                      {checked && <Text style={{ color: '#0a0d12', fontSize: 12, fontWeight: '900' }}>✓</Text>}
                    </View>
                    <Text style={{ color: theme.textHi, fontSize: 14 }}>{getCachedName(id) || 'PArA PIN user'}</Text>
                  </Pressable>
                );
              })
            )}
          </View>
        )}
        <Pressable
          onPress={saveAvatarPrivacy}
          disabled={avatarPrivacySaving || avatarPrivacyLoading}
          style={({ pressed }) => [
            styles.approveBtn,
            { backgroundColor: theme.ice, opacity: avatarPrivacySaving ? 0.5 : pressed ? 0.7 : 1, marginTop: 10 },
          ]}
        >
          <Text style={{ color: '#0a0d12', fontWeight: '700', fontSize: 13 }}>
            {avatarPrivacySaving ? 'Saving…' : 'Save photo privacy'}
          </Text>
        </Pressable>
        {avatarPrivacyMsg && (
          <Text style={[styles.rowHint, { color: avatarPrivacyMsg.ok ? theme.ok : theme.danger }]}>{avatarPrivacyMsg.text}</Text>
        )}
        <Pressable onPress={openHistory} style={{ marginTop: 10 }}>
          <Text style={{ color: theme.ice, fontSize: 12.5, fontWeight: '600' }}>Profile photo history</Text>
        </Pressable>
        {historyOpen && (
          <View style={{ marginTop: 8, gap: 6 }}>
            {historyLoading ? (
              <Text style={[styles.rowHint, { color: theme.textMid }]}>Loading…</Text>
            ) : historyEntries.length === 0 ? (
              <Text style={[styles.rowHint, { color: theme.textMid }]}>
                No previous photos yet — this fills in once you change your photo for the first time.
              </Text>
            ) : (
              historyEntries.map((entry, i) => (
                <Pressable
                  key={`${entry.url}-${i}`}
                  onPress={() => setHistoryViewerUri(entry.url)}
                  style={[styles.row, { paddingVertical: 4 }]}
                >
                  <Image source={{ uri: entry.url }} style={{ width: 32, height: 32, borderRadius: 8 }} />
                  <Text style={{ color: theme.textHi, fontSize: 12.5, flex: 1 }} numberOfLines={1}>
                    {entry.uploadedAt ? new Date(entry.uploadedAt).toLocaleString() : 'Unknown date'}
                    {entry.orgId ? ' · workspace photo' : ''}
                  </Text>
                </Pressable>
              ))
            )}
          </View>
        )}
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
      <AvatarViewer
        visible={ownViewerOpen}
        onClose={() => setOwnViewerOpen(false)}
        userId={myUserId}
        name={displayName || 'You'}
        thumbUrl={myAvatarUrl}
      />
      <AvatarViewer
        visible={!!historyViewerUri}
        onClose={() => setHistoryViewerUri(null)}
        userId={myUserId}
        name={displayName || 'You'}
        directUri={historyViewerUri}
      />
    </AuthBackdrop>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  // Bottom padding clears the floating BottomNav pill (app/(tabs)/_layout.tsx) —
  // see index.tsx's identical comment.
  content: { padding: 16, paddingBottom: 110, gap: 12 },
  // 20px (was 16) — matches web's general panel radius (.sidebar/.conv
  // both border-radius:20px, index.html:619/745) rather than a slightly
  // tighter native-card radius that didn't correspond to anything on web.
  card: { borderWidth: 1, borderRadius: 20, padding: 14, gap: 4 },
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
  modeRow: { flexDirection: 'row', gap: 6, marginTop: 6 },
  modePill: { flex: 1, borderWidth: 1, borderRadius: 999, paddingVertical: 7, alignItems: 'center' },
  deviceRow: { borderWidth: 1, borderRadius: 14, padding: 10, marginTop: 8, gap: 3 },
  badge: { borderWidth: 1, borderRadius: 20, paddingHorizontal: 8, paddingVertical: 2 },
  deviceActions: { flexDirection: 'row', gap: 14, flexWrap: 'wrap', marginTop: 6 },
});
