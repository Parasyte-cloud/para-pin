# PArA PIN — Capacitor wrapper (iOS + Android)

This is a thin native shell around the real app, which lives at
`https://chat.parasyte.cloud` (deployed from `../index.html` + `../worker.js`
via `wrangler deploy`, same as the web/desktop versions). It's configured to
load that URL directly (see `server.url` in `capacitor.config.json`), not a
bundled local copy — so any change you deploy to the web app shows up in the
native app immediately too, with no rebuild or app store resubmission
needed. `www/index.html` in this folder is just a placeholder Capacitor's
tooling requires to exist; it's not the real app and isn't shown at runtime.

Same account, same backend, same PIN-based auth as the web app — this is
genuinely the same product, just installable from the App Store / Play
Store instead of "Add to Home Screen."

## Prerequisites (on your Mac)
- Node.js + npm
- Xcode + CocoaPods (`sudo gem install cocoapods`) for iOS
- Android Studio (with an SDK installed) for Android

## 1. Install dependencies
```
cd mobile
npm install
```

## 2. Add the native platforms
The `ios/` and `android/` folders already exist in this repo from initial
setup. If you ever need to regenerate either from scratch:
```
npx cap add ios
npx cap add android
```

## 3. Sync native config
Run this after changing `capacitor.config.json` (app id, name, server URL,
etc). You do NOT need to run this after changing the web app itself — that's
the whole point of pointing at the live URL instead of bundling a copy.
```
npx cap sync
```

## 4. Generate app icons + splash screens
`assets/icon.png` (1024x1024) and `assets/splash.png` (2732x2732) are
already in this project.
```
npx capacitor-assets generate
```

## 5. iOS — build + TestFlight
```
npx cap open ios
```
This opens `App.xcworkspace` in Xcode.
1. Select the `App` target → **Signing & Capabilities** → set your Team
   (your Apple Developer account) and confirm the Bundle Identifier
   (`cloud.parasyte.parapin`, or change it in `capacitor.config.json` first
   and re-run `npx cap sync`).
2. Pick **Any iOS Device (arm64)** as the build target.
3. **Product → Archive**.
4. In the Organizer window that opens, **Distribute App → App Store Connect
   → Upload**. It'll show up in TestFlight a few minutes later for you (and
   teammates you invite) to install and test.

## 6. Android — build + Play Console internal testing
```
npx cap open android
```
This opens the project in Android Studio.
1. **Build → Generate Signed Bundle / APK → Android App Bundle**, create or
   reuse a signing key.
2. Upload the resulting `.aab` to the **Internal testing** track in
   [Google Play Console](https://play.google.com/console).
3. Add testers by email (or a public opt-in link) — they install via the
   Play Store once accepted, no APK sideloading needed.

## Known limitations to plan around

- **Push notifications**: the web app uses standard Web Push (VAPID keys,
  service worker), which works fine in Android's WebView, but iOS's WebView
  (WKWebView, what Capacitor uses) has historically had unreliable Service
  Worker support. If push notifications don't work reliably in the iOS
  build, the fix is adding Capacitor's native `@capacitor/push-notifications`
  plugin (APNs-backed) rather than relying on the web Push API there — that
  needs an Apple Push Notification key from your Apple Developer account
  plus a small worker.js change to send to both Web Push and APNs depending
  on platform. Not yet done.
- **First launch needs network**: since the app loads live from
  `chat.parasyte.cloud` rather than a bundled copy, there's no offline
  first-launch experience. This matches how the PWA/web version already
  behaves, so it's not a regression, just worth knowing.
- **App Store / Play Store review**: both stores have policies about apps
  that are "just a website in a wrapper." Having genuinely native-feeling
  behavior (this app already uses real browser APIs for push, camera/mic
  for calls, etc.) generally satisfies this, but it's worth a quick read of
  each store's current guidelines before submitting, since these do shift
  over time.
