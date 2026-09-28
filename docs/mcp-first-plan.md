# Nuri MCP‑First — Plan & Checklist

Living doc. We're making the app **web‑PWA‑first**, then porting the same patterns to iOS/Android, with the end goal of **one MCP backend + thin frontends**. Update as we go.

## Vision & order of work
- **End state:** one MCP backend (the `mcp.nuri.com` pattern) does orchestration (OAuth, server‑side redirect capture, order submission, account reads). Frontends — **web PWA, iOS, Android, agents** — just *sign* (PRF for user taps, held key for background) and call the MCP.
- **Now:** get every function working reliably, UX‑focused, like `arkade-os/wallet`. **Then** optimize → refactor toward MCP → UI/UX polish. Don't over‑engineer now.
- **One shared codebase (hard rule):** web/iOS/Android share as much code as possible. Every platform difference goes behind a `.web` file swap or a small `Platform.OS === "web"` branch — **never a fork/parallel implementation**. Today the entire app is shared except 6 `.web` shims + a few guarded branches (all for genuine platform realities). The MCP end‑state shrinks even those.

## Signing architecture (decided)
- **PRF / passkey** → ONLY user‑initiated actions (login, 2FA cosign, send) where a tap exists. On web `navigator.credentials.get()` needs a gesture.
- **Background ops** (load balances/transactions, re‑auth, polling) → **held key**, never PRF (no gesture in a browser background → "missing signature").
- **Where the key lives:** `localStorage` now. **Corrected 2026-08-01 — the reasoning
  that follows was wrong and is kept only to show what was believed:** *"safe because the
  co‑signer is the 2nd factor"*. That holds for the **Bitcoin** key. It does **not** hold
  for the Ethereum, Nostr and auth‑HMAC keys stored alongside it, which have no co‑signer
  at all — an XSS reads them and spends, with no user interaction. See #746.
  Planned: PRF‑derived wrapping key, one passkey prompt per session, explicitly no user
  passwords. Native: Keychain, unchanged.

## Web PWA — status
**Working**
- Boots as a PWA, native‑module‑free (Metro `.web`/alias shims: secureKeyStorage, passkey→`navigator.credentials`, keychain, sqlite, webview→iframe).
- Same‑origin `/api/*` nginx proxy → no CORS. `fetch` **and** `XMLHttpRequest`(axios) rewritten by `lib/web/apiProxy.ts`.
- Login → real `nuri.com` passkey → PRF → wallet derivation (same wallet as native).
- **Arkade** ✅ (after adding `https://pwa.nuri.com` to `ORIGIN_V4`).

**To verify / pending**
- [ ] Send (bitcoin/arkade) end‑to‑end
- [x] Mercuryo buy ✅ web opens checkout in a **new tab** (iframe is blocked by the widget); reuses Android's external-checkout path + status-polling. iOS keeps in-app WebView.
- [ ] Peripheral native→web: Sumsub KYC (web link), Wirex, QR scan (`expo-camera`), Apple Pay (gate off on web)
- [ ] Remaining dynamic‑import chunks in signing/CSV paths → static‑import if they break
- [x] FX (`/api/fx`, frankfurter) returned 301 via proxy ✅ frankfurter.app is retired; call `api.frankfurter.dev/v1` directly (open CORS), proxy dropped
- [ ] PWA installability: web manifest + icons + service worker
- [ ] Cosmetic: lilac CTA on lilac login background

## Infra / deploy (current)
- **PWA host:** `pwa.nuri.com` → `116.203.208.144` (nginx 1.18). Static at `/var/www/pwa.nuri.com`; vhost `sites-available/pwa.nuri.com` serves the SPA + `/api/*` same‑origin proxy. Cert via certbot webroot.
- **Backends (separate boxes):** `arkade.nuri.com`=188.34.194.25 (docker `server-arkade-v4`), `sign.nuri.com`=46.224.61.123 (**retired for the app** — the app signs only against Nuri Cosigner v4 on `arkade.nuri.com`; v1 wallet migration is a separate product on `v1.nuri.com`. Listed for the record, not as a live dependency).
- **WebAuthn origin allow‑lists** (server‑side, can't spoof — client origin is signed into the assertion). Must include `https://pwa.nuri.com`. ✅ arkade `ORIGIN_V4` (`.env`, recreate container). `sign.nuri.com` (v1 MuSig2) needs no entry — the app never sends it an assertion.

## MCP migration roadmap (end‑state)
- [ ] **Bitcoin passkey bridge → `server-bitcoin-passkey-bridge-mpc`**
- [ ] Then arkade as makes sense.
- Pattern: frontend signs via PRF worker → MCP does the rest. One backend to maintain.

## Lightning incoming push (vs 20s poll) — spec
Two "incoming" cases:
- **App-created swaps** (send LN, receiver invoice): ALREADY push via boltz-swap `SwapManager` (WebSocket, on by default). No work.
- **Static address `you@nuri.com` (LNURL):** still the **20s `receive/sync` / `lnurl/status` poll** — the app can't watch a swap it didn't create. Needs server push.

Arkade server = repo **`github.com/nuri-com/server-arkade-v4`** (deployed on host 188.34.194.25 at `/opt/nuri/arkade-v4/apis/server-2fa/v4`). Hand-rolled: raw `http.createServer`, only dep `better-sqlite3`, talks to Boltz REST directly — **NO swap SDK, no `ws` lib to upgrade**. Line numbers below are canonical (repo), not deployed-disk. Key facts:
- Owner identity: `ownerKeyForReceive({credId, clientPk33})` (`ArkadeReceive.js:141`).
- Incoming swap is created at `lnurlStore.addReceiveLightningSwap(...)` — **`ArkadeServer.js:4435`** (inside `GET /lnurl/callback/<username>`, route `ArkadeServer.js:5566`; server `http.createServer` at `ArkadeServer.js:5448`). **This is the emit point.**
- Boltz status via REST `ArkadeBoltzStatus.js` (`/v2/swap/reverse/<id>/transaction`).
- No existing SSE/WS/EventEmitter/notify anywhere — net-new SSE confirmed against canonical source.

**Minimal change (~60 lines, additive, keeps poll as fallback):**
1. In-memory SSE hub `Map<ownerKey, Set<res>>` + new route `GET /v4/arkade/lnurl/subscribe` (`text/event-stream`).
2. After `addReceiveLightningSwap` (4440): `sseHub.publish(ownerKey, {type:"incoming", swapId: row.id})`.
3. (Optional) emit again on claimable/settled — or skip: app already has `subscribeToSwap` (boltz `wss://.../v2/ws`) to watch to completion once it has the swapId.
4. nginx: `proxy_buffering off` + long `proxy_read_timeout` on that location (both proxies). No WS upgrade.
5. App (shared): `EventSource(.../lnurl/subscribe)` on wallet load → on `incoming` → existing claim flow; keep 20s poll as slow fallback.

**Status (2026-06-26):** Server SSE LIVE (v9, dev-verified). **App consumer DONE + deployed** — `services/arkade/internal/receiveSsePush.ts` (web-only; native keeps poll), wired in `receiveAutoClaim.ts` wallet-ready, route `GET /api/arkade/receive/subscribe?cred_id_b64u=…&client_public_key_33_hex=…`. Verified live headless: app opens stream, server returns `200 text/event-stream`, `receive_sse_push status=started`. On `incoming` → `runArkadeLnurlForegroundMonitorTick` (same refresh as poll). Remaining: real payment to light up end-to-end.

## Claim UX — make incoming claims frictionless (investigated 2026-06-26)
Today: Payment-Received modal → "Unlock Wallet" button → wait → passkey. Causes:
- Auto-claim is **stubbed off** (`scheduleArkadeReceiveAutoClaims` → `status=disabled, expected_next=unlock_wallet_manual_runner`); replaced by the manual button.
- Client key is **held** (localStorage) → client VHTLC signature needs no prompt.
- The prompt is the **cosigner**: server `verifyRequestAuth` (`ArkadeServer.js:2434`) calls `verifyAssertion` → mandates a fresh WebAuthn assertion per claim.
Two improvements:
- **① App-only (no server change):** auto-trigger the claim on Payment-Received / SSE `incoming` + pre-fetch swap status → removes the button + dead wait, leaving just the passkey. Safe, do anytime.
- **② Background (no passkey unless token expired):** needs a small server change — broaden the **existing** `claim_session_token` (server already issues `receive_claim`-scoped tokens in `handleReceiveClaimApprove`) from per-swap to **owner-scoped + TTL**, issued once at unlock/login, reused for all incoming claims. SAFE posture: receive-claims move funds INTO the user's own wallet (not a spend) → 1FA (held key) acceptable; **spends keep 2FA**. Needs user sign-off (security posture) before briefing the server dev.

Note: web vtxo-subscription flag (`ARKADE_INCOMING_FUNDS_SUBSCRIPTION_ENABLED = Platform.OS==="web"`) is ON — helps on-chain/ark vtxo arrivals (connects `status=ready`, HTTP, no WS-upgrade) but does NOT cover LNURL-incoming. Decide keep vs revert.

## Ideas / open questions
- Held key: `localStorage` (now) vs memory+zeroize (later) — security/UX tradeoff for the optimization phase.
- Apple Pay: likely keep the native module on iOS (genuinely useful), gate off on web.
- How much to move into the MCP vs keep in‑app — decide per service after web is fully green.

## Changes applied (branch `feat/pwa-web`)
- `lib/secureKeyStorage.web.ts`, `services/auth/PasskeyNativeModuleService.web.ts`, `services/balance/TransactionCacheService.web.ts`
- `lib/web/WebViewWeb.tsx`, `lib/web/ReactNativeKeychainWeb.ts`, `lib/web/apiProxy.ts`
- `metro.config.js` (web aliases), `index.js` (install apiProxy), `App.tsx` (static bootstrap import, web login path, skip biometric lock on web)
- nginx `pwa.nuri.com` vhost: `/api/*` proxy
