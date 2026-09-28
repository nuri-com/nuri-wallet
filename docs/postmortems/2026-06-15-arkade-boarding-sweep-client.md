# Arkade Boarding Sweep Client Postmortem

Date: 2026-06-15

Repo: `nuri-expo`

Branch: `arkade-debug-ui-ux-and-migration-fixes-emino-jun13th`

Status: working in the app with the deployed `server-arkade-v4`
`security/boarding-sweep-approval` branch. This document preserves the current
review state before maintainers merge the PR.

## Summary

The receive unlock flow is now working in the secure approval-token model:

1. Lightning receive claim still uses the receive-claim approval scope.
2. Boarding sweep now uses the boarding-sweep approval scope for both direct
   PSBT signing and Arkade tree signing.
3. Boarding sweep signs only requests that were approved by the server.
4. Boarding sweep only attempts locally owned, server `sweep_ready`, confirmed
   boarding UTXOs.
5. Boarding sweep runs one boarding UTXO per unlock attempt.
6. The Unlock Wallet prompt is hidden for non-actionable state such as pending
   LN receives, pending/preconfirmed wallet VTXOs, and below-dust recoverable
   sats.

The final user-visible state after the stuck wallet was cleared is expected to
be pending or idle, not actionable, when the only remaining values are:

1. `ln_receive_pending_count=2`.
2. `ln_receive_claimable_count=0`.
3. `boarding_sweep_ready_count=0`.
4. `recoverable_sats=288`.
5. `recoverable_min_sats=333`.
6. `actionable_count=0`.
7. No Unlock Wallet modal.
8. No passkey prompt.

## Why We Changed The Client

The server was hardened so `/arkade/sign` and `/arkade/tree/*` no longer accept
generic request-auth signing for receive maintenance. That is the right server
security model, but it exposed places where the app was relying on implicit SDK
behavior instead of carrying one precise approval scope through the whole
operation.

The client had to become stricter:

1. Build the exact direct sign jobs once.
2. Approve those exact sign jobs.
3. Reuse the same jobs for signing.
4. Approve tree signing under the same boarding-sweep scope.
5. Fail before calling the server if the app tries to sign a request that was
   not approved.
6. Avoid showing user prompts when the app has no operation it can actually
   complete.

## Failure Sequence

### 1. Direct Approval Mismatch

Initial failure:

`boarding sweep approval missing sign request ...`

Meaning:

1. The app asked the server to approve one set of direct sign requests.
2. The app later recomputed the PSBT preimage after the transaction state had
   changed.
3. The later `/arkade/sign` request did not match the approved request key.
4. The new local guard correctly stopped before calling the server.

Fix:

1. Build immutable direct sign jobs once in `ArkadeRemoteIdentity.sign(...)`.
2. Use that same job list for `/api/arkade/receive/boarding/sweep/approve`.
3. Use the same job objects for `/arkade/sign`.
4. Assert every sign request is present in `approvedRequestKeys` before calling
   the server.

### 2. Tree Signing Had The Wrong Approval Scope

Next failure:

`Arkade tree signing requires approval token`

Meaning:

1. Direct PSBT co-signing succeeded.
2. The SDK then entered Arkade tree signing.
3. The tree signer tried to use the generic outgoing-spend approval path.
4. Boarding sweep is receive maintenance, not outgoing spend.
5. No correct tree approval token was available.

Fix:

1. Keep a boarding-sweep approval scope active during `Ramps.onboard(...)`.
2. When tree requests appear during boarding sweep, call the same
   `/api/arkade/receive/boarding/sweep/approve` route with the combined direct
   and tree request set.
3. Use the returned `approval_token` for `/arkade/tree/session-init`,
   `/arkade/tree/nonce`, and `/arkade/tree/sign`.

### 3. Server And Local UTXO Ownership Needed Proof

Next failure:

`script ... is not a wallet script`

Initial suspicion was a long-lived wallet/key mismatch. We added diagnostics to
prove the actual state:

1. Server `sweep_ready` rows matched local SDK `getBoardingUtxos()` by
   `txid:vout`.
2. Values matched.
3. Local confirmed UTXOs matched the server rows.
4. The rejected script matched the current local wallet boarding script.
5. The failure was not caused by stale server rows or an old private key.

The useful copied log fields are:

1. `boarding_sweep_ownership`.
2. `boarding_sweep_ownership_rows`.
3. `boarding_sweep_error_script`.
4. `boarding_script`.
5. `offchain_script`.
6. `wallet_scripts`.
7. `wallet_has_script`.

### 4. Boarding Script Was Missing From Local Wallet Scripts

One diagnostic run showed:

1. `boarding_script=925a5bec1a9b9689`.
2. `offchain_script=7467f961525f0c26`.
3. `wallet_scripts=7467f961525f0c26`.
4. `wallet_has_script=0`.

Fix:

1. Register both the recovery default offchain script and the recovery boarding
   script in `recoveryDefaults.ts`.
2. Return both scripts from `wallet.getWalletScripts()`.
3. Return both scripts from `wallet.getScriptMap()`.
4. Add a local preflight guard before `Ramps.onboard(...)`.

After this, the local wallet showed:

1. `wallet_scripts=7467f961525f0c26,925a5bec1a9b9689`.
2. `wallet_has_script=1`.

### 5. Multi-Input Boarding Sweep Still Failed In Arkade SDK/Node

After the local script registration was fixed, the old wallet still failed when
the app attempted to sweep both boarding UTXOs in one SDK onboarding call:

`failed to sign commitment tx: ... script ... is not a wallet script`

The important distinction:

1. Server approval succeeded.
2. Direct signing succeeded.
3. Tree session, nonce, and sign succeeded.
4. The failure happened later in the Arkade SDK/node commitment signing path.

A fresh one-UTXO boarding test then succeeded, and the old stuck wallet also
cleared when the app swept one UTXO at a time.

Fix:

1. Preserve all matched confirmed candidates for diagnostics.
2. Select exactly one confirmed matched boarding UTXO for the current sweep.
3. Build the approval context from that one outpoint.
4. Pass only that one UTXO to `Ramps.onboard(...)`.
5. Refresh state after success so the next unlock can sweep the next UTXO.

## Live Evidence

Fresh test wallet:

1. `selected_count=1`.
2. `boarding_sweep_ready_sats=3000`.
3. Server approval succeeded.
4. `/arkade/sign` succeeded.
5. Tree signing succeeded.
6. `boarding_sweep: ok`.
7. Sweep txid:
   `956be6affa30231056e7ad7fbc6a9129e9c2318cc0014eb3bce3715021f82432`.

Previously stuck wallet:

1. Old stuck outpoint:
   `0c2a677ca31a50d1745b9f49d43756b8a274e751e957d9cb7271960f87649243:2`
   for `35722 sats`.
2. Old stuck outpoint:
   `7a91dda04aea66c63a066416d5a04feccd6d14c63f969aaccbd15e36e18abf1f:0`
   for `21540 sats`.
3. Multi-input sweep failed inside Arkade SDK/node with
   `script ... is not a wallet script`.
4. One-by-one sweep succeeded.
5. Sweep txid:
   `3ba35e8792a11c5c6e254d24a2f881f22953e38e2cf7f2bd59e71bb3e37face7`.
6. Sweep txid:
   `062c48c439e67900aadedc877934c6608edc135a1ba3a04a055a51e283cf3957`.
7. Final server sync showed `boarding=0` for the affected owner.

## What Changed In The App

### `services/arkade/ArkadeRemoteIdentity.ts`

1. Added immutable boarding-sweep direct sign jobs.
2. Reused the exact approved sign jobs instead of recomputing preimages.
3. Added local approved-request checks before server signing.
4. Routed boarding-sweep tree requests through boarding-sweep approval instead
   of outgoing spend approval.
5. Required approval-token usage for direct and tree boarding-sweep signing.
6. Logged missing request hashes before failing closed.

### `services/arkade/ArkadeApiService.ts`

1. Added optional boarding row script fields used for ownership diagnostics.

### `services/arkade/internal/recoveryDefaults.ts`

1. Built both recovery offchain and recovery boarding scripts.
2. Registered both recovery contracts.
3. Exposed both scripts through wallet script lookup methods.
4. Logged both script hashes during wallet initialization.

### `services/arkade/internal/receiveAutoSweep.ts`

1. Intersected server `sweep_ready` rows with local SDK boarding UTXOs.
2. Logged ownership proof rows and script hashes.
3. Blocked stale or non-wallet-script server rows.
4. Added rejected-script diagnostics for Arkade SDK/node errors.
5. Swept one confirmed matched boarding UTXO per attempt.
6. Passed only that selected UTXO into `Ramps.onboard(...)`.

### `services/arkade/ArkadeReceiveUnlockService.ts`

1. Kept LN pending rows as pending, not actionable.
2. Kept wallet pending/preconfirmed VTXOs as pending, not actionable.
3. Counted recoverable wallet update only when recoverable sats meet the
   recoverable dust threshold.
4. Skipped manual recoverable update below dust.
5. Included `recoverable_min_sats=333` in diagnostics.
6. Passed server boarding rows through the local ownership filter before
   showing sweep-ready state.

### `screens/bitcoin/components/ArkadeUnlockWalletModal.tsx`

1. Added copied diagnostic fields for claimable sats, boarding sats, pending
   counts, recoverable threshold, and preconfirmed sats.

## Current Unlock State Rules

The app shows `Unlock Wallet` only when `actionableCount > 0`.

Actionable:

1. `ln_receive_claimable_count > 0`.
2. `boarding_sweep_ready_count > 0` after local ownership filtering.
3. `recoverable_sats >= recoverable_min_sats`.

Not actionable:

1. LN pending rows with no claimable status.
2. Wallet pending VTXOs.
3. Preconfirmed pending sats.
4. Recoverable sats below `333`.
5. Server boarding rows that do not match local SDK UTXOs.

## Why We Did Not Use A Raw Private-Key Test

We intentionally did not validate this by pasting a raw private key into a CLI.
A raw key alone is not enough for this flow. A faithful test would also need:

1. Arkade wallet storage and contract state.
2. Node URL.
3. Arkade server public key.
4. Nuri recovery server public key.
5. CSV policy.
6. Selected UTXOs.
7. Server approval/passkey path.

The live one-UTXO sweep and the old wallet one-by-one sweeps proved the secure
path without introducing a burned test-key workflow.

## Reviewer Checklist

1. Confirm no boarding sweep path falls back to generic request-auth signing.
2. Confirm direct sign requests are approved before `/arkade/sign`.
3. Confirm tree requests during boarding sweep use `approval_scope=boarding_sweep`.
4. Confirm the app selects one boarding UTXO per sweep attempt.
5. Confirm server rows are intersected with local SDK boarding UTXOs before
   sweep.
6. Confirm below-dust recoverable sats do not open Unlock Wallet.
7. Confirm `Unlock Wallet` still appears for actual LN claimable rows or
   sweep-ready boarding rows.
8. Confirm copied logs include enough fields to diagnose the next receive issue
   without exposing secrets.

## Open Follow-Ups

1. Ask Arkade whether multi-input boarding onboarding is intended and provide
   the stuck-wallet outpoints plus the `script ... is not a wallet script`
   evidence.
2. Reduce repeated passkey prompts inside one unlock session while preserving
   exact per-operation approval tokens.
3. Keep live proof checks for send, LN receive claim, boarding sweep, and
   below-dust unlock state after every approval-token change.
