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
// Deliberate scope cuts vs. web, all workspace/AI features with no direct
// mobile UI to attach to yet, not media-plane limitations:
//  - No recording / AI meeting summary (worker.js gates both behind a
//    workspace org, and there's no mobile "start_meetings" permission UI
//    to check against yet).
//  - No active-speaker highlighting (index.html's Web Audio
//    AnalyserNode-per-participant sampler — no direct RN equivalent
//    without a native audio-processing module).
//  - No minimize-to-PiP while browsing other screens — the overlay is
//    modal, same as CallOverlay's 1:1 call screen.
//  - No invite picker: joining brings in whoever the *entry point* already
//    knows (a group chat's own memberIds — see app/chat/[id].tsx's
//    "Start meeting" button) or whoever's already been invited from web;
//    there's no standalone contacts/roster browser on mobile yet to pick
//    people from (see mobile-app/README.md).

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
  hasAudio: boolean;
}

export type MeetingStatus = 'idle' | 'connecting' | 'active';

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
let midToTrack: Record<string, { userId: string; kind: string }> = {};
let pulledTracks = new Set<string>();
let wsPingInterval: ReturnType<typeof setInterval> | null = null;
let negotiationQueue: Promise<void> = Promise.resolve();
// Presence-socket reconnect bookkeeping — mirrors index.html's
// connectMeetingWs (meetingConnectAttempts/meetingWsReconnectTimer). This
// was previously entirely absent on mobile (flagged inline as an explicit,
// known gap): a dropped presence socket just left this device's presence
// stale in the room until it explicitly left, with no self-healing at all.
let meetingConnectAttempts = 0;
let meetingWsReconnectTimer: ReturnType<typeof setTimeout> | null = null;

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

  startMeeting: (meetingName: string, orgId: string | null, inviteUserIds: string[]) => Promise<void>;
  handleMeetingInvite: (signal: MeetingInviteSignal) => void;
  acceptInvite: () => Promise<void>;
  declineInvite: () => void;
  leaveMeeting: () => void;
  toggleMute: () => void;
  toggleCamera: () => void;
  dismissError: () => void;
}

export const useMeetingStore = create<MeetingState>((set, get) => {
  function teardown() {
    if (wsPingInterval) clearInterval(wsPingInterval);
    wsPingInterval = null;
    if (meetingWsReconnectTimer) clearTimeout(meetingWsReconnectTimer);
    meetingWsReconnectTimer = null;
    meetingConnectAttempts = 0;
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
    meetingSfuSessionId = null;
    midToTrack = {};
    pulledTracks = new Set();
    negotiationQueue = Promise.resolve();
  }

  function attachTrack(userId: string, name: string, avatarUrl: string | null, track: MediaStreamTrack, stream: MediaStream) {
    set((s) => {
      const existing = s.participants[userId] || { userId, name, avatarUrl, videoStream: null, hasAudio: false };
      const next = {
        ...existing,
        name: name || existing.name,
        avatarUrl: avatarUrl ?? existing.avatarUrl,
        videoStream: track.kind === 'video' ? stream : existing.videoStream,
        hasAudio: track.kind === 'audio' ? true : existing.hasAudio,
      };
      return { participants: { ...s.participants, [userId]: next } };
    });
  }

  function removeParticipant(userId: string) {
    set((s) => {
      const next = { ...s.participants };
      delete next[userId];
      return { participants: next };
    });
    for (const [mid, info] of Object.entries(midToTrack)) {
      if (info.userId === userId) delete midToTrack[mid];
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

  function wsSend(payload: unknown) {
    if (meetingWs && meetingWs.readyState === WebSocket.OPEN) meetingWs.send(JSON.stringify(payload));
  }

  function handleWsMessage(data: any) {
    const myUserId = useSessionStore.getState().userId;
    if (data.type === 'roster') {
      (data.participants || []).forEach((p: any) => {
        if (p.userId === myUserId) return;
        set((s) => ({
          participants: {
            ...s.participants,
            [p.userId]: s.participants[p.userId] || { userId: p.userId, name: p.name, avatarUrl: p.avatarUrl || null, videoStream: null, hasAudio: false },
          },
        }));
        (p.tracks || []).forEach((t: any) => pullTrack(p.userId, p.name, p.avatarUrl || null, p.sfuSessionId, t.trackName, t.kind));
      });
      return;
    }
    if (data.type === 'participant-joined') {
      if (data.userId === myUserId) return;
      set((s) => ({
        participants: {
          ...s.participants,
          [data.userId]: s.participants[data.userId] || { userId: data.userId, name: data.name, avatarUrl: data.avatarUrl || null, videoStream: null, hasAudio: false },
        },
      }));
      return;
    }
    if (data.type === 'participant-left') {
      removeParticipant(data.userId);
      return;
    }
    if (data.type === 'participant-track') {
      if (data.userId === myUserId) return;
      const p = get().participants[data.userId];
      pullTrack(data.userId, p?.name || 'Someone', p?.avatarUrl ?? null, data.sfuSessionId, data.trackName, data.kind);
      return;
    }
    if (data.type === 'participant-untrack') {
      set((s) => {
        const existing = s.participants[data.userId];
        if (!existing) return s;
        return { participants: { ...s.participants, [data.userId]: { ...existing, videoStream: null } } };
      });
      return;
    }
  }

  function connectWs(inviteUserIds: string[], isReconnect: boolean) {
    const { meetingId, orgId } = get();
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

      // Deliberately bodiless — see index.html's identical comment: the
      // live Cloudflare Realtime API 400s an empty JSON object here, a
      // truly bodiless POST is what it wants.
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
      // Must happen before publishLocalTracks()'s 'publish' messages go
      // out — the DO stamps every 'participant-track' broadcast with
      // whatever me.sfuSessionId it currently has on file (worker.js's
      // MeetingRoom.fetch, the 'publish' handler), which starts out null
      // until this arrives. Skipping this left every OTHER participant's
      // pullTrack() call with a null remoteSessionId, silently unable to
      // ever pull this device's tracks.
      wsSend({ type: 'set-session', sfuSessionId: meetingSfuSessionId });
      set({ status: 'active' });
      await publishLocalTracks();
      for (const toUserId of inviteUserIds) {
        apiFetch('/meeting/invite', {
          method: 'POST',
          body: JSON.stringify({ toUserId, meetingId, meetingName: get().meetingName, orgId }),
        }).catch(() => {});
      }
    });
    ws.addEventListener('close', () => {
      if (wsPingInterval) clearInterval(wsPingInterval);
      wsPingInterval = null;
      // `meetingWs !== ws` covers two cases at once: teardown() already ran
      // (it nulls meetingWs before closing, an intentional leave) or a
      // newer connectWs() already superseded this one — either way this
      // stale close event must not also schedule its own reconnect on top.
      if (meetingWs !== ws) return;
      meetingWs = null;
      // The RTCPeerConnection/SFU session are independent of this presence
      // socket (same reasoning as web), so a drop doesn't end the meeting
      // outright. Previously there was genuinely no reconnect loop at all
      // here — a drop just left this device's presence stale in the room
      // until it explicitly left. Mirrors index.html's connectMeetingWs:
      // bounded retries with a jittered delay, not indefinite.
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
      attachTrack(info.userId, info.name || 'Someone', info.avatarUrl ?? null, ev.track, ev.streams[0]);
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

    dismissError: () => set({ errorMessage: null }),
  };
});
