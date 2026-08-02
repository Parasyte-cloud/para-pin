import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Image,
  FlatList,
  TextInput,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, Stack, router } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useTheme } from '../../src/hooks/useTheme';
import { useSessionStore } from '../../src/state/session';
import { useMessagesStore } from '../../src/state/messages';
import { useChatSocket } from '../../src/hooks/useChatSocket';
import { ensureChatKey } from '../../src/state/e2ee';
import { encryptString } from '../../src/crypto/e2ee';
import { resolveNames } from '../../src/state/names';
import { apiFetch } from '../../src/api/client';
import { useCallStore } from '../../src/state/call';
import type { ChatMessage, MessageAttachment } from '../../src/types';

const DECRYPT_RETRY_MS = 5000;

function formatBytes(size?: number): string {
  if (!size || size <= 0) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Image attachments once decrypted — a local file:// URI is enough for RN's
// Image component, no separate download step needed (unlike a file/voice
// row, which has to be tapped to be useful).
function ImageAttachment({ attachment, mine, theme }: { attachment: MessageAttachment; mine: boolean; theme: any }) {
  if (attachment._decryptedUri) {
    return (
      <Pressable onPress={() => Sharing.shareAsync(attachment._decryptedUri!).catch(() => {})}>
        <Image source={{ uri: attachment._decryptedUri }} style={styles.attachmentImage} resizeMode="cover" />
      </Pressable>
    );
  }
  return (
    <View style={[styles.attachmentPlaceholder, { backgroundColor: mine ? 'rgba(10,13,18,0.15)' : theme.glass }]}>
      {attachment._decryptedUri === null ? (
        <Text style={{ fontSize: 11, color: mine ? '#0a0d12' : theme.textLow }}>Couldn't load image</Text>
      ) : (
        <ActivityIndicator color={mine ? '#0a0d12' : theme.ice} size="small" />
      )}
    </View>
  );
}

// Voice notes: a play/pause button plus elapsed/duration, using
// expo-audio's player hooks. Source is only handed to the hook once bytes
// are actually decrypted; before that this just shows a loading dot,
// matching the same _decryptedUri/_decrypting states as file/image rows.
function AudioAttachment({ attachment, mine, theme }: { attachment: MessageAttachment; mine: boolean; theme: any }) {
  const player = useAudioPlayer(attachment._decryptedUri ? { uri: attachment._decryptedUri } : undefined);
  const status = useAudioPlayerStatus(player);

  if (!attachment._decryptedUri) {
    return (
      <View style={[styles.attachmentRow, { backgroundColor: mine ? 'rgba(10,13,18,0.1)' : theme.glass }]}>
        {attachment._decryptedUri === null ? (
          <Text style={{ fontSize: 12, color: mine ? '#0a0d12' : theme.textLow }}>Couldn't load voice note</Text>
        ) : (
          <ActivityIndicator color={mine ? '#0a0d12' : theme.ice} size="small" />
        )}
      </View>
    );
  }

  const elapsed = status.playing ? status.currentTime : 0;
  const duration = status.duration || attachment.duration || 0;

  return (
    <Pressable
      onPress={() => (status.playing ? player.pause() : player.play())}
      style={[styles.attachmentRow, { backgroundColor: mine ? 'rgba(10,13,18,0.1)' : theme.glass }]}
    >
      <Text style={{ fontSize: 18 }}>{status.playing ? '⏸' : '▶️'}</Text>
      <Text style={{ fontSize: 12.5, color: mine ? '#0a0d12' : theme.textHi }}>
        {formatDuration(elapsed)} / {formatDuration(duration)}
      </Text>
    </Pressable>
  );
}

function FileAttachment({ attachment, mine, theme }: { attachment: MessageAttachment; mine: boolean; theme: any }) {
  const canOpen = !!attachment._decryptedUri;
  return (
    <Pressable
      disabled={!canOpen}
      onPress={() => canOpen && Sharing.shareAsync(attachment._decryptedUri!).catch(() => {})}
      style={[styles.attachmentRow, { backgroundColor: mine ? 'rgba(10,13,18,0.1)' : theme.glass, opacity: canOpen ? 1 : 0.7 }]}
    >
      <Text style={{ fontSize: 18 }}>📎</Text>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: 12.5, color: mine ? '#0a0d12' : theme.textHi }}>
          {attachment.name || 'Attachment'}
        </Text>
        <Text style={{ fontSize: 10.5, color: mine ? 'rgba(10,13,18,0.6)' : theme.textLow }}>
          {attachment._decryptedUri === null ? "Couldn't decrypt" : attachment._decrypting ? 'Decrypting…' : formatBytes(attachment.size)}
        </Text>
      </View>
      {attachment._decrypting && <ActivityIndicator color={mine ? '#0a0d12' : theme.ice} size="small" />}
    </Pressable>
  );
}

function AttachmentView({ attachment, mine, theme }: { attachment: MessageAttachment; mine: boolean; theme: any }) {
  const mime = attachment.mime || '';
  if (mime.startsWith('image/')) return <ImageAttachment attachment={attachment} mine={mine} theme={theme} />;
  if (mime.startsWith('audio/')) return <AudioAttachment attachment={attachment} mine={mine} theme={theme} />;
  return <FileAttachment attachment={attachment} mine={mine} theme={theme} />;
}

export default function ChatDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const myUserId = useSessionStore((s) => s.userId);
  const chat = useSessionStore((s) => s.chats.find((c) => c.id === id)) ?? null;
  const messages = useMessagesStore((s) => (id ? s.byChat[id] || [] : []));
  const loadHistory = useMessagesStore((s) => s.loadHistory);
  const decryptChat = useMessagesStore((s) => s.decryptChat);
  const addOptimistic = useMessagesStore((s) => s.addOptimistic);
  const removeOptimistic = useMessagesStore((s) => s.removeOptimistic);
  const mergeMessages = useMessagesStore((s) => s.mergeMessages);

  const [names, setNames] = useState<Record<string, string>>({});
  const [typingLabel, setTypingLabel] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [keyReady, setKeyReady] = useState(false);
  const typingClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const chatTitle = chat?.name || (chat?.type === 'dm' ? 'Direct message' : 'Group');
  const dmPeerId = chat?.type === 'dm' ? chat.memberIds?.find((mid) => mid !== myUserId) || null : null;
  const dmPeerName = (dmPeerId && names[dmPeerId]) || chatTitle;
  const startOutgoingCall = useCallStore((s) => s.startOutgoingCall);
  const inCall = useCallStore((s) => s.callState !== 'idle');

  const callPeer = useCallback(
    (video: boolean) => {
      if (!dmPeerId || inCall) return;
      startOutgoingCall(dmPeerId, dmPeerName, null, video);
    },
    [dmPeerId, dmPeerName, inCall, startOutgoingCall]
  );

  const { sendTyping } = useChatSocket(chat, {
    onTyping: (userId, name) => {
      if (userId === myUserId) return;
      setTypingLabel(name);
      if (typingClearTimer.current) clearTimeout(typingClearTimer.current);
      typingClearTimer.current = setTimeout(() => setTypingLabel(null), 3000);
    },
    onMessage: () => {
      // New live message landed — nudge decrypt in case it needed a key
      // that's since become available (see e2ee.ts's 5s cooldown).
      if (chat) decryptChat(chat);
    },
  });

  // Initial load: history, member names (for group sender labels), mark
  // read, and kick off decryption (with a retry loop matching
  // index.html's startE2eeRetryPolling — chat-key establishment can
  // legitimately take a beat, e.g. waiting on a device-key round trip).
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
    setInput('');
    const key = await ensureChatKey(chat);
    if (!key) {
      setSending(false);
      setInput(text);
      return;
    }
    const enc = encryptString(key, text);
    const tempId = `pending-${Date.now()}`;
    const optimistic: ChatMessage = {
      id: tempId,
      fromUserId: myUserId || '',
      ts: Date.now(),
      text,
      _e2eeDone: true,
      _pending: true,
    };
    addOptimistic(chat.id, optimistic);
    const res = await apiFetch<{ message?: ChatMessage }>(`/chats/${chat.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ ciphertext: enc.ciphertext, iv: enc.iv, alg: chat.type === 'group' ? 'group' : 'dm' }),
    });
    setSending(false);
    removeOptimistic(chat.id, tempId);
    if (res.ok && res.body.message) {
      mergeMessages(chat.id, [{ ...res.body.message, text, _e2eeDone: true }]);
    } else {
      setInput(text); // don't lose what they typed
    }
  }, [input, chat, sending, myUserId, addOptimistic, removeOptimistic, mergeMessages]);

  const onChangeText = useCallback(
    (v: string) => {
      setInput(v);
      sendTyping();
    },
    [sendTyping]
  );

  const listData = useMemo(() => [...messages].reverse(), [messages]);

  const renderItem = useCallback(
    ({ item, index }: { item: ChatMessage; index: number }) => {
      const mine = item.fromUserId === myUserId;
      const prev = listData[index + 1]; // one earlier in time, since list is reversed
      const showSender = chat?.type === 'group' && !mine && prev?.fromUserId !== item.fromUserId;
      const bodyText = item.deleted ? 'Message deleted' : item.text || '…';
      return (
        <View style={[styles.bubbleRow, mine ? styles.bubbleRowMine : styles.bubbleRowTheirs]}>
          <View
            style={[
              styles.bubble,
              {
                backgroundColor: mine ? theme.ice : theme.glass,
                borderColor: mine ? 'transparent' : theme.glassBrd,
              },
            ]}
          >
            {showSender && (
              <Text style={[styles.senderLabel, { color: theme.textLow }]}>{names[item.fromUserId] || ''}</Text>
            )}
            {item.attachment && !item.deleted && (
              <View style={styles.attachmentWrap}>
                <AttachmentView attachment={item.attachment} mine={mine} theme={theme} />
              </View>
            )}
            {(!item.attachment || item.text || item.deleted) && (
              <Text style={{ color: mine ? '#0a0d12' : theme.textHi, fontSize: 14.5, lineHeight: 20 }}>
                {item.deleted ? <Text style={{ fontStyle: 'italic', opacity: 0.7 }}>{bodyText}</Text> : bodyText}
              </Text>
            )}
          </View>
        </View>
      );
    },
    [myUserId, listData, chat?.type, names, theme]
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
          title: chatTitle,
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

      {typingLabel && (
        <Text style={[styles.typing, { color: theme.textLow }]}>{typingLabel} is typing…</Text>
      )}

      <View style={[styles.composerRow, { borderColor: theme.glassBrd, backgroundColor: theme.bg1 }]}>
        <TextInput
          value={input}
          onChangeText={onChangeText}
          placeholder="Message"
          placeholderTextColor={theme.textLow}
          style={[styles.input, { color: theme.textHi, backgroundColor: theme.glass, borderColor: theme.glassBrd }]}
          multiline
          editable={!sending}
        />
        <Pressable
          onPress={onSend}
          disabled={!input.trim() || sending}
          style={({ pressed }) => [
            styles.sendBtn,
            { backgroundColor: theme.ice, opacity: !input.trim() || sending ? 0.4 : pressed ? 0.7 : 1 },
          ]}
        >
          <Text style={{ color: '#0a0d12', fontWeight: '700', fontSize: 13 }}>Send</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  listContent: { padding: 12, flexGrow: 1, justifyContent: 'flex-end' },
  empty: { transform: [{ scaleY: -1 }], alignItems: 'center', padding: 24 },
  keyBanner: { padding: 8, borderBottomWidth: 1, alignItems: 'center' },
  bubbleRow: { marginVertical: 3, flexDirection: 'row' },
  bubbleRowMine: { justifyContent: 'flex-end' },
  bubbleRowTheirs: { justifyContent: 'flex-start' },
  bubble: { maxWidth: '78%', borderRadius: 16, borderWidth: 1, paddingHorizontal: 13, paddingVertical: 9 },
  senderLabel: { fontSize: 11, fontWeight: '600', marginBottom: 2 },
  typing: { fontSize: 11.5, paddingHorizontal: 14, paddingBottom: 2 },
  composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10, borderTopWidth: 1 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 9,
    fontSize: 14,
    maxHeight: 120,
  },
  sendBtn: { borderRadius: 999, paddingHorizontal: 16, paddingVertical: 11 },
  headerCallBtns: { flexDirection: 'row', gap: 16, paddingRight: 4 },
  attachmentWrap: { marginBottom: 4 },
  attachmentImage: { width: 200, height: 200, borderRadius: 12 },
  attachmentPlaceholder: { width: 200, height: 120, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  attachmentRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, minWidth: 160 },
});
