// iMessage-style chat detail screen: grouped/tailed bubbles, date
// separators, tapback reactions, reply/edit/delete, swipe-to-reply, and
// (DM-only) delivered/read receipts — see src/components/MessageBubble.tsx
// and MessageActionSheet.tsx for the two extracted pieces this composes.
//
// Deliberately NOT included here: sending new photo/voice attachments.
// Receiving/decrypting them (from the web app) works — see
// MessageAttachments.tsx — but authoring one from mobile needs a photo
// picker + raw-byte upload path (worker.js's POST /api/upload) that hasn't
// been built or verified yet, and this session had no way to test an
// actual binary upload from a real device. Flagged in the README rather
// than shipping a "+" button that doesn't do anything.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useLocalSearchParams, Stack, router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { BlurView } from 'expo-blur';
import { useTheme } from '../../src/hooks/useTheme';
import { useSessionStore } from '../../src/state/session';
import { useMessagesStore } from '../../src/state/messages';
import { useChatSocket } from '../../src/hooks/useChatSocket';
import { ensureChatKey } from '../../src/state/e2ee';
import { encryptString } from '../../src/crypto/e2ee';
import { resolveNames } from '../../src/state/names';
import { apiFetch } from '../../src/api/client';
import { useCallStore } from '../../src/state/call';
import { colorFromString } from '../../src/utils/avatar';
import MessageBubble, { formatTime } from '../../src/components/MessageBubble';
import MessageActionSheet from '../../src/components/MessageActionSheet';
import type { ChatMessage } from '../../src/types';

const DECRYPT_RETRY_MS = 5000;
const GROUP_GAP_MS = 60 * 1000; // same-sender messages within this window render as one visual group
const DATE_SEPARATOR_GAP_MS = 3 * 60 * 60 * 1000; // 3h gap (or a new day) gets its own separator

// Stable reference for the "no messages loaded yet for this chat" case.
// Root cause of the "Maximum update depth exceeded" crash (2026-08-02):
// the Zustand selector below used to do `s.byChat[id] || []`, which
// allocates a BRAND NEW array every single call whenever byChat[id] is
// still unset. React's useSyncExternalStore (which Zustand's hook uses
// under the hood) compares snapshots with Object.is — a fresh array
// reference every call looks like "the store changed" even though
// nothing did, which forces an immediate re-render, which re-runs the
// selector, which allocates ANOTHER new array, forever. That's exactly
// what "Maximum update depth exceeded" means, and it's fatal in RN's
// release build (see README's crash-log writeup). Returning this same
// module-level constant instead keeps Object.is happy until byChat[id]
// actually gets set by loadHistory/decryptChat.
const EMPTY_MESSAGES: ChatMessage[] = [];

function isGroupable(a: ChatMessage, b: ChatMessage | undefined): boolean {
  if (!b) return false;
  if (a.type === 'system' || b.type === 'system' || a.system || b.system) return false;
  return a.fromUserId === b.fromUserId && Math.abs(a.ts - b.ts) < GROUP_GAP_MS;
}

function dateSeparatorLabel(ts: number, prevTs: number | null): string | null {
  const d = new Date(ts);
  if (prevTs === null) return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  const gap = ts - prevTs;
  const sameDay = d.toDateString() === new Date(prevTs).toDateString();
  if (sameDay && gap < DATE_SEPARATOR_GAP_MS) return null;
  const now = new Date();
  if (sameDay === false && d.toDateString() === now.toDateString()) return `Today ${formatTime(ts)}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${formatTime(ts)}`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${formatTime(ts)}`;
}

export default function ChatDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const myUserId = useSessionStore((s) => s.userId);
  const chat = useSessionStore((s) => s.chats.find((c) => c.id === id)) ?? null;
  const messages = useMessagesStore((s) => (id ? s.byChat[id] || EMPTY_MESSAGES : EMPTY_MESSAGES));
  const loadHistory = useMessagesStore((s) => s.loadHistory);
  const decryptChat = useMessagesStore((s) => s.decryptChat);
  const addOptimistic = useMessagesStore((s) => s.addOptimistic);
  const removeOptimistic = useMessagesStore((s) => s.removeOptimistic);
  const mergeMessages = useMessagesStore((s) => s.mergeMessages);
  const applyDelete = useMessagesStore((s) => s.applyDelete);
  const applyEdit = useMessagesStore((s) => s.applyEdit);
  const applyReaction = useMessagesStore((s) => s.applyReaction);

  const [names, setNames] = useState<Record<string, string>>({});
  const [typingLabel, setTypingLabel] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [keyReady, setKeyReady] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [actionSheetFor, setActionSheetFor] = useState<string | null>(null);
  const [replyTarget, setReplyTarget] = useState<{ id: string; fromName: string; text: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [otherReadTs, setOtherReadTs] = useState(0);
  const typingClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const listRef = useRef<FlatList<ChatMessage>>(null);

  const chatTitle = chat?.name || (chat?.type === 'dm' ? 'Direct message' : 'Group');
  const dmPeerId = chat?.type === 'dm' ? chat.memberIds?.find((mid) => mid !== myUserId) || null : null;
  const dmPeerName = (dmPeerId && names[dmPeerId]) || chatTitle;
  const startOutgoingCall = useCallStore((s) => s.startOutgoingCall);
  const inCall = useCallStore((s) => s.callState !== 'idle');

  const callPeer = useCallback(
    (video: boolean) => {
      if (!dmPeerId || inCall) return;
      // Tag the call with this chat's own workspace scope so it lands in
      // the same Personal/Workspace call-log bucket as the chat itself —
      // see src/state/callSignal.ts's CallSignal/CallLogEntry.orgId
      // comments and worker.js:2805-2806/2827.
      startOutgoingCall(dmPeerId, dmPeerName, null, video, chat?.orgId ?? null);
    },
    [dmPeerId, dmPeerName, inCall, startOutgoingCall, chat?.orgId]
  );

  const { sendTyping } = useChatSocket(chat, {
    onTyping: (userId, name) => {
      if (userId === myUserId) return;
      setTypingLabel(name);
      if (typingClearTimer.current) clearTimeout(typingClearTimer.current);
      typingClearTimer.current = setTimeout(() => setTypingLabel(null), 3000);
    },
    onMessage: () => {
      if (chat) decryptChat(chat);
    },
    onReadReceipt: (userId, upToTs) => {
      if (dmPeerId && userId === dmPeerId) setOtherReadTs((prev) => Math.max(prev, upToTs));
    },
  });

  useEffect(() => {
    if (!chat) return;
    let cancelled = false;

    (async () => {
      await loadHistory(chat);
      if (chat.memberIds?.length) {
        const resolved = await resolveNames(chat.memberIds);
        if (!cancelled) setNames(resolved);
      }
      const key = await ensureChatKey(chat);
      if (!cancelled) setKeyReady(!!key);
      const stillPending = await decryptChat(chat);
      if (!cancelled && stillPending) {
        retryTimer.current = setInterval(async () => {
          const key2 = await ensureChatKey(chat);
          if (key2) setKeyReady(true);
          const pending = await decryptChat(chat);
          if (!pending && retryTimer.current) {
            clearInterval(retryTimer.current);
            retryTimer.current = null;
          }
        }, DECRYPT_RETRY_MS);
      }
      if (chat.type === 'dm' && chat.memberIds?.length) {
        // Server computes the member-id list itself from the verified chat
        // record (see worker.js's /api/chats/:id/read-state route) — no
        // query params needed here, it can't be spoofed to read another
        // chat's state anyway.
        const readRes = await apiFetch<{ reads?: Record<string, number> }>(`/chats/${chat.id}/read-state`);
        const otherId = chat.memberIds.find((mid) => mid !== myUserId);
        if (readRes.ok && otherId && readRes.body.reads?.[otherId]) {
          // Functional max-merge, not a plain set — the live WS
          // 'read_receipt' handler (below) can resolve before this fetch
          // does, and a plain set here would clobber that newer value back
          // to a stale cached one.
          const fetchedTs = readRes.body.reads[otherId];
          if (!cancelled) setOtherReadTs((prev) => Math.max(prev, fetchedTs));
        }
      }
      apiFetch(`/chats/${chat.id}/read`, {
        method: 'POST',
        body: JSON.stringify({ upToTs: Date.now(), silent: false }),
      }).catch(() => {});
    })();

    return () => {
      cancelled = true;
      if (retryTimer.current) clearInterval(retryTimer.current);
      if (typingClearTimer.current) clearTimeout(typingClearTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat?.id]);

  const onSend = useCallback(async () => {
    const text = input.trim();
    if (!text || !chat || sending) return;
    setSending(true);
    setSendError(null);
    // Everything below can throw synchronously (encryptString's underlying
    // @noble/ciphers call validates key/iv length strictly and throws if
    // ensureChatKey ever hands back a malformed key — a real possibility
    // right after a device-approval/rewrap) or reject (the two apiFetch
    // calls). onSend is invoked from onPress as a fire-and-forget handler,
    // so an uncaught throw here doesn't just fail this send — it becomes
    // an unhandled rejection that React Native's release build can
    // escalate to a fatal, whole-app-crashing error (this is what the
    // 2026-08-02 TestFlight crash log traced back to: RN's own
    // ExceptionsManager reportFatal: path aborting the process). Wrapping
    // the whole body turns any of that into a normal, visible send error
    // instead of a hard crash. app/_layout.tsx's ErrorBoundary is the
    // second layer of defense for anything that still gets past this.
    try {
      const key = await ensureChatKey(chat);
      if (!key) {
        // Previously a silent no-op — the persistent `!keyReady` banner
        // above the message list covers the FIRST time a chat's key isn't
        // ready yet, but gave no feedback for a send attempted mid-wait, and
        // didn't explain what to do if it stays stuck (a missing chat-key
        // wrap for this device — see the "Re-sync keys" button added to
        // web's Settings > Devices list, index.html:9174-9176 — is the
        // actual fix for that case, not something mobile can self-heal).
        setSendError("Encryption isn't ready for this chat yet. If this doesn't clear on its own, ask whoever's already signed in on web to hit \"Re-sync keys\" for this device in Settings.");
        return;
      }
      const enc = encryptString(key, text);

      if (editingId) {
        const res = await apiFetch<{ message?: ChatMessage }>(`/chats/${chat.id}/messages/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify({ ciphertext: enc.ciphertext, iv: enc.iv }),
        });
        if (res.ok) {
          // Pass the plaintext we already have (knownText) so the bubble
          // updates immediately instead of showing "Waiting for
          // encryption…" until the next unrelated decrypt pass.
          applyEdit(chat.id, editingId, enc.ciphertext, enc.iv, text);
          setInput('');
          setEditingId(null);
        } else {
          setSendError("Couldn't save that edit. Try again.");
        }
        return;
      }

      setInput('');
      const replyPayload = replyTarget ? { id: replyTarget.id, fromName: replyTarget.fromName, text: replyTarget.text } : undefined;
      const tempId = `pending-${Date.now()}`;
      const optimistic: ChatMessage = {
        id: tempId,
        fromUserId: myUserId || '',
        ts: Date.now(),
        text,
        replyTo: replyPayload || null,
        _e2eeDone: true,
        _pending: true,
      };
      addOptimistic(chat.id, optimistic);
      setReplyTarget(null);
      const res = await apiFetch<{ message?: ChatMessage }>(`/chats/${chat.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          ciphertext: enc.ciphertext,
          iv: enc.iv,
          alg: chat.type === 'group' ? 'group' : 'dm',
          replyTo: replyPayload,
        }),
      });
      removeOptimistic(chat.id, tempId);
      if (res.ok && res.body.message) {
        mergeMessages(chat.id, [{ ...res.body.message, text, _e2eeDone: true }]);
      } else {
        // Previously silently restored the input with zero indication
        // anything went wrong — put the text back (so nothing's lost) but
        // now actually say so.
        setInput(text);
        setSendError(
          !res.ok && res.networkError ? "Couldn't reach PArA. Check your connection and try again." : "That message didn't send. Try again."
        );
      }
    } catch (e: any) {
      // Belt-and-suspenders for the encrypt-throw case above, plus
      // anything else unforeseen — never let a send attempt escape as an
      // uncaught/unhandled rejection.
      setInput(text);
      setSendError(e?.message ? `Send failed: ${e.message}` : "That message didn't send. Try again.");
    } finally {
      setSending(false);
    }
  }, [input, chat, sending, myUserId, editingId, replyTarget, addOptimistic, removeOptimistic, mergeMessages, applyEdit]);

  const onChangeText = useCallback(
    (v: string) => {
      setInput(v);
      setSendError(null);
      sendTyping();
    },
    [sendTyping]
  );

  const listData = useMemo(() => [...messages].reverse(), [messages]);

  const mostRecentOwnId = useMemo(() => {
    const found = listData.find((m) => m.fromUserId === myUserId && !m.deleted && m.type !== 'system');
    return found?.id ?? null;
  }, [listData, myUserId]);

  const actionSheetMessage = useMemo(() => listData.find((m) => m.id === actionSheetFor) ?? null, [listData, actionSheetFor]);
  const myReactionOnActionSheet = useMemo(() => {
    if (!actionSheetMessage?.reactions || !myUserId) return null;
    for (const [emoji, ids] of Object.entries(actionSheetMessage.reactions)) {
      if (ids.includes(myUserId)) return emoji;
    }
    return null;
  }, [actionSheetMessage, myUserId]);

  const sendReaction = useCallback(
    async (emoji: string) => {
      if (!chat || !actionSheetFor) return;
      setActionSheetFor(null);
      const res = await apiFetch<{ reactions?: Record<string, string[]> }>(`/chats/${chat.id}/messages/${actionSheetFor}/react`, {
        method: 'POST',
        body: JSON.stringify({ emoji }),
      });
      if (res.ok && res.body.reactions) applyReaction(chat.id, actionSheetFor, res.body.reactions);
    },
    [chat, actionSheetFor, applyReaction]
  );

  const deleteMessage = useCallback(async () => {
    if (!chat || !actionSheetFor) return;
    const targetId = actionSheetFor;
    const original = listData.find((m) => m.id === targetId) || null;
    setActionSheetFor(null);
    applyDelete(chat.id, targetId);
    const res = await apiFetch(`/chats/${chat.id}/messages/${targetId}`, { method: 'DELETE' }).catch(() => null);
    // Roll back the optimistic delete if the server never actually deleted
    // it — otherwise a dropped request left the bubble permanently showing
    // "Message deleted" while the server still has the real content.
    if ((!res || !res.ok) && original) mergeMessages(chat.id, [original]);
  }, [chat, actionSheetFor, applyDelete, listData, mergeMessages]);

  const startEdit = useCallback(() => {
    if (!actionSheetMessage) return;
    setEditingId(actionSheetMessage.id);
    setInput(actionSheetMessage.text || '');
    setReplyTarget(null);
    setActionSheetFor(null);
  }, [actionSheetMessage]);

  const startReplyFromSheet = useCallback(() => {
    if (!actionSheetMessage) return;
    setReplyTarget({
      id: actionSheetMessage.id,
      fromName: actionSheetMessage.fromUserId === myUserId ? 'You' : names[actionSheetMessage.fromUserId] || 'Message',
      text: actionSheetMessage.deleted ? 'Message deleted' : actionSheetMessage.text || (actionSheetMessage.attachment ? 'Attachment' : ''),
    });
    setEditingId(null);
    setActionSheetFor(null);
  }, [actionSheetMessage, myUserId, names]);

  const copyFromSheet = useCallback(async () => {
    if (actionSheetMessage?.text) await Clipboard.setStringAsync(actionSheetMessage.text);
    setActionSheetFor(null);
  }, [actionSheetMessage]);

  const renderItem = useCallback(
    ({ item, index }: { item: ChatMessage; index: number }) => {
      const mine = item.fromUserId === myUserId;
      const prev = listData[index + 1]; // older
      const next = listData[index - 1]; // newer
      const isFirstInGroup = !isGroupable(item, prev);
      const isLastInGroup = !isGroupable(item, next);
      const showSenderName = chat?.type === 'group' && !mine && isFirstInGroup && item.type !== 'system';
      const separator = item.type === 'system' ? null : dateSeparatorLabel(item.ts, prev ? prev.ts : null);

      const receiptLabel =
        chat?.type === 'dm' && mine && item.id === mostRecentOwnId
          ? item._pending
            ? null
            : otherReadTs >= item.ts
              ? `Read ${formatTime(otherReadTs)}`
              : 'Delivered'
          : null;

      return (
        <View>
          {separator && (
            <Text style={[styles.dateSeparator, { color: theme.textLow }]}>{separator}</Text>
          )}
          <MessageBubble
            item={item}
            mine={mine}
            myUserId={myUserId}
            theme={theme}
            showSenderName={showSenderName}
            senderName={names[item.fromUserId]}
            senderColor={colorFromString(item.fromUserId, theme.ice, theme.fire)}
            isFirstInGroup={isFirstInGroup}
            isLastInGroup={isLastInGroup}
            readReceiptLabel={receiptLabel}
            onLongPress={() => setActionSheetFor(item.id)}
            onSwipeReply={() => {
              // Clear any in-progress edit — otherwise editingId stays set
              // after this reply is sent (onSend's editingId branch runs
              // first and returns early), and the *next* message send
              // would silently attach this stale reply target.
              setEditingId(null);
              setReplyTarget({
                id: item.id,
                fromName: mine ? 'You' : names[item.fromUserId] || 'Message',
                text: item.deleted ? 'Message deleted' : item.text || (item.attachment ? 'Attachment' : ''),
              });
            }}
          />
        </View>
      );
    },
    [myUserId, listData, chat?.type, names, theme, mostRecentOwnId, otherReadTs]
  );

  if (!chat) {
    return (
      <View style={[styles.container, { backgroundColor: theme.bg0, alignItems: 'center', justifyContent: 'center' }]}>
        <Text style={{ color: theme.textMid }}>Chat not found.</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: theme.bg0 }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      <Stack.Screen
        options={{
          // Bug: this used to always show chatTitle's raw fallback
          // ("Direct message"/"Group") for every DM, even after names[]
          // resolved the real peer name a moment later — dmPeerName
          // already computes the right value (chatTitle is still its own
          // fallback while resolveNames() hasn't returned yet), this just
          // wasn't using it.
          title: dmPeerId ? dmPeerName : chatTitle,
          headerRight: dmPeerId
            ? () => (
                <View style={styles.headerCallBtns}>
                  <Pressable onPress={() => callPeer(false)} hitSlop={8} disabled={inCall} style={{ opacity: inCall ? 0.4 : 1 }}>
                    <Text style={{ fontSize: 18 }}>📞</Text>
                  </Pressable>
                  <Pressable onPress={() => callPeer(true)} hitSlop={8} disabled={inCall} style={{ opacity: inCall ? 0.4 : 1 }}>
                    <Text style={{ fontSize: 18 }}>🎥</Text>
                  </Pressable>
                </View>
              )
            : undefined,
        }}
      />

      {!keyReady && (
        <View style={[styles.keyBanner, { backgroundColor: theme.glass, borderColor: theme.glassBrd }]}>
          <Text style={{ color: theme.textMid, fontSize: 12 }}>🔒 Setting up encryption for this chat…</Text>
        </View>
      )}

      <FlatList
        ref={listRef}
        data={listData}
        keyExtractor={(m) => m.id}
        renderItem={renderItem}
        inverted
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={{ color: theme.textMid }}>No messages yet. Say hello.</Text>
          </View>
        }
      />

      {typingLabel && <Text style={[styles.typing, { color: theme.textLow }]}>{typingLabel} is typing…</Text>}

      {sendError && (
        <Pressable
          onPress={() => setSendError(null)}
          style={[styles.sendErrorBanner, { backgroundColor: theme.glass, borderColor: theme.danger }]}
        >
          <Text style={{ color: theme.danger, fontSize: 12, flex: 1 }}>{sendError}</Text>
          <Text style={{ color: theme.textLow, fontSize: 12, marginLeft: 8 }}>✕</Text>
        </Pressable>
      )}

      {(replyTarget || editingId) && (
        <BlurView
          intensity={45}
          tint={theme.scheme === 'dark' ? 'dark' : 'light'}
          style={[styles.composerContext, { borderColor: theme.glassBrdHi }]}
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontSize: 11.5, fontWeight: '600', color: theme.ice }}>
              {editingId ? 'Editing message' : `Replying to ${replyTarget?.fromName}`}
            </Text>
            {replyTarget && (
              <Text numberOfLines={1} style={{ fontSize: 12, color: theme.textLow }}>
                {replyTarget.text}
              </Text>
            )}
          </View>
          <Pressable
            onPress={() => {
              setReplyTarget(null);
              if (editingId) {
                setEditingId(null);
                setInput('');
              }
            }}
            hitSlop={10}
          >
            <Text style={{ fontSize: 16, color: theme.textLow }}>✕</Text>
          </Pressable>
        </BlurView>
      )}

      {/* Liquid-glass pill composer bar — a real BlurView (not just a
          tinted rgba fill) so messages scrolling behind it actually
          show through frosted, matching the web app's own
          backdrop-filter:blur() glass panels (index.html's .glass rules). */}
      <BlurView intensity={50} tint={theme.scheme === 'dark' ? 'dark' : 'light'} style={[styles.composerRow, { borderColor: theme.glassBrdHi }]}>
        <TextInput
          value={input}
          onChangeText={onChangeText}
          placeholder="Message"
          placeholderTextColor={theme.textLow}
          style={[styles.input, { color: theme.textHi, backgroundColor: theme.glass, borderColor: theme.glassBrdHi }]}
          multiline
          editable={!sending}
        />
        <Pressable
          onPress={onSend}
          disabled={!input.trim() || sending}
          style={({ pressed }) => [
            styles.sendBtn,
            { backgroundColor: theme.ice, opacity: !input.trim() || sending ? 0.35 : pressed ? 0.7 : 1 },
          ]}
        >
          <Text style={{ color: '#0a0d12', fontWeight: '700', fontSize: 16 }}>{editingId ? '✓' : '↑'}</Text>
        </Pressable>
      </BlurView>

      <MessageActionSheet
        visible={!!actionSheetFor}
        theme={theme}
        canCopy={!!actionSheetMessage?.text && !actionSheetMessage.deleted}
        canEdit={!!actionSheetMessage && actionSheetMessage.fromUserId === myUserId && !actionSheetMessage.attachment && !actionSheetMessage.deleted}
        canDelete={!!actionSheetMessage && actionSheetMessage.fromUserId === myUserId && !actionSheetMessage.deleted}
        myReaction={myReactionOnActionSheet}
        onReact={sendReaction}
        onReply={startReplyFromSheet}
        onCopy={copyFromSheet}
        onEdit={startEdit}
        onDelete={deleteMessage}
        onClose={() => setActionSheetFor(null)}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  listContent: { paddingHorizontal: 10, paddingVertical: 12, flexGrow: 1, justifyContent: 'flex-end' },
  empty: { transform: [{ scaleY: -1 }], alignItems: 'center', padding: 24 },
  keyBanner: { padding: 8, borderBottomWidth: 1, alignItems: 'center' },
  sendErrorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 12,
    marginBottom: 6,
    padding: 8,
    borderRadius: 10,
    borderWidth: 1,
  },
  dateSeparator: { textAlign: 'center', fontSize: 11.5, fontWeight: '600', marginVertical: 10 },
  typing: { fontSize: 11.5, paddingHorizontal: 16, paddingBottom: 2 },
  composerContext: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 10,
    marginBottom: 6,
    padding: 10,
    borderRadius: 18,
    borderWidth: 1,
    overflow: 'hidden',
  },
  composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10, borderTopWidth: 1, overflow: 'hidden' },
  input: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 15,
    maxHeight: 120,
    minHeight: 40,
  },
  sendBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  headerCallBtns: { flexDirection: 'row', gap: 16, paddingRight: 4 },
});
