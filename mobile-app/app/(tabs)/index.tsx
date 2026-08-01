import { useCallback, useMemo, useState } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, RefreshControl } from 'react-native';
import { useTheme } from '../../src/hooks/useTheme';
import { useSessionStore } from '../../src/state/session';
import type { ChatSummary } from '../../src/types';

function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('') || '?';
}

// Deterministic-ish color from a string, same idea as index.html's
// colorFor() helper — just enough so avatars aren't all one flat color.
function colorFromString(str: string, ice: string, fire: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return Math.abs(hash) % 2 === 0 ? ice : fire;
}

export default function ChatsScreen() {
  const theme = useTheme();
  const chats = useSessionStore((s) => s.chats);
  const summaries = useSessionStore((s) => s.summaries);
  const pinnedChatIds = useSessionStore((s) => s.pinnedChatIds);
  const refreshSession = useSessionStore((s) => s.refreshSession);
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refreshSession();
    setRefreshing(false);
  }, [refreshSession]);

  const sorted = useMemo(() => {
    const pinnedSet = new Set(pinnedChatIds);
    return [...chats].sort((a, b) => {
      const aPinned = pinnedSet.has(a.id) ? 1 : 0;
      const bPinned = pinnedSet.has(b.id) ? 1 : 0;
      if (aPinned !== bPinned) return bPinned - aPinned;
      return (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0);
    });
  }, [chats, pinnedChatIds]);

  const renderItem = useCallback(
    ({ item }: { item: ChatSummary }) => {
      const name = item.name || (item.type === 'dm' ? 'Direct message' : 'Group');
      const unread = summaries[item.id]?.unreadCount ?? 0;
      const avatarColor = colorFromString(item.id, theme.ice, theme.fire);
      return (
        <Pressable
          style={({ pressed }) => [styles.row, { borderBottomColor: theme.glassBrd, opacity: pressed ? 0.7 : 1 }]}
          // Chat detail screen (message thread, E2EE decrypt, live WS) is
          // Phase 2 — see mobile-app/README.md's roadmap. This scaffold
          // stops at the list.
        >
          <View style={[styles.avatar, { backgroundColor: avatarColor }]}>
            <Text style={styles.avatarText}>{initials(name)}</Text>
          </View>
          <View style={styles.rowBody}>
            <Text style={[styles.name, { color: theme.textHi }]} numberOfLines={1}>
              {name}
            </Text>
            <Text style={[styles.preview, { color: theme.textLow }]} numberOfLines={1}>
              {/* Messages are end-to-end encrypted server-side (see
                  worker.js's ChatRoom DO comments) — a plaintext preview
                  requires the on-device E2EE key work planned for Phase 2,
                  not yet implemented here. */}
              Encrypted message
            </Text>
          </View>
          {unread > 0 && (
            <View style={[styles.badge, { backgroundColor: theme.ice }]}>
              <Text style={styles.badgeText}>{unread > 99 ? '99+' : unread}</Text>
            </View>
          )}
        </Pressable>
      );
    },
    [summaries, theme]
  );

  return (
    <View style={[styles.container, { backgroundColor: theme.bg0 }]}>
      <FlatList
        data={sorted}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.ice} />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={{ color: theme.textMid, textAlign: 'center' }}>
              No chats yet. Start one from the web app for now — starting chats natively is coming in
              a later phase.
            </Text>
          </View>
        }
        contentContainerStyle={sorted.length === 0 ? styles.emptyContainer : undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1 },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#0a0d12', fontWeight: '700', fontSize: 14 },
  rowBody: { flex: 1, minWidth: 0 },
  name: { fontSize: 15, fontWeight: '600' },
  preview: { fontSize: 12.5, marginTop: 2 },
  badge: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: '#0a0d12', fontSize: 11, fontWeight: '700' },
  empty: { padding: 32 },
  emptyContainer: { flexGrow: 1, justifyContent: 'center' },
});
