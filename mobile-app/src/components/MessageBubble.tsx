// iMessage-style bubble: tail on the last bubble of a consecutive run,
// tight corner radii within a group, tapback-style reaction pills, and two
// horizontal swipe gestures — right reveals a reply icon and triggers
// onSwipeReply past a threshold (bubble itself slides with the drag, same
// as Messages/WhatsApp's swipe-to-reply), left reveals this message's
// timestamp without moving the bubble (real iMessage doesn't shift bubbles
// on this gesture, just fades the time in at the trailing edge — mirrored
// here rather than reusing the reply-swipe's translate). Both built on core
// RN Animated + PanResponder — no reanimated/gesture-handler-swipeable
// dependency, which would need its own native config; PanResponder ships
// with React Native itself.

import { useMemo, useRef } from 'react';
import { View, Text, Pressable, StyleSheet, Animated, PanResponder } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { AttachmentView } from './MessageAttachments';
import type { ChatMessage } from '../types';
import type { ThemeColors } from '../theme';

// Own-message bubble gradient — mirrors index.html's exact CSS
// (`.bubble-row.me .bubble`, index.html:771):
//   background:linear-gradient(135deg, rgba(0,212,255,0.22), rgba(255,106,0,0.16));
//   border-color:rgba(0,212,255,0.25);
// This was previously a flat theme.ice fill (a stand-in from before this
// package was installable — see README's "known gap" note, now closed).
// RN's LinearGradient has no `deg` prop; start/end {0,0}->{1,1} is the
// standard approximation of a 135deg (top-left-to-bottom-right) CSS angle.
const MINE_BUBBLE_GRADIENT = ['rgba(0,212,255,0.22)', 'rgba(255,106,0,0.16)'] as const;
const MINE_BUBBLE_GRADIENT_START = { x: 0, y: 0 };
const MINE_BUBBLE_GRADIENT_END = { x: 1, y: 1 };
const MINE_BUBBLE_BORDER = 'rgba(0,212,255,0.25)';

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
  // In-chat message search (see app/chat/[id].tsx's msgSearch* state,
  // mirroring index.html's #msgSearchInput highlighting) — highlightQuery
  // is the lowercased search term to bold-highlight within this bubble's
  // text, isCurrentMatch picks a stronger highlight color for whichever
  // match searchStep() has currently scrolled to, same distinction as
  // web's own current-vs-other-match highlight treatment.
  highlightQuery?: string;
  isCurrentMatch?: boolean;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Splits `text` on (case-insensitive) occurrences of `query` and renders
// matched spans with a highlight background — same idea as index.html's
// highlightMatch() (index.html:2977-2979) regex-wrapping matches in a
// <mark>, adapted to RN Text's nested-Text-span model since there's no
// <mark> equivalent.
function HighlightedText({
  text,
  query,
  color,
  highlightBg,
  highlightColor,
}: {
  text: string;
  query: string;
  color: string;
  highlightBg: string;
  highlightColor: string;
}) {
  if (!query) return <Text>{text}</Text>;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const parts: { text: string; match: boolean }[] = [];
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(q, i);
    if (idx === -1) {
      parts.push({ text: text.slice(i), match: false });
      break;
    }
    if (idx > i) parts.push({ text: text.slice(i, idx), match: false });
    parts.push({ text: text.slice(idx, idx + q.length), match: true });
    i = idx + q.length;
  }
  return (
    <Text>
      {parts.map((p, idx) =>
        p.match ? (
          <Text key={idx} style={{ backgroundColor: highlightBg, color: highlightColor, fontWeight: '700' }}>
            {p.text}
          </Text>
        ) : (
          <Text key={idx} style={{ color }}>
            {p.text}
          </Text>
        )
      )}
    </Text>
  );
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
  highlightQuery,
  isCurrentMatch,
}: Props) {
  const dragX = useRef(new Animated.Value(0)).current;
  const replyIconOpacity = useRef(new Animated.Value(0)).current;
  const timeOpacity = useRef(new Animated.Value(0)).current;
  const SWIPE_LEFT_REVEAL_DISTANCE = 50; // fully revealed by this far, no threshold/trigger — just a peek, same as iMessage

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_evt, gesture) =>
        Math.abs(gesture.dx) > 8 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5,
      onPanResponderMove: (_evt, gesture) => {
        if (gesture.dx >= 0) {
          const clamped = Math.min(gesture.dx, SWIPE_MAX_DISTANCE);
          dragX.setValue(clamped);
          replyIconOpacity.setValue(Math.min(clamped / SWIPE_TRIGGER_DISTANCE, 1));
          timeOpacity.setValue(0);
        } else {
          // Left: reveal-only, no bubble translation and no release
          // "trigger" — matches real iMessage's swipe-to-peek-timestamps,
          // which is purely visual and has no action attached to it.
          const clamped = Math.min(-gesture.dx, SWIPE_LEFT_REVEAL_DISTANCE);
          dragX.setValue(0);
          replyIconOpacity.setValue(0);
          timeOpacity.setValue(clamped / SWIPE_LEFT_REVEAL_DISTANCE);
        }
      },
      onPanResponderRelease: (_evt, gesture) => {
        const triggered = gesture.dx > SWIPE_TRIGGER_DISTANCE;
        Animated.spring(dragX, { toValue: 0, useNativeDriver: true, bounciness: 8 }).start();
        Animated.timing(replyIconOpacity, { toValue: 0, duration: 150, useNativeDriver: true }).start();
        Animated.timing(timeOpacity, { toValue: 0, duration: 220, useNativeDriver: true }).start();
        if (triggered) onSwipeReply();
      },
      onPanResponderTerminate: () => {
        Animated.spring(dragX, { toValue: 0, useNativeDriver: true }).start();
        Animated.timing(replyIconOpacity, { toValue: 0, duration: 150, useNativeDriver: true }).start();
        Animated.timing(timeOpacity, { toValue: 0, duration: 220, useNativeDriver: true }).start();
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

      {/* Swipe-left reveal: peeks this message's own timestamp at the
          trailing edge, same side regardless of mine/theirs (iMessage
          always reveals on the right, since the gesture itself is always
          leftward) — purely a fade-in, the bubble itself never moves. */}
      <Animated.View style={[styles.timeReveal, { opacity: timeOpacity }]} pointerEvents="none">
        <Text style={{ fontSize: 11, color: theme.textLow }}>{formatTime(item.ts)}</Text>
      </Animated.View>

      <Animated.View
        {...panResponder.panHandlers}
        style={[styles.bubbleCol, mine ? styles.colMine : styles.colTheirs, { transform: [{ translateX: dragX }] }]}
      >
        {showSenderName && !mine && (
          <Text style={[styles.senderLabel, { color: senderColor || theme.textLow }]}>{senderName || ''}</Text>
        )}

        {item.replyTo?.id && (
          <Pressable onPress={onReplyPreviewPress} style={[styles.replyPreview, { borderLeftColor: theme.ice }]}>
            <Text numberOfLines={1} style={[styles.replyPreviewName, { color: theme.ice }]}>
              {item.replyTo.fromName || 'Message'}
            </Text>
            <Text numberOfLines={1} style={[styles.replyPreviewText, { color: theme.textLow }]}>
              {item.replyTo.text || ''}
            </Text>
          </Pressable>
        )}

        <Pressable onLongPress={onLongPress} delayLongPress={280}>
          {(() => {
            const bubbleChildren = (
              <>
                {item.attachment && !item.deleted && (
                  <View style={styles.attachmentWrap}>
                    <AttachmentView attachment={item.attachment} mine={mine} theme={theme} />
                  </View>
                )}
                {(!item.attachment || item.text || item.deleted) && (
                  <Text style={{ color: theme.textHi, fontSize: 15.5, lineHeight: 20.5 }}>
                    {item.deleted ? (
                      <Text style={{ fontStyle: 'italic', opacity: 0.7 }}>{bodyText}</Text>
                    ) : highlightQuery ? (
                      <HighlightedText
                        text={bodyText}
                        query={highlightQuery}
                        color={theme.textHi}
                        highlightBg={theme.fire}
                        highlightColor="#0a0d12"
                      />
                    ) : (
                      bodyText
                    )}
                    {!item.deleted && item.edited ? (
                      <Text style={{ fontSize: 11, color: theme.textLow }}> (edited)</Text>
                    ) : null}
                  </Text>
                )}

                {/* iMessage-style tail — only on the last bubble of a
                    consecutive run: a small square, colored the same as the
                    bubble, with just the inner corner rounded off. Sitting
                    flush against the bubble's own sharp tail-side corner
                    (see bubbleCornerStyle above) it reads as a single curved
                    tail extending out from that corner, no image/SVG asset
                    needed. Own-message tail reuses the same gradient so it
                    doesn't read as a mismatched flat-color patch glued onto
                    a translucent bubble. */}
                {isLastInGroup &&
                  (mine ? (
                    <LinearGradient
                      colors={MINE_BUBBLE_GRADIENT}
                      start={MINE_BUBBLE_GRADIENT_START}
                      end={MINE_BUBBLE_GRADIENT_END}
                      style={styles.tailMine}
                    />
                  ) : (
                    <View style={[styles.tailTheirs, { backgroundColor: theme.glass }]} />
                  ))}
              </>
            );
            const bubbleStyle = [
              styles.bubble,
              bubbleCornerStyle,
              { borderColor: mine ? MINE_BUBBLE_BORDER : theme.glassBrdHi },
              isCurrentMatch && { borderColor: theme.ice, borderWidth: 2 },
            ];
            // Own-message bubbles get the gradient fill (see
            // MINE_BUBBLE_GRADIENT above); others keep the flat glass fill —
            // matches web's `.bubble-row:not(.me) .bubble` vs
            // `.bubble-row.me .bubble` split exactly.
            return mine ? (
              <LinearGradient
                colors={MINE_BUBBLE_GRADIENT}
                start={MINE_BUBBLE_GRADIENT_START}
                end={MINE_BUBBLE_GRADIENT_END}
                style={bubbleStyle}
              >
                {bubbleChildren}
              </LinearGradient>
            ) : (
              <View style={[...bubbleStyle, { backgroundColor: theme.glass }]}>{bubbleChildren}</View>
            );
          })()}
        </Pressable>

        {reactionSummary.length > 0 && (
          <View style={[styles.reactionPillRow, mine ? { justifyContent: 'flex-end' } : { justifyContent: 'flex-start' }]}>
            {reactionSummary.map((r) => (
              <View
                key={r.emoji}
                style={[
                  styles.reactionPill,
                  // Matches index.html's `.reaction-pill.mine` exactly
                  // (index.html:826) — a translucent ice tint with a
                  // matching border, not a solid fill; this used to render
                  // as a solid bright theme.ice chip with dark text, which
                  // was never how web actually draws it.
                  r.mine
                    ? { backgroundColor: 'rgba(0,212,255,0.12)', borderColor: 'rgba(0,212,255,0.5)' }
                    : { backgroundColor: theme.glass, borderColor: theme.glassBrd },
                ]}
              >
                <Text style={{ fontSize: 12 }}>{r.emoji}</Text>
                {r.count > 1 && (
                  <Text style={{ fontSize: 10.5, color: r.mine ? theme.textHi : theme.textMid, marginLeft: 2 }}>{r.count}</Text>
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
  timeReveal: { position: 'absolute', top: '38%', right: -50, width: 46, alignItems: 'center' },
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
