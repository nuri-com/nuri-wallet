// One mapping from a durable BTC→EUR top-up (PendingPurchasesStore) to the row
// that represents it. Both ends of the same swap render it: the Bitcoin list as
// the SOURCE (sats leaving), the card or wallet list as the DESTINATION (euros
// arriving). Only the icon, the amount emphasis and the sign differ, so they
// share this rather than each keeping their own copy of the shape.
import type { ActivityItem } from "../components/ActivitySheet";
import type { PendingPurchase } from "../services/app/PendingPurchasesStore";
import { groupCount } from "./formatting";

export type PendingTopupSide = "source" | "destination";

export function pendingTopupRow(
  purchase: PendingPurchase,
  opts: {
    side: PendingTopupSide;
    fiatSymbol: string;
    /** Live leg status from the background tracker; falls back to "Pending". */
    statusText?: string | null;
    /** Omitted when there is nothing to open — the row is then inert. */
    onOpenDetail?: () => void;
  },
): ActivityItem {
  const fiat = `${opts.fiatSymbol} ${purchase.amountFiat.toFixed(2)}`;
  const sats = typeof purchase.amountSats === "number" ? groupCount(purchase.amountSats) : null;
  const isSource = opts.side === "source";
  return {
    key: `pending-${purchase.id ?? purchase.amountFiat}`,
    icon: isSource ? "arrow-up" : "plus",
    label: purchase.destination === "wallet" ? "Top up EUR" : "Top up card",
    sublabel: opts.statusText || "Pending",
    // The side that is losing money leads with the euro figure and shows the
    // sats going out; the side receiving it leads with what arrives.
    amount: fiat,
    amountSecondary: sats ? `${isSource ? "-" : "+"}BTC ${sats}` : "",
    ...(opts.onOpenDetail ? { onPress: opts.onOpenDetail } : {}),
    pending: true,
    createdAt: new Date().toISOString(),
  };
}
