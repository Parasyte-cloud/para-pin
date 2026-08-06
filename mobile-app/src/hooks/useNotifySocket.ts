// The always-open notify socket every client keeps connected — mirrors
// index.html's connectNotifySocket (index.html:10785-10844). Right now
// this only exists to receive {type:'call-signal'} messages so incoming
// calls can ring while the app isn't sitting in a specific chat; if
// mobile ever gets live unread badges outside an open chat, that's a
// {type:'notify'} handler added right here, not a second socket.
//
// Mount ONCE for the whole authenticated session (see app/_layout.tsx) —
// not per-screen, this has to stay open regardless of which tab/chat is
// currently visible for incoming calls to work at all.

import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { wsUrl } from '../api/client';
import { useSessionStore } from '../state/session';
import { useCallStore } from '../state/call';
import { useMeetingStore } from '../state/meeting';

const HEARTBEAT_INTERVAL_MS = 12000;
const STALE_THRESHOLD_MS = 25000;
const MAX_RECONNECT_DELAY_MS = 4000;

export function useNotifySocket() {
  const pinHash = useSessionStore((s) => s.pinHash);
  const isLocked = useSessionStore((s) => s.isLocked);
  const socketRef = useRef<WebSocket | null>(null);
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const lastActivityRef = useRef(0);
  const mountedRef = useRef(true);

  const active = !!pinHash && !isLocked;

  useEffect(() => {
    mountedRef.current = true;
    if (!active) return;

    function cleanup() {
      if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      heartbeatTimerRef.current = null;
      reconnectTimerRef.current = null;
      if (socketRef.current) {
        try {
          socketRef.current.close();
        } catch {
          // already closed/closing
        }
        socketRef.current = null;
      }
    }

    function scheduleReconnect() {
      if (reconnectTimerRef.current) return;
      reconnectAttemptsRef.current = Math.min(reconnectAttemptsRef.current + 1, 5);
      const base = Math.min(800 * reconnectAttemptsRef.current, MAX_RECONNECT_DELAY_MS);
      // Full jitter (mirrors index.html's scheduleNotifyReconnect): this
      // socket carries incoming-call signaling for every device, a mass
      // reconnect after an outage/redeploy hitting every phone at the same
      // deterministic step would be the worst possible place for a
      // synchronized thundering herd.
      const delay = Math.random() * base;
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, delay);
    }

    function connect() {
      if (!mountedRef.current) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl('/notify/ws'));
      } catch {
        scheduleReconnect();
        return;
      }
      lastActivityRef.current = Date.now();

      ws.addEventListener('open', () => {
        reconnectAttemptsRef.current = 0;
        lastActivityRef.current = Date.now();
      });

      ws.addEventListener('message', (ev) => {
        lastActivityRef.current = Date.now();
        let data: any;
        try {
          data = JSON.parse(ev.data as string);
        } catch {
          return;
        }
        if (data.type === 'call-signal') {
          // Group-meeting invites ride the same call-signal envelope as
          // 1:1 offers (see MeetingInviteSignal in state/meeting.ts) —
          // routed to the meeting store instead of the 1:1 call state
          // machine so an incoming meeting invite doesn't get treated as
          // a phone call.
          if (data.signal && data.signal.kind === 'meeting-invite') {
            useMeetingStore.getState().handleMeetingInvite(data.signal);
          } else {
            useCallStore.getState().handleCallSignal(data.signal);
          }
        }
      });

      ws.addEventListener('close', () => {
        if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
        if (socketRef.current !== ws) return;
        socketRef.current = null;
        if (mountedRef.current) scheduleReconnect();
      });

      ws.addEventListener('error', () => {
        try {
          ws.close();
        } catch {
          // the 'close' handler above owns the reconnect
        }
      });

      socketRef.current = ws;

      heartbeatTimerRef.current = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - lastActivityRef.current > STALE_THRESHOLD_MS) {
          try {
            ws.close();
          } catch {
            // close() itself throwing means it's already gone
          }
          return;
        }
        try {
          ws.send(JSON.stringify({ type: 'ping' }));
        } catch {
          // a dropped heartbeat isn't itself an error — the staleness check above catches a truly dead socket
        }
      }, HEARTBEAT_INTERVAL_MS);
    }

    connect();

    // iOS/Android both suspend a backgrounded app's JS timers, so a lock
    // screen or a few minutes in another app means the heartbeat interval
    // itself was frozen too — there's no "silently dead but still OPEN"
    // detection running at all while backgrounded, only whatever the socket
    // itself does (which varies by OS/carrier, and isn't reliable). Mirrors
    // index.html's visibilitychange handler: the instant the app is
    // foregrounded again, force a real reconnect right away instead of
    // waiting for the heartbeat to eventually notice a stale connection,
    // that gap is exactly what "the call/notify didn't come through until I
    // reopened the app" looks like from the outside.
    const appStateSub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next !== 'active' || !mountedRef.current) return;
      if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) return;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      reconnectAttemptsRef.current = 0;
      connect();
    });

    return () => {
      mountedRef.current = false;
      appStateSub.remove();
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
