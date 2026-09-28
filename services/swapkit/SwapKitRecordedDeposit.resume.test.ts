import { beforeEach, describe, expect, it, vi } from "vitest";

// Review 5296967000 (#1468): the app dies right after the signed provider deposit is recorded, before
// the card top-up writes its post-broadcast row. On the next start the REAL store hydrates that row,
// the REAL resume promotes it once the chain knows the deposit, and the REAL tracker must hand the
// recorded deposit back to the swap loop as an externally funded one. Only storage, the chain, the
// swap loop and the side-effect stores are faked.

const mocks = vi.hoisted(() => ({
  disk: [] as unknown[],
  runSwapKitSwapLoop: vi.fn(),
  getTransactionStatus: vi.fn(),
  broadcastTransaction: vi.fn(),
  listSwapKitSwaps: vi.fn(),
  trackSwapKitSwap: vi.fn(),
}));

vi.mock("../balance/TransactionCacheService", () => ({
  getCacheValue: async (): Promise<unknown> => JSON.parse(JSON.stringify(mocks.disk)),
  setCacheValue: async (_key: string, value: unknown) => {
    mocks.disk = JSON.parse(JSON.stringify(value));
  },
}));
vi.mock("../nostr/NostrBackupService", () => ({
  publishSwapKitRecoverySnapshotToNostr: async () => {},
  restoreSwapKitRecoverySnapshotFromNostr: async (): Promise<null> => null,
}));
vi.mock("../bitcoin/BlockchainService", () => ({
  blockchainService: {
    getTransactionStatus: mocks.getTransactionStatus,
    broadcastTransaction: mocks.broadcastTransaction,
  },
}));
vi.mock("./SwapKitService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./SwapKitService")>();
  return {
    ...actual,
    runSwapKitSwapLoop: mocks.runSwapKitSwapLoop,
    listSwapKitSwaps: mocks.listSwapKitSwaps,
    trackSwapKitSwap: mocks.trackSwapKitSwap,
  };
});
vi.mock("../../lib/secureKeyStorage", () => ({
  getEthereumAddress: async () => "0x1111111111111111111111111111111111111111",
}));
vi.mock("../events/AppEventBusService", () => ({ EventBus: { emit: vi.fn(), on: vi.fn() } }));
vi.mock("../app/PendingPurchasesStore", () => ({
  PendingPurchasesStore: {
    hydrate: async () => {},
    list: (): unknown[] => [],
    add: async () => {},
    remove: async () => {},
  },
}));
vi.mock("../balance/PendingWalletTransfersStore", () => ({
  PendingWalletTransfersStore: { list: async (): Promise<unknown[]> => [], remove: async () => {} },
}));
vi.mock("./SwapKitDirectSwapStore", () => ({
  SwapKitDirectSwapStore: { hydrate: async () => {}, list: (): unknown[] => [] },
  listAbandonedSwapOrders: async () => new Set<string>(),
}));
vi.mock("./SwapKitDirectEvmSwapService", () => ({
  DIRECT_SWAP_SETTLED_EVENT: "swap:directSettled",
  resumeDirectEvmSwaps: async () => {},
}));
vi.mock("./SwapKitHtlcActionService", () => ({ handleSwapKitHtlcAction: vi.fn() }));
vi.mock("./SwapKitArkadeActionService", () => ({ handleSwapKitArkadeAction: vi.fn() }));
vi.mock("./SwapKitEvmSigner", () => ({
  signAndBroadcastSwapKitEvmTx: vi.fn(),
  SWAPKIT_SWEEP_CHAIN_IDS: [],
}));
vi.mock("../balance/MultiCurrencyBalanceService", () => ({
  getErc20BalanceUnits: async () => 0n,
}));
vi.mock("../base/BaseTokenTransferService", () => ({
  getBaseMainnetErc20Balance: async () => 0n,
  sendTokenOnBase: vi.fn(),
  getBaseTransactionOutcome: vi.fn(),
  signAndBroadcastBaseMainnetTx: vi.fn(),
  signCowOrderOnBase: vi.fn(),
}));
vi.mock("./SwapKitUsdcRecoveryService", () => ({ recoverStrandedUsdc: vi.fn() }));
vi.mock("./SwapKitRecoveryService", () => ({
  acceptedRecoveryQuote: vi.fn(),
  hasRecoveryConsent: () => false,
  isCurrentRateRecoveryRoute: () => false,
  recoveryPayoutProven: vi.fn(),
}));

const DEPOSIT_TXID = "f".repeat(64);
const DEPOSIT_TO = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

/** Exactly what the card top-up writes before the broadcast (its call, not a hand-built row). */
const preBroadcastRow = (kind?: "card_topup") => ({
  ...(kind ? { kind } : {}),
  txId: "sk_psbt_crash",
  destination: "card",
  settleTarget: "0x2222222222222222222222222222222222222222",
  expectedUsdc: 0,
  minEurc: 9.9,
  usdcBaseline: "0",
  stable: "EURC_BASE",
  sats: 1_000,
  createdAt: 1,
  attempts: 0,
  recovery: {
    status: "FUNDING",
    externallyFundedDeposit: true,
    depositTo: DEPOSIT_TO,
    depositAmount: "1000",
    depositTxHash: DEPOSIT_TXID,
    depositRawTx: "0200deadbeef",
  },
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.disk = [];
  mocks.runSwapKitSwapLoop.mockResolvedValue({ status: "PENDING" });
  mocks.listSwapKitSwaps.mockResolvedValue({ transactions: [] });
  mocks.trackSwapKitSwap.mockResolvedValue({ status: "PENDING" });
  // The deposit was accepted by the network before the app died.
  mocks.getTransactionStatus.mockResolvedValue({ confirmed: false });
});

async function crashThenRestart() {
  // A new process: fresh modules over the same disk.
  vi.resetModules();
  const { hydrateAndResumeSwapKitOrders } = await import("./SwapKitPendingTracker");
  await hydrateAndResumeSwapKitOrders();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function loopOptionsFor(txId: string) {
  const call = mocks.runSwapKitSwapLoop.mock.calls.find(([id]) => id === txId);
  return call?.[1] as { externallyFundedDeposit?: boolean; depositTxHash?: string } | undefined;
}

describe("a card top-up that crashed right after recording its signed deposit", () => {
  it("resumes as an externally funded order, replaying the recorded deposit", async () => {
    // Written through the real store, the way the card top-up writes it.
    const { SwapKitOrderStore } = await import("./SwapKitOrderStore");
    await SwapKitOrderStore.hydrate();
    await SwapKitOrderStore.addDurable(preBroadcastRow("card_topup") as never);

    await crashThenRestart();

    // Nothing is paid twice: the chain already had it.
    expect(mocks.broadcastTransaction).not.toHaveBeenCalled();
    expect(loopOptionsFor("sk_psbt_crash")).toMatchObject({
      externallyFundedDeposit: true,
      depositTxHash: DEPOSIT_TXID,
    });
    const stored = (mocks.disk as Array<{ txId: string; kind?: string; recovery?: object }>).find(
      (row) => row.txId === "sk_psbt_crash",
    );
    expect(stored?.kind).toBe("card_topup");
    expect(stored?.recovery).not.toHaveProperty("status");
    expect(stored?.recovery).not.toHaveProperty("depositRawTx");
  });

  it("resumes the same way for a row written without its kind", async () => {
    // A row already on a device from the head the review saw, where the pre-broadcast write left the
    // kind out.
    mocks.disk = [preBroadcastRow()];

    await crashThenRestart();

    expect(loopOptionsFor("sk_psbt_crash")).toMatchObject({
      externallyFundedDeposit: true,
      depositTxHash: DEPOSIT_TXID,
    });
  });

  it("keeps a row whose deposit the chain has not seen, re-sending only that transaction", async () => {
    mocks.disk = [preBroadcastRow("card_topup")];
    mocks.getTransactionStatus.mockRejectedValue(new Error("Not Found"));
    mocks.broadcastTransaction.mockRejectedValue(new Error("network down"));

    await crashThenRestart();

    expect(mocks.broadcastTransaction).toHaveBeenCalledWith("0200deadbeef");
    // Unknown outcome: not tracked, not dropped.
    expect(loopOptionsFor("sk_psbt_crash")).toBeUndefined();
    expect((mocks.disk as Array<{ txId: string }>).map((row) => row.txId)).toContain(
      "sk_psbt_crash",
    );
  });

  it("resumes the same way after the post-broadcast row replaced the recorded one", async () => {
    // The crash comes one step later: the broadcast answered and the regular row was written over the
    // pre-broadcast one, through the same store call the card top-up makes.
    const { SwapKitOrderStore } = await import("./SwapKitOrderStore");
    await SwapKitOrderStore.hydrate();
    await SwapKitOrderStore.addDurable(preBroadcastRow("card_topup") as never);
    const { recovery, ...order } = preBroadcastRow("card_topup");
    await SwapKitOrderStore.add({
      ...order,
      kind: "card_topup",
      recovery: {
        externallyFundedDeposit: true,
        depositTo: recovery.depositTo,
        depositAmount: recovery.depositAmount,
        depositTxHash: recovery.depositTxHash,
      },
    } as never);

    await crashThenRestart();

    expect(mocks.getTransactionStatus).not.toHaveBeenCalled();
    expect(loopOptionsFor("sk_psbt_crash")).toMatchObject({
      externallyFundedDeposit: true,
      depositTxHash: DEPOSIT_TXID,
    });
  });
});
