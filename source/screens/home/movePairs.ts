// Which ends of a move may be paired, answered once for both pickers.
//
// Almost every pair is answered by pricing it, so this names only the source
// whose exits are FIXED: the card pays out to the wallet holding its settlement
// currency (the user's main currency) and nowhere else. There is no card to
// bitcoin route, and a withdrawal cannot cross currencies.
//
// Every SOURCE may always be picked: the destination follows it, staying where
// it is when the new pair is open and moving to the source's own default when
// it is not, so the sheet never holds a pair that cannot run, and the change
// is on screen before Next. A DESTINATION the source cannot reach is shown
// unavailable and never picked (#1467).
import type { FiatCode } from "../../lib/tokens";
import { cardSettleWalletRail } from "./moveBookkeeping";

/** The card on the Move sheet. */
export const CARD_RAIL = "visa";

/** Where a source may send; null = not fixed, pricing answers it. */
export const moveDestinationsFor = (
  fromKey: string | null,
  settleCurrency: FiatCode,
): string[] | null => {
  if (fromKey === CARD_RAIL) return [cardSettleWalletRail(settleCurrency)];
  return null;
};

type DestinationsFor = ((fromKey: string) => string[] | null) | undefined;

/** Whether `from → to` is a pair the Move sheet may hold. */
export const moveRailPairOpen = (
  destinationsFor: DestinationsFor,
  fromKey: string,
  toKey: string,
): boolean => {
  const exits = destinationsFor?.(fromKey) ?? null;
  return exits === null || exits.includes(toKey);
};

/**
 * Whether picking `key` for `side` is allowed against the end already chosen.
 * Any source is; a destination only when the chosen source can reach it.
 */
export const moveRailPickOpen = (
  destinationsFor: DestinationsFor,
  pair: { fromKey: string | null; toKey: string | null },
  side: "from" | "to",
  key: string,
): boolean => {
  if (side === "from" || !pair.fromKey) return true;
  return moveRailPairOpen(destinationsFor, pair.fromKey, key);
};

/**
 * The pair after the user picks `key` as the source: the destination stays if
 * the new pair is open, else becomes the source's first fixed exit. Picking the
 * current destination as the source swaps the ends.
 */
export const moveSourcePick = (
  destinationsFor: DestinationsFor,
  pair: { fromKey: string | null; toKey: string | null },
  key: string,
): { fromKey: string; toKey: string | null } => {
  const kept = pair.toKey === key ? pair.fromKey : pair.toKey;
  if (kept && kept !== key && moveRailPairOpen(destinationsFor, key, kept)) {
    return { fromKey: key, toKey: kept };
  }
  const exits = destinationsFor?.(key) ?? null;
  return { fromKey: key, toKey: exits?.[0] ?? null };
};
