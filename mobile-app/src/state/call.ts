// 1:1 audio/video call state machine — ports index.html's call handling
// (index.html:6572-6994) as closely as react-native-webrtc's API (which
// deliberately mirrors browser WebRTC) allows. Signaling rides the same
// always-open notify socket every client keeps connected (see
// useNotifySocket.ts); offer/answer/ICE/end all travel as REST calls
// relayed through the other person's UserChannel DO. Audio/video itself is
// peer-to-peer WebRTC and never touches the Worker.
//
// Known cut vs. web: no synthesized ringback/ringtone audio (that's a Web
// Audio oscillator trick with no direct RN equivalent) — the incoming/
// outgoing call screens are the signal for now. Group/meeting calls
// (Cloudflare Calls SFU) are a separate, not-yet-built path — see
// mobile-app/README.md.

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
  awaitingConnection: boolean;
  callStartedAt: number | null;
  elapsedSec: number;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  connectError: string | null;

  startOutgoingCall: (peerId: string, peerName: string, peerAvatarUrl: string | null, video: boolean) => Promise<void>;
  acceptCall: () => Promise<void>;
  declineCall: (reason?: string) => void;
  endCall: (reason?: string) => void;
  toggleMute: () => void;
  toggleCamera: () => void;
  handleCallSignal: (signal: CallSignal) => void;
  dismissConnectError: () => void;
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
  getCallId: () => string | null,
  onRemoteStream: (stream: MediaStream) => void,
  onConnected: () => void,
  onFailedOrClosed: () => void,
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
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      if (disconnectGraceTimer) {
        clearTimeout(disconnectGraceTimer);
        disconnectGraceTimer = null;
      }
      onFailedOrClosed();
    }
    if (pc.connectionState === 'disconnected') {
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
  }

  function finishCall(reason: string | undefined, alreadyLogged: boolean) {
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
      awaitingConnection: false,
      callStartedAt: null,
      elapsedSec: 0,
      localStream: null,
      remoteStream: null,
    });
  }

  function onCallConnected() {
    if (get().callState === 'connected') return;
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
    awaitingConnection: false,
    callStartedAt: null,
    elapsedSec: 0,
    localStream: null,
    remoteStream: null,
    connectError: null,

    startOutgoingCall: async (peerId, peerName, peerAvatarUrl, video) => {
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
        localStream: stream,
        connectError: null,
      });
      const pc = await createPeerConnection(
        peerId,
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
      await sendCallSignal(peerId, { kind: 'offer', callId, sdp: offer.sdp, video });
      ringTimeoutTimer = setTimeout(() => {
        if (get().callState === 'ringing-out') get().endCall('no-answer');
      }, RING_TIMEOUT_MS);
    },

    acceptCall: async () => {
      const s = get();
      if (s.callState !== 'ringing-in' || !s.peerId) return;
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

    dismissConnectError: () => set({ connectError: null }),

    handleCallSignal: (signal) => {
      if (!signal || !signal.kind) return;
      const s = get();
      const myUserId = useSessionStore.getState().userId;

      if (signal.kind === 'offer') {
        if (s.callState !== 'idle') {
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
          connectError: null,
        });
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
        if (rtcPeerConn && signal.candidate) {
          if (rtcPeerConn.remoteDescription) {
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
      void myUserId; // reserved for future "who initiated" checks, unused today
    },
  };
});
