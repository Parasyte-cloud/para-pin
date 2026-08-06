// Full-screen profile photo viewer — mirrors index.html's lightbox +
// openUserAvatarViewer (index.html ~3080-3200s) closely enough to behave
// the same way: show the already-cached public thumbnail immediately (if
// one was passed in), then try to upgrade to a signed, full-resolution
// copy from the private avatar tier via GET /api/profile/avatar-url, which
// runs canViewAvatar server-side and logs the access. If that's denied and
// there's no thumbnail to fall back to, this closes itself with an
// explanation rather than sitting on a blank frame.
//
// Pinch-to-zoom/pan/rotate uses react-native-gesture-handler's classic
// component API (PinchGestureHandler/PanGestureHandler/TapGestureHandler)
// driving plain Animated.Value instances directly — deliberately NOT
// react-native-reanimated (not an existing dependency here, and the
// classic handler + Animated.event combination is enough for a photo
// viewer that isn't also trying to stay perfectly smooth during a FlatList
// scroll). Gesture math (scale/translate accumulation, focal-point-free
// simple recentering) is intentionally simpler than a production photo app
// like Photos.app — good enough for "zoom in on someone's profile photo",
// not attempting pixel-perfect pinch-anchoring.
import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Modal, Image, Animated, ActivityIndicator } from 'react-native';
import {
  PinchGestureHandler,
  PanGestureHandler,
  TapGestureHandler,
  State,
  type PinchGestureHandlerStateChangeEvent,
  type PanGestureHandlerStateChangeEvent,
  type TapGestureHandlerStateChangeEvent,
} from 'react-native-gesture-handler';
import { useTheme } from '../hooks/useTheme';
import { apiFetch } from '../api/client';
import { useAvatarScreenCapture } from '../hooks/useAvatarScreenCapture';

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;

export interface AvatarViewerProps {
  visible: boolean;
  onClose: () => void;
  userId: string | null;
  name: string;
  thumbUrl?: string | null;
  orgId?: string | null;
  // When provided (profile photo HISTORY entries — see the Settings
  // screen's history list), this is already a fully-resolved signed URL
  // for one specific past photo and the /profile/avatar-url upgrade fetch
  // below is skipped entirely — there's nothing to "upgrade" to, the
  // history endpoint already minted the highest-resolution signed URL it
  // has for that exact entry.
  directUri?: string | null;
}

export default function AvatarViewer({ visible, onClose, userId, name, thumbUrl, orgId, directUri }: AvatarViewerProps) {
  const theme = useTheme();
  const [uri, setUri] = useState<string | null>(directUri || thumbUrl || null);
  const [upgrading, setUpgrading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  // Scoped to exactly this screen being mounted+visible — see the hook's
  // own header comment for the Android-blocks/iOS-detects-only reasoning.
  useAvatarScreenCapture(visible ? userId : null);

  // ---- gesture-driven transform state ----
  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const rotateDeg = useRef(new Animated.Value(0)).current;
  const lastScaleRef = useRef(1);
  const lastTranslateXRef = useRef(0);
  const lastTranslateYRef = useRef(0);
  const lastRotationRef = useRef(0);
  const pinchRef = useRef(null);
  const panRef = useRef(null);
  const doubleTapRef = useRef(null);

  const resetTransform = useCallback(() => {
    lastScaleRef.current = 1;
    lastTranslateXRef.current = 0;
    lastTranslateYRef.current = 0;
    lastRotationRef.current = 0;
    scale.setValue(1);
    translateX.setValue(0);
    translateY.setValue(0);
    rotateDeg.setValue(0);
  }, [scale, translateX, translateY, rotateDeg]);

  // Reset + reload every time this opens on a (possibly different) person.
  useEffect(() => {
    if (!visible) return;
    resetTransform();
    setErrorText(null);
    setUri(directUri || thumbUrl || null);
    if (directUri || !userId) return;
    setUpgrading(true);
    apiFetch<{ url?: string; error?: string }>(
      `/profile/avatar-url?userId=${encodeURIComponent(userId)}${orgId ? `&orgId=${encodeURIComponent(orgId)}` : ''}`
    )
      .then((r) => {
        if (r.ok && r.body.url) {
          setUri(r.body.url);
        } else if (!thumbUrl) {
          setErrorText(r.body?.error === 'not_authorized' ? "This person's profile photo isn't visible to you." : 'No profile photo to show.');
        }
      })
      .catch(() => {
        if (!thumbUrl) setErrorText("Couldn't load this photo. Try again.");
      })
      .finally(() => setUpgrading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, userId, orgId]);

  const onPinchEvent = Animated.event([{ nativeEvent: { scale } }], { useNativeDriver: true });
  const onPinchStateChange = useCallback(
    (event: PinchGestureHandlerStateChangeEvent) => {
      if (event.nativeEvent.oldState === State.ACTIVE) {
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, lastScaleRef.current * event.nativeEvent.scale));
        lastScaleRef.current = next;
        scale.setValue(next);
        if (next === MIN_SCALE) {
          lastTranslateXRef.current = 0;
          lastTranslateYRef.current = 0;
          Animated.parallel([
            Animated.spring(translateX, { toValue: 0, useNativeDriver: true }),
            Animated.spring(translateY, { toValue: 0, useNativeDriver: true }),
          ]).start();
        }
      }
    },
    [scale, translateX, translateY]
  );

  const onPanEvent = Animated.event([{ nativeEvent: { translationX: translateX, translationY: translateY } }], {
    useNativeDriver: true,
    listener: () => {},
  });
  const onPanStateChange = useCallback(
    (event: PanGestureHandlerStateChangeEvent) => {
      if (event.nativeEvent.oldState === State.ACTIVE) {
        lastTranslateXRef.current += event.nativeEvent.translationX;
        lastTranslateYRef.current += event.nativeEvent.translationY;
        // translateX/Y Animated.Values were driven relative to the
        // gesture's own start (0) — fold that into the running total, then
        // reset the Animated.Value's "delta" back to 0 so the next drag
        // starts from the folded position instead of jumping.
        translateX.setOffset(lastTranslateXRef.current);
        translateX.setValue(0);
        translateY.setOffset(lastTranslateYRef.current);
        translateY.setValue(0);
      }
    },
    [translateX, translateY]
  );

  const toggleZoom = useCallback(() => {
    const zoomingIn = lastScaleRef.current <= MIN_SCALE;
    const target = zoomingIn ? DOUBLE_TAP_SCALE : MIN_SCALE;
    lastScaleRef.current = target;
    if (!zoomingIn) {
      lastTranslateXRef.current = 0;
      lastTranslateYRef.current = 0;
      translateX.flattenOffset();
      translateY.flattenOffset();
    }
    Animated.parallel([
      Animated.spring(scale, { toValue: target, useNativeDriver: true }),
      ...(zoomingIn
        ? []
        : [
            Animated.spring(translateX, { toValue: 0, useNativeDriver: true }),
            Animated.spring(translateY, { toValue: 0, useNativeDriver: true }),
          ]),
    ]).start();
  }, [scale, translateX, translateY]);

  const onDoubleTap = useCallback(
    (event: TapGestureHandlerStateChangeEvent) => {
      if (event.nativeEvent.state === State.ACTIVE) toggleZoom();
    },
    [toggleZoom]
  );

  const rotate = useCallback(() => {
    const next = (lastRotationRef.current + 90) % 360;
    lastRotationRef.current = next;
    Animated.timing(rotateDeg, { toValue: next, duration: 220, useNativeDriver: true }).start();
  }, [rotateDeg]);

  const rotateInterpolated = rotateDeg.interpolate({ inputRange: [0, 360], outputRange: ['0deg', '360deg'] });

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <TapGestureHandler ref={doubleTapRef} numberOfTaps={2} onHandlerStateChange={onDoubleTap}>
          <View style={StyleSheet.absoluteFill}>
            <PanGestureHandler
              ref={panRef}
              simultaneousHandlers={[pinchRef, doubleTapRef]}
              onGestureEvent={onPanEvent}
              onHandlerStateChange={onPanStateChange}
              minPointers={1}
              maxPointers={1}
            >
              <Animated.View style={StyleSheet.absoluteFill}>
                <PinchGestureHandler
                  ref={pinchRef}
                  simultaneousHandlers={[panRef, doubleTapRef]}
                  onGestureEvent={onPinchEvent}
                  onHandlerStateChange={onPinchStateChange}
                >
                  <Animated.View style={styles.imageWrap}>
                    {uri ? (
                      <Animated.Image
                        source={{ uri }}
                        style={[
                          styles.image,
                          {
                            transform: [
                              { translateX },
                              { translateY },
                              { scale },
                              { rotate: rotateInterpolated },
                            ],
                          },
                        ]}
                        resizeMode="contain"
                      />
                    ) : (
                      !errorText && <ActivityIndicator color={theme.ice} size="large" />
                    )}
                    {errorText && <Text style={styles.errorText}>{errorText}</Text>}
                  </Animated.View>
                </PinchGestureHandler>
              </Animated.View>
            </PanGestureHandler>
          </View>
        </TapGestureHandler>

        {upgrading && (
          <View style={styles.loadingBadge}>
            <ActivityIndicator color="#fff" size="small" />
            <Text style={styles.loadingBadgeText}>Loading full-resolution photo…</Text>
          </View>
        )}

        <View style={styles.topBar}>
          <Text style={styles.nameText} numberOfLines={1}>{name}</Text>
          <View style={styles.topBarActions}>
            <Pressable onPress={rotate} hitSlop={10} style={styles.iconBtn}>
              <Text style={{ fontSize: 16, color: '#fff' }}>⟳</Text>
            </Pressable>
            <Pressable onPress={onClose} hitSlop={10} style={styles.iconBtn}>
              <Text style={{ fontSize: 16, color: '#fff' }}>✕</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)' },
  imageWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  image: { width: '100%', height: '100%' },
  errorText: { color: '#fff', fontSize: 14.5, textAlign: 'center', paddingHorizontal: 32, opacity: 0.85 },
  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 54, paddingHorizontal: 16, paddingBottom: 10,
  },
  nameText: { color: '#fff', fontSize: 15, fontWeight: '700', flex: 1, marginRight: 12 },
  topBarActions: { flexDirection: 'row', gap: 8 },
  iconBtn: {
    width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(18,18,22,0.55)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)',
  },
  loadingBadge: {
    position: 'absolute', bottom: 40, alignSelf: 'center',
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(18,18,22,0.7)', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
  },
  loadingBadgeText: { color: '#fff', fontSize: 12.5 },
});
