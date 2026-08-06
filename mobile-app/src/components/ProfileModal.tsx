// Profile tab's modal — ports index.html's "Your profile" overlay
// (index.html ~9500s "settingsProfileOverlay"/openProfileModal) enough to
// give the nav's new Profile tab somewhere real to go. Deliberately lighter
// than web's version: no role/department field (that's an HR/roster
// concept, out of scope here) and no inline device-approval form — device
// trust already has a full, working implementation in
// app/(tabs)/settings.tsx (the "Approve a new device" section), so this
// links there instead of forking a second copy of that flow.
//
// Editing (name + photo) mirrors index.html's profileSaveBtn flow exactly:
// pick/compress an image client-side, upload it PLAIN (not E2EE — see
// utils/profilePhotoUpload.ts's header comment for why), then POST
// /api/profile with the resulting URL and the new display name together.

import { useState } from 'react';
import { View, Text, Pressable, StyleSheet, Modal, Image, TextInput, ActivityIndicator, Alert } from 'react-native';
import { BlurView } from 'expo-blur';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { useSessionStore } from '../state/session';
import { useTheme } from '../hooks/useTheme';
import { initials, colorFromString } from '../utils/avatar';
import { uploadProfilePhoto, uploadPrivateAvatarPhoto, ProfilePhotoUploadError } from '../utils/profilePhotoUpload';
import AvatarViewer from './AvatarViewer';

export default function ProfileModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const theme = useTheme();
  const displayName = useSessionStore((s) => s.displayName);
  const avatarUrl = useSessionStore((s) => s.avatarUrl);
  const userId = useSessionStore((s) => s.userId);
  const updateProfile = useSessionStore((s) => s.updateProfile);

  const [editing, setEditing] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [pendingPhotoUri, setPendingPhotoUri] = useState<string | null>(null);
  const [pendingPhotoMime, setPendingPhotoMime] = useState('image/jpeg');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);

  const goToDeviceSecurity = () => {
    onClose();
    router.push('/(tabs)/settings');
  };

  const startEditing = () => {
    setNameInput(displayName || '');
    setPendingPhotoUri(null);
    setError(null);
    setEditing(true);
  };

  const cancelEditing = () => {
    setEditing(false);
    setPendingPhotoUri(null);
    setError(null);
  };

  const pickPhoto = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setError('Photo library access is needed to change your profile photo.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.8,
      allowsEditing: true,
      aspect: [1, 1],
    });
    if (result.canceled || !result.assets?.[0]) return;
    setPendingPhotoUri(result.assets[0].uri);
    setPendingPhotoMime(result.assets[0].mimeType || 'image/jpeg');
    setError(null);
  };

  const save = async () => {
    if (!nameInput.trim()) {
      setError('Enter a display name.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      let newAvatarUrl: string | undefined;
      let newAvatarMediaKey: string | undefined;
      if (pendingPhotoUri) {
        newAvatarUrl = await uploadProfilePhoto(pendingPhotoUri, pendingPhotoMime);
        // Private-tier upload is additive — if it fails, the save still
        // proceeds with just the public thumbnail (see
        // profilePhotoUpload.ts's header comment). newAvatarMediaKey stays
        // undefined in that case, which updateProfile treats as "leave
        // whatever private-tier photo is already saved untouched".
        try {
          newAvatarMediaKey = await uploadPrivateAvatarPhoto(pendingPhotoUri, pendingPhotoMime);
        } catch {
          // swallow — see comment above
        }
      }
      const res = await updateProfile(nameInput, newAvatarUrl, newAvatarMediaKey);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setEditing(false);
      setPendingPhotoUri(null);
    } catch (e) {
      setError(e instanceof ProfilePhotoUploadError ? e.message : "Couldn't save your profile. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const shownAvatarUrl = pendingPhotoUri || avatarUrl;
  const shownName = editing ? nameInput || displayName || 'You' : displayName || 'You';

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      onRequestClose={() => {
        if (editing) cancelEditing();
        else onClose();
      }}
    >
      <Pressable
        style={styles.backdrop}
        onPress={() => {
          if (!saving) (editing ? cancelEditing() : onClose());
        }}
      >
        <Pressable onPress={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 360 }}>
          <BlurView
            intensity={50}
            tint={theme.scheme === 'dark' ? 'dark' : 'light'}
            style={[styles.card, { borderColor: theme.glassBrdHi }]}
          >
            <Text style={[styles.title, { color: theme.textHi }]}>Your profile</Text>

            <Pressable onPress={editing ? pickPhoto : () => shownAvatarUrl && setViewerOpen(true)} disabled={editing ? false : !shownAvatarUrl}>
              {shownAvatarUrl ? (
                <Image source={{ uri: shownAvatarUrl }} style={styles.avatarImg} />
              ) : (
                <View style={[styles.avatarFallback, { backgroundColor: colorFromString(userId || '', theme.ice, theme.fire) }]}>
                  <Text style={styles.avatarFallbackText}>{initials(shownName)}</Text>
                </View>
              )}
              {editing && (
                <View style={[styles.avatarEditBadge, { backgroundColor: theme.ice }]}>
                  <Text style={{ fontSize: 12 }}>📷</Text>
                </View>
              )}
            </Pressable>

            {editing ? (
              <TextInput
                value={nameInput}
                onChangeText={setNameInput}
                placeholder="Your name"
                placeholderTextColor={theme.textLow}
                maxLength={40}
                editable={!saving}
                style={[styles.nameInput, { color: theme.textHi, borderColor: theme.glassBrdHi, backgroundColor: theme.glass }]}
              />
            ) : (
              <Text style={[styles.name, { color: theme.textHi }]}>{shownName}</Text>
            )}

            {error && <Text style={{ color: theme.danger, fontSize: 12.5, marginBottom: 10, textAlign: 'center' }}>{error}</Text>}

            {editing ? (
              <View style={styles.editActions}>
                <Pressable onPress={cancelEditing} disabled={saving} style={[styles.editBtn, { backgroundColor: theme.glass, borderColor: theme.glassBrdHi }]}>
                  <Text style={{ color: theme.textMid, fontWeight: '600' }}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={save}
                  disabled={saving}
                  style={[styles.editBtn, { backgroundColor: theme.ice, opacity: saving ? 0.6 : 1 }]}
                >
                  {saving ? <ActivityIndicator color="#0a0d12" size="small" /> : <Text style={{ color: '#0a0d12', fontWeight: '700' }}>Save</Text>}
                </Pressable>
              </View>
            ) : (
              <Pressable
                onPress={startEditing}
                style={[styles.secBtn, { borderColor: theme.glassBrdHi, backgroundColor: theme.glass }]}
              >
                <Text style={{ color: theme.textHi, fontWeight: '600', fontSize: 14 }}>Edit name &amp; photo</Text>
              </Pressable>
            )}

            {!editing && (
              <Pressable
                onPress={goToDeviceSecurity}
                style={[styles.secBtn, { borderColor: theme.glassBrdHi, backgroundColor: theme.glass }]}
              >
                <Text style={{ color: theme.textHi, fontWeight: '600', fontSize: 14 }}>Devices &amp; security</Text>
                <Text style={{ color: theme.textLow, fontSize: 12, marginTop: 2 }}>
                  Approve a new device, manage Face ID, and more — in Settings
                </Text>
              </Pressable>
            )}

            {!editing && (
              <Pressable onPress={onClose} style={styles.closeBtn}>
                <Text style={{ color: theme.textMid, fontWeight: '600' }}>Close</Text>
              </Pressable>
            )}
          </BlurView>
        </Pressable>
      </Pressable>
      <AvatarViewer
        visible={viewerOpen}
        onClose={() => setViewerOpen(false)}
        userId={userId}
        name={shownName}
        thumbUrl={shownAvatarUrl}
      />
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  // 20px radius / 22px padding — matches web's .modal exactly
  // (index.html:1132: `border-radius:20px; padding:22px`), was 24/24.
  card: { borderRadius: 20, borderWidth: 1, padding: 22, alignItems: 'center', overflow: 'hidden' },
  title: { fontSize: 17, fontWeight: '700', marginBottom: 16 },
  avatarImg: { width: 84, height: 84, borderRadius: 42, marginBottom: 12 },
  avatarFallback: { width: 84, height: 84, borderRadius: 42, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  avatarFallbackText: { color: '#0a0d12', fontWeight: '700', fontSize: 26 },
  avatarEditBadge: {
    position: 'absolute',
    bottom: 10,
    right: -2,
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#0a0d12',
  },
  name: { fontSize: 18, fontWeight: '700', marginBottom: 18 },
  // Pill radius (999) matches web's `.modal input[type=text]` exactly
  // (index.html:1135-1137), was a boxy 12px corner.
  nameInput: { width: '100%', borderWidth: 1, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 11, fontSize: 15, textAlign: 'center', marginBottom: 14 },
  // Pill radius matches web's `.btn`/`.modal-actions` buttons
  // (index.html:1319, 999px), was 16px.
  secBtn: { width: '100%', borderWidth: 1, borderRadius: 999, padding: 14, marginBottom: 10 },
  editActions: { flexDirection: 'row', gap: 10, width: '100%', marginBottom: 10 },
  editBtn: { flex: 1, borderWidth: 1, borderRadius: 999, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  closeBtn: { paddingVertical: 10, paddingHorizontal: 20 },
});
