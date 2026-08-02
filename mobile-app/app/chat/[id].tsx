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
  Image,
  Alert,
} from 'react-native';
import { useLocalSearchParams, Stack, router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import { File } from 'expo-file-system';
import {
  useAudioRecorder,
  useAudioRecorderState,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
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
import { useMeetingStore } from '../../src/state/meeting';
import { colorFromString } from '../../src/utils/avatar';
import MessageBubble, { formatTime } from '../../src/components/MessageBubble';
import MessageActionSheet from '../../src/components/MessageActionSheet';
import { AuthBackdrop } from '../../src/components/AuthBackdrop';
import { encryptAndUploadAttachment, AttachmentUploadError, type PendingAttachment } from '../../src/utils/attachmentUpload';
import type { ChatMessage, MessageAttachment } from '../../src/types';

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
  const [pendingAttachment, setPendingAttachment] = useState<PendingAttachment | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCurrentIndex, setSearchCurrentIndex] = useState(-1);
  const typingClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const recordingDurationMsRef = useRef(0);

  // Voice-note recorder — RecordingPresets.HIGH_QUALITY produces a .m4a
  // file on both iOS and Android (see RecordingPresets' own doc comment),
  // matching MIME_EXTENSIONS' existing 'audio/m4a' entry in
  // state/messages.ts, so a voice note sent from mobile decrypts/plays
  // back correctly on mobile without adding a new extension mapping.
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(audioRecorder, 100);
  useEffect(() => {
    recordingDurationMsRef.current = recorderState.durationMillis || 0;
  }, [recorderState.durationMillis]);

  // If the screen unmounts mid-recording (back button, deep link, chat
  // switch) the native recording session otherwise keeps running with
  // nothing left to ever call .stop() on it — this is the same class of
  // bug as a call/meeting overlay leaking a live PeerConnection, just for
  // the mic instead.
  useEffect(() => {
    return () => {
      if (audioRecorder.isRecording) {
        audioRecorder.stop().catch(() => {});
        setAudioModeAsync({ allowsRecording: false }).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chatTitle = chat?.name || (chat?.type === 'dm' ? 'Direct message' : 'Group');
  const dmPeerId = chat?.type === 'dm' ? chat.memberIds?.find((mid) => mid !== myUserId) || null : null;
  const dmPeerName = (dmPeerId && names[dmPeerId]) || chatTitle;
  const startOutgoingCall = useCallStore((s) => s.startOutgoingCall);
  const inCall = useCallStore((s) => s.callState !== 'idle');
  const startMeeting = useMeetingStore((s) => s.startMeeting);
  const meetingStatus = useMeetingStore((s) => s.status);
  const inMeeting = meetingStatus !== 'idle';

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

  // Group calling's entry point: auto-invite every other member of THIS
  // chat, same as web's group-chat "Start meeting" button
  // (index.html:8388ish's joinMeetingRoom(newMeetingId, chat.name,
  // invitable, {orgId})) — mobile has no standalone contacts/roster picker
  // to choose people from yet, so the group chat's own memberIds is the
  // one entry point that doesn't need one.
  const startGroupMeeting = useCallback(() => {
    if (!chat || chat.type !== 'group' || inMeeting || inCall) return;
    const invite = (chat.memberIds || []).filter((mid) => mid !== myUserId);
    startMeeting(chat.name || 'Group call', chat.orgId ?? null, invite);
  }, [chat, inMeeting, inCall, myUserId, startMeeting]);

  // Photo attach — mirrors index.html's image-attachment picker in spirit
  // (pick, preview, upload-on-send), not its exact UI, since there's no
  // web-style drag/drop equivalent on mobile. fileSize isn't always
  // populated by the picker (notably: not from the camera on some
  // Android OEMs), so it falls back to reading the file's real size off
  // disk rather than sending a wrong/zero size to the recipient.
  const pickImage = useCallback(
    async (source: 'camera' | 'library') => {
      if (pendingAttachment || isRecording) return;
      const perm =
        source === 'camera'
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        setSendError(`${source === 'camera' ? 'Camera' : 'Photo library'} access is needed to attach a photo.`);
        return;
      }
      const result = await (source === 'camera'
        ? ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.8 })
        : ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 }));
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      let size = asset.fileSize || 0;
      if (!size) {
        try {
          size = new File(asset.uri).size || 0;
        } catch {
          // best-effort only — an unknown size still sends fine, it just
          // won't show a file-size hint anywhere in the UI
        }
      }
      setSendError(null);
      setPendingAttachment({
        kind: 'image',
        uri: asset.uri,
        mime: asset.mimeType || 'image/jpeg',
        name: asset.fileName || 'photo.jpg',
        size,
        width: asset.width || undefined,
        height: asset.height || undefined,
      });
    },
    [pendingAttachment, isRecording]
  );

  const openAttachMenu = useCallback(() => {
    if (pendingAttachment || isRecording || sending) return;
    Alert.alert('Add Photo', undefined, [
      { text: 'Take Photo', onPress: () => pickImage('camera') },
      { text: 'Choose from Library', onPress: () => pickImage('library') },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [pendingAttachment, isRecording, sending, pickImage]);

  // Voice notes — tap to start, tap again to stop (not iMessage's
  // press-and-hold-to-record, which needs its own gesture-conflict
  // handling against the surrounding ScrollView/FlatList; a tap toggle is
  // the same "one button, in or out of a recording" affordance without
  // that risk). Stopping produces a pendingAttachment preview the same as
  // a picked photo — reviewable and cancelable before it actually sends,
  // not fired off the instant you lift your finger.
  const startVoiceRecording = useCallback(async () => {
    if (pendingAttachment || isRecording || sending) return;
    const perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) {
      setSendError('Microphone access is needed to record a voice note.');
      return;
    }
    setSendError(null);
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await audioRecorder.prepareToRecordAsync();
    audioRecorder.record();
    setIsRecording(true);
  }, [pendingAttachment, isRecording, sending, audioRecorder]);

  const stopVoiceRecording = useCallback(
    async (discard: boolean) => {
      if (!isRecording) return;
      await audioRecorder.stop();
      setIsRecording(false);
      setAudioModeAsync({ allowsRecording: false }).catch(() => {});
      if (discard || !audioRecorder.uri) return;
      const durationSec = Math.max(1, Math.round(recordingDurationMsRef.current / 1000));
      let size = 0;
      try {
        size = new File(audioRecorder.uri).size || 0;
      } catch {
        // best-effort only, same as pickImage's size fallback
      }
      setPendingAttachment({
        kind: 'voice',
        uri: audioRecorder.uri,
        mime: 'audio/m4a',
        name: 'voice-message.m4a',
        size,
        duration: durationSec,
      });
    },
    [isRecording, audioRecorder]
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
    const attachment = pendingAttachment;
    if ((!text && !attachment) || !chat || sending) return;
    setSending(true);
    setSendError(null);
    // Everything below can throw synchronously (encryptString's underlying
    // @noble/ciphers call validates key/iv length strictly and throws if
    // ensureChatKey ever hands back a malformed key — a real possibility
    // right after a device-approval/rewrap) or reject (the two apiFetch
    // calls, plus now the attachment upload). onSend is invoked from
    // onPress as a fire-and-forget handler, so an uncaught throw here
    // doesn't just fail this send — it becomes an unhandled rejection
    // that React Native's release build can escalate to a fatal,
    // whole-app-crashing error (this is what the 2026-08-02 TestFlight
    // crash log traced back to: RN's own ExceptionsManager reportFatal:
    // path aborting the process). Wrapping the whole body turns any of
    // that into a normal, visible send error instead of a hard crash.
    // app/_layout.tsx's ErrorBoundary is the second layer of defense for
    // anything that still gets past this.
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

      if (editingId) {
        if (!text) return; // editing is text-only, same as web
        const enc = encryptString(key, text);
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
      setPendingAttachment(null);
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
        attachment: attachment
          ? {
              kind: attachment.kind,
              mime: attachment.mime,
              size: attachment.size,
              width: attachment.width,
              height: attachment.height,
              duration: attachment.duration,
              name: attachment.name,
              fileIv: 'pending', // any truthy value — see MessageAttachment's own comment, just picks the "encrypted attachment" render branch
              _decryptedUri: attachment.uri, // the original local file, shown immediately while the real upload/encrypt below is still in flight
            }
          : null,
      };
      addOptimistic(chat.id, optimistic);
      setReplyTarget(null);

      let attachmentPayload: MessageAttachment | null = null;
      if (attachment) {
        try {
          attachmentPayload = await encryptAndUploadAttachment(key, attachment);
        } catch (e) {
          removeOptimistic(chat.id, tempId);
          setSendError(e instanceof AttachmentUploadError ? e.message : "Couldn't upload the attachment. Try again.");
          if (text) setInput(text);
          setPendingAttachment(attachment);
          return;
        }
      }

      const enc = text ? encryptString(key, text) : null;
      const res = await apiFetch<{ message?: ChatMessage }>(`/chats/${chat.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          ciphertext: enc?.ciphertext,
          iv: enc?.iv,
          alg: chat.type === 'group' ? 'group' : 'dm',
          attachment: attachmentPayload,
          replyTo: replyPayload,
        }),
      });
      removeOptimistic(chat.id, tempId);
      if (res.ok && res.body.message) {
        const merged: ChatMessage = { ...res.body.message, text, _e2eeDone: true };
        if (attachmentPayload && merged.attachment) {
          // Same reasoning as the optimistic bubble above — we already
          // have both the plaintext name and the original local file, no
          // need to round-trip a decrypt of our own just-sent attachment.
          merged.attachment = { ...merged.attachment, name: attachment!.name, _decryptedUri: attachment!.uri };
        }
        mergeMessages(chat.id, [merged]);
      } else {
        // Previously silently restored the input with zero indication
        // anything went wrong — put the text back (so nothing's lost) but
        // now actually say so.
        if (text) setInput(text);
        setSendError(
          !res.ok && res.networkError ? "Couldn't reach PArA. Check your connection and try again." : "That message didn't send. Try again."
        );
      }
    } catch (e: any) {
      // Belt-and-suspenders for the encrypt-throw case above, plus
      // anything else unforeseen — never let a send attempt escape as an
      // uncaught/unhandled rejection.
      if (text) setInput(text);
      setSendError(e?.message ? `Send failed: ${e.message}` : "That message didn't send. Try again.");
    } finally {
      setSending(false);
    }
  }, [input, pendingAttachment, chat, sending, myUserId, editingId, replyTarget, addOptimistic, removeOptimistic, mergeMessages, applyEdit]);

  const onChangeText = useCallback(
    (v: string) => {
      setInput(v);
      setSendError(null);
      sendTyping();
    },
    [sendTyping]
  );

  const listData = useMemo(() => [...messages].reverse(), [messages]);

  // ---------------- in-chat message search ----------------
  // Client-side only, same as index.html's msgSearch* implementation
  // (index.html:9749-9819) — messages are E2EE'd, the server never sees
  // plaintext to search server-side, so this can only ever match against
  // what's already been decrypted onto this device. Matches are computed
  // in `messages`' own chronological order (oldest-first), not listData's
  // reversed/inverted order, purely because that's what web's
  // searchMatchIds does and "most recent match first" (below) reads more
  // naturally off that ordering.
  const scrollToMessageId = useCallback(
    (id: string) => {
      const idx = listData.findIndex((m) => m.id === id);
      if (idx === -1 || !listRef.current) return;
      try {
        listRef.current.scrollToIndex({ index: idx, viewPosition: 0.5, animated: true });
      } catch {
        // onScrollToIndexFailed below handles the retry
      }
    },
    [listData]
  );

  const searchMatchIds = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    // Protected messages are excluded from matching entirely (not just
    // display) — same reasoning as web's identical exclusion: search
    // shouldn't be able to confirm a protected message contains a given
    // term via a highlighted hit before it's ever unlocked.
    return messages
      .filter((m) => m.type !== 'system' && !m.deleted && !m.protected && m.text && m.text.toLowerCase().includes(q))
      .map((m) => m.id);
  }, [messages, searchQuery]);

  // Re-lands on "most recent match" only when the QUERY changes (typing),
  // not on every re-render where searchMatchIds' contents shift for other
  // reasons (e.g. a new message arriving) — that would otherwise yank the
  // user back to the bottom mid-navigation.
  useEffect(() => {
    setSearchCurrentIndex(searchMatchIds.length ? searchMatchIds.length - 1 : -1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  useEffect(() => {
    if (searchCurrentIndex < 0) return;
    const id = searchMatchIds[searchCurrentIndex];
    if (id) scrollToMessageId(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchCurrentIndex]);

  const toggleSearch = useCallback(() => {
    setSearchOpen((prev) => {
      const next = !prev;
      if (!next) {
        setSearchQuery('');
        setSearchCurrentIndex(-1);
      }
      return next;
    });
  }, []);

  const searchStep = useCallback(
    (dir: number) => {
      if (!searchMatchIds.length) return;
      setSearchCurrentIndex((prev) => (prev + dir + searchMatchIds.length) % searchMatchIds.length);
    },
    [searchMatchIds]
  );

  const currentSearchMatchId = searchCurrentIndex >= 0 ? searchMatchIds[searchCurrentIndex] : null;

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
            highlightQuery={searchMatchIds.includes(item.id) ? searchQuery.trim() : undefined}
            isCurrentMatch={item.id === currentSearchMatchId}
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
    [myUserId, listData, chat?.type, names, theme, mostRecentOwnId, otherReadTs, searchMatchIds, searchQuery, currentSearchMatchId]
  );

  if (!chat) {
    return (
      <AuthBackdrop>
        <View style={[styles.container, { alignItems: 'center', justifyContent: 'center' }]}>
          <Text style={{ color: theme.textMid }}>Chat not found.</Text>
        </View>
      </AuthBackdrop>
    );
  }

  return (
    <AuthBackdrop>
    <KeyboardAvoidingView
      style={styles.container}
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
          headerRight: () => (
            <View style={styles.headerCallBtns}>
              <Pressable onPress={toggleSearch} hitSlop={8}>
                <Text style={{ fontSize: 17, opacity: searchOpen ? 1 : 0.85 }}>🔍</Text>
              </Pressable>
              {dmPeerId && (
                <>
                  <Pressable onPress={() => callPeer(false)} hitSlop={8} disabled={inCall} style={{ opacity: inCall ? 0.4 : 1 }}>
                    <Text style={{ fontSize: 18 }}>📞</Text>
                  </Pressable>
                  <Pressable onPress={() => callPeer(true)} hitSlop={8} disabled={inCall} style={{ opacity: inCall ? 0.4 : 1 }}>
                    <Text style={{ fontSize: 18 }}>🎥</Text>
                  </Pressable>
                </>
              )}
              {!dmPeerId && chat?.type === 'group' && (
                <Pressable
                  onPress={startGroupMeeting}
                  hitSlop={8}
                  disabled={inMeeting || inCall}
                  style={{ opacity: inMeeting || inCall ? 0.4 : 1 }}
                >
                  <Text style={{ fontSize: 18 }}>🎥</Text>
                </Pressable>
              )}
            </View>
          ),
        }}
      />

      {searchOpen && (
        <BlurView
          intensity={45}
          tint={theme.scheme === 'dark' ? 'dark' : 'light'}
          style={[styles.searchBar, { borderColor: theme.glassBrdHi }]}
        >
          <Text style={{ fontSize: 14 }}>🔍</Text>
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search in this chat"
            placeholderTextColor={theme.textLow}
            autoFocus
            style={[styles.searchInput, { color: theme.textHi }]}
            returnKeyType="search"
            onSubmitEditing={() => searchStep(-1)}
          />
          <Text style={{ fontSize: 12, color: theme.textLow, minWidth: 34, textAlign: 'center' }}>
            {searchMatchIds.length ? `${searchCurrentIndex + 1}/${searchMatchIds.length}` : searchQuery.trim() ? '0/0' : ''}
          </Text>
          <Pressable onPress={() => searchStep(-1)} hitSlop={8} disabled={!searchMatchIds.length}>
            <Text style={{ fontSize: 15, color: searchMatchIds.length ? theme.textHi : theme.textLow, opacity: searchMatchIds.length ? 1 : 0.4 }}>‹</Text>
          </Pressable>
          <Pressable onPress={() => searchStep(1)} hitSlop={8} disabled={!searchMatchIds.length}>
            <Text style={{ fontSize: 15, color: searchMatchIds.length ? theme.textHi : theme.textLow, opacity: searchMatchIds.length ? 1 : 0.4 }}>›</Text>
          </Pressable>
          <Pressable onPress={toggleSearch} hitSlop={8}>
            <Text style={{ fontSize: 15, color: theme.textLow }}>✕</Text>
          </Pressable>
        </BlurView>
      )}

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
        extraData={`${searchQuery}:${currentSearchMatchId}`}
        inverted
        contentContainerStyle={styles.listContent}
        // Bubbles are variable-height, so scrollToIndex (used by
        // scrollToMessageId above to jump to a search match) can't rely on
        // getItemLayout math and sometimes misses on the first attempt —
        // this is FlatList's own documented recovery hook: jump to an
        // approximate offset, then retry the precise scroll once that
        // render settles.
        onScrollToIndexFailed={(info) => {
          listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
          setTimeout(() => {
            listRef.current?.scrollToIndex({ index: info.index, viewPosition: 0.5, animated: true });
          }, 100);
        }}
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

      {pendingAttachment && !isRecording && (
        <BlurView
          intensity={45}
          tint={theme.scheme === 'dark' ? 'dark' : 'light'}
          style={[styles.composerContext, { borderColor: theme.glassBrdHi }]}
        >
          {pendingAttachment.kind === 'image' ? (
            <Image source={{ uri: pendingAttachment.uri }} style={styles.attachPreviewThumb} />
          ) : (
            <View style={[styles.attachPreviewThumb, styles.attachPreviewVoiceIcon, { backgroundColor: theme.glass }]}>
              <Text style={{ fontSize: 18 }}>🎙</Text>
            </View>
          )}
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontSize: 11.5, fontWeight: '600', color: theme.ice }}>
              {pendingAttachment.kind === 'image' ? 'Photo' : 'Voice message'}
            </Text>
            {pendingAttachment.kind === 'voice' && (
              <Text style={{ fontSize: 12, color: theme.textLow }}>{pendingAttachment.duration}s</Text>
            )}
          </View>
          <Pressable onPress={() => setPendingAttachment(null)} hitSlop={10} disabled={sending}>
            <Text style={{ fontSize: 16, color: theme.textLow }}>✕</Text>
          </Pressable>
        </BlurView>
      )}

      {isRecording && (
        <BlurView
          intensity={45}
          tint={theme.scheme === 'dark' ? 'dark' : 'light'}
          style={[styles.composerContext, { borderColor: theme.danger }]}
        >
          <View style={[styles.recordingDot, { backgroundColor: theme.danger }]} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontSize: 12.5, fontWeight: '600', color: theme.textHi }}>
              Recording… {Math.floor(recorderState.durationMillis / 1000)}s
            </Text>
          </View>
          <Pressable onPress={() => stopVoiceRecording(true)} hitSlop={10} style={{ marginRight: 14 }}>
            <Text style={{ fontSize: 13, color: theme.textLow }}>Cancel</Text>
          </Pressable>
          <Pressable onPress={() => stopVoiceRecording(false)} hitSlop={10}>
            <Text style={{ fontSize: 13, fontWeight: '700', color: theme.ice }}>Stop</Text>
          </Pressable>
        </BlurView>
      )}

      {/* Liquid-glass pill composer bar — a real BlurView (not just a
          tinted rgba fill) so messages scrolling behind it actually
          show through frosted, matching the web app's own
          backdrop-filter:blur() glass panels (index.html's .glass rules). */}
      <BlurView intensity={50} tint={theme.scheme === 'dark' ? 'dark' : 'light'} style={[styles.composerRow, { borderColor: theme.glassBrdHi }]}>
        <Pressable
          onPress={openAttachMenu}
          disabled={sending || isRecording || !!pendingAttachment || !!editingId}
          hitSlop={8}
          style={{ opacity: sending || isRecording || pendingAttachment || editingId ? 0.35 : 1, paddingBottom: 8 }}
        >
          <Text style={{ fontSize: 22, color: theme.ice }}>+</Text>
        </Pressable>
        <TextInput
          value={input}
          onChangeText={onChangeText}
          placeholder="Message"
          placeholderTextColor={theme.textLow}
          style={[styles.input, { color: theme.textHi, backgroundColor: theme.glass, borderColor: theme.glassBrdHi }]}
          multiline
          editable={!sending}
        />
        {!input.trim() && !pendingAttachment && !editingId ? (
          <Pressable
            onPress={() => (isRecording ? stopVoiceRecording(false) : startVoiceRecording())}
            disabled={sending}
            style={({ pressed }) => [
              styles.sendBtn,
              { backgroundColor: isRecording ? theme.danger : theme.glass, opacity: sending ? 0.35 : pressed ? 0.7 : 1 },
            ]}
          >
            <Text style={{ fontSize: 17 }}>{isRecording ? '⏹' : '🎙'}</Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={onSend}
            disabled={(!input.trim() && !pendingAttachment) || sending}
            style={({ pressed }) => [
              styles.sendBtn,
              { backgroundColor: theme.ice, opacity: (!input.trim() && !pendingAttachment) || sending ? 0.35 : pressed ? 0.7 : 1 },
            ]}
          >
            <Text style={{ color: '#0a0d12', fontWeight: '700', fontSize: 16 }}>{editingId ? '✓' : '↑'}</Text>
          </Pressable>
        )}
      </BlurView>

      <MessageActionSheet
        visible={!!actionSheetFor}
        theme={theme}
        canCopy={!!actionSheetMessage?.text && !actionSheetMessage.deleted}
        canEdit={!!actionSheetMessage && actionSheetMessage.fromUserId === myUserId && !actionSheetMessage.attachment && !actionSheetMessage.deleted}
        canDelete={!!actionSheetMessage && actionSheetMessage.fromUserId === myUserId && !actionSheetMessage.deleted}
        myReaction={myReactionOnActionSheet}
        senderName={
          actionSheetMessage
            ? actionSheetMessage.fromUserId === myUserId
              ? 'You'
              : names[actionSheetMessage.fromUserId] || 'Message'
            : ''
        }
        senderColor={actionSheetMessage ? colorFromString(actionSheetMessage.fromUserId, theme.ice, theme.fire) : theme.ice}
        onReact={sendReaction}
        onReply={startReplyFromSheet}
        onCopy={copyFromSheet}
        onEdit={startEdit}
        onDelete={deleteMessage}
        onClose={() => setActionSheetFor(null)}
      />
    </KeyboardAvoidingView>
    </AuthBackdrop>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  // 14px (was 10) — extra clearance for the bubble tail's -6px protrusion
  // (MessageBubble.tsx's tailMine/tailTheirs), see that file's comment.
  listContent: { paddingHorizontal: 14, paddingVertical: 12, flexGrow: 1, justifyContent: 'flex-end' },
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
  attachPreviewThumb: { width: 40, height: 40, borderRadius: 8 },
  attachPreviewVoiceIcon: { alignItems: 'center', justifyContent: 'center' },
  recordingDot: { width: 10, height: 10, borderRadius: 5 },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 10,
    marginBottom: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
  },
  searchInput: { flex: 1, fontSize: 14, paddingVertical: 2 },
});
