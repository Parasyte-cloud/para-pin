// Thin REST helpers for call signaling — mirrors index.html's
// sendCallSignal/getIceServers/logCallEntry (index.html:6621-6639)
// exactly. The actual media never touches these; this just relays
// offer/answer/ICE-candidate/end messages through the other person's
// UserChannel DO, and logs call history.

import { apiFetch } from '../api/client';

export interface RtcIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

let iceServersCache: RtcIceServer[] | null = null;

export async function getIceServers(): Promise<RtcIceServer[]> {
  if (iceServersCache) return iceServersCache;
  const res = await apiFetch<{ iceServers?: RtcIceServer[] }>('/calls/ice-servers');
  iceServersCache =
    res.ok && res.body.iceServers && res.body.iceServers.length
      ? res.body.iceServers
      : [{ urls: 'stun:stun.l.google.com:19302' }];
  return iceServersCache;
}

export interface CallSignal {
  kind: 'offer' | 'answer' | 'ice-candidate' | 'end' | 'ice-restart-offer' | 'ice-restart-answer';
  callId: string | null;
  sdp?: string;
  video?: boolean;
  candidate?: unknown;
  reason?: string;
  durationSec?: number;
  direction?: 'incoming' | 'outgoing' | null;
  fromUserId?: string;
  fromName?: string;
  fromAvatarUrl?: string | null;
  // Which workspace this call belongs to (`null`/absent = Personal) — set
  // on the initial 'offer' so the callee's own call-log write lands in the
  // same workspace scope as the caller's, matching web's
  // orgId:activeOrgId||null tagging on outgoing signals (index.html:6656).
  orgId?: string | null;
}

// Mirrors index.html's sendCallSignal exactly (index.html:7091-7106): a
// dropped offer/answer/ICE-candidate here has no later resync path the way
// a chat message does, so a single transient failure (a WiFi/cellular
// handoff, a moment of packet loss) used to permanently lose that one
// signal with zero retry. Two bounded retries on a genuine transport
// failure covers the brief-blip case; a real "recipient unreachable" still
// resolves the same way it always did via the existing ring/connect
// timeouts, not this function.
export async function sendCallSignal(toUserId: string, signal: CallSignal) {
  const attempt = () =>
    apiFetch('/calls/signal', { method: 'POST', body: JSON.stringify({ toUserId, signal }) }).catch(() => ({ ok: false as const, status: 0, body: null, networkError: true }));
  let r = await attempt();
  for (let i = 0; i < 2 && !r.ok && (r.networkError || r.status === 0 || r.status >= 500); i++) {
    await new Promise((resolve) => setTimeout(resolve, 300 * (i + 1)));
    r = await attempt();
  }
  return r;
}

export interface CallLogEntry {
  withUserId: string | null;
  withName: string | null;
  withAvatarUrl?: string | null;
  direction: 'incoming' | 'outgoing';
  outcome: 'answered' | 'missed' | 'declined' | 'busy';
  durationSec: number;
  isVideo: boolean;
  // worker.js's POST /call-log reads entry.orgId and stores it verbatim
  // (worker.js:2827); GET /call-log filters by it (worker.js:2805-2806).
  // Personal calls omit this / send null, same convention as chat orgId.
  orgId?: string | null;
}

export function logCallEntry(entry: CallLogEntry) {
  return apiFetch('/calls/log', { method: 'POST', body: JSON.stringify(entry) }).catch(() => {});
}
