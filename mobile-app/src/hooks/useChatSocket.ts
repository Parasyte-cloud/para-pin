// Live updates for one open chat. Mirrors index.html's connectSocket
// (index.html:9879-9955): REST handles every actual write (send/edit/
// delete/read), this socket is purely a push channel for events plus a
// typing/ping heartbeat the server expects — see worker.js's ChatRoom
// comment that typing/ping are the ONLY things a client ever sends over
// this socket.

import { useEffect, useRef, useCallback } from 'react';
import { wsUrl } from '../api/client';
import { useMessagesStore } from '../state/messages';
import type { ChatSummary } from '../types';

const PING_INTERVAL_MS = 25000;
const STALE_THRESHOLD_MS = 40000;
const MAX_RECONNECT_DELAY_MS = 8000;
const TYPING_THROTTLE_MS = 2500;

interface ChatSocketHandlers {
  onTyping?: (userId: string, name: string) => void;
  onReadReceipt?: (userId: string, upToTs: number) => void;
  onMessage?: () => void; // fired after a live message is merged in, for scroll-to-bottom etc.
}

export function useChatSocket(chat: ChatSummary | null, handlers: ChatSocketHandlers = {}) {
  const socketRef = useRef<WebSocket | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const lastActivityRef = useRef(0);
  const lastTypingSentRef = useRef(0);
  const mountedRef = useRef(true);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const mergeMessages = useMessagesStore((s) => s.mergeMessages);
  const applyDelete = useMessagesStore((s) => s.applyDelete);
  const applyEdit = useMessagesStore((s) => s.applyEdit);
  const applyReaction = useMessagesStore((s) => s.applyReaction);

  const chatId = chat?.id ?? null;

  useEffect(() => {
    mountedRef.current = true;
    if (!chatId) return;
    const activeChatId = chatId; // stable `string` binding — TS doesn't carry the guard's narrowing into the nested closures below

    function cleanup() {
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      pingTimerRef.current = null;
      reconnectTimerRef.current = null;
      if (socketRef.current) {
        try {
          socketRef.current.close();
        } catch {
          // socket may already be closed/closing — nothing to do
        }
        socketRef.current = null;
      }
    }

    function scheduleReconnect() {
      if (reconnectTimerRef.current) return;
      reconnectAttemptsRef.current = Math.min(reconnectAttemptsRef.current + 1, 5);
      const base = Math.min(1000 * reconnectAttemptsRef.current, MAX_RECONNECT_DELAY_MS);
      // Full jitter + growing backoff, mirrors index.html's connectSocket —
      // this used to be a flat 2s retry forever with zero growth and zero
      // jitter, the worst combination for a real outage (every client
      // hammering the same 2s cadence in lockstep instead of backing off).
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
        ws = new WebSocket(wsUrl(`/chats/${activeChatId}/ws`));
      } catch {
        scheduleReconnect();
        return;
      }
      socketRef.current = ws;
      lastActivityRef.current = Date.now();

      ws.addEventListener('open', () => {
        reconnectAttemptsRef.current = 0;
        lastActivityRef.current = Date.now();
        if (pingTimerRef.current) clearInterval(pingTimerRef.current);
        // A mobile connection can go silently dead — carrier NAT timeout on
        // an idle socket, screen lock, a WiFi/cellular handoff — without
        // ever firing a 'close' event, leaving readyState stuck at "OPEN"
        // while nothing arrives again. Previously this just pinged blindly
        // on an interval with nothing checking whether anything (including
        // the pong) ever came back, so that exact case was invisible here.
        // Same fix as useNotifySocket.ts: check staleness first, force a
        // reconnect if too much silence has passed, otherwise ping as usual.
        pingTimerRef.current = setInterval(() => {
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
            // send can throw if the socket closed between the interval
            // firing and this call — the close handler below will reconnect
          }
        }, PING_INTERVAL_MS);
      });

      ws.addEventListener('message', (ev) => {
        lastActivityRef.current = Date.now();
        let data: any;
        try {
          data = JSON.parse(ev.data as string);
        } catch {
          return;
        }
        switch (data.type) {
          case 'pong':
            return;
          case 'message':
            mergeMessages(activeChatId, [data.message]);
            handlersRef.current.onMessage?.();
            return;
          case 'typing':
            handlersRef.current.onTyping?.(data.userId, data.name || 'Someone');
            return;
          case 'read_receipt':
            handlersRef.current.onReadReceipt?.(data.userId, data.upToTs);
            return;
          case 'delete':
            applyDelete(activeChatId, data.messageId);
            return;
          case 'edit':
            // No knownText here (this client didn't type the edit), so
            // applyEdit marks the message pending re-decrypt — without
            // this onMessage() call nothing would ever actually decrypt
            // it; the message would sit blank until some unrelated event
            // happened to trigger decryptChat again.
            applyEdit(activeChatId, data.messageId, data.ciphertext, data.iv);
            handlersRef.current.onMessage?.();
            return;
          case 'reaction':
            applyReaction(activeChatId, data.messageId, data.reactions || {});
            return;
          default:
            return;
        }
      });

      ws.addEventListener('close', () => {
        if (pingTimerRef.current) clearInterval(pingTimerRef.current);
        pingTimerRef.current = null;
        if (socketRef.current === ws) socketRef.current = null;
        if (mountedRef.current) scheduleReconnect();
      });

      ws.addEventListener('error', () => {
        try {
          ws.close();
        } catch {
          // already closing — the 'close' handler above owns the reconnect
        }
      });
    }

    connect();
    return () => {
      mountedRef.current = false;
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  const sendTyping = useCallback(() => {
    const now = Date.now();
    if (now - lastTypingSentRef.current < TYPING_THROTTLE_MS) return;
    lastTypingSentRef.current = now;
    try {
      socketRef.current?.send(JSON.stringify({ type: 'typing' }));
    } catch {
      // best-effort — a dropped typing ping isn't worth surfacing to the user
    }
  }, []);

  return { sendTyping };
}
