// Ambient glow background shared by the PIN and lock screens — ports
// index.html's #bgfx (index.html:92-108): a near-black base with two large,
// soft-edged tinted circles (ice top-left, fire bottom-right) that give the
// whole app its signature teal-to-orange glow rather than a flat black
// screen. Web animates these drifting slowly via a CSS keyframe; skipped
// here (RN Animated looping on two huge blurred circles isn't worth the
// battery/perf cost for a background effect that's barely perceptible as
// motion at this scale) — static still reads as the same glow.
import type { ReactNode } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTheme } from '../hooks/useTheme';

export function AuthBackdrop({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={[styles.root, { backgroundColor: theme.bg0 }]}>
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <View style={[styles.glow, styles.glowIce, { backgroundColor: theme.ice }]} />
        <View style={[styles.glow, styles.glowFire, { backgroundColor: theme.fire }]} />
      </View>
      {children}
    </View>
  );
}

const GLOW_SIZE = 520;

const styles = StyleSheet.create({
  root: { flex: 1 },
  glow: { position: 'absolute', width: GLOW_SIZE, height: GLOW_SIZE, borderRadius: GLOW_SIZE / 2, opacity: 0.16 },
  glowIce: { top: -GLOW_SIZE * 0.35, left: -GLOW_SIZE * 0.3 },
  glowFire: { bottom: -GLOW_SIZE * 0.4, right: -GLOW_SIZE * 0.3 },
});
