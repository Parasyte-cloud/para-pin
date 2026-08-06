# PArA Enterprise Biometric Authentication — Architecture Report

## Scope and what this round actually changed

PArA already had working Face ID/Touch ID/fingerprint app-unlock on mobile (`expo-local-authentication`, with automatic device-PIN fallback) and WebAuthn passkeys on web (used for MFA at login and for approving new devices). This round's job was to close the real gaps in that foundation and turn it into something closer to an enterprise policy story, without fabricating features the product doesn't structurally have. Concretely, this round added:

- An inactivity/backgrounding auto-lock timer on **both** platforms — previously the only way to re-lock was a manual tap; there was no timeout-based lock at all.
- An **org-level minimum lock-timeout policy** (`org.securityPolicy`) an admin can set, enforced client-side as a ceiling on top of each person's own preference (strictest wins).
- A **passkey-based relock** on web: when the app re-locks from inactivity, and the account has a registered passkey, "Unlock with Face ID/Touch ID/Windows Hello" is offered as an alternative to retyping the PIN.
- A fix so mobile biometric unlock no longer **requires network access** to succeed — a successful Face ID/fingerprint scan now unlocks immediately; refreshing session data happens in the background afterward.
- Detection of the device's own **biometric enrollment being cleared or its passcode being removed**, self-reported to the server for a security notification (mirrors the device-trust round's `local-security-event` endpoint).
- A **step-up re-authentication** helper wired to approving a new device on mobile (the single highest-value action this app has) — biometric-or-device-passcode confirmation right before granting a new device account access, independent of workspace policy.

## Architecture

```
                 ┌─────────────────────────┐
                 │   Org admin (web)        │
                 │  Settings > Workspace     │
                 │  > Security policy        │
                 └────────────┬─────────────┘
                              │ POST /org/security-policy
                              ▼
                 ┌─────────────────────────┐
                 │  Registry Durable Object  │
                 │  org.securityPolicy =     │
                 │  { minTimeoutSec,         │
                 │    requireStepUpForSens.} │
                 └────────────┬─────────────┘
                              │ returned in POST /session's `orgs[]`
                              ▼
        ┌─────────────────────┴─────────────────────┐
        ▼                                             ▼
┌───────────────────┐                       ┌───────────────────┐
│  Web (index.html)   │                       │  Mobile (Expo RN)   │
│  effectiveLockTime  │                       │ getEffectiveLock    │
│  outSec() = min(     │                       │ TimeoutSec() = min( │
│   own pref,          │                       │   own pref,          │
│   min(org minima))    │                       │   min(org minima))    │
│                       │                       │                       │
│  startInactivityTimer │                       │ useInactivityAutoLock │
│  (visibilitychange +  │                       │ (AppState background │
│   idle listeners)     │                       │  → active elapsed)    │
│                       │                       │                       │
│  lockApp() on timeout │                       │  lockNow() on timeout │
│                       │                       │                       │
│  lockPasskeyBtn →      │                       │ unlockWithBiometric   │
│  webauthn/auth-verify  │                       │ (LocalAuthentication, │
│  using cached state.pin│                       │  now offline-safe)    │
└───────────────────┘                       └───────────────────┘
```

The device-trust work from the previous round (rich per-device records, risk scoring, mark-lost/compromised, the `/devices/status` self-check poll) is the substrate this sits on top of — biometric/passkey verification answers "is this really you," device trust answers "is this device still allowed to be you at all." They're deliberately kept as separate concerns talking through the same Registry DO.

## Implementation notes by surface

**Backend (`worker.js`)**
- `org.securityPolicy: { minTimeoutSec: 0|30|60|300|null, requireStepUpForSensitive: boolean }`, defensively defaulted (`org.securityPolicy || null`) rather than backfilled on every org — same migration pattern used for `pendingDeviceLinks` last round.
- `GET/POST /org/security-policy` — read is any org member (so a non-admin's client can compute its own effective timeout), write is `manage_workspace`-gated, audit-logged.
- `orgs[]` in the `/session` response now carries `securityPolicy` per org, so neither client needs an extra round trip to enforce it.
- `/devices/local-security-event` (built last round) now also accepts the two events the mobile watcher reports: `biometric_disabled`, `passcode_removed`.

**Web (`index.html`)**
- `startInactivityTimer()`: one `lastActivityAt` timestamp, refreshed by real mouse/keyboard/touch/scroll events while the tab is visible, frozen while hidden, checked every 5s and immediately on regaining visibility. `effectiveLockTimeoutSec()` computes the enforced value from `myOrgs[].securityPolicy` + the person's own `localStorage`-persisted preference.
- Settings > Security gained an Auto-lock selector (four tiers, matching the requested policy list) and Settings > Workspace gained the admin-facing policy control.
- `lockPasskeyBtn` on the lock screen: only shown if a passkey is registered (cached flag, refreshed whenever the passkey list loads) and this is a relock (not first-time PIN setup). Authenticates using `state.pin` — the same sha256(PIN) value already persisted locally for the existing PIN-based relock check — as the auth header, so no network call is needed just to figure out whose account this is before prompting WebAuthn.

**Mobile (`mobile-app/`)**
- `useInactivityAutoLock`: tracks `AppState` transitions into `background` (not the transient `inactive` state iOS fires for app-switcher previews/Control Center) and checks elapsed time against `getEffectiveLockTimeoutSec()` on return to `active`.
- `unlockWithBiometric` no longer gates the unlock decision on `refreshSession()`'s network call — the on-device biometric result is trusted immediately, and `refreshSession()` runs afterward in the background to pull fresh data and catch a real revocation.
- `useBiometricEnrollmentWatcher`: compares `expo-local-authentication`'s `getEnrolledLevelAsync()` against the last-observed value (persisted in SecureStore) on every foreground; a drop to `NONE` reports `passcode_removed`, a drop from biometric to `SECRET` reports `biometric_disabled`.
- `requireStepUpAuth()`: thin wrapper around `LocalAuthentication.authenticateAsync` with `disableDeviceFallback:false` — the OS already does Face ID/fingerprint-first-then-device-passcode on its own, there's no separate PIN UI to build. Wired unconditionally into the device-approval flow.
- Settings screen gained the same four-tier Auto-lock selector, showing the org-mandated override when it's stricter.

## Security review

**What's genuinely enforced vs. what's UX-level.** Every lock-timeout and step-up control built this round is **client-enforced**, not a server-side authorization boundary. This needs to be said plainly: a modified or compromised client could simply skip calling `lockApp()`/`lockNow()`, or skip the step-up prompt, and the server would never know — none of the actual data-access endpoints (chat reads, HR/CRM reads, device-trust actions) check "was this session recently biometric-confirmed." What this system actually protects against is the realistic, common case — someone else picking up an unlocked, unattended device — not a sophisticated attacker who has already compromised the client binary itself. This is the same trust boundary every consumer/enterprise chat app's app-lock feature has (Signal, WhatsApp, Slack); none of them turn a client-side lock screen into a server-side authorization check either, and doing so here would need a much bigger redesign (real per-action server-side step-up tokens, not a UI gate).

**Biometric data never leaves the device — by construction, not by extra effort.** `expo-local-authentication` on mobile and WebAuthn's platform authenticator on web are both OS/hardware-owned: the app receives a boolean success/fail result and, for WebAuthn, a signed assertion — never a fingerprint image, face scan, or any biometric template. Secure Enclave (iOS) and the Android Keystore-backed biometric APIs are what actually perform the match; this app has no code path that could touch raw biometric data even if it wanted to. This isn't new work — it's an inherent property of the platform APIs already in use — but it's worth stating explicitly since "never store biometric data" was an explicit requirement: it was already true, and remains true.

**Offline unlock trade-off.** Trusting the local biometric result without waiting on `refreshSession()` means a device that was revoked/lost/compromised while offline will still show its cached chat data behind a successful Face ID scan until the background refresh (or the periodic `/devices/status` poll from last round) catches up and forces a sign-out. This is a deliberate, bounded trade-off — the same "can't do instant server-forced logout" limitation already documented for this app's pinHash-based auth model, not a new weaker guarantee introduced by this change.

**Step-up is a UX confirmation, not a cryptographic proof.** `requireStepUpAuth`'s result is just "the OS says the local biometric/passcode check passed" — it does not produce a token the server verifies. `org.securityPolicy.requireStepUpForSensitive` is stored and returned but the mobile step-up wiring this round doesn't yet read it (device approval is unconditional instead) — see "Not built" below.

**Passkey relock reuses `state.pin`, not the raw PIN.** The relock flow authenticates WebAuthn calls with the locally-cached sha256(PIN) hash, never the raw PIN text — `myRawPin` stays `null` on that path, which only affects the "Share my PIN" convenience feature (already null-guarded) and nothing cryptographic.

## Platform differences

| | iOS | Android | Web |
|---|---|---|---|
| Biometric API | Face ID / Touch ID via LocalAuthentication, backed by Secure Enclave | Fingerprint / face unlock via LocalAuthentication, backed by Android Keystore | WebAuthn platform authenticator (Touch ID on Mac, Windows Hello, or a registered security key) |
| Device passcode fallback | Automatic (`disableDeviceFallback:false`) | Automatic (`disableDeviceFallback:false`) | Falls back to typing the PIN; no native OS passcode fallback concept in a browser |
| Enrollment-change detection | `getEnrolledLevelAsync()` — reliable | `getEnrolledLevelAsync()` — reliable, though Android's fragmentation across OEM biometric stacks means behavior can vary slightly by device | Not applicable — a browser has no concept of "the device's biometric enrollment," only whether a WebAuthn credential is currently usable |
| Background timing | `AppState` background/active, OS may suspend timers while backgrounded (irrelevant here — this measures time on RE-ENTRY, not a running background timer) | Same via `AppState` | `visibilitychange` + a 5s foreground interval; browsers throttle/suspend timers in hidden tabs, same non-issue since the check re-runs on regaining visibility |
| Custom biometric prompt UI | Not possible — Face ID/Touch ID's system sheet is owned entirely by iOS | Not possible — the fingerprint/face dialog is owned by the OS (via BiometricPrompt) | Not possible — the browser/OS draws its own WebAuthn UI (e.g. macOS's Touch ID sheet) |

**On "beautiful Face ID/fingerprint animation":** neither iOS nor Android nor any browser lets an app skin, replace, or animate the system biometric prompt itself — that UI is drawn entirely by the OS for good reason (so a malicious app can never spoof it). What an app *can* control is everything around it: the moment the prompt is triggered, the transition into/out of the lock screen, and the messaging on success/failure. This round didn't add new custom transition animations (the existing lock/unlock screen transitions were left as-is, no regressions introduced), but no version of "custom Face ID animation" as literally requested is achievable on any platform — worth being direct about rather than claiming otherwise.

## Deliberately not built, and why

- **Per-module unlock (chats/vault/HR/CRM/Finance/Settings each independently biometric-gated).** HR and CRM only exist in the web app (mobile's scope has always excluded them, confirmed in an earlier round); there is no "Finance" module anywhere in this product; and Secure Vault is a narrow, already-working concept (a per-message reveal gate), not a whole app section. Building six independently-gated compartments would mean repeated Face ID prompts switching between a chat and Settings in the same session — worse UX than every real product in this category (Teams/Slack/Signal all gate at the app level plus targeted step-up on specific actions, never per-screen) — so that's the model this round built instead.
- **"Approve payments."** There is no in-app payment/card-entry flow — Paystack's hosted checkout handles the actual money movement entirely outside this app, consistent with this app never being allowed to touch payment credentials directly. There's nothing to gate beyond the *button taps* that start/cancel a subscription, and mobile has no billing screen at all yet (web-only today), so this wasn't wired this round.
- **"Approve workspace deletion."** No workspace-deletion feature exists in the product. Building a step-up gate for an action that doesn't exist would mean fabricating the action too — out of scope for an auth round.
- **Server-enforced step-up.** `requireStepUpForSensitive` is stored and returned to clients but nothing server-side currently rejects a request for lacking a step-up confirmation — see the Security review section above.
- **Root/jailbreak detection.** Flagged as a gap in the previous device-trust round too — needs a native dependency (`jail-monkey` or similar) plus an EAS rebuild, a deploy step this environment can't perform or verify.
- **True idle-while-foregrounded detection on mobile** (as opposed to time-since-backgrounded). Would require wrapping the entire app tree in a capture-phase touch listener; the device's own screen-lock timeout already handles real foreground inactivity in practice.

## Testing plan

What was actually run and passed in this environment:
- `node --check worker.js` — passes.
- Extracted and `node --check`'d all 8 inline `<script>` blocks in `index.html` — passes, zero errors.
- `npx tsc --noEmit` in `mobile-app/` — two errors present, both pre-existing and unrelated to any file touched this round (`app/chat/[id].tsx`'s attachment-type narrowing, `CallOverlay.tsx`'s `StyleSheet.absoluteFillObject`).
- Manually traced every new endpoint (`/org/security-policy`, `/devices/local-security-event`'s new event types) from outer `/api/*` proxy → Registry DO handler → response shape, and cross-checked every client call site against the server's actual field names.

What this environment cannot do, and would need a real device/deployment pass before calling this shipped:
- **Actual biometric hardware interaction** — Face ID/Touch ID/fingerprint prompts, Secure Enclave/Keystore behavior, and enrollment-change detection all require a real device (or at minimum an iOS Simulator/Android Emulator with biometric enrollment simulated) — none of this can be exercised in a sandboxed environment with no device.
- **Cross-platform timing verification** — confirming the inactivity timer actually fires within a reasonable margin of the configured tier on both a real background app and a real backgrounded browser tab, across both iOS and Android's differing background-execution limits.
- **WebAuthn passkey relock end-to-end** — needs a browser with a real registered platform authenticator (Touch ID on an actual Mac, or Windows Hello) to click through; can't be simulated headlessly.
- **Org policy propagation timing** — confirming a freshly-saved stricter org policy is picked up by an already-open client within one `/session` refresh cycle, across multiple simultaneously-signed-in devices.
- **Accessibility pass with a real screen reader** (VoiceOver/TalkBack) — `accessibilityLabel`/`accessibilityState` were added to the new toggle and timeout-tier controls, but real assistive-technology verification needs a physical run-through, not a static code check.

Recommended before considering this production-ready: a manual QA pass on one real iOS device and one real Android device covering enrollment/de-enrollment of biometrics, airplane-mode unlock, backgrounding across each timeout tier, and the org-policy-override path with two test workspaces set to different minimums.
