// lib/wirex/cardAutoSwap.ts
// The card settles in the user's home currency. Money that arrives in the other
// currency is swapped into it (Wirex FX). Wirex prices a swap to the cent, so
// the amount is the balance cut down to whole cents; under a cent nothing runs.

export function autoSwapAmount(held: number | null | undefined): string | null {
  if (typeof held !== "number" || !Number.isFinite(held) || held <= 0) return null;
  // Rounded to 4 places first so a float such as 12.3 * 100 = 1229.9999 keeps its cent.
  const cents = Math.floor(Math.round(held * 1e6) / 1e4);
  return cents >= 1 ? (cents / 100).toFixed(2) : null;
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
