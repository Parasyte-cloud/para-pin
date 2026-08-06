# PArA Calls & Meetings — Production Readiness Audit (Round 2)

This continues `CHAOS_ENGINEERING_AUDIT.md` (reconnect storms, meeting duplicate-join races, ICE restart, signal retries, mobile socket staleness — already fixed and documented there, not repeated here) into territory that round didn't cover: Durable Object lifecycle, host controls, abuse protection, memory leaks over long sessions, TURN correctness, and observability. Same ground rules as last time, stated plainly again because they matter more this round, not less: this is a code-level audit with syntax/type verification on everything touched, not a live chaos run. I did not spin up real multi-party WebRTC sessions, did not test real Bluetooth/AirPods/carrier hardware, and cannot produce a real call-success-rate percentage — there is no production traffic to measure. Where the ask genuinely requires that (scale testing, 8-hour soak runs, a full automated E2E suite, real-device QA), that's called out explicitly below as what it is: work for you to run with real infrastructure and real devices, with a concrete plan for how, not a number I invented.

## Findings

### 1. Ghost/zombie participants in meetings — no dead-socket detection

**Severity:** High.
**Root cause:** `MeetingRoom` doesn't use Cloudflare's hibernatable WebSocket API — a socket only leaves the room when its `close`/`error` event fires. An app killed outright (not backgrounded), a network black hole, or certain OS-level connection drops never fire that event. The participant sits in `sessions` looking permanently "live" to everyone else with no way to clear it short of the whole Durable Object being evicted for unrelated reasons.
**Affected files/components:** `worker.js` — `MeetingRoom` class.
**Why it happens:** WebSocket `close`/`error` are best-effort browser/runtime events, not guaranteed delivery — this is a documented gap in raw WebSocket semantics generally, not specific to Cloudflare.
**Fix:** Every participant already pings its presence socket every 20s. Added `sweepGhosts()`: tracks `lastPingAt` per session, evicts (closes, removes from roster, broadcasts a real `participant-left`) anyone silent past `PRESENCE_STALE_MS` (50s — the same constant and 2.5x-ping-interval reasoning `UserChannel`'s existing presence sweep already uses). Runs on every ping received and on every new join, so as long as one real participant remains, ghosts clear within one ping cycle.
**Architecture improvement:** The durable fix is migrating to the hibernatable WebSocket API (`state.acceptWebSocket()` + `webSocketMessage`/`webSocketClose` handlers), which gives Cloudflare-guaranteed close delivery and lets idle rooms actually hibernate instead of staying pinned in memory. That's a larger, riskier change (different event wiring, different DO billing/lifecycle behavior) — flagging it as the real long-term fix rather than doing it in this pass.
**Testing strategy:** Manual: join a meeting from two tabs, force-kill one (not close cleanly — kill the browser process or airplane-mode the device), confirm the other tab drops that tile within ~50-70s without needing a refresh.
**Regression risk:** Low — purely additive; the sweep only ever removes sessions that are already provably silent past the threshold, never touches a live one.
**Verification steps:** `node --check worker.js` passes. Live verification requires the manual test above against a deployed instance.

### 2. No rate limiting on inbound call/meeting rings

**Severity:** High (abuse/harassment vector + shared push-quota risk).
**Root cause:** `/call-signal` broadcast every signal kind unconditionally. Any authenticated account could POST an unbounded stream of `offer`/`meeting-invite` signals at a specific target, each one triggering a real OS push (APNs/FCM/Web Push) — a way to flood one person's phone with fake incoming-call rings, and to burn through the whole deployment's shared push-provider quota doing it.
**Affected files/components:** `worker.js` — `UserChannel.fetch`, `/call-signal` handler.
**Why it happens:** No abuse protection existed on this path at all, unlike most other write endpoints in this codebase which already use the established `checkRateLimit` helper.
**Fix:** Rate-limited specifically on `kind === 'offer' || kind === 'meeting-invite'` (the two kinds that actually cause a ring) — 20 attempts/minute per recipient, using the DO's own storage (already scoped to one user). Deliberately does *not* rate-limit `ice-candidate`/`answer`/`end`/`ice-restart-*` — those are legitimate, necessarily high-frequency traffic inside a call the recipient already answered.
**Architecture improvement:** None needed beyond this — the existing `checkRateLimit` primitive was the right tool, just not applied here yet.
**Testing strategy:** Script 25 rapid `offer` signals at one recipient in under a minute, confirm the 21st+ get `429 rate_limited` and the recipient's device never rings for those.
**Regression risk:** Low. 20/minute is generous for any legitimate rapid-redial pattern; a real user hanging up and immediately calling back a handful of times in a minute is nowhere near the limit.
**Verification steps:** `node --check worker.js` passes.

### 3. TURN-not-configured signal computed but discarded client-side

**Severity:** Medium (directly affects the exact scenarios the mission called out: symmetric NAT, corporate firewalls — enterprise customers are the ones most likely to sit behind exactly this).
**Root cause:** `/api/calls/ice-servers` already computes and returns a definitive `turnError` (e.g. `'turn_not_configured'`) — the server knows for certain. Both clients fetched it and threw it away, only ever showing a generic post-timeout guess ("this usually means...") after a full ~15s connection attempt had already failed.
**Affected files/components:** `index.html` (`getIceServers`, `startAwaitingConnection`), `mobile-app/src/state/callSignal.ts` (`getIceServers`), `mobile-app/src/state/call.ts` (`startAwaitingConnection`).
**Fix:** Cached `turnError` alongside the ice servers on both platforms; the connect-timeout message now distinguishes "TURN genuinely isn't configured on this deployment, ask your admin" (definitive) from "TURN lookup failed just now, probably temporary" (transient) from the old generic guess (only when the server-side answer itself is unknown).
**Architecture improvement:** Worth surfacing `turnError` proactively in the admin console (PArA Ops) too, so an admin discovers "TURN isn't set up" before their first enterprise customer's call fails behind a firewall, rather than after. Not built this round — that's new UI, and the brief was explicit about not redesigning UI before reliability is solid. Flagged as the natural next step once this pass is deployed and stable.
**Testing strategy:** With `CF_TURN_KEY_ID`/`CF_TURN_API_TOKEN` unset, place a call between two networks that can't reach each other directly (or force it by blocking UDP host/srflx candidates), confirm the specific "TURN not configured" message appears instead of the generic one.
**Regression risk:** None — text-only change to an existing error path.
**Verification steps:** `node --check worker.js`, inline-script syntax scan, and `tsc --noEmit` on the touched mobile files all clean.

### 4. Zero observability for the entire realtime stack

**Severity:** High for operability — this is the one that makes every other finding's promise ("every failure should be reproducible") actually true or false. Before this pass, `worker.js` had exactly one `console.log` in the whole file, for hostname-branding debug — nothing for calls or meetings at all. A production incident ("customer X's calls kept failing last Tuesday") had zero server-side trail to investigate from.
**Root cause:** No logging was ever added as call/meeting features were built.
**Affected files/components:** `worker.js` — new `logRealtime()` helper; call sites added in `UserChannel`'s `/call-signal` and `/api/calls/ice-servers`, and `MeetingRoom`'s join/leave/ghost-sweep/room-full paths.
**Fix:** One structured, single-line JSON log per event (`console.log('[realtime]', JSON.stringify({...}))`), greppable via `wrangler tail | grep '\[realtime\]'` or a Logpush filter on the same tag. Covers: every offer/answer/end/restart/busy signal (with `callId`, kind, reason), rate-limit trips, TURN availability per ice-servers request, and meeting join/leave/ghost-eviction/room-full-rejection (with `meetingId`, `userId`, resulting room size). Deliberately excludes per-ICE-candidate logging — legitimately many-events-per-second-per-call, adds volume without adding diagnostic value.
**Architecture improvement:** This is `console.log`-based, which means `wrangler tail` (live) or whatever Logpush destination you wire up (historical). For real dashboards/alerting/success-rate math, the next step is a Cloudflare Analytics Engine binding (or an external sink via Logpush) that aggregates these same events into queryable metrics — genuinely the only way to ever produce a real "99.9%" number, and something I can't wire up from this sandbox since it needs a `wrangler.jsonc` binding change and a live deploy to provision.
**Testing strategy:** `wrangler tail` while placing a call and joining/leaving a meeting; confirm every expected event line appears with correct fields.
**Regression risk:** None — logging is side-effect-free with respect to actual call/meeting behavior; every `logRealtime` call is wrapped in try/catch.
**Verification steps:** `node --check worker.js` passes.

## Confirmed already solid (verified, not changed)

`MeetingRoom` uses zero persistent storage — everything lives in the in-memory `sessions`/`userSessions` Maps. That means a Worker/DO restart loses nothing durable to clean up; an idle room with no live sockets just isn't kept warm by anything, which is correct garbage collection, not a leak. Verified by grepping the entire class for `state.storage` — zero hits.

Memory leak sweep across both platforms' call and meeting code (repeated join/leave cycles specifically, since that's what an 8-hour meeting or a heavy caller's day actually stresses): every `setInterval`/reconnect timer/`RTCPeerConnection`/`MediaStream`/`AudioContext` created during a call or meeting is torn down on every exit path, including the dedup Sets (`meetingPulledTracks` on web, `pulledTracks` on mobile) that gate re-pulling tracks — both already reset on `leaveMeeting()`, so rejoining any meeting starts clean rather than inheriting stale dedup state from a previous one.

TURN/STUN wiring itself is genuinely well-built: two STUN fallbacks always present, real Cloudflare Realtime TURN credentials fetched dynamically when configured, both known response shapes handled, and the documented Cloudflare caveat (port-53 URLs silently time out in browsers) already filtered out. The only real gap was the discarded `turnError` signal, fixed above.

## Reported, not built this round (explicitly out of scope per "don't redesign UI first")

**No host controls exist at all** — no mute-all, no remove-participant, no host transfer, no waiting room/lobby. Confirmed by grepping the entire backend for any of these; zero matches. For a platform aiming at Teams/Zoom/Meet-level reliability, "remove participant" in particular is closer to a trust-and-safety requirement than a nice-to-have — without it, a host's only recourse against a disruptive or compromised participant is ending the meeting for everyone. Every one of these needs real UI (participant-list context menus, permission gating, confirmation dialogs) to be usable, which is exactly what the brief said to hold off on. Flagging this as the most important product decision to make once reliability work is done, not something I built blind against an explicit instruction not to touch UI first.

**No rate limit on meeting-room join-attempt churn itself** (only on the ring-triggering signals above) — lower severity, since it requires a real authenticated org member spamming their own meeting room, and the blast radius is mostly that room getting noisy, not a cross-tenant DoS. Worth adding if abuse is ever actually observed; not pre-built speculatively.

**No client-side crash/error telemetry** for WebRTC failures (a getUserMedia rejection, an ICE failure the user never reports) — everything above is server-side. Wiring a client-side error beacon is a legitimate, separate piece of infrastructure (new endpoint, new client SDK-equivalent), not something to fold into this pass.

## What requires real infrastructure and real devices — and how to actually get it

**Call/meeting success rate ≥99.9%.** Not measurable without production traffic. The `logRealtime` events added this round are exactly what makes this measurable *once you have traffic*: pipe them to Logpush or an Analytics Engine binding, compute `answered/connected ÷ offer` and `meeting_join ÷ meeting_join_rejected+failures` over a real rollout window. Anything short of that is a fabricated number, so I didn't invent one.

**Multi-participant scale (5/10/25/50/100).** Cloudflare Calls' SFU architecture is specifically what makes this scale on the media-plane side (fan-out happens on Cloudflare's infrastructure, not peer-to-peer) — that part is architecturally sound already. What I can't verify from here is client-side rendering/CPU/battery behavior with 50-100 live tiles, or whether your specific Cloudflare Realtime plan/quota actually supports your target concurrent-participant count. Recommend a real internal load test (a room full of real or scripted browser tabs) before advertising any specific participant cap, and confirming your Cloudflare account's actual provisioned limits.

**Real hardware chaos** — Bluetooth/AirPods connect mid-call, headphones unplugged, phone-call interruption, screen lock across different OEM Android skins. This genuinely varies by manufacturer in ways no code review can predict; recommend a small real-device QA matrix (a handful of iOS + Android devices spanning a couple of OS versions each) explicitly running through this exact interruption list before launch.

**8-hour soak / memory-leak testing.** The code-level teardown audit above passed for every reachable path, but that's necessary, not sufficient — only a real multi-hour run with a heap profiler attached (Chrome DevTools Memory tab for web, Xcode Instruments / Android Studio Profiler for mobile) proves it holds in practice. Recommend one supervised long meeting with profiling on as a pre-launch gate.

**A full automated E2E suite for the 25 scenarios listed** (call setup, reconnect, network switching, browser refresh, large meetings, repeated calls, 8-hour meetings, stress testing...). Building a real WebRTC-capable browser-automation harness — two headless browser instances actually negotiating a live peer connection, with real traffic-shaping for packet loss/latency injection — is a legitimate multi-day infrastructure project in its own right, not something to claim was done in this pass. Playwright (which can drive real Chrome instances with real WebRTC stacks, and read `getStats()` for connection-quality assertions) plus OS-level traffic shaping (`tc`/Network Link Conditioner) is the right toolset; scoping and building that harness is a concrete next project, not a checkbox I can tick from a code-only sandbox.
