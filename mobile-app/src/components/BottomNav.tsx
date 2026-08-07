// Liquid-glass floating bottom nav — ports index.html's #bottomNav exactly
// (index.html:1768-1803 markup, :277-477 CSS): Profile / Calls / seam /
// lock medallion / seam / Chats / Settings, five real stops around a fixed
// center medallion, plus the sliding "active pill" highlight capsule
// (index.html's .nav-active-pill/moveNavActivePill) instead of every tab
// carrying its own static highlight.
//
// This replaces the previous 3-tab version (Calls / medallion / Chats /
// Settings) — that was a deliberate scope-cut for not having a Profile
// screen yet. Profile now opens ProfileModal instead of a route, same
// non-navigating-tab pattern as the medallion itself (see index.html's own
// comment: "a fixed circle... whose own tap locks the app instead of
// switching tabs" — Profile here is the same idea, an action, not a route).
//
// No react-native-svg in this project (sandbox has no npm registry access
// to install it — see mobile-app/README.md's Phase 3 note for the same
// constraint on a different package), so index.html's inline SVG icons are
// approximated with glyphs here rather than ported 1:1.

import { useCallback, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Image, Animated, LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePathname, router } from 'expo-router';
import { BlurView } from 'expo-blur';
import { useSessionStore } from '../state/session';
import { useTheme } from '../hooks/useTheme';
import { initials, colorFromString } from '../utils/avatar';
import { toggleReachability, useReachabilityStore } from '../state/reachability';
import ProfileModal from './ProfileModal';

interface RouteTabDef {
  key: 'calls' | 'chats' | 'settings';
  href: '/(tabs)' | '/(tabs)/calls' | '/(tabs)/settings';
  label: string;
  icon: string;
  match: (path: string) => boolean;
}

const ROUTE_TABS: RouteTabDef[] = [
  { key: 'calls', href: '/(tabs)/calls', label: 'Calls', icon: '📞', match: (p) => p === '/calls' },
  { key: 'chats', href: '/(tabs)', label: 'Chats', icon: '💬', match: (p) => p === '/' || p === '' },
  { key: 'settings', href: '/(tabs)/settings', label: 'Settings', icon: '⚙️', match: (p) => p === '/settings' },
];

function Seam({ color }: { color: string }) {
  return <View style={[styles.seam, { backgroundColor: color }]} />;
}

export default function BottomNav() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const lockNow = useSessionStore((s) => s.lockNow);
  const displayName = useSessionStore((s) => s.displayName);
  const avatarUrl = useSessionStore((s) => s.avatarUrl);
  const userId = useSessionStore((s) => s.userId);
  const oneHandedModeEnabled = useSessionStore((s) => s.oneHandedModeEnabled);
  const reachabilityActive = useReachabilityStore((s) => s.active);
  const [profileOpen, setProfileOpen] = useState(false);

  // Sliding highlight capsule — same idea as index.html's
  // .nav-active-pill/moveNavActivePill: one shared glass capsule animates
  // its x/width to whichever tab is active instead of every tab carrying
  // its own always-on highlight. Layouts are captured per-tab via onLayout
  // since there's no upfront measurement API — RN only reports each
  // Pressable's box once it's actually laid out.
  const tabLayouts = useRef<Record<string, { x: number; width: number }>>({});
  const pillX = useRef(new Animated.Value(0)).current;
  const pillW = useRef(new Animated.Value(0)).current;
  const pillOpacity = useRef(new Animated.Value(0)).current;

  const activeKey = ROUTE_TABS.find((t) => t.match(pathname))?.key ?? null;

  const slideTo = useCallback(
    (key: string) => {
      const layout = tabLayouts.current[key];
      if (!layout) return;
      Animated.spring(pillX, { toValue: layout.x, useNativeDriver: false, bounciness: 6, speed: 16 }).start();
      Animated.spring(pillW, { toValue: layout.width, useNativeDriver: false, bounciness: 6, speed: 16 }).start();
      Animated.timing(pillOpacity, { toValue: 1, duration: 180, useNativeDriver: false }).start();
    },
    [pillX, pillW, pillOpacity]
  );

  const onTabLayout = useCallback(
    (key: string) => (e: LayoutChangeEvent) => {
      const { x, width } = e.nativeEvent.layout;
      tabLayouts.current[key] = { x, width };
      if (key === activeKey) slideTo(key);
    },
    [activeKey, slideTo]
  );

  const seamColor = theme.scheme === 'dark' ? 'rgba(255,255,255,0.22)' : 'rgba(10,13,18,0.14)';

  const renderRouteTab = (tab: RouteTabDef) => {
    const active = tab.key === activeKey;
    return (
      <Pressable key={tab.key} onPress={() => router.push(tab.href)} onLayout={onTabLayout(tab.key)} style={styles.tab} hitSlop={4}>
        <View style={[styles.tabIconWrap, active && { backgroundColor: `rgba(${theme.scheme === 'dark' ? '255,255,255' : '10,13,18'},0.12)` }]}>
          <Text style={[styles.tabIcon, { opacity: active ? 1 : 0.55, transform: [{ scale: active ? 1.12 : 1 }] }]}>{tab.icon}</Text>
        </View>
        <Text style={[styles.tabLabel, { color: active ? theme.ice : theme.textLow }]}>{tab.label}</Text>
      </Pressable>
    );
  };

  return (
    <>
      <View style={[styles.wrap, { bottom: Math.max(insets.bottom, 10) }]} pointerEvents="box-none">
        {/* Reachability handle — only takes up space when the person has
            actually turned One-handed mode on in Settings, so it costs
            nothing for everyone else. Tap toggles; see
            src/state/reachability.ts for what it actually shifts. */}
        {oneHandedModeEnabled && (
          <Pressable
            onPress={toggleReachability}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={reachabilityActive ? 'Move content back up' : 'Bring content within reach'}
            style={[
              styles.reachabilityHandle,
              {
                borderColor: theme.glassBrdHi,
                backgroundColor: theme.scheme === 'dark' ? 'rgba(30,33,40,0.5)' : 'rgba(255,255,255,0.65)',
              },
            ]}
          >
            <View style={[styles.reachabilityBar, { backgroundColor: reachabilityActive ? theme.ice : theme.textLow }]} />
          </Pressable>
        )}
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
            <Animated.View
              pointerEvents="none"
              style={[
                styles.activePill,
                {
                  transform: [{ translateX: pillX }],
                  width: pillW,
                  opacity: pillOpacity,
                  backgroundColor: theme.scheme === 'dark' ? 'rgba(0,212,255,0.16)' : 'rgba(0,168,214,0.14)',
                },
              ]}
            />

            {/* Profile: an avatar circle instead of an icon, tap opens
                ProfileModal — not a route, same non-navigating-tab pattern
                as the lock medallion below (and so never registers with
                onTabLayout/activeKey — it can't "be active" any more than
                the medallion can). */}
            <Pressable onPress={() => setProfileOpen(true)} style={styles.tab} hitSlop={4}>
              {avatarUrl ? (
                <Image source={{ uri: avatarUrl }} style={styles.profileAvatarImg} />
              ) : (
                <View style={[styles.profileAvatarFallback, { backgroundColor: colorFromString(userId || '', theme.ice, theme.fire) }]}>
                  <Text style={styles.profileAvatarText}>{initials(displayName || '?')}</Text>
                </View>
              )}
              <Text style={[styles.tabLabel, { color: theme.textLow }]}>Profile</Text>
            </Pressable>

            <Seam color={seamColor} />
            {renderRouteTab(ROUTE_TABS[0])}
            <Seam color={seamColor} />

            {/* Center medallion: flush in the row (no vertical pop-out —
                see index.html's own comment on .nav-lock-btn: "sits
                flush... so it still reads as a distinct raised badge
                against the glass" via its own chrome ring, not an
                offset). Fixed, never matched by the active-tab lookup
                above, tap locks the app instead of switching tabs. */}
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

            <Seam color={seamColor} />
            {renderRouteTab(ROUTE_TABS[1])}
            <Seam color={seamColor} />
            {renderRouteTab(ROUTE_TABS[2])}
          </BlurView>
        </View>
      </View>

      <ProfileModal visible={profileOpen} onClose={() => setProfileOpen(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 30 },
  reachabilityHandle: {
    width: 56,
    height: 22,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  reachabilityBar: { width: 30, height: 4, borderRadius: 2 },
  // Shadow properties live here, not on `pill` — see the comment above the
  // BlurView. `elevation` (Android's shadow mechanism) doesn't have this
  // overflow conflict, but keeping it here too so both platforms' shadow
  // config lives in one place.
  shadowWrap: {
    width: '94%',
    maxWidth: 460,
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
    width: '100%',
    borderWidth: 1.5,
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 6,
    overflow: 'hidden',
    position: 'relative',
  },
  activePill: {
    position: 'absolute',
    top: 4,
    bottom: 4,
    left: 0,
    borderRadius: 999,
    zIndex: 0,
  },
  seam: { alignSelf: 'center', width: 1, height: '55%', flexShrink: 0 },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2, paddingVertical: 4, zIndex: 1 },
  tabIconWrap: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  tabIcon: { fontSize: 15 },
  tabLabel: { fontSize: 9, fontWeight: '600' },
  profileAvatarImg: { width: 26, height: 26, borderRadius: 13, marginBottom: 1 },
  profileAvatarFallback: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', marginBottom: 1 },
  profileAvatarText: { color: '#0a0d12', fontWeight: '700', fontSize: 10 },
  medallion: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 2,
    zIndex: 1,
  },
  medallionImg: { width: 25, height: 25, borderRadius: 12.5 },
});
