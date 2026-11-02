// What the Lightning receive corridor will actually quote.
//
// These are not our policy: they are the solver card's bounds moved inward by
// the margins probed live against the 500..50000 sat, 30 bps card, where 501
// was refused (502 minted) and the fee lands on top of the cap (49830 was the
// highest amount that minted):
//   floor   = card min + 5
//   ceiling = card max - fee at the cap - 20
// server-arkade-v4 derives the same bounds from its configured card
// (`receiveLimitsFromCards`); these mirror the current 500..100000 sat card.
//
// Enforcing them in the wallet turns a useless "HTTP 400" from the payer's
// wallet into a bound the user can see BEFORE they hand out an invoice.
// The live limits follow the solver's card (lightningLimitsStore); these
// constants are their fallback.
import { ARKADE_RECEIVE_MAX_SATS, ARKADE_RECEIVE_MIN_SATS } from "../../../config/constants";
import { getArkadeLightningLimits } from "./lightningLimitsStore";

export { ARKADE_RECEIVE_MAX_SATS, ARKADE_RECEIVE_MIN_SATS };

export type ReceiveAmountProblem = "below_min" | "above_max" | null;

/** Why this amount cannot be invoiced, or null when it can. */
export function checkReceiveAmountSats(sats: number): ReceiveAmountProblem {
  if (Number.isNaN(sats)) return "below_min";
  if (!Number.isFinite(sats)) return sats > 0 ? "above_max" : "below_min";
  if (sats <= 0) return "below_min";
  const whole = Math.trunc(sats);
  const { minSats, maxSats } = getArkadeLightningLimits().receive;
  if (whole < minSats) return "below_min";
  if (whole > maxSats) return "above_max";
  return null;
}

export function isReceivableAmountSats(sats: number): boolean {
  return checkReceiveAmountSats(sats) === null;
}

/**
 * Thrown when an amount cannot be invoiced, so a caller can tell this apart
 * from a network or solver failure and show the bound rather than "try again".
 */
export class ArkadeReceiveAmountError extends Error {
  readonly problem: Exclude<ReceiveAmountProblem, null>;
  readonly amountSats: number;
  readonly minSats: number;
  readonly maxSats: number;

  constructor(problem: Exclude<ReceiveAmountProblem, null>, amountSats: number) {
    const { minSats, maxSats } = getArkadeLightningLimits().receive;
    super(
      problem === "below_min"
        ? `amount_sats ${amountSats} is below the corridor minimum of ${minSats}`
        : `amount_sats ${amountSats} is above the corridor maximum of ${maxSats}`,
    );
    this.minSats = minSats;
    this.maxSats = maxSats;
    this.name = "ArkadeReceiveAmountError";
    this.problem = problem;
    this.amountSats = amountSats;
  }
}
