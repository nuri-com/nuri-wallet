# Nuri Expo: SwapKit v1 → v2 Migration Plan

## Implemented branch boundary — 2026-09-16

The current requirement supersedes this plan's original v1 drain exception: **no production v1 network calls**, including startup and wallet-wake polling. Existing v1 records are preserved, never relabeled as v2 ids. Local signer/parser helpers remain shared; old network services remain isolated from production entrypoints.

The final active-caller census is:

| Production flow | Current path |
| --- | --- |
| Stable → BTC, BTC → stable/card, direct EVM and sweep | Existing `SwapKitV2*Service` quote/commit/action paths |
| Arkade BOLT11 / LNURL / remittance sends | `SwapKitArkadeLightningSendService` → v2 quote/commit/material; approved funding → journaled `swap_submit` with indexed outpoint |
| Lightning wake/refund and interrupted commits | `SwapKitV2LightningResume` → v2 status/tracker; shared order lock prevents competing funders |
| Public Pay swap deposits | `PayTargetService` → v2 quote/commit with only `send_asset`; separate persisted recovery capability and status |
| App startup and transaction detail/history | v2 resume/tracker/status; explicit Continue reconstructs saved execution bounds |

`SwapKitV2ProductionBoundary.test.ts` checks symbol reachability and module initialization from App.tsx, excluding the explicitly development-only debug loader. It includes a positive control for the legacy network caller. Legacy corridor implementations (`StableToBtcSwapService`, `SwapKitCardTopupService`, `SwapKitArkadeIntentsStableService`, `SwapKitSweepService`, `SwapKitDirectEvmSwapService`, their recovery wrappers, and the v1 tracker) are not production network paths. V2 imports of local signing, balance-reading, formatting, and parser helpers are intentional.

Server code and a read-only deployed capability call confirm contract 2.2.0 supplies `arkade_refund_material`, `arkade_intents_fund`, `arkade_intents_refund`, and `send_asset`. No server contract extension is necessary. Local MCP, engine and server-recovery selfchecks pass without provider calls or funds; this is not a funded release proof.

## Objective

Migrate Nuri Expo's wallet swap integration from the legacy SwapKit MCP at `https://swapkit.nuri.com/mcp` to the v2 MCP at `https://swapkit.nuri.com/v2/mcp` without losing supported swap corridors, wallet signing, pending-order recovery, sweep/recovery UX, or legacy-order recoverability.

This is an Expo client migration. SwapKit v2 is already deployed and exposes:

- `swap_capabilities`
- `swap`
- `swap_submit`
- `swap_status`
- `swap_cancel`
- `swap_list`
- `swap_sweep`

## Non-goals

- Do not port subscriptions, operational/discovery tools, or unused legacy providers.
- Do not add Mercuryo, Paybis, or an on-ramp flow to SwapKit; those remain dedicated services/app flows.
- Do not add a separate recipient feature in Expo; recipient validation belongs to the v2 swap boundary.
- Do not sweep Base balances; Base EURC/USDC are first-class wallet balances.
- Do not replace amount-specific Lightning Address/LNURL invoice creation in the app payment layer.
- Do not migrate old v1 orders into v2 storage or reinterpret v1 order IDs as v2 order IDs.

## Current client scope

The central caller is `services/swapkit/SwapKitService.ts`, especially `callSwapKitTool()` and these exported paths:

- quote/route/options/plan helpers
- create/execute helpers
- wallet-action submission
- tracking/status/list helpers
- sweep helpers
- recovery quote/accept helpers

Important production callers include:

- `services/swapkit/StableToBtcSwapService.ts`
- `services/swapkit/SwapKitDirectEvmSwapService.ts`
- `services/swapkit/SwapKitCardTopupService.ts` — DEFERRED: stays on v1 for now; the BTC/Arkade → EURC-card route needs a new SwapKit server capability still in development. Migrate in a follow-up once it lands.
- `services/swapkit/SwapKitArkadeLightningSendService.ts`
- `services/swapkit/SwapKitArkadeIntentsStableService.ts`
- `services/swapkit/SwapKitSweepService.ts`
- `services/swapkit/SwapKitPendingTracker.ts`
- `services/swapkit/SwapKitRecoveryService.ts`
- `services/swapkit/SwapKitHtlcActionService.ts`
- `services/swapkit/SwapKitArkadeActionService.ts`
- `services/swapkit/SwapKitArkadeIntentsActionService.ts`
- `services/pay/PayTargetService.ts` where it invokes SwapKit-backed payment flows
- transaction/status UI screens that consume the service's status model

Before editing, regenerate the caller census with repository search; tests and debug screens are not production callers unless confirmed.

## v1 → v2 operation mapping

| Existing behavior | v2 replacement | Migration rule |
|---|---|---|
| `swap_options`, `swap_route`, `swap_plan` | `swap` with `mode: "quote"` | Use canonical `from`, `to`, `amount`, `side`, owner, recipient, capabilities, and signer class. Do not pass route IDs between calls. |
| `swap_create` + `swap_execute` | `swap` with `mode: "commit"` | The selected `optionId` is sent with the commit. The response already contains the first bound action(s). |
| Provider/route-specific execution branches | One action dispatcher | Dispatch only on v2 action `kind`; do not branch on provider names. |
| `swap_wallet_submit` | `swap_submit` | Submit `{orderId, actionId, evidence, idempotencyKey}` and consume the returned refreshed order view. |
| `swap_track` | `swap_status` | Poll by v2 `orderId`; use returned canonical status and actions. |
| `swap_list` | `swap_list` | Restore active and recent v2 orders after restart/reinstall. |
| v1 cancellation | `swap_cancel` | Only cancel unfunded orders; funded orders must settle or refund. |
| `swap_sweep` | v2 `swap_sweep` | Read-only scan by default; `confirm:true` creates ordinary v2 orders and returns normal bound actions. |
| v1 recipient normalization | v2 `swap` boundary | Pass the user's existing recipient input; consume v2's normalized recipient metadata. No extra resolver round trip. |
| v1 recovery quote/accept | Compatibility path | Keep v1 recovery for legacy v1 orders until the migration drain is complete, unless a separate v2 recovery contract is explicitly added. |

## Phase 0 — Freeze and inventory

1. Create the integration branch from `dev` and switch the production callers directly to the v2 transport.
2. Keep the existing v1 URL and implementation available only for legacy-order tracking/recovery during the migration.
3. Record every production caller and its expected request/response shape.
4. Define the v2 capability set for each caller. Start with the action kinds that the wallet can actually sign:
   - `send_asset`
   - `execute_evm_call`
   - `sign_typed_data`
   - `pay_lightning_invoice`
   - `htlc_material`
   - `arkade_send`
   - `arkade_claim`
5. Do not invent capabilities: derive them from the existing signer/action implementations.

## Phase 1 — Build the v2 client transport

In `SwapKitService.ts`:

1. Add a v2 endpoint constant without deleting the v1 endpoint.
2. Add a v2 JSON-RPC/MCP request wrapper with the same timeout, retry, error, and telemetry behavior as the existing wrapper.
3. Call `swap_capabilities` once per app session or cached capability version.
4. Validate the returned contract version, action kinds, signer classes, and schemas before enabling v2.
5. Normalize MCP errors into the existing app error model without hiding `unmapped_provider_state`, `order_in_flight`, capability, recipient, or funding errors.
6. Keep v1 and v2 order IDs/types distinct at the type level.

## Phase 2 — Replace quote and commit orchestration

Implement v2-native helpers rather than adapting v1 route IDs:

### Quote

Send:


```json
{
  "from": "USDC_ARBITRUM",
  "to": "EURC_BASE",
  "amount": "12.345678",
  "side": "deposit",
  "mode": "quote",
  "owner": "0x...",
  "settleTarget": "0x...",
  "refundAddress": "0x...",
  "capabilities": ["send_asset", "execute_evm_call"],
  "signerClass": {"evm": "eoa"}
}
```

Display `options[]` and structured `unavailable[]`. Store the chosen `optionId` from the quote.

### Commit

Send the same request with `mode:"commit"`, the chosen `optionId`, and a stable idempotency key. Persist the returned `orderId` before beginning wallet action execution.

The commit response is authoritative for the initial action stream. Do not reconstruct actions from a route, provider, or client-side amount calculation.

### Action loop

Create one v2 action dispatcher that:

1. Reads the live returned action stream.
2. Dispatches by closed `kind`.
3. Signs/broadcasts only the exact bound request.
4. Submits evidence through `swap_submit`.
5. Uses the returned refreshed state/actions immediately.
6. Never repeats an action that v2 retired or superseded.
7. Fails closed on unknown action kinds or missing evidence fields.

Reuse existing wallet signing implementations; replace only the SwapKit protocol adapter around them.

## Phase 3 — Tracking, restart, and legacy compatibility

1. Update `SwapKitPendingTracker` to call `swap_list` and `swap_status` for v2 orders.
2. Persist v2 order IDs, action IDs, idempotency keys, and canonical status.
3. On startup/foreground:
   - v2 orders use v2 `swap_list`/`swap_status`;
   - v1 orders continue using v1 tracking/recovery;
   - never send a v1 ID to v2 or vice versa.
4. Keep v1 tracking until all existing v1 orders are terminal and the rollback window is closed.
5. Preserve recovery UI for v1 orders; v2 sweep/refund recovery is handled by the v2 sweep response and action stream.
6. Verify app reinstall/resume with server-side order IDs, not only local order storage.

## Phase 4 — Sweep migration

Update `SwapKitSweepService.ts` and its UI consumers to call v2 `swap_sweep`.

### Read-only behavior

Verify that the response still supports:

- off-Base EVM balance discovery;
- refundable Satora HTLC discovery;
- signable-chain filtering;
- market/spam/dust filtering;
- Base EURC/USDC exclusion;
- exact token address and amount metadata;
- discovery metadata used by debug/recovery UI.

### Confirm behavior

1. Call v2 `swap_sweep(confirm:true)`.
2. Present/execute the ordinary returned v2 orders and action streams.
3. Use `swap_submit` for every action result.
4. Keep refund/claim actions bound to the exact returned descriptors.
5. Do not call the old `fundSweepConvert` path for v2 orders.

### tBTC-Arbitrum regression

The recent v1 `safeSweepAmount()` fix is shared by v2 because v2 uses the current `src/sweep.mjs` scanner. Add a v2-specific selfcheck proving that a small tBTC-Arbitrum balance is not rounded down to six decimals and that the rendered amount never exceeds the raw balance.

Also run the refundable-HTLC/recovery selfcheck after the legacy discovery hydration change; no duplicate implementation should be created in v2.

## Phase 5 — Recipient boundary

This is part of the normal quote/commit migration, not a separate product feature.

1. Keep Expo's existing QR, ENS, Lightning Address/LNURL, Bitcoin, Arkade, and payment-layer logic.
2. Pass the user's target into v2 `swap`.
3. Let v2 validate and normalize:
   - ENS → resolved checksummed EVM address;
   - EVM/Bitcoin/Arkade/BOLT11 chain and format compatibility;
   - BOLT11 amount and expiry;
   - reject unresolved/mismatched destinations before provider creation.
4. For Lightning Address/LNURL, Expo first obtains the amount-specific BOLT11 invoice through its existing payment layer, then commits that invoice to v2.
5. Store/display v2 `resolvedRecipients` only where useful for confirmation/debugging; do not add another resolver request.

Do not delete v1 client support until existing v1 orders are terminal or have an explicit recovery plan; new orders use v2 directly.

## Test plan

### Unit/selfcheck coverage

- v2 capabilities handshake and schema validation.
- Quote option selection and structured unavailable handling.
- Commit idempotency and duplicate-submit safety.
- Every action kind used by Expo.
- Exact transaction/request binding before signing.
- Recipient normalization and rejection cases.
- BOLT11 amount/expiry and Lightning Address invoice flow.
- tBTC-Arbitrum small-balance precision.
- Base balance exclusion.
- Refundable HTLC discovery and claim.
- v2 sweep live-balance recheck and reservation guard.
- v2 order restart/resume and v1/v2 ID separation.

### Integration tests

- Each existing production caller using the direct v2 integration.
- App foreground/background and restart during `AWAITING_ACTION`, `IN_FLIGHT`, `SETTLING`, `REFUNDED`, and `FAILED`.
- Cancellation of an unfunded v2 order.
- Recovery of a legacy v1 order while new orders use v2.
- Sweep UI read-only, confirm, action execution, and refundable claim.

### Funded release gates

One corridor at a time, with no overlapping funded experiments:

1. one ordinary EVM stablecoin route;
2. one Arkade/Lightning route;
3. one Bitcoin route if supported by the app flow;
4. one tBTC-Arbitrum sweep/recovery case only if a real controlled balance is available;
5. one refundable HTLC recovery case if available.

Release proof requires destination balance increase or proven refund—not quote availability, provider acceptance, generated actions, or transaction submission.

## Integration verification

1. Build the branch from `dev` locally.
2. Run the full end-to-end test flow locally against v2.
3. Fix failures directly in the integration branch.
4. Keep v1 tracking/recovery only for orders created before the migration.

## Done definition

The migration is complete when every named production caller uses v2 for new orders, v1 remains available only for legacy-order recovery during the drain, all action kinds used by Expo are handled from the v2 capability contract, sweep/recovery and tBTC-Arbitrum precision are verified, recipient handling is validated at the v2 boundary, and funded destination/refund evidence passes the release gates.
