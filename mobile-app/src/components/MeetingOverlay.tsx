// Redesigned group Meeting Room screen — task #223 of the calling-
// experience redesign. Dynamic grid that becomes a hero+filmstrip layout
// when a participant is pinned, a floating draggable self-preview when self
// isn't the pinned tile, host controls (mute-all, waiting room admit/deny),
// a waiting-room screen for gated joiners, and floating reactions.
//
// Explicit scope cuts, stated here rather than silently faked — all of
// these need real infrastructure this repo doesn't have installed, not
// just more UI code (see state/meeting.ts's own header for the full list):
//  - Active-speaker highlighting: would need per-participant audio-level
//    stats; pc.getStats() on the single SFU peer connection returns one
//    inbound-rtp report per remote track, but nothing in this file
//    associates a given report back to a specific participant reliably
//    enough to highlight them with confidence, so no tile gets a fake
//    "speaking now" ring.
//  - Screen sharing, background blur/replacement, live captions/
//    transcription, real-time recording capture: none of the underlying
//    capture/ML/STT pieces exist on mobile yet (screen-share signaling
//    itself already works generically server-side, see worker.js's
//    MeetingRoom — only the OS-level capture API is missing).
//  - Noise suppression / bandwidth adaptation beyond whatever Cloudflare
//    Calls and libwebrtc already do automatically under the hood.

import { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Modal, Alert, ScrollView, Animated, Easing, AccessibilityInfo } from 'react-native';
import { RTCView } from 'react-native-webrtc';
import { BlurView } from 'expo-blur';
import { useMeetingStore, type MeetingParticipant, type WaitingParticipant } from '../state/meeting';
import { initials, colorFromString } from '../utils/avatar';
import { callColors, callMotion } from '../theme/callTheme';
import { AnimatedAvatar, ConnectionQualityDots, GlassBadge, isReduceMotionEnabled } from './call/primitives';
import { GlassDock, type DockItem } from './call/GlassDock';

const REACTION_EMOJIS = ['👍', '❤️', '😂', '👏', '🎉', '🙌'];

// ---------------- Participant tile ----------------

function ParticipantTile({
  name,
  userId,
  videoStreamURL,
  hasAudio,
  mirror,
  isSelf,
  isHost,
  isPinned,
  audioLevel,
  onPress,
  onLongPress,
  hero,
}: {
  name: string;
  userId: string;
  videoStreamURL: string | null;
  hasAudio: boolean;
  mirror?: boolean;
  isSelf?: boolean;
  isHost?: boolean;
  isPinned?: boolean;
  audioLevel?: number | null;
  onPress?: () => void;
  onLongPress?: () => void;
  hero?: boolean;
}) {
  const color = colorFromString(userId, callColors.ice, callColors.fire);
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={`${name}${isSelf ? ' (you)' : ''}${isHost ? ', host' : ''}${!hasAudio ? ', muted' : ''}`}
      accessibilityHint={onLongPress ? 'Long-press for host options' : undefined}
      style={[styles.tile, { borderColor: isPinned ? callColors.ice : callColors.glassBrd }]}
    >
      {videoStreamURL ? (
        <RTCView streamURL={videoStreamURL} style={StyleSheet.absoluteFill} objectFit="cover" mirror={mirror} />
      ) : (
        <View style={styles.tileAvatarWrap}>
          <AnimatedAvatar name={name} userId={userId} size={hero ? 96 : 56} audioLevel={isSelf ? audioLevel ?? null : null} />
        </View>
      )}
      <View style={styles.tileFooter}>
        <BlurView intensity={40} tint="dark" style={styles.tileNamePill}>
          {isHost && <Text style={styles.tileHostIcon}>★</Text>}
          <Text style={styles.tileNameText} numberOfLines={1}>
            {isSelf ? `${name} (you)` : name}
          </Text>
          {!hasAudio && <Text style={styles.tileMuteIcon}>🔇</Text>}
        </BlurView>
      </View>
    </Pressable>
  );
}

// ---------------- Floating draggable self-preview (used only when someone
// else is pinned — otherwise self is just a normal grid/hero tile) ----------------

function FloatingSelfPreview({ streamURL, muted }: { streamURL: string | null; muted: boolean }) {
  const pan = useRef(new Animated.ValueXY({ x: 16, y: 90 })).current;
  const lastOffset = useRef({ x: 16, y: 90 });
  return (
    <Animated.View
      accessible
      accessibilityLabel="Your camera preview, draggable"
      style={[styles.floatingSelf, { transform: pan.getTranslateTransform() }]}
      onStartShouldSetResponder={() => true}
      onResponderMove={(e) => {
        pan.setValue({ x: e.nativeEvent.pageX - 54, y: e.nativeEvent.pageY - 76 });
      }}
      onResponderRelease={(e) => {
        lastOffset.current = { x: e.nativeEvent.pageX - 54, y: e.nativeEvent.pageY - 76 };
      }}
    >
      {streamURL ? (
        <RTCView streamURL={streamURL} style={StyleSheet.absoluteFill} objectFit="cover" mirror />
      ) : (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: callColors.glass, alignItems: 'center', justifyContent: 'center' }]}>
          <Text style={{ fontSize: 22 }}>{muted ? '🔇' : '🎤'}</Text>
        </View>
      )}
    </Animated.View>
  );
}

// ---------------- Floating reactions ----------------

function FloatingReactionParticle({ emoji, onDone }: { emoji: string; onDone: () => void }) {
  const rise = useRef(new Animated.Value(0)).current;
  const drift = useRef(new Animated.Value(Math.random() * 2 - 1)).current;
  useEffect(() => {
    Animated.timing(rise, {
      toValue: 1,
      duration: isReduceMotionEnabled() ? 400 : 2400,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start(onDone);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const translateY = rise.interpolate({ inputRange: [0, 1], outputRange: [0, -220] });
  const opacity = rise.interpolate({ inputRange: [0, 0.7, 1], outputRange: [1, 1, 0] });
  const scale = rise.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0.4, 1.1, 1] });
  return (
    <Animated.Text
      style={{
        position: 'absolute',
        bottom: 140,
        fontSize: 30,
        opacity,
        // `drift` is a fixed random -1..1 seed (not animated over time,
        // just a per-particle horizontal offset) — Animated.multiply needs
        // an Animated.Value on at least one side, which drift already is.
        transform: [{ translateY }, { translateX: Animated.multiply(drift, 40) }, { scale }],
      }}
    >
      {emoji}
    </Animated.Text>
  );
}

function FloatingReactions({ reactions }: { reactions: { id: string; emoji: string }[] }) {
  const [shown, setShown] = useState<{ id: string; emoji: string }[]>([]);
  const seen = useRef(new Set<string>());
  useEffect(() => {
    const fresh = reactions.filter((r) => !seen.current.has(r.id));
    if (fresh.length === 0) return;
    fresh.forEach((r) => seen.current.add(r.id));
    setShown((s) => [...s, ...fresh].slice(-12));
  }, [reactions]);
  return (
    <View style={styles.reactionLayer} pointerEvents="none">
      {shown.map((r) => (
        <FloatingReactionParticle key={r.id} emoji={r.emoji} onDone={() => setShown((s) => s.filter((x) => x.id !== r.id))} />
      ))}
    </View>
  );
}

// ---------------- Host: waiting-room admit sheet ----------------

function ParticipantsSheet({
  visible,
  onClose,
  isHost,
  waitingRoomEnabled,
  waitingList,
  participantCount,
  onToggleWaitingRoom,
  onAdmit,
  onDeny,
  onMuteAll,
}: {
  visible: boolean;
  onClose: () => void;
  isHost: boolean;
  waitingRoomEnabled: boolean;
  waitingList: WaitingParticipant[];
  participantCount: number;
  onToggleWaitingRoom: (enabled: boolean) => void;
  onAdmit: (userId: string) => void;
  onDeny: (userId: string) => void;
  onMuteAll: () => void;
}) {
  if (!visible) return null;
  return (
    <Pressable style={styles.moreBackdrop} onPress={onClose}>
      <Pressable onPress={(e) => e.stopPropagation()}>
        <BlurView intensity={64} tint="dark" style={styles.sheet}>
          <View style={styles.sheetGrip} />
          <Text style={styles.sheetTitle}>{participantCount} in the meeting</Text>
          {isHost && (
            <>
              <Pressable onPress={onMuteAll} style={styles.sheetRow} accessibilityRole="button" accessibilityLabel="Mute everyone">
                <Text style={styles.sheetRowText}>🔇 Mute everyone</Text>
              </Pressable>
              <Pressable
                onPress={() => onToggleWaitingRoom(!waitingRoomEnabled)}
                style={styles.sheetRow}
                accessibilityRole="switch"
                accessibilityState={{ checked: waitingRoomEnabled }}
                accessibilityLabel="Waiting room"
              >
                <Text style={styles.sheetRowText}>🚪 Waiting room</Text>
                <Text style={{ color: waitingRoomEnabled ? callColors.ok : callColors.textLow, fontWeight: '700' }}>{waitingRoomEnabled ? 'On' : 'Off'}</Text>
              </Pressable>
              {waitingList.length > 0 && (
                <>
                  <Text style={styles.sheetSubTitle}>Waiting to join</Text>
                  {waitingList.map((w) => (
                    <View key={w.userId} style={styles.waitingRow}>
                      <Text style={styles.sheetRowText} numberOfLines={1}>{w.name}</Text>
                      <View style={{ flexDirection: 'row', gap: 8 }}>
                        <Pressable onPress={() => onDeny(w.userId)} style={[styles.waitingBtn, { backgroundColor: callColors.danger }]} accessibilityLabel={`Deny ${w.name}`}>
                          <Text style={styles.waitingBtnText}>✕</Text>
                        </Pressable>
                        <Pressable onPress={() => onAdmit(w.userId)} style={[styles.waitingBtn, { backgroundColor: callColors.ok }]} accessibilityLabel={`Admit ${w.name}`}>
                          <Text style={styles.waitingBtnText}>✓</Text>
                        </Pressable>
                      </View>
                    </View>
                  ))}
                </>
              )}
            </>
          )}
        </BlurView>
      </Pressable>
    </Pressable>
  );
}

// ---------------- Tile action sheet (host long-press on a participant) ----------------

function TileActionSheet({
  participant,
  isPinned,
  onClose,
  onTogglePin,
  onRemove,
}: {
  participant: { userId: string; name: string } | null;
  isPinned: boolean;
  onClose: () => void;
  onTogglePin: () => void;
  onRemove: () => void;
}) {
  if (!participant) return null;
  return (
    <Pressable style={styles.moreBackdrop} onPress={onClose}>
      <Pressable onPress={(e) => e.stopPropagation()}>
        <BlurView intensity={64} tint="dark" style={styles.sheet}>
          <View style={styles.sheetGrip} />
          <Text style={styles.sheetTitle}>{participant.name}</Text>
          <Pressable onPress={onTogglePin} style={styles.sheetRow} accessibilityRole="button">
            <Text style={styles.sheetRowText}>{isPinned ? '📌 Unpin' : '📌 Pin for everyone on my screen'}</Text>
          </Pressable>
          <Pressable onPress={onRemove} style={styles.sheetRow} accessibilityRole="button">
            <Text style={[styles.sheetRowText, { color: callColors.danger }]}>⛔ Remove from meeting</Text>
          </Pressable>
        </BlurView>
      </Pressable>
    </Pressable>
  );
}

// Rendered once at the root (see app/_layout.tsx), same reasoning as
// CallOverlay — a meeting can be joined/invited-into regardless of which
// tab is currently open. Component name/default-export/no-props shape is
// unchanged from before this redesign, so the mount point needed no edits.
export default function MeetingOverlay() {
  const status = useMeetingStore((s) => s.status);
  const meetingName = useMeetingStore((s) => s.meetingName);
  const participants = useMeetingStore((s) => s.participants);
  const localStream = useMeetingStore((s) => s.localStream);
  const muted = useMeetingStore((s) => s.muted);
  const cameraOff = useMeetingStore((s) => s.cameraOff);
  const errorMessage = useMeetingStore((s) => s.errorMessage);
  const pendingInvite = useMeetingStore((s) => s.pendingInvite);
  const isHost = useMeetingStore((s) => s.isHost);
  const hostUserId = useMeetingStore((s) => s.hostUserId);
  const waitingRoomEnabled = useMeetingStore((s) => s.waitingRoomEnabled);
  const waitingList = useMeetingStore((s) => s.waitingList);
  const reactions = useMeetingStore((s) => s.reactions);
  const pinnedUserId = useMeetingStore((s) => s.pinnedUserId);
  const networkQuality = useMeetingStore((s) => s.networkQuality);
  const localAudioLevel = useMeetingStore((s) => s.localAudioLevel);
  const muteAllRequestedAt = useMeetingStore((s) => s.muteAllRequestedAt);
  const toggleMute = useMeetingStore((s) => s.toggleMute);
  const toggleCamera = useMeetingStore((s) => s.toggleCamera);
  const switchCamera = useMeetingStore((s) => s.switchCamera);
  const leaveMeeting = useMeetingStore((s) => s.leaveMeeting);
  const acceptInvite = useMeetingStore((s) => s.acceptInvite);
  const declineInvite = useMeetingStore((s) => s.declineInvite);
  const dismissError = useMeetingStore((s) => s.dismissError);
  const toggleWaitingRoom = useMeetingStore((s) => s.toggleWaitingRoom);
  const admitParticipant = useMeetingStore((s) => s.admitParticipant);
  const denyParticipant = useMeetingStore((s) => s.denyParticipant);
  const requestMuteAll = useMeetingStore((s) => s.requestMuteAll);
  const removeParticipant = useMeetingStore((s) => s.removeParticipant);
  const sendReaction = useMeetingStore((s) => s.sendReaction);
  const setPinnedUserId = useMeetingStore((s) => s.setPinnedUserId);
  const clearMuteAllToast = useMeetingStore((s) => s.clearMuteAllToast);

  const [participantsSheetOpen, setParticipantsSheetOpen] = useState(false);
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false);
  const [tileActionFor, setTileActionFor] = useState<{ userId: string; name: string } | null>(null);
  const [recordNoticeOpen, setRecordNoticeOpen] = useState(false);

  useEffect(() => {
    if (errorMessage) Alert.alert('Meeting problem', errorMessage, [{ text: 'OK', onPress: dismissError }]);
  }, [errorMessage, dismissError]);

  useEffect(() => {
    if (!muteAllRequestedAt) return;
    AccessibilityInfo.announceForAccessibility?.('The host muted everyone');
    const t = setTimeout(() => clearMuteAllToast(), 3200);
    return () => clearTimeout(t);
  }, [muteAllRequestedAt, clearMuteAllToast]);

  if (status === 'idle' && !pendingInvite) return null;

  // ---- Invite card ----
  if (pendingInvite && status === 'idle') {
    return (
      <Modal visible animationType="slide" presentationStyle="fullScreen" statusBarTranslucent>
        <View style={[styles.container, styles.centered]}>
          <AnimatedAvatar name={pendingInvite.fromName} userId={pendingInvite.fromUserId} size={112} breathing />
          <Text style={[styles.name, { marginTop: 16 }]}>{pendingInvite.meetingName || 'Group meeting'}</Text>
          <Text style={styles.subText}>{pendingInvite.fromName} is inviting you</Text>
          <View style={[styles.row, { marginTop: 40 }]}>
            <View style={styles.controlCol}>
              <Pressable onPress={declineInvite} style={[styles.roundBtn, { backgroundColor: callColors.danger }]} accessibilityRole="button" accessibilityLabel="Decline invite">
                <Text style={styles.roundBtnLabel}>✕</Text>
              </Pressable>
              <Text style={styles.controlLabel}>Decline</Text>
            </View>
            <View style={styles.controlCol}>
              <Pressable onPress={acceptInvite} style={[styles.roundBtn, { backgroundColor: callColors.ok }]} accessibilityRole="button" accessibilityLabel="Join meeting">
                <Text style={styles.roundBtnLabel}>✓</Text>
              </Pressable>
              <Text style={styles.controlLabel}>Join</Text>
            </View>
          </View>
        </View>
      </Modal>
    );
  }

  // ---- Waiting room (this device is the one gated) ----
  if (status === 'waiting-for-host') {
    return (
      <Modal visible animationType="slide" presentationStyle="fullScreen" statusBarTranslucent>
        <View style={[styles.container, styles.centered]}>
          <AnimatedAvatar name={meetingName || 'Meeting'} userId={meetingName || 'meeting'} size={100} breathing />
          <Text style={[styles.name, { marginTop: 16 }]}>Waiting to be let in</Text>
          <Text style={styles.subText}>The host will let you into {meetingName || 'the meeting'} shortly.</Text>
          <Pressable onPress={() => leaveMeeting()} style={[styles.roundBtn, { backgroundColor: callColors.danger, marginTop: 40 }]} accessibilityRole="button" accessibilityLabel="Cancel and leave">
            <Text style={styles.roundBtnLabel}>✕</Text>
          </Pressable>
          <Text style={styles.controlLabel}>Cancel</Text>
        </View>
      </Modal>
    );
  }

  const remoteList: MeetingParticipant[] = Object.values(participants);
  const totalCount = remoteList.length + 1;
  const pinnedIsSelf = pinnedUserId === 'me';
  const pinnedRemote = pinnedUserId && !pinnedIsSelf ? remoteList.find((p) => p.userId === pinnedUserId) : null;
  const heroActive = !!pinnedUserId && (pinnedIsSelf || !!pinnedRemote);
  const filmstripList = heroActive ? (pinnedIsSelf ? remoteList : [{ userId: 'me', name: 'You' } as any, ...remoteList.filter((p) => p.userId !== pinnedUserId)]) : [];
  const gridColumns = remoteList.length === 0 ? 1 : remoteList.length === 1 ? 2 : 2;

  const primaryDock: DockItem[] = [
    { key: 'mute', icon: muted ? '🔇' : '🎤', label: muted ? 'Unmute' : 'Mute', active: muted, onPress: toggleMute, accessibilityHint: muted ? 'Turns your microphone back on' : 'Turns your microphone off' },
    { key: 'camera', icon: '🎥', label: cameraOff ? 'Start video' : 'Stop video', active: !cameraOff, onPress: toggleCamera, accessibilityHint: cameraOff ? 'Turns your camera back on' : 'Turns your camera off' },
    { key: 'react', icon: '🙂', label: 'React', onPress: () => setReactionPickerOpen(true), accessibilityHint: 'Opens the reaction picker' },
    {
      key: 'participants',
      icon: '👥',
      label: 'People',
      badge: isHost && waitingList.length > 0,
      onPress: () => setParticipantsSheetOpen(true),
      accessibilityHint: isHost ? 'Host controls and waiting room' : 'See who is in the meeting',
    },
  ];
  const overflowDock: DockItem[] = [
    { key: 'flip', icon: '🔄', label: 'Flip camera', disabled: cameraOff, onPress: switchCamera, accessibilityHint: 'Switches between front and back camera' },
    { key: 'record', icon: '⏺️', label: 'Record', onPress: () => setRecordNoticeOpen(true), accessibilityHint: 'Explains recording availability' },
  ];

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" statusBarTranslucent>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.name} numberOfLines={1}>{meetingName || 'Meeting'}</Text>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 2 }}>
            <Text style={styles.subText}>{status === 'connecting' ? 'Connecting…' : `${totalCount} in the meeting`}</Text>
            {status === 'active' && <ConnectionQualityDots quality={networkQuality} size={2.5} />}
            {isHost && <GlassBadge label="Host" tone="neutral" />}
          </View>
        </View>

        {muteAllRequestedAt && (
          <View style={styles.toast} pointerEvents="none">
            <GlassBadge label="Host muted everyone" icon="🔇" tone="warn" />
          </View>
        )}

        {heroActive ? (
          <View style={styles.heroWrap}>
            {pinnedIsSelf ? (
              <ParticipantTile
                name="You"
                userId="me"
                videoStreamURL={!cameraOff && localStream ? localStream.toURL() : null}
                hasAudio={!muted}
                mirror
                isSelf
                isHost={isHost}
                isPinned
                hero
                audioLevel={localAudioLevel}
                onPress={() => setPinnedUserId(null)}
              />
            ) : pinnedRemote ? (
              <ParticipantTile
                name={pinnedRemote.name || 'Someone'}
                userId={pinnedRemote.userId}
                videoStreamURL={pinnedRemote.videoStream ? pinnedRemote.videoStream.toURL() : null}
                hasAudio={pinnedRemote.hasAudio}
                isHost={pinnedRemote.userId === hostUserId}
                isPinned
                hero
                onPress={() => setPinnedUserId(null)}
                onLongPress={isHost ? () => setTileActionFor({ userId: pinnedRemote.userId, name: pinnedRemote.name || 'Someone' }) : undefined}
              />
            ) : null}
            {!pinnedIsSelf && <FloatingSelfPreview streamURL={!cameraOff && localStream ? localStream.toURL() : null} muted={muted} />}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filmstrip} contentContainerStyle={{ gap: 8, paddingHorizontal: 4 }}>
              {filmstripList.map((p: any) =>
                p.userId === 'me' ? (
                  <View key="me" style={styles.filmstripTile}>
                    <ParticipantTile
                      name="You"
                      userId="me"
                      videoStreamURL={!cameraOff && localStream ? localStream.toURL() : null}
                      hasAudio={!muted}
                      mirror
                      isSelf
                      isHost={isHost}
                      audioLevel={localAudioLevel}
                      onPress={() => setPinnedUserId('me')}
                    />
                  </View>
                ) : (
                  <View key={p.userId} style={styles.filmstripTile}>
                    <ParticipantTile
                      name={p.name || 'Someone'}
                      userId={p.userId}
                      videoStreamURL={p.videoStream ? p.videoStream.toURL() : null}
                      hasAudio={p.hasAudio}
                      isHost={p.userId === hostUserId}
                      onPress={() => setPinnedUserId(p.userId)}
                      onLongPress={isHost ? () => setTileActionFor({ userId: p.userId, name: p.name || 'Someone' }) : undefined}
                    />
                  </View>
                )
              )}
            </ScrollView>
          </View>
        ) : (
          <ScrollView contentContainerStyle={[styles.grid, { flexDirection: gridColumns === 1 ? 'column' : 'row' }]}>
            <View style={[styles.tileWrap, { width: gridColumns === 1 ? '100%' : '48%' }]}>
              <ParticipantTile
                name="You"
                userId="me"
                videoStreamURL={!cameraOff && localStream ? localStream.toURL() : null}
                hasAudio={!muted}
                mirror
                isSelf
                isHost={isHost}
                audioLevel={localAudioLevel}
                onPress={() => setPinnedUserId('me')}
              />
            </View>
            {remoteList.map((p) => (
              <View key={p.userId} style={[styles.tileWrap, { width: gridColumns === 1 ? '100%' : '48%' }]}>
                <ParticipantTile
                  name={p.name || 'Someone'}
                  userId={p.userId}
                  videoStreamURL={p.videoStream ? p.videoStream.toURL() : null}
                  hasAudio={p.hasAudio}
                  isHost={p.userId === hostUserId}
                  onPress={() => setPinnedUserId(p.userId)}
                  onLongPress={isHost ? () => setTileActionFor({ userId: p.userId, name: p.name || 'Someone' }) : undefined}
                />
              </View>
            ))}
          </ScrollView>
        )}

        <FloatingReactions reactions={reactions} />

        <View style={styles.controlsWrap}>
          <GlassDock primary={primaryDock} overflow={overflowDock} endCall={{ label: 'Leave meeting', onPress: () => leaveMeeting() }} />
        </View>

        {reactionPickerOpen && (
          <Pressable style={styles.moreBackdrop} onPress={() => setReactionPickerOpen(false)}>
            <Pressable onPress={(e) => e.stopPropagation()}>
              <BlurView intensity={60} tint="dark" style={[styles.sheet, { paddingBottom: 30 }]}>
                <View style={styles.sheetGrip} />
                <View style={{ flexDirection: 'row', gap: 18, justifyContent: 'center' }}>
                  {REACTION_EMOJIS.map((e) => (
                    <Pressable
                      key={e}
                      onPress={() => {
                        sendReaction(e);
                        setReactionPickerOpen(false);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`React with ${e}`}
                    >
                      <Text style={{ fontSize: 30 }}>{e}</Text>
                    </Pressable>
                  ))}
                </View>
              </BlurView>
            </Pressable>
          </Pressable>
        )}

        <ParticipantsSheet
          visible={participantsSheetOpen}
          onClose={() => setParticipantsSheetOpen(false)}
          isHost={isHost}
          waitingRoomEnabled={waitingRoomEnabled}
          waitingList={waitingList}
          participantCount={totalCount}
          onToggleWaitingRoom={toggleWaitingRoom}
          onAdmit={admitParticipant}
          onDeny={denyParticipant}
          onMuteAll={requestMuteAll}
        />

        <TileActionSheet
          participant={tileActionFor}
          isPinned={!!tileActionFor && pinnedUserId === tileActionFor.userId}
          onClose={() => setTileActionFor(null)}
          onTogglePin={() => {
            if (!tileActionFor) return;
            setPinnedUserId(pinnedUserId === tileActionFor.userId ? null : tileActionFor.userId);
            setTileActionFor(null);
          }}
          onRemove={() => {
            if (!tileActionFor) return;
            removeParticipant(tileActionFor.userId);
            setTileActionFor(null);
          }}
        />

        {recordNoticeOpen && (
          <Pressable style={styles.moreBackdrop} onPress={() => setRecordNoticeOpen(false)}>
            <BlurView intensity={60} tint="dark" style={styles.sheet}>
              <View style={styles.sheetGrip} />
              <Text style={styles.sheetTitle}>Recording</Text>
              <Text style={styles.sheetHint}>Recording capture isn't wired up on mobile yet — the backend can already transcribe and summarize a recording once one exists (see Settings on the web app), it's just the actual mic+call audio capture on this device that's still missing.</Text>
            </BlurView>
          </Pressable>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingVertical: 50, backgroundColor: callColors.voidBottom },
  centered: { justifyContent: 'center', alignItems: 'center' },
  header: { alignItems: 'center', gap: 2, marginBottom: 10, paddingHorizontal: 16 },
  name: { fontSize: 18, fontWeight: '700', color: callColors.textHi },
  subText: { color: callColors.textLow, fontSize: 12.5 },
  toast: { alignItems: 'center', marginBottom: 8 },
  grid: { flexWrap: 'wrap', gap: '4%', paddingBottom: 20, paddingHorizontal: 12 },
  tileWrap: { aspectRatio: 3 / 4, marginBottom: 12 },
  tile: { flex: 1, borderRadius: 18, borderWidth: 1.5, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  tileAvatarWrap: { alignItems: 'center', justifyContent: 'center' },
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
  tileHostIcon: { fontSize: 10, color: callColors.warn },
  heroWrap: { flex: 1, paddingHorizontal: 12 },
  filmstrip: { maxHeight: 96, marginTop: 10 },
  filmstripTile: { width: 72, height: 88 },
  floatingSelf: {
    position: 'absolute',
    width: 108,
    height: 152,
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: callColors.glassBrdHi,
    zIndex: 5,
    top: 8,
    right: 8,
  },
  reactionLayer: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 260, alignItems: 'center' },
  controlsWrap: { alignItems: 'center', width: '100%', paddingTop: 8 },
  row: { flexDirection: 'row', gap: 28, justifyContent: 'center', alignItems: 'flex-start' },
  controlCol: { alignItems: 'center', gap: 6, width: 64 },
  controlLabel: { fontSize: 11, color: callColors.textMid },
  roundBtn: { width: 62, height: 62, borderRadius: 31, alignItems: 'center', justifyContent: 'center' },
  roundBtnLabel: { fontSize: 24, color: '#fff', fontWeight: '700' },
  moreBackdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'flex-end' },
  sheet: {
    width: '100%',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 10,
    paddingBottom: 40,
    paddingHorizontal: 20,
    borderWidth: 1,
    borderColor: callColors.glassBrd,
    borderBottomWidth: 0,
    overflow: 'hidden',
  },
  sheetGrip: { width: 36, height: 4, borderRadius: 2, backgroundColor: callColors.glassBrdHi, alignSelf: 'center', marginBottom: 14 },
  sheetTitle: { color: callColors.textHi, fontSize: 16, fontWeight: '700', marginBottom: 6 },
  sheetSubTitle: { color: callColors.textMid, fontSize: 12.5, fontWeight: '600', marginTop: 10, marginBottom: 4 },
  sheetRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12 },
  sheetRowText: { color: callColors.textHi, fontSize: 14.5, flexShrink: 1 },
  sheetHint: { color: callColors.textMid, fontSize: 12.5, lineHeight: 18, marginTop: 4 },
  waitingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8 },
  waitingBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  waitingBtnText: { color: '#fff', fontWeight: '700' },
});
