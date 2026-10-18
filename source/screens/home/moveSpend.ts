// What a move actually spends, which is not always what was typed.
//
// A priced move states its own cost: the quote's `sendAmount` is the figure
// that has to fit, fees included. An UNPRICED move normally spends exactly the
// typed amount, because the two rails are one asset and the transfer is plain.
//
// arkade → on-chain is the exception, and it is unpriced. Above the corridor
// floor it runs over bitcoinvn: the provider charges its spread on top of what
// the recipient gets, and paying that invoice funds an Arkade Intents lockup
// which charges again. Gating on the typed amount let a Max move pass the
// sheet and fail after the user had confirmed. Below the floor the corridor
// does not serve the move at all, and `moveTransferBounds` refuses it there.
//
// The send screen reserves the same headroom for a Bitcoin-address recipient.
// Both entry points have to agree, or one accepts an amount the other refuses.
//
// The three constants are duplicated rather than imported: their modules pull
// in the Arkade SDK and React Native sources, which cannot be loaded in a unit
// test. `moveSpend.contract.test.ts` imports the real ones and asserts these
// still match, so the copies cannot drift unnoticed.

import { ARKADE_LIGHTNING_MAX_SEND_SATS } from "../../config/constants";
import type { SwapAmountBounds } from "../../services/swapkit/SwapAmountBounds";

/** Mirror of LIGHTNING_TO_BITCOIN_MIN_SATS. */
export const MOVE_CORRIDOR_MIN_SATS = 6_550;
/** Mirror of LIGHTNING_TO_BITCOIN_SPREAD_MULTIPLIER. */
export const MOVE_CORRIDOR_SPREAD_MULTIPLIER = 1.025;
/** Mirror of the Arkade Intents fee: 30 bps, minimum 5 sats. */
const INTENTS_FEE_BPS = 30;
const INTENTS_FEE_MIN_SATS = 5;

function withIntentsFee(sats: number): number {
  return sats + Math.max(INTENTS_FEE_MIN_SATS, Math.ceil((sats * INTENTS_FEE_BPS) / 10_000));
}

export type MoveSpendInput = {
  /** Sats the user typed, expressed on the source side. */
  sourceAmount: number;
  /** The accepted quote's spend, when this move has a price. */
  quotedSendAmount?: number | null;
  /** Rail keys, so only the corridor pair reserves corridor headroom. */
  fromKey?: string | null;
  toKey?: string | null;
};

/**
 * What a move typed on the SOURCE side actually takes out of it. The keypad
 * holds at most the rail's own precision (cents, or whole sats) and the source
 * states its balance rounded to it, so a balance of 0.995018 reads "1.00" and
 * the user types 1. That figure IS "all of it": the move then takes the exact
 * balance, every decimal, instead of refusing 1 > 0.995018 or leaving dust.
 * Any other figure is taken as typed.
 */
export function moveSourceAmount(input: {
  typed: number;
  available?: number | null;
  whole: boolean;
}): number {
  const { typed, available, whole } = input;
  if (!(typed > 0) || available == null || !(available > 0)) return typed;
  const scale = whole ? 1 : 100;
  return Math.round(typed * scale) === Math.round(available * scale) ? available : typed;
}

/**
 * The bounds of a move that has no quote to state them. arkade -> onchain is
 * always paid over the Lightning corridor: the typed sats become the Lightning
 * invoice, so the corridor's floor and the Arkade Lightning ceiling both bind
 * it. Without them a figure outside that band passed the sheet and failed only
 * after the order was committed. Any other unpriced pair states no band.
 */
export function moveTransferBounds(
  fromKey?: string | null,
  toKey?: string | null,
): SwapAmountBounds | null {
  if (fromKey !== "arkade" || toKey !== "onchain") return null;
  return { min: MOVE_CORRIDOR_MIN_SATS, max: ARKADE_LIGHTNING_MAX_SEND_SATS };
}

/**
 * The figure the source balance has to cover.
 */
export function moveSpendAmount(input: MoveSpendInput): number {
  const typed = Number(input.sourceAmount) || 0;
  const quoted = Number(input.quotedSendAmount);
  // A price on the table always wins: it is the real cost, already grossed.
  if (Number.isFinite(quoted) && quoted > 0) return quoted;
  if (input.fromKey !== "arkade" || input.toKey !== "onchain") return typed;
  // Below the floor the corridor is not offered, so no corridor fee applies.
  if (typed < MOVE_CORRIDOR_MIN_SATS) return typed;
  return withIntentsFee(Math.ceil(typed * MOVE_CORRIDOR_SPREAD_MULTIPLIER));
}
