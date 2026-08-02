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
const RECONNECT_DELAY_MS = 2000;
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

    function connect() {
      if (!mountedRef.current) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl(`/chats/${activeChatId}/ws`));
      } catch {
        reconnectTimerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
        return;
      }
      socketRef.current = ws;

      ws.addEventListener('open', () => {
        if (pingTimerRef.current) clearInterval(pingTimerRef.current);
        pingTimerRef.current = setInterval(() => {
          try {
            ws.send(JSON.stringify({ type: 'ping' }));
          } catch {
            // send can throw if the socket closed between the interval
            // firing and this call — the close handler below will reconnect
          }
        }, PING_INTERVAL_MS);
      });

      ws.addEventListener('message', (ev) => {
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
        if (mountedRef.current) reconnectTimerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
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
