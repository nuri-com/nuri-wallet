# Briefing: iOS/Android — passkey + PRF **entirely in-WebView** (delete native passkey modules)

**For:** the iOS/Android developer.
**Goal:** remove ALL native passkey/PRF code and run the **exact same web ceremony the PWA uses** (`navigator.credentials` + the WebAuthn `prf` extension) **inside the app's own WebView** — **no external browser window, no `ASWebAuthenticationSession`, no Chrome Custom Tabs.** RP ID stays `nuri.com`.

---

## TL;DR
- The passkey create/get/PRF call becomes the web code in `services/auth/PasskeyNativeModuleService.web.ts`, running in the app's `WKWebView` (iOS) / `WebView` (Android).
- In-WebView WebAuthn **does** work now, but **only with specific config**. It is NOT on by default.
- **De-risk iOS PRF on a real device FIRST** (it's the one piece that can block the whole approach) before building everything else.

---

## The shape: one full-screen WebView = identical UI/UX, zero feature native modules
The native apps are a **single full-screen OS WebView** (WKWebView on iOS, Android `WebView`) loading the **same web build the PWA serves**. The UI *is* the web app (React-Native-Web → DOM), so it is **1-to-1 with the PWA by construction** — same screens, same pixels, same flows, no per-screen native work.

**What "no native modules" means precisely:** delete every *custom feature module* (passkey/PRF, secure storage, crypto bridges). The only native surface left is the **WebView container itself** — the OS rendering surface, not custom code — plus a few genuinely-native integrations you choose to keep.

**Shipping the web build:**
- **Remote (recommended, fully OTA):** WebView loads `https://pwa.nuri.com`. Every web deploy updates all platforms instantly — no app-store release. Add an offline fallback screen.
- **Bundled:** ship the web build in the app for offline/first paint; optionally OTA the assets.
- **Hybrid:** bundled shell + remote content.

**App Store caveat (real — plan for it):** Apple guideline **4.2** can reject *pure* web wrappers. Mitigate by keeping a few genuinely-native integrations a wrapper alone can't do — **push notifications, biometric secure storage, Apple Pay, native share/QR** (you want these anyway). That's enough native value to pass while 100% of the UI stays web. Android: a `WebView` shell is fine (or Trusted Web Activity), but the in-app passkey requirement (no external window) means embedded `WebView` per the Android section, not a Custom Tab.

**Host options in this stack:** you're already on Expo/RN, so the pragmatic path is a **full-screen `react-native-webview`** loading the web build (it wraps WKWebView/Android WebView) — or a thin pure-native shell. Either way, configure the WebView host per the passkey sections below (Associated Domains on iOS, `setWebAuthenticationSupport` on Android) so in-WebView WebAuthn+PRF works.

**Native code that remains (small, stable):** the WebView shell + its config; deep-link/universal-link handling; and the optional native integrations above (push, biometric, Apple Pay) behind feature checks. Everything else is web.

## Feasibility — read this before you start
In-WebView WebAuthn+PRF is supported on recent OS versions **with configuration**, not out of the box:
- **Android:** well-supported from **AndroidX WebKit 1.12.1+** via a documented API. Lower risk.
- **iOS:** `WKWebView` + **Associated Domains**; the **PRF extension needs iOS 18+** (WebKit/Safari 18). Higher risk — there are reports that WKWebView passkeys can require entitlements beyond Associated Domains. **Verify PRF returns a non-empty result on a real device on your minimum iOS target before committing.**

If iOS in-WebView PRF turns out blocked on your min target, raise it immediately — that's the one finding that would change the plan.

---

## iOS (WKWebView)
1. **Associated Domains entitlement** (Signing & Capabilities → Associated Domains):
   - `webcredentials:nuri.com`
   - For dev/testing against a not-yet-published AASA: `webcredentials:nuri.com?mode=developer`
2. **apple-app-site-association** at `https://nuri.com/.well-known/apple-app-site-association` must include the app:
   ```json
   { "webcredentials": { "apps": ["<TEAMID>.<BUNDLE_ID>"] } }
   ```
   (If universal links already work for nuri.com, you already serve AASA — just add/confirm the `webcredentials` section with this app's `TEAMID.BundleID`.)
3. **OS version:** passkeys in WKWebView need iOS 16+; **the `prf` extension needs iOS 18+.** Gate accordingly.
4. **WKWebView:** load `https://pwa.nuri.com` (or the bundled web app). With the associated domain present, `navigator.credentials.create/get` for RP ID `nuri.com` run in-WebView. Only `nuri.com` passkeys are usable (RP ID must match the associated domain) — which is exactly what we want.
5. **Verify early (real device):** `getClientExtensionResults().prf.results.first` is **non-empty**. A silent empty PRF = broken wallet derivation (we hit this exact failure mode in testing).

## Android (WebView)
1. **Dependency:** `androidx.webkit:webkit:1.12.1` or newer.
2. **Enable WebAuthn in the WebView** (feature-detect, then enable):
   ```kotlin
   if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
       WebSettingsCompat.setWebAuthenticationSupport(
           webView.settings,
           WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP
       )
   }
   ```
   If unsupported (old system WebView APK on the device), in-WebView passkeys won't work — prompt the user to update Android System WebView (Play Store), or gate the feature.
3. **Digital Asset Links:** `https://nuri.com/.well-known/assetlinks.json` must verify this app (App Links) for `nuri.com`.
4. Routes WebAuthn through Credential Manager (Chromium WebView). **Verify PRF returns non-empty** on your min target + current WebView APK.

---

## What to DELETE (native passkey/PRF — no longer used)
- **iOS:** `ios/NuriDev/PasskeyModule.swift` (the `ASAuthorizationController` / `ASAuthorizationPublicKeyCredentialPRF*` code) and its module registration.
- **Android:** the native passkey / Credential-Manager module + registration.
- **RN bridge:** the native branch in `services/auth/PasskeyNativeModuleService.ts` (`NativeModules.PasskeyModule`). The web implementation becomes the single source of truth.

## What stays / what to wire
- `services/auth/PasskeyNativeModuleService.web.ts` is the **one** passkey implementation. Make the native build resolve to it (run the auth UI in the WebView), so there is no second code path.
- Everything else about signing is unchanged: PRF for user-initiated taps; **held key for background ops** (balance/tx polling must NOT trigger a passkey — verify no prompt fires).

## The web ceremony (already implemented — do not reinvent)
`PasskeyNativeModuleService.web.ts`:
- `navigator.credentials.get({ publicKey: { rpId: "nuri.com", userVerification: "required", extensions: { prf: { eval: { first: utf8("nuri-prf-salt-v1") } } } } })`
- Result encoding: `prfB64` = **standard base64**; all other `*B64u` fields = **base64url, no padding**.
- Same passkey → same PRF because **rpId (`nuri.com`) + PRF salt (`nuri-prf-salt-v1`) are identical** to the old native path. So a wallet created on the PWA/Safari resolves to the same keys in the in-app WebView.

---

## Test matrix — do NOT ship without all passing
1. **iOS min target, real device:** create passkey in-WebView → get assertion → `prf.results.first` non-empty.
2. **Android min target, real device, current WebView APK:** same.
3. **Cross-surface parity:** a passkey created on `pwa.nuri.com` (Safari/Chrome) works in the app's WebView and vice-versa (because RP ID = `nuri.com`).
4. **No stray prompts:** background balance/tx refresh triggers **no** passkey prompt (held-key path).
5. **PRF determinism:** same passkey derives the same wallet address across PWA, Safari, iOS WebView, Android WebView.

## Why this is the right shape
Native apps become **thin WebView shells over the same web app + same web auth** — the one-shared-codebase goal. The only native code left is the shell, the WebView config above, and genuinely-native features you deliberately keep (push notifications, biometric secure storage, Apple Pay).
