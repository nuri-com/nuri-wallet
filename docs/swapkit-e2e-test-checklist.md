# SwapKit manual e2e test checklist (T11, swapkit#88)

Reproducible swap tests on a dev iPhone with Metro. Run before merging anything that touches
`services/swapkit/` or the swap modals, and after every server release that changes tracking.

## 1. Preconditions

1. Metro running on `:8081` (`npx expo start --dev-client`), phone and Mac on the same network.
2. Dev client installed and connected (the app shows the Metro bundle, not a release bundle).
3. Wallet unlocked at least once this session (PRF material available for signing).
4. Balances: ≥15 EUR in EURC on Base for the EUR→BTC tests; ≥10 EUR worth of sats
   (Arkade VTXOs or Lightning-spendable) for the BTC→EUR tests. Check limits in the modal —
   below-minimum amounts are rejected at quote time, which is not a swap test.
5. Note the device EOA (`0x…`): it is printed in the swap logs at create time and is the
   `fromAddress` for all server-side verification below.

## 2. Log capture

Console output is the ground truth; capture it to a file before starting:

```sh
node tools/metro-log-capture.mjs /tmp/swap-test-$(date +%H%M).log   # Node 22+
tail -f /tmp/swap-test-*.log | grep -E "SwapKit|derive|poll #"      # second terminal
```

The script attaches to Metro's inspector proxy (`http://localhost:8081/json` →
`webSocketDebuggerUrl`, CDP `Runtime.consoleAPICalled`) and appends timestamped lines.
It exits when the app reloads — re-run it after every reload.

## 3. Test matrix

| # | Test | Entry point | Route under test |
|---|------|-------------|------------------|
| 1 | EUR→BTC, Arkade | Home → Move (or Euro → Send → Convert to bitcoin, which opens the same card) | EURC → BTC_ARKADE (pick the Arkade route card) |
| 2 | EUR→BTC, Lightning | same card | EURC → BTC_LN (pick the Lightning route card) |
| 3 | BTC→EUR card topup | Home → Move, destination VISA Euro (same sheet and prices as test 4) | BTC → EURC to the Wirex smart account |
| 4 | BTC→EUR wallet | Home → Move, destination Euro | BTC → EURC to the device EOA |

### Per test — steps

1. Start log capture (section 2), open the entry point, enter the amount, wait for route cards.
2. Pick the route under test (NOT just the default), confirm, approve with passkey/Face ID.
3. Leave the app foregrounded until the success screen. Do not reload Metro mid-swap.
4. Record: txId (`sk_…` in the logs), duration, and the final status line.

### Per test — what the phase display must show

Non-terminal phases come from `describeSwapKitPhase` (`services/swapkit/SwapKitService.ts`):

- Funding: "Locking your coins into the swap vault…"
- EVM/CoW leg active: "Auctioning for your best exchange rate…"
- BTC leg, mid-route: "Swapping through the Bitcoin network…"
- BTC leg, last leg: "Delivering to your wallet…"
- Multi-leg routes prefix "Step n of m · ". Never a blank subtitle; a stuck swap must show
  the server's `funds.userMessage` verbatim.

### Per test — expected log markers (grep the capture file)

All tests:

- `poll #1 status=` … `poll #n status=… terminal=false actions=…` — the loop heartbeat,
  roughly every 12s (`runSwapKitSwapLoop`).
- Final: `poll #n status=COMPLETED terminal=true` (or the modal's success callback).
- No `sign attempt 3/3 failed` and no `API_ERR` lines on a happy path.

Test-specific:

- Test 1 (Arkade): an `arkade_vhtlc_v1` action handled without error; arkade txid submitted.
- Test 2 (Lightning): invoice paid marker, then status-only polls until terminal.
- Tests 3/4 (Satora/Boltz leg): `derive satora keyIndex=<n> minimum=<n> action=wa_…` —
  keyIndex must equal the server's minimum exactly (one jump, no walk-up), and a replay of the
  same actionId must log the SAME keyIndex (idempotence). Then the EVM/CoW leg signs once.
- Test 3 additionally: faucet drip line if the EOA had no gas (gas gate,
  `SwapKitCardTopupService`).

## 4. Server-side verification (MCP)

Use the Nuri Swap Kit MCP tools, scoped to the device EOA from step 1.5:

1. `swap_list` with `fromAddress = <device EOA>` — the new txId appears with the expected
   route and terminal status.
2. `swap_history` for the txId — every leg terminal, timestamps plausible, and the
   settle amount within the quoted bounds.
3. Cross-check: the `poll #` count in the app log times ~12s ≈ the server-side duration.

## 5. Safety invariant on ANY failure

Before retrying, panicking, or filing a bug, establish whether money moved:

1. `swap_history` for the txId → read `funds` / `fundsMovedToProvider`.
2. `fundsMovedToProvider = false` → nothing left the wallet; safe to retry freely.
3. `fundsMovedToProvider = true` and non-terminal → do NOT create a replacement swap and do
   NOT choose new destinations; the server sweep (cron, every minute) recovers to the
   create-time-bound addresses. Keep the txId, watch `funds.userMessage`.
4. The app must have parked cleanly: pending row visible, subtitle showing
   `funds.userMessage`, no crash loop.

## 6. Regression flags worth one extra run each

- Kill the app right after the send (test 1): on next launch the pending tracker resumes and
  the swap still completes (WP1 server-side funding detection).
- Two swaps back to back (test 3 then 4): the second must not reuse the first's keyIndex
  (`derive … keyIndex=` strictly increases).
