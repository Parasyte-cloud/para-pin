// Redesigned 1:1 call screen — premium audio + video call UI (task #221/
// #222 of the calling-experience redesign; see CALL_UI_REDESIGN.md for the
// full spec once written). Explicitly NOT a FaceTime/WhatsApp/Telegram
// reskin — see callTheme.ts's header for the concrete differences this
// design commits to instead.
//
// Audio call: large breathing avatar, a live waveform ring reacting to the
// real local mic level (see callNetworkMonitor.ts — genuinely measured off
// getStats(), not simulated), a drifting two-tone aurora backdrop, a status
// capsule stack (state + quality + HD/encrypted badges), and the floating
// glass dock (GlassDock). Video call: same chrome over full-bleed remote
// video with a draggable local PiP, avatar/waveform only shown for the
// audio-only portions of a video call (ringing/connecting, or if the peer's
// video hasn't arrived yet).
//
// Two things this UI deliberately does NOT claim, stated here rather than
// silently faked, because the state machine underneath them (call.ts) is
// explicit about not supporting them:
//  - Bluetooth/headphone ROUTE DETECTION: react-native-webrtc's
//    enumerateDevices() never returns an 'audiooutput' device on this
//    platform (verified by reading the native module directly — see
//    call.ts's toggleSpeaker comment). There is no reliable signal to show
//    "connected via AirPods" from, so this UI doesn't show one. The Speaker
//    button is real UI state (drives the OS's default routing preference)
//    the same way it always has been, not audio-route control.
//  - A DTMF keypad: calls here are PIN-to-PIN VoIP between PArA accounts,
//    there's no PSTN/phone-number dial path for a keypad to send tones
//    into, so the "Keypad" item from the brief has nothing to actually do
//    on this call type — omitted rather than shown as a dead button.

import { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Modal, Alert, Animated, Easing, PanResponder, Dimensions, AccessibilityInfo } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RTCView } from 'react-native-webrtc';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { useCallStore } from '../state/call';
import { useSessionStore } from '../state/session';
import { initials, colorFromString } from '../utils/avatar';
import { callColors, callMotion } from '../theme/callTheme';
import { AnimatedAvatar, ConnectionQualityDots, GlassBadge, isReduceMotionEnabled } from './call/primitives';
import { GlassDock, type DockItem } from './call/GlassDock';
import { isTrackHd } from '../utils/callNetworkMonitor';

const PIP_WIDTH = 108;
const PIP_HEIGHT = 152;
const PIP_MARGIN = 16;

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Draggable, corner-snapping local self-view — unchanged from the previous
// design (already worked well, nothing about the redesign brief asked for
// a different interaction here beyond "floating self preview," which this
// already was).
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
      accessible
      accessibilityLabel="Your camera preview, draggable"
      style={[styles.localPreview, { borderColor, transform: pan.getTranslateTransform() }]}
    >
      <RTCView streamURL={streamURL} style={StyleSheet.absoluteFill} objectFit="cover" mirror zOrder={2} />
    </Animated.View>
  );
}

// Slow two-blob aurora drift behind the avatar on an audio call / any
// no-remote-video moment — the brief's "elegant background." Deliberately
// subtle (low opacity, slow) so it reads as ambient depth, not a distraction
// from the actual call. Skips the drift animation (holds a static position)
// under Reduce Motion, same policy as every other idle loop in this surface.
function AuroraBackdrop() {
  const drift = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (isReduceMotionEnabled()) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(drift, { toValue: 1, duration: 9000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(drift, { toValue: 0, duration: 9000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [drift]);
  const translate1 = drift.interpolate({ inputRange: [0, 1], outputRange: [-24, 24] });
  const translate2 = drift.interpolate({ inputRange: [0, 1], outputRange: [18, -18] });
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <LinearGradient colors={[callColors.voidTop, callColors.voidBottom]} style={StyleSheet.absoluteFill} />
      <Animated.View style={[styles.glowCircle, { backgroundColor: callColors.ice, opacity: 0.14, top: -160, left: -110, transform: [{ translateX: translate1 }, { translateY: translate1 }] }]} />
      <Animated.View style={[styles.glowCircle, { backgroundColor: callColors.fire, opacity: 0.1, bottom: -180, right: -130, transform: [{ translateX: translate2 }, { translateY: translate2 }] }]} />
    </View>
  );
}

// Rendered once at the root (see app/_layout.tsx) so an incoming call can
// interrupt whatever screen/tab is currently open, same mount point as
// before this redesign — the component name/default-export/no-props shape
// is unchanged on purpose so swapping this file in was a drop-in replace.
export default function CallOverlay() {
  // Real per-device safe-area insets (notch, Dynamic Island, home
  // indicator) rather than one fixed padding guess — the old design's
  // paddingVertical:60 either wasted space on an SE or crowded the status
  // bar/Dynamic Island on a Pro Max; this is the actual "100% responsive
  // across screen sizes" fix, not a cosmetic one. SafeAreaProvider already
  // wraps the whole app (see app/_layout.tsx), so this Just Works here.
  const insets = useSafeAreaInsets();
  const oneHandedModeEnabled = useSessionStore((s) => s.oneHandedModeEnabled);
  const callState = useCallStore((s) => s.callState);
  const peerName = useCallStore((s) => s.peerName);
  const peerId = useCallStore((s) => s.peerId);
  const hasVideo = useCallStore((s) => s.hasVideo);
  const muted = useCallStore((s) => s.muted);
  const cameraOff = useCallStore((s) => s.cameraOff);
  const speakerOn = useCallStore((s) => s.speakerOn);
  const awaitingConnection = useCallStore((s) => s.awaitingConnection);
  const isReconnecting = useCallStore((s) => s.isReconnecting);
  const elapsedSec = useCallStore((s) => s.elapsedSec);
  const localStream = useCallStore((s) => s.localStream);
  const remoteStream = useCallStore((s) => s.remoteStream);
  const connectError = useCallStore((s) => s.connectError);
  const networkQuality = useCallStore((s) => s.networkQuality);
  const localAudioLevel = useCallStore((s) => s.localAudioLevel);
  const acceptCall = useCallStore((s) => s.acceptCall);
  const declineCall = useCallStore((s) => s.declineCall);
  const endCall = useCallStore((s) => s.endCall);
  const toggleMute = useCallStore((s) => s.toggleMute);
  const toggleCamera = useCallStore((s) => s.toggleCamera);
  const toggleSpeaker = useCallStore((s) => s.toggleSpeaker);
  const switchCamera = useCallStore((s) => s.switchCamera);
  const dismissConnectError = useCallStore((s) => s.dismissConnectError);
  const [addPersonNoticeOpen, setAddPersonNoticeOpen] = useState(false);
  const [isHdRemote, setIsHdRemote] = useState(false);

  useEffect(() => {
    if (connectError) {
      Alert.alert('Call problem', connectError, [{ text: 'OK', onPress: dismissConnectError }]);
    }
  }, [connectError, dismissConnectError]);

  // Recomputed off the actual negotiated remote video track's settings
  // whenever the remote stream (or its tracks) change — genuine resolution
  // check (see isTrackHd's own comment), not a guess from callState.
  useEffect(() => {
    if (!remoteStream) {
      setIsHdRemote(false);
      return;
    }
    const track = remoteStream.getVideoTracks()[0];
    setIsHdRemote(isTrackHd(track as any));
    // react-native-webrtc doesn't emit a resize event through this binding,
    // so this is a best-effort snapshot at the moment the stream/track
    // reference changes rather than a live subscription — acceptable here
    // since resolution renegotiation mid-call is rare and the badge isn't
    // safety-critical.
  }, [remoteStream]);

  // VoiceOver announcement on state transitions that matter but have no
  // other non-visual signal (ringing/vibration already covers incoming
  // calls; this covers the ones that don't already announce themselves).
  useEffect(() => {
    if (callState === 'connected') AccessibilityInfo.announceForAccessibility?.('Call connected');
    if (isReconnecting) AccessibilityInfo.announceForAccessibility?.('Reconnecting call');
  }, [callState, isReconnecting]);

  if (callState === 'idle') return null;

  const name = peerName || 'PArA PIN user';
  const hasRemoteVideo = hasVideo && !!remoteStream && remoteStream.getVideoTracks().length > 0;
  const controlsActive = callState === 'connected' || callState === 'ringing-out';
  const isPoorConnection = callState === 'connected' && !isReconnecting && (networkQuality === 'poor' || networkQuality === 'fair');

  const statusLabel =
    callState === 'ringing-in'
      ? `Incoming ${hasVideo ? 'video ' : ''}call`
      : callState === 'ringing-out'
        ? 'Calling…'
        : isReconnecting
          ? 'Reconnecting…'
          : awaitingConnection
            ? 'Connecting…'
            : formatElapsed(elapsedSec);

  const primaryDock: DockItem[] = [
    {
      key: 'mute',
      icon: muted ? '🔇' : '🎤',
      label: muted ? 'Unmute' : 'Mute',
      active: muted,
      disabled: !controlsActive,
      onPress: toggleMute,
      accessibilityHint: muted ? 'Turns your microphone back on' : 'Turns your microphone off',
    },
    {
      key: 'speaker',
      icon: '🔊',
      label: 'Speaker',
      active: speakerOn,
      disabled: !controlsActive,
      onPress: toggleSpeaker,
      accessibilityHint: 'Toggles the speaker indicator',
    },
    ...(hasVideo
      ? [
          {
            key: 'camera',
            icon: '🎥',
            label: cameraOff ? 'Start video' : 'Stop video',
            active: !cameraOff,
            disabled: !controlsActive,
            onPress: toggleCamera,
            accessibilityHint: cameraOff ? 'Turns your camera back on' : 'Turns your camera off',
          } as DockItem,
        ]
      : []),
  ];
  const overflowDock: DockItem[] = [
    ...(hasVideo
      ? [
          {
            key: 'flip',
            icon: '🔄',
            label: 'Flip camera',
            disabled: !controlsActive || cameraOff,
            onPress: switchCamera,
            accessibilityHint: 'Switches between front and back camera',
          } as DockItem,
        ]
      : []),
    {
      key: 'add',
      icon: '➕',
      label: 'Add person',
      disabled: !controlsActive,
      onPress: () => setAddPersonNoticeOpen(true),
      accessibilityHint: 'Explains how to bring more people into this call',
    },
  ];

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" statusBarTranslucent>
      <View style={[styles.container, { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 20 }]}>
        {hasRemoteVideo ? (
          <RTCView streamURL={remoteStream!.toURL()} style={StyleSheet.absoluteFill} objectFit="cover" />
        ) : (
          <AuroraBackdrop />
        )}

        {hasVideo && localStream && !cameraOff && (
          <LocalPip streamURL={localStream.toURL()} borderColor={callColors.glassBrdHi} />
        )}

        <View style={[styles.badgeRow, { top: insets.top + 12 }]} pointerEvents="none">
          <GlassBadge label="Encrypted" icon="🔒" tone="ok" />
          {hasVideo && isHdRemote && <GlassBadge label="HD" tone="neutral" />}
          {callState === 'connected' && (
            <BlurView intensity={40} tint="dark" style={styles.qualityPill}>
              <ConnectionQualityDots quality={isReconnecting ? 'unknown' : networkQuality} />
            </BlurView>
          )}
        </View>

        {isPoorConnection && (
          <View style={[styles.poorBanner, { top: insets.top + 48 }]} pointerEvents="none">
            <GlassBadge label="Poor connection" icon="⚠️" tone="warn" />
          </View>
        )}

        <View style={styles.header} pointerEvents="none">
          {!hasRemoteVideo && (
            <AnimatedAvatar
              name={name}
              userId={peerId || name}
              size={128}
              breathing={callState === 'ringing-in' || callState === 'ringing-out' || awaitingConnection || isReconnecting}
              audioLevel={callState === 'connected' && !isReconnecting ? localAudioLevel : null}
            />
          )}
          <Text style={styles.name} accessibilityRole="header">{name}</Text>
          <BlurView intensity={40} tint="dark" style={styles.statusPill}>
            <Text style={styles.status} accessibilityLiveRegion="polite">{statusLabel}</Text>
          </BlurView>
        </View>

        <View style={styles.controlsWrap}>
          {callState === 'ringing-in' ? (
            <View style={styles.incomingRow}>
              <View style={styles.controlCol}>
                <GlassBadgeButton icon="✕" color={callColors.danger} label="Decline" onPress={() => declineCall()} accessibilityHint="Declines this call" />
              </View>
              <View style={styles.controlCol}>
                <GlassBadgeButton icon={hasVideo ? '🎥' : '✓'} color={callColors.ok} label="Accept" onPress={() => acceptCall()} accessibilityHint="Answers this call" />
              </View>
            </View>
          ) : (
            <GlassDock
              primary={primaryDock}
              overflow={overflowDock}
              endCall={{ label: 'End call', onPress: () => endCall() }}
              oneHandedModeEnabled={oneHandedModeEnabled}
            />
          )}

          {addPersonNoticeOpen && (
            <Pressable style={styles.moreBackdrop} onPress={() => setAddPersonNoticeOpen(false)}>
              <BlurView intensity={60} tint="dark" style={styles.moreSheet}>
                <Text style={styles.moreTitle}>Add someone to this call</Text>
                <Text style={styles.moreHint}>1:1 calls can't grow into a group mid-call yet. End this call and start a Meeting Room from a group chat instead — everyone gets a push the moment it starts.</Text>
              </BlurView>
            </Pressable>
          )}
        </View>
      </View>
    </Modal>
  );
}

// Large circular accept/decline button — same visual language as
// GlassIconButton's press animation but bigger and solid-colored, matching
// how every serious calling UI (this one included) treats accept/decline
// as the two highest-stakes taps on the whole screen.
function GlassBadgeButton({ icon, color, label, onPress, accessibilityHint }: { icon: string; color: string; label: string; onPress: () => void; accessibilityHint?: string }) {
  const scale = useRef(new Animated.Value(1)).current;
  const press = () => {
    Animated.sequence([
      Animated.timing(scale, { toValue: 0.9, duration: 80, useNativeDriver: true }),
      Animated.spring(scale, { toValue: 1, useNativeDriver: true, ...callMotion.springSnappy }),
    ]).start();
    onPress();
  };
  return (
    <View style={{ alignItems: 'center', gap: 8 }}>
      <Animated.View style={{ transform: [{ scale }] }}>
        <Pressable onPress={press} accessibilityRole="button" accessibilityLabel={label} accessibilityHint={accessibilityHint} style={[styles.roundBtn, { backgroundColor: color }]}>
          <Text style={styles.roundBtnLabel}>{icon}</Text>
        </Pressable>
      </Animated.View>
      <Text style={styles.controlLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // paddingTop/paddingBottom deliberately NOT set here — applied inline
  // per-render from useSafeAreaInsets() instead, so this same style works
  // correctly on an SE (no notch), any notched iPhone, a Dynamic Island
  // model, and Android's variable status/nav bar heights, rather than one
  // fixed guess that was only ever right for whichever device it was
  // designed against.
  container: { flex: 1, justifyContent: 'space-between', paddingHorizontal: 24, backgroundColor: callColors.voidBottom },
  glowCircle: { position: 'absolute', width: 360, height: 360, borderRadius: 180 },
  // `top` likewise applied inline (insets.top + a small gap) for the same reason.
  badgeRow: { position: 'absolute', left: 0, right: 0, flexDirection: 'row', gap: 8, justifyContent: 'center', flexWrap: 'wrap' },
  qualityPill: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 7, overflow: 'hidden' },
  poorBanner: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  header: { alignItems: 'center', gap: 10, marginTop: 40 },
  name: { fontSize: 23, fontWeight: '700', color: callColors.textHi },
  statusPill: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 5, overflow: 'hidden', marginTop: 2 },
  status: { fontSize: 13, color: callColors.textHi, fontWeight: '500' },
  localPreview: {
    position: 'absolute',
    width: PIP_WIDTH,
    height: PIP_HEIGHT,
    borderRadius: 16,
    borderWidth: 2,
    overflow: 'hidden',
    zIndex: 5,
    top: 100,
  },
  controlsWrap: { alignItems: 'center', width: '100%' },
  incomingRow: { flexDirection: 'row', gap: 40, justifyContent: 'center', alignItems: 'flex-start' },
  controlCol: { alignItems: 'center', gap: 6, width: 72 },
  controlLabel: { fontSize: 11, color: callColors.textMid },
  roundBtn: { width: 66, height: 66, borderRadius: 33, alignItems: 'center', justifyContent: 'center' },
  roundBtnLabel: { fontSize: 25, color: '#fff', fontWeight: '700' },
  moreBackdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 230,
  },
  moreSheet: {
    width: '84%',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: callColors.glassBrd,
    padding: 18,
    alignItems: 'center',
    overflow: 'hidden',
  },
  moreTitle: { color: callColors.textHi, fontSize: 16, fontWeight: '700' },
  moreHint: { color: callColors.textMid, fontSize: 12.5, marginTop: 8, textAlign: 'center', lineHeight: 18 },
});
