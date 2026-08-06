// Screen-capture protection for the profile-photo full-screen viewer,
// scoped ONLY to whatever screen mounts this hook (see AvatarViewer) —
// never applied app-wide, so it can't interfere with anything else (chat
// screenshots, screen recording during a call, etc. all stay unaffected).
//
// Android: real OS-level protection is available and used. preventScreenCaptureAsync()
// sets FLAG_SECURE on the window (see node_modules/expo-screen-capture's
// Android source — currentActivity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)),
// which makes the OS itself render a black frame for any screenshot,
// screen recording, or Recents/App-Switcher preview. That's a genuine
// block, not a detection-and-hope, which is why it's the one thing this
// app is willing to describe as "prevented" rather than "detected". It's
// gated behind the org's avatarPolicy.preventScreenshotAndroid (default
// off) since it changes real, visible behavior (Recents preview goes
// blank) and an org should opt into that trade-off rather than have it
// silently appear.
//
// iOS: there is NO supported Apple API to block a screenshot of arbitrary
// app content — full stop. expo-screen-capture's iOS "prevention" path
// (which this app deliberately never calls) works by reparenting the key
// window's layer under a UITextField with isSecureTextEntry = true,
// piggybacking on the OS behavior that hides secure-text-entry fields from
// the screenshot/recording buffer. That's a real technique and it does
// often work today, but it's an unofficial side effect of a feature built
// for password fields, not a sanctioned capability — Apple has changed
// secure-entry rendering internals across iOS releases before without
// warning, and relying on it would mean this app claiming to block iOS
// screenshots, which the design brief for this feature explicitly rules
// out ("iOS cannot prevent screenshots ... do not claim screenshots are
// blocked"). So on iOS this hook ONLY wires the detection listener via
// useScreenshotListener and reports what it saw — it never calls
// preventScreenCaptureAsync/usePreventScreenCapture.
//
// The detection listener itself is also attached on Android (in addition
// to FLAG_SECURE when the org policy calls for it) as defense in depth —
// if screenshot protection is off, or a launcher/OEM skin doesn't fully
// honor FLAG_SECURE, a screenshot might still get through, and it's better
// to have a log entry than nothing.
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import * as ScreenCapture from 'expo-screen-capture';
import { apiFetch } from '../api/client';
import { useSessionStore } from '../state/session';

const ANDROID_PREVENT_KEY = 'para-avatar-viewer';

function anyOrgRequiresAndroidScreenshotProtection(): boolean {
  // Same "any org can raise the bar" reasoning as effectiveLockTimeoutSec
  // in state/session.ts: whichever workspace the photo/viewer is
  // associated with isn't tracked precisely enough here to scope this
  // tighter, and erring toward protecting more often is the safe default
  // for a security control.
  const { orgs } = useSessionStore.getState();
  return orgs.some((o) => !!o.avatarPolicy?.preventScreenshotAndroid);
}

// targetUserId identifies whose photo is on screen, used only for the
// detection report (see worker.js POST /profile/screenshot-report) so the
// right person's access log gets the entry and their own device gets
// notified. Pass null while nothing's loaded yet — the hook just won't
// report anything until a real id is supplied.
export function useAvatarScreenCapture(targetUserId: string | null) {
  const targetRef = useRef(targetUserId);
  targetRef.current = targetUserId;

  useEffect(() => {
    let preventedAndroid = false;
    let screenshotSub: { remove: () => void } | null = null;
    let cancelled = false;

    (async () => {
      if (Platform.OS === 'android') {
        if (anyOrgRequiresAndroidScreenshotProtection()) {
          await ScreenCapture.preventScreenCaptureAsync(ANDROID_PREVENT_KEY).catch(() => {});
          if (!cancelled) preventedAndroid = true;
        }
        // Dangerous permission pre-Android 14 (see the library's merged
        // AndroidManifest); best-effort — if the person declines, the
        // listener below simply never fires, which just means this one
        // piece of defense-in-depth logging is unavailable, not a crash.
        await ScreenCapture.requestPermissionsAsync().catch(() => {});
      }
      if (cancelled) return;
      screenshotSub = ScreenCapture.addScreenshotListener(() => {
        const targetUserIdNow = targetRef.current;
        if (!targetUserIdNow) return;
        apiFetch('/profile/screenshot-report', {
          method: 'POST',
          body: JSON.stringify({ targetUserId: targetUserIdNow, context: 'avatar_viewer' }),
        }).catch(() => {});
      });
    })();

    return () => {
      cancelled = true;
      if (preventedAndroid) ScreenCapture.allowScreenCaptureAsync(ANDROID_PREVENT_KEY).catch(() => {});
      screenshotSub?.remove();
    };
  }, []);
}
