# PArA PIN — Chat (solo preview)

Liquid-glass team chat gated by a local PArA PIN. Single-file static app
(`index.html` — HTML/CSS/JS, no backend yet). Everything persists to
`localStorage` on the device it's opened on.

## Web — run it
Open `index.html` directly, or serve the folder:
```
python3 -m http.server 8080
```
Then visit `http://localhost:8080`.

## Web — deploy
Push this repo, then deploy `index.html` as a static site via Cloudflare
Pages or Vercel. See the main chat thread for the full Cloudflare Pages +
custom subdomain walkthrough (`chat.parasyte.cloud`).

## Mobile — iOS / Android
See [`mobile/README.md`](mobile/README.md) — wraps this same app in Capacitor
so it can be built and submitted through your Apple Developer / Google Play
accounts.

## Status
Solo/local prototype. Multi-user sync over the real PArA PIN identity layer
(hardware-bound PIN, device verification, mTLS) is not wired up yet.
