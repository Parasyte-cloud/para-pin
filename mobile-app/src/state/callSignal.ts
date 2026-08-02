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
  kind: 'offer' | 'answer' | 'ice-candidate' | 'end';
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

export function sendCallSignal(toUserId: string, signal: CallSignal) {
  return apiFetch('/calls/signal', { method: 'POST', body: JSON.stringify({ toUserId, signal }) }).catch(() => {});
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
