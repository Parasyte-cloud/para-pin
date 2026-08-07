// Mirrors index.html's :root CSS custom properties (see para-pin/index.html
// lines ~41-68) so the native app reads as the same product, not a
// re-skin. Keep these two files in sync if the web palette changes.

export const colors = {
  dark: {
    ice: '#00d4ff',
    fire: '#ff6a00',
    bg0: '#050608',
    bg1: '#0a0d12',
    glass: 'rgba(255,255,255,0.055)',
    glassBrd: 'rgba(255,255,255,0.09)',
    glassBrdHi: 'rgba(255,255,255,0.18)',
    textHi: '#f2f5f7',
    textMid: '#9aa5ad',
    textLow: '#5f6a72',
    danger: '#ff6a6a',
    ok: '#7ee08a',
  },
  light: {
    ice: '#00a8d6',
    fire: '#e05e00',
    bg0: '#eef1f4',
    bg1: '#ffffff',
    glass: 'rgba(10,13,18,0.04)',
    glassBrd: 'rgba(10,13,18,0.10)',
    glassBrdHi: 'rgba(10,13,18,0.18)',
    textHi: '#12161b',
    textMid: '#5b6670',
    textLow: '#8b949c',
    danger: '#d64545',
    ok: '#2f9e4a',
  },
} as const;

// High-contrast alternates — not just "boost the numbers a bit", these use
// true black/white backgrounds+text and much more opaque borders so every
// text/background and border/background pair clears WCAG AA (4.5:1 for
// text) with real margin, which the default glass-on-glass palette above
// deliberately doesn't chase (translucent glass panels are inherently
// lower-contrast by design). Ice/fire accents are kept recognizable as the
// same brand colors but nudged for legibility against true black/white.
const highContrastDark = {
  ice: '#4fe0ff',
  fire: '#ff8a3d',
  bg0: '#000000',
  bg1: '#0a0a0a',
  glass: 'rgba(255,255,255,0.12)',
  glassBrd: 'rgba(255,255,255,0.45)',
  glassBrdHi: 'rgba(255,255,255,0.7)',
  textHi: '#ffffff',
  textMid: '#e6e9ec',
  textLow: '#c2c9cf',
  danger: '#ff8a8a',
  ok: '#8ef29c',
} as const;
const highContrastLight = {
  ice: '#006c8a',
  fire: '#a03e00',
  bg0: '#ffffff',
  bg1: '#ffffff',
  glass: 'rgba(10,13,18,0.08)',
  glassBrd: 'rgba(10,13,18,0.45)',
  glassBrdHi: 'rgba(10,13,18,0.7)',
  textHi: '#000000',
  textMid: '#22262b',
  textLow: '#3c4147',
  danger: '#a32020',
  ok: '#106b28',
} as const;
export const highContrastColors = { dark: highContrastDark, light: highContrastLight };

export type ThemeColors = Record<keyof typeof colors.dark, string>;

export const gradient = { ice: colors.dark.ice, fire: colors.dark.fire };

export const radii = {
  pill: 999,
  card: 16,
  input: 14,
};

export const spacing = (n: number) => n * 4;
