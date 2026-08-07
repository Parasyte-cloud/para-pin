# PArA — Public Launch Readiness Review

Scope note, stated plainly because it matters more here than in any prior audit: this is a code-level review against the actual `worker.js`/`index.html`/`mobile-app` source and `wrangler.jsonc` config, not a live production readiness certification. I did not run load tests, did not deploy to a staging Cloudflare account, did not exercise real browsers/devices, and cannot produce uptime or error-rate numbers — there is no production traffic yet. Every finding below is either something I read directly in the code and verified (grep + line references, `node --check` where code changed), or explicitly labeled as something only real infrastructure/traffic can answer. Findings already covered in depth by `CHAOS_ENGINEERING_AUDIT.md` and `PRODUCTION_READINESS_AUDIT.md` (reconnects, ICE restart, ghost participants, call rate limiting) are referenced, not repeated.

**Verdict: not launch-ready. 2 Critical, 4 High.** Three of the six are fixable before tomorrow; the other three are real scope/infrastructure gaps that need an explicit launch-scope decision, not a quick patch.

---

## Critical

### C1. The CRM fix and the badge/pill fix are sitting uncommitted on disk — nothing has shipped

**Area:** Deployment / release process.
**What's true right now:** `git status` shows `index.html` and `worker.js` still modified against the last real commit (`80c382c`). Both attempted commits this session failed with `fatal: Unable to create '.../.git/index.lock': File exists` and the follow-up `git push` reported `Everything up-to-date` — meaning **the CRM deal/contact creation fix (C2 below) and the iOS pill-overflow/undefined-badge fix are not committed, not pushed, and not deployed.** If launch happens on the current deployed build, CRM add-deal and add-contact will still 400 on every attempt, exactly as they always have.
**Fix (you, not me):** a stale `index.lock` almost always means an earlier `git` process was killed mid-write, not that one is actually still running. Confirm nothing's running, then clear it:
```
ps aux | grep git        # confirm no real git process is running
rm /Users/sudo-su/para-pin/.git/index.lock
git add -A
git commit -m "Fix CRM deal/contact creation (field-name mismatch), surface errors on CRM move/delete, fix iOS pill overflow + undefined device badges, remove dead eager QR script loads, lazy-load chat images"
git push origin main
```
Then deploy (`wrangler deploy`, or whatever your CI does) and confirm `git log -1` on the deploy target matches the commit hash above before calling it launched.
**Severity justification:** Critical because it isn't a code defect — it's the difference between "fixed" and "believed fixed." Nothing else in this report matters if the build going out tomorrow doesn't actually contain today's fixes.

### C2. CRM deal and contact creation have been completely broken since the feature shipped

Already found, fixed, and verified this session (see prior message in this conversation for full root-cause writeup). Restated here only because it's a launch blocker on its own merits: **`crmSanitizeDeal` expected `name`, the client always sends `title`; `crmSanitizeContact` expected `firstName`/`lastName`, the client always sends one `name` field.** Every "Add Deal" and "Add Contact" click has always failed with `400 missing_name`. Fixed in the working tree; blocked from being live by C1.
**Regression test to run once deployed:** create a deal and a contact through the actual UI, confirm both appear on the board/list rather than showing a save error.

---

## High

### H1. No error tracking, no alerting, and almost no logging outside calls/meetings

**What I checked:** the entire 586KB `worker.js` contains exactly **3** `console.log`/`console.error`/`console.warn` calls total, all added in the prior chaos-engineering round and scoped only to call/meeting signaling (`logRealtime`). Auth, sessions, billing (Paystack webhooks), HR, CRM, admin actions, retention purge, and the birthday sweep have zero logging. There is no Sentry/Bugsnag/Datadog-equivalent wired into either the worker or the web app, and `wrangler.jsonc` has no Analytics Engine binding — so there is also no way to build a dashboard or alert off Cloudflare's own request-level data. Confirmed via `wrangler.jsonc` (`durable_objects`, `r2_buckets`, `ai`, `vars`, `triggers` are the only bindings present) and grep across `worker.js`.
**Why this is a launch blocker and not a nice-to-have:** if a Paystack webhook silently fails signature verification for a legitimate customer, if the retention cron throws halfway through, or if the birthday sweep starts erroring for large orgs (see H2), **you will not find out unless a customer tells you.** `ALERT_EMAIL` is set in `wrangler.jsonc` vars but nothing in the code actually sends to it — it's a configured destination with no sender.
**Minimum bar before tomorrow:** wrap the billing webhook handler, the CRM/HR mutation endpoints, and the two cron jobs in the same `logRealtime`-style structured `console.log`, greppable via `wrangler tail`. That gets you live visibility even without a dashboard. A real Analytics Engine binding + alerting is the correct follow-up but is new infrastructure (`wrangler.jsonc` binding + a live deploy to provision) I can't stand up from this sandbox.
**Severity:** High. Nothing here breaks a user-facing flow today, but it means every other bug in this app — known or not-yet-found — is invisible after launch.

### H2. Retention purge and birthday sweep are unbounded, sequential, whole-platform loops in a single cron invocation

**Location:** `worker.js`, `scheduled(event, env, ctx)` (~line 10474) and `Registry`'s `/internal/birthday-sweep` handler.
**What it does:** once daily, one Worker invocation lists every chat room on the entire platform and `await`s a Durable Object RPC per room, one at a time, in a plain `for` loop — then separately lists every org, and for every org iterates every member twice (once to compute HR-admin permissions, once to check each member's birthday), each check its own async storage read.
**Why it's a large-org/enterprise risk:** this is correct and fine at the platform's current size. It does not scale — Cloudflare Workers cron invocations have a wall-clock execution budget and Durable Objects impose a per-invocation subrequest ceiling; a sequential, unbatched loop across every chat room and every org member on the whole platform is exactly the shape of code that works in every test you'd run today and quietly starts truncating (some orgs never get their birthday check that day, some old messages never get purged) once the platform has enough orgs/chats to run past that budget mid-loop. Combined with H1 (no logging on this path), that failure would be **completely silent** — the `try/catch` around each job explicitly swallows the error with "it'll retry tomorrow," which is true for a transient failure and false for a structural one that recurs every day once you're past the threshold.
**Recommended fix (not built this round — genuine architecture decision, not a one-line patch):** batch both loops (page through orgs/chats in bounded chunks per invocation, or fan out via `ctx.waitUntil` + parallel DO calls instead of sequential awaits), and log a summary line (`{job:'retention', processed, failed, durationMs}`) so a stall is visible instead of inferred.
**Severity:** High specifically because "large organizations" and "enterprise administration" are explicitly in your launch checklist — this is the one piece of platform-wide (not per-org) code that doesn't shard by tenant, so it's the one place a single large customer's data volume could degrade something for every other customer too.

### H3. No security response headers anywhere in the app

**What I checked:** grepped `worker.js` and `index.html` for `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options` — zero matches. No CSP is set on any response.
**Why it matters here specifically:** this app renders user-supplied content into the DOM in several places (chat messages, CRM/HR free-text fields, uploaded file names) and already has one deliberate XSS guard (the upload endpoint blocks `text/html`/`image/svg+xml`/`text/javascript` content-types specifically because "this is a shared-file box, not a place to host script" — see `worker.js` ~line 8003). That existing guard is good evidence the risk is already understood; a CSP header is the standard defense-in-depth layer that limits the blast radius if any single escaping bug slips through anyway (a message renderer, a CRM field, an admin console table). Right now there's nothing backstopping that.
**Fix:** add a `Content-Security-Policy` (at minimum `default-src 'self'`, explicit allowances for the CDNs already used, `frame-ancestors 'none'`) plus `X-Content-Type-Options: nosniff` to the worker's response headers for HTML responses. This is genuinely a same-day fix — I can draft the exact header value against what the app actually loads (fonts, the `AI` binding, Paystack's checkout redirect, any CDN scripts) if you want it done this session; flagging it rather than guessing a policy blind, since a too-strict CSP silently breaks features instead of failing loud.
**Severity:** High for a public launch specifically — this app moves to being reachable by anyone, not just known org members, the moment it's public.

### H4. No way to remove a disruptive participant from a live meeting

Carried forward from `PRODUCTION_READINESS_AUDIT.md` (Finding, "Reported, not built"), re-flagged here because "launches publicly tomorrow" changes its severity. Confirmed still true via grep — zero `remove-participant`/`mute-all`/`kick` handlers anywhere in `MeetingRoom`. Today a host's only recourse against a disruptive, compromised, or simply wrong participant in a group meeting is ending the meeting for everyone. For an internal beta this is tolerable; for a public launch where meetings can include external guests, it's closer to a trust-and-safety gap than a missing feature. Needs real UI (participant list, permission gating, confirmation dialog) — not something to build blind in this pass, but worth an explicit yes/no on whether it ships before or right after launch.

---

## Medium

- **No CSP means no report-only telemetry either** — once H3 is fixed, a `report-to`/`report-uri` directive costs nothing extra and gives you real data on what the policy would have blocked, worth doing at the same time rather than as a separate pass.
- **Chat message send has no auto-retry** (documented, deliberate — see `CHAOS_ENGINEERING_AUDIT.md`, "no idempotency key on the send endpoint"). Still true, still the right call without that key; add the idempotency key if this becomes a real complaint post-launch.
- **No application-level backup/export of the whole `Registry` Durable Object.** Durable Object storage is Cloudflare-replicated and durable by platform guarantee — this is not a "data loss on a node failure" risk. What's missing is a *recovery-from-our-own-bug* story: if a future write path corrupts data the way the CRM bug rejected it (but silently, instead of loudly), there's no point-in-time export to restore from. Per-org HR/CRM CSV export exists (task history shows this shipped) but that's manual and per-org, not a platform-wide backup you could actually restore from in an incident. Worth a documented runbook, not necessarily new code, before launch.
- **R2 media bucket has no lifecycle rules configured** in `wrangler.jsonc` — orphaned uploads (abandoned attachments, deleted messages whose media key wasn't cleaned up) accumulate indefinitely. Cost/hygiene issue, not a correctness or security one.
- **Accessibility pass is explicitly partial** on mobile (task #225: high-contrast mode and one-handed gesture support still pending; VoiceOver labels/Reduced Motion already done). Not a launch blocker for a public consumer-facing app on its own, but worth a stated timeline rather than silence if asked.
- **Projects module does not exist yet.** Per `ENTERPRISE_OS_ROADMAP.md`, Projects is explicitly "Phase 2, not built." I checked `index.html` and confirmed there's no Projects tab or dead link exposed in the UI — so this isn't a broken feature, it's a feature that was never scoped for this launch. Listing it here only so it's a conscious decision ("Projects ships later") rather than a surprise gap discovered by a customer.

## Low

- `ALERT_EMAIL` var is configured but unused (see H1) — either wire it to something or remove it so it doesn't imply monitoring that doesn't exist.
- Tiered workspace pricing is still listed pending in the task history (`#28`) — a business/pricing decision, not a code defect, noting only because "billing" was in the review scope.
- Per-user notification preferences don't exist yet (roadmapped Phase 7) — today it's all-or-nothing push. Fine for launch, not fine indefinitely.

---

## What I did not, and could not, verify from here

**Everything requiring real traffic or real devices**, restated from the prior audits since it's still true and still the honest boundary: call/meeting success rate at scale, 50-100 participant meeting performance, real browser/OS/hardware compatibility matrix (Safari/Firefox/Chrome/Edge × iOS/Android × phone/tablet/desktop), an 8-hour soak test for memory leaks, and any literal chaos/stress/load test. All of those need a staging deploy, real or scripted browser/device traffic, and time — not code reading. If you want, I can draft the actual test plans (Playwright + `tc` traffic-shaping harness for browser chaos, a k6/artillery script for API load, a specific real-device QA checklist) as concrete next steps rather than leaving them as bullet points.

## Bar for "production-ready"

Per your own criteria (zero Critical/High), the path to launch-ready is: fix C1 (commit + deploy — minutes), confirm C2 shipped as part of that, add minimal structured logging to billing/CRM/HR/cron (H1 — a few hours), batch the two platform-wide cron loops or at minimum add failure logging to them so a stall is visible instead of silent (H2 — half a day for logging-only, longer for real batching), ship a CSP header (H3 — same day, I can draft it now if you want), and get an explicit answer on whether meeting participant-removal (H4) ships before or shortly after launch rather than not at all.
