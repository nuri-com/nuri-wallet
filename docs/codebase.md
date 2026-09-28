# Nuri Expo - Codebase Guide

> A React Native / Expo bitcoin wallet app with Wirex Visa card issuance, EUR stablecoin on Base (IBAN/SEPA), passkey wallet creation, Lightning swaps, and more.

**Source baseline:** PWA 0.99.2 (`1ef9850af9b05b2e58b8bd7054e3828c3c11a1a5`) | **React Native:** 0.79.6 | **Expo:** ~53.0.27 | **React:** 19.0.0 | **Node:** 22.21.1 (Volta configuration; the recorded deployment used 22.23.2)

Start with [the current web source map](transparency.md) and [publication readiness](open-source-readiness.md). The detailed inventory below includes historical module names and is not a declaration that every listed path is active in this release. In particular, new swaps use the v2 entrypoints documented in the source map.

---

## Quick Start

```bash
# Install the committed dependency versions (review install hooks first)
npm ci --legacy-peer-deps

# Start dev server (requires dev client build on device/sim)
npm start              # expo start --dev-client
npm run dev            # expo start --dev-client --lan

# Run on platforms
npm run ios            # expo run:ios
npm run android        # expo run:android
npm run web            # expo start --web

# Clear cache
npm run clear          # expo start --clear

# Prebuild native dirs
npm run prebuild       # expo prebuild
```

### Environment Setup

1. Copy `.env.example` to `.env` and fill in API keys
2. Key env vars:
   - `EXPO_PUBLIC_FAUCET_RELAY_URL` - Faucet relay endpoint
3. For Play Store submissions: place service account key at `./local-only/play-service-account.json`

### Other Useful Scripts

```bash
npm run guardian                  # Guardian server on port 8080
npm run package:register          # Package registration
npm run wf                        # Multi-agent workflow CLI (see CLAUDE.md)
npm run check:cosigner-boundary   # MISSION-CRITICAL guard: the app runtime is v4-only (see AGENTS.md)
```

---

## Project Structure

```
nuri-expo/
├── .github/
│   ├── ISSUE_TEMPLATE/agent-ready.yml  # Human-verified Ready/R-A-R-A issue contract
│   └── workflows/deploy-selected-ref.yml # Manual branch+commit PWA deploy + release tag
├── cloudflare/             # app.nuri.com Worker: static Expo assets, same-origin API proxy, LNURL SSRF guard
├── App.tsx                    # Root component - auth, app-level overlays, deep linking (~1,650 lines)
├── index.js                   # Entry point - polyfills, debug log buffer, Metro async-chunk loader (web), registerRootComponent
├── designSystem.ts            # Strict design tokens (colors, typography, rules)
│
├── screens/                   # Domain-based screen folders (each screen file is tagged // @screen <slug>; see docs/screens.md)
│   ├── home/                  # THE screen: UnifiedHomeScreen + universal carousel state, AssetScreen (per-rail detail), MoveSheet (swap), AddMoneyChoiceModal
│   │   ├── rails.ts           # RailKey + the `nav:openHomeRail` event deep links route through
│   │   ├── homeCarousel.ts    # Carousel rail selection + ordering helpers (universal, all platforms)
│   │   ├── homeOverview.ts    # Three EUR groups, shared Wirex counted once, fixed paired carousel order
│   │   └── hooks/             # useWirexCardReadyPoll, useCardDetailDeepLink
│   ├── bitcoin/
│   │   ├── hooks/             # useBitcoinBuyFlow, useArkadeReceiveUnlock
│   │   ├── components/        # PaymentReceivedModal, BitcoinSourceBalances
│   │   └── modals/            # BitcoinReceiveModal, BitcoinSendScreen, BitcoinSendSourceModal, BitcoinTransactionsModal, MercuryoBuyBitcoinModal
│   ├── wirex/                 # WirexCardDetailsModal, WirexCardLimitEditor, WirexCardTransactionsModal, Wirex3dsApprovalHost, modals/ (WirexSendChoiceModal, SepaRecipientModal, SepaAmountConfirmationModal, WirexAppleWalletModal, WirexEmailEntryModal, WirexPhysicalCardOrderModal, Wirex3dsApprovalModal), hooks/ (useWirexCard, useWirexCardLifecycle, useWirexCardReveal, useWirexAppleWallet, useWirexOnboarding, useWirexSendFlow, useWirexPhysicalCardOrder, useWirex3dsChallenges)
│   ├── wallet/
│   │   ├── hooks/             # useWalletSendFlow, walletPendingOptimism
│   │   └── modals/            # WalletReceiveModal, WalletSendChoiceModal, WalletSendStablecoinModal, WalletTransactionsModal
│   ├── swapkit/               # SwapStatusDetailSheet, SweepClaimSheet, SwapKitWalletOpenRecoveryHost
│   ├── onboarding/            # UsernameOnboardingScreen
│   ├── migration/             # V1WalletMigrationScreen (v1.nuri.com)
│   ├── debug/                 # DebugModal and debug-only full-screen/modal tools
│
├── components/                # Reusable UI components (screen-level ones are tagged // @screen; shells are not — see docs/screens.md)
│   ├── typography.tsx         # Body, BodyBold, H1-H4, Caption, Subtitle, TextLink, DisplayHeadline
│   ├── layout.tsx             # Row, Section, KeyValueRow, Divider
│   ├── Button.tsx             # Standard button (7 variants, 4 sizes: xlarge[desktop only]/large/medium/small)
│   ├── IconButton.tsx         # Round icon button (optional label below, 3 sizes: large/medium/small)
│   ├── Spinner.tsx            # Unified ActivityIndicator (5 variants: pending/loading/overlay/button/buttonDark)
│   ├── AmountInput.tsx        # Currency/amount input
│   ├── HomeCardCarousel.tsx   # Magnetic top-card rail; reports selection only after swipe settle
│   ├── TappableBalance.tsx, BalanceDigits.tsx, BalanceScreenLayout.tsx  # Balance display
│   ├── FloatingTransactionStatus.tsx, NetworkPendingBadge.tsx, NotificationBadge.tsx, StatusPill.tsx
│   ├── AddressDisplay.tsx     # Truncated address display
│   ├── Label.tsx, Tag.tsx, Chip.tsx   # Figma DS components
│   ├── Card.tsx, DSSwitch.tsx, InfoList.tsx, InfoCard.tsx, InlineInfoCard.tsx
│   ├── FullScreenModal.tsx    # Shared full-screen modal scaffold (FullScreenTitle, FullScreenContent)
│   ├── BrandStatusView.tsx    # Shared fullscreen status body (brand title, amount, caption, illustration, CTA)
│   ├── BrandDisplayTitle.tsx  # Harriet display headline for fullscreen status/success screens
│   ├── ModalSheet.tsx         # Reusable bottom sheet modal (option list)
│   ├── ModalHeaderWithCloseButton.tsx  # Modal header with close button
│   ├── TransactionsModalShell.tsx  # Shared transaction list modal shell (loading, refresh, CSV export)
│   ├── QrCard.tsx, QrScannerModal.tsx  # QR display / scan
│   ├── InputField.tsx, CountryDropdown.tsx, UsernamePicker.tsx  # Inputs
│   ├── PopRiffleView.tsx, ProgressBar.tsx  # Animations / progress
│   ├── FullscreenLayer.tsx    # Layer + safe areas + the padded column every fullscreen Layer surface shares
│   ├── BiometricLockModal.tsx, PleaseUpdateAppModal.tsx  # Wallet-access / update gates
│   ├── PasskeyLoginScreen.tsx (+ Native/WebView), PasskeyContinueOrSwitchModal.tsx, PasskeyWebAuthnPrfView.tsx  # Auth
│   ├── LegacyWalletDetectedBanner.tsx  # Legacy-wallet detection / sign-out banner
│   ├── NostrChatModal.tsx, SupportModals.tsx, SupportButton.tsx, ChatBubble.tsx  # Full-screen Nostr support chat
│   ├── SumsubWebModal.tsx, SupportDumpModal.tsx, FAQModal.tsx, GenericSuccessModal.tsx
│   └── ...
│
├── services/                  # Domain-based business logic services
│   ├── auth/                  # AuthStateService, PasskeyNativeModuleService, PasskeyPrfWalletBootstrapService
│   ├── bitcoin/               # BlockchainService, WalletService, Musig2WalletKeys, OnchainSendService, BitcoinBootstrapService, SigningContextStore, PendingBitcoinSendsStore, PendingSendsReconciler, BitcoinAddressService, BitcoinBalanceDriver, BitcoinBalanceService, BitcoinBalanceStore, balanceShape, cachedBalance, BitcoinSendService, BitcoinTransactionsService, BtcL2Provider, LnurlService (+ providers/)
│   ├── arkade/                # ArkadeAddressService, ArkadeApiService, ArkadeWalletService, ArkadeSendService, ArkadeLightningSendService, ArkadeLightningReceiveService, ArkadeReceiveOrchestrator, ArkadeReceiveUnlockService, ArkadeRecoveryBackupService, ArkadeRemoteIdentity, ArkadeRemoteSignerSession, ArkadeServerConfigService, ArkadeServerDecayPolicy, ArkadeTransactionHistoryService, ArkadeClientRecoveryContract, ArkadeCredIdAccountService, ArkadeDeprecatedSignerMigrationService, ArkadeLnurlService, ArkadeUnlockSupportService, ArkadeVersion (+ debug/, internal/, types/)
│   ├── base/                  # BaseTokenTransferService (EURC on Base)
│   ├── wirex/                 # WirexService, WirexAccountService, WirexProvisioningRepairService, wirexConfig
│   ├── swapkit/               # SwapKitService, SwapKitCardTopupService, StableToBtcSwapService, SwapKitPendingTracker, SwapKitWalletOpenRecovery (owner-bound eligibility for the app-root recovery host; no second execution engine)
│   ├── balance/               # BalanceCacheService, BalanceReconcileService, MultiCurrencyBalanceService, TransactionCacheService (+ transactions/)
│   ├── pricing/               # PriceService, FxRateService, BtcSpotPriceService, SolverPriceService
│   ├── nostr/                 # NostrUnreadSync
│   ├── notifications/         # NotificationService (+ .web twin), NotificationRegistrationService, notificationRouting, DevDeviceRegistry, ExpoPushClient, notificationTypes
│   ├── logging/               # NetworkLogger, DebugLogBuffer, LoggerService
│   ├── support/               # SupportDumpService
│   ├── events/                # AppEventBusService
│   ├── mercuryo/              # MercuryoOrderStore, MercuryoStatusService, MercuryoPendingTracker
│   ├── app/                   # AppUpdateService, OtaUpdateService, OtaUpdateAutoApply, FactoryResetService, AlertSuppressionService, WebViewSessionService, PendingPurchasesStore, NetworkStatusService, BalanceDriversService, ForegroundPoller, SoftLogoutService, UserLogoutService, V1WalletMigrationService, wipeStorageKeys
│   └── ...
│
├── lib/                       # Utility libraries (22 subdirectories + top-level helpers)
│   ├── crypto.ts              # SHA256, HKDF, XChaCha20-Poly1305, zeroization
│   ├── secureKeyStorage.ts    # iOS Keychain / Android biometric storage
│   ├── walletDerivation.ts    # HKDF-SHA256 entropy derivation from PRF
│   ├── musig2Agg.ts           # MuSig2 key aggregation
│   ├── amounts.ts             # Decimal truncation
│   ├── bytes.ts               # Hex/bytes/base64 conversions
│   ├── ibanFormat.ts          # IBAN display formatting
│   ├── logging.ts             # Structured logging with emoji tags
│   │
│   ├── bitcoin/               # Bitcoin address validation, BIP-86 Taproot
│   ├── arkade/                # Arkade (Ark L2) client helpers
│   ├── ethereum/              # Ethereum address utilities
│   ├── wirex/                 # Wirex card + smart-account helpers (AA bootstrap, SEPA, card actions, activity merge, provisioning-repair decision, sandbox live E2E)
│   ├── currency/             # HomeCurrencyService (home-currency selection / conversion)
│   ├── swapkit/               # SwapKit rate hook (useSwapKitRate)
│   ├── mercuryo/, applepay/, sumsub/, qr/, wallet/, auth/, phone/  # Feature-specific helpers
│   ├── nostr/                 # Nostr protocol (messaging, storage, unread)
│   ├── rpc/                   # Base / chain RPC providers (baseRpc, chainRpc)
│   ├── faucet/                # Base gas faucet (via Wirex proxy)
│   ├── debug/, support/, crypto/  # Misc helpers
│   ├── web/                   # PWA-only shims: apiProxy (same-origin /api/* rewrites + LNURL forwarder), metroAsyncRequire (Metro's async-chunk loader, #1473), appViewportHeight, WebViewWeb, ReactNativeKeychainWeb
│   └── i18n/                  # Localization (English + German)
│
├── config/                    # Configuration
│   ├── constants.ts           # App constants (poll intervals, pubkeys, timeouts)
│   ├── endpoints.ts           # API endpoints
│   ├── network.ts             # Per-build network switch (`extra.appNetwork`) + pinned public hosts
│   ├── passkey.ts             # WebAuthn RP ID for the wallet login/recovery flows (identity only, not a signer endpoint)
│   ├── arkadeContract.json    # Arkade contract config
│   └── babel/                 # Custom Babel plugin (font scale locking)
│
├── types/                     # Domain-based TypeScript definitions
│   ├── bitcoin.ts, BitcoinCheckSequenceVerifyCSV.ts, debug.ts
│   ├── mercuryo.ts, shared.ts, swapkit.ts, wallet.ts
│   └── lib/                   # Types for lib modules
│
├── tools/                     # CLI tools
│   └── wf.mjs                 # Multi-agent workflow CLI; temporary plans live gitignored under .wf/plans/
│
├── (backend microservices live in the nuri-servers repo — not in this app)
│
├── scripts/                   # top-level .mjs scripts + mirror/
│   ├── bump-version.mjs       # Bumps appVersion in app.config.ts (build numbers are EAS-managed)
│   ├── generate-app-variant-assets.mjs  # Per-variant icon/splash asset generation
│   ├── package-register.mjs   # Package registration helper (npm run package:register)
│   ├── arkade-*.mjs           # ~19 Arkade proof / e2e / recovery scripts
│   ├── mirror/                # Server mirror/verify scripts (5 files)
│   └── wirex/                 # Wirex local-up/down + Auth0 token probe (3 files)
│
├── assets/                    # Images, fonts, icons
│   ├── icons/                 # SVG icons with index.ts barrel export (arrow, bank, checkmark, copy, share, etc.)
│   ├── illustrations/         # Illustrations
│   ├── logos/                 # Brand / partner logos
│   ├── app-variants/          # Per-variant (dev/preview/prod) icons & splash
│   ├── wirex/                 # Wirex assets
│   ├── SharpGroteskBold25.ttf # Headline bold font
│   ├── Harriet-v2-Display-Thin.ttf  # Headline thin font
│   ├── icon.png               # App icon
│   └── nuri-splash-screen.png # Splash screen
│
├── __mocks__/                 # Vitest mocks (expo-stub, react-native)
├── test/                      # Vitest helpers (live env skip guard)
├── *.test.ts                  # Colocated unit tests for money math / pure helpers (lib/, services/)
├── certs/                     # Certificates
├── config-plugins/            # Expo config plugins
├── native-modules/            # Custom native modules
├── experimental/              # Experimental code
├── skill/                     # Agent skill assets
│
├── android/                   # Android native project
├── ios/                       # iOS native project (Nuricom.xcworkspace)
│
├── app.config.ts              # Expo config (schemes, plugins, associated domains)
├── eas.json                   # EAS Build profiles (dev, preview, prod)
├── metro.config.js            # Metro bundler (Noble extensions, Node polyfills)
├── babel.config.js            # Babel (expo preset + font scaling lock)
├── tsconfig.json              # TypeScript strict mode
├── docs/                      # Project docs (codebase, screens registry, development, support-chat, postmortems, wirex reports)
├── CLAUDE.md                  # Project rules + workflow skill for Claude Code
└── AGENTS.md                  # Multi-agent workflow reference
```

---

## Screen Registry

Every user-facing screen has a **stable slug ID** of the form `domain.name` (e.g. `bitcoin.receive-unlock`, `wirex.card`, `auth.login.native`). The slug is decoupled from the file/component name, so renaming a component never changes how we refer to its screen. Use slugs — not "the green screen" or a class name — in issues, PRs, logs, and agent prompts.

- **Source of truth:** [`docs/screens.md`](screens.md) lists every screen (slug → component, file, purpose), grouped by domain (`auth · lock · onboarding · bitcoin · card · wirex · wallet · swap · app`).
- **In-file tag:** each screen file's first line is `// @screen <slug>`. Grep `@screen` for file→slug; look up the slug in `docs/screens.md` for everything else.
- **A screen vs a shell:** a screen is a distinct destination the user is *on*. Reusable building blocks (e.g. `ModalSheet`, `FullScreenModal`, `QrCard`) and inline sections are **not** tagged. See the "Not tagged" section in `docs/screens.md`.

**When you add a new screen file:** pick an unused `domain.name` slug, add `// @screen <slug>` as the first line, and add a row to the matching table in `docs/screens.md`.

---

## Architecture Overview

### Navigation

**No Expo Router, and no tabs.** `App.tsx` renders exactly one signed-in screen —
`screens/home/UnifiedHomeScreen` — plus the app-level overlays (biometric lock,
support chat, 3DS host, update blocker, passkey login).

Two web URLs are read straight off `window.location.pathname` at mount, and each has
its own parser so neither can be reached from the other's path: `/@username`
(`lib/auth/passkeyUsernameLink.ts`) targets a passkey login and is cleared from the
address bar once used, and `/pay/@username` (`lib/pay/payLinkPath.ts`) opens the public
pay page. The pay link is a SEPARATE ROOT: `App.tsx` picks between `PayLinkApp` and
`WalletApp` before either mounts, so a visitor's browser never runs the wallet's
initialization — which reads secure storage, starts the signed-in services and can soft-log
out a pre-Wirex install. It is a link handed to strangers, so nothing signed-in exists
behind it at all.

Everything else is reached from the home: a rail row opens `screens/home/AssetScreen`,
which carries that rail's Receive/Send, its in-flight transfers and its transaction
list; the swap control opens `screens/home/MoveSheet`, which prices every pair through
`services/swapkit/SwapContract` (`quoteSwap` → the user accepts → `executeSwap`) and so
has one flow for every direction rather than a sheet per pair.

The Wirex account settles in **two** currencies — WEUR and WUSD, the only tokens it
ever holds — so it is one row on the home and two rails inside the Move sheet, "VISA
Euro" and "VISA Dollar" (`screens/home/moveBookkeeping.ts`). Filling the pocket that
matches the source is a transfer (`services/wallet/CardTransferService.ts`, EURC or
USDC to the card's deposit address), crossing them is a priced swap settling on that
address, bitcoin into either hands off to `SwapKitCardTopupService` with that stable,
and the way out is `withdrawToWallet(amount, { asset })` — which pays out to the wallet
holding the same currency and nowhere else.

The dollar rail's balance is owned by `services/balance/UsdcBalanceStore.ts`, the twin of
`WalletBalanceStore` (one EOA, two tokens, two stores). Both honour a `moveId` on
`wallet:optimisticCredit` and a matching `wallet:revokeOptimisticCredit`: a credit that
crossed the bus into a balance its emitter does not own can only be taken back by name,
since the anchor outranks a live read for its whole hold.

Deep links and notification taps resolve to a **rail**, not to a screen instance.
`App.tsx` maps the link to a `RailKey` and emits `nav:openHomeRail`
(`screens/home/rails.ts`); the home is the only listener, so there is one way in:

| Link | Rail |
|------|------|
| `nuri://bitcoin`, `bitcoin:` / `lightning:` URIs | `arkade` |
| `nuri://card` | `visa` |
| `nuri://wallet`, `nuri://keys` | `wallet` |
| `nuri://show-iban` | `iban` + the bank side of `wirex.cardDetails` |
| `nuri://show-card-number` | `visa` + the card reveal |

The last two also park their target in `lib/cardDetailIntent.ts`, because a
one-shot emit is lost on a cold start or before the Wirex data has loaded. The
home drains it (`useCardDetailDeepLink`) once it is mounted AND that data is ready.

Modals are presented on top of the home via state flags in the home itself; the
app-level ones stay in `App.tsx`.

### Event Bus

Cross-screen communication uses `services/events/AppEventBusService.ts` (pub/sub):

- `nav:openHomeRail` - Open a funding rail's asset screen on the home (deep links, notification taps)
- `card:drainPendingDetail` - Nudge the home to drain a parked card-detail deep link
- `ui:resetMainScreens` - Close every overlay (the biometric lock depends on it)
- `kyc:state` / `kyc:refresh` / `kyc:start` - KYC flow
- `card:refresh` / `wallet:refresh` / `bitcoin:syncWallet` - Data refresh
- `bitcoin:sendAuthenticated` - Arkade Lightning send passed native passkey approval
- `bitcoin:sendSubmitted` - Arkade Lightning send funded/submitted progress
- `transactions:refresh` - Refresh all transaction caches
- `support:openNostrChat` / `support:unreadCount` - Support chat
- `ui:showGenericSuccess` - Success modal
- `app:updateRequired` - Force update

### State Management

No Redux/Zustand - uses React `useState`/`useEffect` in `App.tsx` + singleton service instances + EventBus.

## Core Features

### 1. Bitcoin Wallet

- **Two Bitcoin systems, one co-signer.** The classical MuSig2+CSV L1 wallet and Arkade (Ark L2) are separate wallet systems that are both live at once — neither supersedes the other — and they share the *same* current co-signer: **Nuri Cosigner v4 on `arkade.nuri.com`**, reached with a native passkey assertion. There is no browser hop and no second signer. The retired `sign.nuri.com/v1` signer, legacy address scans, dual balances and any in-app migration/sweep are **out of this app**; migrating an old wallet is a separate product on `v1.nuri.com` (`screens/migration/V1WalletMigrationScreen.tsx` only links to it). `npm run check:cosigner-boundary` (`scripts/check-no-legacy-cosigner.sh`) fails the build if any of that returns — see AGENTS.md.
- **Taproot addresses** (BIP-86) with MuSig2 key aggregation (`lib/musig2Agg.ts`)
- **One L1 address.** `services/bitcoin/Musig2WalletKeys.ts` resolves the user key, the v4 aggregate and the co-signer's own CSV timelock from the arkade signing context, and `lib/bitcoin/deriveMusig2CsvAddress.ts` derives the single MuSig2+CSV address from them. There is deliberately no fallback to the v1 aggregate: that would derive the wrong wallet's address. `WalletService` publishes exactly that address; nothing in the app derives or scans a second one.
- **CSV timelock recovery** (CheckSequenceVerify) as fallback
- **PSBT signing** via `@scure/btc-signer`. An L1 send is built by `lib/bitcoin/buildBitcoinSendPsbt.ts` and run by `services/bitcoin/OnchainSendService.ts` as a 2-of-2 round with the v4 co-signer: build the PSBT, register the server swap intent that binds recipient and amount, then sign under a native passkey approval and broadcast.
- **Remit (Lightning → Tanzanian shilling)** via `services/remit/RemitService.ts`, a thin client for the MCP endpoint at `REMIT_MCP_URL` (`remit.nuri.com/mcp`, JSON-RPC over plain HTTP POST). A Tanzanian mobile number in the send screen's recipient field selects the rail: `quote_tzs` prices the shilling amount in sats while typing, and `send_tzs_to_phone_with_lightning` mints a BOLT11 at confirm, which the existing `bolt11` target pays. The corridor performs the ClickPesa payout itself after that invoice settles, so the wallet holds no payout credentials — `check_lightning_tzs_payment` is fired once after the send to prompt it. Minting moves no money, and what leaves the wallet is the amount inside the invoice, never the quote. Recipient recognition is `lib/remit/tanzaniaPhone.ts`. The corridor serves browser CORS, so the PWA calls it directly and it is listed in `public/index.html`'s `connect-src` rather than `lib/web/apiProxy.ts`'s rewrite table.

- **Arkade (Ark L2)** for Lightning send (`services/arkade/`) over the Arkade Intents RFQ corridor `arkade:BTC -> lightning:BTC`: `@arkade-os/swap` quotes it over a nostr transport to the pinned solver (`config/endpoints.ts`), the wallet funds the lockup the quote derives locally, and `internal/lightningSendRefund.ts` reclaims it if the solver never pays. Lightning receive is server-owned and currently dark — no solver serves `lightning:BTC -> arkade:BTC`.
- **Arkade receive unlock** caches claimable restore metadata, skips fresh receive-only revalidation when state is recent, and runs every planned action of a session on one tap — a Lightning claim and a boarding sweep together, with a recoverable wallet update held back for when it is the only work (it is a whole settlement round, and pairing it costs the passkey prefetch and the optimistic close). Sync and wallet summary settle independently, so a summary failure still yields actionable state from the sync rows; boarding rows the wallet cannot verify (unbuildable wallet, unreadable boarding UTXOs) are kept, not dropped, and the rows are snapshotted before the first step because a claim's `arkade:receiveUpdated` triggers a refresh that clears them mid-session. The modal releases after receive-claim signing only when that claim is the whole job, refreshes after successful claims in the background, and can be reopened from the arkade rail's pending-sweep row (`ARKADE_OPEN_UNLOCK_WALLET_EVENT`) — background auto-sweep stays disabled, so that modal is the only path these funds have
- **LNURL** payment resolution
- **Esplora API** (mempool.space) for UTXO/balance
- Key files: `services/bitcoin/WalletService.ts`, `services/bitcoin/Musig2WalletKeys.ts`, `services/bitcoin/OnchainSendService.ts`, `services/bitcoin/BlockchainService.ts`, `services/bitcoin/BtcL2Provider.ts`, `lib/bitcoin/`, `scripts/check-no-legacy-cosigner.sh`

### 2. Visa Card (Wirex)

- Virtual & physical card issuance
- KYC/AML via **SumSub** SDK
- IBAN / SEPA account linking
- Card balance, transactions, freeze/activate, daily spending limit
- ZeroDev smart account (ERC-4337 AA) on Base
- Reached via the Wirex proxy server (`EXPO_PUBLIC_WIREX_PROXY_URL`)
- Key files: `screens/wirex/`, `services/wirex/WirexService.ts`, `services/wirex/WirexAccountService.ts`, `lib/wirex/`

**Provisioning repair (launch check).** Onboarding provisions the card and the SEPA account exactly once, at signup; an account whose KYC was still pending then — or whose country only became SEPA-eligible later — has nothing re-run for it, and no server-side hook fires when the capability flips to `Active`. `services/wirex/WirexProvisioningRepairService.ts` closes that gap once per launch:

- Entitlement is judged **per rail** by `lib/wirex/provisioningRepair.ts` (`capability Active + that product absent`), so a card never suppresses the IBAN repair or the reverse. An account whose every card is closed is excluded — that is deliberate, not missing.
- The re-trigger is a single `getStatus({ email })` — passing the email is the only thing that re-runs the server's provisioning path. `country` comes from the account's residence address and is omitted when unknown, never defaulted.
- Wirex issues asynchronously, so the products are polled for with the **email-less** read; a second provisioning request inside that window would mint a second card. `lib/wirex/provisioningAttemptMarker.ts` records every email-bearing attempt — signup's `/onboard/start` and the repair's `/status?email` alike, written by `WirexService` at both chokepoints — in a wallet-keyed AsyncStorage entry (`@nuri:wirexProvisioningAttempt:v1:<wallet>`, 30 min), so the guarantee survives a kill-and-relaunch and covers a launch that lands mid-signup. It fails closed: a marker that cannot be written aborts the provisioning request rather than issuing unguarded.
- Entry points (`initWirexProvisioningRepair`): `addWalletUnlockedListener` on native (the reads need a Wirex read session, and minting one signs with the on-device EOA — after the unlock the key cache is warm, so no Face ID), and the signed-in effect on web, where the browser has no unlock cycle. It also listens for `wirex:verificationApproved`, which `WirexAccountService` emits when a status read observes KYC turning Approved with the app already open — the other moment products become due — and re-runs the check. Sign-out releases the latch and strands any run still in flight.

### 3. NEAR Intent Swaps / SwapKit Reverse Route

- Current-rate recovery (#1325): `SwapKitRecoveryQuote.ts` validates the dedicated EIP-712 contract; `SwapKitRecoveryService.ts` previews and explicitly accepts through the existing MCP caller. `SwapKitOrderStore.recoveryConsent` preserves the exact quote/signature for response-loss replay. Stored and discovered rows use the accepted fixed bounds without changing legacy floors. Recovery never invokes the replacement-order fallback; retirement requires the original order's final EURC receipt. Backend integration and physical-device testing remain release gates.

- **1-click atomic swaps** for legacy Bitcoin to stablecoin routes
- **SwapKit EURC Base mainnet to Lightning** for wallet buy-BTC route
- Server-side AMM solver via SwapKit MCP
- Swap status polling and history
- Key files: `screens/swapkit/SwapKit*.tsx`, `services/swapkit/*.ts`; solver backend lives in the nuri-servers repo
- Card/wallet conversion can quote direct BTC routes with top-up-scoped `send_asset`; Arkade offboards the full provider amount with its fee added on top

### 4. SwapKit Lightning / Base Routes

- **BTC Lightning to EURC Base** via nuri SwapKit MCP
- The MCP also types direct `USDC_BASE` and native `ETH_BASE` route options; UI asset selection remains EURC-first
- Resolves either the Wirex smart-account address or the user's EOA as the Base settlement target
- Pays the returned Lightning invoice through the active Arkade Bitcoin send rail
- CoW signing is fail-closed on the accepted token direction, receiver, maximum input, and minimum output; restart tracking keeps those bounds
- Per-route gas/deadline metadata and structured temporary server failures come from the MCP; durable server state is one Durable Object per transaction
- On hydrate/foreground, `swap_list(fromAddress)` discovers nonterminal server transactions that are missing locally; `swap_track(txId)` remains the detailed status source
- `SwapKitOrderStore` keeps recoverable rows without a time-based expiry and persists provider, public order/action IDs, key index, deadline, status, and transaction hashes
- Active recovery snapshots are encrypted before Nostr backup. Mnemonics, private keys, PRF output, and preimages are never serialized or submitted to the MCP
- **Known gap:** the Arkade backup stores *pointers* to the VTXO chain, not the presigned transactions themselves — those live only on Arkade's indexer. "Recover without Nuri" holds; "recover without Arkade" does not yet. `services/arkade/internal/vtxoChainBackup.ts` is the planning layer for closing it and is deliberately not wired into any production path. See [#883](https://github.com/nuri-com/nuri-expo/issues/883)
- FixedFloat recovery retries the same transaction with one idempotent `EXCHANGE`; it never starts a replacement route after funding
- Satora and Boltz remain server-side, quote-only for *forward* swaps until SwapKit provides provider-free wallet actions. The one client-signed exception is **stuck-HTLC refund recovery**: when `swap_sweep` returns chain-sourced `refundable[]` locks, the wallet builds, simulates, and broadcasts the coordinator's permissionless `refundTo` itself (`services/swapkit/SatoraHtlcRefundService.ts`) — the depositor is verified on-chain via the coordinator `deposits(key)` mapping before signing, and tokens always return to the depositor regardless of caller. This is recovery-only; it never executes a forward Satora swap client-side
- Key files: `screens/home/MoveSheet.tsx` (every swap, including bitcoin into the card), `services/swapkit/SwapContract.ts`, `services/swapkit/SwapKitService.ts`, `services/swapkit/SwapKitCardTopupService.ts`, `docs/swapkit-server-needs.md`

### 4b. SwapKit v2 (contract 2.2.0, `/v2/mcp`)

Production entrypoints use `/v2/mcp` exclusively, including Pay deposits and Arkade Lightning. `SwapKitV2ProductionBoundary.test.ts` follows imported symbols and module initialization from App.tsx and fails if it reaches the legacy network caller; a positive control proves the scanner detects v1 execution. Legacy modules remain for isolated tests and development tooling, plus local signing helpers reused by v2; no v1 tracker or recovery host runs at app startup.

`SwapKitArkadeLightningSendService` persists the commit and exchanges public refund material before returning the exact funding action. `ArkadeLightningSendService` retains its native v4 approval and pre-funding recovery record; the v2 action journal submits the exact indexed outpoint and retries evidence without funding twice. `SwapKitLoopRegistry` is shared by foreground funding and background tracking. `SwapKitV2LightningResume` adopts lost commit responses and drives v2 refund/status actions on wallet wake. Legacy ids are retained separately and are neither polled nor reinterpreted as v2 ids.

`PayTargetService` uses only `send_asset` quotes for external-payer deposits, validates the bound asset/address/amount/deadline, and tracks with a random, persisted Pay-specific recovery capability. Interrupted commits reuse their original request and idempotency key. Pay never starts a signed-in wallet action executor.


- **Full v1→v2 migration.** Every production swap corridor (Base stable↔stable, stable→BTC/BTC_ARKADE, BTC/BTC_ARKADE→stable, and card top-up) runs on the v2 engine; v1 endpoint/services stay only to track/recover already-created v1 orders.
- **One dumb loop, dispatch on `kind`.** The client mirrors the server's reference client: `swap(mode:"commit")` → drive `state:"ready"` actions through a single switch on `action.kind` → submit evidence with the action's own `idempotencyKey` → poll otherwise. No provider/corridor branching client-side; the server owns routing (satora dropped server-side, LI.FI→Arkade boarding is a server route). The client presents every server-priced option with no client provider filter.
- **`recoveryKey` (2.2.0):** every authed call (commit/submit/status/list/cancel) carries a wallet-generated recovery capability derived prompt-free from the passkey credential id (`walletPasskeyCredIdB64u`; EOA fallback) — public, wipe-stable material, NOT a signing key and NO new derivation scheme. The server persists only its SHA-256 hash and indexes orders by it, so a restored wallet re-adopts pending orders via `swap_list`. `services/swapkit/SwapKitV2RecoveryKey.ts`.
- **Immutable consent bounds:** commit binds `acceptedDepositAmount` + `minimumSettleAmount` (exact-decimal strings); the server never overwrites them with an execution value. Persisted so a lost-response resume re-commits identically.
- **Wallet sovereignty:** material actions mint an OPAQUE `walletKeyRef` (encodes provider + the v1 `SwapKitHtlcKeyService` keyIndex); the server echoes it verbatim and never parses it. The wallet resolves only refs it minted, verifying by re-derived preimage/hash, and fails closed on foreign refs. `arkade_refund_material`/`arkade_intents_refund` reuse the v1 Arkade Intents refund core; `arkade_intents_fund` returns the EXACT created VTXO outpoint (resolved from the indexer, never guessed) which the server verifies.
- **Contract gate:** the client requires contract ≥2.2 (`swap_capabilities`), failing closed on an older minor since 2.0/2.1 accept a commit but cannot honour recoveryKey/bounds/refund kinds.
- **Durable resume:** `SwapKitV2OrderStore` persists per-order flow + a JSON-safe `executorSpec`; on restart the tracker rebuilds each order's flow-specific bounded executor set (send_asset funder, chain allowlist, approval ceiling) instead of the default set, and re-adopts server-authoritative orders via `swap_list({owner, recoveryKey})`. **Full wipe→restore:** the Arkade Intents refund reconstructs its funded-send record from wallet-owned material (`provisionRefundKey` descriptor + x-only key are a deterministic function of the passkey-bound identity; refund address is the wallet's own) when the local cache is gone, and the covenant-rebuild gate proves the reconstruction controls the funded lockup before signing — the local record is a cache, never the only copy. Card-destination orders emit `DIRECT_SWAP_SETTLED_EVENT` at terminal to confirm/revert the optimistic card credit; every terminal order clears its pending-transfer row.
- **No hand-rolled decimal math for token amounts** — viem `parseUnits`/`formatUnits`, integer base units on both sides (the 18-decimal float-rounding mismatch that stranded tBTC sweeps lives in the server providers; issue nuri-mcp-bitcoin-swapkit#289).
- **Immediate handoff — accepting the quote is the user's last step.** The sheet closes the moment an order id exists (`onOrderId`); there is no post-acceptance wait screen and no `SwapProcessingPhase` for one. Everything after the handoff runs unattended: the tracker's loop drives every action the executor set can sign, with no poll budget and no give-up count (only a contract violation — unsupported action kind / unknown order — fails closed). Failure BEFORE the handoff stays inline in the initiating sheet; failure after it belongs to the pill and the pending rows.
- **Global move status.** `SwapKitV2MoveStatus.ts` is an observable per-order phase map fed by the tracker (server status + blocked actions) and by the EVM signer (`onApproving`/`onBeforeBroadcast` → **Approving…** / **Executing…** — the step the wallet is really on, never a timer). `components/V2MoveStatusBridge.tsx` renders it as one app-level pill inside `DsOverlayRoot`, deferring while a sheet is open (OTA-toast pattern), keeping concurrent orders independent, and offering a tap ONLY for `action_required` — which runs that step via `resumeSwapKitV2Order` with the order's own persisted bounds. Dismissal hides presentation only; tracking, recovery and accounting are untouched.
- **Terminal balance accounting.** `SwapKitV2MoveAccounting.ts` captures each move's two legs (exact asset + rail) at the handoff and applies them the instant the order reports COMPLETED, through the existing keyed `optimisticAnchor`/`pendingOptimisticMoves` primitives — the refetch after a terminal event lags by seconds, which is why a completed swap used to leave both balances unchanged. Idempotent per `orderId`; skips a leg the ledger already published; applies nothing for an order with no session baseline (restart/reconcile — the authoritative read is the only truth); non-COMPLETED terminals revoke only that order's credit.
- Key files: `services/swapkit/SwapKitV2Service.ts` (transport), `SwapKitV2ActionService.ts` (dispatcher + validators), `SwapKitV2Executors.ts`, `SwapKitV2OrderStore.ts`, `SwapKitV2PendingTracker.ts`, `SwapKitV2ResumeExecutors.ts`, `SwapKitV2RecoveryKey.ts`, `SwapKitV2MoveStatus.ts`, `SwapKitV2MoveAccounting.ts`, `SwapKitV2BtcToStableService.ts`, `SwapKitV2StableToBtcService.ts`, `SwapKitV2DirectEvmService.ts`, `SwapKitV2SweepService.ts`, `components/V2MoveStatusBridge.tsx`; `docs/swapkit-v2-migration-plan.md`

### 5. Passkey Wallet Creation

- **WebAuthn + PRF** for key derivation
- Deterministic BTC + ETH keys from passkey PRF output
- Biometric-only key storage (Face ID / Touch ID) — **native only.** On the web PWA there
  is no keychain: `lib/secureKeyStorage.web.ts` writes keys to `localStorage` as
  plaintext. Everything below in this section describes the native path and does **not**
  apply in a browser. The Bitcoin key is still covered by the co-signer there; the
  Ethereum, Nostr and auth-HMAC keys are **not** — see #746 and the "Trust anchors"
  section of the README.
- App unlock has one canonical path: one biometric read of the combined `wallet_private_keys` entry releases both the Bitcoin and EVM private keys into the session cache.
- The combined entry is mandatory during wallet bootstrap. A failed write aborts and rolls back persistence instead of leaving a wallet that requires separate unlocks.
- Separate Bitcoin/EVM keychain reads are never an unlock fallback because two reads can trigger two biometric prompts. Missing, incomplete, corrupt, or unreadable combined entries fail closed into passkey relogin.
- Successful unlock keeps both keys memory-resident only for the unlocked session; app lock and logout clear that cache.
- Every successful combined unlock publishes one central wallet-unlocked notification. `App.tsx` owns the single listener that releases the app-lock gate and closes `BiometricLockModal`, so the lockscreen cannot remain above an already-unlocked wallet.
- The lockscreen carries no `Delete wallet` action — it was removed, and the `nuri://factory-reset` link no longer reaches a wipe.
- `services/auth/WalletAccessController.ts` owns the lockscreen's unlock orchestration: one ceremony at a time, every attempt bounded by `WALLET_ACCESS_TIMEOUT_MS`, and a timed-out read released from the shared in-flight slot (`abandonInFlightWalletUnlock`) so the next tap re-asks the provider instead of joining a dead promise. Passkey recovery runs only from an explicit tap, never from the automatic attempt, because Android gates provider UI on user activation; the `recovery_required` verdict is remembered, so that tap goes straight to the passkey rather than repeating a read already known to fail. An unlock read carries the generation it started under, and both abandoning one and succeeding at one retire the rest — a read that has lost the race may still seed the cache, but it may no longer clear the keys the winner installed. The screen renders the typed outcome as localized retry copy and stays tappable — an unanswered provider can no longer leave the CTA disabled forever (#1067).
- Wallet deletion has no screen-local wipe path: `FactoryResetService` remains the sole owner of clearing auth state, Keychain entries, cached transactions, pending purchases, Arkade storage, signing contexts, server overrides, and reloading the app. It is reached from the debug hub and from the production logout below.
- **Logging out IS a factory reset, and the passkey is what survives.** `services/app/UserLogoutService.requestUserLogout()` runs `services/app/FactoryResetService.performFactoryReset()`: session, this device's key material, third-party sessions, caches, pending orders, Arkade storage and push registration all go, and the app reloads onto a neutral welcome where **any** passkey may sign in. The passkey itself belongs to the OS/password manager and is untouched, so the same one signs the same wallet back in — nothing softer is offered, because device state left behind is state the next passkey inherits.
  - The reset is fail-closed: it clears `@auth:previous_addresses` (which otherwise survives on purpose, #671) and verifies the critical keychain entries are absent BEFORE scheduling the reload. A survivor throws instead of relaunching.
  - `services/app/SoftLogoutService.performSoftLogoutForRelogin()` still exists for the relogin flows that keep a `preserveHint` ("Continue with @name"). It is not what the logout sheet calls.
- The route into it is the home greeting's eight-tap gesture — the same hidden entry that opens the debug hub in a dev build, which opens the logout confirm sheet in a production one (`DEBUG_UI_ENABLED` picks between them, so a build only ever has one of the two). `requestUserLogout()` is the caller for that gesture: it owns the process-wide exactly-once guard, and when the reset's gate refuses to relaunch it latches a blocking recovery state instead of returning the user to a home screen over a half-wiped identity.
- **A `/@username` link that replaces the wallet in place is the second teardown, and it lives at the same boundary.** `services/app/UserLogoutService.requestWalletReplacement()` runs `wipeLocalWalletData()` — the same destructive wipe, minus the relaunch, because `App.tsx` commits the incoming wallet in the same process once it returns `"replaced"`. It shares this module's guards rather than owning private ones: the exactly-once flag keeps a second wipe off the wallet just committed, and an abort latches the same process-wide flag `hasAbortedTeardown()` exposes, so the home and Support Chat sheets present the same recovery state. It differs from the logout in one direction — it *refuses* (`"blocked"`) once that flag is latched, because retrying a logout is a way out of a half-torn device and committing a fresh identity onto one is not. The refusal is at the service, not in React state, since a queued or duplicate passkey payload reaches it whatever the UI shows.
  - `App.tsx` never wipes directly. On anything but `"replaced"` it zeroizes the incoming PRF, commits nothing, and on `"blocked"` raises an app-root non-dismissible `LogoutConfirmSheet` whose only action is the full `requestUserLogout()` teardown plus relaunch.
- iOS 18.0+ required for PRF support
- Key files: `App.tsx`, `components/BiometricLockModal.tsx`, `lib/secureKeyStorage.ts`, `services/app/FactoryResetService.ts`, `services/auth/PasskeyNativeModuleService.ts`, `services/auth/PasskeyPrfWalletBootstrapService.ts`, `lib/walletDerivation.ts`

### 6. Wallet (EUR stablecoin on Base)

- EURC balance and onchain transaction history on **Base** (chain config in `config/network.ts`)
- IBAN / SEPA transfers surfaced through the Wirex account
- Home-currency selection / conversion via `lib/currency/HomeCurrencyService.ts`
- Key files: `screens/wallet/`, `services/base/BaseTokenTransferService.ts`, `lib/currency/HomeCurrencyService.ts`

### 7. Fiat On-Ramp (Mercuryo)

- Buy Bitcoin with fiat (Apple Pay, card, etc.)
- Widget proxy server for authentication
- Mercuryo requires identity verification for every user, so checkout runs in the OS browser (Chrome Custom Tab / SFSafariViewController) instead of an in-app WebView; web opens a tab because the widget refuses to be iframed
- The sheet only enters the amount and hands off. `MercuryoOrderStore` records the handoff durably, `MercuryoPendingTracker` polls `MERCURYO_STATUS_ENDPOINT` in the background (resumed on every foreground) and writes the visible `PendingPurchasesStore` row on `paid` — so a purchase survives the sheet closing, the app being backgrounded, or the process being killed in checkout
- Key files: `screens/bitcoin/modals/MercuryoBuyBitcoinModal.tsx`, `services/mercuryo/` (order store, status service, tracker), `lib/mercuryo/`; widget proxy lives in the nuri-servers repo

### 8. Nostr Support Chat

- Real-time messaging via Nostr protocol
- Unread count sync
- Telegram bridge for operators
- Key files: `lib/nostr/`, `services/nostr/NostrUnreadSync.ts`, `components/NostrChatModal.tsx`

### 9. Notifications

- Native (iOS/Android) runs on `expo-notifications` → Expo Push Service → APNs/FCM. Web/PWA runs
  on the Push API with VAPID and `public/nuri-service-worker.js`; the two share one API surface via
  the `NotificationService.ts` / `NotificationService.web.ts` platform split, so callers never branch.
- `App.tsx` calls `startNotifications()` at boot for foreground presentation and the Android channel,
  wires `addListeners` for taps, and reads `getInitialNotification()` for a tap that cold-started the
  app (that one predates any listener, so it cannot arrive through the listener).
- **Registration carries no wallet identity.** The client mints a random 128-bit `subscriptionId`
  and posts `{subscriptionId, token, kind, platform}` to `NOTIFICATIONS_API_BASE_URL/devices`. A
  credential id is an identifier, not a secret, so registering under one would let a caller claim
  someone else's and read their payment notifications — and verifying such a claim needs a
  `credId → pubkey` source only arkade holds. With a random subscription there is nothing to
  impersonate, so the endpoint needs no auth.
- **Arkade vouches for the link.** `bindSubscriptionWithArkade()` calls
  `/v4/arkade/notifications/bind` with the request-auth envelope arkade already verifies; arkade
  forwards the binding to the notification server. It must be a *standing* binding: a payment to a
  static Lightning address is invoiced by arkade itself, with the recipient device never involved,
  so there is nothing to register per payment. The opt-in path may raise Face ID; the silent
  sign-in sync passes `allowPrompt: false` and settles for a cached assertion, so app start never
  produces a dialog.
- **Wirex vouches for the banking rails.** The same `subscriptionId` gets a second binding in the
  `wirex` namespace, for card spend, SEPA movements, card limits and 3DS. `bindSubscriptionWithWirex()`
  → `wirexService.bindNotificationSubscription()` posts `{subscription_id}` to
  `/mcp/v1/notifications/bind`; the wallet is never sent, the server derives it from the read-session
  signature. Bindings are keyed `(namespace, external_id, subscription_id)`, so the two rails coexist
  on one device token and a factory reset orphaning the subscription cascades both away.
  It uses a *cached* read session only — minting one would sign with the biometric EOA, and a
  background bind must never raise Face ID. That cache is per-process, so the bind attempted at
  sign-in is always a no-op; `WIREX_READ_SESSION_MINTED_EVENT` is what gives it its real chance once
  the card screens mint one. Unlike the arkade bind it is not cached locally: re-sending is free
  (`INSERT … ON CONFLICT DO NOTHING`) and is the only thing that repairs a binding the server
  cascaded away after a token change. It never gates `registerPushToken`'s answer — every account
  without a card fails it, and that must not read as "notifications are off".
- **Payload contract the server must honour.** `data.target` may be `"bitcoin" | "wallet" | "card"`
  and nothing else; `readNotificationTarget` drops anything unrecognised, so a malformed or
  future payload lands nowhere instead of breaking navigation. Wirex pushes always target `card` and
  carry `data.source = "wirex"` plus a `kind` (`3ds` | `activity` | `card_limit`).
  **The server composes every title and body**; the client writes no per-event copy.
- **Arrival and tap do different things** — `createNotificationRouter` (`notificationRouting.ts`)
  owns both, so the difference is unit-testable instead of buried in `App.tsx`. A wirex push emits
  `card:refresh` on *arrival*, which re-reads the account and re-polls pending 3DS; that poll is what
  surfaces the approve/decline modal, and a push delivered while the app is already foregrounded
  produces no AppState transition to do it instead. Arrival never navigates — only the user's own tap
  may move them. The tap refreshes too, since it can be the first sight of a payload that arrived
  while the app was backgrounded or not running.
- `NOTIFICATIONS_API_BASE_URL` is pinned to `https://notifications.nuri.com` in `config/network.ts`,
  like `WIREX_PROXY_BASE_URL`. It is a public hostname, not a secret, and an env var would have to be
  set in every EAS environment — forgetting one would silently disable notifications there.
  `EXPO_PUBLIC_NOTIFICATIONS_API_URL` overrides it for a local server.
- **Fingerprint source.** The `expo-notifications` config plugin writes the iOS `aps-environment`
  entitlement and pulls in `firebase-messaging` on Android. Remote push therefore only ever reaches
  devices through a new native build — never over OTA.
- **Credentials — only the VAPID private key ever belongs on the notification server.** APNs and FCM
  live on EAS: the server sends natively through the credential-free `exp.host` endpoint, and the
  Expo project holds those. Android needs **two distinct Firebase files** — the *service account key*
  (Project Settings → Service Accounts → Generate New Private Key) uploaded to EAS via
  `eas credentials`, and `google-services.json` (public identifiers) referenced by
  `GOOGLE_SERVICES_JSON` in the app build. Both are gitignored.
- iOS needs an APNs key, generated by EAS on the first build that asks for it.
  Android needs a Firebase project per package name (`com.nuri.mobileios`, `.dev`, `.preview`) —
  Firebase is not an added dependency, `expo-notifications` already bundles `firebase-messaging`;
  the project only supplies the `google-services.json` that names the FCM sender. That file is
  **committed and shared by every variant**: it carries one `client` entry per package name and the
  Google Services Gradle plugin picks the matching one, so no build profile has to select anything
  and none can quietly ship without FCM. A package missing from the file fails the Android build
  loudly. `GOOGLE_SERVICES_JSON` only overrides the path for a local build.
  The PWA needs no vendor account at all: `npm run vapid:generate` mints the P-256 keypair. The
  public half is pinned in `config/network.ts` (public by design — the browser receives it on every
  subscribe); the private half signs pushes and lives only on the notification server. Rotating the
  pair invalidates existing subscriptions, which the client detects and re-subscribes through.
- **Still missing: the sender.** A backend has to store recipient tokens and hold the VAPID private
  key. `ExpoPushClient.ts` sends straight from the app instead — debug-only, and viable solely
  because Expo's push endpoint needs no credentials. Web push cannot work this way at all, since
  signing requires the private key.
- Key files: `services/notifications/`, `public/nuri-service-worker.js`,
  `scripts/generate-vapid-keys.mjs`, `screens/debug/DebugNotificationsModal.tsx`

### 10. Public payment link (`/pay/@username`)

- A page anyone can open to pay a nuri user. No session, no wallet, no passkey — the
  visitor is a stranger, and `PayLinkApp` is its own app root, so the wallet app is never
  mounted and none of its initialization touches the visitor's browser.
- **The rail directory is ENS, not the arkade API.** `lib/pay/resolvePayRecipient.ts`
  reads four text records off `<username>.nuri.eth` through the arkade CCIP-Read
  gateway: `com.nuri.lightning`, `com.nuri.evm`, `com.nuri.arkade`, `com.nuri.btc`.
  They are read by name, never enumerated — offchain records emit no events, so the
  ENS subgraph and the ENS web app list none of them. `POST /v4/arkade/lnurl/status`
  cannot serve this: it is 401 unauthenticated and refuses foreign usernames.
- **The destination is never chosen.** `lib/pay/selectPayRail.ts` maps the source asset
  the payer holds to the recipient's matching rail; only a source the recipient cannot
  use where it lands (USDC on Arbitrum) becomes a swap settling into Base USDC. A
  record's presence is not a capability claim — the gateway serves one EVM address for
  every chain, so which chains settle is a client-side fact.
- QR/copy remain the default: `services/pay/PayTargetService.ts` turns a rail into one `PayTarget`
  (`lib/pay/payTarget.ts`), `screens/pay/hooks/usePayLinkTarget.ts` holds only the request
  state around it, and `components/PayTargetView.tsx` renders it. A target that carries an
  expiry is dropped when it passes — an expired invoice on screen fails only inside the
  payer's wallet.
  A swap deposit's order is polled through `swap_track` (`readPayOrderStatus` +
  `screens/pay/hooks/usePayOrderStatus.ts`) so the page can say whether the money arrived;
  a terminal order withdraws the deposit address from the page entirely, settled or
  failed, and a deposit with no usable order id is never offered at all. The order's own funding figure is required — a swap deposit with no quoted
  amount produces no target rather than falling back to what the payer typed.
  Direct rails create nothing; a Lightning rail invoices through the recipient's own
  LNURL-pay endpoint, whose returned BOLT11 is decoded and its amount required to equal
  the one asked for; a swap rail creates a real SwapKit order, is fail-closed on the
  payer's refund address (a real EVM address, checked before the order exists), and puts the provider's quoted amount and the source token into
  the deposit QR because only the paying wallet can enforce an exact-amount order.
- Amounts are exact integers in the asset's smallest unit. `exactBaseUnits` converts the
  typed or quoted figure once and `formatBaseUnits` writes it back, so the QR and the line
  the payer reads come from one number; a figure with more precision than the asset holds
  produces no target rather than a rounded one.
- Amounts are collected in the unit they are consumed in, spelled out: the Bitcoin rails
  read the typed figure as SATS, so the page writes "sats" instead of the ₿ glyph the
  signed-in app uses. A stranger reads "₿1" as one bitcoin.
- `PayLinkSummary` keeps the current source, exact target amount and fixed recipient visible
  above the QR. `PayTargetView` displays a shortened recipient on one line above the QR
  and only "Tap to copy" below. The clipboard receives the complete canonical QR URI,
  preserving chain, token and exact amount; only the visible address is shortened. `App.tsx` caps only the web pay-link
  frame at 430px; wallet identity and auth initialization remain unchanged.
- `PayWalletButtons` adds Bitcoin/Lightning OS URI handoff through React Native Linking,
  using the existing target (no signing or payment-success claim). QR/copy stay available.
  WalletConnect runtime is deliberately absent: #1163's vendored provider has not been
  admitted/proven for exact chain/account selection and pairing lifecycle. Its corrected
  base-unit/calldata helpers remain regression-tested in `lib/pay/walletConnectPay.ts`;
  these pure helpers do not enable any connector. No banking or confidential APIs are used.
- SEPA is absent by design — no IBAN field exists in ENS, in the LNURL profile or in
  the arkade database.
- Key files: `lib/pay/`, `screens/pay/`, `components/PayTargetView.tsx`

---

## Design System

Strict rules enforced in `designSystem.ts`:

**Colors:**

| Token | Value |
|-------|-------|
| BLACK[100] | `#2C232E` (= COLORS.TEXT) |
| BLACK[75] | `#615A62` |
| BLACK[50] | `#959196` |
| BLACK[25] | `#CAC8CB` |
| BACKGROUND | `#F0F0F0` |
| BUTTON_PRIMARY | `#BEAAFF` |
| BUTTON_ACCENT | `#6E9E96` |

**Font Sizes:**

| Token | Value |
|-------|-------|
| CAPTION | 12 |
| BODY_SMALL | 14 |
| BODY | 16 |
| BUTTON_XL | 20 |
| H4 | 24 |
| H3 | 32 |
| H2 | 40 |
| H1 | 64 |

**Border Radius (RADIUS):**

| Token | Value |
|-------|-------|
| PILL | 100 |
| CARD | 24 |
| INPUT | 12 |
| BADGE | 9 |
| SMALL | 8 |

**Other tokens:** SPACING, FONT_WEIGHTS, and FONT_FAMILIES tokens also exist in `designSystem.ts`.

**Fonts:** Inter (body), Sharp Grotesk Bold (headlines), Harriet Display Thin (alt headlines).

**Typography components:** `components/typography.tsx` exports Body, BodyBold, H1-H4, Caption, Subtitle, TextLink, DisplayHeadline. Use these instead of raw `<Text>` with manual styles.

**Rules:** All buttons pill-shaped (`borderRadius: RADIUS.PILL`), must have icons, no text opacity changes (except 0.5 for inactive).

---

## Key Dependencies

| Category | Package | Purpose |
|----------|---------|---------|
| Bitcoin | `@scure/btc-signer` | PSBT, Taproot, MuSig2 |
| Bitcoin | `@scure/bip32` | HD wallet derivation |
| Bitcoin | `@noble/secp256k1` | ECDSA signatures |
| Ethereum | `ethers` v6 | Wallet, signing, providers |
| Ethereum | `viem` | EVM library (Base reads/writes) |
| Smart Accounts | `@zerodev/sdk` | ERC-4337 account abstraction (Base) |
| Crypto | `@noble/curves`, `@noble/hashes`, `@noble/ciphers` | Primitives |
| KYC | `@sumsub/react-native-mobilesdk-module` | Identity verification |
| Storage | `react-native-keychain` | Biometric secure storage |
| i18n | `i18n-js` + `expo-localization` | EN + DE |

---

## Build & Deploy

### EAS Build Profiles

| Profile | Distribution | Notes |
|---------|-------------|-------|
| `development` | Internal | Dev client, debug build |
| `preview` | Internal | Release build for testing |
| `production` | Store | App bundle, 8GB heap |

### iOS

- Bundle ID: `com.nuri.nuriwallet`
- Deployment target: 18.0
- Build & deploy: EAS cloud (`npx eas-cli build --platform ios --profile production --auto-submit`)

### Android

- Package: `com.nuri.mobileios`
- Signing: `android/app/keystore.properties` or env vars
- ProGuard enabled for release
- Play Store submit: needs `./local-only/play-service-account.json`

### Deep Linking

Supported URI schemes: `nuri://`, `nuriwallet://`, `lightning://`, `bitcoin://`, `btc://`, `ln://`

Associated domains: `nuri.com`, `passkey.nuri.com`, `confirm.nuri.com`

---

## Backend Services

The app's backend microservices (Nuri Cosigner v4 on `arkade.nuri.com` — the one co-signer both Bitcoin systems use, NEAR/SwapKit solver, Mercuryo proxy, mailer, faucet relay, Nostr bridge/relay, update checker, Wirex proxy, Lightning pay) are **not in this repo** — they live in the [nuri-servers](https://github.com/nuri-com/nuri-servers) repo (and other org repos). The app reaches them over HTTPS; see `config/endpoints.ts`.

---

## Auth Flow

```
App Launch
  -> Check services/auth/AuthStateService for stored keys
  -> No key? -> Welcome Screen (Passkey)
      -> WebAuthn PRF -> HKDF -> BTC+ETH keys -> Secure storage
  -> Wirex account bootstrap (ZeroDev smart account on Base)
  -> KYC (SumSub) -> Card provisioning -> IBAN / SEPA linking
  -> Full app access (Bitcoin + Card + Wallet tabs)
```

---

## Localization

Two languages in `lib/i18n/`:
- `en.ts` - English
- `de.ts` - German

Usage: `import { t } from "./lib/i18n"` then `t("screen.HomeScreen.someKey")`

---

## Notable Patterns

- **No Expo Router, no tabs** - one signed-in screen (`screens/home/UnifiedHomeScreen`); navigation is rail state inside it
- **No Redux/Zustand** - singleton services + EventBus + React state
- **Domain-based screen folders** with colocated hooks, components, and modals (e.g., `screens/bitcoin/hooks/`, `screens/wirex/modals/`)
- **Screen registry** - every screen has a stable slug ID tagged in-file as `// @screen <slug>` and listed in `docs/screens.md`; new screen files MUST be tagged + registered (see [Screen Registry](#screen-registry))
- **Domain-based services** organized into subdirectories (e.g., `services/bitcoin/`, `services/auth/`, `services/balance/`)
- **Shared typography components** (Body, BodyBold, H1-H4, Caption, etc. from `components/typography.tsx`) -- never use raw `<Text>` with manual style spreads
- **Biome** for linting and formatting (`npx biome check --write .`)
- **Vitest** configured (`vitest.config.ts` + `__mocks__/` + `test/`) with default colocated unit tests and opt-in `npm run test:live` live suites; current coverage includes:
  - money-math / pure-helper tests under `lib/` and `services/pricing/`
  - SwapKit routing/tracking/top-up/stable-to-BTC flows
  - bitcoin parsing/address/BIP-86 helpers
  - wallet derivation vectors
  - Ethereum address derivation
  - MuSig2 aggregation
  - crypto PRF/seed helpers
  - card transaction status
  - Wirex onboarding analysis
  - validation, bytes, and IBAN formatting
  - pending transaction matching
  - live SwapKit MCP, pricing, Base balance, Esplora, and Wirex sandbox E2E shape contracts (gated by `NURI_LIVE_CONTRACTS`)
- **Strict TypeScript** - `noUnusedLocals`, `noUnusedParameters`, `noImplicitAny`
- **New Architecture enabled** (TurboModules/Fabric) on Android
- **Hermes JS engine** on both platforms
- **Custom Babel plugin** locks font scaling (`config/babel/lockFontScaling`)
- **App variants** - dev/preview/prod built side-by-side; per-variant assets in `assets/app-variants/` (see CLAUDE.md §10)
- **Multi-agent workflow** via `tools/wf.mjs` CLI (see CLAUDE.md for skill, AGENTS.md for reference)
