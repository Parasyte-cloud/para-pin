import { useColorScheme } from 'react-native';
import { colors, type ThemeColors } from '../theme';

export function useTheme(): ThemeColors & { scheme: 'light' | 'dark' } {
  const scheme = useColorScheme() === 'light' ? 'light' : 'dark';
  return { ...colors[scheme], scheme };
}
