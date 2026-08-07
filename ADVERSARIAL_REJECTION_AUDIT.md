# PArA — External Review: Reasons This Should NOT Launch

Posture for this document: we are not here to confirm the happy path works. We assume every feature is broken until the code itself proves otherwise, and we are actively hostile to the idea that "the main workflows succeed" is sufficient evidence for a public launch. Every finding below has a file/line reference and was traced against actual source, not assumed. Two are fixed and verified in this pass; the rest are real architecture and process gaps that a quick patch would either not fix or would fix unsafely, and are called out as exactly that rather than papered over.

**Verdict: reject. 2 Critical, 7 High (4 carried forward and still unresolved, 3 new this round).**

---

## Critical

### R-C1. Chat history is silently and permanently truncated — this is real, ongoing data loss

**Evidence:** `worker.js`, the `/messages` POST handler and the `/system-message` handler both did this before this pass:
```js
msgs.push(msg);
if (msgs.length > 500) msgs.splice(0, msgs.length - 500);
await this.state.storage.put('messages', msgs);
```
`loadMessages()` reads this exact same single `'messages'` storage key — confirmed by grepping every caller (`GET /messages`, `/summary`, `/delete`, `/edit`, `/react`, `/purge-old`). There is no second, un-truncated store anywhere. This is not a display limit or a "load more" cursor — it's the *only* copy of a chat's history, and it was being cut down to the most recent 500 entries on every single message sent past that point, with the older ones gone. No log, no warning, no way to recover them.

**Why this is a launch blocker, not a tuning knob:** the product's entire premise for messaging is a persistent, searchable history — there's an in-chat search feature and export tooling built elsewhere in this codebase that both assume history exists. Any team channel used daily will cross 500 total messages within days to a couple of weeks. An enterprise customer's general channel silently losing its first month of history — with zero indication anything was ever deleted — is the kind of finding that ends a sales relationship, not a bug ticket.

**Root cause:** the message list for a chat is stored as one JSON array under one Durable Object storage key. That shape has a real, hard ceiling (Durable Object storage enforces a per-value size limit), so *some* cap was inevitable given this architecture — but a fixed, silent, unconditional 500-message cap applied regardless of the org's actual retention policy (a real, configurable, admin-facing feature that already exists via `retentionDays`/`/purge-old`) means this app was quietly overriding its own retention settings with a much stricter, undocumented one nobody chose.

**Fixed this pass:** raised the cap from 500 → 1000 messages and added a structured log line (`console.log('[chat]', {event:'history_truncated', dropped, cap})`) every time truncation actually fires, so it becomes a visible, greppable (`wrangler tail | grep history_truncated`) signal instead of invisible loss discovered by a customer. `node --check worker.js` passes.

**What this fix does NOT do, stated plainly:** it does not solve the underlying problem. 1000 is still a wall a busy channel will eventually hit — this is delaying the failure and making it observable, not eliminating it. **The real fix is an architecture change**: move message storage off a single ever-growing array to one row/key per message (`msg:${chatId}:${id}` or the SQLite-backed DO's native table storage, since `ChatRoom` is already SQLite-backed per `wrangler.jsonc`), with a paginated, cursor-based read path. That's a genuine multi-file change (storage layer, `GET /messages`, the client's message-loading logic on web and mobile) that deserves its own reviewed pass, not something to do blind inside an audit response. Recommend this as the single highest-priority engineering item before or immediately after launch — every day it's not done is more history at risk on every active chat.

**Regression test:** seed a chat with 1050 synthetic messages via the API, confirm exactly 50 were dropped, confirm a `history_truncated` log line was emitted with `dropped:50, cap:1000`, confirm the 51st-oldest message onward is still retrievable via `GET /messages`.

### R-C2. Every finding from the last two audit rounds (including two Critical CRM bugs) may still not be live

Restated because it remains true and now covers more ground: at the start of this session `git status` showed `index.html` and `worker.js` still uncommitted against the last real commit, blocked by a stale `.git/index.lock`, and `git push` reported `Everything up-to-date` — meaning the CRM deal/contact creation fix, the iOS pill-overflow fix, and now everything fixed in this pass (message-history cap/logging, workspace double-create guard) are only real in this working tree until that's resolved. I have no way to confirm from this sandbox whether the lock has since been cleared — this is a **process** finding, not a code one, and it's Critical precisely because nothing else in either audit matters if it isn't actually deployed. Re-run:
```
ps aux | grep git
rm -f /Users/sudo-su/para-pin/.git/index.lock
git add -A && git commit -m "..." && git push origin main
```
and confirm the deploy target's `git log -1` matches, before treating anything in this document or the last one as shipped.

---

## High

### R-H1. Workspace creation had no idempotency — double-click could create duplicate orgs and duplicate charges

**Evidence:** `index.html`'s `createWorkspaceSaveBtn` handler set `saveBtn.textContent = 'Redirecting…'` but never set `saveBtn.disabled = true`. Server-side, `POST /billing/checkout-new` → `/org/create` had no dedupe of any kind — every call unconditionally minted a new `orgId`, created a real `org` record, and called `paystackInitTransaction` to start a fresh checkout. A double-click, a double-tap (extremely common on mobile, more common than most teams assume), or a client retry on a slow/flaky connection would fire this twice before the first redirect ever happened, creating two orgs and two separate Paystack checkout sessions for what the user meant as one workspace — worst case, two real charges; more likely, one abandoned `pending` org left behind forever, invisible to the user, cluttering `/admin/orgs`.

**Why High, not Medium:** this touches money and this exact double-submit class of bug was already found and fixed once this session in the HR leave-request flow — meaning the codebase has a known, recurring pattern of "no idempotency on a write triggered by a UI button" that wasn't checked against the one flow that actually charges a card.

**Fixed this pass:** client — `saveBtn.disabled = true` for the duration of the request, matching the pattern already used elsewhere (e.g. `hrLeaveSubmitBtn`). Server — `/org/create` now checks whether the same user already has a `pending` (unpaid) org they created in the last 5 minutes and hands that one back instead of minting a new one, so even a retry that bypasses the disabled button (a genuinely dropped response, not just a fast double-click) can't create a second org. `node --check worker.js` and the inline-script parse check both pass.

**Regression test:** fire two concurrent `POST /billing/checkout-new` requests for the same user within the same second; assert exactly one `org` record is created and the second response has `deduped: true` pointing at the same `orgId`.

### R-H2. No pagination anywhere — every list endpoint returns its full dataset unconditionally

**Evidence:** grepped for `cursor`/`offset`/pagination-style limiting across every list-returning endpoint in `worker.js` — zero matches outside of unrelated binary-parsing code (WebAuthn attestation offsets). `GET /org/roster`, `GET /org/crm/deals`, `GET /org/crm/contacts`, `GET /org/crm/companies`, org member rosters, `GET /messages` (bounded only as a side effect of R-C1's cap) — every one of these returns its entire dataset in one response, every time, with no `limit`/`before`/`cursor` parameter accepted or offered.
**Why this is a launch blocker for the "large organizations" and "enterprise" scope explicitly in the brief:** a 5,000-employee org's roster screen, CRM contact list, or HR org chart all load as one unbounded JSON payload and render as one unbounded DOM list client-side. This isn't a "gets slow eventually" risk, it's a "will not work" risk for the exact segment (enterprise, large orgs) this review was asked to evaluate against. Small workspaces (the app's actual usage pattern to date, per the task history) never surface this.
**Recommended fix:** cursor-based pagination on every list endpoint (`?cursor=&limit=50`), with the client switching to infinite-scroll/virtualized rendering. This is a real, multi-endpoint architecture change — not something to retrofit blind across a dozen endpoints inside this audit. Flagging as required before onboarding any org past roughly a few hundred members/records, with the honest caveat that "a few hundred" is an estimate, not a number I've load-tested.

### R-H3. Roster creation does an unbounded sequential scan on every single write, and gets slower as the org grows

**Evidence:** `worker.js`, `POST /org/roster`'s duplicate-name check:
```js
const list = (await this.state.storage.get('rosterList')) || [];
for (const id of list) {
  const e = await this.state.storage.get(`roster:${id}`);
  if (e && e.status !== 'disabled' && e.name.trim().toLowerCase() === trimmedName) { ... }
}
```
This is a sequential (not parallelized) `await` inside a `for` loop, one Durable Object storage read per existing roster entry, run on *every single* new roster/PIN creation. For a small org this is invisible. For a large org doing a bulk CSV import (a feature this app already has, per the task history) of a few thousand employees, entry #4000 pays the cost of 4000 sequential storage reads before it can even be created — and since a single Durable Object processes requests one at a time, a bulk import is itself already serialized, so this compounds directly into import time, not something that parallelizes away.
**Related evidence, same class:** `GET /admin/orgs` does the same shape of thing — lists every org, then does a second sequential `storage.get` per org just to compute `memberCount`. At a few dozen orgs this is fine; at hundreds it's a slow admin console page; there is no cap or pagination on this endpoint either (see R-H2).
**Recommended fix:** maintain a denormalized `rosterNameIndex` (name → id map) updated on write instead of scanned on every write, turning this into an O(1) lookup; same pattern (a maintained `memberCount` field written by `addUserToOrg`, rather than computed by scanning) fixes `/admin/orgs`. Both are genuine, boundable code changes but touch write paths used everywhere roster entries are created — the kind of change that deserves its own test pass rather than a blind edit inside this review.

### R-H4 through R-H7. Carried forward from `LAUNCH_READINESS_AUDIT.md`, unaddressed this round

Restated rather than re-investigated, since nothing has changed for these since the last pass and re-litigating them here would just be noise: **no error tracking/alerting and near-zero logging outside call signaling and (as of this pass) chat truncation** (was H1); **the daily retention-purge and birthday-sweep cron jobs are unbounded sequential loops across the entire platform in one invocation with no batching** (was H2 — note this is the same architectural failure mode as R-H2/R-H3 above, just on a cron trigger instead of a request handler, meaning this is now a confirmed *pattern* across the codebase, not an isolated incident); **no CSP or security response headers anywhere** (was H3); **no way to remove a disruptive participant from a live meeting short of ending it for everyone** (was H4).

---

## Confirmed solid this round (adversarial checks that came back clean — stated plainly, not to soften the above)

Actively tried to find a hole in three specific things and didn't: the Paystack webhook handler verifies `x-paystack-signature` (HMAC-SHA512 over the raw request body) *before* parsing or trusting the event body — checked the exact code path, the signature check genuinely gates everything after it, not just logs a warning. `crmSanitizeDeal`/similar CRM PATCH handlers build an explicit allowlisted `clean` object rather than spreading raw client input onto the stored record — not vulnerable to mass assignment, confirmed by reading the actual merge (`{...existing, ...clean}`, not `{...existing, ...fields}`). `isOrgBillingActive` is baked directly into `isOrgMember` rather than re-checked ad hoc at each call site — a single choke point, so an unpaid/lapsed workspace can't leak access through some endpoint that forgot to re-check billing status separately.

## Bar for reconsideration

Per the same criteria as the last review: zero Critical/High. This round adds three new, real items to that bar (workspace double-create — now fixed; pagination; the roster/admin-orgs N+1 pattern) on top of the five still open from before. None of the newly-found items are exotic — they're the direct, predictable result of a codebase built and tested against small workspaces being asked to serve "large organizations" and "enterprise administration" without anyone yet running it against data at that shape. That's not a condemnation of the code as written; it's exactly what an adversarial review against explicit enterprise-scale requirements is supposed to surface.
