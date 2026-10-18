// lib/wirex/cardAutoSwap.ts
// The card settles in the user's home currency. Money that arrives in the other
// currency is swapped into it (Wirex FX). Wirex prices a swap to the cent and
// refuses one under 10 of the paying currency (its estimate answers
// `min_amount: 10`), so a swap takes the balance cut down to whole cents, from
// 10 up. Less than that is offered back as found money and withdrawn to the
// wallet instead.

const SWAP_MINIMUM_CENTS = 1000;

function wholeCents(held: number | null | undefined): number {
  if (typeof held !== "number" || !Number.isFinite(held) || held <= 0) return 0;
  // Rounded to 4 places first so a float such as 12.3 * 100 = 1229.9999 keeps its cent.
  return Math.floor(Math.round(held * 1e6) / 1e4);
}

export function autoSwapAmount(held: number | null | undefined): string | null {
  const cents = wholeCents(held);
  return cents >= SWAP_MINIMUM_CENTS ? (cents / 100).toFixed(2) : null;
}

/** The balance to offer as found money: at least a cent, under the swap minimum. */
export function foundMoneyAmount(held: number | null | undefined): number | null {
  const cents = wholeCents(held);
  return cents >= 1 && cents < SWAP_MINIMUM_CENTS ? (held as number) : null;
}

export type CardSwapStep = "wait" | "reset" | "start" | "idle";

/**
 * What the card's latest other-currency reading calls for. Nothing while a
 * swap runs (one at a time); the caller asks again when it ends, so a reading
 * that arrived meanwhile is not lost. A zero reading means the money left: the
 * same amount arriving later is new money. A reading already swapped (or maybe
 * swapped, when unconfirmed) never starts a second swap.
 */
export function cardSwapStep(s: {
  running: boolean;
  reading: number | null | undefined;
  key: string;
  taken: string | null;
}): CardSwapStep {
  if (s.running) return "wait";
  if (s.reading === 0) return "reset";
  if (!autoSwapAmount(s.reading) || s.taken === s.key) return "idle";
  return "start";
}
