// Announcing money in flight, in the words each producer already speaks.
//
// A producer knows its assets and its addresses, not the board's screens. These
// helpers do that translation once so no commit path has to reason about rails,
// and so every producer lands in the SAME store - which is the whole point of
// having one.
import {
  MoneyInFlightStore,
  type MoneyInFlight,
  type MoneyRail,
  type MoneyUnit,
} from "./MoneyInFlightStore";
import { assetRail, destinationRail, type OwnDestinations } from "./assetRails";

const unitForRail = (rail: MoneyRail): MoneyUnit =>
  rail === "onchain" || rail === "arkade"
    ? "sats"
    : rail === "dollar" || rail === "visaUsd"
      ? "USD"
      : "EUR";

/**
 * A v2 swap, named by its assets. Either end may be absent when it is not one
 * of this wallet's screens (a send to someone else's bitcoin address), and the
 * record is written whenever at least one end is ours.
 */
export async function startSwapInFlight(args: {
  orderId: string;
  from: string;
  to: string;
  /** Source amount in the source asset's display unit (sats for bitcoin). */
  sendAmount: number;
  /** Destination amount in the destination's display unit. */
  receiveAmount: number;
  settleTarget?: string | null;
  own: OwnDestinations;
  /** Which card pocket a card-settled swap credits. */
  cardPocket?: "EUR" | "USD" | null;
}): Promise<void> {
  const fromRail = assetRail(args.from);
  const toRail = destinationRail(args.to, args.settleTarget, args.own, args.cardPocket);
  await MoneyInFlightStore.start({
    id: args.orderId,
    from:
      fromRail && args.sendAmount > 0
        ? { rail: fromRail, amount: args.sendAmount, unit: unitForRail(fromRail) }
        : null,
    to:
      toRail && args.receiveAmount > 0
        ? { rail: toRail, amount: args.receiveAmount, unit: unitForRail(toRail) }
        : null,
    kind: "swap",
    createdAt: new Date().toISOString(),
  });
}

/**
 * Money leaving the app: a bitcoin or stablecoin send to an address that is not
 * ours. It debits the rail that paid and credits nothing - a destination row
 * here would state money arriving that is gone.
 */
export async function startSendInFlight(args: {
  id: string;
  rail: MoneyRail;
  amount: number;
  unit?: MoneyUnit;
  /** Set when the money lands on another of this wallet's rails (a bitcoin
   * rail-to-rail transfer); absent for a send to someone else. */
  toRail?: MoneyRail | null;
}): Promise<void> {
  if (!(args.amount > 0)) return;
  const unit = args.unit ?? unitForRail(args.rail);
  await MoneyInFlightStore.start({
    id: args.id,
    from: { rail: args.rail, amount: args.amount, unit },
    to: args.toRail ? { rail: args.toRail, amount: args.amount, unit } : null,
    kind: "send",
    createdAt: new Date().toISOString(),
  });
}

/** Money arriving from outside the app (a purchase): credits only. */
export async function startIncomingInFlight(args: {
  id: string;
  rail: MoneyRail;
  amount: number;
  unit?: MoneyUnit;
  kind?: MoneyInFlight["kind"];
}): Promise<void> {
  if (!(args.amount > 0)) return;
  await MoneyInFlightStore.start({
    id: args.id,
    from: null,
    to: { rail: args.rail, amount: args.amount, unit: args.unit ?? unitForRail(args.rail) },
    kind: args.kind ?? "purchase",
    createdAt: new Date().toISOString(),
  });
}

/** A card top-up: one wallet pays, one card pocket receives. */
export async function startCardTopUpInFlight(args: {
  id: string;
  amount: number;
  fiat: "EUR" | "USD";
}): Promise<void> {
  if (!(args.amount > 0)) return;
  const usd = args.fiat === "USD";
  await MoneyInFlightStore.start({
    id: args.id,
    from: { rail: usd ? "dollar" : "wallet", amount: args.amount, unit: args.fiat },
    to: { rail: usd ? "visaUsd" : "visa", amount: args.amount, unit: args.fiat },
    kind: "card_topup",
    createdAt: new Date().toISOString(),
  });
}

/** A card pocket paid out to the wallet holding the same currency. */
export async function startCardWithdrawInFlight(args: {
  id: string;
  amount: number;
  fiat: "EUR" | "USD";
}): Promise<void> {
  if (!(args.amount > 0)) return;
  const usd = args.fiat === "USD";
  await MoneyInFlightStore.start({
    id: args.id,
    from: { rail: usd ? "visaUsd" : "visa", amount: args.amount, unit: args.fiat },
    to: { rail: usd ? "dollar" : "wallet", amount: args.amount, unit: args.fiat },
    kind: "card_withdraw",
    createdAt: new Date().toISOString(),
  });
}

/** A SEPA transfer out of a card pocket to someone's bank account. */
export async function startSepaInFlight(args: {
  transferId: string;
  amount: number;
  fiat: "EUR" | "USD";
}): Promise<void> {
  if (!(args.amount > 0) || !args.transferId) return;
  const usd = args.fiat === "USD";
  await MoneyInFlightStore.start({
    id: args.transferId,
    from: { rail: usd ? "visaUsd" : "visa", amount: args.amount, unit: args.fiat },
    to: null,
    kind: "sepa",
    createdAt: new Date().toISOString(),
  });
}

/** The money landed, failed or was refunded. Retires both ends at once. */
export const finishInFlight = (id: string): Promise<void> => MoneyInFlightStore.finish(id);
