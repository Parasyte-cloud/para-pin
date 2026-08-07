// Group meeting (Cloudflare Realtime SFU) state machine — ports index.html's
// Meeting Room client (index.html:7410-8000ish) to react-native-webrtc,
// which mirrors browser WebRTC closely enough that this is a genuinely
// close port rather than a re-architecture: same sessions/new ->
// tracks/new (publish) -> tracks/new (pull, one per remote track) ->
// renegotiate dance against the same /api/meeting/sfu/* proxy, same
// MeetingRoom Durable Object presence WebSocket, same one-negotiation-at-
// a-time queue (WebRTC only allows one offer/answer in flight per
// RTCPeerConnection).
//
// This round (calling-UI redesign) added real host controls, a waiting
// room, and ephemeral reactions — all server-enforced in the MeetingRoom
// Durable Object, not just hidden client-side (see worker.js's MeetingRoom
// class). Host is whoever the DO first saw join; if they leave, the
// longest-present remaining participant is promoted automatically.
//
// Screen sharing (startScreenShare/stopScreenShare below): react-native-
// webrtc genuinely ships mediaDevices.getDisplayMedia() + a
// ScreenCapturePickerView native component on both platforms (verified by
// reading the installed package's native modules directly, not assumed
// from the JS API surface alone) — this is NOT the same "impossible without
// ejecting" situation as background blur/captions below.
//   - Android: works end-to-end after a normal `expo prebuild` + build —
//     the library's own AndroidManifest.xml fragment already declares the
//     foregroundServiceType="mediaProjection" service it needs, Gradle's
//     manifest merger picks it up automatically, no manual native edit.
//   - iOS: getDisplayMedia() will resolve a track that silently never
//     produces any frames until a Broadcast Upload Extension exists — this
//     genuinely can't be added by editing source files in this repo, it's
//     a new Xcode target. Needed, concretely: (1) a Broadcast Upload
//     Extension target with a SampleHandler that streams frames into an App
//     Group-shared Unix socket (protocol implied by react-native-webrtc's
//     ios/RCTWebRTC/SocketConnection.*), (2) an App Group entitlement
//     shared by the app and the extension, (3) Info.plist keys
//     RTCAppGroupIdentifier (the App Group ID) and RTCScreenSharingExtension
//     (the extension's bundle ID) on the main app target. None of the
//     installed config plugins (@config-plugins/react-native-webrtc) add
//     any of this — confirmed by reading its source, it only wires up
//     camera/mic Info.plist strings and bitcode. The client code below
//     works identically on both platforms either way; only iOS needs that
//     one-time Xcode addition before real frames actually flow.
// The SFU publish/pull signaling itself needed ZERO backend changes — it
// was already fully generic (worker.js's MeetingRoom DO literally has "mic,
// camera, screen-share, ..." in its own comment for the 'publish' message
// type), a screen track is just another trackName/kind pair to it.
//
// Other deliberate scope cuts vs. web, all workspace/AI features with no
// direct mobile UI to attach to yet, or requiring native/ML capability this
// repo doesn't have installed:
//  - No background blur/replacement (needs a real-time ML segmentation
//    dependency, none installed).
//  - No live captions/transcription (needs an on-device or streaming STT
//    dependency, none installed; the existing POST /api/meeting/ai-
//    assistant endpoint already does AFTER-the-fact Whisper transcription +
//    summary from an uploaded recording, which is a legitimate, real,
//    different feature this file doesn't wire mobile's Record button into
//    yet, since actually capturing the mixed mic+remote audio locally needs
//    a native audio-capture module this app doesn't have either).
//  - No transfer/add-person mid-meeting invite picker (there's no
//    standalone contacts/roster browser on mobile to pick people from, see
//    mobile-app/README.md — inviting still only works from a group chat's
//    own member list, same as before this round).

import { create } from 'zustand';
import {
  RTCPeerConnection,
  MediaStream,
  mediaDevices,
  type MediaStreamTrack,
} from 'react-native-webrtc';
import { apiFetch, wsUrl } from '../api/client';
import { useSessionStore } from './session';
import { getIceServers } from './callSignal';
import { startNetworkMonitor } from '../utils/callNetworkMonitor';
import type { NetworkQuality } from '../theme/callTheme';

export interface MeetingInviteSignal {
  kind: 'meeting-invite';
  meetingId: string;
  meetingName: string | null;
  orgId: string | null;
  fromUserId: string;
  fromName: string;
  fromAvatarUrl: string | null;
}

export interface MeetingParticipant {
  userId: string;
  name: string;
  avatarUrl: string | null;
  videoStream: MediaStream | null;
  // Separate from videoStream on purpose — a participant can be sharing
  // their screen AND have their camera on at the same time (the trackName
  // convention keeps them as two independent tracks, 'video-'+userId vs
  // 'screen-'+userId), the UI needs to tell them apart to show the screen
  // share prominently instead of just replacing the camera tile.
  screenStream: MediaStream | null;
  hasAudio: boolean;
}

export interface WaitingParticipant {
  userId: string;
  name: string;
  avatarUrl: string | null;
}

export interface MeetingReaction {
  id: string;
  userId: string;
  name: string;
  emoji: string;
  ts: number;
}

export type MeetingStatus = 'idle' | 'connecting' | 'waiting-for-host' | 'active';
export type KnockDenied = 'denied' | 'removed' | null;

interface WrapsTrackResponse {
  sessionId?: string;
  tracks?: Array<{ mid?: string; trackName?: string; sessionDescription?: { type: string; sdp: string } }>;
  sessionDescription?: { type: string; sdp: string };
  requiresImmediateRenegotiation?: boolean;
  error?: string;
  errorDescription?: string;
}

// Non-reactive native handles — same reasoning as call.ts's rtcPeerConn:
// large non-serializable objects that never need to trigger a re-render on
// their own, only the derived Zustand state below does.
let meetingWs: WebSocket | null = null;
let meetingPc: RTCPeerConnection | null = null;
let meetingSfuSessionId: string | null = null;
let meetingLocalStreamRef: MediaStream | null = null;
// The local getDisplayMedia() capture track, kept module-level (not in
// Zustand state, same reasoning as meetingPc/meetingWs above) so both the
// native 'ended' listener and stopScreenShare() can find and stop the exact
// same track instance without round-tripping through React state.
let meetingScreenTrack: MediaStreamTrack | null = null;
let midToTrack: Record<string, { userId: string; kind: string }> = {};
let pulledTracks = new Set<string>();
let wsPingInterval: ReturnType<typeof setInterval> | null = null;
let negotiationQueue: Promise<void> = Promise.resolve();
let stopNetworkMonitor: (() => void) | null = null;
// Presence-socket reconnect bookkeeping — mirrors index.html's
// connectMeetingWs (meetingConnectAttempts/meetingWsReconnectTimer). This
// was previously entirely absent on mobile (flagged inline as an explicit,
// known gap): a dropped presence socket just left this device's presence
// stale in the room until it explicitly left, with no self-healing at all.
let meetingConnectAttempts = 0;
let meetingWsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reactionExpiryTimers: ReturnType<typeof setTimeout>[] = [];

function enqueue(fn: () => Promise<void>) {
  negotiationQueue = negotiationQueue.then(fn).catch(() => {});
  return negotiationQueue;
}

async function sfuFetch(path: string, opts: { method: string; body?: string }): Promise<{ ok: boolean; body: WrapsTrackResponse | null; status: number }> {
  // Bounded, same reasoning as web's meetingSfuFetch — every pull/publish
  // shares the one negotiation queue, so a single hung request would
  // otherwise park everything queued behind it forever.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await apiFetch<WrapsTrackResponse>('/meeting/sfu/' + path, { ...opts, signal: controller.signal });
    return res;
  } catch {
    return { ok: false, body: null, status: 0 };
  } finally {
    clearTimeout(timeoutId);
  }
}

interface MeetingState {
  status: MeetingStatus;
  meetingId: string | null;
  meetingName: string | null;
  orgId: string | null;
  participants: Record<string, MeetingParticipant>;
  localStream: MediaStream | null;
  muted: boolean;
  cameraOff: boolean;
  errorMessage: string | null;
  pendingInvite: MeetingInviteSignal | null;

  // --- added this round ---
  hostUserId: string | null;
  isHost: boolean;
  waitingRoomEnabled: boolean;
  waitingList: WaitingParticipant[]; // only ever populated for the host
  knockDenied: KnockDenied; // this device's own knock outcome, if denied/removed
  reactions: MeetingReaction[]; // ephemeral, auto-expire
  pinnedUserId: string | null; // pure client UI state, no server round trip
  networkQuality: NetworkQuality;
  localAudioLevel: number | null;
  muteAllRequestedAt: number | null; // bumped on receipt, UI shows a one-shot toast then clears it
  // Real getDisplayMedia()-backed screen share, see this file's header
  // comment for the honest Android-works/iOS-needs-one-Xcode-target
  // breakdown. isScreenSharing/screenShareStream are LOCAL (this device);
  // remote participants' shares show up as MeetingParticipant.screenStream.
  isScreenSharing: boolean;
  screenShareStream: MediaStream | null;
  screenShareError: string | null;

  startMeeting: (meetingName: string, orgId: string | null, inviteUserIds: string[]) => Promise<void>;
  handleMeetingInvite: (signal: MeetingInviteSignal) => void;
  acceptInvite: () => Promise<void>;
  declineInvite: () => void;
  leaveMeeting: () => void;
  toggleMute: () => void;
  toggleCamera: () => void;
  switchCamera: () => void;
  dismissError: () => void;

  toggleWaitingRoom: (enabled: boolean) => void;
  admitParticipant: (userId: string) => void;
  denyParticipant: (userId: string) => void;
  requestMuteAll: () => void;
  removeParticipant: (userId: string) => void;
  sendReaction: (emoji: string) => void;
  setPinnedUserId: (userId: string | null) => void;
  clearMuteAllToast: () => void;
  startScreenShare: () => Promise<void>;
  stopScreenShare: () => void;
  dismissScreenShareError: () => void;
}

export const useMeetingStore = create<MeetingState>((set, get) => {
  function teardown() {
    if (wsPingInterval) clearInterval(wsPingInterval);
    wsPingInterval = null;
    if (meetingWsReconnectTimer) clearTimeout(meetingWsReconnectTimer);
    meetingWsReconnectTimer = null;
    meetingConnectAttempts = 0;
    if (stopNetworkMonitor) stopNetworkMonitor();
    stopNetworkMonitor = null;
    reactionExpiryTimers.forEach(clearTimeout);
    reactionExpiryTimers = [];
    if (meetingWs) {
      try {
        meetingWs.close();
      } catch {
        // already closed/closing
      }
      meetingWs = null;
    }
    if (meetingPc) {
      try {
        meetingPc.close();
      } catch {
        // already closed/closing
      }
      meetingPc = null;
    }
    if (meetingLocalStreamRef) {
      meetingLocalStreamRef.getTracks().forEach((t: MediaStreamTrack) => t.stop());
      meetingLocalStreamRef = null;
    }
    if (meetingScreenTrack) {
      try {
        meetingScreenTrack.stop();
      } catch {
        // already stopped
      }
      meetingScreenTrack = null;
    }
    meetingSfuSessionId = null;
    midToTrack = {};
    pulledTracks = new Set();
    negotiationQueue = Promise.resolve();
  }

  // `signalKind` is OUR own publish-time label ('audio'/'video'/'screen',
  // see midToTrack — carried through from pullTrack's server-provided
  // `kind`), NOT the native MediaStreamTrack.kind, which is only ever
  // 'audio'/'video' at the WebRTC level and can't tell a screen-share video
  // track apart from a camera one — that distinction only exists in this
  // app's own signaling, so routing has to key off signalKind, not
  // track.kind, or a screen share would just overwrite the camera tile.
  function attachTrack(userId: string, name: string, avatarUrl: string | null, track: MediaStreamTrack, stream: MediaStream, signalKind: string) {
    set((s) => {
      const existing = s.participants[userId] || { userId, name, avatarUrl, videoStream: null, screenStream: null, hasAudio: false };
      const next = {
        ...existing,
        name: name || existing.name,
        avatarUrl: avatarUrl ?? existing.avatarUrl,
        videoStream: signalKind === 'video' ? stream : existing.videoStream,
        screenStream: signalKind === 'screen' ? stream : existing.screenStream,
        hasAudio: signalKind === 'audio' ? true : existing.hasAudio,
      };
      return { participants: { ...s.participants, [userId]: next } };
    });
  }

  function removeParticipantLocal(userId: string) {
    set((s) => {
      const next = { ...s.participants };
      delete next[userId];
      return { participants: next };
    });
    for (const [mid, info] of Object.entries(midToTrack)) {
      if (info.userId === userId) delete midToTrack[mid];
    }
    // Also drop this user's pull-dedupe entries (bug fix: pulledTracks
    // previously only ever grew for the life of the meeting. Without this,
    // someone who left and rejoined the SAME meeting — or even just
    // dropped/restored their own presence socket while staying published —
    // would come back with a trackName pullTrack() had already marked as
    // "pulled", so their video/audio would silently never get re-requested
    // for anyone already in the call.
    for (const key of pulledTracks) {
      if (key.startsWith(userId + '|')) pulledTracks.delete(key);
    }
  }

  function pullTrack(userId: string, name: string, avatarUrl: string | null, remoteSessionId: string | null, trackName: string, kind: string) {
    if (!remoteSessionId || !trackName) return;
    const dedupeKey = userId + '|' + trackName;
    if (pulledTracks.has(dedupeKey)) return;
    pulledTracks.add(dedupeKey);

    enqueue(async () => {
      if (!meetingPc || !meetingSfuSessionId) {
        pulledTracks.delete(dedupeKey);
        return;
      }
      const pullOnce = () =>
        sfuFetch(`sessions/${meetingSfuSessionId}/tracks/new`, {
          method: 'POST',
          body: JSON.stringify({ tracks: [{ location: 'remote', sessionId: remoteSessionId, trackName }] }),
        });
      let r = await pullOnce();
      if (!r.ok || !r.body) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        r = await pullOnce();
      }
      if (!r.ok || !r.body) {
        pulledTracks.delete(dedupeKey);
        return;
      }
      const track = (r.body.tracks || [])[0];
      if (track && track.mid) {
        midToTrack[track.mid] = { userId, kind };
        // Track name/avatar alongside the mid too, so the ontrack handler
        // (which only has a mid) can render this participant correctly
        // even if it fires before any 'roster'/'participant-joined' text
        // updates land — same reasoning as web's meetingMidToTrack, kept
        // here as a closure-captured object rather than a second map.
        (midToTrack[track.mid] as any).name = name;
        (midToTrack[track.mid] as any).avatarUrl = avatarUrl;
      }
      if (r.body.requiresImmediateRenegotiation && r.body.sessionDescription) {
        await meetingPc.setRemoteDescription(r.body.sessionDescription as any);
        const answer = await meetingPc.createAnswer();
        await meetingPc.setLocalDescription(answer);
        await sfuFetch(`sessions/${meetingSfuSessionId}/renegotiate`, {
          method: 'PUT',
          body: JSON.stringify({ sessionDescription: { type: answer.type, sdp: answer.sdp } }),
        });
      }
    });
  }

  function publishLocalTracks() {
    return enqueue(async () => {
      if (!meetingPc || !meetingSfuSessionId) return;
      const myUserId = useSessionStore.getState().userId || '';
      const offer = await meetingPc.createOffer(undefined);
      await meetingPc.setLocalDescription(offer);
      const tracksPayload = meetingPc
        .getTransceivers()
        .filter((t) => t.sender && t.sender.track)
        .map((t) => ({
          location: 'local',
          mid: t.mid,
          trackName: (t.sender.track!.kind === 'video' ? 'video-' : 'audio-') + myUserId,
        }));
      if (tracksPayload.length === 0) return;
      const publishOnce = () =>
        sfuFetch(`sessions/${meetingSfuSessionId}/tracks/new`, {
          method: 'POST',
          body: JSON.stringify({ sessionDescription: { type: offer.type, sdp: offer.sdp }, tracks: tracksPayload }),
        });
      let r = await publishOnce();
      if (!r.ok || !r.body || !r.body.sessionDescription) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        r = await publishOnce();
      }
      if (!r.ok || !r.body || !r.body.sessionDescription) return;
      await meetingPc.setRemoteDescription(r.body.sessionDescription as any);
      tracksPayload.forEach((t) =>
        wsSend({ type: 'publish', trackName: t.trackName, kind: t.trackName.startsWith('video') ? 'video' : 'audio' })
      );
    });
  }

  // Renegotiates to publish ONLY the just-added screen transceiver —
  // deliberately separate from publishLocalTracks (which re-sends every
  // transceiver with a live sender.track) because that function derives
  // trackName purely from track.kind ('video'/'audio'), which can't tell a
  // screen-share video track apart from the camera's; reusing it here would
  // both mis-name the screen track 'video-'+userId (colliding with the
  // already-published camera track) and needlessly re-POST tracks/new for
  // tracks the SFU already has. Errors are absorbed into screenShareError
  // state rather than thrown — enqueue()'s own .catch already swallows
  // rejections, so a caller awaiting this can never observe a throw.
  function publishScreenTrack(mid: string | null) {
    return enqueue(async () => {
      if (!meetingPc || !meetingSfuSessionId || !mid) {
        set({ screenShareError: 'Could not start screen sharing.', isScreenSharing: false, screenShareStream: null });
        return;
      }
      const myUserId = useSessionStore.getState().userId || '';
      const trackName = 'screen-' + myUserId;
      const offer = await meetingPc.createOffer(undefined);
      await meetingPc.setLocalDescription(offer);
      const publishOnce = () =>
        sfuFetch(`sessions/${meetingSfuSessionId}/tracks/new`, {
          method: 'POST',
          body: JSON.stringify({
            sessionDescription: { type: offer.type, sdp: offer.sdp },
            tracks: [{ location: 'local', mid, trackName }],
          }),
        });
      let r = await publishOnce();
      if (!r.ok || !r.body || !r.body.sessionDescription) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        r = await publishOnce();
      }
      if (!r.ok || !r.body || !r.body.sessionDescription) {
        if (meetingScreenTrack) {
          try {
            meetingScreenTrack.stop();
          } catch {
            // already stopped
          }
          meetingScreenTrack = null;
        }
        set({ screenShareError: 'Could not start screen sharing — try again.', isScreenSharing: false, screenShareStream: null });
        return;
      }
      await meetingPc.setRemoteDescription(r.body.sessionDescription as any);
      wsSend({ type: 'publish', trackName, kind: 'screen' });
    });
  }

  function wsSend(payload: unknown) {
    if (meetingWs && meetingWs.readyState === WebSocket.OPEN) meetingWs.send(JSON.stringify(payload));
  }

  // Runs the "actually join" sequence — mint an SFU session, publish local
  // tracks, send invites — now factored out of the ws 'open' handler so it
  // can be triggered either immediately (a genuine reconnect, which always
  // bypasses the waiting room server-side) or once the very first 'roster'
  // message proves this connection attempt was NOT gated into waiting.
  async function completeJoin(inviteUserIds: string[]) {
    const { meetingId, meetingName, orgId } = get();
    const r = await sfuFetch('sessions/new', { method: 'POST' });
    if (!r.ok || !r.body || !r.body.sessionId) {
      const err = (r.body && (r.body.error || r.body.errorDescription)) || `HTTP ${r.status || '?'}`;
      set({
        errorMessage:
          err === 'sfu_not_configured'
            ? 'Meeting server not set up yet on this deployment.'
            : `Could not start the meeting: ${err}`,
      });
      get().leaveMeeting();
      return;
    }
    meetingSfuSessionId = r.body.sessionId;
    wsSend({ type: 'set-session', sfuSessionId: meetingSfuSessionId });
    set({ status: 'active' });
    if (meetingPc) {
      stopNetworkMonitor = startNetworkMonitor(meetingPc, (sample) => {
        set({ networkQuality: sample.quality, localAudioLevel: sample.localAudioLevel });
      });
    }
    await publishLocalTracks();
    for (const toUserId of inviteUserIds) {
      apiFetch('/meeting/invite', {
        method: 'POST',
        body: JSON.stringify({ toUserId, meetingId, meetingName, orgId }),
      }).catch(() => {});
    }
  }

  function scheduleReactionExpiry(id: string) {
    const t = setTimeout(() => {
      set((s) => ({ reactions: s.reactions.filter((r) => r.id !== id) }));
    }, 2600);
    reactionExpiryTimers.push(t);
  }

  function handleWsMessage(data: any) {
    const myUserId = useSessionStore.getState().userId;

    if (data.type === 'waiting') {
      set({ status: 'waiting-for-host' });
      return;
    }
    if (data.type === 'admitted') {
      // The gating socket was a dead end (server never processes anything
      // on it beyond ping) — close it and open a real one, now armed with
      // the one-time admit pass the server just granted this userId.
      try { meetingWs?.close(); } catch {}
      meetingWs = null;
      const pendingInvites: string[] = (get() as any)._pendingInviteUserIds || [];
      connectWs(pendingInvites, false);
      return;
    }
    if (data.type === 'denied') {
      set({ knockDenied: 'denied', errorMessage: "The host didn't let you into this meeting." });
      get().leaveMeeting();
      return;
    }
    if (data.type === 'removed') {
      set({ knockDenied: 'removed', errorMessage: 'The host removed you from this meeting.' });
      get().leaveMeeting();
      return;
    }
    if (data.type === 'roster') {
      (data.participants || []).forEach((p: any) => {
        if (p.userId === myUserId) return;
        set((s) => ({
          participants: {
            ...s.participants,
            [p.userId]: s.participants[p.userId] || { userId: p.userId, name: p.name, avatarUrl: p.avatarUrl || null, videoStream: null, screenStream: null, hasAudio: false },
          },
        }));
        (p.tracks || []).forEach((t: any) => pullTrack(p.userId, p.name, p.avatarUrl || null, p.sfuSessionId, t.trackName, t.kind));
      });
      set({
        hostUserId: data.hostUserId || null,
        isHost: !!myUserId && data.hostUserId === myUserId,
        waitingRoomEnabled: !!data.waitingRoomEnabled,
        waitingList: Array.isArray(data.waiting) ? data.waiting : [],
      });
      // First 'roster' this connection has seen since opening — this is
      // the "you actually got in" signal for a fresh (non-reconnect) join
      // that wasn't gated into the waiting room; see connectWs's 'open'.
      const alreadyJoined = (get() as any)._joinCompletedFor === meetingWs;
      if (!alreadyJoined && get().status !== 'active') {
        (get() as any)._joinCompletedFor = meetingWs;
        completeJoin((get() as any)._pendingInviteUserIds || []);
      }
      return;
    }
    if (data.type === 'host-changed') {
      set({ hostUserId: data.hostUserId, isHost: data.hostUserId === myUserId });
      return;
    }
    if (data.type === 'waiting-room-changed') {
      set({ waitingRoomEnabled: !!data.enabled });
      return;
    }
    if (data.type === 'knock') {
      if (!get().isHost) return;
      set((s) => (s.waitingList.some((w) => w.userId === data.userId) ? s : { waitingList: [...s.waitingList, { userId: data.userId, name: data.name, avatarUrl: data.avatarUrl || null }] }));
      return;
    }
    if (data.type === 'mute-all') {
      if (data.byUserId !== myUserId) {
        const { localStream, muted } = get();
        if (!muted) {
          localStream?.getAudioTracks().forEach((t: MediaStreamTrack) => { t.enabled = false; });
          set({ muted: true });
        }
      }
      set({ muteAllRequestedAt: Date.now() });
      return;
    }
    if (data.type === 'reaction') {
      const entry: MeetingReaction = { id: `${data.userId}-${Date.now()}-${Math.random()}`, userId: data.userId, name: data.name || 'Someone', emoji: data.emoji, ts: Date.now() };
      set((s) => ({ reactions: [...s.reactions, entry] }));
      scheduleReactionExpiry(entry.id);
      return;
    }
    if (data.type === 'participant-joined') {
      if (data.userId === myUserId) return;
      set((s) => ({
        participants: {
          ...s.participants,
          [data.userId]: s.participants[data.userId] || { userId: data.userId, name: data.name, avatarUrl: data.avatarUrl || null, videoStream: null, screenStream: null, hasAudio: false },
        },
      }));
      return;
    }
    if (data.type === 'participant-left') {
      removeParticipantLocal(data.userId);
      set((s) => ({ waitingList: s.waitingList.filter((w) => w.userId !== data.userId) }));
      return;
    }
    if (data.type === 'participant-track') {
      if (data.userId === myUserId) return;
      const p = get().participants[data.userId];
      pullTrack(data.userId, p?.name || 'Someone', p?.avatarUrl ?? null, data.sfuSessionId, data.trackName, data.kind);
      return;
    }
    if (data.type === 'participant-untrack') {
      // Same dedupe-staleness bug as removeParticipantLocal, narrower case:
      // publishLocalTracks always reuses the SAME trackName ('video-'+userId)
      // for as long as that user's session lives, so someone turning their
      // camera off (unpublish) then back on (publish again, identical
      // trackName) would hit pullTrack's dedupe cache on the re-publish and
      // never actually get pulled — their video would stay blank for
      // everyone else even though they've turned the camera back on.
      // trackName tells us which kind (worker.js's MeetingRoom always
      // includes it on this message type, see the 'unpublish' handler).
      if (data.trackName) pulledTracks.delete(data.userId + '|' + data.trackName);
      const isVideo = typeof data.trackName === 'string' && data.trackName.startsWith('video-');
      const isAudio = typeof data.trackName === 'string' && data.trackName.startsWith('audio-');
      const isScreen = typeof data.trackName === 'string' && data.trackName.startsWith('screen-');
      set((s) => {
        const existing = s.participants[data.userId];
        if (!existing) return s;
        return {
          participants: {
            ...s.participants,
            [data.userId]: {
              ...existing,
              videoStream: isVideo ? null : existing.videoStream,
              screenStream: isScreen ? null : existing.screenStream,
              hasAudio: isAudio ? false : existing.hasAudio,
            },
          },
        };
      });
      return;
    }
  }

  function connectWs(inviteUserIds: string[], isReconnect: boolean) {
    const { meetingId, orgId } = get();
    (get() as any)._pendingInviteUserIds = inviteUserIds;
    const params: Record<string, string> = { meetingId: meetingId! };
    if (orgId) params.orgId = orgId;
    const ws = new WebSocket(wsUrl('/meeting/room/ws', params));
    meetingWs = ws;
    ws.addEventListener('message', (ev) => {
      let data: any;
      try {
        data = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if (data.type === 'pong') return;
      handleWsMessage(data);
    });
    ws.addEventListener('open', async () => {
      // A real connect (first join or a reconnect) happened, don't let a
      // handful of ordinary transient drops spread across a long meeting
      // (each one reconnecting fine) add up toward the give-up threshold
      // below even though every single one actually succeeded.
      meetingConnectAttempts = 0;
      if (wsPingInterval) clearInterval(wsPingInterval);
      wsPingInterval = setInterval(() => wsSend({ type: 'ping' }), 20000);

      if (isReconnect) {
        if (meetingSfuSessionId) wsSend({ type: 'set-session', sfuSessionId: meetingSfuSessionId });
        if (meetingPc) {
          meetingPc
            .getTransceivers()
            .filter((t) => t.sender && t.sender.track)
            .forEach((t) =>
              wsSend({
                type: 'publish',
                trackName: (t.sender.track!.kind === 'video' ? 'video-' : 'audio-') + useSessionStore.getState().userId,
                kind: t.sender.track!.kind,
              })
            );
        }
        return;
      }

      // Deliberately does nothing else here — whether this connection is
      // let straight in or gated into the waiting room is decided
      // server-side and only known once the FIRST message arrives ('roster'
      // = in, 'waiting' = gated). See handleWsMessage's 'roster' branch for
      // where completeJoin() actually fires for a fresh join.
    });
    ws.addEventListener('close', () => {
      // `meetingWs !== ws` covers two cases at once: teardown() already ran
      // (it nulls meetingWs before closing, an intentional leave) or a
      // newer connectWs() already superseded this one (including the
      // waiting-room -> admitted transition, which closes the old socket
      // itself) — either way this stale close event must not also schedule
      // its own reconnect on top.
      //
      // Bug fix: this check used to run AFTER clearing wsPingInterval below,
      // which raced the 'admitted' transition specifically — the NEW
      // socket's 'open' handler (which starts its own ping interval and
      // overwrites the module-level wsPingInterval variable) can fire before
      // the OLD socket's 'close' event does, so the old handler would end up
      // clearInterval-ing the NEW connection's interval and nulling the
      // variable out from under it, silently leaving the meeting with no
      // presence heartbeat at all until the next drop/reconnect. Checking
      // staleness first means a stale close event never touches the current
      // connection's interval.
      if (meetingWs !== ws) return;
      if (wsPingInterval) clearInterval(wsPingInterval);
      wsPingInterval = null;
      meetingWs = null;
      if (get().status === 'waiting-for-host') return; // denied/left while waiting, not a drop to recover from
      // The RTCPeerConnection/SFU session are independent of this presence
      // socket (same reasoning as web), so a drop doesn't end the meeting
      // outright. Mirrors index.html's connectMeetingWs: bounded retries
      // with a jittered delay, not indefinite.
      if (!get().meetingId) return;
      meetingConnectAttempts++;
      if (meetingConnectAttempts > 4) {
        set({ errorMessage: "Lost the connection to this meeting. It may be full, or the network dropped." });
        get().leaveMeeting();
        return;
      }
      if (meetingWsReconnectTimer) clearTimeout(meetingWsReconnectTimer);
      const delay = 1000 + Math.random() * 2000;
      meetingWsReconnectTimer = setTimeout(() => {
        meetingWsReconnectTimer = null;
        if (get().meetingId) connectWs(inviteUserIds, true);
      }, delay);
    });
  }

  async function beginMeeting(id: string, name: string, orgId: string | null, inviteUserIds: string[]) {
    if (get().status !== 'idle') get().leaveMeeting();
    set({
      status: 'connecting',
      meetingId: id,
      meetingName: name,
      orgId,
      participants: {},
      muted: false,
      cameraOff: false,
      errorMessage: null,
      pendingInvite: null,
      hostUserId: null,
      isHost: false,
      waitingRoomEnabled: false,
      waitingList: [],
      knockDenied: null,
      reactions: [],
      pinnedUserId: null,
      networkQuality: 'unknown',
      localAudioLevel: null,
      muteAllRequestedAt: null,
      isScreenSharing: false,
      screenShareStream: null,
      screenShareError: null,
    });

    let stream: MediaStream;
    try {
      stream = (await mediaDevices.getUserMedia({ audio: true, video: { facingMode: 'user' } })) as unknown as MediaStream;
    } catch {
      set({ errorMessage: 'Camera and microphone access is needed to join a meeting.', status: 'idle', meetingId: null });
      return;
    }
    meetingLocalStreamRef = stream;
    set({ localStream: stream });

    const iceServers = await getIceServers();
    const pc = new RTCPeerConnection({ iceServers });
    stream.getTracks().forEach((t: MediaStreamTrack) => pc.addTrack(t, stream));
    // @ts-expect-error react-native-webrtc's event-target-shim types this loosely; the shape matches RTCTrackEvent
    pc.addEventListener('track', (ev: any) => {
      const mid = ev.transceiver && ev.transceiver.mid;
      const info = mid != null ? (midToTrack as any)[mid] : null;
      if (!info) return;
      attachTrack(info.userId, info.name || 'Someone', info.avatarUrl ?? null, ev.track, ev.streams[0], info.kind);
    });
    meetingPc = pc;

    connectWs(inviteUserIds, false);
  }

  return {
    status: 'idle',
    meetingId: null,
    meetingName: null,
    orgId: null,
    participants: {},
    localStream: null,
    muted: false,
    cameraOff: false,
    errorMessage: null,
    pendingInvite: null,

    hostUserId: null,
    isHost: false,
    waitingRoomEnabled: false,
    waitingList: [],
    knockDenied: null,
    reactions: [],
    pinnedUserId: null,
    networkQuality: 'unknown',
    localAudioLevel: null,
    muteAllRequestedAt: null,
    isScreenSharing: false,
    screenShareStream: null,
    screenShareError: null,

    startMeeting: async (meetingName, orgId, inviteUserIds) => {
      const id = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : String(Date.now()) + Math.random();
      await beginMeeting(id, meetingName, orgId, inviteUserIds);
    },

    // Called from useNotifySocket.ts whenever a {kind:'meeting-invite'}
    // signal arrives. Same "don't stack a prompt over something already
    // active" reasoning as 1:1 calls declining a second offer while busy —
    // the inviter never learns it was auto-declined, same as a missed call.
    handleMeetingInvite: (signal) => {
      if (get().status !== 'idle') return;
      // Import lazily to avoid a require cycle at module-eval time between
      // call.ts and meeting.ts (neither actually needs the other's state
      // at import time, only inside these handler bodies).
      const { useCallStore } = require('./call');
      if (useCallStore.getState().callState !== 'idle') return;
      set({ pendingInvite: signal });
    },

    acceptInvite: async () => {
      const invite = get().pendingInvite;
      if (!invite) return;
      // Re-check busy state at accept time, not just when the invite first
      // arrived (handleMeetingInvite's own check) — a 1:1 call can start
      // in the window between the invite showing up and the user actually
      // tapping Accept.
      const { useCallStore } = require('./call');
      if (useCallStore.getState().callState !== 'idle') {
        set({ pendingInvite: null, errorMessage: "Can't join — you're on another call." });
        return;
      }
      await beginMeeting(invite.meetingId, invite.meetingName || 'Meeting', invite.orgId, []);
    },

    declineInvite: () => set({ pendingInvite: null }),

    leaveMeeting: () => {
      teardown();
      set({
        status: 'idle',
        meetingId: null,
        meetingName: null,
        orgId: null,
        participants: {},
        localStream: null,
        muted: false,
        cameraOff: false,
        hostUserId: null,
        isHost: false,
        waitingRoomEnabled: false,
        waitingList: [],
        reactions: [],
        pinnedUserId: null,
        networkQuality: 'unknown',
        localAudioLevel: null,
        muteAllRequestedAt: null,
        isScreenSharing: false,
        screenShareStream: null,
        screenShareError: null,
      });
    },

    toggleMute: () => {
      const { localStream, muted } = get();
      localStream?.getAudioTracks().forEach((t: MediaStreamTrack) => {
        t.enabled = muted;
      });
      set({ muted: !muted });
    },

    toggleCamera: () => {
      const { localStream, cameraOff } = get();
      localStream?.getVideoTracks().forEach((t: MediaStreamTrack) => {
        t.enabled = cameraOff;
      });
      set({ cameraOff: !cameraOff });
    },

    // Same real react-native-webrtc extension method call.ts's switchCamera
    // uses (`_switchCamera()`, not in the public TS types hence the cast) —
    // was missing here entirely; camera switching mid-meeting silently did
    // nothing before this.
    switchCamera: () => {
      const { localStream } = get();
      localStream?.getVideoTracks().forEach((t: any) => {
        if (typeof t._switchCamera === 'function') t._switchCamera();
      });
    },

    dismissError: () => set({ errorMessage: null }),

    startScreenShare: async () => {
      if (get().isScreenSharing || !meetingPc) return;
      set({ screenShareError: null });
      let stream: MediaStream;
      try {
        // No constraints object needed — unlike getUserMedia, getDisplayMedia
        // always goes through the OS's own picker (Control Center broadcast
        // sheet on iOS, the system share-a-screen dialog on Android), which
        // is where the person actually chooses what gets captured.
        stream = (await mediaDevices.getDisplayMedia({})) as unknown as MediaStream;
      } catch {
        // Person cancelled the OS picker or refused permission — not a real
        // error worth surfacing as a banner, same as declining a camera
        // prompt elsewhere in this store.
        return;
      }
      const track = stream.getVideoTracks()[0];
      if (!track) {
        stream.getTracks().forEach((t: MediaStreamTrack) => t.stop());
        set({ screenShareError: 'Screen sharing is not available on this device.' });
        return;
      }
      meetingScreenTrack = track;
      // Fires when the person stops sharing from the OS's own control (iOS
      // Control Center "Stop Broadcast", Android's persistent share
      // notification) instead of this app's own button — the same native
      // event both platforms' capture surfaces raise through
      // react-native-webrtc, so one listener covers both stop paths.
      // Cast to `any`: react-native-webrtc's published MediaStreamTrack.d.ts
      // imports its EventTarget base from a relative './vendor/event-target-
      // shim' path that only exists in the package's own src/ tree, not in
      // the shipped lib/typescript/ output (confirmed by checking
      // node_modules directly) — a real gap in their published types, not a
      // capability MediaStreamTrack actually lacks; it's a genuine
      // EventTarget at runtime and 'ended' genuinely fires here.
      (track as any).addEventListener('ended', () => {
        if (meetingScreenTrack === track) get().stopScreenShare();
      });
      const sender = meetingPc.addTrack(track, stream);
      const transceiver = meetingPc.getTransceivers().find((t) => t.sender === sender);
      set({ isScreenSharing: true, screenShareStream: stream });
      await publishScreenTrack(transceiver?.mid ?? null);
    },

    stopScreenShare: () => {
      if (!get().isScreenSharing) return;
      const myUserId = useSessionStore.getState().userId || '';
      const track = meetingScreenTrack;
      meetingScreenTrack = null;
      // Best-effort: pull the track off its sender immediately so the SFU
      // stops getting frames right away, rather than waiting on the stopped
      // track to time out server-side. Deliberately not renegotiated away
      // (same minimalism as toggleCamera above, which also never removes
      // the transceiver) — the 'unpublish' signal below is what actually
      // tells other participants to clear the tile; a dead sender left in
      // the SDP is harmless.
      if (meetingPc && track) {
        const sender = meetingPc.getSenders().find((s: any) => s.track === track);
        if (sender) {
          try {
            sender.replaceTrack(null);
          } catch {
            // sender already gone (peer connection torn down mid-call)
          }
        }
      }
      if (track) {
        try {
          track.stop();
        } catch {
          // already stopped (e.g. this ran from the track's own 'ended' event)
        }
      }
      wsSend({ type: 'unpublish', trackName: 'screen-' + myUserId });
      set({ isScreenSharing: false, screenShareStream: null });
    },

    dismissScreenShareError: () => set({ screenShareError: null }),

    // ---- host controls (server double-checks isHost on every one of
    // these too — see MeetingRoom's message handler — this is UX-speed,
    // not the actual authorization boundary) ----
    toggleWaitingRoom: (enabled) => {
      if (!get().isHost) return;
      wsSend({ type: 'set-waiting-room', enabled });
    },
    admitParticipant: (userId) => {
      if (!get().isHost) return;
      wsSend({ type: 'admit', targetUserId: userId });
      set((s) => ({ waitingList: s.waitingList.filter((w) => w.userId !== userId) }));
    },
    denyParticipant: (userId) => {
      if (!get().isHost) return;
      wsSend({ type: 'deny', targetUserId: userId });
      set((s) => ({ waitingList: s.waitingList.filter((w) => w.userId !== userId) }));
    },
    requestMuteAll: () => {
      if (!get().isHost) return;
      wsSend({ type: 'mute-all' });
    },
    removeParticipant: (userId) => {
      if (!get().isHost) return;
      wsSend({ type: 'remove-participant', targetUserId: userId });
    },
    sendReaction: (emoji) => {
      wsSend({ type: 'reaction', emoji });
      const myUserId = useSessionStore.getState().userId || 'me';
      const myName = useSessionStore.getState().displayName || 'You';
      const entry: MeetingReaction = { id: `local-${Date.now()}-${Math.random()}`, userId: myUserId, name: myName, emoji, ts: Date.now() };
      set((s) => ({ reactions: [...s.reactions, entry] }));
      scheduleReactionExpiry(entry.id);
    },
    setPinnedUserId: (userId) => set({ pinnedUserId: userId }),
    clearMuteAllToast: () => set({ muteAllRequestedAt: null }),
  };
});
