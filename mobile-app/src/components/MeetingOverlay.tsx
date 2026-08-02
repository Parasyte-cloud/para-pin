// Group meeting UI — the mobile counterpart to index.html's Meeting Room
// overlay, built on top of state/meeting.ts's SFU client. A tile grid
// (self + each remote participant with video, or an avatar chip for
// audio-only/no-video-yet participants) plus a simple three-button control
// row (Mute / Camera / Leave), and — mirroring CallOverlay's ringing-in
// card — an incoming-invite card when someone else starts a meeting and
// invites this user while mobile is idle.
//
// Scope cuts vs. web (see state/meeting.ts's header comment for the full
// list/reasoning): no recording, no AI summary, no active-speaker
// highlighting, no PiP-while-browsing, no in-overlay invite picker.

import { useEffect } from 'react';
import { View, Text, Pressable, StyleSheet, Modal, Alert, ScrollView } from 'react-native';
import { RTCView } from 'react-native-webrtc';
import { BlurView } from 'expo-blur';
import { useMeetingStore } from '../state/meeting';
import { useTheme } from '../hooks/useTheme';
import { initials, colorFromString } from '../utils/avatar';

function Tile({
  name,
  userId,
  videoStreamURL,
  hasAudio,
  mirror,
  theme,
}: {
  name: string;
  userId: string;
  videoStreamURL: string | null;
  hasAudio: boolean;
  mirror?: boolean;
  theme: ReturnType<typeof useTheme>;
}) {
  const color = colorFromString(userId, theme.ice, theme.fire);
  return (
    <View style={[styles.tile, { backgroundColor: theme.glass, borderColor: theme.glassBrd }]}>
      {videoStreamURL ? (
        <RTCView streamURL={videoStreamURL} style={StyleSheet.absoluteFill} objectFit="cover" mirror={mirror} />
      ) : (
        <View style={[styles.tileAvatar, { backgroundColor: color }]}>
          <Text style={styles.tileAvatarText}>{initials(name)}</Text>
        </View>
      )}
      <View style={styles.tileFooter}>
        <BlurView intensity={40} tint="dark" style={styles.tileNamePill}>
          <Text style={styles.tileNameText} numberOfLines={1}>
            {name}
          </Text>
          {!hasAudio && <Text style={styles.tileMuteIcon}>🔇</Text>}
        </BlurView>
      </View>
    </View>
  );
}

// Rendered once at the root (see app/_layout.tsx), same reasoning as
// CallOverlay — a meeting can be joined/invited-into regardless of which
// tab is currently open.
export default function MeetingOverlay() {
  const theme = useTheme();
  const status = useMeetingStore((s) => s.status);
  const meetingName = useMeetingStore((s) => s.meetingName);
  const participants = useMeetingStore((s) => s.participants);
  const localStream = useMeetingStore((s) => s.localStream);
  const muted = useMeetingStore((s) => s.muted);
  const cameraOff = useMeetingStore((s) => s.cameraOff);
  const errorMessage = useMeetingStore((s) => s.errorMessage);
  const pendingInvite = useMeetingStore((s) => s.pendingInvite);
  const toggleMute = useMeetingStore((s) => s.toggleMute);
  const toggleCamera = useMeetingStore((s) => s.toggleCamera);
  const leaveMeeting = useMeetingStore((s) => s.leaveMeeting);
  const acceptInvite = useMeetingStore((s) => s.acceptInvite);
  const declineInvite = useMeetingStore((s) => s.declineInvite);
  const dismissError = useMeetingStore((s) => s.dismissError);

  useEffect(() => {
    if (errorMessage) Alert.alert('Meeting problem', errorMessage, [{ text: 'OK', onPress: dismissError }]);
  }, [errorMessage, dismissError]);

  if (status === 'idle' && !pendingInvite) return null;

  if (pendingInvite && status === 'idle') {
    const color = colorFromString(pendingInvite.fromUserId, theme.ice, theme.fire);
    return (
      <Modal visible animationType="slide" presentationStyle="fullScreen" statusBarTranslucent>
        <View style={[styles.container, { backgroundColor: theme.bg0, justifyContent: 'center', alignItems: 'center' }]}>
          <View style={[styles.bigAvatar, { backgroundColor: color }]}>
            <Text style={styles.bigAvatarText}>{initials(pendingInvite.fromName)}</Text>
          </View>
          <Text style={[styles.name, { color: theme.textHi, marginTop: 14 }]}>
            {pendingInvite.meetingName || 'Group meeting'}
          </Text>
          <Text style={{ color: theme.textLow, fontSize: 13, marginTop: 4 }}>
            {pendingInvite.fromName} is inviting you
          </Text>
          <View style={[styles.row, { marginTop: 40 }]}>
            <View style={styles.controlCol}>
              <Pressable onPress={declineInvite} style={[styles.roundBtn, { backgroundColor: '#ff453a' }]}>
                <Text style={styles.roundBtnLabel}>✕</Text>
              </Pressable>
              <Text style={[styles.controlLabel, { color: theme.textLow }]}>Decline</Text>
            </View>
            <View style={styles.controlCol}>
              <Pressable onPress={acceptInvite} style={[styles.roundBtn, { backgroundColor: '#34c759' }]}>
                <Text style={styles.roundBtnLabel}>✓</Text>
              </Pressable>
              <Text style={[styles.controlLabel, { color: theme.textLow }]}>Join</Text>
            </View>
          </View>
        </View>
      </Modal>
    );
  }

  const remoteList = Object.values(participants);
  const gridColumns = remoteList.length <= 1 ? 1 : 2;

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" statusBarTranslucent>
      <View style={[styles.container, { backgroundColor: theme.bg0, paddingHorizontal: 12 }]}>
        <View style={styles.header}>
          <Text style={[styles.name, { color: theme.textHi }]} numberOfLines={1}>
            {meetingName || 'Meeting'}
          </Text>
          <Text style={{ color: theme.textLow, fontSize: 12.5 }}>
            {status === 'connecting' ? 'Connecting…' : `${remoteList.length + 1} in the meeting`}
          </Text>
        </View>

        <ScrollView contentContainerStyle={[styles.grid, { flexDirection: gridColumns === 1 ? 'column' : 'row' }]}>
          <View style={[styles.tileWrap, { width: gridColumns === 1 ? '100%' : '48%' }]}>
            <Tile
              name="You"
              userId="me"
              videoStreamURL={!cameraOff && localStream ? localStream.toURL() : null}
              hasAudio={!muted}
              mirror
              theme={theme}
            />
          </View>
          {remoteList.map((p) => (
            <View key={p.userId} style={[styles.tileWrap, { width: gridColumns === 1 ? '100%' : '48%' }]}>
              <Tile
                name={p.name || 'Someone'}
                userId={p.userId}
                videoStreamURL={p.videoStream ? p.videoStream.toURL() : null}
                hasAudio={p.hasAudio}
                theme={theme}
              />
            </View>
          ))}
        </ScrollView>

        <View style={styles.controlsWrap}>
          <View style={styles.row}>
            <View style={styles.controlCol}>
              <Pressable
                onPress={toggleMute}
                style={[styles.gridBtn, { backgroundColor: muted ? '#fff' : 'rgba(255,255,255,0.16)' }]}
              >
                <Text style={{ fontSize: 21 }}>{muted ? '🔇' : '🎤'}</Text>
              </Pressable>
              <Text style={[styles.controlLabel, { color: theme.textLow }]}>{muted ? 'Unmute' : 'Mute'}</Text>
            </View>
            <View style={styles.controlCol}>
              <Pressable
                onPress={toggleCamera}
                style={[styles.gridBtn, { backgroundColor: !cameraOff ? '#fff' : 'rgba(255,255,255,0.16)' }]}
              >
                <Text style={{ fontSize: 21 }}>🎥</Text>
              </Pressable>
              <Text style={[styles.controlLabel, { color: theme.textLow }]}>Camera</Text>
            </View>
            <View style={styles.controlCol}>
              <Pressable onPress={() => leaveMeeting()} style={[styles.gridBtn, styles.endBtn, { backgroundColor: '#ff453a' }]}>
                <Text style={styles.endBtnLabel}>✕</Text>
              </Pressable>
              <Text style={[styles.controlLabel, { color: theme.textLow }]}>Leave</Text>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingVertical: 50 },
  header: { alignItems: 'center', gap: 2, marginBottom: 10 },
  name: { fontSize: 18, fontWeight: '700' },
  bigAvatar: { width: 116, height: 116, borderRadius: 58, alignItems: 'center', justifyContent: 'center' },
  bigAvatarText: { color: '#0a0d12', fontWeight: '700', fontSize: 38 },
  grid: { flexWrap: 'wrap', gap: '4%', paddingBottom: 20 },
  tileWrap: { aspectRatio: 3 / 4, marginBottom: 12 },
  tile: { flex: 1, borderRadius: 18, borderWidth: 1, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  tileAvatar: { width: 68, height: 68, borderRadius: 34, alignItems: 'center', justifyContent: 'center' },
  tileAvatarText: { color: '#0a0d12', fontWeight: '700', fontSize: 22 },
  tileFooter: { position: 'absolute', bottom: 8, left: 8, right: 8 },
  tileNamePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    overflow: 'hidden',
    maxWidth: '100%',
  },
  tileNameText: { color: '#fff', fontSize: 11.5, fontWeight: '600', maxWidth: 110 },
  tileMuteIcon: { fontSize: 11 },
  controlsWrap: { alignItems: 'center', width: '100%', paddingTop: 8 },
  row: { flexDirection: 'row', gap: 28, justifyContent: 'center', alignItems: 'flex-start' },
  controlCol: { alignItems: 'center', gap: 6, width: 64 },
  controlLabel: { fontSize: 11 },
  roundBtn: { width: 62, height: 62, borderRadius: 31, alignItems: 'center', justifyContent: 'center' },
  roundBtnLabel: { fontSize: 24, color: '#fff', fontWeight: '700' },
  gridBtn: {
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  endBtn: { borderColor: 'transparent' },
  endBtnLabel: { fontSize: 24, color: '#fff', fontWeight: '700' },
});
