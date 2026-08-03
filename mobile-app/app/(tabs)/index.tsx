import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, RefreshControl, TextInput, Image, Animated, LayoutChangeEvent } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useTheme } from '../../src/hooks/useTheme';
import { useSessionStore } from '../../src/state/session';
import { initials, colorFromString } from '../../src/utils/avatar';
import { resolveNames, getCachedName } from '../../src/state/names';
import { resolvePreview, getCachedPreview } from '../../src/state/previews';
import { AuthBackdrop } from '../../src/components/AuthBackdrop';
import WorkspaceSwitcher from '../../src/components/WorkspaceSwitcher';
import MembersModal from '../../src/components/MembersModal';
import type { ChatSummary } from '../../src/types';

// Mirrors index.html's chatDisplayName() (index.html:4030-4034): a DM's
// `name` is always null server-side (worker.js never sets one) — the
// display name is the OTHER member's resolved profile name, not something
// the chat record carries itself. Only a group chat has a real `chat.name`.
function displayName(chat: ChatSummary, myUserId: string | null): string {
  if (chat.type === 'group') return chat.name || 'Group';
  const otherId = chat.memberIds?.find((id) => id !== myUserId);
  return (otherId && getCachedName(otherId)) || 'PArA PIN user';
}

// Chat-list filter pills — mirrors index.html's #chatFilterBar exactly
// (index.html:4266-4268's renderChatList filter switch), minus the
// "Archived" pill: web's Archived pulls from a separate on-demand
// /api/chats/archived cache that has no mobile equivalent (no archive
// feature built on mobile at all yet — this is a styling pass, not a new
// feature, so the pill isn't added just to sit empty). All/Unread/Groups/
// Pinned all read off state this screen already had (summaries,
// pinnedChatIds), nothing new is being invented here.
type ChatFilter = 'all' | 'unread' | 'groups' | 'pinned';
const FILTERS: { key: ChatFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'groups', label: 'Groups' },
  { key: 'pinned', label: 'Pinned' },
];

export default function ChatsScreen() {
  const theme = useTheme();
  const chats = useSessionStore((s) => s.chats);
  const summaries = useSessionStore((s) => s.summaries);
  const pinnedChatIds = useSessionStore((s) => s.pinnedChatIds);
  const refreshSession = useSessionStore((s) => s.refreshSession);
  const myUserId = useSessionStore((s) => s.userId);
  const activeOrgId = useSessionStore((s) => s.activeOrgId);
  const orgs = useSessionStore((s) => s.orgs);
  const [refreshing, setRefreshing] = useState(false);
  // Bumped after resolveNames() resolves — getCachedName() itself is a
  // synchronous, non-reactive Map read (see src/state/names.ts), so
  // nothing re-renders on its own once names come back without this.
  const [namesVersion, setNamesVersion] = useState(0);
  // Same pattern for decrypted preview text (src/state/previews.ts).
  const [previewsVersion, setPreviewsVersion] = useState(0);
  const [membersOpen, setMembersOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ChatFilter>('all');

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refreshSession();
    setRefreshing(false);
  }, [refreshSession]);

  // Same shape as web's ensureNamesLoaded() (index.html:4036-4052): collect
  // every OTHER member across all chats and resolve whatever isn't cached
  // yet in one batched /users call, re-run whenever the chat list itself
  // changes (new chat, membership change).
  useEffect(() => {
    const otherIds = new Set<string>();
    for (const c of chats) {
      if (c.type === 'group') continue;
      const otherId = c.memberIds?.find((id) => id !== myUserId);
      if (otherId) otherIds.add(otherId);
    }
    if (!otherIds.size) return;
    let cancelled = false;
    resolveNames([...otherIds]).then(() => {
      if (!cancelled) setNamesVersion((v) => v + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [chats, myUserId]);

  // Decrypts each chat's last message for the preview line — the data
  // (`summaries[id].lastMessage`) was already coming back from /session,
  // see types.ts's comment; this just decrypts and caches it per chat,
  // same idea as ensureNamesLoaded() above but for message content instead
  // of profile names. Each resolvePreview() call is itself a no-op once
  // cached (keyed by chatId+messageId), so re-running this on every
  // summaries change is cheap.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await Promise.all(chats.map((c) => resolvePreview(c, summaries[c.id]?.lastMessage, myUserId)));
      if (!cancelled) setPreviewsVersion((v) => v + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [chats, summaries, myUserId]);

  // Same filter/sort shape as web's renderChatList() (index.html:4259-
  // 4269): scope to the active workspace, pinned-first then most-recent,
  // then the active filter pill, then the search query against display
  // name — all client-side over data this screen already had.
  const sorted = useMemo(() => {
    const pinnedSet = new Set(pinnedChatIds);
    const scoped = chats.filter((c) => (c.orgId || null) === (activeOrgId || null));
    let list = [...scoped].sort((a, b) => {
      const aPinned = pinnedSet.has(a.id) ? 1 : 0;
      const bPinned = pinnedSet.has(b.id) ? 1 : 0;
      if (aPinned !== bPinned) return bPinned - aPinned;
      return (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0);
    });
    if (filter === 'unread') list = list.filter((c) => (summaries[c.id]?.unreadCount ?? 0) > 0);
    else if (filter === 'groups') list = list.filter((c) => c.type === 'group');
    else if (filter === 'pinned') list = list.filter((c) => pinnedSet.has(c.id));
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((c) => displayName(c, myUserId).toLowerCase().includes(q));
    return list;
  }, [chats, pinnedChatIds, activeOrgId, filter, query, summaries, myUserId]);

  const emptyMessage = useMemo(() => {
    if (query.trim()) return 'No chats match your search.';
    if (filter === 'unread') return 'No unread chats.';
    if (filter === 'groups') return 'No group chats yet.';
    if (filter === 'pinned') return 'No pinned chats yet — long-press a chat to pin it.';
    return activeOrgId
      ? `No chats in this workspace yet. Tap 👥 above to message someone from the workspace.`
      : "No chats yet. Personal DMs are still started from the web app for now — there's no contacts directory to start one from on mobile without an existing pairing.";
  }, [query, filter, activeOrgId]);

  // Sliding filter-pill highlight capsule — same technique as
  // BottomNav.tsx's own active-tab pill (which itself ports index.html's
  // .nav-active-pill/moveNavActivePill idea): one shared capsule animates
  // to whichever pill's measured layout is active, instead of every pill
  // carrying its own always-on highlight. Mirrors index.html's
  // .chat-filter-pill-highlight (index.html:667-673) exactly in spirit.
  const pillLayouts = useRef<Record<string, { x: number; width: number }>>({});
  const pillX = useRef(new Animated.Value(0)).current;
  const pillW = useRef(new Animated.Value(0)).current;
  const pillOpacity = useRef(new Animated.Value(0)).current;

  const slideFilterPillTo = useCallback(
    (key: string) => {
      const layout = pillLayouts.current[key];
      if (!layout) return;
      Animated.spring(pillX, { toValue: layout.x, useNativeDriver: false, bounciness: 6, speed: 18 }).start();
      Animated.spring(pillW, { toValue: layout.width, useNativeDriver: false, bounciness: 6, speed: 18 }).start();
      Animated.timing(pillOpacity, { toValue: 1, duration: 160, useNativeDriver: false }).start();
    },
    [pillX, pillW, pillOpacity]
  );

  const onFilterPillLayout = useCallback(
    (key: ChatFilter) => (e: LayoutChangeEvent) => {
      const { x, width } = e.nativeEvent.layout;
      pillLayouts.current[key] = { x, width };
      if (key === filter) slideFilterPillTo(key);
    },
    [filter, slideFilterPillTo]
  );

  const selectFilter = useCallback(
    (key: ChatFilter) => {
      setFilter(key);
      slideFilterPillTo(key);
    },
    [slideFilterPillTo]
  );

  const renderItem = useCallback(
    ({ item }: { item: ChatSummary }) => {
      const name = displayName(item, myUserId);
      const unread = summaries[item.id]?.unreadCount ?? 0;
      const lastMessage = summaries[item.id]?.lastMessage;
      const preview = getCachedPreview(item.id, lastMessage?.id) ?? (lastMessage ? 'Decrypting…' : 'No messages yet');
      const avatarColor = colorFromString(item.id, theme.ice, theme.fire);
      const isGroup = item.type === 'group';
      return (
        <Pressable
          onPress={() => router.push(`/chat/${item.id}`)}
          style={({ pressed }) => [
            styles.row,
            { backgroundColor: pressed ? theme.glassBrd : `rgba(${theme.scheme === 'dark' ? '255,255,255' : '10,13,18'},0.035)` },
          ]}
        >
          <View style={styles.avatarWrap}>
            <View style={[styles.avatar, { backgroundColor: avatarColor }]}>
              <Text style={styles.avatarText}>{initials(name)}</Text>
            </View>
            {/* Mirrors index.html's .avatar.group::after — a small 👥 badge
                pinned to the avatar's corner for group chats, same as web. */}
            {isGroup && (
              <View style={[styles.groupBadge, { backgroundColor: theme.bg1 }]}>
                <Text style={styles.groupBadgeText}>👥</Text>
              </View>
            )}
          </View>
          <View style={styles.rowBody}>
            <View style={styles.rowTop}>
              <Text style={[styles.name, { color: theme.textHi }]} numberOfLines={1}>
                {name}
              </Text>
            </View>
            <Text style={[styles.preview, { color: theme.textMid }]} numberOfLines={1}>
              {preview}
            </Text>
          </View>
          {unread > 0 && (
            <LinearGradient
              colors={[theme.ice, theme.fire]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.badge}
            >
              <Text style={styles.badgeText}>{unread > 99 ? '99+' : unread}</Text>
            </LinearGradient>
          )}
        </Pressable>
      );
    },
    // namesVersion isn't read directly in the body — displayName() reads
    // through getCachedName()'s module-level Map, not React state — but it
    // needs to be a dependency anyway so this callback identity changes
    // (and FlatList re-renders rows) once resolveNames() actually fills
    // that cache in. myUserId is a real dependency: which member counts as
    // "the other one" depends on it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [summaries, theme, myUserId, namesVersion, previewsVersion]
  );

  return (
    <AuthBackdrop>
      {/* Mirrors index.html's .sidebar-head (index.html:1601-1611): app
          icon + title/sub stack, head-actions pinned right. The "+ new
          chat"/"👥 new group" buttons web has here aren't ported — starting
          a new Personal DM or group from scratch is a web-only capability
          mobile never built (see README's own scope note on the empty-state
          text below); the workspace roster/message button mobile DOES have
          is kept, just restyled as a matching circular icon-btn. */}
      <View style={styles.head}>
        <Image source={require('../../assets/icon.png')} style={styles.appIcon} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[styles.title, { color: theme.textHi }]}>PArA</Text>
          <Text style={[styles.sub, { color: theme.textLow }]}>PIN-GATED · TEAM CHAT</Text>
        </View>
        {activeOrgId && (
          <Pressable
            onPress={() => setMembersOpen(true)}
            hitSlop={10}
            style={[styles.iconBtn, { backgroundColor: theme.glass, borderColor: theme.glassBrd }]}
          >
            <Text style={{ fontSize: 15 }}>👥</Text>
          </Pressable>
        )}
      </View>

      {/* Only shows the switcher once there's actually somewhere to switch
          to — a user in zero workspaces sees the plain chat list, same as
          web hiding the workspace bar for a personal-only account. */}
      {orgs.length > 0 && <WorkspaceSwitcher />}
      <MembersModal visible={membersOpen} onClose={() => setMembersOpen(false)} />

      {/* Mirrors index.html's .search (index.html:641-647) — a plain
          client-side filter over chatDisplayName(), same as
          renderChatList()'s `q` handling; no new backend capability, just
          filtering data this screen already fetches. */}
      <View style={styles.searchWrap}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search chats..."
          placeholderTextColor={theme.textLow}
          style={[styles.searchInput, { color: theme.textHi, backgroundColor: theme.scheme === 'dark' ? 'rgba(255,255,255,0.03)' : 'rgba(10,13,18,0.03)', borderColor: theme.glassBrd }]}
        />
      </View>

      {/* Mirrors index.html's #chatFilterBar (index.html:652-679) — sliding
          highlight capsule behind whichever pill is active. */}
      <View style={[styles.filterBar, { backgroundColor: theme.glass, borderColor: theme.glassBrd }]}>
        <Animated.View
          pointerEvents="none"
          style={[
            styles.filterPillHighlight,
            {
              transform: [{ translateX: pillX }],
              width: pillW,
              opacity: pillOpacity,
              backgroundColor: theme.scheme === 'dark' ? 'rgba(255,255,255,0.16)' : 'rgba(10,13,18,0.1)',
            },
          ]}
        />
        {FILTERS.map((f) => (
          <Pressable key={f.key} onPress={() => selectFilter(f.key)} onLayout={onFilterPillLayout(f.key)} style={styles.filterPill}>
            <Text style={[styles.filterPillText, { color: filter === f.key ? theme.textHi : theme.textMid }]}>{f.label}</Text>
          </Pressable>
        ))}
      </View>

      <FlatList
        data={sorted}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        extraData={`${namesVersion}:${previewsVersion}`}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.ice} />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={{ color: theme.textMid, textAlign: 'center' }}>{emptyMessage}</Text>
          </View>
        }
        contentContainerStyle={sorted.length === 0 ? styles.emptyContainer : styles.listContent}
        style={{ flex: 1 }}
      />
    </AuthBackdrop>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18, paddingTop: 14, paddingBottom: 8 },
  appIcon: { width: 30, height: 30, borderRadius: 8 },
  title: { fontSize: 19, fontWeight: '700', letterSpacing: 0.6 },
  sub: { fontSize: 10, letterSpacing: 1.2, marginTop: 1 },
  iconBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  searchWrap: { marginHorizontal: 16, marginTop: 10, marginBottom: 8 },
  searchInput: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 16, paddingVertical: 10, fontSize: 13 },
  // Five pills in web, four here (no Archived — see FILTERS comment above);
  // horizontal scroll kept anyway since Groups/Pinned can still get tight
  // on a narrow phone with large text settings.
  filterBar: {
    position: 'relative',
    flexDirection: 'row',
    gap: 4,
    marginHorizontal: 16,
    marginBottom: 10,
    padding: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  filterPillHighlight: { position: 'absolute', top: 4, bottom: 4, left: 0, borderRadius: 999 },
  filterPill: { flex: 1, paddingVertical: 7, borderRadius: 999, alignItems: 'center', zIndex: 1 },
  filterPillText: { fontSize: 12, fontWeight: '600' },
  // Pill-style rows (borderRadius 999, no divider lines) — mirrors
  // index.html's .chat-item exactly instead of the previous flat
  // bordered-list-row look.
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 9, borderRadius: 999, marginHorizontal: 8, marginBottom: 4 },
  avatarWrap: { position: 'relative' },
  avatar: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#0a0d12', fontWeight: '700', fontSize: 13 },
  groupBadge: { position: 'absolute', bottom: -3, right: -3, width: 15, height: 15, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  groupBadgeText: { fontSize: 9 },
  rowBody: { flex: 1, minWidth: 0 },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 },
  name: { fontSize: 14, fontWeight: '600' },
  preview: { fontSize: 12.5, marginTop: 2 },
  badge: { minWidth: 19, height: 19, borderRadius: 10, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: '#0a0d12', fontSize: 10.5, fontWeight: '700' },
  empty: { padding: 32 },
  // 100px clears the floating BottomNav pill (see app/(tabs)/_layout.tsx)
  // so the last row in the list isn't hidden underneath it — the default
  // native tab bar used to reserve this space automatically; a
  // floating/absolute nav doesn't, so screens have to leave room for it
  // themselves.
  listContent: { paddingBottom: 100, paddingTop: 2 },
  emptyContainer: { flexGrow: 1, justifyContent: 'center', paddingBottom: 100 },
});
