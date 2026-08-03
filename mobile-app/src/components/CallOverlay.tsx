// iOS-native call UI: full-bleed remote video (or a soft gradient backdrop
// for audio-only/pre-connect), a draggable local PiP self-view that snaps
// to whichever corner it's released nearest to, and — once a call is
// live — the real iOS in-call control grid: six circular liquid-glass
// buttons in two rows of three (Speaker / Camera / Mute, then Flip camera /
// End / More), matching the reference layout instead of the single
// horizontal row this used to be. Mute/camera controls are available as
// soon as there's a live call (ringing-out included, matching FaceTime
// letting you pre-mute before the other side even picks up) rather than
// only once connected — one of the audio/video consistency fixes, see
// mobile-app/README.md's call-reliability section for the rest.

import { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Modal, Alert, Animated, PanResponder, Dimensions } from 'react-native';
import { RTCView } from 'react-native-webrtc';
import { BlurView } from 'expo-blur';
import { useCallStore } from '../state/call';
import { useTheme } from '../hooks/useTheme';
import { initials, colorFromString } from '../utils/avatar';

const PIP_WIDTH = 108;
const PIP_HEIGHT = 152;
const PIP_MARGIN = 16;

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Draggable, corner-snapping local self-view — a lightweight PanResponder
// + Animated implementation (no reanimated dependency) so it behaves like
// FaceTime's PiP without adding another native module on top of the ones
// Phase 3/4 already required.
function LocalPip({ streamURL, borderColor }: { streamURL: string; borderColor: string }) {
  const { width: screenW, height: screenH } = Dimensions.get('window');
  const pan = useRef(new Animated.ValueXY({ x: screenW - PIP_WIDTH - PIP_MARGIN, y: 70 })).current;
  const lastOffset = useRef({ x: screenW - PIP_WIDTH - PIP_MARGIN, y: 70 });

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4,
      onPanResponderGrant: () => {
        pan.setOffset(lastOffset.current);
        pan.setValue({ x: 0, y: 0 });
      },
      onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], { useNativeDriver: false }),
      onPanResponderRelease: (_e, gesture) => {
        pan.flattenOffset();
        const currentX = lastOffset.current.x + gesture.dx;
        const currentY = lastOffset.current.y + gesture.dy;
        const snappedX = currentX + PIP_WIDTH / 2 < screenW / 2 ? PIP_MARGIN : screenW - PIP_WIDTH - PIP_MARGIN;
        const snappedY = Math.min(Math.max(currentY, 60), screenH - PIP_HEIGHT - 140);
        lastOffset.current = { x: snappedX, y: snappedY };
        Animated.spring(pan, { toValue: { x: snappedX, y: snappedY }, useNativeDriver: false, bounciness: 6 }).start();
      },
    })
  ).current;

  return (
    <Animated.View
      {...panResponder.panHandlers}
      style={[styles.localPreview, { borderColor, transform: pan.getTranslateTransform() }]}
    >
      <RTCView streamURL={streamURL} style={StyleSheet.absoluteFill} objectFit="cover" mirror zOrder={2} />
    </Animated.View>
  );
}

// Rendered once at the root (see app/_layout.tsx) so an incoming call can
// interrupt whatever screen/tab is currently open, same as a phone's
// native call UI — not scoped to any one route.
export default function CallOverlay() {
  const theme = useTheme();
  const callState = useCallStore((s) => s.callState);
  const peerName = useCallStore((s) => s.peerName);
  const peerId = useCallStore((s) => s.peerId);
  const direction = useCallStore((s) => s.direction);
  const hasVideo = useCallStore((s) => s.hasVideo);
  const muted = useCallStore((s) => s.muted);
  const cameraOff = useCallStore((s) => s.cameraOff);
  const speakerOn = useCallStore((s) => s.speakerOn);
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
  const toggleSpeaker = useCallStore((s) => s.toggleSpeaker);
  const switchCamera = useCallStore((s) => s.switchCamera);
  const dismissConnectError = useCallStore((s) => s.dismissConnectError);
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    if (connectError) {
      Alert.alert('Call problem', connectError, [{ text: 'OK', onPress: dismissConnectError }]);
    }
  }, [connectError, dismissConnectError]);

  if (callState === 'idle') return null;

  const name = peerName || 'PArA PIN user';
  const avatarColor = colorFromString(peerId || name, theme.ice, theme.fire);
  const hasRemoteVideo = hasVideo && !!remoteStream;
  // Controls are available from the moment a call is live (ringing-out
  // included, same as FaceTime letting you pre-mute before the other side
  // even answers) rather than gated to `connected` only — that gating was
  // one of the audio/video inconsistencies: an outgoing video call let you
  // toggle camera before pickup already (no gate bug there), but mute was
  // silently unavailable until connected for BOTH types, which is the
  // asymmetry worth fixing — a call already has live local audio/video
  // tracks well before the peer answers.
  const controlsActive = callState === 'connected' || callState === 'ringing-out';
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
        {hasRemoteVideo ? (
          <RTCView streamURL={remoteStream!.toURL()} style={StyleSheet.absoluteFill} objectFit="cover" />
        ) : (
          // FaceTime-style soft backdrop for audio-only calls and any
          // moment before the remote video stream actually arrives —
          // flat black/bg0 alone read as "is this even working," two
          // large soft-edged tinted circles behind the avatar reads as a
          // deliberate design instead. No image/blur asset, just layered
          // low-opacity Views.
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            <View style={[styles.glowCircle, { backgroundColor: theme.ice, opacity: 0.16, top: -140, left: -100 }]} />
            <View style={[styles.glowCircle, { backgroundColor: theme.fire, opacity: 0.1, bottom: -160, right: -120 }]} />
          </View>
        )}

        {hasVideo && localStream && !cameraOff && (
          <LocalPip streamURL={localStream.toURL()} borderColor={theme.glassBrdHi} />
        )}

        <View style={styles.header} pointerEvents="none">
          {!hasRemoteVideo && (
            <View style={[styles.bigAvatar, { backgroundColor: avatarColor }]}>
              <Text style={styles.bigAvatarText}>{initials(name)}</Text>
            </View>
          )}
          <Text style={[styles.name, { color: hasRemoteVideo ? '#fff' : theme.textHi }]}>{name}</Text>
          {/* Frosted glass status pill — most useful (and most visible)
              while remote video is playing behind it; falls back to a
              plain semi-transparent pill on Android where BlurView has no
              true blur without the experimental method (still reads as
              "glass chrome", just softer). */}
          <BlurView intensity={40} tint="dark" style={styles.statusPill}>
            <Text style={styles.status}>{statusLabel}</Text>
          </BlurView>
        </View>

        <View style={styles.controlsWrap}>
          {callState === 'ringing-in' ? (
            // Colors match index.html's `.incoming-call-decline`/
            // `.incoming-call-accept` exactly (index.html:489/491:
            // #ff4d4d / #2ecf7a) — were iOS system red/green before this
            // pass, close but not literally web's palette.
            <View style={styles.row}>
              <View style={styles.controlCol}>
                <Pressable onPress={() => declineCall()} style={[styles.roundBtn, { backgroundColor: '#ff4d4d' }]}>
                  <Text style={styles.roundBtnLabel}>✕</Text>
                </Pressable>
                <Text style={styles.controlLabel}>Decline</Text>
              </View>
              <View style={styles.controlCol}>
                <Pressable onPress={() => acceptCall()} style={[styles.roundBtn, { backgroundColor: '#2ecf7a' }]}>
                  <Text style={styles.roundBtnLabel}>{hasVideo ? '🎥' : '✓'}</Text>
                </Pressable>
                <Text style={styles.controlLabel}>Accept</Text>
              </View>
            </View>
          ) : (
            // 2x3 iOS in-call grid. Every cell is the SAME circular glass
            // treatment (see .gridBtn) regardless of what it does — the
            // active/toggled states (mute, speaker, camera) invert to a
            // solid white fill same as the real iOS control grid, End
            // stays red/prominent, and anything not actually wired to a
            // real action (More, and Flip camera when there's no video
            // track to flip) renders visibly dimmed rather than silently
            // doing nothing, so it doesn't read as broken.
            <View style={styles.grid}>
              {/* Active/toggled state matches index.html's
                  `.video-call-btn.active` exactly (index.html:571:
                  rgba(255,255,255,0.35), a translucent lift, not opaque
                  white) — was solid #fff before this pass. */}
              <View style={styles.gridRow}>
                <View style={styles.controlCol}>
                  <Pressable
                    onPress={toggleSpeaker}
                    disabled={!controlsActive}
                    style={[styles.gridBtn, { backgroundColor: speakerOn ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.16)', opacity: controlsActive ? 1 : 0.4 }]}
                  >
                    <Text style={{ fontSize: 21 }}>🔊</Text>
                  </Pressable>
                  <Text style={styles.controlLabel}>Speaker</Text>
                </View>
                <View style={styles.controlCol}>
                  <Pressable
                    onPress={toggleCamera}
                    disabled={!controlsActive || !hasVideo}
                    style={[
                      styles.gridBtn,
                      { backgroundColor: hasVideo && !cameraOff ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.16)', opacity: controlsActive && hasVideo ? 1 : 0.4 },
                    ]}
                  >
                    <Text style={{ fontSize: 21 }}>🎥</Text>
                  </Pressable>
                  <Text style={styles.controlLabel}>Camera</Text>
                </View>
                <View style={styles.controlCol}>
                  <Pressable
                    onPress={toggleMute}
                    disabled={!controlsActive}
                    style={[styles.gridBtn, { backgroundColor: muted ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.16)', opacity: controlsActive ? 1 : 0.4 }]}
                  >
                    <Text style={{ fontSize: 21 }}>{muted ? '🔇' : '🎤'}</Text>
                  </Pressable>
                  <Text style={styles.controlLabel}>{muted ? 'Unmute' : 'Mute'}</Text>
                </View>
              </View>
              <View style={styles.gridRow}>
                <View style={styles.controlCol}>
                  <Pressable
                    onPress={switchCamera}
                    disabled={!controlsActive || !hasVideo || cameraOff}
                    style={[styles.gridBtn, { backgroundColor: 'rgba(255,255,255,0.16)', opacity: controlsActive && hasVideo && !cameraOff ? 1 : 0.35 }]}
                  >
                    <Text style={{ fontSize: 21 }}>🔄</Text>
                  </Pressable>
                  <Text style={styles.controlLabel}>Flip</Text>
                </View>
                <View style={styles.controlCol}>
                  {/* End-call color matches index.html's
                      `.video-call-end-btn` exactly (index.html:572:
                      #ff4d4d), was iOS system red (#ff453a). */}
                  <Pressable onPress={() => endCall()} style={[styles.gridBtn, styles.endBtn, { backgroundColor: '#ff4d4d' }]}>
                    <Text style={styles.endBtnLabel}>✕</Text>
                  </Pressable>
                  <Text style={styles.controlLabel}>End</Text>
                </View>
                <View style={styles.controlCol}>
                  <Pressable
                    onPress={() => setMoreOpen(true)}
                    disabled={!controlsActive}
                    style={[styles.gridBtn, { backgroundColor: 'rgba(255,255,255,0.16)', opacity: controlsActive ? 1 : 0.4 }]}
                  >
                    <Text style={{ fontSize: 21 }}>⋯</Text>
                  </Pressable>
                  <Text style={styles.controlLabel}>More</Text>
                </View>
              </View>
            </View>
          )}

          {moreOpen && (
            <Pressable style={styles.moreBackdrop} onPress={() => setMoreOpen(false)}>
              <BlurView intensity={60} tint="dark" style={styles.moreSheet}>
                <Text style={styles.moreTitle}>{name}</Text>
                <Text style={styles.moreSub}>
                  {hasVideo ? 'Video call' : 'Audio call'} · {formatElapsed(elapsedSec)}
                </Text>
                <Text style={styles.moreHint}>To add more people, end this call and start a group meeting from a group chat instead.</Text>
              </BlurView>
            </Pressable>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'space-between', paddingVertical: 60, paddingHorizontal: 24 },
  glowCircle: { position: 'absolute', width: 340, height: 340, borderRadius: 170 },
  header: { alignItems: 'center', gap: 8, marginTop: 40 },
  bigAvatar: { width: 116, height: 116, borderRadius: 58, alignItems: 'center', justifyContent: 'center' },
  bigAvatarText: { color: '#0a0d12', fontWeight: '700', fontSize: 38 },
  name: { fontSize: 22, fontWeight: '700' },
  statusPill: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 5, overflow: 'hidden', marginTop: 2 },
  status: { fontSize: 13, color: '#fff', fontWeight: '500' },
  localPreview: {
    position: 'absolute',
    width: PIP_WIDTH,
    height: PIP_HEIGHT,
    borderRadius: 16,
    borderWidth: 2,
    overflow: 'hidden',
    zIndex: 5,
  },
  controlsWrap: { alignItems: 'center', width: '100%' },
  row: { flexDirection: 'row', gap: 28, justifyContent: 'center', alignItems: 'flex-start' },
  controlCol: { alignItems: 'center', gap: 6, width: 64 },
  controlLabel: { fontSize: 11, color: 'rgba(255,255,255,0.85)' },
  roundBtn: { width: 62, height: 62, borderRadius: 31, alignItems: 'center', justifyContent: 'center' },
  roundBtnLabel: { fontSize: 24, color: '#fff', fontWeight: '700' },
  // 2x3 in-call control grid — three equal-width columns per row, same
  // circular glass button in every cell (see the comment at the JSX call
  // site for why every cell shares one style regardless of what it does).
  grid: { gap: 20, alignItems: 'center' },
  gridRow: { flexDirection: 'row', gap: 26, justifyContent: 'center' },
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
  moreBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 220,
  },
  moreSheet: {
    width: '84%',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    padding: 18,
    alignItems: 'center',
    overflow: 'hidden',
  },
  moreTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  moreSub: { color: 'rgba(255,255,255,0.7)', fontSize: 12.5, marginTop: 2 },
  moreHint: { color: 'rgba(255,255,255,0.55)', fontSize: 11.5, marginTop: 10, textAlign: 'center' },
});
