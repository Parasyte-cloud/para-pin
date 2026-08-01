import { useCallback, useMemo, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useTheme } from '../hooks/useTheme';

export const PIN_LENGTH = 7; // matches worker.js's /^\d{7}$/ PIN format (see index.html:3136)

const KEYPAD_ROWS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['', '0', 'back'],
];

interface PinKeypadProps {
  onComplete: (pin: string) => void;
  loading?: boolean;
  error?: string | null;
}

// Shared by app/(auth)/pin.tsx (fresh login/account creation) and
// app/(auth)/lock.tsx (biometric-fallback re-entry) so the two screens
// can't drift out of sync on what a "PIN" actually looks like.
export function PinKeypad({ onComplete, loading, error }: PinKeypadProps) {
  const theme = useTheme();
  const [digits, setDigits] = useState('');

  const dots = useMemo(() => Array.from({ length: PIN_LENGTH }, (_, i) => i < digits.length), [digits]);

  const onKey = useCallback(
    (key: string) => {
      if (loading || !key) return;
      if (key === 'back') {
        setDigits((d) => d.slice(0, -1));
        return;
      }
      setDigits((d) => {
        if (d.length >= PIN_LENGTH) return d;
        const next = d + key;
        if (next.length === PIN_LENGTH) {
          onComplete(next);
          return '';
        }
        return next;
      });
    },
    [loading, onComplete]
  );

  return (
    <View style={styles.wrap}>
      <View style={styles.dotsRow}>
        {dots.map((filled, i) => (
          <View
            key={i}
            style={[
              styles.dot,
              { borderColor: theme.glassBrdHi, backgroundColor: filled ? theme.ice : 'transparent' },
            ]}
          />
        ))}
      </View>

      {error ? <Text style={[styles.error, { color: theme.danger }]}>{error}</Text> : null}

      <View style={styles.keypad}>
        {KEYPAD_ROWS.map((row, ri) => (
          <View key={ri} style={styles.keypadRow}>
            {row.map((key, ki) => {
              if (!key) return <View key={ki} style={styles.key} />;
              const label = key === 'back' ? '⌫' : key;
              const isUtility = key === 'back';
              return (
                <Pressable
                  key={key}
                  onPress={() => onKey(key)}
                  disabled={loading}
                  style={({ pressed }) => [
                    styles.key,
                    { borderColor: theme.glassBrd, backgroundColor: theme.glass, opacity: pressed ? 0.6 : 1 },
                  ]}
                >
                  <Text
                    style={[
                      isUtility ? styles.keyLabelSmall : styles.keyLabel,
                      { color: isUtility ? theme.textMid : theme.textHi },
                    ]}
                  >
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: 20 },
  dotsRow: { flexDirection: 'row', gap: 12 },
  dot: { width: 12, height: 12, borderRadius: 6, borderWidth: 1 },
  error: { fontSize: 12.5, textAlign: 'center', maxWidth: 300 },
  keypad: { gap: 14 },
  keypadRow: { flexDirection: 'row', gap: 14 },
  key: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyLabel: { fontSize: 24, fontWeight: '600' },
  keyLabelSmall: { fontSize: 13, fontWeight: '600' },
});
