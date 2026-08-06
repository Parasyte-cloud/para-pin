// 1:1 audio/video call state machine — ports index.html's call handling
// (index.html:6572-6994) as closely as react-native-webrtc's API (which
// deliberately mirrors browser WebRTC) allows. Signaling rides the same
// always-open notify socket every client keeps connected (see
// useNotifySocket.ts); offer/answer/ICE/end all travel as REST calls
// relayed through the other person's UserChannel DO. Audio/video itself is
// peer-to-peer WebRTC and never touches the Worker.
//
// An incoming call vibrates AND now plays the synthesized ringtone (see
// startRinging/stopRinging below and utils/ringtonePlayer.ts/
// ringtoneSynth.ts) — real PCM audio generated in JS to match web's Web
// Audio oscillator tones exactly, since there's no Web Audio API on-device
// to run the same trick live. Outgoing calls get the matching ringback
// tone too (started in startOutgoingCall, stopped in onCallConnected).
// This only fires while the app is foregrounded and the always-open
// notify socket is connected; a backgrounded/killed app has no CallKit/
// VoIP-push integration, so it only gets whatever the push-notification
// path delivers (see mobile-app/src/state/push.ts) — a real background
// ring would need that separate, bigger native piece of work.
// Group/meeting calls (Cloudflare Calls SFU) are a separate path — see
// state/meeting.ts.

import { Vibration } from 'react-native';
import { create } from 'zustand';
import {
  RTCPeerConnection,
  RTCIceCandidate,
  mediaDevices,
  MediaStream,
  type MediaStreamTrack,
} from 'react-native-webrtc';
import { useSessionStore } from './session';
import { getIceServers, sendCallSignal, logCallEntry, type CallSignal } from './callSignal';
import { playIncomingRingtone, playOutgoingRingback, stopRingAudio } from '../utils/ringtonePlayer';

export type CallState = 'idle' | 'ringing-out' | 'ringing-in' | 'connected';

const RING_TIMEOUT_MS = 30000;
const CONNECT_TIMEOUT_MS = 15000;
const DISCONNECT_GRACE_MS = 12000;

// Not part of the Zustand state on purpose — these are large, non-
// serializable native objects that never need to trigger a re-render by
// themselves (only the derived state below does), same as index.html
// keeping `rtcPeerConn` as a plain top-level `let`, not reactive state.
let rtcPeerConn: RTCPeerConnection | null = null;
let pendingRemoteOfferSdp: string | null = null;
let pendingIceCandidates: unknown[] = [];
let ringTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
let connectTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
let disconnectGraceTimer: ReturnType<typeof setTimeout> | null = null;
let callTimerInterval: ReturnType<typeof setInterval> | null = null;
// One ICE-restart attempt per call, not per 'failed' event — mirrors
// index.html's iceRestartAttempted. Reset in teardownMedia (finishCall).
let iceRestartAttempted = false;

interface CallStoreState {
  callState: CallState;
  callId: string | null;
  peerId: string | null;
  peerName: string | null;
  peerAvatarUrl: string | null;
  direction: 'incoming' | 'outgoing' | null;
  hasVideo: boolean;
  muted: boolean;
  cameraOff: boolean;
  speakerOn: boolean;
  awaitingConnection: boolean;
  callStartedAt: number | null;
  elapsedSec: number;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  connectError: string | null;
  // Which workspace this call belongs to — see callSignal.ts's CallSignal/
  // CallLogEntry.orgId comments. Threaded through so the call-log entry
  // this device writes lands in the same workspace as whichever chat (or
  // incoming offer) the call started from.
  orgId: string | null;

  startOutgoingCall: (peerId: string, peerName: string, peerAvatarUrl: string | null, video: boolean, orgId?: string | null) => Promise<void>;
  acceptCall: () => Promise<void>;
  declineCall: (reason?: string) => void;
  endCall: (reason?: string) => void;
  toggleMute: () => void;
  toggleCamera: () => void;
  toggleSpeaker: () => void;
  switchCamera: () => void;
  handleCallSignal: (signal: CallSignal) => void;
  dismissConnectError: () => void;
}

// Repeating buzz-pause-buzz pattern (`true` as the second arg repeats
// until Vibration.cancel() is called) layered with the actual synthesized
// ringtone audio — vibration alone used to be the whole story here, see
// this file's header comment for why that was the known gap.
function startRinging() {
  Vibration.vibrate([0, 700, 500], true);
  playIncomingRingtone().catch(() => {});
}
function stopRinging() {
  Vibration.cancel();
  stopRingAudio();
}

function clearAllTimers() {
  if (ringTimeoutTimer) clearTimeout(ringTimeoutTimer);
  if (connectTimeoutTimer) clearTimeout(connectTimeoutTimer);
  if (disconnectGraceTimer) clearTimeout(disconnectGraceTimer);
  if (callTimerInterval) clearInterval(callTimerInterval);
  ringTimeoutTimer = null;
  connectTimeoutTimer = null;
  disconnectGraceTimer = null;
  callTimerInterval = null;
}

async function createPeerConnection(
  peerId: string,
  direction: 'incoming' | 'outgoing',
  getCallId: () => string | null,
  onRemoteStream: (stream: MediaStream) => void,
  onConnected: () => void,
  onClosed: () => void,
  onDisconnected: () => void
): Promise<RTCPeerConnection> {
  const iceServers = await getIceServers();
  const pc = new RTCPeerConnection({ iceServers });

  // @ts-expect-error react-native-webrtc's event-target-shim types this loosely; the shape matches RTCPeerConnectionIceEvent
  pc.addEventListener('icecandidate', (ev: any) => {
    if (ev.candidate) sendCallSignal(peerId, { kind: 'ice-candidate', callId: getCallId(), candidate: ev.candidate.toJSON() });
  });
  // @ts-expect-error same as above — RTCTrackEvent
  pc.addEventListener('track', (ev: any) => {
    if (ev.streams && ev.streams[0]) onRemoteStream(ev.streams[0]);
  });
  // @ts-expect-error same as above — react-native-webrtc's shim types addEventListener too loosely for a plain 'connectionstatechange' Event
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'connected') {
      if (disconnectGraceTimer) {
        clearTimeout(disconnectGraceTimer);
        disconnectGraceTimer = null;
      }
      onConnected();
    }
    if (pc.connectionState === 'closed') {
      if (disconnectGraceTimer) {
        clearTimeout(disconnectGraceTimer);
        disconnectGraceTimer = null;
      }
      onClosed();
    }
    // 'failed' never self-recovers the way 'disconnected' sometimes does —
    // it needs an application-level ICE restart (a fresh offer/answer with
    // iceRestart:true) or the call is just dead. Mirrors index.html's
    // identical fix: only the original caller ('outgoing' direction)
    // initiates the restart, a deterministic tie-breaker so both sides
    // don't race each other; the callee just rides out the same grace
    // window waiting for either a spontaneous recovery or the incoming
    // restart offer (see handleCallSignal's 'ice-restart-offer'/
    // 'ice-restart-answer' below). Falls through to the exact same
    // onDisconnected('hangup') callback either way if nothing pans out —
    // same worst case as before this fix, only the success case improves.
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      if (pc.connectionState === 'failed' && direction === 'outgoing' && !iceRestartAttempted) {
        iceRestartAttempted = true;
        (pc.createOffer({ iceRestart: true } as any) as Promise<any>)
          .then((offer: any) => pc.setLocalDescription(offer).then(() => offer))
          .then((offer: any) => sendCallSignal(peerId, { kind: 'ice-restart-offer', callId: getCallId(), sdp: offer.sdp }))
          .catch(() => {});
      }
      if (disconnectGraceTimer) clearTimeout(disconnectGraceTimer);
      disconnectGraceTimer = setTimeout(() => {
        disconnectGraceTimer = null;
        onDisconnected();
      }, DISCONNECT_GRACE_MS);
    }
  });
  return pc;
}

export const useCallStore = create<CallStoreState>((set, get) => {
  function teardownMedia() {
    const { localStream } = get();
    if (localStream) {
      localStream.getTracks().forEach((t: MediaStreamTrack) => t.stop());
    }
    if (rtcPeerConn) {
      try {
        rtcPeerConn.close();
      } catch {
        // already closed/closing
      }
      rtcPeerConn = null;
    }
    pendingRemoteOfferSdp = null;
    pendingIceCandidates = [];
    iceRestartAttempted = false;
  }

  function finishCall(reason: string | undefined, alreadyLogged: boolean) {
    stopRinging();
    clearAllTimers();
    const state = get();
    if (!alreadyLogged && state.peerId) {
      const wasConnected = state.callState === 'connected';
      const durationSec = state.callStartedAt ? Math.round((Date.now() - state.callStartedAt) / 1000) : 0;
      const outcome = wasConnected ? 'answered' : reason === 'busy' ? 'busy' : 'missed';
      logCallEntry({
        withUserId: state.peerId,
        withName: state.peerName,
        withAvatarUrl: state.peerAvatarUrl,
        direction: state.direction === 'incoming' ? 'incoming' : 'outgoing',
        outcome,
        durationSec,
        isVideo: state.hasVideo,
        orgId: state.orgId,
      });
    }
    teardownMedia();
    set({
      callState: 'idle',
      callId: null,
      peerId: null,
      peerName: null,
      peerAvatarUrl: null,
      direction: null,
      hasVideo: false,
      muted: false,
      cameraOff: false,
      speakerOn: false,
      awaitingConnection: false,
      callStartedAt: null,
      elapsedSec: 0,
      localStream: null,
      remoteStream: null,
      orgId: null,
    });
  }

  function onCallConnected() {
    if (get().callState === 'connected') return;
    // Stops the outgoing ringback the instant the call actually connects —
    // acceptCall()/finishCall() already call this for the incoming-ring
    // side, but a caller going ringing-out -> connected never passes
    // through either of those, so without this the ringback tone would
    // keep looping underneath a now-live call.
    stopRinging();
    set({ callState: 'connected', callStartedAt: Date.now(), awaitingConnection: false, elapsedSec: 0 });
    if (ringTimeoutTimer) clearTimeout(ringTimeoutTimer);
    if (connectTimeoutTimer) clearTimeout(connectTimeoutTimer);
    ringTimeoutTimer = null;
    connectTimeoutTimer = null;
    callTimerInterval = setInterval(() => {
      const startedAt = get().callStartedAt;
      if (startedAt) set({ elapsedSec: Math.round((Date.now() - startedAt) / 1000) });
    }, 1000);
  }

  function startAwaitingConnection() {
    set({ awaitingConnection: true });
    if (connectTimeoutTimer) clearTimeout(connectTimeoutTimer);
    connectTimeoutTimer = setTimeout(() => {
      const s = get();
      if (s.callState !== 'idle' && s.callState !== 'connected') {
        set({ connectError: "Couldn't connect this call — the two networks likely need a TURN relay your admin hasn't configured yet." });
        get().endCall('connect-timeout');
      }
    }, CONNECT_TIMEOUT_MS);
  }

  function flushPendingIceCandidates() {
    if (!rtcPeerConn) return;
    pendingIceCandidates.forEach((c) => rtcPeerConn!.addIceCandidate(new RTCIceCandidate(c as any)).catch(() => {}));
    pendingIceCandidates = [];
  }

  return {
    callState: 'idle',
    callId: null,
    peerId: null,
    peerName: null,
    peerAvatarUrl: null,
    direction: null,
    hasVideo: false,
    muted: false,
    cameraOff: false,
    speakerOn: false,
    awaitingConnection: false,
    callStartedAt: null,
    elapsedSec: 0,
    localStream: null,
    remoteStream: null,
    connectError: null,
    orgId: null,

    startOutgoingCall: async (peerId, peerName, peerAvatarUrl, video, orgId = null) => {
      if (get().callState !== 'idle') return;
      let stream: MediaStream;
      try {
        stream = (await mediaDevices.getUserMedia({ audio: true, video })) as unknown as MediaStream;
      } catch {
        set({ connectError: video ? 'Camera and microphone access is needed to make a video call.' : 'Microphone access is needed to make a call.' });
        return;
      }
      const callId = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : String(Date.now()) + Math.random();
      set({
        callId,
        peerId,
        peerName: peerName || 'PArA PIN user',
        peerAvatarUrl,
        direction: 'outgoing',
        callState: 'ringing-out',
        hasVideo: video,
        // Video calls default to speaker (matches how the OS/WebRTC's own
        // default routing already behaves); audio calls default to
        // earpiece, same convention as FaceTime/most VoIP apps.
        speakerOn: video,
        localStream: stream,
        connectError: null,
        orgId,
      });
      playOutgoingRingback().catch(() => {});
      const pc = await createPeerConnection(
        peerId,
        'outgoing',
        () => get().callId,
        (remoteStream) => set({ remoteStream }),
        onCallConnected,
        () => get().endCall('hangup'),
        () => get().endCall('hangup')
      );
      rtcPeerConn = pc;
      stream.getTracks().forEach((t: MediaStreamTrack) => pc.addTrack(t, stream));
      const offer = await pc.createOffer(undefined);
      await pc.setLocalDescription(offer);
      await sendCallSignal(peerId, { kind: 'offer', callId, sdp: offer.sdp, video, orgId });
      ringTimeoutTimer = setTimeout(() => {
        if (get().callState === 'ringing-out') get().endCall('no-answer');
      }, RING_TIMEOUT_MS);
    },

    acceptCall: async () => {
      const s = get();
      if (s.callState !== 'ringing-in' || !s.peerId) return;
      stopRinging();
      if (ringTimeoutTimer) {
        clearTimeout(ringTimeoutTimer);
        ringTimeoutTimer = null;
      }
      let stream: MediaStream;
      try {
        stream = (await mediaDevices.getUserMedia({ audio: true, video: s.hasVideo })) as unknown as MediaStream;
      } catch {
        set({ connectError: s.hasVideo ? 'Camera and microphone access is needed to answer a video call.' : 'Microphone access is needed to answer a call.' });
        get().declineCall('declined');
        return;
      }
      set({ localStream: stream });
      const pc = await createPeerConnection(
        s.peerId,
        'incoming',
        () => get().callId,
        (remoteStream) => set({ remoteStream }),
        onCallConnected,
        () => get().endCall('hangup'),
        () => get().endCall('hangup')
      );
      rtcPeerConn = pc;
      stream.getTracks().forEach((t: MediaStreamTrack) => pc.addTrack(t, stream));
      await pc.setRemoteDescription({ type: 'offer', sdp: pendingRemoteOfferSdp! });
      flushPendingIceCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sendCallSignal(s.peerId, { kind: 'answer', callId: s.callId, sdp: answer.sdp });
      startAwaitingConnection();
    },

    declineCall: (reason) => {
      const s = get();
      if (s.callState !== 'ringing-in') return;
      if (ringTimeoutTimer) {
        clearTimeout(ringTimeoutTimer);
        ringTimeoutTimer = null;
      }
      if (s.peerId) sendCallSignal(s.peerId, { kind: 'end', callId: s.callId, reason: reason || 'declined' });
      logCallEntry({
        withUserId: s.peerId,
        withName: s.peerName,
        withAvatarUrl: s.peerAvatarUrl,
        direction: 'incoming',
        outcome: reason === 'no-answer' ? 'missed' : 'declined',
        durationSec: 0,
        isVideo: s.hasVideo,
        orgId: s.orgId,
      });
      finishCall(reason || 'declined', true);
    },

    endCall: (reason) => {
      const s = get();
      if (s.callState === 'idle') return;
      const wasConnected = s.callState === 'connected';
      const durationSec = s.callStartedAt ? Math.round((Date.now() - s.callStartedAt) / 1000) : 0;
      if (s.peerId) {
        sendCallSignal(s.peerId, {
          kind: 'end',
          callId: s.callId,
          reason: reason || (wasConnected ? 'hangup' : 'no-answer'),
          durationSec,
          direction: s.direction,
          video: s.hasVideo,
        });
      }
      logCallEntry({
        withUserId: s.peerId,
        withName: s.peerName,
        withAvatarUrl: s.peerAvatarUrl,
        direction: s.direction === 'incoming' ? 'incoming' : 'outgoing',
        outcome: wasConnected ? 'answered' : 'missed',
        durationSec,
        isVideo: s.hasVideo,
        orgId: s.orgId,
      });
      finishCall(reason, true);
    },

    toggleMute: () => {
      const { localStream, muted } = get();
      localStream?.getAudioTracks().forEach((t: MediaStreamTrack) => {
        t.enabled = muted; // currently muted -> re-enable; currently unmuted -> disable
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

    // Known cut: react-native-webrtc (the version installed here) doesn't
    // expose an actual iOS/Android audio-route override (no
    // setSpeakerphoneOn-style native method — checked the installed
    // package's native module surface directly, see mobile-app/README.md).
    // Adding one means a new native module + config plugin + rebuild, the
    // same class of change as the WebRTC dependency itself needed. This
    // toggle is real UI state (drives the button's active look, and
    // reflects the OS's own default routing — speaker for video calls,
    // earpiece for audio) but doesn't force a route change of its own on
    // top of whatever the OS/WebRTC already picked. Flagged rather than
    // silently faked so it isn't mistaken for a broken feature later.
    toggleSpeaker: () => set((s) => ({ speakerOn: !s.speakerOn })),

    // `_switchCamera()` is a real react-native-webrtc extension method on
    // video tracks (not in the public TS types, hence the cast) — flips
    // between front/back camera on a live video call.
    switchCamera: () => {
      const { localStream } = get();
      localStream?.getVideoTracks().forEach((t: any) => {
        if (typeof t._switchCamera === 'function') t._switchCamera();
      });
    },

    dismissConnectError: () => set({ connectError: null }),

    handleCallSignal: (signal) => {
      if (!signal || !signal.kind) return;
      const s = get();
      const myUserId = useSessionStore.getState().userId;

      if (signal.kind === 'offer') {
        // Also busy-reject while in a group meeting — meeting.ts's own
        // handleMeetingInvite already checks the reverse (won't surface a
        // meeting invite while mid 1:1-call), but this side of that same
        // "only one call thing at a time" rule was missing: without it, a
        // 1:1 offer arriving during an active meeting would still ring and
        // let acceptCall() grab a second getUserMedia() stream on top of
        // the meeting's already-live one.
        const { useMeetingStore } = require('./meeting');
        const inMeeting = useMeetingStore.getState().status !== 'idle';
        if (s.callState !== 'idle' || inMeeting) {
          if (signal.fromUserId) sendCallSignal(signal.fromUserId, { kind: 'end', callId: signal.callId, reason: 'busy' });
          return;
        }
        pendingRemoteOfferSdp = signal.sdp || null;
        set({
          callId: signal.callId,
          peerId: signal.fromUserId || null,
          peerName: signal.fromName || 'Someone',
          peerAvatarUrl: signal.fromAvatarUrl || null,
          direction: 'incoming',
          callState: 'ringing-in',
          hasVideo: !!signal.video,
          speakerOn: !!signal.video,
          connectError: null,
          orgId: signal.orgId ?? null,
        });
        startRinging();
        ringTimeoutTimer = setTimeout(() => {
          if (get().callState === 'ringing-in') get().declineCall('no-answer');
        }, RING_TIMEOUT_MS);
        return;
      }

      if (signal.callId !== s.callId) return; // stale or unrelated call

      if (signal.kind === 'answer') {
        if (rtcPeerConn && s.callState === 'ringing-out') {
          rtcPeerConn
            .setRemoteDescription({ type: 'answer', sdp: signal.sdp! })
            .then(flushPendingIceCandidates)
            .catch(() => {});
          if (ringTimeoutTimer) {
            clearTimeout(ringTimeoutTimer);
            ringTimeoutTimer = null;
          }
          startAwaitingConnection();
        }
        return;
      }
      if (signal.kind === 'ice-candidate') {
        // BUG FIXED HERE (this was silently dropping candidates, the
        // likely #1 cause of "calls sometimes just don't connect"): the
        // caller starts trickling ICE candidates the instant its offer is
        // sent, but the callee doesn't create `rtcPeerConn` until
        // acceptCall() runs — and a human tapping "Accept" always takes
        // at least a second or two. Every candidate that arrives during
        // that ringing window used to be thrown away outright instead of
        // queued, because the old check was `if (rtcPeerConn && ...)`.
        // A call could still connect if the few candidates that happened
        // to arrive AFTER accept were enough, which is exactly what
        // "inconsistent, works sometimes" looks like. Now every candidate
        // is queued whenever there's no peer connection yet OR the remote
        // description isn't set yet, and flushPendingIceCandidates() (see
        // acceptCall/the 'answer' handler) drains the queue once it's
        // actually possible to add them. Applies identically to audio and
        // video calls — this was never track-type-specific.
        if (signal.candidate) {
          if (rtcPeerConn && rtcPeerConn.remoteDescription) {
            rtcPeerConn.addIceCandidate(new RTCIceCandidate(signal.candidate as any)).catch(() => {});
          } else {
            pendingIceCandidates.push(signal.candidate);
          }
        }
        return;
      }
      if (signal.kind === 'end') {
        finishCall(signal.reason || 'hangup', false);
        return;
      }
      if (signal.kind === 'ice-restart-offer') {
        // Only the callee side ever receives this — see the 'outgoing'-only
        // gate in createPeerConnection where it's sent.
        if (rtcPeerConn && signal.sdp) {
          rtcPeerConn
            .setRemoteDescription({ type: 'offer', sdp: signal.sdp })
            .then(() => rtcPeerConn!.createAnswer())
            .then((answer: any) => rtcPeerConn!.setLocalDescription(answer).then(() => answer))
            .then((answer: any) => sendCallSignal(s.peerId!, { kind: 'ice-restart-answer', callId: s.callId, sdp: answer.sdp }))
            .catch(() => {});
        }
        return;
      }
      if (signal.kind === 'ice-restart-answer') {
        if (rtcPeerConn && signal.sdp) {
          rtcPeerConn.setRemoteDescription({ type: 'answer', sdp: signal.sdp }).catch(() => {});
        }
        return;
      }
      void myUserId; // reserved for future "who initiated" checks, unused today
    },
  };
});
