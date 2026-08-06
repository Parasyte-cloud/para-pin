# PArA Realtime Platform — Chaos Engineering Audit

Scope note up front: this was a code-level fault-injection audit, not a live chaos run against production. I traced every reconnect, ICE, Durable Object lifecycle, and dedup path in `worker.js`, `index.html`, and `mobile-app/src` against each failure scenario below, fixed the gaps that trace showed were real, and verified every touched file still parses cleanly (`node --check` on the backend and every inline script, `tsc --noEmit` on the mobile app). I did not — and structurally cannot, from this sandbox — toggle airplane mode on two real phones mid-call or run `wrangler deploy` against your live Cloudflare account while a call is in progress. Where that matters, it's called out below as a recommended real-world smoke test rather than something I'm claiming to have verified.

## Already solid before this pass

A few things worth stating plainly rather than implying everything was broken: message delivery already dedups by ID on both platforms (`mergeMessages`), so a message arriving twice (WS + resync) never double-renders. Meeting track-pulls already dedup by `userId|trackName`, so a reconnect re-announcing the same tracks doesn't stack duplicate video elements. Every Durable Object here (`ChatRoom`, `UserChannel`, `MeetingRoom`) keeps its actually-important state in `state.storage`, not memory — the in-memory `sessions` Map is a pure live-broadcast convenience. That means killing a Worker or evicting a DO loses zero durable data; the next request just spins up a fresh instance that reads storage back in, and clients already reconnect their sockets on their own. ICE candidates arriving before a peer connection or remote description exists were already queued rather than dropped (fixed in an earlier round, reconfirmed correct here on both platforms). None of that needed touching.

## What was actually broken, and what I fixed

**Duplicate joins / reconnect storms / race conditions in group meetings.** `MeetingRoom`'s session map was keyed by WebSocket object, not by user. A reconnect race — flaky WiFi reconnecting before the old socket finished closing, a second tab, a presence-socket drop during a network switch — left two live entries for the same person, and whichever one closed first broadcast a false `participant-left` for someone still in the room. Everyone else's client would then rip out that person's live video/audio tile with nothing to bring it back except a fresh track event. Fixed in `worker.js`: a new socket for a userId that already has one now evicts the old session first, and the old session's own async close handler is marked so it doesn't announce a leave that isn't real.

**Reconnect storms.** The chat socket, the notify/call-signal socket, and the meeting presence socket all had deterministic backoff (1s, 2s, 3s... or a flat 2s forever on mobile's chat socket) with zero jitter. A Worker redeploy or a regional network blip drops every open socket at once; a fixed schedule means every client reconnects in the same synchronized waves instead of spreading out — the classic thundering-herd problem. Fixed on both platforms: every reconnect delay is now randomized across its full range (full jitter), not just a flat step.

**Dropped ICE candidates / offer / answer / packet loss during signaling.** `sendCallSignal` (both platforms) was fire-and-forget with zero retry — a single dropped POST during a live call permanently lost that candidate, offer, or answer with no recovery path. Fixed: up to two bounded retries on a genuine transport failure (network error or 5xx), short backoff between them. A real "recipient unreachable" still resolves exactly as before through the existing ring/connect timeouts.

**No automatic recovery from a failed ICE connection.** When `connectionState` hit `'failed'`, both platforms just ended the call outright — the user had to manually redial. Browsers/react-native-webrtc never self-heal from `'failed'` the way they sometimes do from a brief `'disconnected'`; it needs an application-level ICE restart. Added on both platforms: the original caller (a deterministic tie-breaker, so both sides don't race each other) sends a fresh offer with `iceRestart: true` the moment `'failed'` is seen, two new signal kinds (`ice-restart-offer`/`ice-restart-answer`) carry the renegotiation, and the existing grace-period timer gives it a window to land before falling back to the exact same `endCall('hangup')` as before. Worst case is unchanged; best case the call heals itself.

**Mobile chat socket had no dead-connection detection at all.** Unlike the notify socket (which already checked for silence before assuming a still-"OPEN" socket was actually alive), the per-chat WebSocket hook only reacted to a real `close`/`error` event. A carrier NAT timeout, screen lock, or WiFi-to-cellular handoff can leave a socket reporting `OPEN` while nothing arrives again — that case was invisible here. Fixed: the same staleness check the notify socket already had (40s of silence forces a reconnect), plus real growing+jittered backoff replacing the flat 2s-forever retry.

**Mobile app backgrounding had no foreground recovery trigger.** iOS/Android both suspend a backgrounded app's JS timers, so the heartbeat itself was frozen while backgrounded — there was no equivalent of the web app's `visibilitychange` handler forcing an immediate reconnect the moment the app comes back. Fixed: an `AppState` listener now forces the notify socket to reconnect right away on returning to foreground if it isn't already open, instead of waiting for the heartbeat to eventually notice.

**Mobile group meetings had no reconnect loop at all.** This one was flagged in the code itself as a known, explicit gap — a dropped presence socket during a meeting just left that device's presence stale until it explicitly left. Fixed: ported web's bounded-retry reconnect (jittered delay, gives up after a handful of attempts with a clear error rather than spinning forever), including re-announcing the still-live SFU session and published tracks on reconnect exactly like web already does.

## Scenario-by-scenario

Disconnect the network / lose connectivity / switch WiFi / switch to mobile — handled by the reconnect+backoff+jitter fixes above on every socket (chat, notify, meeting), on both platforms.

Delay messages / cause latency — message ordering already tolerant (sorted by timestamp, deduped by ID on arrival); signaling now has bounded retries rather than failing outright on a slow/lossy connection.

Drop ICE candidates / cause packet loss — signaling retry + ICE restart above; trickle-ICE was already queue-safe.

Kill Workers / restart Durable Objects — already correct by design (durable storage, no code change needed); recommend one real supervised test (a `wrangler deploy` mid-call) since this is the one category I can't exercise from here.

Refresh browsers / close tabs / switch devices / rotate phones / lock screens / background apps — covered by the mobile staleness/backgrounding fixes plus the web app's existing `visibilitychange` resync, which was already correct.

Cause duplicate requests / duplicate joins — the `MeetingRoom` session-eviction fix directly addresses this; chat message duplicates were already deduped by ID.

Cause reconnect storms — jitter added across every reconnect path on both platforms.

Cause race conditions — the meeting duplicate-join race is the concrete one this audit found and fixed; ICE offer/answer glare is avoided by the deterministic "only the original caller restarts" rule rather than left to chance.

## Deliberately not changed, and why

Plain chat message sends still have no auto-retry on failure — the text is preserved and a banner prompts a manual resend. This is a considered choice, not an oversight: there's no idempotency key on the send endpoint, so blindly auto-retrying a POST whose response was lost (but which may have actually succeeded server-side) risks a real duplicate message landing in a group chat, which is worse than asking the sender to tap again. If you want this auto-retried too, the right fix is adding a client-generated idempotency key the server dedupes on — that's a bounded follow-up, not something I did here since it touches the send endpoint's contract and deserved its own decision rather than folding it into a chaos-recovery pass.

The ICE-restart fix requires both call participants to be running the updated code. During a rolling deploy, a client still on the old build will just silently ignore the new `ice-restart-offer`/`ice-restart-answer` signal kinds (unrecognized kind, no handler) rather than error — it degrades to today's behavior (call ends, redial needed), not to something worse. Worth deploying web, mobile, and the backend together so the improvement actually takes effect for everyone at once.

## Verification performed

`node --check worker.js` and every inline `<script>` block extracted from `index.html`: clean. `npx tsc --noEmit` across the whole mobile app: two pre-existing errors remain (an attachment-type mismatch in `app/chat/[id].tsx` and a `StyleSheet.absoluteFillObject` typo in `CallOverlay.tsx`), both in files this pass never touched, confirmed unrelated by grepping the error output against the five files actually changed (`state/call.ts`, `state/callSignal.ts`, `state/meeting.ts`, `hooks/useNotifySocket.ts`, `hooks/useChatSocket.ts`) — zero errors there.
