// Shared visual language for the redesigned calling surfaces — the large
// avatar + live waveform ring, connection-quality dots, glass badges, and
// glass icon buttons used by both the audio call screen and the video/
// meeting screen. Kept in one file because these pieces only make sense
// together (they share the same glass/gradient vocabulary) and nothing
// outside src/components/call needs them individually.
//
// Animation approach: plain core `Animated` (no react-native-reanimated —
// not an existing dependency, and none of this needs to survive a gesture
// running on the UI thread the way the profile-photo viewer's pinch/pan
// does) driving native-thread transforms/opacity wherever possible
// (useNativeDriver: true) so these stay smooth even while JS is busy with
// WebRTC signaling.

import { useEffect, useRef } from 'react';
import { View, Text, Pressable, StyleSheet, Image, Animated, Easing, AccessibilityInfo } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { callColors, callRadii, callMotion, qualityColor, type NetworkQuality } from '../../theme/callTheme';
import { initials, colorFromString } from '../../utils/avatar';

// ---------------- reduced motion ----------------
// One shared, synchronously-readable flag — every animated primitive below
// checks it before starting a LOOPING animation (breathing, ambient
// waveform, ring sweep). One-shot feedback (a button press spring, a
// connected/ended transition) still plays even with Reduce Motion on —
// that's not what Reduce Motion is for; it's the perpetual, purposeless
// motion (idle loops) that gets suppressed, matching Apple's own HIG
// guidance on the setting.
let reduceMotionEnabled = false;
AccessibilityInfo.isReduceMotionEnabled?.().then((v) => { reduceMotionEnabled = v; }).catch(() => {});
AccessibilityInfo.addEventListener?.('reduceMotionChanged', (v: boolean) => { reduceMotionEnabled = v; });
export function isReduceMotionEnabled() {
  return reduceMotionEnabled;
}

// ---------------- Avatar + live waveform ring ----------------

const BAR_COUNT = 10;

export function AnimatedAvatar({
  name,
  userId,
  avatarUrl,
  size = 128,
  breathing = false,
  audioLevel = null,
  ringColor,
}: {
  name: string;
  userId: string;
  avatarUrl?: string | null;
  size?: number;
  // Gentle idle scale pulse — used for ringing/connecting states, matches
  // the brief's "avatar should gently breathe while ringing."
  breathing?: boolean;
  // [0,1] real mic/remote level from callNetworkMonitor, or null when no
  // sample is available yet — the ring still animates ambiently in that
  // case (ambient, not frozen) rather than pretending to react to nothing.
  audioLevel?: number | null;
  ringColor?: string;
}) {
  const breathe = useRef(new Animated.Value(0)).current;
  const bars = useRef(Array.from({ length: BAR_COUNT }, () => new Animated.Value(0.28))).current;
  const ambientPhase = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!breathing || isReduceMotionEnabled()) {
      breathe.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breathe, { toValue: 1, duration: callMotion.breatheDuration, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(breathe, { toValue: 0, duration: callMotion.breatheDuration, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [breathing, breathe]);

  // Ambient fallback loop — a slow phase drift used to derive each bar's
  // idle height when there's no real audioLevel sample yet, so the ring
  // never just sits dead flat before the first stats tick lands.
  useEffect(() => {
    if (isReduceMotionEnabled()) return;
    const loop = Animated.loop(
      Animated.timing(ambientPhase, { toValue: 1, duration: 3400, easing: Easing.linear, useNativeDriver: false })
    );
    loop.start();
    return () => loop.stop();
  }, [ambientPhase]);

  // Whenever a real audioLevel sample arrives, spring each bar toward a
  // level-derived target with a small per-bar phase offset — reads as a
  // live equalizer, not a single pulsing blob.
  useEffect(() => {
    bars.forEach((bar, i) => {
      const phase = i / BAR_COUNT;
      let target: number;
      if (audioLevel === null) {
        target = 0.24 + 0.1 * Math.abs(Math.sin(phase * Math.PI * 2));
      } else {
        target = 0.22 + Math.min(1, audioLevel * 2.2) * (0.55 + 0.35 * Math.sin(phase * Math.PI * 2 + Date.now() / 500));
        target = Math.max(0.16, Math.min(1, target));
      }
      Animated.spring(bar, { toValue: target, useNativeDriver: false, ...callMotion.springGentle }).start();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioLevel]);

  const color = colorFromString(userId || name, callColors.ice, callColors.fire);
  const scale = breathe.interpolate({ inputRange: [0, 1], outputRange: [1, 1.045] });
  const ringSize = size * 1.34;
  const barColor = ringColor || callColors.ice;

  return (
    <View style={{ width: ringSize, height: ringSize, alignItems: 'center', justifyContent: 'center' }}>
      {/* Waveform ring — bars placed radially, each an independently
          animated rounded rect rotated to point outward. */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        {bars.map((bar, i) => {
          const angle = (i / BAR_COUNT) * 360;
          const barLength = ringSize / 2 - size / 2 - 4;
          return (
            <View
              key={i}
              style={{
                position: 'absolute',
                left: ringSize / 2 - 2,
                top: ringSize / 2 - size / 2 + 2,
                width: 4,
                height: barLength,
                transform: [{ rotate: `${angle}deg` }],
              }}
            >
              <Animated.View
                style={{
                  width: 4,
                  height: barLength,
                  borderRadius: 2,
                  backgroundColor: barColor,
                  opacity: 0.85,
                  transform: [{ scaleY: bar }],
                }}
              />
            </View>
          );
        })}
      </View>

      <Animated.View style={{ width: size, height: size, borderRadius: size / 2, transform: [{ scale }], overflow: 'hidden' }}>
        {avatarUrl ? (
          <Image source={{ uri: avatarUrl }} style={{ width: size, height: size }} />
        ) : (
          <LinearGradient
            colors={[color, callColors.fire]}
            start={{ x: 0.15, y: 0.1 }}
            end={{ x: 0.9, y: 0.95 }}
            style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
          >
            <Text style={{ color: '#0a0d12', fontWeight: '800', fontSize: size * 0.34 }}>{initials(name)}</Text>
          </LinearGradient>
        )}
      </Animated.View>
    </View>
  );
}

// ---------------- Connection quality ----------------

export function ConnectionQualityDots({ quality, size = 3 }: { quality: NetworkQuality; size?: number }) {
  const bars = quality === 'unknown' ? 0 : { poor: 1, fair: 2, good: 3, excellent: 4 }[quality];
  const color = qualityColor(quality);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 2 }} accessible accessibilityLabel={`Connection quality: ${quality}`}>
      {[0, 1, 2, 3].map((i) => (
        <View
          key={i}
          style={{
            width: size,
            height: size * 1.6 + i * (size * 0.9),
            borderRadius: size / 2,
            backgroundColor: i < bars ? color : callColors.glassBrd,
          }}
        />
      ))}
    </View>
  );
}

// ---------------- Badges (HD / E2EE / Recording / Reconnecting) ----------------

export function GlassBadge({
  label,
  icon,
  tone = 'neutral',
  pulsing = false,
}: {
  label: string;
  icon?: string;
  tone?: 'neutral' | 'ok' | 'warn' | 'danger';
  pulsing?: boolean;
}) {
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!pulsing || isReduceMotionEnabled()) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.4, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulsing, pulse]);

  const toneColor = tone === 'ok' ? callColors.ok : tone === 'warn' ? callColors.warn : tone === 'danger' ? callColors.danger : callColors.textHi;

  return (
    <BlurView intensity={46} tint="dark" style={styles.badge}>
      {icon ? <Animated.Text style={{ fontSize: 10.5, opacity: pulsing ? pulse : 1 }}>{icon}</Animated.Text> : null}
      <Text style={[styles.badgeText, { color: toneColor }]}>{label}</Text>
    </BlurView>
  );
}

// ---------------- Glass icon button (dock cell) ----------------

export function GlassIconButton({
  icon,
  label,
  active = false,
  danger = false,
  disabled = false,
  onPress,
  size = 56,
  accessibilityHint,
}: {
  icon: string;
  label: string;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onPress?: () => void;
  size?: number;
  accessibilityHint?: string;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const press = () => {
    Animated.sequence([
      Animated.timing(scale, { toValue: 0.88, duration: 80, useNativeDriver: true }),
      Animated.spring(scale, { toValue: 1, useNativeDriver: true, ...callMotion.springSnappy }),
    ]).start();
    onPress?.();
  };

  const bg = danger ? callColors.danger : active ? callColors.glassHi : callColors.glass;

  return (
    <View style={{ alignItems: 'center', gap: 5, width: size + 10 }}>
      <Animated.View style={{ transform: [{ scale }] }}>
        <Pressable
          onPress={press}
          disabled={disabled}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ disabled, selected: active }}
          accessibilityHint={accessibilityHint}
          style={[
            styles.dockBtn,
            {
              width: size,
              height: size,
              borderRadius: callRadii.dockBtn,
              backgroundColor: bg,
              borderColor: danger ? 'transparent' : active ? callColors.glassBrdHi : callColors.glassBrd,
              opacity: disabled ? 0.35 : 1,
            },
          ]}
        >
          <Text style={{ fontSize: size * 0.4 }}>{icon}</Text>
        </Pressable>
      </Animated.View>
      <Text style={styles.dockLabel} numberOfLines={1}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: callRadii.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: callColors.glassBrd,
  },
  badgeText: { fontSize: 10.5, fontWeight: '700', letterSpacing: 0.3 },
  dockBtn: { alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  dockLabel: { fontSize: 10.5, color: callColors.textMid, fontWeight: '600' },
});
