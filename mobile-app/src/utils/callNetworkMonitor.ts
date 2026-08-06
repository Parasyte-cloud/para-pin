// Real network-quality + audio-level sampling off an RTCPeerConnection's
// own getStats() — react-native-webrtc's getStats() JSON-serializes
// libwebrtc's actual native StatsReport map (verified by reading
// RTCPeerConnection.ts's implementation directly, see the comment right
// above its getStats() method), so the numbers here are genuinely measured,
// not simulated. Used by both call.ts (1:1) and meeting.ts (SFU) — a
// meeting only has ONE local RTCPeerConnection (to the SFU), so polling it
// gives this device's real connection quality to the meeting as a whole,
// which is the only granularity a client-side signal can honestly claim
// anyway (per-remote-participant quality would need per-participant
// receiver stats, a reasonable future refinement, not built this round).
//
// Quality thresholds are deliberately conservative/coarse (four tiers) —
// real-world RTT/loss numbers are noisy frame to frame, and a UI that
// flickers between "Good" and "Fair" every poll would read as broken, not
// informative. Each sample is smoothed against the previous tier with a
// one-step-at-a-time cap (can't jump straight from excellent to poor in one
// 2s poll) so the badge/dots animate as a real trend, not noise.

import type { NetworkQuality } from '../theme/callTheme';

export interface NetworkSample {
  quality: NetworkQuality;
  rttMs: number | null;
  packetLossPct: number | null;
  // Real-ish mic level in [0,1] if the platform's stats report populates
  // 'audioLevel' on the outbound/media-source report for this track — not
  // every libwebrtc build does, so this can legitimately stay null. The
  // waveform component falls back to a designed idle-ambient motion when
  // it does, rather than freezing flat (see AnimatedAvatar's comment).
  localAudioLevel: number | null;
  remoteAudioLevel: number | null;
}

const QUALITY_RANK: NetworkQuality[] = ['poor', 'fair', 'good', 'excellent'];

function rankOf(q: NetworkQuality): number {
  const i = QUALITY_RANK.indexOf(q);
  return i === -1 ? 2 : i;
}

function scoreToQuality(rttMs: number | null, lossPct: number | null): NetworkQuality {
  if (rttMs === null && lossPct === null) return 'unknown';
  let tier: NetworkQuality = 'excellent';
  const rtt = rttMs ?? 0;
  const loss = lossPct ?? 0;
  if (rtt >= 500 || loss >= 8) tier = 'poor';
  else if (rtt >= 300 || loss >= 4) tier = 'fair';
  else if (rtt >= 150 || loss >= 1.5) tier = 'good';
  else tier = 'excellent';
  return tier;
}

export function startNetworkMonitor(
  pc: { getStats: () => Promise<Map<string, any>> } | null,
  onSample: (sample: NetworkSample) => void,
  intervalMs = 2000
): () => void {
  let stopped = false;
  let lastQuality: NetworkQuality = 'unknown';
  // Deltas need the previous cumulative counters to compute a rate.
  let prevInbound: { packetsLost: number; packetsReceived: number; ts: number } | null = null;

  async function tick() {
    if (stopped || !pc) return;
    try {
      const report = await pc.getStats();
      let rttMs: number | null = null;
      let lossPct: number | null = null;
      let localAudioLevel: number | null = null;
      let remoteAudioLevel: number | null = null;

      for (const stat of report.values()) {
        if (stat.type === 'candidate-pair' && (stat.state === 'succeeded' || stat.nominated) && typeof stat.currentRoundTripTime === 'number') {
          rttMs = Math.round(stat.currentRoundTripTime * 1000);
        }
        if (stat.type === 'inbound-rtp' && stat.kind === 'audio' && typeof stat.packetsLost === 'number' && typeof stat.packetsReceived === 'number') {
          const now = Date.now();
          if (prevInbound) {
            const dLost = stat.packetsLost - prevInbound.packetsLost;
            const dRecv = stat.packetsReceived - prevInbound.packetsReceived;
            const dTotal = dLost + dRecv;
            if (dTotal > 0) lossPct = Math.max(0, Math.round((dLost / dTotal) * 1000) / 10);
          }
          prevInbound = { packetsLost: stat.packetsLost, packetsReceived: stat.packetsReceived, ts: now };
          if (typeof stat.audioLevel === 'number') remoteAudioLevel = stat.audioLevel;
        }
        if ((stat.type === 'media-source' || stat.type === 'outbound-rtp') && stat.kind === 'audio' && typeof stat.audioLevel === 'number') {
          localAudioLevel = stat.audioLevel;
        }
      }

      const raw = scoreToQuality(rttMs, lossPct);
      if (lastQuality === 'unknown') {
        lastQuality = raw;
      } else {
        const diff = rankOf(raw) - rankOf(lastQuality);
        lastQuality = QUALITY_RANK[rankOf(lastQuality) + Math.sign(diff) * Math.min(1, Math.abs(diff))];
      }

      onSample({ quality: lastQuality, rttMs, packetLossPct: lossPct, localAudioLevel, remoteAudioLevel });
    } catch {
      // getStats() can throw on a not-yet-connected/already-closed pc —
      // just skip this tick, the next interval retries.
    }
  }

  const timer = setInterval(tick, intervalMs);
  tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

// Real HD detection off the actual negotiated video track resolution
// (MediaStreamTrack.getSettings() reflects what the encoder is actually
// sending/what's actually being decoded, not a guess) — 720p+ is the
// conventional "HD" line every major calling app uses.
export function isTrackHd(track: { getSettings?: () => { height?: number } } | null | undefined): boolean {
  if (!track || typeof track.getSettings !== 'function') return false;
  const height = track.getSettings().height;
  return typeof height === 'number' && height >= 720;
}
