// How one in-flight record reads on one screen. Every screen that shows
// pending rows (the home rails and each history list) gets its rows from
// MoneyInFlightStore through this, so a move looks the same wherever it shows.
import type { PendingWalletTransfer } from "../../types/wallet";
import type { MoneyInFlight, MoneyLeg, MoneyRail } from "./MoneyInFlightStore";
import { inFlightForRail } from "./MoneyInFlightStore";

/** The `screen.HomeScreen.pending*` key a row's label comes from. */
export type InFlightLabel =
  | "pendingSending"
  | "pendingReceiving"
  | "pendingToCard"
  | "pendingToWallet"
  | "pendingFromBitcoin"
  | "pendingBuyingBitcoin";

export type InFlightRow = {
  key: string;
  record: MoneyInFlight;
  leg: MoneyLeg;
  direction: "out" | "in";
  label: InFlightLabel;
};

const isBtc = (rail: MoneyRail | undefined) => rail === "arkade" || rail === "onchain";
const isCard = (rail: MoneyRail | undefined) => rail === "visa" || rail === "visaUsd";

export function inFlightLabel(record: MoneyInFlight, direction: "out" | "in"): InFlightLabel {
  if (record.kind === "purchase") return "pendingBuyingBitcoin";
  if (direction === "out") {
    if (isCard(record.to?.rail)) return "pendingToCard";
    if (isCard(record.from?.rail) && record.to) return "pendingToWallet";
    return "pendingSending";
  }
  if (isBtc(record.from?.rail) && !isBtc(record.to?.rail)) return "pendingFromBitcoin";
  return "pendingReceiving";
}

/** The rows `rails` draws, newest first. */
export function inFlightRowsFor(
  records: readonly MoneyInFlight[],
  rails: readonly MoneyRail[],
): InFlightRow[] {
  const rows: InFlightRow[] = [];
  for (const rail of rails) {
    for (const { record, leg, direction } of inFlightForRail(records, rail)) {
      rows.push({
        key: `inflight-${record.id}-${direction}-${rail}`,
        record,
        leg,
        direction,
        label: inFlightLabel(record, direction),
      });
    }
  }
  return rows.sort((a, b) => Date.parse(b.record.createdAt) - Date.parse(a.record.createdAt));
}

/**
 * The euro or dollar history's pending entries, in the row shape that list
 * already renders. Same records as every other screen.
 */
export function inFlightAsWalletTransfers(
  records: readonly MoneyInFlight[],
  rail: "wallet" | "dollar",
): PendingWalletTransfer[] {
  return inFlightRowsFor(records, [rail]).map((row) => {
    const isOrder = row.record.kind === "swap";
    return {
      amount: row.leg.amount,
      createdAt: row.record.createdAt,
      txHash: isOrder ? null : row.record.id,
      orderId: isOrder ? row.record.id : null,
      kind: row.record.kind === "card_topup" ? "card_topup" : "wallet_transfer",
      direction: row.direction,
      fiat: rail === "dollar" ? "USD" : "EUR",
      // Incoming rows render with the arriving framing; outgoing swaps with the
      // swap one; everything else as a transfer.
      source: row.direction === "in" ? "swapkit_topup" : isOrder ? "swapkit" : "base-mainnet",
    };
  });
}
