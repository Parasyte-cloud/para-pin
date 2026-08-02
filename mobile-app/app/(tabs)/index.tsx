import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, RefreshControl } from 'react-native';
import { router } from 'expo-router';
import { useTheme } from '../../src/hooks/useTheme';
import { useSessionStore } from '../../src/state/session';
import { initials, colorFromString } from '../../src/utils/avatar';
import { resolveNames, getCachedName } from '../../src/state/names';
import { resolvePreview, getCachedPreview } from '../../src/state/previews';
import { AuthBackdrop } from '../../src/components/AuthBackdrop';
import WorkspaceSwitcher from '../../src/components/WorkspaceSwitcher';
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

  const sorted = useMemo(() => {
    const pinnedSet = new Set(pinnedChatIds);
    // Same scoping rule as worker.js/index.html everywhere else:
    // `(chat.orgId || null) === (activeOrgId || null)` — Personal is
    // `null` on both sides, a workspace is its org id on both sides.
    const scoped = chats.filter((c) => (c.orgId || null) === (activeOrgId || null));
    return [...scoped].sort((a, b) => {
      const aPinned = pinnedSet.has(a.id) ? 1 : 0;
      const bPinned = pinnedSet.has(b.id) ? 1 : 0;
      if (aPinned !== bPinned) return bPinned - aPinned;
      return (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0);
    });
  }, [chats, pinnedChatIds, activeOrgId]);

  const renderItem = useCallback(
    ({ item }: { item: ChatSummary }) => {
      const name = displayName(item, myUserId);
      const unread = summaries[item.id]?.unreadCount ?? 0;
      const lastMessage = summaries[item.id]?.lastMessage;
      const preview = getCachedPreview(item.id, lastMessage?.id) ?? (lastMessage ? 'Decrypting…' : 'No messages yet');
      const avatarColor = colorFromString(item.id, theme.ice, theme.fire);
      return (
        <Pressable
          onPress={() => router.push(`/chat/${item.id}`)}
          style={({ pressed }) => [styles.row, { borderBottomColor: theme.glassBrd, opacity: pressed ? 0.7 : 1 }]}
        >
          <View style={[styles.avatar, { backgroundColor: avatarColor }]}>
            <Text style={styles.avatarText}>{initials(name)}</Text>
          </View>
          <View style={styles.rowBody}>
            <Text style={[styles.name, { color: theme.textHi }]} numberOfLines={1}>
              {name}
            </Text>
            <Text style={[styles.preview, { color: theme.textLow }]} numberOfLines={1}>
              {preview}
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
    // namesVersion isn't read directly in the body — displayName() reads
    // through getCachedName()'s module-level Map, not React state — but it
    // needs to be a dependency anyway so this callback identity changes
    // (and FlatList re-renders rows) once resolveNames() actually fills
    // that cache in. myUserId is a real dependency: which member counts as
    // "the other one" depends on it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [summaries, theme, myUserId, namesVersion, previewsVersion]
  );

  const activeOrgName = activeOrgId ? orgs.find((o) => o.id === activeOrgId)?.name || 'this workspace' : null;

  return (
    <AuthBackdrop>
      {/* Only shows the switcher once there's actually somewhere to switch
          to — a user in zero workspaces sees the plain chat list, same as
          web hiding the workspace bar for a personal-only account. */}
      {orgs.length > 0 && <WorkspaceSwitcher />}
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
            <Text style={{ color: theme.textMid, textAlign: 'center' }}>
              {activeOrgName
                ? `No chats in ${activeOrgName} yet. Start one from the web app for now — starting chats natively is coming in a later phase.`
                : 'No chats yet. Start one from the web app for now — starting chats natively is coming in a later phase.'}
            </Text>
          </View>
        }
        contentContainerStyle={sorted.length === 0 ? styles.emptyContainer : undefined}
        style={{ flex: 1 }}
      />
    </AuthBackdrop>
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
