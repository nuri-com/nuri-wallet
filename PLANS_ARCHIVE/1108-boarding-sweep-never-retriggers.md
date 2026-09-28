# Issue #1108: Boarding sweep never retriggers: 737k sats stranded on a sweep_ready UTXO with no retry path

> Claimed by lennardevertz on 2026-08-17
> Branch: `wf/1108-boarding-sweep-retry`

## Summary
Restore the only client-side path that can move a `sweep_ready` boarding UTXO. A wallet-summary rejection used to discard the server's boarding rows and publish `actionableCount: 0`, which is the single condition `App.tsx` opens the unlock modal on — so the monitor polled forever, the modal never appeared, and 737,148 sats sat unswept from 2026-08-04. Behind that gate: an unbuildable wallet (or an unreadable boarding-UTXO list) silently dropped the same rows, one tap ran only the first actionable step, and the first `claim_signed` closed the modal before the sweep ran. Boarding sweeps are client-only and background auto-sweep stays disabled, so every one of those independently strands the funds.

## Issue Description
#### Goal and why

`POST /api/arkade/receive/sync` reports the boarding row `4cdfc1681b060f5d252e70873b2c61943d23b2e74261f047b4de8df8c04c8cb6:0`, 737,148 sats, `status: "sweep_ready"`, `swept_at_ms: null`, unspent with 1,843 confirmations. The Arkade indexer shows zero vtxos for the owner, so nothing ever landed offchain: this is a never-executed sweep, not a half-settled round. `/arkade/info` returns the expected `serverPk33`, so the MuSig2 cosign path is healthy and the sweep succeeds the moment the app fires it. The defect is app-wide — any wallet whose summary fails once while a boarding UTXO is `sweep_ready` lands in the same state — and the reporting account is only the reproducer.

#### Scope

- Settle `/receive/sync` and the wallet summary independently, so a summary failure cannot discard boarding rows.
- Keep server `sweep_ready` rows when local ownership cannot be checked, in a distinct "needs wallet" state.
- Surface a failed receive-address derivation with a retry instead of "no address yet".
- Hydrate the boarding address back from the server, verified against the wallet's own boarding script.
- Run every actionable step in one unlock session and keep the modal open while work remains.
- Decide explicitly on `isArkadeBoardingAutoSweepEnabled()` and, while it stays off, add a persistent pending-sweep surface.
- Cover the gate with a regression test.

#### Non-goals

- The empty server-side `sweep.script_pubkey`: `buildBoardingOwnershipProof` already tolerates it, so it is cosmetic and belongs to the server repository.
- Enabling background auto-sweep, which would need a server-approved signing scope without a user tap.
- Any per-account remediation; the fix is the code path, not one owner's funds.

#### Acceptance criteria

- [x] A rejected `getArkadeWalletSummary()` still yields actionable unlock state from the sync rows.
- [x] An unbuildable wallet, or an unreadable boarding-UTXO list, keeps the server's `sweep_ready` rows.
- [x] One unlock tap runs both a Lightning claim and a boarding sweep.
- [x] The modal stays open while actionable items remain.
- [x] A failed address derivation offers a retry.
- [x] A server-hydrated boarding address is only used when it matches the wallet's own boarding script.
- [x] Waiting sats remain reachable after the modal is dismissed.
- [x] Regression tests cover the gate and the ownership-filter paths.

#### Owning repository and base branch

`nuri-com/nuri-expo @ dev`

#### Risk class

Funds-adjacent (receive/sweep paths, no signing-policy change)

## Tasks
1. Settle sync and summary independently in `refreshArkadeReceiveUnlockState`; surface a summary failure in `lastError` instead of collapsing the state.
2. Keep server `sweep_ready` rows when the wallet cannot be built or its boarding UTXOs cannot be read; expose `boardingWalletUnavailable`.
3. Publish an address-derivation error from `WalletService` and offer a retry in the receive sheets.
4. Hydrate the boarding address from `/receive/sync`, accepted only when its script matches the wallet's own boarding tapscript.
5. Run every actionable step in one unlock session; keep `recoverable_wallet_update` out of a mixed session.
6. Gate the modal's early close on the Lightning claim being the only actionable item.
7. Keep auto-sweep disabled and add the persistent pending-sweep row that reopens the modal.
8. Add regression tests for the unlock state, the step loop, and the real ownership-filter path.

## Progress Log
| Date | Agent | Task | Status | Notes |
|------|-------|------|--------|-------|
| 2026-08-17 | lennardevertz | 1-8 | Complete | First implementation at `5f5e094d`; PR nuri-com/nuri-expo#1109 opened against `dev`. 991 tests passed, typecheck clean for touched files. |
| 2026-08-17 | lennardevertz | 1-2, 4-8 | Complete | Review round at `83ad90be`: snapshot boarding rows before the step loop (a claim's `arkade:receiveUpdated` triggers a refresh that clears them mid-session), restore rows on the refresh failure path, verify the hydrated address against `boardingTapscript.pkScript`, unbundle `recoverable_wallet_update`, keep the wallet-unavailable support log informative, give the pending-sweep row its own copy. 995 tests passed. |
| 2026-08-17 | lennardevertz | 2, 8 | Complete | Second review round: a failed `getBoardingUtxos()` was swallowed into `[]` inside `buildBoardingOwnershipProof`, so a node timeout dropped every `sweep_ready` row with `walletUnavailable: false`. Now carried as `localUtxoLookupError`, treated as needs-wallet by the filter, and thrown by the sweep instead of returning a skip. New `receiveAutoSweep.filter.test.ts` drives the real filter, including the control case where the wallet genuinely owns nothing. |

## Handoff Notes
Device verification is still open and listed unchecked in the PR: (a) a `sweep_ready` UTXO with a failing wallet summary must open the modal and complete the sweep, (b) dismissing the modal and tapping the arkade rail's pending-sweep row must reopen it, (c) a forced address-derivation failure must show the retry and recover from it.

`boardingWalletUnavailable` is currently consumed only by the unlock detail log. The rows stay actionable so the funds remain reachable, but "needs wallet" is not yet distinct in the UI — if that should read differently to the user, it needs a product decision, not another code path. Same for a home-list signal: the pending-sweep row lives on the arkade asset screen, one tap deep.

`isArkadeBoardingAutoSweepEnabled()` stays `false` by decision, documented at the flag. Anyone revisiting it needs the server-approved signing scope story first — that is what makes the tap mandatory today.

The pending-sweep row introduced `screen.AssetScreen.pendingSweep{Label,Status,A11yLabel}` in both locales. That copy has not been through product review.
