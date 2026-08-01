import { Redirect, Tabs } from 'expo-router';
import { Text, type ColorValue } from 'react-native';
import { useSessionStore } from '../../src/state/session';
import { useTheme } from '../../src/hooks/useTheme';

function TabIcon({ symbol, color }: { symbol: string; color: ColorValue }) {
  return <Text style={{ fontSize: 20, color }}>{symbol}</Text>;
}

export default function TabsLayout() {
  const pinHash = useSessionStore((s) => s.pinHash);
  const isLocked = useSessionStore((s) => s.isLocked);
  const theme = useTheme();
  if (!pinHash) return <Redirect href="/(auth)/pin" />;
  if (isLocked) return <Redirect href="/(auth)/lock" />;

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: theme.bg1 },
        headerTintColor: theme.textHi,
        tabBarStyle: { backgroundColor: theme.bg1, borderTopColor: theme.glassBrd },
        tabBarActiveTintColor: theme.ice,
        tabBarInactiveTintColor: theme.textLow,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: 'Chats', tabBarIcon: ({ color }) => <TabIcon symbol="💬" color={color} /> }}
      />
      <Tabs.Screen
        name="calls"
        options={{ title: 'Calls', tabBarIcon: ({ color }) => <TabIcon symbol="📞" color={color} /> }}
      />
      <Tabs.Screen
        name="settings"
        options={{ title: 'Settings', tabBarIcon: ({ color }) => <TabIcon symbol="⚙️" color={color} /> }}
      />
    </Tabs>
  );
}
