// Profile tab's modal — ports index.html's "Your profile" overlay
// (index.html ~9500s "settingsProfileOverlay"/openProfileModal) enough to
// give the nav's new Profile tab somewhere real to go. Deliberately lighter
// than web's version: no role field (that's an HR/roster concept with no
// mobile editor yet) and no inline device-approval form — device trust
// already has a full, working implementation in app/(tabs)/settings.tsx
// (the "Approve a new device" section), so this links there instead of
// forking a second copy of that flow.

import { View, Text, Pressable, StyleSheet, Modal, Image } from 'react-native';
import { BlurView } from 'expo-blur';
import { router } from 'expo-router';
import { useSessionStore } from '../state/session';
import { useTheme } from '../hooks/useTheme';
import { initials, colorFromString } from '../utils/avatar';

export default function ProfileModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const theme = useTheme();
  const displayName = useSessionStore((s) => s.displayName);
  const avatarUrl = useSessionStore((s) => s.avatarUrl);
  const userId = useSessionStore((s) => s.userId);

  const goToDeviceSecurity = () => {
    onClose();
    router.push('/(tabs)/settings');
  };

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable onPress={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 360 }}>
          <BlurView
            intensity={50}
            tint={theme.scheme === 'dark' ? 'dark' : 'light'}
            style={[styles.card, { borderColor: theme.glassBrdHi }]}
          >
            <Text style={[styles.title, { color: theme.textHi }]}>Your profile</Text>

            {avatarUrl ? (
              <Image source={{ uri: avatarUrl }} style={styles.avatarImg} />
            ) : (
              <View style={[styles.avatarFallback, { backgroundColor: colorFromString(userId || '', theme.ice, theme.fire) }]}>
                <Text style={styles.avatarFallbackText}>{initials(displayName || '?')}</Text>
              </View>
            )}

            <Text style={[styles.name, { color: theme.textHi }]}>{displayName || 'You'}</Text>

            <Pressable
              onPress={goToDeviceSecurity}
              style={[styles.secBtn, { borderColor: theme.glassBrdHi, backgroundColor: theme.glass }]}
            >
              <Text style={{ color: theme.textHi, fontWeight: '600', fontSize: 14 }}>Devices &amp; security</Text>
              <Text style={{ color: theme.textLow, fontSize: 12, marginTop: 2 }}>
                Approve a new device, manage Face ID, and more — in Settings
              </Text>
            </Pressable>

            <Pressable onPress={onClose} style={styles.closeBtn}>
              <Text style={{ color: theme.textMid, fontWeight: '600' }}>Close</Text>
            </Pressable>
          </BlurView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { borderRadius: 24, borderWidth: 1, padding: 24, alignItems: 'center', overflow: 'hidden' },
  title: { fontSize: 17, fontWeight: '700', marginBottom: 16 },
  avatarImg: { width: 84, height: 84, borderRadius: 42, marginBottom: 12 },
  avatarFallback: { width: 84, height: 84, borderRadius: 42, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  avatarFallbackText: { color: '#0a0d12', fontWeight: '700', fontSize: 26 },
  name: { fontSize: 18, fontWeight: '700', marginBottom: 18 },
  secBtn: { width: '100%', borderWidth: 1, borderRadius: 16, padding: 14, marginBottom: 10 },
  closeBtn: { paddingVertical: 10, paddingHorizontal: 20 },
});
