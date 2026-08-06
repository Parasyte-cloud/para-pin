// Design language for the redesigned calling experience — deliberately its
// own module rather than folded into src/theme.ts, because a call screen is
// the one place in this app that goes full-bleed/immersive (dark scrim,
// large type, glass chrome over live video) regardless of the person's
// light/dark app-wide preference, the same way FaceTime, Zoom, and every
// other serious calling surface stays dark-chrome even inside a light-mode
// OS. It still derives its accent from the app's own ice/fire brand pair
// (src/theme.ts) rather than inventing a new palette, so a call reads as
// "PArA," not a bolted-on white-label SDK.
//
// Explicit non-goals, stated up front because the brief named them: this is
// not a FaceTime reskin, not a WhatsApp reskin, not a Telegram reskin. The
// concrete differences: (1) a warm ice→fire conic sweep instead of any
// single-hue system tint, used sparingly as a ring/accent rather than a
// background wash; (2) status communicated primarily through a persistent
// top capsule stack (badges + quality) rather than a single transient toast;
// (3) the control dock is one continuous glass pill that reflows its own
// contents by call type instead of a fixed grid of circles; (4) an audio
// call's entire canvas is alive (waveform + drifting aurora) rather than a
// static portrait behind a flat scrim.

import { colors } from '../theme';

export const callColors = {
  ice: colors.dark.ice,
  fire: colors.dark.fire,
  // Deep space canvas — near-black with a hint of blue, not pure #000
  // (pure black behind glass chrome reads as "broken/unrendered" rather
  // than "premium"; a hair of blue keeps it feeling like glass over depth).
  voidTop: '#04070c',
  voidBottom: '#0a0f18',
  glass: 'rgba(255,255,255,0.10)',
  glassHi: 'rgba(255,255,255,0.20)',
  glassBrd: 'rgba(255,255,255,0.16)',
  glassBrdHi: 'rgba(255,255,255,0.30)',
  textHi: '#f5f7f9',
  textMid: 'rgba(245,247,249,0.72)',
  textLow: 'rgba(245,247,249,0.46)',
  danger: '#ff5252',
  dangerHi: '#ff6f6f',
  ok: '#32e07a',
  warn: '#ffc247',
  // Quality tiers, used by both the animated dots and the numeric badge.
  qualityExcellent: '#32e07a',
  qualityGood: '#8fe073',
  qualityFair: '#ffc247',
  qualityPoor: '#ff6a52',
} as const;

export const callRadii = {
  dock: 40,
  dockBtn: 30,
  tile: 22,
  pill: 999,
  sheet: 28,
} as const;

export const callSpacing = (n: number) => n * 4;

// Motion — one small set of curves reused everywhere so every animation in
// this surface feels like it belongs to the same hand. `spring` values are
// tuned soft/heavy (Apple's own "gentle" preset family) rather than bouncy;
// premium reads as controlled, not springy.
export const callMotion = {
  springGentle: { damping: 18, stiffness: 180, mass: 0.9 },
  springSnappy: { damping: 16, stiffness: 260, mass: 0.7 },
  durationFast: 160,
  durationBase: 260,
  durationSlow: 420,
  // Breathing avatar / ambient waveform idle loop — slow enough to read as
  // "calm, alive," not "loading spinner."
  breatheDuration: 2600,
};

export function qualityColor(quality: NetworkQuality): string {
  switch (quality) {
    case 'excellent': return callColors.qualityExcellent;
    case 'good': return callColors.qualityGood;
    case 'fair': return callColors.qualityFair;
    case 'poor': return callColors.qualityPoor;
    default: return callColors.textLow;
  }
}

export type NetworkQuality = 'excellent' | 'good' | 'fair' | 'poor' | 'unknown';
