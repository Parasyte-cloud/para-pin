import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '../../src/hooks/useTheme';

// Calls (1:1 and meeting/SFU) need react-native-webrtc plus the two-tier
// signaling protocol MeetingRoom's WebSocket speaks (roster + track
// announce) — see mobile-app/README.md's Phase 3. Placeholder until then.
export default function CallsScreen() {
  const theme = useTheme();
  return (
    <View style={[styles.container, { backgroundColor: theme.bg0 }]}>
      <Text style={[styles.title, { color: theme.textHi }]}>Calls</Text>
      <Text style={[styles.body, { color: theme.textMid }]}>
        Audio and video calling are coming in a later phase — this needs native WebRTC, which isn’t
        wired up yet. Use the web app for calls in the meantime.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
  title: { fontSize: 18, fontWeight: '700' },
  body: { fontSize: 13, textAlign: 'center', lineHeight: 19 },
});
