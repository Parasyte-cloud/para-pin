# PArA PIN — mobile (React Native / Expo)

Native iOS + Android client for PArA PIN, talking to the same backend as
`chat.parasyte.cloud` (not `web.parasyte.cloud` — that hostname is a
desktop-specific CSS/behavior layer on top of the same app and this client
intentionally doesn't replicate it; see `index.html`'s `desktop-app` class
toggle for context). Free to download — Workspace (paid) membership is
purchased on web, but a workspace's chats work here too once you're a
member; mobile never handles billing itself.

Replaces the old `mobile/` Capacitor WebView wrapper (kept in the repo only
because this sandbox can't delete files — safe to `git rm -r mobile` once
this is reviewed). Bundle ID `cloud.parasyte.parapin` and the app icon were
carried over from it since they were already decided and never actually
submitted to either store.

## Stack

- **Expo (managed) + EAS Build**, SDK 57, React Native 0.86, React 19.
- **expo-router** (file-based routing, `app/`), TypeScript strict mode.
- **Zustand** for session/message state (`src/state/`).
- **expo-secure-store** (iOS Keychain / Android Keystore) for the auth
  credential (`pinHash`), device identity (`deviceId`), the E2EE device
  keypair, and the biometric-unlock preference. Nothing else is persisted
  to disk — chats/orgs/messages are refetched each session.
- **expo-crypto** for `sha256(pin)` (the PIN hash sent to the server) and
  **expo-local-authentication** for Face ID/fingerprint quick-unlock.
- **@noble/curves + @noble/hashes + @noble/ciphers** (pure JS, no native
  module) for E2EE — see below. Chosen specifically because it needs no
  dev client / custom native build, so `npx expo start` + Expo Go still
  works for everything built so far.

## Setup

**Expo Go no longer works, as of Phase 3.** `react-native-webrtc` is a real
native module — `npx expo start` + scanning the QR code into the Expo Go
app will fail to load the JS bundle (it'll error on the native call
between `RTCPeerConnection`/`RTCView` and Expo Go's fixed set of built-in
native modules, which doesn't include WebRTC). Everything through Phase 2
worked in Expo Go; Phase 3 requires a **custom dev client** instead —
build one once, then `expo start` targets that installed dev client the
same way Expo Go worked before:

```
cd mobile-app
npm install
npx eas build --profile development --platform ios
npx eas build --profile development --platform android
# install the resulting build on your device/simulator, then:
npx expo start --dev-client
```

This sandbox's network proxy blocks a couple of non-npm-registry hosts
(`exp.host`, the React Native Directory API), so `npx expo-doctor` couldn't
fully validate here — 17/20 checks passed, re-run it yourself before fully
trusting dependency-version alignment. `tsc --noEmit` passes clean, and a
full Metro bundle export (`npx expo export`) resolves all ~1,400-1,500
modules with zero errors for both iOS and Android — the one remaining
failure in this sandbox is the final native Hermes-bytecode step, blocked
by this environment's binary-execution restriction, not a code issue (EAS
Build's cloud infra does that step fine).

```
npx eas login
npx eas build:configure
npx eas build --profile development --platform ios
npx eas build --profile development --platform android
```

`eas.json`'s `submit.production.ios.ascAppId` still has a placeholder —
fill in the real App Store Connect app ID before `eas submit`.

### Android push needs `google-services.json`

`app.json` now points `android.googleServicesFile` at
`./google-services.json` (not committed — it's per-project, download it
from the Firebase console: Project settings → your Android app →
`google-services.json`) and put it at `mobile-app/google-services.json`.
Without it, `getDevicePushTokenAsync()` on Android will fail at runtime,
and a build with the `expo-notifications` plugin enabled may fail outright
depending on EAS's prebuild step. iOS needs no equivalent app-side file —
push capability comes from the `expo-notifications` config plugin adding
the `aps-environment` entitlement automatically, EAS Build's provisioning
handles the rest.

### Server-side secrets (`wrangler secret put <NAME>`)

Existing (Web Push, already configured if push worked on web before):
`VAPID_PRIVATE_KEY_JWK`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`.

New for mobile push (Phase 4) — nothing sends until these are set,
everything else in the app works fine without them:
- `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY_P8` (the full `.p8` file
  contents, from an Apple Developer push-notification key), `APNS_BUNDLE_ID`
  (`cloud.parasyte.parapin`). `APNS_USE_SANDBOX=true` only if you need to
  target Apple's sandbox APNs environment instead of production.
- `FCM_SERVICE_ACCOUNT_JSON` — the full contents of a Firebase service
  account JSON key (Firebase console → Project settings → Service accounts
  → Generate new private key) with the Firebase Cloud Messaging API
  enabled on that project.

Once both a device is registered (Settings → Push notifications → Enable,
after a dev-client build) and these secrets are set, `POST
/api/push/test` sends a real test push and reports per-target
success/failure — the fastest way to confirm this actually works end to
end.

## What's built

**Phase 1 — auth + chat list + biometric unlock**
- PIN entry/creation (`app/(auth)/pin.tsx`) wired to real `POST
  /api/session`, same auth header pattern as web (`X-Para-Pin-Hash`),
  handles every real error case the server returns (`rate_limited`,
  `pin_disabled`, `device_approval_required`, `mfa_required` — MFA punts to
  the web app since native TOTP/WebAuthn UI isn't built).
- Face ID / fingerprint quick-unlock (`app/(auth)/lock.tsx`, opt-in via
  Settings): a LOCAL device-lock gate on top of the real credential, not a
  replacement for it — PIN is still what's sent to the server. Doesn't yet
  re-lock automatically when backgrounded, only on cold start.
- Tab shell (Chats/Calls/Settings), chat list from real session data.

**Phase 2 — E2EE messaging + realtime chat — done**
- `src/crypto/e2ee.ts`: P-256 ECDH + HKDF-SHA256 + AES-256-GCM, verified
  **byte-for-byte interoperable** with the web app's actual WebCrypto
  implementation — not just "should match the spec," actually checked. See
  `scratch_e2ee_interop_check.mjs` (kept deliberately, same pattern as the
  main repo's own `scratch_e2ee_test.mjs`): two independently-generated
  keypairs, one via Node's real WebCrypto (standing in for the web app),
  one via this module's @noble implementation, public keys exchanged, and
  every check passes — identical derived AES keys, cross-decryption both
  directions, and a group-key wrap created by one side unwrapping correctly
  on the other. Run it yourself: `node mobile-app/scratch_e2ee_interop_check.mjs`.
- `src/state/e2ee.ts`: device keypair persisted in SecureStore, published
  to `POST /api/e2ee/public-key`, and the same resolve-or-establish wrap
  flow as index.html's `ensureChatKey` (`GET`/`POST
  /chats/:id/e2ee-wraps`, including the `ifEmpty` race-loser path).
- `src/hooks/useChatSocket.ts`: live `message`/`typing`/`read_receipt`/
  `edit`/`delete` over `wss://chat.parasyte.cloud/api/chats/:id/ws`, typing
  + ping heartbeat out, auto-reconnect on drop.
- `app/chat/[id].tsx`: message bubbles, composer, send (encrypt + `POST
  /messages`), optimistic local echo, typing indicator, mark-read on open,
  decrypt-with-retry (a chat key can legitimately take a moment to
  establish on first use).
- Root layout switched from a bare `Slot` to a real `Stack` so this screen
  gets native push/back-button chrome.

**Phase 3 — 1:1 calls — done**
- `react-native-webrtc` + `@config-plugins/react-native-webrtc` for native
  WebRTC (RTCPeerConnection, RTCView) — see the "Expo Go" note below, this
  is the point where a custom dev client becomes required.
- `src/state/callSignal.ts`: `getIceServers` (`GET /api/calls/ice-servers`,
  STUN now, TURN once Cloudflare Calls secrets are set), `sendCallSignal`
  (`POST /api/calls/signal`), `logCallEntry` (`POST /api/calls/log`) — all
  match worker.js's actual request/response shapes exactly, not guessed.
- `src/hooks/useNotifySocket.ts`: the always-open global socket (mirrors
  index.html's `connectNotifySocket`), mounted once in the root layout,
  delivers incoming `{type:'call-signal'}` messages regardless of which
  screen is open.
- `src/state/call.ts`: full call state machine — outgoing/incoming ringing,
  offer/answer/ICE exchange, mute/camera toggle, a 15s connect timeout on
  outgoing calls, and a 12s grace period on `disconnected` before treating
  a flaky connection as actually ended (matches index.html's behavior).
- `src/components/CallOverlay.tsx`: full-screen call UI mounted once at the
  app root (sibling to the route `Stack`) so an incoming call can interrupt
  any screen, with local/remote video via `RTCView` for video calls.
- Call buttons (audio + video) in the chat detail header for DMs
  (`app/chat/[id].tsx`), and a real Calls tab (`app/(tabs)/calls.tsx`)
  showing call history from `GET /api/calls/log` with tap-to-call-back.

**Known, deliberate scope cuts in Phase 3:**
- **No ringtone/vibration audio** — the incoming-call UI is silent beyond
  the on-screen overlay; no sound plays yet.
- **Group/meeting calls aren't built.** Only the 1:1 direct WebRTC path
  (mirrors index.html's `startOutgoingCall`/`handleCallSignal` for DMs).
  The separate SFU-based meeting path on Cloudflare Calls (`MeetingRoom`
  DO) is unbuilt — group calls still require the web app.
- Call log entries are always written/read as personal (no `orgId`) —
  mobile has no workspace switcher yet, so this can't leak into or out of
  a workspace's call history; it's just not workspace-scoped at all yet.

**Attachments — done.** Files/images/voice notes are E2EE'd server-side
(separate ciphertext for the file bytes AND the filename); this now
decrypts both, same `decryptWithFallback` treatment as text. Since React
Native has no `URL.createObjectURL`, decrypted bytes are written to a
per-message file under `expo-file-system`'s cache directory instead of an
in-memory blob URL (`src/state/messages.ts`'s `decryptOneAttachment`,
`MessageAttachment._decryptedUri` in `src/types.ts`). Images render inline
(`app/chat/[id].tsx`'s `ImageAttachment`), voice notes get a play/pause
row via `expo-audio` (`AudioAttachment`), everything else is a tappable
file row that opens the OS share sheet via `expo-sharing` (`FileAttachment`).
Sending attachments FROM mobile still isn't built — this covers receiving
ones sent from web.

**Legacy pre-multi-device DM fallback — implemented, with an inherent
limit worth understanding.** `src/crypto/e2ee.ts` now has
`deriveLegacyDmKey` (matches index.html's `E2EE_DM_INFO` derivation
exactly) and `src/state/e2ee.ts`'s `ensureLegacyDmKey` fetches the peer's
frozen legacy public key and tries it whenever the current wrap-based key
fails to decrypt something, same `decryptWithFallback` pattern as web.
**This does not mean old DM history now decrypts on mobile in general.**
The fallback key is derived from *this device's* private key — it only
reproduces the original ciphertext's key if this device's key is the same
one that was active when that DM was encrypted. Mobile always generates a
brand-new keypair the first time it runs, so on any account that already
had pre-multi-device DMs from the web app before ever opening mobile, this
resolves to a *different* key and still can't decrypt that history — the
same way approving any other new device never could either. It only
actually helps if mobile happens to be an account's very first device
ever. This is a data-availability limitation of the frozen-legacy-key
design itself (see index.html:10328-10332), not something more mobile
code can close.

**Other Phase 2 scope cuts still standing:**
- Sending edits/reactions/replies/deleting from mobile isn't built —
  receiving those live updates is (the WS handler applies them), sending
  them isn't yet.

**Phase 4 — Push notifications — done**
- `worker.js`: `sendApnsPush`/`sendFcmPush` alongside the existing Web Push
  code, both using the same ES256-JWT-signing pattern VAPID already
  proved out — APNs directly (ES256 JWT signed with the `.p8` key), FCM
  via a Google service-account OAuth2 exchange (RS256 JWT → access token
  → FCM HTTP v1 `messages:send`). `pushToAllTargets` sends one payload to
  every Web Push subscription AND every native device token for a user,
  pruning only entries a push service confirms are permanently gone
  (`BadDeviceToken`/`Unregistered` for APNs, `UNREGISTERED`/
  `INVALID_ARGUMENT` for FCM) — same conservative rule the original Web
  Push code used. New `UserChannel` DO endpoints: `/register-device`,
  `/unregister-device`, storage key `deviceTokens` (kept separate from
  `pushSubs` so the existing Web Push code can't be handed a shape it
  doesn't understand). Public routes: `POST /api/push/register-device`,
  `POST /api/push/unregister-device`.
- `mobile-app/src/state/push.ts`: registers the device on login/unlock via
  `expo-notifications`' `getDevicePushTokenAsync()` — deliberately the RAW
  APNs device token / FCM registration token, not Expo's own push-relay
  service, so this really is a direct dual-send to Apple/Google with
  nothing else in the path. Settings has an "Enable" control showing
  current permission status.
- **Not independently verified the way E2EE was.** There's no real device
  token or live Apple/Google credential in this environment to send an
  actual test push through — the JWT-signing halves use the same
  well-understood primitives as VAPID's own (already proven correct), but
  the only real test is a genuine push landing on a real device once the
  `APNS_*`/`FCM_*` secrets below are set. Worth running `POST
  /api/push/test` once a device is registered, before trusting this fully.
- Requires the same custom dev client Phase 3 already introduced —
  `expo-notifications` isn't part of Expo Go's module set either.

**Phase 5 (HR, admin console, billing, SSO/SAML settings, workspace custom
domains) is intentionally excluded from mobile, not just "not yet built."**
Mobile is the free product; Workspace/billing/admin surfaces are the paid,
web-only product — see the top of this file. Message search, contacts/
roster browsing, and profile editing also aren't built, unrelated to that
split, just not reached yet.

## Known rough edges

- Android adaptive icon's background/monochrome layers are still Expo's
  stock placeholders — only the foreground layer got the real PArA icon.
- `App.tsx` / `index.ts` are dead code (real entry is `expo-router/entry`)
  — left in place because this sandbox can't delete files. Safe to
  `rm App.tsx index.ts` locally.
- No automated test suite yet (unlike the main repo's `tests/`) —
  `scratch_e2ee_interop_check.mjs` is a one-off verification script, not a
  repeatable `npm test` target. Worth promoting into a real test if this
  crypto module changes again.
