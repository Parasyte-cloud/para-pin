// Long-press message actions — reveals the same quick-reaction row the web
// app uses (index.html:3099's QUICK_REACTIONS, kept identical so a
// reaction sent from either client looks like a deliberate, consistent
// feature rather than two different emoji sets) plus Reply/Copy/Edit/
// Delete, mirroring the web app's context menu (index.html:1272 area).
// A simple centered modal rather than trying to anchor a popover exactly
// over the bubble — robust across message lengths/positions without a
// measurement dependency, still fully "long-press to act on a message."

import { View, Text, Pressable, StyleSheet, Modal } from 'react-native';
import { BlurView } from 'expo-blur';
import type { ThemeColors } from '../theme';

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

interface Props {
  visible: boolean;
  theme: ThemeColors & { scheme: 'light' | 'dark' };
  canCopy: boolean;
  canEdit: boolean;
  canDelete: boolean;
  myReaction: string | null;
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
        <Pressable onPress={() => {}} style={styles.cardWrap}>
          <BlurView intensity={65} tint={theme.scheme === 'dark' ? 'dark' : 'light'} style={[styles.card, { borderColor: theme.glassBrdHi }]}>
          <View style={[styles.reactionRow, { borderBottomColor: theme.glassBrd }]}>
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
                <Text style={{ fontSize: 26 }}>{emoji}</Text>
              </Pressable>
            ))}
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
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 32 },
  cardWrap: { width: '100%', maxWidth: 300 },
  card: { width: '100%', borderRadius: 20, borderWidth: 1, overflow: 'hidden' },
  reactionRow: { flexDirection: 'row', justifyContent: 'space-between', padding: 10, borderBottomWidth: 1 },
  reactionBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
