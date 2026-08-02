// Workspace roster/contacts browsing — ports index.html's
// #workspaceMembersOverlay (index.html:2011-2088, populated by
// openWorkspaceMembers() around index.html:4679-4739) closely: fetch
// GET /api/org/members for the active workspace, list every member with a
// Message and Call quick action per row, same as web's msgBtn/callBtn
// (index.html:4709-4736). Message opens/creates the 1:1 DM via
// POST /api/org/member-dm — the SAME endpoint web uses — so this doubles
// as the missing "start a chat natively" entry point the chat list's own
// empty state currently points people at the web app for.
//
// Scope note, matching web itself, not a mobile gap: there's no
// personal-account contacts directory. A personal account's only
// "contacts" are whoever it already has a 1:1 chat with (paired via
// POST /api/contacts by exchanging a PIN hash, see worker.js) — web has
// no browsable list for that either, so this modal is workspace-only,
// same as the feature it's porting.

import { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Modal, FlatList, ActivityIndicator, Image } from 'react-native';
import { router } from 'expo-router';
import { useSessionStore } from '../state/session';
import { useCallStore } from '../state/call';
import { useTheme } from '../hooks/useTheme';
import { apiFetch } from '../api/client';
import { initials, colorFromString } from '../utils/avatar';

interface OrgMember {
  id: string;
  displayName?: string;
  avatarUrl?: string | null;
  isAdmin?: boolean;
}

export default function MembersModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const theme = useTheme();
  const activeOrgId = useSessionStore((s) => s.activeOrgId);
  const orgs = useSessionStore((s) => s.orgs);
  const myUserId = useSessionStore((s) => s.userId);
  const chats = useSessionStore((s) => s.chats);
  const startOutgoingCall = useCallStore((s) => s.startOutgoingCall);
  const inCall = useCallStore((s) => s.callState !== 'idle');

  const [members, setMembers] = useState<OrgMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const activeOrgName = orgs.find((o) => o.id === activeOrgId)?.name || 'Workspace';

  const load = useCallback(async () => {
    if (!activeOrgId) return;
    setLoading(true);
    setError(null);
    const r = await apiFetch<{ members?: OrgMember[] }>(`/org/members?orgId=${encodeURIComponent(activeOrgId)}`);
    setLoading(false);
    if (!r.ok || !r.body.members) {
      setError('Could not load members.');
      return;
    }
    setMembers(r.body.members);
  }, [activeOrgId]);

  useEffect(() => {
    if (visible) load();
  }, [visible, load]);

  const messageMember = useCallback(
    async (m: OrgMember) => {
      if (!activeOrgId || busyId) return;
      setBusyId(m.id);
      const r = await apiFetch<{ chat?: { id: string } }>('/org/member-dm', {
        method: 'POST',
        body: JSON.stringify({ orgId: activeOrgId, targetUserId: m.id }),
      });
      setBusyId(null);
      if (!r.ok || !r.body.chat) {
        setError("Couldn't open that chat. Try again.");
        return;
      }
      // The chat may not be in useSessionStore's `chats` yet (server just
      // created it this request) — chat/[id].tsx looks it up from that
      // list, so a stale cache would 404 the very screen we're about to
      // push. refreshSession() is the same full re-fetch every other
      // "state changed server-side, catch mobile up" action in this app
      // already uses (see settings.tsx's device-approval flow).
      if (!chats.some((c) => c.id === r.body.chat!.id)) {
        await useSessionStore.getState().refreshSession();
      }
      onClose();
      router.push(`/chat/${r.body.chat.id}`);
    },
    [activeOrgId, busyId, chats, onClose]
  );

  const callMember = useCallback(
    (m: OrgMember) => {
      if (inCall) return;
      onClose();
      startOutgoingCall(m.id, m.displayName || 'PArA PIN user', m.avatarUrl ?? null, false, activeOrgId);
    },
    [inCall, onClose, startOutgoingCall, activeOrgId]
  );

  const renderItem = useCallback(
    ({ item }: { item: OrgMember }) => {
      const name = item.displayName || 'PArA PIN user';
      const isMe = item.id === myUserId;
      return (
        <View style={[styles.row, { borderBottomColor: theme.glassBrd }]}>
          {item.avatarUrl ? (
            <Image source={{ uri: item.avatarUrl }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, styles.avatarFallback, { backgroundColor: colorFromString(item.id, theme.ice, theme.fire) }]}>
              <Text style={styles.avatarText}>{initials(name)}</Text>
            </View>
          )}
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[styles.name, { color: theme.textHi }]} numberOfLines={1}>
              {name}
              {isMe ? ' (you)' : ''}
              {item.isAdmin ? ' · Admin' : ''}
            </Text>
          </View>
          {!isMe && (
            <View style={styles.actions}>
              {busyId === item.id ? (
                <ActivityIndicator color={theme.ice} size="small" style={{ width: 30 }} />
              ) : (
                <Pressable onPress={() => messageMember(item)} hitSlop={8} style={[styles.actionBtn, { backgroundColor: theme.glass }]}>
                  <Text style={{ fontSize: 14 }}>💬</Text>
                </Pressable>
              )}
              <Pressable
                onPress={() => callMember(item)}
                disabled={inCall}
                hitSlop={8}
                style={[styles.actionBtn, { backgroundColor: theme.glass, opacity: inCall ? 0.4 : 1 }]}
              >
                <Text style={{ fontSize: 14 }}>📞</Text>
              </Pressable>
            </View>
          )}
        </View>
      );
    },
    [theme, myUserId, busyId, messageMember, callMember, inCall]
  );

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable onPress={(e) => e.stopPropagation()} style={styles.sheetWrap}>
          <View style={[styles.sheet, { backgroundColor: theme.bg1, borderColor: theme.glassBrdHi }]}>
            <View style={styles.header}>
              <Text style={[styles.title, { color: theme.textHi }]}>{activeOrgName} members</Text>
              <Pressable onPress={onClose} hitSlop={10}>
                <Text style={{ fontSize: 18, color: theme.textLow }}>✕</Text>
              </Pressable>
            </View>

            {loading ? (
              <ActivityIndicator color={theme.ice} style={{ marginTop: 30 }} />
            ) : error ? (
              <Text style={{ color: theme.danger, textAlign: 'center', marginTop: 20 }}>{error}</Text>
            ) : (
              <FlatList
                data={members}
                keyExtractor={(m) => m.id}
                renderItem={renderItem}
                style={styles.list}
                ListEmptyComponent={<Text style={{ color: theme.textMid, textAlign: 'center', marginTop: 20 }}>No members yet.</Text>}
              />
            )}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheetWrap: { paddingHorizontal: 0 },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, borderBottomWidth: 0, padding: 16, maxHeight: '75%', minHeight: 260 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  title: { fontSize: 16, fontWeight: '700' },
  list: { flexGrow: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  avatar: { width: 36, height: 36, borderRadius: 18 },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#0a0d12', fontWeight: '700', fontSize: 13 },
  name: { fontSize: 14.5, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: 8 },
  actionBtn: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
});
