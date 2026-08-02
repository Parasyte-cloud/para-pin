import { useEffect } from 'react';
import { View, Text, Pressable, StyleSheet, Modal, Alert } from 'react-native';
import { RTCView } from 'react-native-webrtc';
import { useCallStore } from '../state/call';
import { useTheme } from '../hooks/useTheme';
import { initials, colorFromString } from '../utils/avatar';

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Rendered once at the root (see app/_layout.tsx) so an incoming call can
// interrupt whatever screen/tab is currently open, same as a phone's
// native call UI — not scoped to any one route.
export default function CallOverlay() {
  const theme = useTheme();
  const callState = useCallStore((s) => s.callState);
  const peerName = useCallStore((s) => s.peerName);
  const peerAvatarUrl = useCallStore((s) => s.peerAvatarUrl);
  const peerId = useCallStore((s) => s.peerId);
  const direction = useCallStore((s) => s.direction);
  const hasVideo = useCallStore((s) => s.hasVideo);
  const muted = useCallStore((s) => s.muted);
  const cameraOff = useCallStore((s) => s.cameraOff);
  const awaitingConnection = useCallStore((s) => s.awaitingConnection);
  const elapsedSec = useCallStore((s) => s.elapsedSec);
  const localStream = useCallStore((s) => s.localStream);
  const remoteStream = useCallStore((s) => s.remoteStream);
  const connectError = useCallStore((s) => s.connectError);
  const acceptCall = useCallStore((s) => s.acceptCall);
  const declineCall = useCallStore((s) => s.declineCall);
  const endCall = useCallStore((s) => s.endCall);
  const toggleMute = useCallStore((s) => s.toggleMute);
  const toggleCamera = useCallStore((s) => s.toggleCamera);
  const dismissConnectError = useCallStore((s) => s.dismissConnectError);

  useEffect(() => {
    if (connectError) {
      Alert.alert('Call problem', connectError, [{ text: 'OK', onPress: dismissConnectError }]);
    }
  }, [connectError, dismissConnectError]);

  if (callState === 'idle') return null;

  const name = peerName || 'PArA PIN user';
  const avatarColor = colorFromString(peerId || name, theme.ice, theme.fire);
  const statusLabel =
    callState === 'ringing-in'
      ? `Incoming ${hasVideo ? 'video ' : ''}call`
      : callState === 'ringing-out'
        ? 'Calling…'
        : awaitingConnection
          ? 'Connecting…'
          : formatElapsed(elapsedSec);

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" statusBarTranslucent>
      <View style={[styles.container, { backgroundColor: theme.bg0 }]}>
        {hasVideo && remoteStream ? (
          <RTCView streamURL={remoteStream.toURL()} style={StyleSheet.absoluteFill} objectFit="cover" />
        ) : null}
        {hasVideo && localStream && !cameraOff ? (
          <RTCView
            streamURL={localStream.toURL()}
            style={[styles.localPreview, { borderColor: theme.glassBrdHi }]}
            objectFit="cover"
            mirror
            zOrder={1}
          />
        ) : null}

        <View style={styles.header}>
          {!(hasVideo && remoteStream) && (
            <View style={[styles.bigAvatar, { backgroundColor: avatarColor }]}>
              <Text style={styles.bigAvatarText}>{initials(name)}</Text>
            </View>
          )}
          <Text style={[styles.name, { color: hasVideo && remoteStream ? '#fff' : theme.textHi }]}>{name}</Text>
          <Text style={[styles.status, { color: hasVideo && remoteStream ? 'rgba(255,255,255,0.85)' : theme.textMid }]}>
            {statusLabel}
          </Text>
        </View>

        <View style={styles.controls}>
          {callState === 'ringing-in' ? (
            <View style={styles.row}>
              <Pressable onPress={() => declineCall()} style={[styles.roundBtn, { backgroundColor: '#ff4d4d' }]}>
                <Text style={styles.roundBtnLabel}>✕</Text>
              </Pressable>
              <Pressable onPress={() => acceptCall()} style={[styles.roundBtn, { backgroundColor: '#3ddc84' }]}>
                <Text style={styles.roundBtnLabel}>✓</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.row}>
              {callState === 'connected' && (
                <Pressable
                  onPress={toggleMute}
                  style={[styles.smallBtn, { backgroundColor: muted ? theme.ice : theme.glass, borderColor: theme.glassBrd }]}
                >
                  <Text style={{ color: muted ? '#0a0d12' : theme.textHi, fontSize: 18 }}>{muted ? '🔇' : '🎤'}</Text>
                </Pressable>
              )}
              {callState === 'connected' && hasVideo && (
                <Pressable
                  onPress={toggleCamera}
                  style={[styles.smallBtn, { backgroundColor: cameraOff ? theme.ice : theme.glass, borderColor: theme.glassBrd }]}
                >
                  <Text style={{ color: cameraOff ? '#0a0d12' : theme.textHi, fontSize: 18 }}>{cameraOff ? '📷' : '🎥'}</Text>
                </Pressable>
              )}
              <Pressable onPress={() => endCall()} style={[styles.roundBtn, { backgroundColor: '#ff4d4d' }]}>
                <Text style={styles.roundBtnLabel}>✕</Text>
              </Pressable>
            </View>
          )}
          <Text style={[styles.directionHint, { color: theme.textLow }]}>
            {direction === 'incoming' ? 'Incoming' : 'Outgoing'}
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'space-between', paddingVertical: 60, paddingHorizontal: 24 },
  header: { alignItems: 'center', gap: 10, marginTop: 40 },
  bigAvatar: { width: 120, height: 120, borderRadius: 60, alignItems: 'center', justifyContent: 'center' },
  bigAvatarText: { color: '#0a0d12', fontWeight: '700', fontSize: 40 },
  name: { fontSize: 22, fontWeight: '700' },
  status: { fontSize: 14 },
  localPreview: {
    position: 'absolute',
    top: 60,
    right: 20,
    width: 100,
    height: 140,
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
  },
  controls: { alignItems: 'center', gap: 10 },
  row: { flexDirection: 'row', gap: 24, justifyContent: 'center' },
  roundBtn: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  roundBtnLabel: { fontSize: 26, color: '#fff', fontWeight: '700' },
  smallBtn: { width: 56, height: 56, borderRadius: 28, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  directionHint: { fontSize: 11 },
});
