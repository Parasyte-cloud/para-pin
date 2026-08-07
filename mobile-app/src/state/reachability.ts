// One-handed / "Reachability" mode — a bare-bones version of iOS's own
// Reachability: temporarily shift the top-of-screen content down so it's
// within thumb range of someone holding the phone one-handed, without
// moving the already-reachable BottomNav itself. Deliberately NOT a
// PanResponder-driven drag (that needs careful gesture-conflict handling
// against every scrollable list/tab already in this app); a tap-to-toggle
// on a dedicated handle is simpler, discoverable, and just as functional.
//
// A plain module-level Animated.Value (not zustand state) on purpose —
// Animated.Value is itself already an observable the native driver reads
// directly; wrapping it in zustand would either lose the native-driver
// perf win or require re-creating the value on every store update. Only
// the boolean "is it currently active" needs to be reactive state (for the
// handle's own icon/label), so that part alone lives in a tiny store below.

import { Animated } from 'react-native';
import { create } from 'zustand';

export const reachabilityY = new Animated.Value(0);

// How far content shifts down. Fixed rather than computed from screen
// height — this only needs to bring the TOP of a tall list within reach,
// not center the whole screen, and a fixed value is what iOS's own
// Reachability effectively does too (roughly half the screen height on a
// typical phone, but the exact figure was never meant to be device-exact).
const SHIFT_DISTANCE = 220;
const AUTO_DISMISS_MS = 5000;

interface ReachabilityState {
  active: boolean;
}
export const useReachabilityStore = create<ReachabilityState>(() => ({ active: false }));

let dismissTimer: ReturnType<typeof setTimeout> | null = null;

function clearDismissTimer() {
  if (dismissTimer) {
    clearTimeout(dismissTimer);
    dismissTimer = null;
  }
}

export function dismissReachability() {
  clearDismissTimer();
  useReachabilityStore.setState({ active: false });
  Animated.spring(reachabilityY, { toValue: 0, useNativeDriver: true, bounciness: 4, speed: 18 }).start();
}

export function activateReachability() {
  useReachabilityStore.setState({ active: true });
  Animated.spring(reachabilityY, { toValue: SHIFT_DISTANCE, useNativeDriver: true, bounciness: 4, speed: 18 }).start();
  clearDismissTimer();
  // Auto-dismiss rather than staying shifted forever — someone who
  // triggers this, does what they needed near the top of the screen, and
  // moves on shouldn't have to remember it's still active and toggle it
  // back off themselves.
  dismissTimer = setTimeout(dismissReachability, AUTO_DISMISS_MS);
}

export function toggleReachability() {
  if (useReachabilityStore.getState().active) dismissReachability();
  else activateReachability();
}
