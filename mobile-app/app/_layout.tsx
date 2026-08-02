// Must be the very first import in the app — polyfills global
// crypto.getRandomValues, which @noble/curves and @noble/hashes hard-
// require (they throw an explicit error otherwise) for key generation and
// IV/nonce generation. See src/crypto/e2ee.ts.
import 'react-native-get-random-values';
import { useEffect } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { Stack, SplashScreen } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useSessionStore } from '../src/state/session';
import { useTheme } from '../src/hooks/useTheme';
import { useNotifySocket } from '../src/hooks/useNotifySocket';
import { ensurePushRegistered } from '../src/state/push';
import CallOverlay from '../src/components/CallOverlay';

// Held until hydrate() resolves (reads deviceId/pinHash from SecureStore,
// and if a pinHash exists, re-validates it against POST /session — see
// src/state/session.ts). Routing decisions (app/index.tsx and the two
// route groups' own guards) all depend on that being settled first.
SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  const isHydrated = useSessionStore((s) => s.isHydrated);
  const hydrate = useSessionStore((s) => s.hydrate);
  const pinHash = useSessionStore((s) => s.pinHash);
  const isLocked = useSessionStore((s) => s.isLocked);
  const theme = useTheme();

  // Always-open notify socket for incoming call signals — mounted here,
  // once, for the whole authenticated session, not per-screen (see
  // useNotifySocket.ts). It no-ops internally while unauthenticated/locked.
  useNotifySocket();

  useEffect(() => {
    hydrate().finally(() => {
      SplashScreen.hideAsync().catch(() => {});
    });
  }, [hydrate]);

  // Registers this device for native push once actually signed in and
  // unlocked — same gating as useNotifySocket's `active` check, and
  // deliberately re-run on every unlock rather than once ever: a token can
  // rotate, and re-registering is idempotent and cheap (see push.ts).
  useEffect(() => {
    if (pinHash && !isLocked) ensurePushRegistered();
  }, [pinHash, isLocked]);

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
        {/* (auth) and (tabs) manage their own internal navigators
            (Stack/Tabs) and stay headerless; chat/[id] is the one screen
            that actually wants native push/back-button chrome, and sets
            its own title dynamically via <Stack.Screen options> inside
            itself. */}
        <Stack>
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="(auth)" options={{ headerShown: false }} />
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen
            name="chat/[id]"
            options={{
              headerStyle: { backgroundColor: theme.bg1 },
              headerTintColor: theme.textHi,
              headerBackTitle: 'Chats',
            }}
          />
        </Stack>
        {/* Sibling to the Stack, not inside any one screen — an incoming
            call needs to interrupt whatever route is currently active. */}
        <CallOverlay />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
