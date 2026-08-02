// Native push registration — Phase 4. Deliberately does NOT use Expo's own
// push-notification relay service (Notifications.getExpoPushTokenAsync());
// getDevicePushTokenAsync() below returns the raw APNs device token (iOS)
// or FCM registration token (Android) instead, so worker.js really does
// dual-send straight to Apple/Google (see its sendApnsPush/sendFcmPush),
// with nothing extra in the delivery path.
//
// Requires a custom dev client (same requirement Phase 3's
// react-native-webrtc already introduced) — this native module isn't part
// of Expo Go's fixed module set either.

import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { apiFetch } from '../api/client';

// Foreground behavior: still show an alert/sound even while the app is
// open, matching how the web app's own in-app toast + ding work — a
// message you're not currently looking at (different chat, or the app
// backgrounded a moment later) shouldn't go silent just because a socket
// happens to be connected.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export type PushRegisterResult =
  | { ok: true }
  | { ok: false; reason: 'unsupported_platform' | 'permission_denied' | 'no_token' | 'server_rejected' | 'exception'; detail?: string };

let registeredToken: string | null = null;
let registering: Promise<PushRegisterResult> | null = null;
// Settings screen reads this synchronously to explain WHY push looks off,
// instead of the silent console.warn this used to be the only trace of.
let lastResult: PushRegisterResult | null = null;
export function getLastPushRegisterResult(): PushRegisterResult | null {
  return lastResult;
}

// Idempotent — safe to call on every app foreground/login, matches
// ensureMyE2eeKeyPair's "keep the server copy in sync" pattern. Never
// throws — push is additive on top of the always-open notify socket, not
// something the rest of the app depends on — but now RETURNS why it
// didn't work instead of only a console.warn nobody but a developer with
// a cable plugged in would ever see.
export async function ensurePushRegistered(): Promise<PushRegisterResult> {
  if (registering) return registering;
  registering = (async () => {
    try {
      if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
        return (lastResult = { ok: false, reason: 'unsupported_platform' });
      }

      let perms = await Notifications.getPermissionsAsync();
      if (!perms.granted) {
        perms = await Notifications.requestPermissionsAsync({
          ios: { allowAlert: true, allowSound: true, allowBadge: false },
        });
      }
      if (!perms.granted) return (lastResult = { ok: false, reason: 'permission_denied' });

      const devicePushToken = await Notifications.getDevicePushTokenAsync();
      const token = typeof devicePushToken.data === 'string' ? devicePushToken.data : null;
      if (!token) return (lastResult = { ok: false, reason: 'no_token' });
      if (token === registeredToken) return (lastResult = { ok: true });

      const res = await apiFetch('/push/register-device', {
        method: 'POST',
        body: JSON.stringify({ platform: devicePushToken.type, token }),
      });
      if (!res.ok) return (lastResult = { ok: false, reason: 'server_rejected', detail: `status ${res.status}` });
      registeredToken = token;
      return (lastResult = { ok: true });
    } catch (e) {
      // Missing google-services.json, no real APNs entitlement yet in a
      // dev build, simulator (no push capability at all), etc.
      return (lastResult = { ok: false, reason: 'exception', detail: String(e) });
    } finally {
      registering = null;
    }
  })();
  return registering;
}

export async function unregisterPush(): Promise<void> {
  if (!registeredToken) return;
  const token = registeredToken;
  registeredToken = null;
  await apiFetch('/push/unregister-device', { method: 'POST', body: JSON.stringify({ token }) }).catch(() => {});
}
