import { useEffect } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { Slot, SplashScreen } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useSessionStore } from '../src/state/session';
import { useTheme } from '../src/hooks/useTheme';

// Held until hydrate() resolves (reads deviceId/pinHash from SecureStore,
// and if a pinHash exists, re-validates it against POST /session — see
// src/state/session.ts). Routing decisions (app/index.tsx and the two
// route groups' own guards) all depend on that being settled first.
SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  const isHydrated = useSessionStore((s) => s.isHydrated);
  const hydrate = useSessionStore((s) => s.hydrate);
  const theme = useTheme();

  useEffect(() => {
    hydrate().finally(() => {
      SplashScreen.hideAsync().catch(() => {});
    });
  }, [hydrate]);

  if (!isHydrated) {
    return (
      <View style={[styles.loading, { backgroundColor: theme.bg0 }]}>
        <ActivityIndicator color={theme.ice} size="large" />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />
        <Slot />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
