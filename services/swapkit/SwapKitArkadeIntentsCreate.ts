// What every Arkade Intents route result must state before the wallet funds it.
//
// Both corridors on this rail — paying a BOLT11, and swapping into a Base
// stable over Lightning — return the same three things the wallet cannot do
// without: the lockup to fund, the exact sats it must carry, and the handles
// (`rfqId`, `refundLocktime`) an unwind is later looked up by. Reading them in
// one place keeps a route that omits any of them from being funded by one
// corridor because the other's reader was the strict one.
import { isValidArkAddress } from "@arkade-os/sdk";
import type { SwapKitCreateResponse } from "./SwapKitService";

export type ArkadeIntentsCreate = {
  /** SwapKit's order id, for `swap_track`. */
  txId: string;
  /** The negotiation id — the only handle for looking the swap up later. */
  rfqId: string;
  /** When the lockup's unwind path opens, unix seconds. */
  refundLocktime: number;
  /** The Arkade lockup address to fund. */
  lockupAddress: string;
  /** Exactly what the lockup must carry, in sats. */
  fundAmountSats: number;
};

/**
 * The field is the exact integer the covenant must carry, so anything that is
 * not already one is refused rather than made into one. Truncating `1000.9` to
 * `1000` funds the lockup short, and a lockup funded short is one the solver
 * will not fill — the user then waits out the refund timelock for nothing.
 */
function exactSats(value: unknown): number {
  const sats = Number(value);
  return Number.isSafeInteger(sats) && sats > 0 ? sats : 0;
}

/**
 * Every check here runs BEFORE money moves.
 *
 * `fund.amountSats` is the integer the lockup must carry to the sat.
 * `fund.amount` is the same value in BTC and rounds — funding that float buys a
 * lockup the solver will not fill, leaving the user to wait out the refund
 * timelock for nothing, so it is never read.
 */
// A PRE-QUOTE estimate of what an Arkade->Lightning send will lock up, for
// affordability gating and the Max button BEFORE a real quote exists. It is NOT
// a correctness gate — the create path uses the exact from_amount Arkade returns.
// Uses Arkade's published card fee (fee_bps: 30) plus a small floor so tiny
// amounts, where the solver applies a per-quote minimum, are not under-estimated.
const ARKADE_INTENTS_FEE_BPS = 30; // Arkade solver card, docs.arkadeos.com/intents/developer-preview
const ARKADE_INTENTS_FEE_MIN_SATS = 5; // per-quote minimum observed at small amounts

export function maxFundAmountSats(acceptedSats: number): number {
  return (
    acceptedSats +
    Math.max(
      ARKADE_INTENTS_FEE_MIN_SATS,
      Math.ceil((acceptedSats * ARKADE_INTENTS_FEE_BPS) / 10_000),
    )
  );
}

/**
 * The inverse: the largest amount this corridor can be ASKED for when only
 * `budgetSats` may leave the wallet. "Everything you hold" is never such an
 * amount here — the lockup carries the spread on top — so a Max that typed the
 * whole balance produced a quote the affordability gate then refused.
 *
 * The closed form can land a sat over because `maxFundAmountSats` rounds the
 * spread up, so it steps down until the total actually fits.
 */
export function maxAcceptedAmountSats(budgetSats: number): number {
  const budget = Math.floor(budgetSats);
  if (!(budget > ARKADE_INTENTS_FEE_MIN_SATS)) return 0;
  let accepted = Math.floor(
    ((budget - ARKADE_INTENTS_FEE_MIN_SATS) * 10_000) / (10_000 + ARKADE_INTENTS_FEE_BPS),
  );
  // The closed form can land a sat under or over because the fee rounds up and
  // carries a flat floor. Settle to the exact maximum: step down while the total
  // overflows the budget, then up while one more still fits.
  while (accepted > 0 && maxFundAmountSats(accepted) > budget) accepted -= 1;
  while (maxFundAmountSats(accepted + 1) <= budget) accepted += 1;
  return Math.max(0, accepted);
}

export function readArkadeIntentsCreate(
  swap: SwapKitCreateResponse,
  options: { minFundAmountSats: number },
): ArkadeIntentsCreate {
  const source = swap as unknown as Record<string, unknown>;
  const txId = String(swap.txId || swap.orderId || "").trim();
  const rfqId = String(source.rfqId || "").trim();
  const refundLocktime = Math.trunc(Number(source.refundLocktime));
  const lockupAddress = String(swap.fund?.sendToAddress || "").trim();
  const fundAmountSats = exactSats(swap.fund?.amountSats);

  if (!txId) {
    throw new Error("SwapKit returned no order id for the Arkade swap.");
  }
  if (!rfqId) {
    throw new Error("SwapKit returned no rfqId for the Arkade swap.");
  }
  if (!Number.isFinite(refundLocktime) || refundLocktime <= 0) {
    throw new Error("SwapKit returned no refund locktime for the Arkade swap.");
  }
  // The lockup lives on Arkade. A funding target that is not an Arkade address
  // is a rail confusion, and paying it would send offchain funds somewhere the
  // route never quoted.
  if (!lockupAddress || !isValidArkAddress(lockupAddress)) {
    throw new Error("SwapKit returned no Arkade lockup address for the swap.");
  }
  if (fundAmountSats <= 0) {
    throw new Error("SwapKit returned no exact funding amount for the swap.");
  }
  // The lockup must carry at least the invoice amount — a quote that funds less
  // than what the far side receives is a different swap than the one requested.
  // We do NOT recompute the fee: Arkade's own docs state the spread between
  // from_amount and to_amount IS the complete cost and both are binding amounts
  // (fee_bps is advisory and, at small amounts, a rounding/minimum makes the
  // effective spread exceed it — a computed ceiling wrongly rejected 500-sat
  // sends that quote 505). The drain guard is elsewhere and exact: the wallet
  // refuses to fund more than its balance, and the user approves this precise
  // fundAmount on the confirm screen before signing.
  if (fundAmountSats < options.minFundAmountSats) {
    throw new Error("SwapKit funding amount is below the invoice amount.");
  }

  return { txId, rfqId, refundLocktime, lockupAddress, fundAmountSats };
}

/**
 * A create may return actions the wallet is expected to run. This corridor runs
 * exactly ONE thing — the funding send it performs itself — so any other action
 * is work nobody will do, and funding the lockup anyway pays for a route that
 * cannot complete. "Supported by the app somewhere" is not the same as "handled
 * here", which is why this is stricter than `assertSupportedSwapActions`.
 */
export function assertNoUnhandledCreateActions(actions: readonly unknown[] | undefined): void {
  const unhandled = (actions ?? [])
    .map((action) => String((action as { type?: unknown })?.type || "").trim())
    .filter((type) => type && type !== "send_asset");
  if (unhandled.length > 0) {
    throw new Error(
      `SwapKit route asks for actions this corridor does not run: ${unhandled.join(", ")}`,
    );
  }
}
