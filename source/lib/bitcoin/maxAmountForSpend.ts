/**
 * The largest amount that can be ENTERED when `budgetSats` may leave the wallet
 * and `spendFor(amount)` is what an entered amount actually takes out of it
 * (a corridor spread or a lockup fee on top). Stating the budget itself as
 * "available" offered a figure whose spend then exceeded it: typing the shown
 * balance was refused, or failed after confirmation (#1709).
 *
 * `spendFor` must not decrease as the amount grows and must never be below the
 * amount itself. Whole sats; an empty or unreadable budget is 0.
 */
export function maxAmountForSpend(budgetSats: number, spendFor: (sats: number) => number): number {
  const budget = Math.floor(Number(budgetSats));
  if (!Number.isFinite(budget) || budget <= 0) return 0;
  let low = 0;
  let high = budget;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (spendFor(mid) <= budget) low = mid;
    else high = mid - 1;
  }
  return low;
}
