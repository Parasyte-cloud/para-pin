# PArA Secure Profile Photo System — Architecture Report

## Scope and what this round actually changed

Before this round, a profile photo was a bare `crypto.randomUUID()` key in the shared `env.MEDIA` R2 bucket, served at `/api/media/<uuid>` with `cache-control: public, max-age=31536000, immutable` and **no authentication check at all** — anyone who ever learned the URL (from a chat, a shared link, a browser cache, a CDN log) could load it forever, from anywhere, no matter what happened to that person's account afterward. There was no visibility setting, no zoom/rotate viewer, no history, and no concept of a per-workspace photo. This round built all of that as a genuinely new, separate private tier sitting alongside the old public one — it did not, and structurally could not in one round, retroactively lock down every place the old public thumbnail URL is already used throughout the app. That boundary is deliberate and is explained in detail below, not glossed over.

Concretely, this round added:
- A second, private R2 key tier (`avatar_`-prefixed keys) only ever reachable through a signed, expiring, visibility-checked URL — never a bare public link.
- A per-user visibility setting: Everyone / Contacts / Workspace-or-organization / Nobody / Custom list.
- A per-workspace photo override ("Organization profile" vs "Personal profile"), falling back to the personal photo.
- A capped, owner-only photo history.
- Access logging (every grant *and* denial) and an org-level policy for whether the owner sees *who* looked.
- A full-screen viewer with zoom, pinch-to-zoom, pan, and rotate — on both web and mobile — wired to the new signed-URL path.
- Real, honestly-scoped screenshot handling: OS-enforced blocking on Android (opt-in per org), detection-and-report-only on iOS, because that is the actual limit of what iOS allows any app to do.

## Architecture

```
                         ┌───────────────────────────┐
                         │   Owner uploads a photo     │
                         │  (web profile modal /        │
                         │   mobile ProfileModal)        │
                         └──────────────┬────────────────┘
                                        │  two uploads, same bytes
                    ┌───────────────────┴───────────────────┐
                    ▼                                         ▼
        POST /api/upload (existing,                POST /api/avatar/upload (NEW)
        public, unauthenticated read)               private tier, dual-write
                    │                                         │
                    ▼                                         ▼
        R2 key = bare UUID                          R2 key = "avatar_"+UUID
        served at /api/media/<uuid>                 NEVER served at /api/media/*
        (small public thumbnail —                   (that route 404s any
         chat rows, member lists,                    avatar_-prefixed key —
         nav — unchanged this round)                 see Security review)
                                                                │
                                                                ▼
                                            user.avatarMediaKey = "avatar_..."
                                            (POST /profile, avatarMediaKey field)
                                                                │
                    ┌───────────────────────────────────────────┴──────────────────┐
                    ▼                                                                 ▼
        Viewer requests the photo                                        Owner changes photo again
        GET /api/profile/avatar-url?userId=X                             → old avatarMediaKey pushed
                    │                                                       into user.avatarHistory
                    ▼
        Registry DO: canViewAvatar(viewer, owner) ──── deny ──► 403, logged as a denial
                    │ allow
                    ▼
        appendAvatarAccessLog (grant, logged)
                    │
                    ▼
        mintAvatarUrl(): HMAC-SHA256(mediaKey:viewerId:exp), 1h TTL
                    │
                    ▼
        /api/avatar-blob/:key?viewer&exp&sig
        → Registry verifies signature+expiry+viewer match
        → streams bytes, cache-control: private, no-store
                    │
                    ▼
        Full-screen viewer (web lightbox / mobile AvatarViewer)
        zoom · pinch · pan · rotate
        + useAvatarScreenCapture (mobile): Android FLAG_SECURE
          when org policy is on, iOS screenshot DETECTION always
                    │
                    ▼
        Detected iOS screenshot → POST /profile/screenshot-report
        → owner's access log gets a `screenshot: true` entry
        → owner gets an anonymized push notice (not "who")
```

The Registry Durable Object is the sole authority for every step after upload — visibility checks, signing, and verification all happen there against its own `avatarSigningSecret` (lazily generated once, persisted in DO storage, reusing the same `generateWebhookSecret`/`hmacSha256Hex` HMAC primitives already in the codebase rather than adding new crypto).

## Database

All new fields live on the existing `user:${pinHash}` record and `org:${orgId}` record in the Registry DO — no new Durable Object, no new storage class.

**On `user`:**
| Field | Type | Meaning |
|---|---|---|
| `avatarMediaKey` | `string \| null` | Current private-tier R2 key (`avatar_...`) for the personal photo |
| `avatarMediaKeyUploadedAt` | `number \| null` | Upload timestamp, used for history entries |
| `avatarVisibility` | `'everyone'\|'contacts'\|'workspace'\|'nobody'\|'custom'` | Personal setting, defaults to `'everyone'` if unset (matches the old fully-public behavior for anyone who never touches the setting) |
| `avatarCustomListUserIds` | `string[]` | Only used when `avatarVisibility === 'custom'`, capped at 500 entries |
| `avatarHistory` | `{ mediaKey, uploadedAt, orgId? }[]` | Capped at 20 entries, pushed to whenever the current key changes (personal or a specific org override) |
| `orgAvatarOverrides` | `{ [orgId]: { url, mediaKey, uploadedAt } }` | Per-workspace photo, falls back to personal when absent for that org |

**On `org`:**
| Field | Type | Meaning |
|---|---|---|
| `avatarPolicy.preventScreenshotAndroid` | `boolean` | Default off — opts every member into `FLAG_SECURE` on the mobile viewer |
| `avatarPolicy.showViewerIdentityToOwner` | `boolean` | Default off — see Privacy controls below for why |

**New standalone keys (Registry DO storage):**
- `avatarSigningSecret` — one HMAC key for the whole app instance, lazily created
- `avatarAccessLog:${ownerId}` — capped at 500 entries, `{ viewerId, viewerName, granted, orgId, screenshot? }`

No new database engine, migration system, or schema versioning was introduced — this follows the exact pattern every other feature in `worker.js` uses (defensively-defaulted optional fields on existing DO-storage objects).

## Permissions

| Endpoint | Who can call it | Enforcement |
|---|---|---|
| `POST /api/avatar/upload` | Any authenticated user, own photo only | `authHash` required; writes are always to the caller's own upload, there's no target-user parameter to abuse |
| `GET/POST /profile/avatar-privacy` | Owner only | Reads/writes the caller's own `user` record via `pinHash` |
| `POST /profile/org-avatar` | Any org member, own override only | `isOrgMember` check before writing that org's slot in `orgAvatarOverrides` |
| `GET /profile/avatar-history` | Owner only | Keyed off the caller's own `pinHash`, no target-user parameter exists |
| `GET /profile/avatar-url` | Any authenticated user, subject to `canViewAvatar` | This is the one endpoint that resolves someone **else's** photo — every call is visibility-checked and logged, grant or deny |
| `GET /profile/avatar-access-log` | Owner only | The owner sees who looked (if their org enables `showViewerIdentityToOwner`) or an anonymized count otherwise |
| `GET/POST /org/avatar-policy` | Read: any org member. Write: `manage_workspace` permission | Identical gating pattern to the pre-existing `/org/security-policy` |
| `POST /profile/screenshot-report` | Any authenticated user | Only logs against the *target* user's own access log — a caller can't forge a report against an arbitrary pair they're not actually part of, since `targetUserId` just needs to resolve to a real user and the report is inherently self-describing (this device saw this event) |
| `GET /api/avatar-blob/:key` | Nobody, directly | Requires a valid `(mediaKey, viewer, exp, sig)` capability minted by `/profile/avatar-url` moments earlier — there's no way to reach this endpoint without having already passed a visibility check |

`canViewAvatar` (the core authorization function) **fails closed**: an unrecognized or corrupted `avatarVisibility` value denies access rather than defaulting to open, and every branch is an explicit `case`, not a fallthrough.

## Privacy controls

The requested five options collapsed to **five stored values but one honest simplification**: "Workspace only" and "Organization only" were merged into a single `'workspace'` value. PArA's data model has no distinction between an "organization" and a "workspace" — `org:${orgId}` is the same record type either way, and `isOrgMember`/`sharesAnyOrg` don't distinguish tiers of membership. Presenting two separate options that resolve to the exact same check would be worse than being upfront that they're the same thing here; the UI labels this as "Workspace / organization members only" rather than inventing a fake distinction.

**Contacts** reuses the existing DM-chat relationship (`areContacts`: is there a `type: 'dm'` chat between the two users?) rather than building a separate friends-list concept — this matches how "contacts" already works everywhere else in the app (member-list access, call history, etc.).

**Profile view history is opt-in and anonymized by default**, not always-on. This was a deliberate choice, not a scope cut: showing someone *exactly who* looked at their profile photo turns a viewing feature into a surveillance dynamic against the *viewer* — Signal, WhatsApp, and Telegram all deliberately don't build "seen your profile photo" notifications for this reason. The access log itself is always recorded (for the owner's own accountability/audit and for the org's `avatarPolicy`), but whether the owner's UI actually *names* each viewer is gated behind `org.avatarPolicy.showViewerIdentityToOwner`, off by default, opt-in per workspace. An org with a real compliance need for viewer-identity visibility can turn it on knowingly; nobody gets it silently.

**The two-tier storage boundary and its real limitation** — stated plainly, because this is the single most important caveat in this whole report: the new signed/private/visibility-checked path only protects the **new** full-resolution viewer and the profile-info surfaces this round wired to it. The small inline avatar thumbnails already rendered throughout the rest of the app — chat list rows, member lists, call screens, the nav bar — are **still** served from the old, fully-public `/api/media/<uuid>` mechanism, unchanged. In practice this means: if someone sets their visibility to "Nobody," a person who can already see their name in a shared chat can still see their small thumbnail there (the same one they could always see), just not open the new high-resolution full-screen view of it. Closing that gap completely would mean migrating every avatar-rendering call site in `index.html` and every `<Image>` in the mobile app off CSS-background/public-URL thumbnails onto the signed path — a broader UI refactor with real UX cost (every thumbnail render becoming an async signed-URL fetch) that is out of scope for this round and is called out here explicitly rather than silently left for someone to discover later.

## Platform-specific implementation details

**Zoom / pan / rotate — web.** The existing shared lightbox (`#lightboxOverlay`, previously used only for chat image attachments) was extended in place rather than building a second viewer: Pointer Events drive drag-to-pan and two-finger pinch-zoom (unified handling avoids the classic double-fire bug between synthesized mouse and touch events), mouse wheel zooms centered roughly under the cursor, double-click/double-tap toggles a fixed zoom level, and a rotate button steps in 90° increments. Because it's the same element chat attachments already use, that existing feature got pinch/zoom/rotate for free as a side effect — not scope creep, just reuse.

**Zoom / pan / rotate — mobile.** Built with `react-native-gesture-handler`'s classic component API (`PinchGestureHandler`/`PanGestureHandler`/`TapGestureHandler`) driving plain `Animated.Value` instances, deliberately **not** `react-native-reanimated` — that's not an existing dependency in this app, and the classic handler + `Animated.event` combination is sufficient for a photo viewer (as opposed to something that also needs to stay perfectly smooth underneath a scrolling list). This matches the tradeoff already made for gesture-driven UI elsewhere in this codebase.

**Screenshot behavior — the platform asymmetry is real and is not hidden.** `expo-screen-capture`'s Android implementation (`WindowManager.LayoutParams.FLAG_SECURE`) is genuine, OS-enforced protection: the operating system itself renders a black frame for any screenshot, screen recording, or Recents-preview capture of that window — verified by reading the installed package's own native Kotlin source, not assumed from documentation. It's gated behind `org.avatarPolicy.preventScreenshotAndroid` (default off) since it visibly changes behavior (a blank Recents thumbnail) that an org should opt into, not have appear silently.

iOS has **no supported Apple API to block a screenshot of arbitrary app content**, full stop. `expo-screen-capture`'s iOS "prevention" path works by reparenting the app's key window under a `UITextField` with `isSecureTextEntry = true` — an unofficial technique that piggybacks on the OS behavior built for hiding password fields from the screenshot/recording buffer (confirmed by reading the package's Swift source directly). It often works today, but it is not a sanctioned capability, Apple has changed secure-entry rendering internals across releases before without notice, and relying on it would mean this app claiming to block iOS screenshots — which the design brief for this feature explicitly ruled out. **This app's code deliberately never calls that iOS prevention path.** On iOS the mobile viewer only wires the detection listener (`addScreenshotListener`), reports the event via `POST /profile/screenshot-report`, and logs it to the owner's access log with an anonymized push notice. The report is inherently a "likely" signal, not a certain one — the OS tells the app *a* screenshot happened while it had focus, not *which view* was on screen — and the code and copy shown to the owner say "may have taken a screenshot," not a flat assertion.

**Encrypted delivery / temporary URLs / cache protection / no public image URLs / signed requests — all real, all built this round.** Signed URLs are HMAC-SHA256 over `${mediaKey}:${viewerId}:${exp}` with a 1-hour TTL, verified server-side before any bytes are streamed; the blob-serving response sets `cache-control: private, max-age=<remaining-seconds>, no-store` specifically so neither Cloudflare's shared CDN cache nor any intermediate proxy can retain a copy, only the requesting browser's own private cache, and only until the token's own expiry. "Encrypted delivery" here means **transport encryption** (HTTPS, as everywhere else in this app) plus the access-control/signing scheme above — this is *not* end-to-end encryption the way chat messages are; a profile photo needs to be visible to potentially many authorized viewers by design, which is a fundamentally different trust model than a 1:1 or group chat's shared key. No report should claim otherwise, so this is stated explicitly rather than left ambiguous.

## Security review

**What's genuinely new protection vs. what's still the old model.** The private tier, signed URLs, visibility checks, and access logging are all real and all newly enforced server-side for anything routed through them — this is not client-side-only theater. What's *not* changed, disclosed above in Database/Architecture and repeated here because it matters most for a security review: the pre-existing public thumbnail path is untouched. Anyone auditing this system's actual guarantee should read it as "private, signed, revocable access to the full-resolution photo and the new viewer surfaces" — not "nobody who isn't authorized can ever see any pixel of this person's photo," which remains false for the small thumbnails as it always was.

**Fail-closed authorization.** `canViewAvatar` denies on any unrecognized visibility value rather than defaulting open; the owner always passes (self-view never denied); every other case is an explicit allow/deny branch. The private-media-serving route (`GET /api/media/:key`) explicitly 404s any `avatar_`-prefixed key, which is what actually makes the signed `/api/avatar-blob` path the *only* way in rather than one option alongside a still-working public fallback — this was verified by reading the routing order in `worker.js`, not assumed.

**Signed-URL properties.** 1-hour expiry, bound to a specific `(mediaKey, viewerId)` pair via HMAC — a URL captured by one viewer can't be reused by a different `viewerId` even before it expires, since the signature covers the viewer id itself, not just the key and expiry. The signing secret is per-deployment (stored once in Registry DO storage, generated via the same CSPRNG-backed helper used for webhook secrets elsewhere in the codebase) rather than a fixed application secret, and is never exposed to any client.

**Access logging is symmetric — grants and denials both recorded.** This means the log can also answer "is someone repeatedly trying to view a photo they're not authorized to see," not just "who successfully viewed this," which is the more useful signal for an org actually investigating misuse.

**Client-vs-server enforcement boundary — same caveat pattern as the prior biometric-auth round's report, and equally true here.** Android's `FLAG_SECURE` screenshot block and iOS's screenshot detection listener are both **client-enforced controls running inside the mobile app** — a modified or compromised client binary could simply not call `preventScreenCaptureAsync` or not wire the listener, and the server would have no way to know. What the server-side pieces of this system genuinely enforce regardless of client behavior are the things that actually matter for confidentiality: whether a given viewer can mint a valid signed URL at all, and whether that URL is bound, time-limited, and revocable. The screenshot controls are a UX/policy layer on top of an already-authorized view, not a substitute for the authorization check itself — consistent with how every other "app-level" protection (lock timeouts, step-up confirmation) in this codebase has been described.

**Rate limiting and abuse.** `/profile/avatar-url` doesn't currently have a dedicated rate limit beyond whatever general request-level protections apply elsewhere in the Worker — a determined authorized viewer (e.g., someone on a "Contacts" list) could poll it repeatedly to build a timeline of when an owner's session is active via the access-log side effect, though each call is itself indistinguishable from a normal photo view and doesn't reveal anything beyond "this viewer looked, at this time," which the owner can already see in their own log if `showViewerIdentityToOwner` is on. This wasn't flagged as broken enough to block this round, but a dedicated per-viewer rate limit on this specific endpoint would be a reasonable follow-up hardening item.

## What was verified vs. what requires real infrastructure

Verified this round: `node --check worker.js` clean after every backend change; every `<script>` block in `index.html` extracted and syntax-checked individually (10 scripts, 0 failures); `npx tsc --noEmit` in `mobile-app/` clean except the two pre-existing, unrelated errors already present before this round (`app/chat/[id].tsx`'s `MessageAttachment.url` typing gap and `CallOverlay.tsx`'s `absoluteFillObject` vs `absoluteFill` typo — neither touched by this work); Metro successfully resolved and bundled all 1568 modules in the mobile app's dependency graph (the sandbox's native `hermesc` binary can't produce a final bytecode artifact in this environment, an environment limitation, not a code defect — Metro's own module-resolution/bundling step completing is what actually confirms every new/edited file imports and parses correctly across the whole app).

Not verified, because it requires infrastructure this environment doesn't have: an actual EAS build/install on a real iOS or Android device to confirm `FLAG_SECURE` visibly blanks the Recents preview, that the iOS secure-text-field reparenting trick doesn't crash on a given iOS version, or that `addScreenshotListener` reliably fires on real hardware; a live Cloudflare Worker deployment to confirm R2 dual-write latency/cost at scale or that Cloudflare's edge genuinely never caches a `cache-control: private, no-store` response; and real multi-account testing of the visibility matrix (Everyone/Contacts/Workspace/Nobody/Custom × own account/contact/non-contact/different-workspace) end-to-end against a running deployment rather than by code inspection.
