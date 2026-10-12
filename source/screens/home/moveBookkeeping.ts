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

const CARD_RAILS = new Set(["iban", "visa"]);

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
  settleCurrency: FiatCode,
): MoveCardCredit | null {
  if (!toRailKey || !CARD_RAILS.has(toRailKey)) return null;
  const orderId = execution?.orderId?.trim();
  if (!orderId) return null;
  const amount = execution?.quotedReceive ?? quote.receiveAmount;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  // A swap into the card settles its settlement currency, so the figure is in
  // that currency; converting it is the caller's job because only it holds a rate.
  return { amount, currency: settleCurrency, orderId };
}

export type CardSwapTarget = {
  asset: string;
  settleAddress: string;
  settleKind: "card";
};

/** The stable the card settles in: the user's main currency. */
export function cardSettleToken(settleCurrency: FiatCode) {
  return settleCurrency === "USD" ? USDC_BASE_TOKEN : EURC_BASE_TOKEN;
}

/** The wallet rail holding the card's settlement currency. */
export function cardSettleWalletRail(settleCurrency: FiatCode): "wallet" | "dollar" {
  return settleCurrency === "USD" ? "dollar" : "wallet";
}

/**
 * What the card rail `toRailKey` offers a swap FROM `fromRailKey`, or null when
 * it offers nothing.
 *
 * The card settles in ONE currency, the user's main currency. Anything sent to
 * it that is not already that stable is a swap into it, settled on the card's
 * deposit address. The wallet holding that same stable is a plain transfer,
 * handled by the caller.
 *
 * `depositAddress` arrives with the Wirex snapshot and is null until it loads,
 * so this must be recomputed from that address rather than read once.
 */
export function cardSwapTargetFor(
  fromRailKey: string | null | undefined,
  toRailKey: string | null | undefined,
  depositAddress: string | null | undefined,
  settleCurrency: FiatCode,
): CardSwapTarget | null {
  if (!toRailKey || !CARD_RAILS.has(toRailKey)) return null;
  if (!fromRailKey || CARD_RAILS.has(fromRailKey)) return null;
  if (fromRailKey === cardSettleWalletRail(settleCurrency)) return null;
  const address = depositAddress?.trim();
  if (!address) return null;
  return {
    asset: cardSettleToken(settleCurrency).asset,
    settleAddress: address,
    settleKind: "card",
  };
}
