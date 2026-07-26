# PArA PIN — real backend (v1)

This adds an actual multi-user backend on top of the existing static site,
using Cloudflare Workers + Durable Objects (no separate database/server to
run — it deploys as part of the same `para-pin` Worker you already have live).

## What changed
- `worker.js` — new. Two Durable Object classes:
  - `Registry` (one global instance) — accounts (keyed by a hash of your PIN)
    and chat membership.
  - `ChatRoom` (one instance per chat) — message history + realtime
    WebSocket fan-out to everyone currently viewing that chat.
- `wrangler.jsonc` — updated: adds `main: worker.js` and the Durable Object
  bindings/migrations. Static file serving (`assets.directory`) is unchanged.
- `index.html` — updated: the PIN screen now also logs you into a real
  account on the server (your PIN's hash becomes your identity), "New chat"
  asks for someone's PIN instead of a free-text name, and messages are sent
  to / received from the server in real time instead of living only in this
  browser's local storage.

## How the identity model works
Your 7-digit PIN **is** your account. There's no separate signup step:
- The PIN screen you already know (create → confirm, or just enter) still
  gates the device locally, same as before.
- The moment you unlock, the app hashes that PIN (SHA-256, done in your
  browser — the raw PIN is never sent anywhere) and calls the server. If
  that hash has never been seen before, a new account is created; if it has,
  you're logged into the existing one with its real chats.
- To message someone, you need their PIN (they share it with you directly,
  same idea as the "Share Your PArA PIN" concept). Enter it in "New chat."
- Groups can mix people you've already DMed (pick from a list) with new
  people by PIN.

## Deploying
Same as before — drop these three files into the repo root (`worker.js` and
`wrangler.jsonc` are new, `index.html` replaces the old one) and push, or
`wrangler deploy` directly:
```
unzip -o ~/Downloads/para-pin-backend.zip -d ~/para-pin
cd ~/para-pin
git add -A
git commit -m "Add realtime multi-user backend (Durable Objects) and PIN-based identity"
git push
```

## Tested before shipping
- 22 tests against the Registry/ChatRoom logic directly (account creation,
  idempotent login, duplicate-contact handling, permission checks, message
  history capping, etc).
- 22 end-to-end tests driving the actual `index.html` against that same
  logic — simulating three separate "devices" (Alice/Bob/Cara) each with
  their own PIN, confirming: DM creation by PIN, unknown-PIN error handling,
  realtime message delivery over WebSocket while a chat is open, group
  creation via both the contact-picker and by-PIN paths, and that a new
  group shows up for other members the next time they unlock.
- Config validated with `wrangler deploy --dry-run` (bindings, Durable
  Object migrations, asset directory all confirmed valid).
- Not tested: an actual live deploy against your Cloudflare account (I don't
  have access to it from here) — the dry-run + full local simulation is as
  far as I could verify without that access. If something's off after a
  real deploy, send me the error and I'll debug from there.

## Known v1 limitations (by design, not bugs)
- No push notifications — you only get realtime updates for a chat while
  it's actually open. New chats/messages that arrive while you're not
  looking show up next time you unlock or reopen that chat.
- No message editing/deleting, read receipts, or file/image attachments yet.
- Auth is "whoever has the PIN hash can act as that account" — fine for a
  v1 among a trusted team, but not hardened (no rate limiting, no device
  binding yet). That hardening is exactly what your own PArA PIN roadmap
  already calls for (hardware-bound identity, device verification) —
  this is the functional skeleton that work would slot into.
- Each chat keeps its most recent 500 messages; older ones are dropped
  (easy to raise later, kept low for a v1).
