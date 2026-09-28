// What the store is allowed to WRITE to the balance cache.
//
// The two rows are separate rails, and an Arkade event only ever describes one
// of them. The regression this guards is a launch that opens with the onchain
// rail at zero because a receive event overwrote a figure it never read.
import { beforeEach, describe, expect, it, vi } from "vitest";

const setCachedBalance =
  vi.fn<
    (
      key: string,
      amount: number | null,
      currency?: string | null,
      address?: string | null,
    ) => Promise<void>
  >();
// biome-ignore lint/suspicious/noExplicitAny: the read is restated per test
const nextRead: { value: any } = { value: null };

vi.mock("../balance/BalanceCacheService", () => ({
  BALANCE_CACHE_KEYS: { bitcoin: "bitcoin", bitcoinOnchain: "bitcoinOnchain" },
  getCachedBalance: vi.fn(async () => null),
  setCachedBalance,
}));
vi.mock("../../lib/secureKeyStorage", () => ({
  getEthereumAddress: vi.fn(async () => "0xowner"),
}));
// The service reaches the Arkade SDK, which is native — the store's cache
// decision is the subject here, so the read itself is stubbed out.
vi.mock("./BitcoinBalanceService", async () => {
  const shape = await import("./balanceShape");
  return {
    EMPTY_BITCOIN_BALANCE: shape.EMPTY_BITCOIN_BALANCE,
    balanceFromArkadeSummary: shape.balanceFromArkadeSummary,
    getBitcoinBalance: vi.fn(async () => nextRead.value ?? shape.EMPTY_BITCOIN_BALANCE),
  };
});
vi.mock("./WalletService", () => ({
  walletService: { getAddressSnapshot: () => ({ currentAddress: null as string | null }) },
}));
vi.mock("./BlockchainService", () => ({ blockchainService: {} }));
vi.mock("../arkade/ArkadeWalletService", () => ({
  getArkadeWalletSummarySnapshot: (): null => null,
}));
vi.mock("../app/PendingPurchasesStore", () => ({
  PendingPurchasesStore: {
    getSnapshot: () => ({ purchases: [] as unknown[] }),
    subscribe: (): (() => void) => () => {},
  },
  isMercuryoPending: () => false,
}));

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("BitcoinBalanceStore cache writes", () => {
  beforeEach(() => {
    setCachedBalance.mockClear();
  });

  it("leaves the onchain row alone on an arkade-only receive update", async () => {
    const { bitcoinBalanceStore } = await import("./BitcoinBalanceStore");
    bitcoinBalanceStore.applyArkadeReceiveUpdate({ settledSats: 12_345 });
    await flush();
    const keys = setCachedBalance.mock.calls.map((call) => call[0]);
    expect(keys).toContain("bitcoin");
    // The event carried `onchain: 0` because it never asked the chain — writing
    // that row would erase a good balance the next launch opens with.
    expect(keys).not.toContain("bitcoinOnchain");
  });

  it("writes both rows after a read that reached the chain", async () => {
    const { bitcoinBalanceStore } = await import("./BitcoinBalanceStore");
    nextRead.value = {
      total: 25_000,
      byChannel: { onchain: 75_000, arkade: 25_000, lightning: 0 },
      detail: {
        onchain: { confirmed: 75_000, unconfirmed: 0, txCount: 1 },
        arkade: { boardingConfirmed: 0, boardingUnconfirmed: 0 },
      },
      onchainRead: "ok",
    };
    await bitcoinBalanceStore.refresh("manual");
    await flush();
    const written = new Map(setCachedBalance.mock.calls.map((call) => [call[0], call[1]]));
    expect(written.get("bitcoin")).toBe(25_000);
    expect(written.get("bitcoinOnchain")).toBe(75_000);
  });

  it("leaves the onchain row alone when the chain could not be reached", async () => {
    const { bitcoinBalanceStore } = await import("./BitcoinBalanceStore");
    nextRead.value = {
      total: 30_000,
      byChannel: { onchain: 0, arkade: 30_000, lightning: 0 },
      detail: {
        onchain: { confirmed: 0, unconfirmed: 0, txCount: 0 },
        arkade: { boardingConfirmed: 0, boardingUnconfirmed: 0 },
      },
      onchainRead: "failed",
    };
    await bitcoinBalanceStore.refresh("manual");
    await flush();
    const keys = setCachedBalance.mock.calls.map((call) => call[0]);
    expect(keys).toContain("bitcoin");
    expect(keys).not.toContain("bitcoinOnchain");
  });
});

// A fee-bearing rail learns what actually left only after it executes, so the
// caller arms the hold with the quote and re-arms with the real figure. Both
// describe the SAME send: measuring the second one from the already-deducted
// snapshot debited it twice, and a 10 000-sat quote funding 10 030 briefly read
// as 20 030 gone.
describe("re-arming an outgoing hold for the same send", () => {
  it("deducts from the pre-send baseline, not from the deducted figure", async () => {
    const { bitcoinBalanceStore } = await import("./BitcoinBalanceStore");
    nextRead.value = {
      total: 100_000,
      byChannel: { onchain: 0, arkade: 100_000, lightning: 0 },
      detail: {
        onchain: { confirmed: 0, unconfirmed: 0, txCount: 0 },
        arkade: { boardingConfirmed: 0, boardingUnconfirmed: 0 },
      },
      onchainRead: "ok",
    };
    await bitcoinBalanceStore.refresh("manual");
    await flush();

    bitcoinBalanceStore.holdArkadeOutgoingBalance("move_swap", 10_000);
    expect(bitcoinBalanceStore.getSnapshot().bitcoinBalance.total).toBe(90_000);

    // The route funded 30 sats more than it quoted.
    bitcoinBalanceStore.holdArkadeOutgoingBalance("move_swap", 10_030);

    expect(bitcoinBalanceStore.getSnapshot().bitcoinBalance.total).toBe(89_970);
  });
});
