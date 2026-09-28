import { describe, expect, it, vi } from "vitest";
import {
  applyWalletPendingOptimism,
  normalizePendingWalletTransferRow,
  reconcileTopupMirrorRows,
} from "./walletPendingOptimism";

const deps = () => ({
  optimisticHoldUntilRef: { current: 0 },
  applyOptimisticBalanceDebit: vi.fn(() => 1),
  now: 1_000_000,
});

describe("applyWalletPendingOptimism", () => {
  it("arms the outgoing hold and debits for a normal wallet transfer", () => {
    const d = deps();
    applyWalletPendingOptimism("wallet", 12, d);
    expect(d.applyOptimisticBalanceDebit).toHaveBeenCalledWith(12);
    // The handle travels back to the caller, which parks it against the tx so a
    // reverted receipt can drop THIS debit and not some later one.
    expect(applyWalletPendingOptimism("wallet", 12, deps())).toBe(1);
    expect(d.optimisticHoldUntilRef.current).toBe(1_000_000 + 10_000);
  });

  it("does NOT arm the hold or debit for an incoming BTC→EUR topup", () => {
    const d = deps();
    applyWalletPendingOptimism("swapkit_topup", 12, d);
    // Debiting would shrink the balance, and the hold would block the balance
    // from rising when the EURC actually lands.
    expect(d.applyOptimisticBalanceDebit).not.toHaveBeenCalled();
    expect(d.optimisticHoldUntilRef.current).toBe(0);
  });

  it("never lowers an already-later hold", () => {
    const d = deps();
    d.optimisticHoldUntilRef.current = 9_999_999;
    applyWalletPendingOptimism("wallet", 5, d);
    expect(d.optimisticHoldUntilRef.current).toBe(9_999_999);
  });
});

describe("reconcileTopupMirrorRows", () => {
  const rows = [
    { source: "swapkit_topup", orderId: "sk_live" },
    { source: "swapkit_topup", orderId: "sk_orphan" },
    { source: "swapkit", orderId: "eur_to_btc" }, // EUR→BTC, not a topup mirror
    { source: null, orderId: "plain" },
    { source: "swapkit_topup", orderId: null }, // unreconcilable — kept
  ];

  it("drops only topup mirror rows whose durable Bitcoin counterpart is gone", () => {
    const kept = reconcileTopupMirrorRows(rows, new Set(["sk_live"]));
    expect(kept.map((r) => r.orderId)).toEqual(["sk_live", "eur_to_btc", "plain", null]);
  });

  it("keeps every row when all counterparts are still live", () => {
    const kept = reconcileTopupMirrorRows(rows, new Set(["sk_live", "sk_orphan"]));
    expect(kept).toHaveLength(rows.length);
  });
});

describe("normalizePendingWalletTransferRow", () => {
  // The real chain: StableToBtcSwapService emits a pending row for an accepted
  // order, the hook stores it, and on a later launch this normalizer rewrites
  // the cache the resume then reads. Anything it drops is gone for good.
  const emitted = {
    amount: 21.213563, // what actually left, already inside the 5% drift
    maxSellEurc: 21, // the quote — the only value a resume may bound with
    txHash: "0xDEADBEEF",
    orderId: "sk_funded",
    depositAddress: "0x1111111111111111111111111111111111111111",
    kind: "wallet_transfer" as const,
    source: "swapkit",
    createdAt: "2026-08-05T12:00:00.000Z",
  };

  it("carries the quote ceiling through a cache rewrite", () => {
    const once = normalizePendingWalletTransferRow(emitted);
    expect(once.maxSellEurc).toBe(21);
    // Second launch: the stored row goes through the same rewrite again.
    expect(normalizePendingWalletTransferRow(once).maxSellEurc).toBe(21);
    expect(normalizePendingWalletTransferRow(once).amount).toBe(21.213563);
  });

  it("reports no ceiling for a row written before the field existed", () => {
    const { maxSellEurc, ...legacy } = emitted;
    void maxSellEurc;
    expect(normalizePendingWalletTransferRow(legacy).maxSellEurc).toBeNull();
  });

  it("refuses a nonsensical ceiling instead of signing with it", () => {
    for (const bad of [0, -1, Number.NaN, "soon" as unknown as number]) {
      expect(normalizePendingWalletTransferRow({ ...emitted, maxSellEurc: bad }).maxSellEurc).toBe(
        null,
      );
    }
  });
});
