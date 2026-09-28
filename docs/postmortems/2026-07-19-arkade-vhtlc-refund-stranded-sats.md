# Arkade VHTLC Refund — 62.000 stranded sats

Date: 2026-07-19

Repo: `nuri-expo`

Branch: `v0.88.0-emin-jul18`

Commits: `d18069f4` (logs), `5d670ac0` (refund)

Status: resolved — funds recovered on-chain, refund path live-proven.

## Summary

Two swaps funded on 2026-07-18 left 62,000 sats locked in Arkade VHTLCs for
~28 hours. The provider (satora) went silent after taking the client funding,
and the app had no way to get the sats back: the refund operation was a
deliberate `throw`. The swap loop retried it every ~10 seconds through the
night, producing thousands of error lines and no progress.

Nothing was ever at risk of being lost — a VHTLC stays refundable — but the
user could not access their own money and had no visibility into why.

Resolved by implementing the refund via the `refundWithoutReceiver` tapleaf.
Both swaps refunded automatically at 16:02:27 UTC.

| Swap | Amount | Funded | Refunded |
| --- | --- | --- | --- |
| `sk_9db090f4-4f84-4dd9-9c3e-4f7d75d51fc4` | 42,000 sats | 2026-07-18 14:23 | 2026-07-19 16:02 |
| `sk_597681b7-e35a-434b-8cbc-4167c8b72785` | 20,000 sats | 2026-07-18 14:24 | 2026-07-19 16:02 |

## Timeline

1. **07-18 14:23/14:24** — two `BTC_ARKADE → USDC_BASE → EURC_BASE` swaps
   created over satora. Both VHTLCs funded correctly by the wallet.
2. **07-18 onwards** — satora reaches `clientfundedserverrefunded`: it pulled
   its own Arbitrum side back (`providerClaimTxHash`) and never completed the
   swap. Leg status `RECOVERY_PENDING`, order `PROCESSING`, `terminal=false`.
3. **07-19 02:32** — the server starts offering a `refund` action, *before*
   the timelock is reachable.
4. **07-19 overnight** — the app attempts the refund every poll and fails
   every time with `arkade_vhtlc_v1 refund not implemented yet`. ~8,600 error
   lines.
5. **07-19 ~13:00** — user reports missing money.
6. **07-19 14:00** — investigation blocked: the log printed `order=sk_9db09…`,
   and `swap_track` needs the full UUID. Fixed the log truncation first
   (`d18069f4`), which is what made the rest of the session possible.
7. **07-19 15:30** — refund implemented; first live attempt rejected by the
   ark server with `FORFEIT_CLOSURE_LOCKED (11): 1784471181 > 1784468590`.
8. **07-19 16:02:27** — chain block time passes the locktime; the swap loop
   refunds both VHTLCs unattended. 82,682 sats confirmed at the user's
   Arkade address.

## Root causes

### 1. Funds could enter a contract whose exit was not implemented

`SwapKitArkadeActionService` implemented `send` and `claim` but left `refund`
as a `throw` marked "fail closed". Failing closed is the right instinct for a
*signature*, but here it gated the user's only way out of a contract the app
had already funded. The comment said the sats "wait, they are not lost" — true,
and irrelevant to a user who cannot reach their money.

**Money can only be allowed into a contract whose every exit the app can
execute.** Not eventually. Before the first sat goes in.

### 2. A CLTV timelock was compared against the wall clock

The first refund gate used `Date.now()`. Bitcoin evaluates `OP_CHECKLOCKTIMEVERIFY`
against the chain's block time (median time past), which trails the wall clock
by one to two hours. At 15:31 UTC wall clock the chain stood at 13:43 UTC, so a
locktime of 14:26 UTC read as "an hour overdue" locally and "43 minutes away" to
consensus.

**Wall-clock time can prove a timelock has *not* passed. It can never prove it
has.** The chain is the only authority; the ark server reports it in the
rejection.

### 3. "Not due yet" was modelled as a failure

The action handler knew only success and error, so a state that simply meant
"wait" was logged as `ERROR` on every poll. This is what turned a benign wait
into an overnight error flood — and it buries real errors in noise.

### 4. Logs were truncated, which cost the first hour

`lib/log` capped every line at 160 characters ("SMS-safe") and swap services
sliced ids to 8 characters. The result: `order=sk_9db09…` — useless for
`swap_track`, which needs the full UUID. Worse, the actual failure reason lived
in a `data` field the console never renders, so the visible line was just
`Arkade refund failed.`

Both were removed. The very next log line after the fix contained
`FORFEIT_CLOSURE_LOCKED (11): 1784471181 > 1784468590 (blocktime)` — root cause
#2, which would otherwise have stayed invisible.

## The fix

`refundSwapKitArkadeVhtlc` spends the **`refundWithoutReceiver`** tapleaf:

```
CLTV(refundLocktime) + Multisig[sender, arkadeServer]
```

The receiver — the swap provider — is deliberately not a signer on that leaf.
That is precisely why it works when a provider goes silent: the user's wallet
key plus the ark server suffices. No preimage is involved; a refund is the swap
not happening.

Safety properties, unchanged from the claim path:

- The script is rebuilt from the server's parameters and must hash to exactly
  the funded address. One wrong key, hash or timelock and nothing is signed.
- The wallet key must be the VHTLC's `sender` (in the arkade→EVM direction the
  user funds the VHTLC, so the user is the sender, not the receiver).
- The destination is the refund address bound at swap creation. It cannot be
  redirected.

`isVhtlcNotDueYetError()` recognises the ark server's `FORFEIT_CLOSURE_LOCKED`
response and treats it as a quiet skip with the remaining wait, not an error.

## What this does not cover

The refund proven here is **collaborative**: it needs the ark server to
co-sign. If Arkade itself becomes unavailable, this path fails too.

The VHTLC's last resort is `unilateralRefundWithoutReceiver` — the user's key
alone, after a ~9 day CSV delay (`778240` seconds). **It is not implemented.**
Until it is, self-custody of in-flight swap funds depends on Arkade's
cooperation. This is the single largest remaining gap and belongs in the app by
definition: no server can perform it.

## Verification

- `scripts/vhtlc-refund-check.mjs` — rebuilds both stranded VHTLCs from their
  real public parameters and asserts address equality; asserts that a locktime
  off by one second changes the address (fail-closed).
- `services/swapkit/SwapKitArkadeVhtlcService.test.ts` — the timelock gate and
  the `FORFEIT_CLOSURE_LOCKED` classification, including the real message.
- Live: both swaps refunded unattended, 82,682 sats confirmed on-chain at
  `ark1qzpq904am…gg50`.

## Follow-ups

1. **Unilateral exit** (`unilateralRefundWithoutReceiver`) — the real
   self-custody guarantee. Highest priority.
2. **Exit-completeness rule** — refuse to fund any contract whose exits the app
   cannot execute, checked when the route is offered rather than after funding.
3. **Visibility** — locked amounts and their refund time belong in the wallet
   UI. The user learned about this from missing money, not from the app.
4. Server: do not offer a refund action before `refundableAfter`.
5. Server: `summary` reported "deposit window closed 29711415 min ago" (~56
   years) — a cosmetic arithmetic bug, but it undermines trust in the numbers.

Related issues: #870, #871, #872, #873.
