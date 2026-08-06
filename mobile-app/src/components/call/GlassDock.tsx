// Floating glass control dock — one reusable component for both the audio
// and video/meeting screens rather than each screen hand-rolling its own
// button row (which is how the old CallOverlay/MeetingOverlay ended up with
// two different, inconsistent control layouts). A call type only ever needs
// a subset of the full enterprise button set (Mute, Speaker/Audio route,
// Video, Share Screen, Participants, Transfer, Add Person, Record, Keypad,
// More, End) — the caller passes exactly the `primary` items it wants in
// the always-visible row and anything else in `overflow`, which collapses
// into a "More" glass sheet instead of cramming every icon onto one row
// (the old grid did exactly that and it read as busy, not premium).
//
// End Call is deliberately NOT just another item in the list — it's the
// one button in this entire dock whose accidental miss-tap has real
// consequences, so it's rendered as its own larger, unmistakably red
// element, offset from the glass pill rather than blended into it, the same
// visual-hierarchy instinct every serious calling UI (including the ones
// this brief says not to copy) independently arrives at for the same
// reason — that's a case where "don't copy X" and "build something good"
// aren't in tension, the shared answer is just correct.

import { useState, useRef, useEffect } from 'react';
import { View, Text, Pressable, StyleSheet, Modal, Animated } from 'react-native';
import { BlurView } from 'expo-blur';
import { GlassIconButton } from './primitives';
import { callColors, callRadii, callMotion } from '../../theme/callTheme';

export interface DockItem {
  key: string;
  icon: string;
  label: string;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  badge?: boolean; // small dot for "needs attention" (e.g. waiting-room knock while overflowed)
  onPress: () => void;
  accessibilityHint?: string;
}

export function GlassDock({
  primary,
  overflow = [],
  endCall,
  oneHandedOffset = 0,
}: {
  primary: DockItem[];
  overflow?: DockItem[];
  endCall: { label: string; onPress: () => void; disabled?: boolean };
  // Vertical nudge (px) for one-handed reachability — see the accessibility
  // pass: a person can drag the dock down toward their thumb, this is
  // where that offset gets applied.
  oneHandedOffset?: number;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const enter = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(enter, { toValue: 1, useNativeDriver: true, ...callMotion.springGentle }).start();
  }, [enter]);

  const translateY = enter.interpolate({ inputRange: [0, 1], outputRange: [40, 0] });
  const hasOverflowBadge = overflow.some((i) => i.badge);

  return (
    <Animated.View style={[styles.wrap, { transform: [{ translateY: Animated.add(translateY, oneHandedOffset) }], opacity: enter }]}>
      <BlurView intensity={54} tint="dark" style={styles.pill}>
        <View style={styles.row}>
          {primary.map((item) => (
            <View key={item.key}>
              <GlassIconButton
                icon={item.icon}
                label={item.label}
                active={item.active}
                danger={item.danger}
                disabled={item.disabled}
                onPress={item.onPress}
                accessibilityHint={item.accessibilityHint}
              />
              {item.badge && <View style={styles.dot} />}
            </View>
          ))}
          {overflow.length > 0 && (
            <View>
              <GlassIconButton icon="⋯" label="More" onPress={() => setMoreOpen(true)} accessibilityHint="Opens more call controls" />
              {hasOverflowBadge && <View style={styles.dot} />}
            </View>
          )}
        </View>
      </BlurView>

      <Pressable
        onPress={endCall.onPress}
        disabled={endCall.disabled}
        accessibilityRole="button"
        accessibilityLabel={endCall.label}
        style={({ pressed }) => [styles.endBtn, { opacity: endCall.disabled ? 0.4 : pressed ? 0.85 : 1, transform: [{ scale: pressed ? 0.94 : 1 }] }]}
      >
        <Text style={styles.endBtnIcon}>✕</Text>
      </Pressable>

      <Modal visible={moreOpen} transparent animationType="fade" onRequestClose={() => setMoreOpen(false)}>
        <Pressable style={styles.moreBackdrop} onPress={() => setMoreOpen(false)}>
          <Pressable onPress={(e) => e.stopPropagation()}>
            <BlurView intensity={64} tint="dark" style={styles.moreSheet}>
              <View style={styles.moreGrip} />
              <View style={styles.moreGrid}>
                {overflow.map((item) => (
                  <View key={item.key} style={styles.moreCell}>
                    <GlassIconButton
                      icon={item.icon}
                      label={item.label}
                      active={item.active}
                      danger={item.danger}
                      disabled={item.disabled}
                      accessibilityHint={item.accessibilityHint}
                      onPress={() => {
                        item.onPress();
                        setMoreOpen(false);
                      }}
                    />
                  </View>
                ))}
              </View>
            </BlurView>
          </Pressable>
        </Pressable>
      </Modal>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: 14, alignSelf: 'center' },
  pill: {
    borderRadius: callRadii.dock,
    paddingHorizontal: 14,
    paddingVertical: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: callColors.glassBrd,
  },
  row: { flexDirection: 'row', gap: 6, alignItems: 'flex-start' },
  dot: {
    position: 'absolute',
    top: 0,
    right: 6,
    width: 9,
    height: 9,
    borderRadius: 4.5,
    backgroundColor: callColors.danger,
    borderWidth: 1.5,
    borderColor: callColors.voidBottom,
  },
  endBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: callColors.danger,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: callColors.danger,
    shadowOpacity: 0.5,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  endBtnIcon: { fontSize: 26, color: '#fff', fontWeight: '800' },
  moreBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  moreSheet: {
    borderTopLeftRadius: callRadii.sheet,
    borderTopRightRadius: callRadii.sheet,
    paddingTop: 10,
    paddingBottom: 36,
    paddingHorizontal: 20,
    borderWidth: 1,
    borderColor: callColors.glassBrd,
    borderBottomWidth: 0,
  },
  moreGrip: { width: 36, height: 4, borderRadius: 2, backgroundColor: callColors.glassBrdHi, alignSelf: 'center', marginBottom: 16 },
  moreGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, justifyContent: 'flex-start' },
  moreCell: { width: 76, alignItems: 'center' },
});
