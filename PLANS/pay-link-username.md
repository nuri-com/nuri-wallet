# Public payment link: `app.nuri.com/pay/@username`

> Not claimed. No issue filed yet (`wf issue create` is intake/shaping, run separately).
> Branch: TBD (cut from `dev`).

## Summary

A public, signed-out page at `/pay/@username` that lets anyone pay a nuri user. The
sender picks a source asset; the destination is never chosen — it is the recipient,
shown as `@username`. The page resolves the recipient's rails from the nuri ENS
gateway (already public today) and picks the simplest route for the chosen source:
direct when the rail matches, SwapKit when it does not. No new server endpoint is
needed. SEPA is deliberately out of scope — no IBAN field exists anywhere server-side.

## Why this shape

Two facts decide the architecture, both verified live:

1. **The rail directory already exists and is public.** `*.nuri.eth` resolves via the
   arkade CCIP-Read gateway (`src/ArkadeEnsGateway.js`, onchain resolver
   `0xF7d2f89Fa127e8e9487Fc12ec3dBCE7B1E11D50C`) and serves four text records:
   `com.nuri.lightning`, `com.nuri.evm`, `com.nuri.arkade`, `com.nuri.btc`.
   Confirmed populated for `lennard`, `sinan`, `cim`, `emino`. `addr(60)` and every
   ENSIP-11 EVM coin type return the same address (`safeAddress || evmAddress`).
   The ENS web app shows "0 Text Records" because it enumerates from the ENS
   subgraph and offchain records emit no events — the records are there, they are
   just not enumerable. Any client that asks for the key by name gets it.
2. **`POST /v4/arkade/lnurl/status` cannot be the resolver.** It is 401 without an
   assertion and refuses any foreign registered username (400,
   `src/ArkadeServer.js:6053`). A payer passkey does not change this. ENS is the
   only public full-rail read, so the page uses it and nothing else.

Everything else follows: the page needs no auth, no account, and no server change.

## Scope

1. Route `/pay/@username` on web, rendered before the auth gate, with no wallet,
   no passkey prompt, and no signed-in state required.
2. Recipient resolution from ENS text records, cached.
3. Source-asset picker over the assets we can already handle, and a rail selector
   that maps source → the recipient endpoint with the fewest hops.
4. Two payer modes: signed-in nuri user pays from their own balances; a stranger
   pays into a SwapKit deposit address / Lightning invoice / plain address from any
   external wallet.
5. Swap fallback via the existing `SwapContract` engines when the source asset has
   no matching recipient rail.

### Phase 1 (this plan): QR only

Every rail is paid the same way — the page renders what has to be paid and the payer
pays it from whatever wallet they already have:

- EVM stablecoin → recipient address (or the SwapKit deposit address) as address + QR.
- Lightning → BOLT11 fetched from the recipient's LNURL-pay endpoint, as QR.
- BTC onchain → boarding address as QR.
- Arkade → arkade address as QR.

No wallet connection, no signing in the page, no new dependency. This is the whole
delivery target; the page is useful and complete at this point.

### Phase 2 (separate work): in-page payment

Add wallet connectors so the payer can pay without leaving the page, with a toggle
between "Connect wallet" and "Show QR" wherever both work:

- EVM: RainbowKit + wagmi/viem, `connect → switch chain → transfer`. Toggle to QR.
- Lightning: WebLN when the browser exposes it, QR otherwise. Same toggle.
- BTC onchain / Arkade: QR only — no connector standard worth adopting.

Constraint to design around before starting Phase 2: RainbowKit is React DOM, this app
is react-native-web. The connector UI has to live in a `.web.tsx`-only module behind a
platform-split boundary, and wagmi/RainbowKit must not enter the native bundle. Both
are JS-only deps, so neither changes the fingerprint.

Out of scope:

- **SEPA / IBAN.** Not in ENS, not in the LNURL profile, not in the database
  (`grep monerium|iban|sepa` across the arkade server → zero hits). Exposing it needs
  a new profile field, a named param in `setProfile`, a publish flag, and a decision
  on SEPA Direct Debit reachability that neither Monerium nor Wirex documents
  publicly. Separate piece of work.
- Visa/onramp (Mercuryo, Paybis) with the recipient address as deposit target.
  The rail selector is written so this becomes one more source-asset entry later.
- Native (iOS/Android) rendering of the pay page. Web only — this is a link people
  open in a browser.
- Redesigning `/@username`; it keeps its passkey-login behaviour untouched.

## Rules encoded

- The destination is never a user choice. The recipient's rails are the only
  destinations, and the selector picks one; if none fits, the page says the source
  asset cannot be paid, not "choose another destination".
- No route branches on providers. `quoteSwap` answers or it does not.
- A swap for a stranger is only created once a refund address is known. No refund
  address → no order (fail-closed), because a failed swap with nowhere to refund
  strands the payer's funds.
- Direct rails create no order and no SwapKit call at all — address + QR only.
- Nothing on this page prompts for a passkey or reads `secureKeyStorage` unless the
  payer is already signed in.

## Design

### Routing

`lib/pay/payLinkPath.ts` — `parsePayLinkPath(pathname)`, mirroring
`lib/auth/passkeyUsernameLink.ts`: matches `^/pay/@([^/]+)/?$`, lowercases, validates
against the same `USERNAME` regex, returns `string | null`.

`App.tsx` gains `payLinkUsername` state next to `targetedPasskeyUsername` (line 235),
initialised the same way from `window.location.pathname` on web. When set, it renders
`<PayLinkScreen username={…} />` and suppresses `UnifiedHomeScreen`,
`PasskeyLoginScreen` and `UsernameOnboardingScreen` — the page must not ask a stranger
to log in. A signed-in payer keeps their session; the pay screen simply renders over it.

### Resolver

`lib/pay/resolvePayRecipient.ts`:

```
type PayRecipient = {
  username: string;
  lightningAddress: string | null;  // com.nuri.lightning
  evmAddress: string | null;        // com.nuri.evm
  arkadeAddress: string | null;     // com.nuri.arkade
  btcAddress: string | null;        // com.nuri.btc
};
```

Resolution uses ENSIP-10 wildcard resolution against mainnet through the existing
`withFallback(1, …)` helper in `lib/rpc/chainRpc.ts` (same path `lib/qr/resolveEns.ts`
already uses): `getResolver(name)` → `resolve(dnsEncode(name), text(node, key))` per
key, with CCIP-Read enabled. Returns `null` for an unregistered name (all four keys
empty) and throws only when every RPC is unreachable — same contract as
`resolveEnsName`: "no such user" and "we could not check" must not collapse into each
other. Result cached in-memory per username for the page's lifetime.

The parent domain comes from `ENS_PARENT_DOMAIN` (`config/constants.ts:9`). The gateway
answers only direct subnames of the parent, so `<username>.nuri.eth` is the only shape
built.

### Rail selection

`lib/pay/selectPayRail.ts` — a pure function, unit-tested, no I/O:

```
selectPayRail(source: SwapAssetId, recipient: PayRecipient): PayRail | null
```

| Source | Recipient endpoint | Rail |
|---|---|---|
| `BTC` onchain | `btcAddress` (boarding) | direct, no swap |
| `BTC_LIGHTNING` | `lightningAddress` | direct, LNURL-pay |
| `BTC_ARKADE` | `arkadeAddress` | direct |
| `USDC_BASE`, `EURC_BASE` | `evmAddress` | direct ERC-20 on Base |
| anything else routable | best available above | swap, `settleTarget` = that endpoint |

Preference order for the swap destination: `lightningAddress` → `evmAddress`
(USDC/EURC on Base) → `btcAddress`. Rationale: SwapKit settle output is Base-only
USDC/EURC (`src/ArkadeSwapIntent.js:78-86`) plus the Bitcoin rails, and Lightning
settles fastest with no gas.

There is **no per-user capability data** anywhere — the alias record is
`{evmAddress, safeAddress, ownerEoaAddress, arkadeAddress, btcAddress, email}` and
nothing more. Which chains and stablecoins are supported is therefore a client-side
constant (`BASE_STABLE_ASSETS` in `services/swapkit/SwapContract.ts`), not a
directory lookup. The selector must never infer support from the presence of a
record — a populated `com.nuri.evm` means "this address exists", not "this chain
is supported".

### Payer modes

**Signed-in nuri user.** Reuse `useMoveSwap` / `SwapContract` unchanged:
`MoveSwapRequest` already carries `settleTarget`, which is exactly the recipient
endpoint. Direct rails reuse the existing send services rather than the swap engines.

**Stranger (no account).** No wallet, so nothing can be signed locally:

- Direct rail → render the recipient endpoint as address + QR (`AddressQrTile`) or a
  BOLT11 obtained from the recipient's LNURL-pay endpoint. Nothing is created.
- Swap rail → `swap_execute` with `settleTarget` = recipient endpoint and
  `refundAddress` = an address the payer enters first; the returned `fund`
  instruction (deposit address or invoice, with QR) is what the payer pays from any
  external wallet. Status via `swap_track`, polled from the page.

Both stranger paths end in the same component in Phase 1: something to pay, rendered as
address + QR. The Phase 2 toggle slots in there — the payment target is already a
single value, so adding "pay with connected wallet" next to "show QR" changes how it is
paid, not what is paid. Build the payment target as a `{ kind, value, amount }` object
from the start so Phase 2 needs no rework of the resolver or the rail selector.

### UI

Mirrors the Move sheet (`screens/home/MoveSheet.tsx`), reusing
`components/SwapRouteChoices.tsx` and `components/SwapProcessingView.tsx`. The
destination card is not a picker: it is a fixed row showing `@username`. `@ds` only,
no hardcoded styles, `Spinner` not `ActivityIndicator`, every string through `t()`.
Failures flip button state; no error text (house rule).

## Tasks

Phase 1 — QR-only page (this plan).

1. `lib/pay/payLinkPath.ts` + test — path parser, mirroring `passkeyUsernameLink.ts`.
2. `lib/pay/resolvePayRecipient.ts` + test — ENSIP-10 text-record read via
   `withFallback(1, …)`, null vs throw contract, per-username cache.
3. `lib/pay/selectPayRail.ts` + test — pure source→rail mapping, full table above.
4. `screens/pay/PayLinkScreen.tsx` — recipient header, source-asset picker, amount
   input, route choice, processing view. Reuses the Move sheet's components.
5. `screens/pay/hooks/usePayLinkQuote.ts` — signed-in path over `useMoveSwap`;
   stranger path over `swap_execute` + `swap_track` with the payer's refund address.
   Returns a `{ kind, value, amount }` payment target, never a raw string.
5b. `components/PayTargetView.tsx` — renders one payment target as address/invoice +
   QR (`AddressQrTile`, `LightningInvoiceSheet` for BOLT11). The single seam Phase 2's
   connect/QR toggle plugs into.
6. `App.tsx` — `payLinkUsername` state and render gate; suppress the login,
   home and username-claim surfaces while it is set.
7. i18n keys for the new screen in the existing locale files.
8. `docs/screens.md` + `docs/codebase.md` — add the pay route and the resolver module.
9. Verify: `npm run lint`, `npm run typecheck` (unfiltered), `npm run test`, plus a
   live resolve of `lennard.nuri.eth`, `sinan.nuri.eth`, `cim.nuri.eth`,
   `emino.nuri.eth` returning all four records.

## Open risks (decided, not questions)

- **No rate limiting on the gateway.** `/ens` and `/arkade/lnurl/credential-hint/`
  are unauthenticated and unlimited, and the username→address map is already
  scrapable today. The pay page does not make this worse and does not try to fix it;
  it is a server-side concern to raise separately (an operator check on whether a
  proxy in front of prod limits it is unresolved).
- **`com.nuri.evm` has no code on Base** for the accounts checked, i.e. the gateway
  is serving an EOA. If it later serves an undeployed Safe, that Safe deploys on
  demand — no special handling here.
- **Fingerprint**: all changes are JS/TS app code only. No native deps, no config
  change, no new Expo plugin → no runtime-version change, OTA reaches existing builds.

## Progress Log

| Date | Agent | Task | Status | Notes |
|------|-------|------|--------|-------|
| 2026-08-18 | claude | plan | done | Verified ENS records live for 4 users; confirmed status endpoint refuses foreign usernames; confirmed no IBAN field server-side. |
| 2026-08-18 | claude | 1-9 (Phase 1) | done | QR-only pay page built end to end. Live resolve of `lennard` through the app's own module returned all four rails; unregistered name returned null. |
| 2026-08-19 | claude | PR #1123 review fixes | done | Split the pay page into its own app root (wallet init no longer runs for a visitor); LNURL invoice amount decoded and required to match; swap deposit QR carries the quoted amount + source token, with the figure shown next to the address. |
| 2026-08-19 | claude | PR #1123 second review round | done | Payment logic moved to `services/pay/PayTargetService`; Bitcoin amounts labelled in sats instead of ₿; invoice expiry carried on the target and the target dropped when it passes. |
| 2026-08-19 | claude | swap order tracking | done | `trackTxId` is now polled (`readPayOrderStatus` + `usePayOrderStatus`): the deposit QR carries a live status, and an order that ends anywhere but COMPLETED stops being offered. |
| 2026-08-20 | claude | PR #1123 third review round | done | Swap deposits fail closed on the provider's funding figure; the order id is read through `track` (`extractSwapKitOrderId`, now shared); a terminal order — settled or failed — withdraws the deposit address from the page. |
| 2026-08-20 | claude | PR #1123 fourth review round | done | Amounts are exact base-unit integers end to end (`exactBaseUnits`/`formatBaseUnits`), so the QR and the printed figure cannot drift; a deposit with no usable order id produces no target. |
| 2026-08-20 | claude | PR #1123 fifth review round | done | The swap refund address must be a real EVM address (`isValidEvmAddress`) before any order is created; the CTA stays disabled until it is. |
| 2026-08-20 | claude | PR #1123 sixth review round | done | A typed-but-unreadable amount disables the CTA instead of becoming an amountless QR; a failed build returns to the form (Try again + a back control) instead of repeating itself. |
| 2026-08-20 | claude | PR #1123 codex round | done | Invoice-funded swap orders are refused outright: every swap source here is an EVM stable, so a BOLT11 would be a QR paid in another asset under a USDC label — and that branch was also the one path still returning without an order id. |

## Handoff Notes

Phase 1 is implemented on this branch. What exists:

1. `lib/pay/payLinkPath.ts` (+ test) — `/pay/@username`, a separate matcher from the
   passkey login link so neither path can reach the other's flow.
2. `lib/pay/resolvePayRecipient.ts` — ENSIP-10 `resolve()` against the gateway for the
   four `com.nuri.*` keys, per-username cache, null for unregistered vs throw for an
   RPC outage. Verified live against the real gateway, then the throwaway live test
   was deleted (it would fail in CI without network).
3. `lib/pay/selectPayRail.ts` (+ test) — source → rail, null rather than a substitute
   destination. `USDC_ARBITRUM` is the one swap source in Phase 1.
4. `lib/pay/payTarget.ts` + `components/PayTargetView.tsx` — one payable value, one
   view. This is the Phase 2 seam.
5. `screens/pay/PayLinkScreen.tsx` + `screens/pay/hooks/usePayLinkTarget.ts` — asset
   list → amount/refund inputs → address-or-invoice + QR. Failures flip the button to
   "Try again"; no error text anywhere.
6. `App.tsx` — two roots: `App` reads the path and mounts either `PayLinkApp` or
   `WalletApp`. The split is above `WalletApp` because its init effect reads secure
   storage, starts the signed-in services and can reach `performSoftLogoutForRelogin()`;
   returning a different tree from inside it would have run all of that for a stranger.
7. en/de locale keys under `screen.PayLink`; parity test passes.
8. `docs/codebase.md` (§10 + Navigation) and `docs/screens.md` (`pay.link`).

Review fixes on top (PR #1123, taner + codex):

- The pay link is a separate root, not an early return (see 6 above).
- `usePayLinkTarget` decodes the BOLT11 the LNURL callback returns and refuses it unless
  its amount equals the requested sats, and refuses an already-expired one. LNURL binds
  nothing about the invoice to the amount asked for; the wallet's own send path
  (`ArkadeLightningSendService`) has always checked this.
- A swap deposit is exact-amount, so the QR is now an EIP-681 request on the SOURCE chain
  (`swapDepositUri`) carrying the provider's quoted figure and the source token, and the
  figure is written next to the address. Only the paying wallet can enforce the quote —
  this page cannot reconcile an under- or overfunded order.
- `buildTarget`/`lightningTarget`/`swapTarget` now live in
  `services/pay/PayTargetService.ts` (+ test). The hook holds request state only, per the
  repo's layer convention.
- The Bitcoin rails write "sats" and drop the ₿ glyph. Every rail here consumes the typed
  figure as sats, and the keypad has no decimal point for them — inside the app that reads
  as the wallet's own convention, but a stranger reads "₿1" as one bitcoin.
- `PayTarget.expiresAtMs` carries the invoice's own expiry, read off the BOLT11. An
  expired target is never returned, and one that expires while the page is open is dropped
  into the existing "Try again", which mints a fresh invoice.
- The swap order is tracked: `readPayOrderStatus` (service) + `usePayOrderStatus` (hook)
  poll `swap_track` every 12s until terminal. The target view carries the phase line, a
  COMPLETED order says the payment arrived, and any other terminal state drops back to
  "Try again" — a dead order's deposit address must stop being offered.
- `swapTarget` fails closed on the funding figure the way it already did on the refund
  address: no positive `fund.amount` (or a sats-denominated one, which this page has no
  source for) means no target, never the entered figure — an order that repriced settles
  for its own number, and a deposit funded with a different one sits unsettled.
- The order id is read through `track` as well. `extractSwapKitOrderId` now lives in
  `SwapKitService`; the three services that each carried their own copy call it.
- A terminal order takes the deposit address off the page: settled renders the "got paid"
  state instead of the target, failed renders "Try again". Neither leaves an address that
  can still be scrolled to, copied or scanned.
- Amounts are integers in the asset's smallest unit, converted ONCE (`exactBaseUnits`) and
  written back out from that same integer (`formatBaseUnits`). Float math is gone: 0.0000005
  used to encode 1 base unit in the QR while printing 0. A figure with more precision than
  the asset holds — typed or quoted — produces no target rather than a rounded one.
- An address deposit with no usable order id produces no target: the tracking is what
  withdraws a dead deposit, so an untrackable one would stay payable forever.
- The refund address is validated with `isValidEvmAddress` before `swap_execute` is called,
  the way `StableToBtcSwapService` validates its own. It is the last gate before an order
  exists: after it, a typo is a refund destination the payer does not control.
- An amount is optional only while the field is EMPTY. A non-empty figure that cannot be
  read exactly (`.5`, `1.`, half a base unit) disables the CTA; it used to be dropped, so
  the payer got a QR for no amount after typing one.
- A failed build returns to the form: "Try again" resets to the inputs, which keep what was
  typed, rather than repeating the request that just failed; the topbar back control is
  present in that state too.
- A swap order that comes back with invoice funding produces no target. The page's only
  swap sources are EVM stables; a BOLT11 asks for bitcoin, so the payer would scan a QR
  their wallet pays in a different asset under a label that still says USDC. Removing that
  branch also removes the one return path that could hand back a target with no order id.

Verification: `npm run typecheck` clean, `npm test` 1033 passed / 122 files,
`npx biome check` clean on every touched file.

Still true from the planning pass:

1. ENS gateway serves `com.nuri.{lightning,evm,arkade,btc}` publicly for registered
   usernames; the ENS web app cannot enumerate them (subgraph, no events).
2. `POST /v4/arkade/lnurl/status` refuses foreign usernames — not a resolver.
3. SEPA/IBAN exists in no record, no column and no handler; excluded from scope.
4. SwapKit settle output is Base-only USDC/EURC plus the Bitcoin rails.

Not done, deliberately:

1. No amount is encoded into the address QRs (no BIP21/EIP-681) — the plain address is
   what the recipient's own receive sheets show, and inventing a URI format was not
   asked for. Lightning and swap rails do carry the amount, because their target is
   minted for it.
2. Swap arrival is not polled on the page: `PayTarget.trackTxId` is carried but nothing
   consumes it yet. A stranger sees the deposit address, not a live status.
3. Phase 2 (RainbowKit/wagmi for EVM, WebLN for Lightning, connect/QR toggle) is
   untouched. It must work on mobile browsers too — the app is a PWA, so the connector
   layer needs WalletConnect-style deep links, not an extension-only path.
