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
// The spread and fee constants are duplicated rather than imported: their
// modules pull in the Arkade SDK and React Native sources, which cannot be
// loaded in a unit test. `moveSpend.contract.test.ts` imports the real ones and
// asserts these still match, so the copies cannot drift unnoticed. The floor is
// read live from its dependency-free store, because it moves with the BTC price.

import { maxAmountForSpend } from "../../lib/bitcoin/maxAmountForSpend";
import { getArkadeLightningLimits } from "../../services/arkade/internal/lightningLimitsStore";
import { getLightningToBitcoinMinSats } from "../../services/swapkit/LightningToBitcoinLimits";
import type { SwapAmountBounds } from "../../services/swapkit/SwapAmountBounds";

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
  /** The corridor floor in sats; the live store's figure when omitted. */
  corridorMinSats?: number;
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
  lightningMaxSats: number = getArkadeLightningLimits().send.maxSats,
  corridorMinSats: number = getLightningToBitcoinMinSats(),
): SwapAmountBounds | null {
  if (fromKey !== "arkade" || toKey !== "onchain") return null;
  return { min: corridorMinSats, max: lightningMaxSats };
}

/**
 * Whether the Move sheet must state the on-chain source net of the miner fee.
 * Every move out of the MuSig2 on-chain wallet is a PSBT that pays the deposit
 * (or the boarding output) AND the miner fee on top, whatever the destination:
 * arkade, the card, a stablecoin. Stating the raw balance as available let Max
 * (or any amount near it) pass the sheet and fail at the PSBT build with
 * "insufficient funds for fee" (#1341). The shared builder stays the authority;
 * this only keeps the sheet from offering an amount it cannot fund.
 */
export function moveReservesOnchainFee(fromKey?: string | null, toKey?: string | null): boolean {
  return fromKey === "onchain" && toKey != null && toKey !== "onchain";
}

/**
 * Whether the Move sheet must state the Arkade source less the node's VTXO
 * floor. Every move out of Arkade is an offchain send (the swap's deposit, or
 * the corridor's lockup) whose change has to stay at or above that floor, so
 * the whole balance minus less than the floor cannot go out. Stating the raw
 * balance let a move pass the sheet and be refused with "Max N available"
 * after the order was open (#1709). Same figure the send screen states.
 */
export function moveReservesArkadeChange(fromKey?: string | null, toKey?: string | null): boolean {
  return fromKey === "arkade" && toKey != null && toKey !== "arkade";
}

/**
 * Read the Ark node's VTXO floor for one opening of a move out of Arkade.
 * Every opening and route starts from unknown (`null`, which states the raw
 * balance): a floor read on an earlier opening is not proof of the current one,
 * and keeping it after a failed read made it a hard cap nothing re-checked.
 * An unreadable floor stays unknown, and an answer for a closed or changed
 * opening is dropped. Returns the effect cleanup.
 */
export function startMoveArkFloorRead(input: {
  active: boolean;
  read: () => Promise<number | null>;
  set: (floor: number | null) => void;
}): () => void {
  input.set(null);
  if (!input.active) return () => {};
  let cancelled = false;
  void input
    .read()
    .then((floor) => {
      if (!cancelled) input.set(floor);
    })
    .catch(() => {});
  return () => {
    cancelled = true;
  };
}

/**
 * The largest amount the source can be TYPED for, given what it may spend.
 * arkade -> on-chain spends the corridor's spread plus the lockup fee on top
 * of the typed figure, so the most that can be typed is below the balance;
 * every other move spends what was typed (or what its quote states).
 */
export function moveSourceCeiling(input: {
  available: number | null | undefined;
  fromKey?: string | null;
  toKey?: string | null;
}): number | null {
  const { available, fromKey, toKey } = input;
  if (available == null) return null;
  if (fromKey !== "arkade" || toKey !== "onchain") return available;
  return maxAmountForSpend(available, (sats) =>
    withIntentsFee(Math.ceil(sats * MOVE_CORRIDOR_SPREAD_MULTIPLIER)),
  );
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
  if (typed < (input.corridorMinSats ?? getLightningToBitcoinMinSats())) return typed;
  return withIntentsFee(Math.ceil(typed * MOVE_CORRIDOR_SPREAD_MULTIPLIER));
}
