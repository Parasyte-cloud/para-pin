// Mirrors index.html's startDeviceStatusSelfCheck (index.html, Settings >
// Security section) — mounted once at the app root (see app/_layout.tsx),
// same gating as useNotifySocket/ensurePushRegistered (pinHash set, not
// locked).
//
// Exists for one reason: pinHash is a static, shared-across-devices bearer
// credential with no per-device session token, so the server has no way to
// forcibly kill an already-open app the moment a device is revoked/marked
// lost or compromised — see worker.js's GET /devices/status handler
// comment for the full explanation. Revoking a device today only blocks a
// FUTURE /session call; without this poll, an app already running on a
// revoked device would keep working — reading messages, sending them,
// joining calls — until someone happened to force-quit and reopen it. This
// closes that gap down to "at most one poll interval of residual access."
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { apiFetch } from '../api/client';
import { useSessionStore } from '../state/session';

const POLL_MS = 60000;

export function useDeviceStatusSelfCheck() {
  const pinHash = useSessionStore((s) => s.pinHash);
  const isLocked = useSessionStore((s) => s.isLocked);
  const deviceId = useSessionStore((s) => s.deviceId);
  const logout = useSessionStore((s) => s.logout);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const active = !!pinHash && !isLocked && !!deviceId;
    if (!active) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    const check = async () => {
      if (AppState.currentState !== 'active') return;
      const r = await apiFetch<{ status: string }>(`/devices/status?deviceId=${encodeURIComponent(deviceId!)}`);
      if (r.ok && r.body && r.body.status && r.body.status !== 'active' && r.body.status !== 'signed_out') {
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        await logout();
      }
    };

    timerRef.current = setInterval(check, POLL_MS);
    // Also check immediately whenever the app comes back to the
    // foreground, same reasoning as useNotifySocket's AppState-driven
    // reconnect — a device could be revoked while the app was backgrounded
    // for hours, don't wait up to a full POLL_MS after it returns.
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') check();
    });

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      sub.remove();
    };
  }, [pinHash, isLocked, deviceId, logout]);
}
