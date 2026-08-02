// iMessage-style bubble: tail on the last bubble of a consecutive run,
// tight corner radii within a group, tapback-style reaction pills, and a
// swipe-right-to-reply gesture (built on core RN Animated + PanResponder —
// no reanimated/gesture-handler-swipeable dependency, which would need
// its own native config; PanResponder ships with React Native itself).

import { useMemo, useRef } from 'react';
import { View, Text, Pressable, StyleSheet, Animated, PanResponder } from 'react-native';
import { AttachmentView } from './MessageAttachments';
import type { ChatMessage } from '../types';
import type { ThemeColors } from '../theme';

const SWIPE_TRIGGER_DISTANCE = 56;
const SWIPE_MAX_DISTANCE = 80;

interface Props {
  item: ChatMessage;
  mine: boolean;
  myUserId: string | null;
  theme: ThemeColors;
  showSenderName: boolean;
  senderName?: string;
  senderColor?: string;
  isFirstInGroup: boolean;
  isLastInGroup: boolean;
  readReceiptLabel?: string | null;
  onLongPress: () => void;
  onSwipeReply: () => void;
  onReplyPreviewPress?: () => void;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default function MessageBubble({
  item,
  mine,
  myUserId,
  theme,
  showSenderName,
  senderName,
  senderColor,
  isFirstInGroup,
  isLastInGroup,
  readReceiptLabel,
  onLongPress,
  onSwipeReply,
  onReplyPreviewPress,
}: Props) {
  const dragX = useRef(new Animated.Value(0)).current;
  const replyIconOpacity = useRef(new Animated.Value(0)).current;

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_evt, gesture) =>
        Math.abs(gesture.dx) > 8 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5 && gesture.dx > 0,
      onPanResponderMove: (_evt, gesture) => {
        const clamped = Math.min(Math.max(gesture.dx, 0), SWIPE_MAX_DISTANCE);
        dragX.setValue(clamped);
        replyIconOpacity.setValue(Math.min(clamped / SWIPE_TRIGGER_DISTANCE, 1));
      },
      onPanResponderRelease: (_evt, gesture) => {
        const triggered = gesture.dx > SWIPE_TRIGGER_DISTANCE;
        Animated.spring(dragX, { toValue: 0, useNativeDriver: true, bounciness: 8 }).start();
        Animated.timing(replyIconOpacity, { toValue: 0, duration: 150, useNativeDriver: true }).start();
        if (triggered) onSwipeReply();
      },
      onPanResponderTerminate: () => {
        Animated.spring(dragX, { toValue: 0, useNativeDriver: true }).start();
        Animated.timing(replyIconOpacity, { toValue: 0, duration: 150, useNativeDriver: true }).start();
      },
    })
  ).current;

  const reactionSummary = useMemo(() => {
    const reactions = item.reactions;
    if (!reactions) return [];
    return Object.entries(reactions)
      .filter(([, ids]) => ids.length > 0)
      .map(([emoji, ids]) => ({ emoji, count: ids.length, mine: !!myUserId && ids.includes(myUserId) }));
  }, [item.reactions, myUserId]);

  const bodyText = item.deleted ? 'Message deleted' : item.text || '…';
  const tailRadius = 5;
  const roundRadius = 20; // pushed up from 18 — closer to a true pill/capsule on single-line bubbles

  // Tail-side corners tighten for every bubble that's continuing a run
  // (not first/not last), same as iMessage/WhatsApp grouping — this used
  // to be a no-op ternary (both branches returned roundRadius), so every
  // bubble in the middle of a group rendered as a fully-rounded standalone
  // bubble instead of visually connecting to its neighbors. Non-tail-side
  // corners stay fully rounded regardless of grouping.
  const bubbleCornerStyle = mine
    ? {
        borderTopLeftRadius: roundRadius,
        borderTopRightRadius: isFirstInGroup ? roundRadius : tailRadius,
        borderBottomLeftRadius: roundRadius,
        borderBottomRightRadius: isLastInGroup ? tailRadius : tailRadius,
      }
    : {
        borderTopLeftRadius: isFirstInGroup ? roundRadius : tailRadius,
        borderTopRightRadius: roundRadius,
        borderBottomLeftRadius: isLastInGroup ? tailRadius : tailRadius,
        borderBottomRightRadius: roundRadius,
      };

  return (
    <View style={[styles.row, mine ? styles.rowMine : styles.rowTheirs, { marginTop: isFirstInGroup ? 10 : 2 }]}>
      <Animated.View
        style={[styles.replyIcon, mine ? { right: '100%' } : { left: '100%' }, { opacity: replyIconOpacity }]}
        pointerEvents="none"
      >
        <Text style={{ fontSize: 18, color: theme.textLow }}>↩️</Text>
      </Animated.View>

      <Animated.View
        {...panResponder.panHandlers}
        style={[styles.bubbleCol, mine ? styles.colMine : styles.colTheirs, { transform: [{ translateX: dragX }] }]}
      >
        {showSenderName && !mine && (
          <Text style={[styles.senderLabel, { color: senderColor || theme.textLow }]}>{senderName || ''}</Text>
        )}

        {item.replyTo?.id && (
          <Pressable onPress={onReplyPreviewPress} style={[styles.replyPreview, { borderLeftColor: mine ? '#0a0d12' : theme.ice }]}>
            <Text numberOfLines={1} style={[styles.replyPreviewName, { color: mine ? 'rgba(10,13,18,0.7)' : theme.ice }]}>
              {item.replyTo.fromName || 'Message'}
            </Text>
            <Text numberOfLines={1} style={[styles.replyPreviewText, { color: mine ? 'rgba(10,13,18,0.6)' : theme.textLow }]}>
              {item.replyTo.text || ''}
            </Text>
          </Pressable>
        )}

        <Pressable onLongPress={onLongPress} delayLongPress={280}>
          <View
            style={[
              styles.bubble,
              bubbleCornerStyle,
              {
                backgroundColor: mine ? theme.ice : theme.glass,
                borderColor: mine ? 'transparent' : theme.glassBrdHi,
              },
            ]}
          >
            {item.attachment && !item.deleted && (
              <View style={styles.attachmentWrap}>
                <AttachmentView attachment={item.attachment} mine={mine} theme={theme} />
              </View>
            )}
            {(!item.attachment || item.text || item.deleted) && (
              <Text style={{ color: mine ? '#0a0d12' : theme.textHi, fontSize: 15.5, lineHeight: 20.5 }}>
                {item.deleted ? <Text style={{ fontStyle: 'italic', opacity: 0.7 }}>{bodyText}</Text> : bodyText}
                {!item.deleted && item.edited ? (
                  <Text style={{ fontSize: 11, color: mine ? 'rgba(10,13,18,0.55)' : theme.textLow }}> (edited)</Text>
                ) : null}
              </Text>
            )}

            {/* iMessage-style tail — only on the last bubble of a
                consecutive run: a small square, colored the same as the
                bubble, with just the inner corner rounded off. Sitting
                flush against the bubble's own sharp tail-side corner
                (see bubbleCornerStyle above) it reads as a single curved
                tail extending out from that corner, no image/SVG asset
                needed. */}
            {isLastInGroup && (
              <View
                style={[
                  mine ? styles.tailMine : styles.tailTheirs,
                  { backgroundColor: mine ? theme.ice : theme.glass },
                ]}
              />
            )}
          </View>
        </Pressable>

        {reactionSummary.length > 0 && (
          <View style={[styles.reactionPillRow, mine ? { justifyContent: 'flex-end' } : { justifyContent: 'flex-start' }]}>
            {reactionSummary.map((r) => (
              <View
                key={r.emoji}
                style={[
                  styles.reactionPill,
                  { backgroundColor: r.mine ? theme.ice : theme.glass, borderColor: theme.glassBrd },
                ]}
              >
                <Text style={{ fontSize: 12 }}>{r.emoji}</Text>
                {r.count > 1 && (
                  <Text style={{ fontSize: 10.5, color: r.mine ? '#0a0d12' : theme.textMid, marginLeft: 2 }}>{r.count}</Text>
                )}
              </View>
            ))}
          </View>
        )}

        {isLastInGroup && readReceiptLabel && (
          <Text style={[styles.readReceipt, { color: theme.textLow }]}>{readReceiptLabel}</Text>
        )}
      </Animated.View>
    </View>
  );
}

export { formatTime };

const styles = StyleSheet.create({
  row: { flexDirection: 'row' },
  rowMine: { justifyContent: 'flex-end' },
  rowTheirs: { justifyContent: 'flex-start' },
  // 74% (was 78%) plus the FlatList's own horizontal padding bump (see
  // chat/[id].tsx's listContent style) — at 78% a right-aligned "mine"
  // bubble had almost no clearance before the tail's -6px protrusion (see
  // tailMine below) ran into the screen edge, which is what read as a
  // clipped/cut-off tail in testing.
  bubbleCol: { maxWidth: '74%' },
  colMine: { alignItems: 'flex-end' },
  colTheirs: { alignItems: 'flex-start' },
  senderLabel: { fontSize: 11.5, fontWeight: '600', marginBottom: 2, marginLeft: 12 },
  bubble: { borderWidth: 1, paddingHorizontal: 14, paddingVertical: 9, minHeight: 38, justifyContent: 'center', position: 'relative' },
  attachmentWrap: { marginBottom: 4 },
  tailMine: {
    position: 'absolute',
    bottom: 0,
    right: -6,
    width: 10,
    height: 10,
    borderBottomLeftRadius: 10,
  },
  tailTheirs: {
    position: 'absolute',
    bottom: 0,
    left: -6,
    width: 10,
    height: 10,
    borderBottomRightRadius: 10,
  },
  replyIcon: { position: 'absolute', top: '35%', width: 32, alignItems: 'center' },
  replyPreview: { borderLeftWidth: 3, paddingLeft: 8, marginBottom: 4, maxWidth: '100%' },
  replyPreviewName: { fontSize: 11.5, fontWeight: '600' },
  replyPreviewText: { fontSize: 11.5 },
  reactionPillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 3 },
  reactionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  readReceipt: { fontSize: 10.5, marginTop: 2, marginRight: 2 },
});
