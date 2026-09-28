# Changelog

## Unreleased

- **A bridge deposit is now signed as the transaction the provider quoted.** LI.FI's BTC-source rail
  hands the deposit over as a PSBT whose outputs are the deposit — the deposit output, its OP_RETURN
  attribution, the wallet's change and the relayer's fee, in that order — and its solver matches on
  that transaction. The first funded try paid the deposit address with a self-built payment, confirmed,
  and was never attributed; adding the memo alone was still not the quoted transaction. The wallet now
  signs the provider's PSBT exactly: `prepareDepositPsbt` verifies every input is the wallet's own,
  requires the deposit output first (the co-signer binds its approval to the first matching output),
  stamps only the taproot material the signer needs and leaves every output as it was. Because that
  PSBT crosses the provider and server boundary, the wallet also checks the transaction's arithmetic
  against the accepted instruction: the total debit (inputs minus value returning to the wallet) has to
  equal the figure the instruction states, so an extra output or an inflated fee cannot ride along
  behind the funding output. That figure is itself required to be the amount the user accepted, the
  approval is armed on the deposit output the intent names while the note states the total spend, and
  every input has to carry the default sig hash: a signature made under NONE, SINGLE or ANYONECANPAY
  does not commit to the outputs that were validated. A route that
  hands over a PSBT is refused unless the on-chain Bitcoin wallet is the source, since nothing else can
  sign a Bitcoin transaction.

- **A BTC -> EURC move no longer hands the server an address that holds nothing.** The on-chain BTC
  routes are funded from the MuSig2 on-chain wallet, but the top-up declared the Arkade provider's
  *receive* (boarding) address as the Bitcoin side. For deposit-address rails that address is only a
  refund destination, so it never mattered; LI.FI's BTC-source rail builds the deposit from the
  declared sender's UTXOs and refused it (`No UTXOs found for any sender addresses`), so the move
  failed before creating anything. The declared address is now the wallet's own on-chain send source —
  the address the funding actually leaves from, and a refund target that is spendable without a
  boarding step. There is deliberately no fallback to the boarding address: while the MuSig2 wallet is
  not hydrated the move is refused with a clear message instead of declaring an address the payment
  will not come from. The choice follows the funding rail, so an Arkade-funded BTC route keeps working
  without the MuSig2 wallet, and the address is only used while the installed MuSig2 descriptor belongs
  to the credential that is loaded — after an in-app account switch the previous account's descriptor
  is refused instead of binding a route to an address the new account does not own. The install itself
  is also bounded to the identity it started under: the MuSig2 keys are resolved over an await, so a
  login during that window would otherwise land the previous account's descriptor in the singleton and
  stamp it as the new account's (`resetAddressState()` moves an identity epoch that the install
  checks).

- **Refunding a stuck Satora HTLC lock now builds a `refundTo` the coordinator accepts.** The app
  signed `refundTo` with the lock's swap **key** where the contract wants the **preimage hash**, so
  the coordinator derived a key nobody had deposited under and every refund reverted `UnknownHtlc`
  (0xbd697b55) — the funds stayed locked past timelock. `swap_sweep`'s `refundable[]` now carries the
  two identifiers separately (`preimageHash`, `key`), the app signs with the preimage hash, drops a
  payload that only carries the old `hashlock` field or repeats the same bytes for both, and checks
  the server's key against its own derivation before spending gas. The refund journal is keyed by the
  full swap key instead of the preimage hash — several distinct locks may share one preimage hash, and
  the second one used to read the first one's record as its own and be skipped forever.

- **OTA update applies itself when the app is idle (#1334).** A downloaded
  bundle used to wait for a cold start, so a user who never fully closes the app
  kept running weeks-old code — the fixed card reveal kept failing for them. Any
  time the app is in the foreground with nothing open and no wallet-access
  ceremony running, the downloaded bundle is now applied by the app itself,
  instead of offering a toast the user has to tap; mid-send, mid-swap and
  passkey prompts are never interrupted. No timer, no new runtime version, ships
  as an OTA.

### 0.99.0 (web release, LIVE on app.nuri.com since 2026-09-19, 05:20 UTC)

- LIVE: source `7ced12f8`, PRs #1407 + #1409 (merged). Bundle
  `_expo/static/js/web/index-f370976a874cba9c56c120a7d431fa8c.js`
  (SHA-256 `e04d1dfa…729954`). Deploy: GitHub Action "Deploy PWA" run
  `35423568574`, Cloudflare Worker, tag `pwa-20260919-052107`. KYC-resume
  hotfix, three fixes on the home rails' activation path:
- `aebdccf` (#1407, merged `31675ee6`, deployed 02:38 UTC as
  `pwa-20260919-023822`): inactive VISA/IBAN rails show ONE full-width
  "Activate Card & Bank" button instead of an "Add money"+"Activate" pair, and
  the gate is `cardActive` (`isWirexCardReady`), not `isApproved` — approved
  accounts whose products never provisioned no longer see Move/Send on €0.00.
- `f1b917c7` (#1409): the CTA tap was a silent no-op for approved-but-
  unprovisioned accounts (`openRailRow` still gated on `!isApproved` and fell
  through to `setOpenRail` on an already-selected rail). One source of truth:
  `wirexRailsNeedActivation = !cardActive && !isAwaitingReplacementCard`.
- `7ea0a7dd` (#1409): approved-but-unprovisioned accounts were routed into the
  fresh-signup email sheet, which the server rejects with
  `wirex_account_email_mismatch` (email pinned at onboarding) — a dead end with
  no way back into KYC. Now `wirexPendingVerification` also covers
  `isApproved && railsNeedActivation`: the tap opens the stable permalink
  `banking.nuri.com/mcp/kyc/<username>`, which is server-driven and mints a
  fresh Sumsub session — expired KYC links self-heal.
- Device proof (S21, dev build, account `denhard`: approved, cards=0, banks=0,
  vvc=NotFulfilled/SDD): before → email sheet → mismatch error; after →
  "Continue verification pressed" → Chrome opens `in.sumsub.com/websdk/…` with
  a live session. Checks: tsc clean, biome clean, 1377/1377 tests.
- Note: "approved without card" is NOT a failed smart-account deployment —
  Wirex keeps the rails `NotFulfilled` while the SDD mandate is open. The
  provisioning repair (`decideProvisioningRepair`) only re-triggers on
  capability=Active, by design.

### 0.97.0 (web release, LIVE on app.nuri.com since 2026-09-17)

- LIVE: source `92a8f39a`, PR #1373 (merged). Bundle
  `_expo/static/js/web/index-f5eab30abc48b7d47db9fb3e511b449c.js`
  (SHA-256 `f4a078c0…ecc8e2b2`). Fixes a complete signup outage for Android web
  users: "Create Passkey Wallet" completed the passkey ceremony and then froze
  with no redirect and no error, because the app fired a second WebAuthn
  ceremony that Android Chrome never settles. Sign-in and iOS were unaffected.
  Postmortem: `docs/postmortems/2026-09-17-android-passkey-hang.md`.
- `createWalletPasskey` now uses the PRF that `create()` already returns instead
  of a second `get()`. Proven byte-identical on device, so the derived wallet is
  unchanged — see `docs/passkey-prf.md`.
- Assertions send no `allowCredentials` on Android (the shape that hangs) and
  pin the credential by comparing `rawId`; iOS and desktop still name the exact
  credential, so no chooser appears there.
- New mission-critical guard `services/auth/PasskeyPrfDerivation.test.ts`: pins
  the PRF salt and RP ID literals and the byte pass-through. A failure there is
  never "update the expected value" — it means the change would strand every
  existing wallet.
- Deploy note: the workflow run for this deploy reported failure. Production was
  correct; the verification step probed the homepage once, outside its retry
  loop, 22 s after the deploy while Cloudflare was still propagating. No release
  tag was created for `92a8f39a` as a result. PR #1376 (`ae28674f`, merged, not
  yet deployed) retries all three checks together.

### 0.96.4 (web release, LIVE on app.nuri.com since 2026-09-13)

- LIVE: source `951ee69c`, PR #1326 (open/draft, not merged). Bundle
  `_expo/static/js/web/index-ebc58100f30c4ca275aa1f64317c6c7b.js`
  (SHA-256 `6df85b…a255f`). Wallet-open detection shows the eligible original
  funded order after unlock; explicit Continue still required. Same order,
  same recipient, no replacement. Customer signature/payout open.
  Incident: `docs/postmortems/2026-09-13-swapkit-recovery-wallet-open.md`.

### 0.96.4 (web candidate history, superseded by the live entry above)

- #1325 / #1326: Show the existing confirmation on wallet open for an owner-bound, claimed original route with an unsubmitted final leg. Defer behind other flows; dismiss once per order per session. No navigation, replacement swap, automatic changed-price signature, or acceptance on open.
- Shared web/iOS/Android UI; only the bundle-owned label changes. No native version, dependency, fingerprint, deployment, OTA or customer payout claim. See [candidate notes](docs/releases/0.96.4.md).

### 0.96.3 (web-only candidate, unpublished)

- Assign the compiled bundle identity `0.96.3` for the app.nuri.com candidate in #1326. Publication remains pending parent build, deployment and live verification; this entry does not claim it shipped.
- [Web-only candidate notes](docs/releases/0.96.3.md): backend recovery is a separate rollout. This web deployment alone does not promise a usable recovery button or a Ludmilla payout. No backend, OTA or Store publication is included; Expo version `0.96.0`, package version, native build numbers and fingerprint inputs remain unchanged.

- #1325 / #1326: Let the owner review a current euro amount and explicitly continue the original funded swap, without another deposit or replacement order. Preserve the original recipient, quote provenance, fixed accepted EURC minimum and sell ceiling.
- Recover expired unaccepted confirmations and lost acceptance responses without silently replacing or re-signing terms. Keep durable checkpoints and require explicit confirmation of fresh terms.
- Bind real server `id`/`txId` responses to the original order and retain pending recovery until successful net EURC receipt proof. Preserve ordinary signer and price safeguards.
- Exact-head app tests, backend-response integration, typecheck, full lint and independent code reviews passed using offline fixtures. No release, web/OTA deployment or live customer payout is claimed.
- [Draft release notes and web-versus-OTA scope](docs/releases/swap-recovery-unreleased.md): `0.96.3` is assigned only as an unpublished WEB candidate; compatible production runtimes were verified at the recorded functional head. The broader dev/mobile gap is excluded from this web-versus-live delta. A full dev OTA is not approved by these recovery checks.

## 0.96.2 — 2026-09-07 (web release candidate)

- Emin Mahrt / Hermes (#1185, #1186): refresh public payment links while preserving all existing rails. Keep the amount/recipient summary, shorten the recipient address above the QR to one line, and show only "Tap to copy" below. Copy the complete QR payment URI so the source chain, token and exact amount stay intact. Add Bitcoin/Lightning OS wallet handoff; keep WalletConnect runtime and new banking/confidential contracts deferred.
- Preserve the deployed 0.96.1 Home and Support changes. See [release notes](docs/releases/0.96.2.md); PWA only, no OTA or store release.

## 0.96.1 — 2026-09-07 (web release candidate)

Requested and locally Home-tested by Emin Mahrt. Tracking: [#1189](https://github.com/nuri-com/nuri-expo/issues/1189).

### Changed

- Home starts and resets on Total Balance. Balance refreshes no longer automatically choose the highest-funded account or VISA for an empty wallet.
- The overview groups existing balances into Bitcoin, Cash, and Card & Banking. Each group opens its first account, with fixed carousel pairs: Bitcoin/Lightning, Euro/Dollar, VISA/IBAN.
- Card and banking share one balance in the total; unknown currency conversions remain unavailable rather than appearing as zero.
- Support places Logout before Share Info while preserving logout confirmation and explicit sharing consent.

### Added

- Support shows the loaded bundle's release version to the left of Logout so a cached or older app can be identified without confusing it with the latest server deployment.
- [Release notes and product-copy drafts](docs/releases/0.96.1.md), with separate web, OTA, and store publication states.

### Release scope

Web only for this rollout. OTA and store notes are prepared, not published. No new send/swap backend, fresh-Arkade fallback, native dependency, or design-system changes. The Home candidate was user-approved before the Support version addition; the addition receives its own automated and web smoke checks.

## Earlier unreleased ledger (preserved)

The entries below predate the 0.96.1 candidate. They are not a claim that every listed feature is newly included in this release; the candidate diff and release notes define its scope.

## Unreleased

### Added

- `app.nuri.com/?carousel=1` now exposes a reversible home-design canary: a
  magnetic Total Balance/account card rail, Move/Send actions and the selected
  real account's existing activity/detail rows. Account content changes only
  after a swipe settles. Without the query flag the current home stays
  unchanged, so the visual test does not alter passkey or money logic.
- Browser wallet creation now chooses an available username before creating a
  credential, both on the standard welcome page and `app.nuri.com/@username`.
  The passkey requests `@username` as its account/display name. Creation uses
  exactly two WebAuthn ceremonies: `create()`, then one exact-credential `get()`
  that both returns PRF and signs the server username challenge. Existing links
  show `Sign Passkey @username`; available names show `Claim @username Passkey`.
  Only an authoritative server `404` means available; timeouts and every other
  error stop the flow. Missing/malformed PRF stops before wallet bootstrap or
  username registration. After the new passkey and exact PRF assertion succeed,
  Claim replaces any existing local wallet through the canonical switch wipe.
- Support Chat now offers `Switch passkey`; reset verifies critical key removal
  and reloads the web app after a successful switch.
- `scripts/deploy-app-nuri-pwa.sh` is now the only documented production PWA
  deploy path. It requires a clean tree containing both latest `origin/dev` and
  the currently installed source SHA, verifies the one-screen app and mainnet
  export, writes `/deployment.json`, backs up production, and verifies the live
  asset hash after deployment.

### Fixed

- Wirex activation now focuses the email field only after its full-screen sheet
  has finished opening and keeps the single field outside automatic scrolling,
  so the cursor is immediately ready without shifting or clipping the input.
- Inactive VISA now uses the supplied platinum card face with compact Add money
  and Activate controls. Wirex signup shows a dedicated deployment wait state,
  then first-time and resumed KYC open the wallet username's stable external
  verification permalink instead of an expiring embedded session.
- Empty wallets now open on the VISA card while keeping inactive VISA and IBAN
  visible. Both offer Add money and Activate; once funds arrive, the carousel
  automatically opens the highest-valued funded balance until manually swiped.
- Authenticated usernames now persist as wallet identity metadata and recover
  from the owner-bound Arkade record when older LNURL receive caches are absent.
  Home keeps a known identity through delayed or empty hydration, preventing a
  signed-in account from silently degrading to `Welcome there!`.
- Support Chat `Switch passkey` now opens the canonical destructive-logout
  confirmation and uses the exactly-once teardown guard. A partial wipe becomes
  a non-dismissible retry state instead of returning to a half-torn session.
- Cold launch with a persisted username-claim sentinel now clears any retained
  `/@username` target before rendering onboarding, so interruption after key
  persistence cannot strand the user behind a disabled Claim link.
- Successful two-ceremony registration now persists and emits the returned
  username/LNURL status immediately, so home, Receive and Wirex onboarding see
  the claimed identity without another passkey assertion.
- EURC → Bitcoin self-receive now requests on-chain `BTC` routes and settles
  directly to the wallet's `bc1…` Arkade boarding address. It no longer creates
  an Arkade Lightning invoice or sends native `BTC_ARKADE` as a fallback.
  Scanned external Lightning invoices remain separate `BTC_LN` payments.