# PArA PIN — mobile (React Native / Expo)

Native iOS + Android client for PArA PIN, talking to the same backend as
`chat.parasyte.cloud` (not `web.parasyte.cloud` — that hostname is a
desktop-specific CSS/behavior layer on top of the same app and this client
intentionally doesn't replicate it; see `index.html`'s `desktop-app` class
toggle for context).

Replaces the old `mobile/` Capacitor WebView wrapper (kept in the repo only
because this sandbox can't delete files — safe to `git rm -r mobile` once
this is reviewed). Bundle ID `cloud.parasyte.parapin` and the app icon were
carried over from it since they were already decided and never actually
submitted to either store.

## Stack

- **Expo (managed) + EAS Build**, SDK 57, React Native 0.86, React 19.
- **expo-router** (file-based routing, `app/`), TypeScript strict mode.
- **Zustand** for session state (`src/state/session.ts`).
- **expo-secure-store** (iOS Keychain / Android Keystore) for the auth
  credential (`pinHash`) and device identity (`deviceId`) — nothing else is
  persisted to disk; the chat list/org list is refetched from `POST
  /session` on every app boot.
- **expo-crypto** for the client-side `sha256(pin)` that's actually sent to
  the server (matches `index.html`'s `sha256Hex`, `index.html:2991` — the
  raw PIN never leaves the device).

## Setup

```
cd mobile-app
npm install
npx expo start
```

This sandbox's network proxy blocks a couple of non-npm-registry hosts
(`exp.host`, the React Native Directory API), so `npx expo-doctor` and `npx
expo install --check` couldn't fully validate here — 17/20 checks passed,
the 3 network-dependent ones need to be re-run from your own machine before
you fully trust dependency-version alignment. `tsc --noEmit` passes clean.

`eas.json` is scaffolded with `development`/`preview`/`production` build
profiles, all pointed at `https://chat.parasyte.cloud` via
`EXPO_PUBLIC_API_BASE_URL`. You said Apple Developer + Firebase are already
set up — next step when you're ready for a real device build:

```
npx eas login
npx eas build:configure
npx eas build --profile development --platform ios
```

`eas.json`'s `submit.production.ios.ascAppId` still has a placeholder —
fill in the real App Store Connect app ID before `eas submit`.

## What's built (Phase 1 — done)

- PIN entry/creation screen (`app/(auth)/pin.tsx`) wired to the real `POST
  /api/session` — same endpoint index.html uses, same auto-register-on-
  first-use behavior, same `X-Para-Pin-Hash` auth header pattern
  (`src/api/client.ts`, `src/state/session.ts`).
- Handles the real error cases the server actually returns:
  `rate_limited` (with the retry countdown), `pin_disabled`,
  `device_approval_required`, and `mfa_required` (surfaced as a message
  pointing back to the web app — native TOTP/WebAuthn UI isn't built, see
  Phase 5 below).
- Device identity (`deviceId`) generated once and persisted, matching the
  web app's multi-device-trust model.
- Tab shell (`app/(tabs)/`): Chats, Calls, Settings, auth-gated.
- Chat list pulls real chat/org/unread data from the session response.
  Message previews intentionally say "Encrypted message" rather than
  faking a preview — see Phase 2.
- Theme (`src/theme.ts`) mirrors `index.html`'s actual CSS custom
  properties (`--ice`, `--fire`, `--bg-0`, etc.) so this reads as the same
  product, not a re-skin.

## What's NOT built yet — and why each is its own phase

This is a big app; Phase 1 was scoped to "auth, chat, calls" per your
answer, and even that only got as far as auth + a read-only chat list this
pass. Roughly in priority order:

**Phase 2 — Chat: E2EE + realtime + sending**
The hard part isn't UI, it's crypto. Messages are end-to-end encrypted
client-side with ECDH P-256 + HKDF + AES-GCM (`index.html:10392-10444`) —
the server only ever stores/relays opaque ciphertext. React Native has no
built-in WebCrypto, so this needs either `react-native-quick-crypto` or a
WASM-based subtle-crypto shim before a single message can be decrypted.
Also needed: a per-chat WebSocket client for live `message`/`typing`/
`read_receipt`/`edit`/`delete`/`reaction` events (writes still go through
plain REST, matching the web app's pattern — see worker.js's ChatRoom DO),
and the group-chat key-wrapping flow (`/api/chats/:id/e2ee-wraps`).

**Phase 3 — Calls**
Needs `react-native-webrtc` (no browser WebRTC in RN) plus replicating two
distinct signaling paths that already exist for web: a 1:1 direct-call path
and a separate meeting/group SFU-based path layered on Cloudflare Calls
(`MeetingRoom` DO, roster + track-announce over its own WebSocket). Flagged
in the research pass as needing a full read of `index.html` lines
~6650-6900 and ~7380-7900 before implementation — not attempted yet.

**Phase 4 — Push notifications**
Confirmed 100% Web Push/VAPID today, zero APNs/FCM code anywhere. This is
net-new on both ends: device-token registration in the app, and a
worker.js change to dual-send (Web Push vs. APNs/FCM depending on
platform) reusing the existing `USER_CHANNEL` DO's subscription storage.
You said Apple Developer + Firebase are already set up, so the account
side is ready whenever this phase starts.

**Phase 5 — Everything else**
HR, admin console, billing, SSO/SAML settings, workspace custom domains —
all explicitly out of scope for mobile per your "core first" answer. Chat
detail/send, message search, contacts/roster browsing, and profile editing
are also just not built yet even though they're "core."

## Known rough edges in this scaffold

- Android adaptive icon's background/monochrome layers are still Expo's
  stock placeholders — only the foreground layer got the real PArA icon.
  Worth a proper icon pass (safe-zone padding etc.) before a real release.
- `App.tsx` / `index.ts` are dead code (this project's real entry is
  `expo-router/entry` per `package.json`) — left in place because this
  sandbox can't delete files. Safe to `rm App.tsx index.ts` locally.
- No tests yet. The web app's `tests/` suite (SAML/WebAuthn/VAPID/TOTP)
  doesn't apply here since none of that crypto is ported to RN yet.
