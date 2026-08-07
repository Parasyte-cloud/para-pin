import { useColorScheme } from 'react-native';
import { colors, highContrastColors, type ThemeColors } from '../theme';
import { useSessionStore } from '../state/session';

export function useTheme(): ThemeColors & { scheme: 'light' | 'dark' } {
  const scheme = useColorScheme() === 'light' ? 'light' : 'dark';
  const highContrastEnabled = useSessionStore((s) => s.highContrastEnabled);
  const palette = highContrastEnabled ? highContrastColors[scheme] : colors[scheme];
  return { ...palette, scheme };
}
