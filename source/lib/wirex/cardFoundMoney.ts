// lib/wirex/cardFoundMoney.ts
// The card settles in the user's home currency. Money that arrives in the other
// currency cannot be spent through it, so it is offered back as found money,
// whatever the amount, and withdrawn to the wallet holding that currency. Less
// than a cent is dust and is not offered.

function wholeCents(held: number | null | undefined): number {
  if (typeof held !== "number" || !Number.isFinite(held) || held <= 0) return 0;
  // Rounded to 4 places first so a float such as 12.3 * 100 = 1229.9999 keeps its cent.
  return Math.floor(Math.round(held * 1e6) / 1e4);
}

/** The balance to offer as found money: the whole balance, from a cent up. */
export function foundMoneyAmount(held: number | null | undefined): number | null {
  return wholeCents(held) >= 1 ? (held as number) : null;
}
