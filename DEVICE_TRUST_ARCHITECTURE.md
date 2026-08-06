# PArA Device Trust — Architecture Report

Scope: this round extended PArA's existing device-approval flow (one shared PIN, code-based cross-device vouching) into a fuller device-trust system — richer per-device data, risk scoring, geo/impossible-travel/VPN signals, device states (trusted/temporary/revoked/lost/compromised), multi-request "Unknown devices" handling with reject, temporary/one-time approval modes, self-service mark-lost/compromised, a client-polled revocation check, and matching UI on web and mobile. It does **not** include an org-wide admin device roster across every employee — that's a distinct, larger project (see "Not built" below).

## What changed, by layer

**Backend (`worker.js`)**
- `deviceMeta[deviceId]` grew from `{label, addedAt, lastSeenAt}` to a full record: platform, browser, OS version, manufacturer/model, emulator flag, app version, IP, country, city, last two lat/lon (for impossible-travel), session count, risk score + flags, status, expiry, one-time-use flag.
- New helpers: `parseDeviceInfo(ua)` (platform/OS/browser from user-agent), `haversineKm`/`checkImpossibleTravel` (great-circle distance + implied speed between two logins), `looksLikeVpnOrHosting` (ASN-name keyword match), `computeDeviceRiskScore` (transparent point-additive score with named flags, not a black-box model).
- `/session` now enforces device status (revoked/lost/compromised → 403; expired temporary → auto-revoke + 403), builds the rich `deviceMeta` record every login, fires new-country and impossible-travel push alerts, and auto-revokes one-time-use devices after their single session.
- `user.pendingDeviceLink` (singular) → `user.pendingDeviceLinks` (map keyed by the requesting device's ID), fixing a real bug where two concurrent "new device" requests silently clobbered each other. `/device-link/approve` now takes `mode` (`permanent`/`temporary`/`one-time`) and `durationHours`. New `/device-link/reject`, callable either with the code (same proof-of-proximity as approve) or a bare `targetDeviceId` (safe one-click reject from a list, since rejecting only ever removes access).
- New self-service endpoints: `/devices/mark-lost`, `/devices/mark-compromised`, `/devices/revoke` (status-only, keeps history), `/devices/status` (lightweight poll for a device to detect its own revocation), `/devices/local-security-event` (client self-reports Face ID/passcode being turned off — this can only ever be client-reported, see below).
- `GET /devices` now returns the full rich record per device plus an `unknownDevices` list (pending requests not yet decided).
- New/labeled push notification types: `new_device`, `device_approved`, `device_rejected`, `unknown_login`, `suspicious_login`, `compromised_device`, `device_lost`, `device_revoked`, `administrator_action`, `biometric_disabled`, `passcode_removed`.
- `/admin/reset-device` (the real admin-triggered path — `requesterId` checked against the actual admins list) now also fires an `administrator_action` push, and clears `pendingDeviceLinks`.
- All outer `/api/*` proxy routes updated/added to match, including forwarding `ip`/`ua`/`country`/`city` for device-link requests the same way `/api/session` already did.

**Web (`index.html`)**
- Settings > Security > Devices rebuilt: each device shows a trust-level badge, platform icon, browser/OS/manufacturer-model, location, last-seen, session count, color-coded risk score, expiry (if temporary), and one-time flag. Actions: re-sync keys, mark lost, mark compromised, revoke/remove (buttons adapt once a device is already revoked/lost/compromised).
- New "Unknown devices" section lists pending requests (device, location, requested-when) with a one-click Reject and an "Enter code to approve" link into the existing code-entry modal.
- The approve modal gained an access-level selector (Permanent/Temporary + hours/One-time) and a Reject button.
- New periodic self-check (`startDeviceStatusSelfCheck`, every 60s while the tab is visible) polls `/devices/status` and calls the existing `lockApp()` if this device's own trust was pulled — see "Known limitation" below for why this exists.

**Mobile (`mobile-app/`)**
- Installed `expo-device`; `/session` calls now send real `manufacturer`/`model`/`isEmulator`/`osVersion`/`appVersion` (native-only — a browser genuinely cannot report these, see `parseDeviceInfo`'s UA-fallback for the web path).
- Settings screen gained the same device list, Unknown-devices list, mark-lost/compromised/revoke actions, and approve-mode selector/reject as web, using the same theme/styling conventions already in the file.
- New `useDeviceStatusSelfCheck` hook, mounted once at the app root (`app/_layout.tsx`) alongside the existing notify-socket hook — polls every 60s while foregrounded, plus immediately on every foreground transition (via `AppState`), and calls the existing `logout()` on revocation.

## Known architectural limitation: no true forced logout

`pinHash` is a single, static, shared-across-every-device bearer credential — there is no per-device session token that a revoke action could invalidate server-side. This was true before this round and is unchanged by it. Concretely: revoking, marking lost, or marking compromised a device blocks that device's **next** `/session` call, but cannot reach into an already-open tab or already-running app and kill its live access.

The mitigation built this round — client-side polling of `/devices/status` every 60 seconds (plus on-foreground on mobile) — closes that gap down to "at most one polling interval of residual access," which is a reasonable practical bound but is not the same guarantee a real revocable session token gives you (where access ends the instant the server decides it does). A genuine fix would mean replacing the shared-PIN-hash auth model with per-device rotating session tokens issued at `/session` time and checked on every request — a materially bigger change to the auth core than this round's scope, and worth scoping as its own project if instant forced logout becomes a hard requirement.

## Other honest caveats

- **VPN/hosting detection** is a keyword match against Cloudflare's free `asOrganization` string (`amazon`, `digitalocean`, `nordvpn`, etc.) — a real signal, not a fabricated one, but it's a heuristic against a hand-maintained list, not a query against an authoritative commercial IP-intelligence database. It will miss providers not on the list and can't distinguish "this ASN happens to be a cloud provider" from "this specific IP is a consumer VPN exit node."
- **Impossible-travel / risk scoring** is fully real and running (Haversine distance ÷ time-since-last-login against a physically-plausible speed threshold), but it's necessarily approximate: Cloudflare's `request.cf` geo data is IP-derived, not GPS-derived, so it inherits normal IP-geolocation imprecision (typically city-level, sometimes off by a meaningful distance in areas with sparse routing data).
- **Root/jailbreak detection** was scoped as a stated field in the request but is **not built** this round — it needs a native dependency (e.g. `jail-monkey`) plus an EAS rebuild to take effect, which is a deploy step, not a code change I can verify from here. Flagging this explicitly rather than shipping a fake "not rooted" default.
- **Biometric-disabled / passcode-removed notifications** are real and wired (`/devices/local-security-event`), but by nature can only ever be client-self-reported — there is no server-side way to detect a local device setting. No client screen calls this endpoint yet (Settings > Face ID toggle isn't wired to report it); the endpoint exists and is ready, wiring the toggle to call it is a small, clearly-scoped follow-up.
- **"Registered" vs. "Trusted" as separate states**: the requested state list included both. This system only has one tier — a device becomes fully trusted the moment `/device-link/approve` (or first-ever login) succeeds; there's no intermediate "registered but not yet trusted" step. Building that would mean a two-stage approval flow, which is a real design change, not a display tweak — noted rather than faked with a cosmetic label.
- **"Workspace Access" per device**: shown per the requested field list, but access in this system is scoped to the *account* (the shared PIN), not the device — every device on an account sees the same workspaces. The field is accurate, just necessarily identical across every row for one person; there's no per-device workspace-scoping concept to report differently.
- **Org-wide admin device roster** (an admin browsing every employee's devices across the org, not just their own) was explicitly out of scope for this round, which only extended the existing *self-service* Settings > Devices view. That's a legitimately separate, larger feature (new admin-console screen, cross-account query, its own permission model) worth scoping on its own rather than folding in as an afterthought.

## Verification performed

- `node --check worker.js` — passes.
- Extracted and `node --check`'d all 8 inline `<script>` blocks in `index.html` — passes, zero errors.
- `npx tsc --noEmit` in `mobile-app/` — two errors present, both pre-existing and unrelated to this round's files (`app/chat/[id].tsx` attachment-type narrowing, `CallOverlay.tsx`'s `StyleSheet.absoluteFillObject` vs `absoluteFill`); nothing touched this round introduced a new type error.
- Manually traced every new endpoint from outer `/api/*` proxy → Registry DO handler → response shape, and cross-checked every client call site (web + mobile) against the actual field names the server reads/returns, the same pattern used to catch dropped-field proxy bugs in earlier rounds of this project.

What I did **not** do, and can't from here: real multi-device end-to-end testing (two physical devices actually requesting/approving/rejecting against the live deployment), load/scale testing, or verifying push notification delivery end-to-end (APNs/FCM credentials aren't something I can exercise from a sandboxed environment). Those need the real deployment and real devices — the code paths are built and internally consistent, but "works against production with real devices" is still worth a manual pass before calling this fully shipped.
