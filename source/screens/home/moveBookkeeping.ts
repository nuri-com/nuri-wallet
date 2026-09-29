// What a move owes the rails it touches: the credit the DESTINATION shows, and
// which SOURCE balance it is that the move actually spends.
//
// A swap debits its source through the service that spends it, but the arriving
// side has no such owner: the order is handed to a durable tracker and settles
// minutes later, so without a credit here the user watches money leave one rail
// and simply not appear on the other. The bitcoin rails carry their own hold,
// and the euro wallet is credited by the swap hook's event; what is left is the
// card, whose balance comes from Wirex and moves only when it is told to.
import type { FiatCode } from "../../lib/tokens";
import type { SwapExecution, SwapQuote } from "../../services/swapkit/SwapContract";
import { EURC_BASE_TOKEN, USDC_BASE_TOKEN } from "../../services/swapkit/SwapKitStableAssets";

const CARD_RAILS = new Set(["iban", "visa", "visaUsd"]);

/** The card rail that holds dollars; the other two are its euro faces. */
export const CARD_USD_RAIL = "visaUsd";

/**
 * Whether this move spends the ARKADE balance — the one the outgoing hold
 * anchors while the payment is in flight.
 *
 * The two bitcoin rails are ONE swap asset, so the assets alone cannot answer
 * it: a move off the legacy on-chain wallet used to arm the arkade anchor all
 * the same, which hid spendable arkade sats for the length of the hold while
 * the rail that actually paid stayed unchanged.
 */
export function spendsArkadeBalance(quote: Pick<SwapQuote, "engine" | "sendSource">): boolean {
  // Only the bitcoin-spending engine can debit it, and only when the quote was
  // taken on the arkade rail. An unstated source IS arkade — that is the
  // default the whole top-up path applies.
  return quote.engine === "btc-to-stable" && (quote.sendSource ?? "arkade") === "arkade";
}

/**
 * The wallet credit a finished bitcoin move shows before the tracker reports back, or null when the
 * wallet receives nothing. A card-bound quote settles on the card account, so it credits the card
 * (see cardCreditForMove) and never the wallet: crediting both would show spendable wallet money
 * that is not there.
 */
export function walletCreditForMove(
  quote: Pick<SwapQuote, "engine" | "destination" | "receiveAmount" | "to">,
): { amount: number; asset: string } | null {
  if (quote.engine !== "btc-to-stable") return null;
  if (quote.destination === "card") return null;
  if (!(quote.receiveAmount > 0)) return null;
  return { amount: quote.receiveAmount, asset: quote.to };
}

export type MoveCardCredit = {
  /** What to show on the card now, in `currency`. */
  amount: number;
  /** Which currency that figure is in — the card settles in either. */
  currency: FiatCode;
  /** The order that must later confirm or take that figure back. */
  orderId: string;
};

/**
 * The card credit a move that just executed earns, or null when there is none
 * to show.
 *
 * Null covers three cases, and the last is the important one: the destination
 * is not the card; the figure is unusable; or the execution came back WITHOUT
 * an order id — a swap that failed after paying, where the durable tracker owns
 * the outcome. A credit parked under no id could never be confirmed or reverted
 * by the settlement, so it would sit on the card as a figure nothing can
 * correct. The next balance read is the honest answer there.
 *
 * The executed order's own `quotedReceive` wins over the quote the list showed:
 * the route can be recreated at a slightly different price between accepting
 * and signing, and the card should state what was actually bought.
 */
export function cardCreditForMove(
  toRailKey: string | null | undefined,
  quote: Pick<SwapQuote, "receiveAmount">,
  execution: Pick<SwapExecution, "quotedReceive" | "orderId"> | null,
): MoveCardCredit | null {
  if (!toRailKey || !CARD_RAILS.has(toRailKey)) return null;
  const orderId = execution?.orderId?.trim();
  if (!orderId) return null;
  const amount = execution?.quotedReceive ?? quote.receiveAmount;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  // A swap settles the token the rail asked for, so the figure is in THAT
  // currency — the card's dollar pocket is credited in dollars, and converting
  // it is the caller's job because only it holds a rate.
  return { amount, currency: toRailKey === CARD_USD_RAIL ? "USD" : "EUR", orderId };
}

export type CardSwapTarget = {
  asset: string;
  settleAddress: string;
  settleKind: "card";
};

/**
 * What the card rail `toRailKey` offers a swap FROM `fromRailKey`, or null when
 * it offers nothing.
 *
 * The card can be priced like any other EVM destination — the stable it settles
 * in, sent to its deposit address — but only when the source holds the OTHER
 * stable, because that is the only pair with an exchange in it:
 *
 *   dollar → VISA Euro    USDC → EURC, settled on the card
 *   euro   → VISA Dollar  EURC → USDC, settled on the card
 *
 * The matching pairs (euro → VISA Euro, dollar → VISA Dollar) are the same token
 * on both ends, which is a transfer, and bitcoin → card keeps the dedicated
 * top-up service (durable order plus recovery). Both are handled by the caller.
 *
 * `depositAddress` arrives with the Wirex snapshot and is null until it loads,
 * so this must be recomputed from that address rather than read once — a Move
 * opened before Wirex answered would otherwise keep offering nothing for the
 * rest of its life.
 */
export function cardSwapTargetFor(
  fromRailKey: string | null | undefined,
  toRailKey: string | null | undefined,
  depositAddress: string | null | undefined,
): CardSwapTarget | null {
  if (!toRailKey || !CARD_RAILS.has(toRailKey)) return null;
  const wantsUsd = toRailKey === CARD_USD_RAIL;
  // A BITCOIN source prices the card like any other destination: it swaps into the pocket's own stable and
  // settles that on the card account. The wallet/dollar pair rule below is about the app's own stable
  // balances, where the pocket's currency is what decides which rail funds it; bitcoin has no such
  // constraint, it just buys the stable the pocket needs.
  const fromBtc = fromRailKey === "arkade" || fromRailKey === "onchain";
  if (!fromBtc && fromRailKey !== (wantsUsd ? "wallet" : "dollar")) return null;
  const address = depositAddress?.trim();
  if (!address) return null;
  return {
    asset: wantsUsd ? USDC_BASE_TOKEN.asset : EURC_BASE_TOKEN.asset,
    settleAddress: address,
    settleKind: "card",
  };
}

/** The stable a transfer into `toRailKey` sends — null when it is not a card rail. */
export function cardTransferToken(toRailKey: string | null | undefined) {
  if (!toRailKey || !CARD_RAILS.has(toRailKey)) return null;
  return toRailKey === CARD_USD_RAIL ? USDC_BASE_TOKEN : EURC_BASE_TOKEN;
}
