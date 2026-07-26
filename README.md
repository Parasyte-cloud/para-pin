# PArA PIN — rebrand + backend, full drop-in

Everything needed for the current state of the app: the realtime backend
(from last update) plus a rebrand of the icon/favicon/OG image to use the
actual PArAsYtE flame-mask logo paired with the "PArA" wordmark, instead of
the plain "P" monogram + "PArA PIN" text.

## Files
- `index.html` — the app (backend-connected, PWA-enabled, new branding)
- `worker.js`, `wrangler.jsonc` — the Cloudflare Worker backend
- `favicon.png`, `favicon-32x32.png`, `favicon-16x16.png`,
  `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `og-image.png` —
  all regenerated from the flame-mask logo
- `manifest.webmanifest`, `service-worker.js` — PWA install support

## Deploy
Unzip into your repo root (overwrite everything with the same names), then:
```
cd ~/para-pin
git add -A
git commit -m "Rebrand icon/favicon/OG to flame-mask logo + PArA wordmark"
git push
```
Still deploys to the same Cloudflare Worker — nothing new to configure.
