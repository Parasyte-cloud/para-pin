// Personal/Workspace switcher — ports index.html's `.workspace-bar` pill +
// `#workspacesOverlay` modal (index.html:625-631, 1612-1626, 1945-1953).
// Mobile's `orgs: OrgSummary[]` and per-chat `orgId` were already coming
// back from /session (see src/types.ts's SessionResponse comment) but
// nothing consumed them until now — same "data was already there, just
// unused" shape as the chat-list preview-text fix.
//
// Switching sets useSessionStore's `activeOrgId`, which app/(tabs)/index.tsx
// uses to filter the chat list and app/(tabs)/calls.tsx uses to filter the
// call log, mirroring worker.js's `(c.orgId||null) === (activeOrgId||null)`
// pattern used throughout index.html.
//
// Scope note: this gives workspace chats and 1:1 workspace calls full
// parity with Personal. It deliberately does NOT add web's "Meeting Room"
// (group/SFU calls) — that's a separate backend subsystem
// (worker.js's /api/meeting/* routes, Cloudflare Calls SFU) with no mobile
// client code at all yet, not just a missing UI toggle. See README.

import { useState } from 'react';
import { View, Text, Pressable, Modal, StyleSheet, Image } from 'react-native';
import { BlurView } from 'expo-blur';
import { useSessionStore } from '../state/session';
import { useTheme } from '../hooks/useTheme';
import { initials, colorFromString } from '../utils/avatar';

export default function WorkspaceSwitcher() {
  const theme = useTheme();
  const orgs = useSessionStore((s) => s.orgs);
  const activeOrgId = useSessionStore((s) => s.activeOrgId);
  const setActiveOrgId = useSessionStore((s) => s.setActiveOrgId);
  const [open, setOpen] = useState(false);

  const activeOrg = activeOrgId ? orgs.find((o) => o.id === activeOrgId) : null;
  const label = activeOrg?.name || 'Personal';

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={[styles.bar, { backgroundColor: theme.glass, borderColor: theme.glassBrd }]}
      >
        {activeOrg?.logoUrl ? (
          <Image source={{ uri: activeOrg.logoUrl }} style={styles.logo} />
        ) : (
          <View style={[styles.logo, styles.logoFallback, { backgroundColor: colorFromString(activeOrg?.id || 'personal', theme.ice, theme.fire) }]}>
            <Text style={styles.logoFallbackText}>{activeOrg ? initials(activeOrg.name) : '👤'}</Text>
          </View>
        )}
        <Text style={[styles.label, { color: theme.textHi }]} numberOfLines={1}>
          {label}
        </Text>
        <Text style={[styles.chevron, { color: theme.textLow }]}>▾</Text>
      </Pressable>

      <Modal visible={open} animationType="fade" transparent onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.sheetWrap} onPress={() => {}}>
            <BlurView intensity={60} tint={theme.scheme === 'dark' ? 'dark' : 'light'} style={[styles.sheet, { borderColor: theme.glassBrdHi }]}>
              <Text style={[styles.sheetTitle, { color: theme.textHi }]}>Switch to</Text>

              <Pressable
                onPress={() => {
                  setActiveOrgId(null);
                  setOpen(false);
                }}
                style={[
                  styles.row,
                  { borderColor: theme.glassBrd },
                  !activeOrgId && { backgroundColor: 'rgba(0,212,255,0.08)', borderColor: 'rgba(0,212,255,0.25)' },
                ]}
              >
                <View style={[styles.rowLogo, styles.logoFallback, { backgroundColor: theme.glass }]}>
                  <Text style={{ fontSize: 16 }}>👤</Text>
                </View>
                <Text style={[styles.rowLabel, { color: theme.textHi }]}>Personal</Text>
                {!activeOrgId && <Text style={{ color: theme.ice, fontSize: 16 }}>✓</Text>}
              </Pressable>

              {orgs.map((org) => {
                const active = org.id === activeOrgId;
                return (
                  <Pressable
                    key={org.id || org.name}
                    onPress={() => {
                      if (org.id) setActiveOrgId(org.id);
                      setOpen(false);
                    }}
                    style={[
                      styles.row,
                      { borderColor: theme.glassBrd },
                      active && { backgroundColor: 'rgba(0,212,255,0.08)', borderColor: 'rgba(0,212,255,0.25)' },
                    ]}
                  >
                    {org.logoUrl ? (
                      <Image source={{ uri: org.logoUrl }} style={styles.rowLogo} />
                    ) : (
                      <View style={[styles.rowLogo, styles.logoFallback, { backgroundColor: colorFromString(org.id || org.name, theme.ice, theme.fire) }]}>
                        <Text style={styles.logoFallbackText}>{initials(org.name)}</Text>
                      </View>
                    )}
                    <Text style={[styles.rowLabel, { color: theme.textHi }]} numberOfLines={1}>
                      {org.name}
                    </Text>
                    {active && <Text style={{ color: theme.ice, fontSize: 16 }}>✓</Text>}
                  </Pressable>
                );
              })}

              <Pressable onPress={() => setOpen(false)} style={styles.closeBtn}>
                <Text style={{ color: theme.textLow, fontSize: 13, fontWeight: '600' }}>Close</Text>
              </Pressable>
            </BlurView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 10,
    marginBottom: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    borderWidth: 1,
  },
  logo: { width: 22, height: 22, borderRadius: 11 },
  logoFallback: { alignItems: 'center', justifyContent: 'center' },
  logoFallbackText: { fontSize: 11, fontWeight: '700', color: '#0a0d12' },
  label: { flex: 1, fontSize: 12.5, fontWeight: '700' },
  chevron: { fontSize: 12 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheetWrap: { paddingHorizontal: 14, paddingBottom: 34 },
  sheet: { borderRadius: 24, borderWidth: 1, padding: 14, gap: 8, overflow: 'hidden' },
  sheetTitle: { fontSize: 13, fontWeight: '700', marginBottom: 4, paddingHorizontal: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 11, borderRadius: 16, borderWidth: 1 },
  rowLogo: { width: 30, height: 30, borderRadius: 15 },
  rowLabel: { flex: 1, fontSize: 14, fontWeight: '600' },
  closeBtn: { alignItems: 'center', paddingVertical: 10, marginTop: 4 },
});
