import { beforeEach, describe, expect, it, vi } from "vitest";

// A credit that crosses the bus into a balance its emitter does not own can only
// be taken back BY NAME: the receiving rail's live figure is unchanged (the money
// went somewhere else, or nowhere), and its optimistic anchor outranks a live
// read for up to three minutes — so a refresh cannot undo it. Both wallet
// balances have to honour the revocation, because a withdrawal can be requested
// in either currency and only the server says which one actually moved.
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Array<(payload: unknown) => void>>(),
  getEthereumAddress: vi.fn(),
  getCachedBalance: vi.fn(),
  setCachedBalance: vi.fn(),
  getBaseWalletEurcBalance: vi.fn(),
  getErc20Balance: vi.fn(),
}));

vi.mock("../events/AppEventBusService", () => ({
  EventBus: {
    emit: vi.fn(),
    on: (event: string, handler: (payload: unknown) => void) => {
      const list = mocks.handlers.get(event) ?? [];
      list.push(handler);
      mocks.handlers.set(event, list);
      return () => {
        mocks.handlers.set(
          event,
          (mocks.handlers.get(event) ?? []).filter((h) => h !== handler),
        );
      };
    },
  },
}));
vi.mock("../../lib/secureKeyStorage", () => ({
  getEthereumAddress: mocks.getEthereumAddress,
}));
vi.mock("./BalanceCacheService", () => ({
  BALANCE_CACHE_KEYS: { wallet: "wallet", dollar: "dollar" },
  getCachedBalance: mocks.getCachedBalance,
  setCachedBalance: mocks.setCachedBalance,
}));
vi.mock("./MultiCurrencyBalanceService", () => ({
  getBaseWalletEurcBalance: mocks.getBaseWalletEurcBalance,
  getErc20Balance: mocks.getErc20Balance,
}));
vi.mock("../base/BaseTokenTransferService", () => ({ autoDripBaseGasOnce: vi.fn() }));
vi.mock("../app/NetworkStatusService", () => ({
  getNetworkStatus: () => ({ isWaitingForNetwork: false }),
}));
vi.mock("../app/ForegroundPoller", () => ({
  createForegroundPoller: () => ({ start: vi.fn(), stop: vi.fn() }),
}));

import { usdcBalanceStore } from "./UsdcBalanceStore";
import { walletBalanceStore } from "./WalletBalanceStore";

const emit = (event: string, payload: unknown) => {
  for (const handler of mocks.handlers.get(event) ?? []) handler(payload);
};

const ADDRESS = "0x1111111111111111111111111111111111111111";

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  mocks.getEthereumAddress.mockResolvedValue(ADDRESS);
  mocks.getCachedBalance.mockResolvedValue(null);
  mocks.setCachedBalance.mockResolvedValue(undefined);
  mocks.getBaseWalletEurcBalance.mockResolvedValue(100);
  mocks.getErc20Balance.mockResolvedValue(50);
  walletBalanceStore.stop();
  usdcBalanceStore.stop();
  walletBalanceStore.reset();
  usdcBalanceStore.reset();
  walletBalanceStore.start();
  usdcBalanceStore.start();
  await walletBalanceStore.refresh();
  await usdcBalanceStore.refresh();
});

describe("revoking an optimistic credit by name", () => {
  it("takes a euro credit back off the euro wallet", async () => {
    emit("wallet:optimisticCredit", { amount: 25, moveId: "m1" });
    expect(walletBalanceStore.getSnapshot().balanceEur).toBe(125);

    emit("wallet:revokeOptimisticCredit", { moveId: "m1" });
    expect(walletBalanceStore.getSnapshot().balanceEur).toBe(100);
  });

  it("takes a dollar credit back off the dollar wallet", async () => {
    emit("wallet:optimisticCredit", { amount: 10, asset: "USDC_BASE", moveId: "m2" });
    expect(usdcBalanceStore.getSnapshot().balanceUsd).toBe(60);

    emit("wallet:revokeOptimisticCredit", { moveId: "m2" });
    expect(usdcBalanceStore.getSnapshot().balanceUsd).toBe(50);
  });

  it("leaves every other outstanding move alone", async () => {
    emit("wallet:optimisticCredit", { amount: 25, moveId: "keep" });
    emit("wallet:optimisticCredit", { amount: 5, moveId: "drop" });
    expect(walletBalanceStore.getSnapshot().balanceEur).toBe(130);

    emit("wallet:revokeOptimisticCredit", { moveId: "drop" });
    expect(walletBalanceStore.getSnapshot().balanceEur).toBe(125);
  });

  it("ignores a name it never credited", async () => {
    emit("wallet:optimisticCredit", { amount: 25, moveId: "m3" });
    emit("wallet:revokeOptimisticCredit", { moveId: "someone-elses" });
    expect(walletBalanceStore.getSnapshot().balanceEur).toBe(125);
  });

  // A credit can arrive before the rail has read any balance at all — a
  // withdrawal approved during startup. It waits for a figure, and it has to
  // wait revocably: collapsed into a bare total it could not be found again, and
  // dollars that never arrived landed on the rail as soon as a read came in.
  it("takes back a dollar credit that was still waiting for a balance", async () => {
    usdcBalanceStore.stop();
    usdcBalanceStore.reset();
    usdcBalanceStore.start();
    emit("wallet:optimisticCredit", { amount: 10, asset: "USDC_BASE", moveId: "queued" });
    expect(usdcBalanceStore.getSnapshot().balanceUsd).toBeNull();

    emit("wallet:revokeOptimisticCredit", { moveId: "queued" });
    await usdcBalanceStore.refresh();

    expect(usdcBalanceStore.getSnapshot().balanceUsd).toBe(50);
  });

  it("still applies a queued credit that was NOT revoked", async () => {
    usdcBalanceStore.stop();
    usdcBalanceStore.reset();
    usdcBalanceStore.start();
    // The rail last showed 50, so a baseline that has not risen by the credit is
    // one that does not contain it yet.
    mocks.getCachedBalance.mockResolvedValue({ address: ADDRESS, amount: 50 });
    emit("wallet:optimisticCredit", { amount: 10, asset: "USDC_BASE", moveId: "kept" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await usdcBalanceStore.refresh();

    expect(usdcBalanceStore.getSnapshot().balanceUsd).toBe(60);
  });

  // The queue is materialised into real moves when a figure finally arrives.
  // Collapsing it into one anchored total was how a name was lost at exactly the
  // moment the credit became visible: revocable while it waited, unrevocable
  // once shown.
  it("keeps a queued credit revocable after the balance arrives", async () => {
    usdcBalanceStore.stop();
    usdcBalanceStore.reset();
    usdcBalanceStore.start();
    mocks.getCachedBalance.mockResolvedValue({ address: ADDRESS, amount: 50 });
    emit("wallet:optimisticCredit", { amount: 10, asset: "USDC_BASE", moveId: "late" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await usdcBalanceStore.refresh();
    expect(usdcBalanceStore.getSnapshot().balanceUsd).toBe(60);

    emit("wallet:revokeOptimisticCredit", { moveId: "late" });
    expect(usdcBalanceStore.getSnapshot().balanceUsd).toBe(50);
  });

  // A queue can be PART settled: two credits wait, the first lands before the
  // rail ever reads a figure. The read that finally arrives already contains it,
  // so only the second one is still a promise — adding both would show dollars
  // the wallet does not hold.
  it("only promises the queued credits the first read does not already contain", async () => {
    usdcBalanceStore.stop();
    usdcBalanceStore.reset();
    usdcBalanceStore.start();
    mocks.getCachedBalance.mockResolvedValue({ address: ADDRESS, amount: 50 });
    mocks.getErc20Balance.mockResolvedValue(60);
    emit("wallet:optimisticCredit", { amount: 10, asset: "USDC_BASE", moveId: "landed" });
    emit("wallet:optimisticCredit", { amount: 20, asset: "USDC_BASE", moveId: "pending" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await usdcBalanceStore.refresh();

    expect(usdcBalanceStore.getSnapshot().balanceUsd).toBe(80);

    // The one still outstanding stays revocable; the settled one is the ledger's.
    emit("wallet:revokeOptimisticCredit", { moveId: "pending" });
    expect(usdcBalanceStore.getSnapshot().balanceUsd).toBe(60);
  });

  // Each rail only ever holds the credits that named its own token, so a
  // revocation cannot reach across and disturb the other one.

  it("does not let one rail's revocation touch the other", async () => {
    emit("wallet:optimisticCredit", { amount: 25, moveId: "eur" });
    emit("wallet:optimisticCredit", { amount: 10, asset: "USDC_BASE", moveId: "usd" });

    emit("wallet:revokeOptimisticCredit", { moveId: "eur" });
    expect(walletBalanceStore.getSnapshot().balanceEur).toBe(100);
    expect(usdcBalanceStore.getSnapshot().balanceUsd).toBe(60);
  });
});
