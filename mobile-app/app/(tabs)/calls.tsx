import { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, RefreshControl } from 'react-native';
import { apiFetch } from '../../src/api/client';
import { useTheme } from '../../src/hooks/useTheme';
import { useSessionStore } from '../../src/state/session';
import { useCallStore } from '../../src/state/call';
import { initials, colorFromString } from '../../src/utils/avatar';

// Mirrors worker.js's GET /api/calls/log response exactly (Registry DO's
// `/call-log` handler — see the `log.unshift({...})` shape in POST
// /call-log). Now scoped by the session store's activeOrgId, same
// Personal/Workspace split web already has (worker.js:2805-2806 filters
// server-side by the `?orgId=` query param this screen sends).
interface CallLogRow {
  id: string;
  withUserId: string;
  withName: string;
  withAvatarUrl: string | null;
  direction: 'incoming' | 'outgoing';
  outcome: 'answered' | 'missed' | 'declined' | 'busy';
  durationSec: number;
  isVideo: boolean;
  orgId: string | null;
  ts: number;
}

function formatWhen(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return time;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function CallsScreen() {
  const theme = useTheme();
  const [rows, setRows] = useState<CallLogRow[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const startOutgoingCall = useCallStore((s) => s.startOutgoingCall);
  const inCall = useCallStore((s) => s.callState !== 'idle');
  const activeOrgId = useSessionStore((s) => s.activeOrgId);

  const load = useCallback(async () => {
    const res = await apiFetch<{ log: CallLogRow[] }>(`/calls/log?orgId=${encodeURIComponent(activeOrgId || '')}`);
    if (res.ok) setRows(res.body.log || []);
    else if (rows === null) setRows([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOrgId]);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const callBack = useCallback(
    (row: CallLogRow, video: boolean) => {
      if (inCall) return;
      startOutgoingCall(row.withUserId, row.withName, row.withAvatarUrl, video, row.orgId ?? null);
    },
    [inCall, startOutgoingCall]
  );

  const renderItem = useCallback(
    ({ item }: { item: CallLogRow }) => {
      const avatarColor = colorFromString(item.withUserId, theme.ice, theme.fire);
      const missed = item.outcome === 'missed' || item.outcome === 'declined' || item.outcome === 'busy';
      const arrow = item.direction === 'outgoing' ? '↗' : '↙';
      const outcomeLabel =
        item.outcome === 'missed'
          ? 'Missed'
          : item.outcome === 'declined'
            ? 'Declined'
            : item.outcome === 'busy'
              ? 'Busy'
              : formatDuration(item.durationSec);
      return (
        <View style={[styles.row, { borderBottomColor: theme.glassBrd }]}>
          <View style={[styles.avatar, { backgroundColor: avatarColor }]}>
            <Text style={styles.avatarText}>{initials(item.withName)}</Text>
          </View>
          <View style={styles.rowBody}>
            <Text style={[styles.name, { color: theme.textHi }]} numberOfLines={1}>
              {item.withName}
            </Text>
            <Text style={[styles.meta, { color: missed ? theme.fire : theme.textLow }]} numberOfLines={1}>
              {arrow} {outcomeLabel} · {formatWhen(item.ts)}
            </Text>
          </View>
          <View style={styles.actions}>
            <Pressable
              onPress={() => callBack(item, false)}
              disabled={inCall}
              hitSlop={8}
              style={{ opacity: inCall ? 0.4 : 1 }}
            >
              <Text style={{ fontSize: 20 }}>📞</Text>
            </Pressable>
            <Pressable
              onPress={() => callBack(item, true)}
              disabled={inCall}
              hitSlop={8}
              style={{ opacity: inCall ? 0.4 : 1 }}
            >
              <Text style={{ fontSize: 20 }}>🎥</Text>
            </Pressable>
          </View>
        </View>
      );
    },
    [theme, inCall, callBack]
  );

  return (
    <View style={[styles.container, { backgroundColor: theme.bg0 }]}>
      <FlatList
        data={rows || []}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.ice} />}
        ListEmptyComponent={
          rows !== null ? (
            <View style={styles.empty}>
              <Text style={[styles.emptyTitle, { color: theme.textHi }]}>No calls yet</Text>
              <Text style={{ color: theme.textMid, textAlign: 'center', marginTop: 6 }}>
                Start a call from a direct message — it'll show up here once it ends.
              </Text>
            </View>
          ) : null
        }
        contentContainerStyle={!rows || rows.length === 0 ? styles.emptyContainer : undefined}
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
  meta: { fontSize: 12.5, marginTop: 2 },
  actions: { flexDirection: 'row', gap: 16 },
  empty: { padding: 32, alignItems: 'center' },
  emptyTitle: { fontSize: 16, fontWeight: '700' },
  emptyContainer: { flexGrow: 1, justifyContent: 'center' },
});
