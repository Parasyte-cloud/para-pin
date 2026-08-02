// Long-press message actions — iOS-native layout: the quick-reaction row
// the web app uses (index.html:3099's QUICK_REACTIONS, kept identical so a
// reaction sent from either client looks like a deliberate, consistent
// feature rather than two different emoji sets) floating above a centered
// sender-profile chip (avatar + name, "viewable" — large enough to actually
// read, not a cramped inline label), then the Reply/Copy/Edit/Delete list
// below, mirroring the web app's context menu (index.html:1272 area) and
// the iOS Messages long-press reference: reaction bar, sender identity,
// action list, all liquid glass. A simple centered modal rather than
// anchoring a popover exactly over the bubble — robust across message
// lengths/positions without a measurement dependency, still fully
// "long-press to act on a message."

import { View, Text, Pressable, StyleSheet, Modal } from 'react-native';
import { BlurView } from 'expo-blur';
import type { ThemeColors } from '../theme';
import { initials } from '../utils/avatar';

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

interface Props {
  visible: boolean;
  theme: ThemeColors & { scheme: 'light' | 'dark' };
  canCopy: boolean;
  canEdit: boolean;
  canDelete: boolean;
  myReaction: string | null;
  senderName: string;
  senderColor: string;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export default function MessageActionSheet({
  visible,
  theme,
  canCopy,
  canEdit,
  canDelete,
  myReaction,
  senderName,
  senderColor,
  onReact,
  onReply,
  onCopy,
  onEdit,
  onDelete,
  onClose,
}: Props) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* Reaction row floats as its own glass pill above the card, same
            as iOS's reference (the reactions aren't part of the menu card
            itself, they hover just above the message). */}
        <BlurView intensity={65} tint={theme.scheme === 'dark' ? 'dark' : 'light'} style={[styles.reactionPill, { borderColor: theme.glassBrdHi }]}>
          {QUICK_REACTIONS.map((emoji) => (
            <Pressable
              key={emoji}
              onPress={() => onReact(emoji)}
              style={({ pressed }) => [
                styles.reactionBtn,
                {
                  backgroundColor: myReaction === emoji ? theme.glass : 'transparent',
                  opacity: pressed ? 0.6 : 1,
                  transform: [{ scale: myReaction === emoji ? 1.15 : 1 }],
                },
              ]}
            >
              <Text style={{ fontSize: 24 }}>{emoji}</Text>
            </Pressable>
          ))}
        </BlurView>

        <Pressable onPress={() => {}} style={styles.cardWrap}>
          <BlurView intensity={65} tint={theme.scheme === 'dark' ? 'dark' : 'light'} style={[styles.card, { borderColor: theme.glassBrdHi }]}>
            {/* Sender profile — centered and legible, not a cramped
                inline label, so it's genuinely "viewable" rather than just
                technically present. Read-only here (no tap action) since
                there's no per-user profile screen for OTHER people yet on
                mobile — see ProfileModal's own comment for the same
                "own profile only" scope on the nav's Profile tab. */}
            <View style={[styles.senderRow, { borderBottomColor: theme.glassBrd }]}>
              <View style={[styles.senderAvatar, { backgroundColor: senderColor }]}>
                <Text style={styles.senderAvatarText}>{initials(senderName || '?')}</Text>
              </View>
              <Text style={[styles.senderName, { color: theme.textHi }]} numberOfLines={1}>
                {senderName}
              </Text>
            </View>

            <ActionRow label="Reply" icon="↩️" onPress={onReply} theme={theme} />
            {canCopy && <ActionRow label="Copy" icon="📋" onPress={onCopy} theme={theme} />}
            {canEdit && <ActionRow label="Edit" icon="✏️" onPress={onEdit} theme={theme} />}
            {canDelete && <ActionRow label="Delete" icon="🗑️" onPress={onDelete} theme={theme} danger />}
          </BlurView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ActionRow({
  label,
  icon,
  onPress,
  theme,
  danger,
}: {
  label: string;
  icon: string;
  onPress: () => void;
  theme: ThemeColors;
  danger?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.actionRow, { borderTopColor: theme.glassBrd, opacity: pressed ? 0.6 : 1 }]}
    >
      <Text style={{ fontSize: 15, color: danger ? theme.danger : theme.textHi }}>{label}</Text>
      <Text style={{ fontSize: 16 }}>{icon}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  // Its own floating pill, not the menu card's header — see the JSX
  // comment: iOS's reference shows the reactions hovering above the
  // message/menu, not embedded inside the card.
  reactionPill: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 2,
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    overflow: 'hidden',
    width: '100%',
    maxWidth: 300,
  },
  reactionBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  cardWrap: { width: '100%', maxWidth: 300 },
  card: { width: '100%', borderRadius: 20, borderWidth: 1, overflow: 'hidden' },
  senderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  senderAvatar: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  senderAvatarText: { color: '#0a0d12', fontWeight: '700', fontSize: 13 },
  senderName: { fontSize: 15.5, fontWeight: '700', flexShrink: 1 },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
