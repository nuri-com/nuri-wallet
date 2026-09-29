// The fee estimate for an Arkade -> Lightning send (Arkade Intents). The quote
// and the exact lockup amount come from SwapKit v2.
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
