// Liquid-glass floating bottom nav with a center lock medallion — ports
// index.html's `.nav-wrap`/`.nav-pill`/`.nav-tab` treatment
// (index.html:267-283, 452-484) and its center medallion
// (index.html:454-477): frosted glass capsule, active-tab tinted pill,
// a raised circular lock button in the middle that isn't a route at all
// (tapping it calls session.lockNow(), same as web's medallion).
//
// Scope note: web's nav has 5 real destinations (Profile, Calls, Chats,
// Settings) split 2-2 around the medallion — mobile only has 3 screens
// (no dedicated Profile screen exists yet, Settings already covers
// account info). Rather than invent a Profile screen that wasn't asked
// for, this renders Calls / medallion / Chats / Settings (1-2 split) —
// same glass/pill/medallion visual language, just three real tabs
// instead of four.
//
// Replaces expo-router's default tab bar entirely: app/(tabs)/_layout.tsx
// sets tabBarStyle:{display:'none'} and renders this as an absolutely
// positioned sibling instead, same as web's `.nav-wrap{position:fixed}`.

import { View, Text, Pressable, StyleSheet, Image } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePathname, router } from 'expo-router';
import { BlurView } from 'expo-blur';
import { useSessionStore } from '../state/session';
import { useTheme } from '../hooks/useTheme';

interface TabDef {
  key: string;
  href: '/(tabs)' | '/(tabs)/calls' | '/(tabs)/settings';
  label: string;
  icon: string;
  match: (path: string) => boolean;
}

const LEFT_TABS: TabDef[] = [
  { key: 'calls', href: '/(tabs)/calls', label: 'Calls', icon: '📞', match: (p) => p === '/calls' },
];

const RIGHT_TABS: TabDef[] = [
  { key: 'chats', href: '/(tabs)', label: 'Chats', icon: '💬', match: (p) => p === '/' || p === '' },
  { key: 'settings', href: '/(tabs)/settings', label: 'Settings', icon: '⚙️', match: (p) => p === '/settings' },
];

function NavTab({ tab, active, theme }: { tab: TabDef; active: boolean; theme: ReturnType<typeof useTheme> }) {
  return (
    <Pressable onPress={() => router.push(tab.href)} style={styles.tab} hitSlop={4}>
      <View style={[styles.tabIconWrap, active && { backgroundColor: `rgba(${theme.scheme === 'dark' ? '255,255,255' : '10,13,18'},0.12)` }]}>
        <Text style={[styles.tabIcon, { opacity: active ? 1 : 0.55, transform: [{ scale: active ? 1.12 : 1 }] }]}>{tab.icon}</Text>
      </View>
      <Text style={[styles.tabLabel, { color: active ? theme.ice : theme.textLow }]}>{tab.label}</Text>
    </Pressable>
  );
}

export default function BottomNav() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const lockNow = useSessionStore((s) => s.lockNow);

  return (
    <View style={[styles.wrap, { bottom: Math.max(insets.bottom, 10) }]} pointerEvents="box-none">
      {/* Shadow lives on this outer View, not the BlurView below — iOS
          silently drops a shadow on any layer that also has
          overflow:'hidden' (needed here to clip the blur to the pill
          shape), so the two have to be on separate Views or the drop
          shadow never renders at all. */}
      <View style={styles.shadowWrap}>
        <BlurView
          intensity={45}
          tint={theme.scheme === 'dark' ? 'dark' : 'light'}
          style={[
            styles.pill,
            {
              borderColor: theme.glassBrdHi,
              backgroundColor: theme.scheme === 'dark' ? 'rgba(30,33,40,0.36)' : 'rgba(255,255,255,0.5)',
            },
          ]}
        >
          {LEFT_TABS.map((tab) => (
            <NavTab key={tab.key} tab={tab} active={tab.match(pathname)} theme={theme} />
          ))}

          <Pressable
            onPress={lockNow}
            hitSlop={6}
            style={[
              styles.medallion,
              {
                borderColor: theme.glassBrdHi,
                backgroundColor: theme.scheme === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(10,13,18,0.05)',
              },
            ]}
          >
            <Image source={require('../../assets/lock-logo.png')} style={styles.medallionImg} resizeMode="cover" />
          </Pressable>

          {RIGHT_TABS.map((tab) => (
            <NavTab key={tab.key} tab={tab} active={tab.match(pathname)} theme={theme} />
          ))}
        </BlurView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 30 },
  // Shadow properties live here, not on `pill` — see the comment above the
  // BlurView. `elevation` (Android's shadow mechanism) doesn't have this
  // overflow conflict, but keeping it here too so both platforms' shadow
  // config lives in one place.
  shadowWrap: {
    width: '92%',
    maxWidth: 440,
    borderRadius: 999,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.32,
    shadowRadius: 26,
    elevation: 12,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    width: '100%',
    borderWidth: 1.5,
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 8,
    overflow: 'hidden',
  },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2, paddingVertical: 4 },
  tabIconWrap: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  tabIcon: { fontSize: 16 },
  tabLabel: { fontSize: 9, fontWeight: '600' },
  medallion: {
    width: 46,
    height: 46,
    borderRadius: 23,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 4,
  },
  medallionImg: { width: 27, height: 27, borderRadius: 13.5 },
});
