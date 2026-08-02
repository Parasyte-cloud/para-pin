// Attachment renderers, extracted out of app/chat/[id].tsx so both the
// bubble component and any future reuse (e.g. a media gallery) can share
// them. Behavior unchanged from the original Phase-2 implementation —
// image/voice-note/generic-file rendering keyed off MessageAttachment's
// `_decryptedUri`/`_decrypting` state (see src/state/messages.ts).
//
// The `mine` prop is intentionally NOT used to pick different colors here
// (general bug sweep fix, later round). It used to switch to dark literal
// colors (`#0a0d12`, `rgba(10,13,18,…)`) as a compensation for the mine
// bubble being a solid bright `theme.ice` fill — but web's own equivalents
// (`.file-card`, `.att-decrypting`, `.voice-note-play`, index.html:1020-
// 1046) never special-case the own-message case at all, they just inherit
// the page's normal text-hi/tint-based chip colors either way. Now that
// MessageBubble.tsx's own-message bubble is the actual translucent
// gradient over the dark app background (matching web), keeping the old
// dark-on-dark colors here would have made every attachment inside your
// own messages unreadable. `mine` is kept as a prop since AttachmentView's
// signature is shared with the bubble's rendering call site.

import { View, Text, Image, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import * as Sharing from 'expo-sharing';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import type { MessageAttachment } from '../types';
import type { ThemeColors } from '../theme';

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

interface AttachmentProps {
  attachment: MessageAttachment;
  mine: boolean;
  theme: ThemeColors;
}

function ImageAttachment({ attachment, mine, theme }: AttachmentProps) {
  if (attachment._decryptedUri) {
    return (
      <Pressable onPress={() => Sharing.shareAsync(attachment._decryptedUri!).catch(() => {})}>
        <Image source={{ uri: attachment._decryptedUri }} style={styles.attachmentImage} resizeMode="cover" />
      </Pressable>
    );
  }
  return (
    <View style={[styles.attachmentPlaceholder, { backgroundColor: theme.glass }]}>
      {attachment._decryptedUri === null ? (
        <Text style={{ fontSize: 11, color: theme.textLow }}>Couldn't load image</Text>
      ) : (
        <ActivityIndicator color={theme.ice} size="small" />
      )}
    </View>
  );
}

function AudioAttachment({ attachment, mine, theme }: AttachmentProps) {
  const player = useAudioPlayer(attachment._decryptedUri ? { uri: attachment._decryptedUri } : undefined);
  const status = useAudioPlayerStatus(player);

  if (!attachment._decryptedUri) {
    return (
      <View style={[styles.attachmentRow, { backgroundColor: theme.glass }]}>
        {attachment._decryptedUri === null ? (
          <Text style={{ fontSize: 12, color: theme.textLow }}>Couldn't load voice note</Text>
        ) : (
          <ActivityIndicator color={theme.ice} size="small" />
        )}
      </View>
    );
  }

  const elapsed = status.playing ? status.currentTime : 0;
  const duration = status.duration || attachment.duration || 0;

  return (
    <Pressable
      onPress={() => (status.playing ? player.pause() : player.play())}
      style={[styles.attachmentRow, { backgroundColor: theme.glass }]}
    >
      <Text style={{ fontSize: 18 }}>{status.playing ? '⏸' : '▶️'}</Text>
      <Text style={{ fontSize: 12.5, color: theme.textHi }}>
        {formatDuration(elapsed)} / {formatDuration(duration)}
      </Text>
    </Pressable>
  );
}

function FileAttachment({ attachment, mine, theme }: AttachmentProps) {
  const canOpen = !!attachment._decryptedUri;
  return (
    <Pressable
      disabled={!canOpen}
      onPress={() => canOpen && Sharing.shareAsync(attachment._decryptedUri!).catch(() => {})}
      style={[styles.attachmentRow, { backgroundColor: theme.glass, opacity: canOpen ? 1 : 0.7 }]}
    >
      <Text style={{ fontSize: 18 }}>📎</Text>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: 12.5, color: theme.textHi }}>
          {attachment.name || 'Attachment'}
        </Text>
        <Text style={{ fontSize: 10.5, color: theme.textLow }}>
          {attachment._decryptedUri === null ? "Couldn't decrypt" : attachment._decrypting ? 'Decrypting…' : formatBytes(attachment.size)}
        </Text>
      </View>
      {attachment._decrypting && <ActivityIndicator color={theme.ice} size="small" />}
    </Pressable>
  );
}

export function AttachmentView({ attachment, mine, theme }: AttachmentProps) {
  const mime = attachment.mime || '';
  if (mime.startsWith('image/')) return <ImageAttachment attachment={attachment} mine={mine} theme={theme} />;
  if (mime.startsWith('audio/')) return <AudioAttachment attachment={attachment} mine={mine} theme={theme} />;
  return <FileAttachment attachment={attachment} mine={mine} theme={theme} />;
}

const styles = StyleSheet.create({
  attachmentImage: { width: 200, height: 200, borderRadius: 14 },
  attachmentPlaceholder: { width: 200, height: 120, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  attachmentRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, minWidth: 160 },
});
