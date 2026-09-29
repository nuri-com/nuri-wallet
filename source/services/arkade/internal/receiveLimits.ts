// What the Lightning receive corridor will actually quote.
//
// These are not our policy — they are the beta solver's, discovered by probing
// the live callback. Below the floor it answers `amount_out_of_range`; above
// the ceiling it adds its fee ON TOP of the card's max and the quote fails.
//
// The card advertises 500..50000, but neither bound is usable in practice:
//   - 501 sats is refused, 502 mints. The exact edge drifts with the solver's
//     own costs, so the floor here keeps a small margin above it.
//   - 50000 always fails, because the fee is added on top of the cap. The
//     highest amount observed to mint is 49830.
//
// Enforcing them in the wallet turns a useless "HTTP 400" from the payer's
// wallet into a bound the user can see BEFORE they hand out an invoice.
export const ARKADE_RECEIVE_MIN_SATS = 505;
export const ARKADE_RECEIVE_MAX_SATS = 49_830;

export type ReceiveAmountProblem = "below_min" | "above_max" | null;

/** Why this amount cannot be invoiced, or null when it can. */
export function checkReceiveAmountSats(sats: number): ReceiveAmountProblem {
  if (Number.isNaN(sats)) return "below_min";
  if (!Number.isFinite(sats)) return sats > 0 ? "above_max" : "below_min";
  if (sats <= 0) return "below_min";
  const whole = Math.trunc(sats);
  if (whole < ARKADE_RECEIVE_MIN_SATS) return "below_min";
  if (whole > ARKADE_RECEIVE_MAX_SATS) return "above_max";
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
  readonly minSats = ARKADE_RECEIVE_MIN_SATS;
  readonly maxSats = ARKADE_RECEIVE_MAX_SATS;

  constructor(problem: Exclude<ReceiveAmountProblem, null>, amountSats: number) {
    super(
      problem === "below_min"
        ? `amount_sats ${amountSats} is below the corridor minimum of ${ARKADE_RECEIVE_MIN_SATS}`
        : `amount_sats ${amountSats} is above the corridor maximum of ${ARKADE_RECEIVE_MAX_SATS}`,
    );
    this.name = "ArkadeReceiveAmountError";
    this.problem = problem;
    this.amountSats = amountSats;
  }
}
