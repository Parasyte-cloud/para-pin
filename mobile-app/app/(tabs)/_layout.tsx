import { Redirect, Tabs } from 'expo-router';
import { View, StyleSheet, Animated } from 'react-native';
import { useSessionStore } from '../../src/state/session';
import { useTheme } from '../../src/hooks/useTheme';
import BottomNav from '../../src/components/BottomNav';
import { reachabilityY } from '../../src/state/reachability';

export default function TabsLayout() {
  const pinHash = useSessionStore((s) => s.pinHash);
  const isLocked = useSessionStore((s) => s.isLocked);
  const theme = useTheme();
  if (!pinHash) return <Redirect href="/(auth)/pin" />;
  if (isLocked) return <Redirect href="/(auth)/lock" />;

  return (
    <View style={styles.root}>
      {/* Reachability shift lives on this wrapper, not on <Tabs> directly —
          only the screen CONTENT moves down, BottomNav (rendered outside
          this Animated.View below) stays put since it's already within
          thumb reach by design. See src/state/reachability.ts. */}
      <Animated.View style={[styles.root, { transform: [{ translateY: reachabilityY }] }]}>
        <Tabs
          screenOptions={{
            headerStyle: { backgroundColor: theme.bg1 },
            headerTintColor: theme.textHi,
            // Default native tab bar is fully replaced by <BottomNav> below
            // (rendered as a floating sibling, same as web's
            // `.nav-wrap{position:fixed}` — see BottomNav.tsx) rather than
            // styled to look like it — a real liquid-glass pill + center
            // medallion isn't achievable through tabBarStyle alone.
            tabBarStyle: { display: 'none' },
          }}
        >
          <Tabs.Screen name="index" options={{ title: 'Chats' }} />
          <Tabs.Screen name="calls" options={{ title: 'Calls' }} />
          <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
        </Tabs>
      </Animated.View>
      <BottomNav />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
