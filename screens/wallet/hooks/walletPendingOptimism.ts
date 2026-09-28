import type { PendingWalletTransfer } from "../../../types/wallet";
// Optimistic balance handling for a `wallet:pendingTransfer`. Only an OUTGOING
// EUR transfer arms the hold and debits the balance. A BTC→EUR topup
// (`swapkit_topup`) and an other-chain sweep (`swapkit_sweep`) are incoming
// euros (or land on the card): debiting would shrink the shown balance, and —
// critically — the hold makes the wallet balance REJECT any higher figure while
// active, which would suppress the increase when the EURC actually arrives. So
// neither arms either.
//
// Kept in its own import-free module so it is unit-testable without pulling the
// full (React-Native-heavy) useWalletPending hook into the test environment.
export function applyWalletPendingOptimism(
  source: string | null | undefined,
  amount: number,
  deps: {
    optimisticHoldUntilRef: { current: number };
    applyOptimisticBalanceDebit: (amount: number) => number | null;
    now: number;
  },
): number | null {
  if (source === "swapkit_topup" || source === "swapkit_sweep") return null;
  deps.optimisticHoldUntilRef.current = Math.max(
    deps.optimisticHoldUntilRef.current,
    deps.now + 10_000,
  );
  // The handle identifies THIS debit, so a reverted receipt can drop exactly it.
  return deps.applyOptimisticBalanceDebit(amount);
}

// A wallet-destination topup's `wallet:pendingTransfer` mirror row is cached in
// useWalletPending, but its authoritative counterpart is the Bitcoin row
// (PendingPurchasesStore, same orderId) which is durably removed on completion.
// The mirror's clear is a fire-and-forget cache write, so a crash mid-clear can
// leave it behind. On restore, drop any cached `swapkit_topup` row whose
// counterpart is gone — completion already removed the durable Bitcoin row.
// Rows without an orderId (unreconcilable) and all non-topup rows are kept.
export function reconcileTopupMirrorRows<
  T extends { source?: string | null; orderId?: string | null },
>(rows: T[], liveTopupOrderIds: Set<string>): T[] {
  return rows.filter((row) => {
    if (row.source !== "swapkit_topup") return true;
    const id = row.orderId != null ? String(row.orderId).trim() : "";
    if (!id) return true;
    return liveTopupOrderIds.has(id);
  });
}

/**
 * Normalize a cached/merged pending-transfer row back into a stored row.
 *
 * Every field a resume depends on has to be listed here: the hydrate path
 * rewrites the cache from this shape, so anything omitted is dropped on the
 * NEXT launch, not this one. `maxSellEurc` is the ceiling a cold resume signs
 * with — a row that loses it resumes unbounded.
 */
export function normalizePendingWalletTransferRow(
  row: Partial<PendingWalletTransfer> & { amount: number | string },
): PendingWalletTransfer {
  const cap = Number(row.maxSellEurc);
  return {
    amount: Number(row.amount),
    maxSellEurc: Number.isFinite(cap) && cap > 0 ? cap : null,
    createdAt: String(row.createdAt || new Date().toISOString()),
    txHash: row.txHash ? String(row.txHash) : null,
    orderId: row.orderId ? String(row.orderId) : null,
    depositAddress: row.depositAddress ? String(row.depositAddress) : null,
    paymentHash: row.paymentHash ? String(row.paymentHash).toLowerCase() : null,
    // Carried, or the rail a row belongs to is forgotten on the next launch and
    // every restored dollar row reappears on the euro side.
    fiat: row.fiat === "USD" ? "USD" : "EUR",
    kind:
      row.kind === "card_topup" || row.kind === "bank_transfer" || row.kind === "wallet_transfer"
        ? row.kind
        : "wallet_transfer",
    source: row.source ? String(row.source) : null,
  };
}
