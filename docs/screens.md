# Screen Registry

The canonical list of every user-facing screen in the app, each with a **stable slug ID**. Use the slug — never "the green screen" or a component name — when talking about a screen in issues, PRs, logs, or with agents.

## The convention

- **ID = `domain.name`** (kebab-case), e.g. `bitcoin.receive-unlock`. A third level marks a real variant of a parent screen, e.g. `auth.login.native`.
- **The slug is decoupled from the file and component name.** Renaming a component never changes its slug. This is deliberate: the slug is the stable reference, so we never have to rename files just to fix a confusing name.
- **Domains:** `auth · lock · onboarding · bitcoin · card · wirex · wallet · swap · app`. `app` = cross-cutting screens not owned by one feature.
- **Every screen file carries a header tag** as its first line: `// @screen <slug>`. Grep `@screen` to find any file's ID; look it up here for the rest.

### What counts as a screen

A **screen** is a distinct destination the user is *on* — a full page, modal, sheet, or blocking gate with a fixed identity. A **shell** (e.g. `ModalSheet`, `FullScreenModal`, `FullscreenLayer`, `QrCard`) is a reusable building block whose title/meaning comes from its caller, or which only renders *inside* another screen. **Shells are not tagged.** Test: can you stand in the running app and say "I'm on this screen"? If its title is passed in by a parent, it's a shell.

## Adding a new screen

1. Pick a slug `domain.name` not already used below.
2. Add `// @screen <slug>` as the first line of the screen's file.
3. Add a row to the matching table here.

---

## Web hosting / deep-link delivery

`app.nuri.com` is served by the Cloudflare Worker in `cloudflare/`. Its static-assets
configuration intentionally returns the Expo SPA shell for unknown non-API paths, so a direct
visit or reload of `/@username` and `/pay/@username` reaches the app-root routing described
below. `/api/*` is handled separately by the Worker and never falls back to the SPA.

## auth — sign-in / passkey

| Slug | Component | File | Purpose |
|------|-----------|------|---------|
| `auth.login` | PasskeyLoginScreen | `components/PasskeyLoginScreen.tsx` | Root login screen; routes to the Native or WebView passkey variant. Title "BITCOIN WALLET · VISA & IBAN". Top-right headphones icon opens WhatsApp support (wa.me deep link). |
| `auth.login.native` | PasskeyLoginScreenNative | `components/PasskeyLoginScreenNative.tsx` | Native passkey create/login (platform APIs). Variant of `auth.login`. |
| `auth.login.webview` | PasskeyLoginScreenWebView | `components/PasskeyLoginScreenWebView.tsx` | WebView passkey create/login (fallback). Variant of `auth.login`. |
| `auth.continue-or-switch` | PasskeyContinueOrSwitchModal | `components/PasskeyContinueOrSwitchModal.tsx` | Continue with the hinted passkey or pick a different one. |

## lock — app lock / unlock gate

| Slug | Component | File | Purpose |
|------|-----------|------|---------|
| `lock.biometric` | BiometricLockModal | `components/BiometricLockModal.tsx` | Biometric/PIN gate shown when the app is locked on resume. Renders `WalletAccessController` outcomes (`unlocked · cancelled · timeout · recovery_required · wrong_wallet · failed · in_flight`): one ceremony at a time, each bounded by `WALLET_ACCESS_TIMEOUT_MS`, the CTA disabled only while one is in flight, and localized retry copy after a cancel, a timeout or a failure. An unreadable entry defers passkey recovery to a deliberate tap, which then goes straight to it. On web it is a REPAIR only — a browser has no authenticator, so no periodic gate engages it, but keys a read cannot find are rebuilt from the passkey there too. Built on the shared `FullscreenLayer`. |

## onboarding

| Slug | Component | File | Purpose |
|------|-----------|------|---------|
| `onboarding.username` | UsernameOnboardingScreen | `screens/onboarding/UsernameOnboardingScreen.tsx` | Blocking screen to claim a Lightning username during signup. |

## pay

| Slug | Component | File | Purpose |
|------|-----------|------|---------|
| `pay.link` | PayLinkScreen | `screens/pay/PayLinkScreen.tsx` | Public payment link at `/pay/@username` (web). No session, no wallet, no passkey: rails come from the public ENS directory, the payer picks the asset they hold, and the screen preserves the source/amount/recipient summary above a QR with a shortened one-line recipient above it and "Tap to copy" below (copies the full payment URI), with additive Bitcoin/Lightning OS wallet handoff. Web frame is capped at 430px; WalletConnect runtime remains deferred. Owns the app root when the URL matches, so no signed-in surface shows through. |

## bitcoin

| Slug | Component | File | Purpose |
|------|-----------|------|---------|
| `bitcoin.receive` | ReceiveModal | `components/ReceiveModal.tsx` | Shared receive sheet (`@component receive`): Lightning <-> on-chain on Bitcoin, ENS name <-> EVM address on Wallet. A failed address derivation states so and offers a retry instead of "no address yet". |
| `bitcoin.receive-unlock` | PaymentReceivedModal | `screens/bitcoin/components/PaymentReceivedModal.tsx` | Green "Payment Received" gate; passkey-unlock to claim an inbound Arkade payment. Runs every actionable item in one session and stays open while any remain. Auto-opens on actionable work, and reopens on demand via `ARKADE_OPEN_UNLOCK_WALLET_EVENT` — the arkade rail's pending-sweep row, since a boarding sweep has no path but this modal. |
| `bitcoin.ln-invoice` | LightningInvoiceSheet | `components/LightningInvoiceSheet.tsx` | Create a Lightning invoice (amount, bolt11 QR, expiry). |
| `bitcoin.send` | BitcoinSendScreen | `screens/bitcoin/modals/BitcoinSendScreen.tsx` | One recipient field, four rails: a Bitcoin address, an ark address, a BOLT11 / Lightning address, or a Tanzanian phone number. See below — the recipient decides the rail, the wallet and the limits. |
| `bitcoin.transactions` | BitcoinTransactionsModal | `screens/bitcoin/modals/BitcoinTransactionsModal.tsx` | Bitcoin transaction history + CSV export. |
| `bitcoin.buy` | MercuryoBuyBitcoinModal | `screens/bitcoin/modals/MercuryoBuyBitcoinModal.tsx` | Buy Bitcoin with fiat via Mercuryo: enter the amount, then hand off to the OS browser. |

### bitcoin.send — what the recipient decides

The field is free text and the same for every rail, so what was pasted decides
everything downstream. `isBolt11Invoice` / `isLnurlPaymentInput` /
`isValidBitcoinAddressMainnet` / `isArkAddress` /
`normalizeTanzanianMobileNumber` are the single choke point.

| Recipient | Rail | Amount | Limits |
|-----------|------|--------|--------|
| BOLT11 invoice | Arkade Intents corridor (`ArkadeLightningSendService` → `SwapKitArkadeLightningSendService`) | Fixed by the invoice; the keypad locks to it and an expired one is refused | 500–50 000 sats, the solver's card |
| Lightning address / LNURL | Same corridor, after resolving the pay request | Typed, held to `max(provider min, corridor min)` | As above |
| Ark address | `sendArkadeToArk` | Typed | The node's live `vtxoMinAmount`, checked before the approval |
| Tanzanian phone number | `services/remit/RemitService.ts` mints a BOLT11 for the number, then the same Arkade Intents corridor pays it; the corridor pays the phone out in TZS via ClickPesa once that invoice settles | Typed in **TZS**, not sats. A debounced `quote_tzs` writes the quoted sats into the sats field, so every guard below applies unchanged. What is finally spent is the amount inside the minted invoice, re-checked against the balance before dispatch | The Lightning corridor's, as above |
| Bitcoin address | The source picker decides: `sendArkadeBitcoinOnchain` (a collaborative exit) from the arkade rail, or `sendBitcoinOnchainFromMusig2` (`services/bitcoin/OnchainSendService.ts`) from the MuSig2 wallet | Typed | The node's live `utxoMinAmount` either way. From arkade: the SETTLEABLE balance, not the spendable one. From the MuSig2 wallet: that wallet's own on-chain spendable figure (`detail.onchain.spendable`), less the estimated miner fee |

Two figures, not one. Everything the wallet can spend offchain — settled,
too-fresh and preconfirmed VTXOs — funds a Lightning or ark send. Only an
on-chain exit joins a batch round, so it is capped by what may be settled and
the screen says `Max X available` rather than calling the balance insufficient.

The MuSig2 rail is the other way round: it pays a miner fee on top of what the
recipient receives, out of the same wallet, so the screen holds the estimated
fee back from what it offers. Both figures come from the ONE L1 address the app
derives — reading a second address, or the balance of one, is not something this
app does (AGENTS.md).

Whichever rail signs, it signs with **Nuri Cosigner v4 on `arkade.nuri.com`**
under a native passkey assertion: no browser confirm step, no second signer.
`sendBitcoinOnchainFromMusig2` registers the server swap intent that binds
recipient and amount BEFORE the approval is armed, so the co-signer validates
the spend against server-held figures rather than against the PSBT alone.

The corridor is the only rail that funds before it is paid: it puts sats into a
lockup the solver claims by paying the invoice. When the solver goes dark, the
refund is a SECOND act with its own approval, and the record it needs was
written before the funding (`lightningSendStore`) — recovery is owned by
`SwapKitV2LightningResume` and the v2 action journal, using the existing Arkade refund signer. The screen does not drive recovery. The screen's own
post-submit responsibility ends at the pending row: once the sats are gone
nothing here may reclassify the send as failed.

## card

| Slug | Component | File | Purpose |
|------|-----------|------|---------|
| `card.kyc-sumsub` | SumsubWebModal | `components/SumsubWebModal.tsx` | Sumsub KYC (face/document) in a full-screen WebView. Shared by Wirex onboarding. |

## wirex — Wirex card

| Slug | Component | File | Purpose |
|------|-----------|------|---------|
| `wirex.cardDetails` | WirexCardDetailsModal | `screens/wirex/WirexCardDetailsModal.tsx` | Card + bank details reveal (PAN/expiry/CVV/PIN, IBAN/BIC), freeze, daily-limit sub-page. |
| `wirex.cardLimit` | WirexCardLimitEditor | `screens/wirex/WirexCardLimitEditor.tsx` | Inline daily spending-limit editor (sub-page of `wirex.cardDetails`). |
| `wirex.cardTransactions` | WirexCardTransactionsModal | `screens/wirex/WirexCardTransactionsModal.tsx` | Merged Wirex activity feed (card + SEPA/bank + onchain deposits) + CSV export. |
| `wirex.send-choice` | WirexSendChoiceModal | `screens/wirex/modals/WirexSendChoiceModal.tsx` | Choose how to send: withdraw to wallet (opens the Move card, `visa` → `wallet`) or SEPA bank transfer. |
| `wirex.sepa-recipient` | SepaRecipientModal | `screens/wirex/modals/SepaRecipientModal.tsx` | Enter recipient IBAN/BIC + name for a SEPA transfer. |
| `wirex.sepa-confirm` | SepaAmountConfirmationModal | `screens/wirex/modals/SepaAmountConfirmationModal.tsx` | Confirm SEPA amount + recipient before submitting. |
| `wirex.order-physical` | WirexPhysicalCardOrderModal | `screens/wirex/modals/WirexPhysicalCardOrderModal.tsx` | Physical-card order flow (country → delivery method → fees → address → order). |
| `wirex.3ds-approval` | Wirex3dsApprovalModal | `screens/wirex/modals/Wirex3dsApprovalModal.tsx` | Fullscreen in-app 3DS challenge approval: merchant, amount, card last-4; approve/decline with a signed response. |

## wallet — EUR stablecoin (Base)

| Slug | Component | File | Purpose |
|------|-----------|------|---------|
| `wallet.send-choice` | WalletSendChoiceModal | `screens/wallet/modals/WalletSendChoiceModal.tsx` | Choose where the euro/dollar balance goes. Card and Bitcoin open the Move card with both ends chosen (`wallet`/`dollar` → `visa`/`arkade`); Crypto wallet opens the scanner, because only a recipient outside the app needs collecting. |
| `wallet.send` | WalletSendStablecoinModal | `screens/wallet/modals/WalletSendStablecoinModal.tsx` | Send stablecoin to an EVM address on Base. |
| `wallet.transactions` | WalletTransactionsModal | `screens/wallet/modals/WalletTransactionsModal.tsx` | Onchain (Base) transaction history + CSV export. |

## swap — swap flows

The existing `screens/swapkit/SwapStatusDetailSheet.tsx` offers a current-rate quote and one explicit Continue action for eligible funded Bitcoin-to-euro orders (#1325). It shows the estimated amount, fixed minimum, and expiry before signing. It creates no new page or deposit; unresolved confirmation retries the identical checkpoint.

`SwapKitWalletOpenRecoveryHost` presents that same sheet at the authenticated app root, using the track cache and existing hydration events. It binds the unlocked owner and original recipient, waits behind open surfaces, and suppresses repeat presentation per order per session. Presentation does not submit acceptance; accepted checkpoints remain with the tracker.

| Slug | Component | File | Purpose |
|------|-----------|------|---------|
| `swap.sweep-claim` | SweepClaimSheet | `screens/swapkit/SweepClaimSheet.tsx` | The "we found money" sheet: surfaced by `checkSwapKitSweep` when a wallet has claimable swept balances **or** chain-sourced `refundable[]` HTLC locks that are refundable right now — a wallet with zero loose balance but one recoverable stuck swap still sees it. One tap runs `claimSwapKitSweep`, which recovers refundable locks first (independent, best-effort permissionless `refundTo` per lock, verified against the coordinator's `deposits(key)` owner) and then arms each claimable balance. The sheet stays open only on a SETTLED refusal (nothing started, nothing refunded, this app locally refused, nothing unresolved); any started/refunded/unresolved outcome closes it. |

## app — cross-cutting

| Slug | Component | File | Purpose |
|------|-----------|------|---------|
| `app.home` | UnifiedHomeScreen | `screens/home/UnifiedHomeScreen.tsx` | **The app's only screen.** Total Balance lists Bitcoin, Cash, Card & Banking in EUR (unknown conversions remain unavailable; shared Wirex funds count once). Rows select onchain, wallet, visa without activating accounts. Universal carousel order: Total, onchain, arkade, wallet, dollar, visa, iban, including inactive rails. Always starts and resets on Total, whether empty or funded; async balance refreshes never change selection. Explicit group taps, swipes and deep links retain their intended navigation. Header scanner becomes back-to-Total X on every selected rail. Authentication and transaction handlers are unchanged. Owns the Wirex readiness poll, support deep-link card-detail drain and app-wide overlay teardown. |
| `app.asset` | AssetScreen | `screens/home/AssetScreen.tsx` | A rail's full detail layer behind a home row: that rail's balance, one row per currency it holds, Receive/Send, in-flight transfers and transaction history. Its activity list is shared with the carousel's inline panel so both surfaces call the same history/detail actions. The arkade rail adds a pending-sweep row while boarding funds are `sweep_ready`. |
| `app.move` | MoveSheet | `screens/home/MoveSheet.tsx` | The swap sheet: pick a source and destination rail, type the amount on either side, then Next prices the move through `quoteSwap` and shows what it would pay out; accepting one of those prices is what calls `executeSwap`. Pairs with no exchange in them are handed back to the home, which answers `transferred` / `handed-off` / `unhandled` — the sheet holds the screen while a transfer runs and only closes on one that happened. The card appears here as its two pockets, VISA Euro and VISA Dollar: filling the matching one is a transfer (EURC or USDC to the same deposit address), crossing them is a priced swap (the pocket carries the stable it settles plus that address), and bitcoin into either is priced and executed by the same bitcoin-to-stable engine as a move into the wallet, settling that pocket's stable (EURC or USDC only) on the card account. |
| `app.home.add-money` | AddMoneyChoiceModal | `screens/home/AddMoneyChoiceModal.tsx` | The "Add money" branch, one entry per way money reaches the app: **Euro** and **Bitcoin** open Receive on the address that takes them (the EVM wallet, the onchain bitcoin wallet); **IBAN** shows the Wirex account's bank details, or starts the signup that creates one when there is no approved account (a verification already under way is resumed); **Apple / Google Pay** buys bitcoin through Mercuryo. |
| `app.logout-confirm` | LogoutConfirmSheet | `components/LogoutConfirmSheet.tsx` | Confirmation in front of the logout, reached by tapping the home greeting eight times in a production build (the same gesture opens the debug hub in a dev build). States what leaves the device, that the passkey belongs to the OS/password manager and is not deleted, that funds and accounts are untouched, and that signing back in needs that passkey. Cancel tears down nothing; confirming calls `requestUserLogout()` once, which runs the full factory reset and reloads into neutral passkey onboarding. If the teardown aborts part-way the sheet becomes a non-dismissible recovery state offering only Try again. It has a second mount at the app root, never opened by a gesture: a `/@username` link replacing the wallet in place goes through `requestWalletReplacement()`, and an aborted wipe there raises this same sheet over every flow, already in its blocked state, with Try again running the full `requestUserLogout()` teardown. |
| `app.update-required` | PleaseUpdateAppModal | `components/PleaseUpdateAppModal.tsx` | Full-screen blocker prompting an app update. |
| `app.faq` | FAQModal | `components/FAQModal.tsx` | FAQ with expandable answers. |
| `app.support-chat` | NostrChatModal | `components/NostrChatModal.tsx` | Full-screen encrypted support chat over Nostr; opens automatically when unread sync detects a new support message. |
| `v1-wallet-migration-screen` | V1WalletMigrationScreen | `screens/migration/V1WalletMigrationScreen.tsx` | `v1.nuri.com` wallet migration, reachable through the internal `nuri://v1-wallet-migration-screen` link. **iOS:** full-screen in-app WebView (WebAuthn works). **Android:** opens a Chrome Custom Tab via `WebBrowser.openBrowserAsync` (the Android WebView has no WebAuthn since the native opt-in was reverted for the OTA fingerprint); the screen renders `null` and returns via a `nuri://` deep link, so `returnScheme` is passed to v1. |
| `app.support-dump` | SupportDumpModal | `components/SupportDumpModal.tsx` | Send an encrypted debug-state dump to support. |
| `app.qr-scanner` | QrScannerModal | `components/QrScannerModal.tsx` | Scan a QR or paste an address/URI for send/receive. |
| `app.success` | GenericSuccessModal | `components/GenericSuccessModal.tsx` | Full-screen success confirmation (title "Success") rendered app-level after completed flows, triggered by the `ui:showGenericSuccess` event. |

---

## Not tagged (shells / inline sections)

Reusable building blocks and inline sections — intentionally **not** screens:

- **Structural chrome:** `ModalSheet`, `FullScreenModal`, `ModalHeaderWithCloseButton`, `TransactionsModalShell`, `BalanceScreenLayout`, `ScreenHeader`
- **Content widgets:** `Card`, `QrCard`, `InfoCard`, `InlineInfoCard`, `CardLimitControl` (shared limit editor inside `wirex.cardLimit`), `SupportModals` (wrapper that renders `app.support-chat`)

> Debug screens (`screens/debug/**`) are out of scope for this registry.


### SwapKit v2 status and Pay deposits

`SwapStatusDetailSheet` reads v2 status using the order's persisted recovery capability, shows accepted route/execution amounts, and offers explicit Continue through the same bounded executor reconstruction used at startup. Bitcoin, wallet, and card activity rows read the v2 tracker. App startup resumes v2 commit intents and orders; the v1 recovery host is no longer mounted.

Pay's direct address and Lightning rails are unchanged. Swap rails quote and commit v2 `send_asset` actions and display only a valid deposit for the chosen token, with its exact amount and deadline. Status polling uses the Pay order's own saved recovery capability without requiring a Nuri login.
