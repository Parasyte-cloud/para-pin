# PArA PIN — Capacitor wrapper (iOS + Android)

This wraps the existing liquid-glass web app (`www/index.html`) in a real native
shell so it can be built, signed, and submitted through your existing Apple
Developer and Google Play accounts. No rewrite of the app itself — same HTML/CSS/JS.

## Prerequisites (on your Mac)
- Node.js + npm
- Xcode + CocoaPods (`sudo gem install cocoapods`) for iOS
- Android Studio (with an SDK installed) for Android

## 1. Install dependencies
```
cd para-pin-capacitor
npm install
```

## 2. Add the native platforms
These commands generate the `ios/` and `android/` native projects. Run both
even if you only care about one platform right now — they're independent.
```
npx cap add ios
npx cap add android
```

## 3. Generate app icons + splash screens for both platforms
`assets/icon.png` (1024x1024) and `assets/splash.png` (2732x2732) are already
in this project — this command resizes them into every size iOS/Android need.
```
npx capacitor-assets generate
```

## 4. Sync the web app into the native projects
Run this any time you change `www/index.html`.
```
npx cap sync
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

## Notes
- The app itself is 100% local/solo right now (PIN gate + chats persist to
  on-device storage only). Wrapping it in Capacitor doesn't change that —
  it just makes it installable like a normal app instead of a browser tab.
- If you edit the chat app, just replace `www/index.html` with the new
  version and run `npx cap sync` again before rebuilding in Xcode/Android
  Studio.
