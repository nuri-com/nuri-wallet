// The euro/dollar (Base EOA) history as a list of rows: what the history sheet
// draws and what every export of it writes. Pure — no platform imports.
import type { PendingWalletTransfer, WalletTransactionRow } from "../../../types/wallet";

export const getOrderState = (o: WalletTransactionRow | null | undefined): string =>
  String(o?.state || "")
    .trim()
    .toLowerCase();

export const getOrderDateIso = (o: WalletTransactionRow | null | undefined): string | null => {
  const raw = o?.meta?.placedAt || "";
  // Trim fractional seconds to max 3 digits to avoid Invalid Date in some environments.
  const fixed = typeof raw === "string" ? raw.replace(/\.(\d{3})\d+Z$/, ".$1Z") : "";
  return fixed || raw || null;
};

// Best single tx hash for the explorer link / CSV export.
export const pickOrderTxHash = (o: WalletTransactionRow | null | undefined): string | null => {
  const metaHash = String(o?.meta?.txHash || "").trim();
  if (metaHash) return metaHash;
  const metaHashes = Array.isArray(o?.meta?.txHashes) ? o.meta.txHashes : [];
  for (const h of metaHashes) {
    const trimmed = String(h || "").trim();
    if (trimmed) return trimmed;
  }
  const txs = o?.transactions ?? [];
  for (const tx of txs) {
    const trimmed = String(tx?.hash || "").trim();
    if (trimmed) return trimmed;
  }
  return null;
};

const collectKnownTxHashes = (
  orders: ReadonlyArray<WalletTransactionRow> | null | undefined,
): Set<string> => {
  const out = new Set<string>();
  for (const o of orders || []) {
    const metaHash = String(o?.meta?.txHash || "")
      .trim()
      .toLowerCase();
    if (metaHash) out.add(metaHash);
    const metaHashes = Array.isArray(o?.meta?.txHashes) ? o.meta.txHashes : [];
    for (const h of metaHashes) {
      const trimmed = String(h || "")
        .trim()
        .toLowerCase();
      if (trimmed) out.add(trimmed);
    }
    const txs = o?.transactions ?? [];
    for (const tx of txs) {
      const txHash = String(tx?.hash || "")
        .trim()
        .toLowerCase();
      if (txHash) out.add(txHash);
    }
  }
  return out;
};

const collectKnownOrderIds = (
  orders: ReadonlyArray<WalletTransactionRow> | null | undefined,
): Set<string> => {
  const out = new Set<string>();
  for (const o of orders || []) {
    const id = String(o?.id || o?.meta?.orderId || "")
      .trim()
      .toLowerCase();
    if (id) out.add(id);
  }
  return out;
};

// One address holds euro and dollar, so a pending row belongs to whichever
// history is showing ITS token. A row that names no asset predates the dollar
// rail and is euro by construction.
const pendingRowFiat = (entry: { fiat?: "EUR" | "USD" }): string =>
  entry.fiat === "USD" ? "USD" : "EUR";

/**
 * The rows the history is made of: the one aggregate "pending balance" entry,
 * then every local pending transfer the server has not echoed back yet, then
 * the settled orders. The screen and every CSV export read the SAME list —
 * building it twice had the export classifying a sweep as a plain transfer.
 */
export const buildWalletTransactionRows = (
  orders: readonly WalletTransactionRow[] | null | undefined,
  pendingTransfers: readonly PendingWalletTransfer[] | null | undefined,
  pendingWalletFiat: number,
): WalletTransactionRow[] => {
  const settled = [...(orders ?? [])];
  const pendingEffective = Math.max(0, Number.isFinite(pendingWalletFiat) ? pendingWalletFiat : 0);
  const pendingOrder: WalletTransactionRow | null =
    pendingEffective > 0
      ? {
          id: "pending_balance",
          kind: "pending_balance",
          state: "pending",
          amount: String(pendingEffective),
          counterpart: { identifier: {} },
          meta: { placedAt: new Date().toISOString() },
        }
      : null;
  const knownTxHashes = collectKnownTxHashes(settled);
  const knownOrderIds = collectKnownOrderIds(settled);
  const pendingLocal = (pendingTransfers ?? [])
    .filter((entry) => {
      const tx = (entry.txHash || "").toString().trim().toLowerCase();
      const order = (entry.orderId || "").toString().trim().toLowerCase();
      if (tx && knownTxHashes.has(tx)) return false;
      if (order && knownOrderIds.has(order)) return false;
      return true;
    })
    .map(
      (entry, index): WalletTransactionRow => ({
        id: entry.txHash
          ? `pending:${entry.txHash}`
          : entry.orderId
            ? `pending:order:${entry.orderId}`
            : `pending:local:${index}`,
        kind:
          entry.kind === "card_topup"
            ? "card_topup_pending"
            : entry.kind === "bank_transfer"
              ? "bank_transfer_pending"
              : entry.source === "swapkit" ||
                  entry.source === "swapkit_topup" ||
                  entry.source === "swapkit_sweep"
                ? "swapkit_swap_pending"
                : "wallet_transfer_pending",
        state: "pending",
        amount: String(entry.amount),
        // Without this the shared formatter resolves an absent currency to
        // EUR, so a pending dollar transfer reads — and exports — as euros.
        currency: pendingRowFiat(entry),
        counterpart: { identifier: {} },
        meta: {
          placedAt: entry.createdAt,
          txHash: entry.txHash ?? null,
          orderId: entry.orderId ?? null,
          source: entry.source ?? null,
        },
      }),
    );
  return pendingOrder ? [pendingOrder, ...pendingLocal, ...settled] : [...pendingLocal, ...settled];
};

/** How one history row reads: its normalized kind and which way money moved. */
export type WalletRowClass = {
  kind: string;
  isPendingBalance: boolean;
  isPendingLocal: boolean;
  /** A BTC→EUR topup or a sweep: euros arriving through the swap machinery. */
  isTopup: boolean;
  isIncoming: boolean;
};

/** The one classification the sheet and the exports share. */
export function classifyWalletRow(o: WalletTransactionRow | null | undefined): WalletRowClass {
  const rawKind: string = String(o?.kind || "").toLowerCase();
  const kind = rawKind === "card_topup_swap" ? "wallet_transfer_in" : rawKind;
  const isPendingBalance = kind === "pending_balance";
  const isPendingLocal =
    kind === "wallet_transfer_pending" ||
    kind === "card_topup_pending" ||
    kind === "bank_transfer_pending" ||
    kind === "swapkit_swap_pending";
  const isTopup =
    kind === "swapkit_swap_pending" &&
    (o?.meta?.source === "swapkit_topup" || o?.meta?.source === "swapkit_sweep");
  const isIncoming =
    isPendingBalance ||
    kind === "issue" ||
    kind === "card_topup" ||
    kind === "wallet_transfer_in" ||
    isTopup;
  return { kind, isPendingBalance, isPendingLocal, isTopup, isIncoming };
}
