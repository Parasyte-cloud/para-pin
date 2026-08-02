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
- `admin.html`, `admin-manifest.webmanifest`, `service-worker-admin.js` —
  the platform admin console (see below)

## Admin console (admin.parasyte.cloud)

A separate, standalone PWA for platform-wide admin — not a per-workspace
view, this is for whoever's in `worker.js`'s global `admins` list managing
the entire deployment. It's the *same* Worker as chat.parasyte.cloud, just
a different static entry point (`admin.html` instead of `index.html`)
served based on hostname, and it calls the same `/api/admin/*` endpoints
the in-app admin panel already used — no duplicate backend, no second auth
system. Sign-in is the same PIN → `POST /api/session` flow as the regular
app; a login only succeeds here if the response's `isAdmin` flag (the
global platform-admin list, not an org admin) is true.

**One new backend endpoint was added to support it**: `GET /api/admin/orgs`
(worker.js, gated the same way as every other `/admin/*` route) — nothing
else could previously list every workspace across the deployment, every
existing org endpoint needed you to already know an `orgId`. Everything
else (analytics, users/device-lock, roster + bulk CSV import, retention,
legal holds, API keys, webhooks, status page/incidents) reuses endpoints
that already existed.

**Setup, in order:**
1. **Cloudflare dashboard** (only you can do this step): Workers & Pages →
   `para-pin` → Settings → Domains & Routes → Add Custom Domain →
   `admin.parasyte.cloud`. Same one-time step that already put
   `chat.parasyte.cloud` and `web.parasyte.cloud` on this Worker — DNS +
   TLS cert get provisioned automatically since the zone's already on this
   account.
2. **Deploy**: `cd ~/para-pin && npx wrangler deploy`. This one deploy
   ships the admin console files, the new `/api/admin/orgs` endpoint, and
   the hostname-routing change together — nothing separate to build.
3. **Sign in** at `admin.parasyte.cloud` with a PIN that's already a
   platform admin. If you're not sure whether your account is one yet, or
   there isn't one yet at all: `POST /api/admin/bootstrap` with your PIN
   hash and the `ADMIN_BOOTSTRAP_KEY` wrangler secret self-promotes you —
   set that secret first if it isn't already (`npx wrangler secret put
   ADMIN_BOOTSTRAP_KEY`) if you need to use it. If you're already an
   admin from using the in-app admin panel on the regular app before,
   nothing extra is needed — just sign in.

**Scope note**: `/admin/retention` and `/admin/legal-holds` are genuinely
global settings (one retention window, one hold list for the *entire*
deployment) — not per-workspace, even though that might read as
workspace-level governance at first glance. That's an existing backend
design choice from before this console existed, not something introduced
here.

Verified: `node --check worker.js`, `node --check` on the extracted
`<script>` body of `admin.html`, HTML tag-balance check, and the existing
`npm test` suite (28/28 passing, untouched by this change).

## Deploy
Unzip into your repo root (overwrite everything with the same names), then:
```
cd ~/para-pin
git add -A
git commit -m "Rebrand icon/favicon/OG to flame-mask logo + PArA wordmark"
git push
```
Still deploys to the same Cloudflare Worker — nothing new to configure.
