// How the board reads a pending stablecoin transfer: which rail owns it, which
// way the money is going, and what the row is called.
//
// Direction is the part that cannot be guessed from the amount. A wallet send
// and a BTC→stable order's destination mirror arrive on the SAME event and the
// same store; rendering both as a debit told the user their euros (or dollars)
// were leaving while they were on their way in.
import type { PendingWalletTransfer } from "../../types/wallet";

/** The `screen.HomeScreen.pending*` key the row's label comes from. */
export type PendingTransferLabel = "fromBitcoin" | "receiving" | "toCard" | "sending";

export type PendingTransferView = {
  /** Which of the two stable rails states this row. */
  rail: "wallet" | "dollar";
  /** Money arriving rather than leaving — the row is a credit. */
  incoming: boolean;
  label: PendingTransferLabel;
};

// The two producers of INCOMING rows. A top-up mirrors a BTC→stable order on
// the rail the stable lands on; a sweep brings value in from another chain.
// Everything else is money the wallet is sending.
const INCOMING_SOURCES = new Set(["swapkit_topup", "swapkit_sweep"]);

export function pendingTransferView(
  row: Pick<PendingWalletTransfer, "fiat" | "kind" | "source" | "direction">,
): PendingTransferView {
  // A row with no currency is a euro one: it predates the field, and only the
  // euro rail could produce one then.
  const rail = row.fiat === "USD" ? "dollar" : "wallet";
  // An explicit direction wins — a stable→stable swap writes both an `out`
  // (source rail) and an `in` (destination rail) leg, and neither is inferable
  // from `source`. Older rows carry no direction and fall back to the
  // source-based rule that predates it.
  const incoming =
    row.direction != null ? row.direction === "in" : INCOMING_SOURCES.has(String(row.source ?? ""));
  if (incoming) {
    return {
      rail,
      incoming,
      label: row.source === "swapkit_topup" ? "fromBitcoin" : "receiving",
    };
  }
  return { rail, incoming, label: row.kind === "card_topup" ? "toCard" : "sending" };
}

/**
 * The orders whose destination side is already stated by a mirror row.
 *
 * A BTC→stable order writes two records — the durable purchase (the sats
 * leaving) and the mirror (the stable arriving) — under one id. Both would
 * otherwise draw the arriving money, once on the rail the mirror names and once
 * on the euro rail the purchase row assumes.
 */
export function mirroredOrderIds(rows: readonly PendingWalletTransfer[]): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (!pendingTransferView(row).incoming) continue;
    const id = String(row.orderId ?? "").trim();
    if (id) ids.add(id);
  }
  return ids;
}
