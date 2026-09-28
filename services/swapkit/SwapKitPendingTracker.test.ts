vi.mock("./SwapKitV2PendingTracker", () => ({ startSwapKitV2Tracking: vi.fn() }));
vi.mock("../arkade/ArkadeSendService", () => ({ fundArkadeIntentsOutpoint: vi.fn() }));
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SwapKitTrackResponse } from "./SwapKitService";

const mocks = vi.hoisted(() => ({
  getErc20BalanceUnits: vi.fn(),
  runSwapKitSwapLoop: vi.fn(),
  listSwapKitSwaps: vi.fn(),
  trackSwapKitSwap: vi.fn(),
  signAndBroadcastBaseMainnetTx: vi.fn(),
  signAndBroadcastSwapKitEvmTx: vi.fn(),
  signCowOrderOnBase: vi.fn(),
  getBaseMainnetErc20Balance: vi.fn(),
  sendTokenOnBase: vi.fn(),
  getBaseTransactionOutcome: vi.fn(),
  emit: vi.fn(),
  getEthereumAddress: vi.fn(),
  recoverStrandedUsdc: vi.fn(),
  restoreSnapshot: vi.fn(),
  bumpAttempts: vi.fn(),
  listOrders: vi.fn(),
  removeOrder: vi.fn(),
  hydrateOrders: vi.fn(),
  addOrder: vi.fn(),
  removePendingPurchase: vi.fn(),
  listPendingPurchases: vi.fn(),
  listPendingWalletTransfers: vi.fn(),
  removePendingWalletTransfer: vi.fn(),
  hydratePendingPurchases: vi.fn(),
  listAbandonedSwapOrders: vi.fn(),
  hydrateDirectSwaps: vi.fn(),
  listDirectSwaps: vi.fn(),
  resumeDirectEvmSwaps: vi.fn(),
}));

// The Arkade wallet graph reaches AuthStateService through static imports; the swaploop these
// tests exercise never touches auth state, so cut the graph here instead of mocking every
// transitive storage/event dependency.
// The Arkade wallet bootstrap graph (subscriptions, auth, storage) is reachable through static
// imports now; these tests exercise swap tracking, never wallet bootstrap, so cut it at the root.
vi.mock("../arkade/internal/walletCache", () => ({
  getOrCreateWallet: async () => {
    throw new Error("no wallet in swapkit unit tests");
  },
}));

vi.mock("../auth/AuthStateService", () => ({
  authStateManager: {
    getState: () => ({ walletPublicKeys: {} }),
    onAuthStateChanged: () => () => {},
  },
}));

vi.mock("../app/PendingPurchasesStore", () => ({
  PendingPurchasesStore: {
    remove: mocks.removePendingPurchase,
    list: mocks.listPendingPurchases,
    hydrate: mocks.hydratePendingPurchases,
  },
}));
vi.mock("../balance/PendingWalletTransfersStore", () => ({
  PendingWalletTransfersStore: {
    list: mocks.listPendingWalletTransfers,
    remove: mocks.removePendingWalletTransfer,
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
vi.mock("../base/BaseTokenTransferService", () => ({
  signAndBroadcastBaseMainnetTx: mocks.signAndBroadcastBaseMainnetTx,
  signCowOrderOnBase: mocks.signCowOrderOnBase,
  getBaseMainnetErc20Balance: mocks.getBaseMainnetErc20Balance,
  sendTokenOnBase: mocks.sendTokenOnBase,
  getBaseTransactionOutcome: mocks.getBaseTransactionOutcome,
}));
vi.mock("./SwapKitHtlcActionService", () => ({
  handleSwapKitHtlcAction: vi.fn(),
}));
vi.mock("./SwapKitEvmSigner", () => ({
  SWAPKIT_SWEEP_CHAIN_IDS: [1, 10, 56, 100, 137, 8453, 42161, 43114],
  signAndBroadcastSwapKitEvmTx: mocks.signAndBroadcastSwapKitEvmTx,
}));
// The live approval ceiling reads the bound token's balance right before signing.
vi.mock("../balance/MultiCurrencyBalanceService", () => ({
  getErc20BalanceUnits: mocks.getErc20BalanceUnits,
}));
vi.mock("../events/AppEventBusService", () => ({
  EventBus: { emit: mocks.emit },
}));
vi.mock("../../lib/secureKeyStorage", () => ({
  getEthereumAddress: mocks.getEthereumAddress,
}));
vi.mock("./SwapKitDirectEvmSwapService", () => ({
  DIRECT_SWAP_SETTLED_EVENT: "swap:directSettled",
  resumeDirectEvmSwaps: mocks.resumeDirectEvmSwaps,
}));
vi.mock("./SwapKitDirectSwapStore", () => ({
  SwapKitDirectSwapStore: {
    hydrate: mocks.hydrateDirectSwaps,
    list: mocks.listDirectSwaps,
  },
  listAbandonedSwapOrders: mocks.listAbandonedSwapOrders,
}));
vi.mock("./SwapKitUsdcRecoveryService", () => ({
  recoverStrandedUsdc: mocks.recoverStrandedUsdc,
}));
vi.mock("../nostr/NostrBackupService", () => ({
  restoreSwapKitRecoverySnapshotFromNostr: mocks.restoreSnapshot,
}));
vi.mock("./SwapKitOrderStore", () => ({
  SWEEP_FUNDING_STATUS: "FUNDING",
  isUnfundedSweepIntent: (order: { recovery?: { status?: string } }) =>
    order.recovery?.status === "FUNDING",
  SwapKitOrderStore: {
    bumpAttempts: mocks.bumpAttempts,
    list: mocks.listOrders,
    remove: mocks.removeOrder,
    hydrate: mocks.hydrateOrders,
    add: mocks.addOrder,
  },
}));

import {
  hydrateAndResumeSwapKitOrders,
  resumeSwapKitPendingTracking,
  startSwapKitOrderTracking,
  startSwapKitPendingTracking,
} from "./SwapKitPendingTracker";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.trackSwapKitSwap.mockReset().mockResolvedValue({ status: "COMPLETED", terminal: true });
  mocks.getEthereumAddress.mockResolvedValue("0x1111111111111111111111111111111111111111");
  mocks.sendTokenOnBase.mockResolvedValue({ hash: "0xforward", confirmed: false });
  mocks.getBaseTransactionOutcome.mockResolvedValue("success");
  mocks.getBaseMainnetErc20Balance.mockResolvedValue(0n);
  mocks.getErc20BalanceUnits.mockResolvedValue(0n);
  mocks.recoverStrandedUsdc.mockResolvedValue({ txId: null, swappedUsdc: 0 });
  mocks.bumpAttempts.mockResolvedValue(0);
  mocks.listOrders.mockReturnValue([]);
  mocks.removeOrder.mockResolvedValue(undefined);
  mocks.hydrateOrders.mockResolvedValue(undefined);
  mocks.addOrder.mockResolvedValue(undefined);
  mocks.removePendingPurchase.mockResolvedValue(undefined);
  mocks.listPendingPurchases.mockReturnValue([]);
  mocks.listPendingWalletTransfers.mockResolvedValue([]);
  mocks.removePendingWalletTransfer.mockResolvedValue(undefined);
  mocks.hydratePendingPurchases.mockResolvedValue(undefined);
  mocks.restoreSnapshot.mockResolvedValue(null);
  mocks.listAbandonedSwapOrders.mockResolvedValue(new Set<string>());
  mocks.hydrateDirectSwaps.mockResolvedValue(undefined);
  mocks.listDirectSwaps.mockReturnValue([]);
  mocks.resumeDirectEvmSwaps.mockResolvedValue(undefined);
  mocks.listSwapKitSwaps.mockResolvedValue({
    fromAddress: "0x1111111111111111111111111111111111111111",
    includeTerminal: false,
    since: null,
    limit: 100,
    transactions: [],
  });
});

describe("sweep action signing", () => {
  it("binds the sweep signer to the detected chain and token", async () => {
    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "PENDING" });
    mocks.signAndBroadcastSwapKitEvmTx.mockResolvedValueOnce({ hash: "0xhash" });

    startSwapKitOrderTracking({
      kind: "discovered",
      txId: "sweep-generic-signer",
      settleTarget: "0x1111111111111111111111111111111111111111",
      expectedUsdc: 0,
      usdcBaseline: "0",
      sats: 0,
      createdAt: Date.now(),
      attempts: 0,
      recovery: {
        provider: "sweep",
        chainId: 1,
        approvalToken: "0x3333333333333333333333333333333333333333",
        approvalMaxUnits: "11370000",
      },
    });
    // The ceiling is now read from the chain before the loop starts, so the
    // call is one async hop further out than a single microtask.
    await vi.waitFor(() => expect(mocks.runSwapKitSwapLoop).toHaveBeenCalled());

    const options = mocks.runSwapKitSwapLoop.mock.calls[0]?.[1];
    expect(options.allowedActionChains).toEqual([1]);
    expect(options.allowedApprovalTokens).toEqual(["0x3333333333333333333333333333333333333333"]);
    const parsed = {
      chainId: 1,
      to: "0x2222222222222222222222222222222222222222",
      data: "0x1234",
      value: 0n,
    };
    await options.signAction(parsed);
    // The accepted ceiling reaches the signer, narrowed by the live balance —
    // here the default mock reads zero, so nothing may be approved at all.
    expect(mocks.signAndBroadcastSwapKitEvmTx).toHaveBeenCalledWith(parsed, {
      requireApprovalBound: true,
      maxApprovalUnits: 0n,
    });
  });

  it("keeps legacy sweep rows without a token binding read-only", async () => {
    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "PENDING" });

    startSwapKitOrderTracking({
      kind: "discovered",
      txId: "legacy-unbound-sweep",
      settleTarget: "0x1111111111111111111111111111111111111111",
      expectedUsdc: 0,
      usdcBaseline: "0",
      sats: 0,
      createdAt: Date.now(),
      attempts: 0,
      recovery: { provider: "sweep" },
    });
    await Promise.resolve();

    const options = mocks.runSwapKitSwapLoop.mock.calls[0]?.[1];
    expect(options).not.toHaveProperty("signAction");
    expect(options).not.toHaveProperty("allowedApprovalTokens");
  });

  it("re-reports the funded deposit hash the row carries", async () => {
    // Reporting the hash at funding time is best effort. If it never landed,
    // this is the only way the server learns the deposit exists.
    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "PENDING" });

    startSwapKitOrderTracking({
      kind: "discovered",
      txId: "sweep-funded",
      settleTarget: "0x1111111111111111111111111111111111111111",
      expectedUsdc: 0,
      usdcBaseline: "0",
      sats: 0,
      createdAt: Date.now(),
      attempts: 0,
      recovery: { provider: "sweep", status: "PROCESSING", depositTxHash: "0xdeposit" },
    });
    await Promise.resolve();

    expect(mocks.runSwapKitSwapLoop.mock.calls[0]?.[1]).toMatchObject({
      depositTxHash: "0xdeposit",
    });
  });

  it("never runs a loop against a row whose deposit was never confirmed sent", async () => {
    // A FUNDING row is the record that a transfer's outcome is unknown, not an
    // order: the deposit moves outside the tracker, so polling it would report
    // on a convert that may hold no funds at all.
    startSwapKitOrderTracking({
      kind: "discovered",
      txId: "sweep-unfunded",
      settleTarget: "0x1111111111111111111111111111111111111111",
      expectedUsdc: 0,
      usdcBaseline: "0",
      sats: 0,
      createdAt: Date.now(),
      attempts: 0,
      recovery: {
        provider: "sweep",
        status: "FUNDING",
        depositTo: "0x2222222222222222222222222222222222222222",
        depositAmount: "11.37",
      },
    });
    await Promise.resolve();

    expect(mocks.runSwapKitSwapLoop).not.toHaveBeenCalled();
  });
});

describe("SwapKitPendingTracker", () => {
  it("deduplicates active order ids until the running loop exits", async () => {
    const pending = deferred<SwapKitTrackResponse>();
    mocks.runSwapKitSwapLoop.mockReturnValueOnce(pending.promise);

    startSwapKitPendingTracking("ORDER-1", "0xdeposit");
    startSwapKitPendingTracking("order-1", "0xdeposit");

    expect(mocks.runSwapKitSwapLoop).toHaveBeenCalledOnce();
    expect(mocks.runSwapKitSwapLoop).toHaveBeenCalledWith(
      "ORDER-1",
      expect.objectContaining({ depositTxHash: "0xdeposit", signAction: expect.any(Function) }),
    );

    pending.resolve({ status: "PENDING" });
    await pending.promise;
    await Promise.resolve();

    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "PENDING" });
    startSwapKitPendingTracking("order-1", "0xdeposit");
    expect(mocks.runSwapKitSwapLoop).toHaveBeenCalledTimes(2);
  });

  it("clears pending rows only when tracking returns a terminal status", async () => {
    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "PENDING" });

    startSwapKitPendingTracking("order-2", "0xpending");
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.emit).not.toHaveBeenCalledWith("wallet:clearPendingTransfer", expect.anything());

    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "COMPLETED" });
    startSwapKitPendingTracking("order-3", "0xdone");
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.emit).toHaveBeenCalledWith("wallet:clearPendingTransfer", {
      txHash: "0xdone",
      orderId: "order-3",
    });
    expect(mocks.emit).toHaveBeenCalledWith("wallet:refresh");
    expect(mocks.emit).toHaveBeenCalledWith("transactions:refresh");
    expect(mocks.emit).toHaveBeenCalledWith("bitcoin:refresh");
  });

  it("keeps the pending row while a provider-paid BTC payout is unconfirmed", async () => {
    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({
      status: "COMPLETED",
      terminal: true,
      legs: [
        {
          leg: "USDC_BASE->BTC",
          terminal: true,
          settlementConfirmation: {
            txid: "a".repeat(64),
            confirmed: false,
            feerateSatPerVb: 1,
          },
        },
      ],
    });

    startSwapKitPendingTracking("btc-payout-1", "0xdeposit");
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.emit).not.toHaveBeenCalledWith("wallet:clearPendingTransfer", expect.anything());
    expect(mocks.removePendingPurchase).not.toHaveBeenCalled();
  });

  it("re-arms tracking after the poll budget while the BTC payout is unconfirmed", async () => {
    vi.useFakeTimers();
    try {
      mocks.listPendingWalletTransfers.mockResolvedValue([
        { orderId: "btc-payout-rearm", txHash: "0xdeposit", source: "swapkit" },
      ]);
      mocks.runSwapKitSwapLoop
        .mockResolvedValueOnce({
          status: "COMPLETED",
          terminal: true,
          legs: [
            {
              leg: "USDC_BASE->BTC",
              terminal: true,
              settlementConfirmation: { txid: "b".repeat(64), confirmed: false },
            },
          ],
        })
        .mockResolvedValueOnce({ status: "COMPLETED", terminal: true });

      startSwapKitPendingTracking("btc-payout-rearm", "0xdeposit");
      await vi.waitFor(() => expect(mocks.runSwapKitSwapLoop).toHaveBeenCalledTimes(1));

      await vi.advanceTimersByTimeAsync(12_000);

      expect(mocks.runSwapKitSwapLoop).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not re-arm tracking after its durable pending row was cleared", async () => {
    vi.useFakeTimers();
    try {
      mocks.listPendingWalletTransfers.mockResolvedValue([]);
      mocks.runSwapKitSwapLoop.mockResolvedValueOnce({
        status: "COMPLETED",
        terminal: true,
        legs: [
          {
            leg: "USDC_BASE->BTC",
            terminal: true,
            settlementConfirmation: { txid: "d".repeat(64), confirmed: false },
          },
        ],
      });

      startSwapKitPendingTracking("cleared-before-rearm", "0xdeposit");
      await vi.waitFor(() => expect(mocks.runSwapKitSwapLoop).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(12_000);

      expect(mocks.runSwapKitSwapLoop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reset retry limits by re-arming a structural tracker error", async () => {
    vi.useFakeTimers();
    try {
      mocks.listPendingWalletTransfers.mockResolvedValue([
        { orderId: "structural-error", txHash: "0xdeposit", source: "swapkit" },
      ]);
      mocks.runSwapKitSwapLoop.mockRejectedValueOnce(new Error("structural action rejection"));

      startSwapKitPendingTracking("structural-error", "0xdeposit");
      await vi.waitFor(() => expect(mocks.runSwapKitSwapLoop).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(12_000);

      expect(mocks.runSwapKitSwapLoop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-arms a transient outage only after the loop entered the BTC confirmation tail", async () => {
    vi.useFakeTimers();
    try {
      mocks.listPendingWalletTransfers.mockResolvedValue([
        { orderId: "confirmation-outage", txHash: "0xdeposit", source: "swapkit" },
      ]);
      mocks.runSwapKitSwapLoop
        .mockImplementationOnce(async (_orderId, options) => {
          options.onUpdate({
            status: "COMPLETED",
            terminal: true,
            legs: [
              {
                leg: "USDC_BASE->BTC",
                terminal: true,
                settlementConfirmation: { txid: "e".repeat(64), confirmed: false },
              },
            ],
          });
          throw new Error("five consecutive swap_track failures");
        })
        .mockResolvedValueOnce({ status: "COMPLETED", terminal: true });

      startSwapKitPendingTracking("confirmation-outage", "0xdeposit");
      await vi.waitFor(() => expect(mocks.runSwapKitSwapLoop).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(12_000);

      expect(mocks.runSwapKitSwapLoop).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes only rows marked as swapkit and ignores missing order ids", async () => {
    mocks.runSwapKitSwapLoop.mockResolvedValue({ status: "PENDING" });

    resumeSwapKitPendingTracking([
      { orderId: "order-4", txHash: "0x4", source: "swapkit" },
      { orderId: "order-5", txHash: "0x5", source: "mercuryo" },
      { orderId: "", txHash: "0x6", source: "swapkit" },
      { txHash: "0x7", source: "swapkit" },
    ]);

    expect(mocks.runSwapKitSwapLoop).toHaveBeenCalledOnce();
    expect(mocks.runSwapKitSwapLoop).toHaveBeenCalledWith(
      "order-4",
      expect.objectContaining({ depositTxHash: "0x4" }),
    );
  });

  it("rehydrates owner-discovered txIds after local storage loss", async () => {
    mocks.listSwapKitSwaps.mockResolvedValueOnce({
      fromAddress: "0x1111111111111111111111111111111111111111",
      includeTerminal: false,
      since: null,
      limit: 100,
      transactions: [
        {
          txId: "server-order-1",
          status: "RECOVERY_PENDING",
          settleTarget: "0x2222222222222222222222222222222222222222",
          route: { providers: ["fixedfloat", "cow"] },
          createdAt: "2026-07-13T10:00:00.000Z",
        },
      ],
    });
    mocks.listOrders
      .mockReturnValueOnce([])
      .mockReturnValueOnce([])
      .mockReturnValueOnce([
        {
          kind: "discovered",
          txId: "server-order-1",
          settleTarget: "0x2222222222222222222222222222222222222222",
          expectedUsdc: 0,
          usdcBaseline: "0",
          sats: 0,
          createdAt: Date.parse("2026-07-13T10:00:00.000Z"),
          attempts: 0,
        },
      ]);
    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "PENDING" });

    await hydrateAndResumeSwapKitOrders();
    await Promise.resolve();

    expect(mocks.listSwapKitSwaps).toHaveBeenCalledWith({
      fromAddress: "0x1111111111111111111111111111111111111111",
      includeTerminal: false,
      limit: 100,
    });
    expect(mocks.addOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "discovered",
        txId: "server-order-1",
        recovery: expect.objectContaining({ provider: "fixedfloat" }),
      }),
    );
    // A discovered row has no user-accepted bounds, so it must never be wired
    // to a signer: the loop tracks it read-only until a snapshot restores them.
    const discoveredCall = mocks.runSwapKitSwapLoop.mock.calls.find(
      ([txId]) => txId === "server-order-1",
    );
    expect(discoveredCall).toBeDefined();
    const [, discoveredOptions] = discoveredCall ?? [];
    expect(discoveredOptions).not.toHaveProperty("signAction");
    expect(discoveredOptions).not.toHaveProperty("signTypedData");
  });

  it("recovers a persisted row whose provider BTC payout is still unconfirmed", async () => {
    const row = {
      orderId: "btc-payout-restart",
      txHash: "0xdeposit",
      source: "swapkit",
      amount: 20,
      maxSellEurc: 20,
    };
    mocks.listPendingWalletTransfers.mockResolvedValue([row]);
    mocks.trackSwapKitSwap.mockResolvedValueOnce({
      status: "COMPLETED",
      terminal: true,
      legs: [
        {
          leg: "USDC_BASE->BTC",
          terminal: true,
          settlementConfirmation: { txid: "c".repeat(64), confirmed: false },
        },
      ],
    });
    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "COMPLETED", terminal: true });

    await hydrateAndResumeSwapKitOrders();
    await Promise.resolve();

    expect(mocks.removePendingWalletTransfer).not.toHaveBeenCalledWith(null, row.orderId);
    expect(mocks.runSwapKitSwapLoop).toHaveBeenCalledWith(
      row.orderId,
      expect.objectContaining({ depositTxHash: row.txHash }),
    );
  });
});

describe("hydrate snapshot restore", () => {
  it("restores user-accepted bounds from the backup instead of a bounds-less discovered row", async () => {
    mocks.listSwapKitSwaps.mockResolvedValue({
      fromAddress: "0x1111111111111111111111111111111111111111",
      includeTerminal: false,
      since: null,
      limit: 100,
      transactions: [
        { txId: "sk_lost", settleTarget: "0x2222222222222222222222222222222222222222" },
      ],
    });
    mocks.restoreSnapshot.mockResolvedValue([
      {
        kind: "card_topup",
        txId: "sk_lost",
        settleTarget: "0x2222222222222222222222222222222222222222",
        expectedUsdc: 18.574427,
        minEurc: 16.05244014,
        usdcBaseline: "123",
        sats: 30_000,
        createdAt: 1,
        attempts: 0,
      },
    ]);

    await hydrateAndResumeSwapKitOrders();

    expect(mocks.addOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "card_topup",
        txId: "sk_lost",
        expectedUsdc: 18.574427,
        minEurc: 16.05244014,
      }),
    );
    // never a bounds-less discovered row for a restorable order
    expect(mocks.addOrder).not.toHaveBeenCalledWith(
      expect.objectContaining({ txId: "sk_lost", kind: "discovered" }),
    );
  });

  it("does not fetch the snapshot when every server order is known locally", async () => {
    mocks.listOrders.mockReturnValue([]);
    await hydrateAndResumeSwapKitOrders();
    expect(mocks.restoreSnapshot).not.toHaveBeenCalled();
  });

  it("promotes a funding intent the server already reports past funding", async () => {
    // fundSweepConvert can throw after the node accepted the transfer. Owner
    // discovery skips the txId (it is local) and the tracker skips FUNDING rows,
    // so without this the funded order would never be polled again.
    const intent = {
      kind: "discovered" as const,
      txId: "sweep-funded-after-throw",
      settleTarget: "0x1111111111111111111111111111111111111111",
      expectedUsdc: 0,
      usdcBaseline: "0",
      sats: 0,
      createdAt: 1,
      attempts: 0,
      recovery: { provider: "sweep", status: "FUNDING", depositTo: "0x2222222222222222222222" },
    };
    mocks.listOrders.mockReturnValue([intent]);
    mocks.listSwapKitSwaps.mockResolvedValue({
      transactions: [{ txId: "sweep-funded-after-throw", status: "PROCESSING" }],
    });

    await hydrateAndResumeSwapKitOrders();

    expect(mocks.addOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        txId: "sweep-funded-after-throw",
        recovery: expect.objectContaining({
          status: "PROCESSING",
          depositTo: "0x2222222222222222222222",
        }),
      }),
    );
  });

  it("leaves a funding intent alone while the server is still awaiting the deposit", async () => {
    // Nothing here proves the transfer landed, so the row keeps saying so.
    mocks.listOrders.mockReturnValue([
      {
        kind: "discovered" as const,
        txId: "sweep-still-unfunded",
        settleTarget: "0x1111111111111111111111111111111111111111",
        expectedUsdc: 0,
        usdcBaseline: "0",
        sats: 0,
        createdAt: 1,
        attempts: 0,
        recovery: { provider: "sweep", status: "FUNDING" },
      },
    ]);
    mocks.listSwapKitSwaps.mockResolvedValue({
      transactions: [{ txId: "sweep-still-unfunded", status: "AWAITING_FUNDING" }],
    });

    await hydrateAndResumeSwapKitOrders();

    expect(mocks.addOrder).not.toHaveBeenCalled();
    expect(mocks.runSwapKitSwapLoop).not.toHaveBeenCalled();
  });
});

describe("unrecoverable orders", () => {
  it("sweeps any delivered funds, then drops the row instead of retrying forever", async () => {
    const order = {
      txId: "sk_dead",
      settleTarget: "0x2222222222222222222222222222222222222222",
      expectedUsdc: 10,
      minEurc: 9,
      usdcBaseline: "0",
      sats: 1000,
      createdAt: 1,
      attempts: 0,
    };
    mocks.listOrders.mockReturnValue([order]);
    // The three server rejections seen live: none of them can ever succeed on
    // a retry, so the row must not survive the attempt.
    mocks.runSwapKitSwapLoop.mockRejectedValue(
      new Error("Satora duplicate material can only be replaced before order creation or funding"),
    );
    mocks.trackSwapKitSwap.mockResolvedValue({ status: "FAILED", terminal: true });
    mocks.getBaseMainnetErc20Balance.mockResolvedValue(0n);
    mocks.getErc20BalanceUnits.mockResolvedValue(0n); // nothing delivered

    await hydrateAndResumeSwapKitOrders();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.removeOrder).toHaveBeenCalledWith("sk_dead");
  });

  it("escalates a standing walletActionError once the poll budget is exhausted", async () => {
    // The server reports blocking errors as a field, not a thrown error — the
    // catch path never sees them. Only classified AFTER budget exhaustion,
    // because the same text can be transient mid-flight (live 2026-07-20: a
    // CCTP bridge showed "funding needs X, wallet has Y" and self-resolved).
    const order = {
      txId: "sk_walleterr",
      settleTarget: "0x4444444444444444444444444444444444444444",
      expectedUsdc: 10,
      minEurc: 9,
      usdcBaseline: "0",
      sats: 1000,
      createdAt: 1,
      attempts: 0,
    };
    mocks.listOrders.mockReturnValue([order]);
    // Loop resolves NON-terminal (budget exhausted) with the standing error.
    mocks.runSwapKitSwapLoop.mockResolvedValue({
      txId: "sk_walleterr",
      status: "AWAITING_FUNDING",
      walletActionError: "Satora funding needs 114055871 Base USDC units, wallet has 114055868",
    });
    mocks.trackSwapKitSwap.mockResolvedValue({ status: "FAILED", terminal: true });
    mocks.getBaseMainnetErc20Balance.mockResolvedValue(0n);
    mocks.getErc20BalanceUnits.mockResolvedValue(0n);

    await hydrateAndResumeSwapKitOrders();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.removeOrder).toHaveBeenCalledWith("sk_walleterr");
  });

  it("treats a refund-destination mismatch as unrecoverable, not as a retryable failure", async () => {
    // Our own address-binding check, not a server rejection: the server asked
    // to send the refund somewhere other than this order's bound address. It
    // fails identically on every retry, and it is the most serious finding on
    // that path — so it must escalate once and stop, never burn three silent
    // attempts and give up anonymously. Issue #882.
    const order = {
      txId: "sk_mismatch",
      settleTarget: "0x3333333333333333333333333333333333333333",
      expectedUsdc: 10,
      minEurc: 9,
      usdcBaseline: "0",
      sats: 1000,
      createdAt: 1,
      attempts: 0,
    };
    mocks.listOrders.mockReturnValue([order]);
    mocks.runSwapKitSwapLoop.mockRejectedValue(
      new Error("arkade refund destination does not match this order's local address"),
    );
    mocks.trackSwapKitSwap.mockResolvedValue({ status: "FAILED", terminal: true });
    mocks.getBaseMainnetErc20Balance.mockResolvedValue(0n);
    mocks.getErc20BalanceUnits.mockResolvedValue(0n);

    await hydrateAndResumeSwapKitOrders();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.removeOrder).toHaveBeenCalledWith("sk_mismatch");
  });

  it("keeps the row when recovery could not settle it (funds may still be stranded)", async () => {
    const order = {
      txId: "sk_stuck",
      settleTarget: "0x2222222222222222222222222222222222222222",
      expectedUsdc: 10,
      minEurc: 9,
      usdcBaseline: "0",
      sats: 1000,
      createdAt: 1,
      attempts: 0,
    };
    mocks.listOrders.mockReturnValue([order]);
    mocks.runSwapKitSwapLoop.mockRejectedValue(
      new Error("Satora duplicate material can only be replaced before order creation or funding"),
    );
    // The order is dead AND delivered USDC, but the forward swap fails
    // transiently: the row must survive with its bounds for the next hydrate.
    mocks.trackSwapKitSwap.mockResolvedValue({ status: "FAILED", terminal: true });
    mocks.getBaseMainnetErc20Balance.mockResolvedValue(10_000_000n);
    mocks.recoverStrandedUsdc.mockRejectedValue(new Error("network blip"));

    await hydrateAndResumeSwapKitOrders();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.removeOrder).not.toHaveBeenCalledWith("sk_stuck");
  });
});

describe("card-topup pending-row lifecycle", () => {
  const topupOrder = (txId: string) => ({
    kind: "card_topup" as const,
    destination: "wallet" as const,
    txId,
    settleTarget: "0x2222222222222222222222222222222222222222",
    expectedUsdc: 10,
    minEurc: 9,
    usdcBaseline: "0",
    sats: 1000,
    createdAt: 1,
    attempts: 0,
  });
  const clearedRow = (orderId: string) =>
    mocks.emit.mock.calls.some(
      ([e, p]: [string, { orderId?: string }]) =>
        e === "wallet:clearPendingTransfer" && p?.orderId === orderId,
    );

  it("clears the pending row on COMPLETED", async () => {
    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "COMPLETED", terminal: true });

    startSwapKitOrderTracking(topupOrder("sk_done"));
    await new Promise((r) => setTimeout(r, 0));

    expect(clearedRow("sk_done")).toBe(true);
    expect(mocks.removeOrder).toHaveBeenCalledWith("sk_done");
  });

  // Review 5294728655 #3: a Bitcoin → card order's outcome reaches the card's optimistic credit.
  const settlement = (orderId: string) =>
    mocks.emit.mock.calls.find(
      ([e, p]: [string, { txId?: string }]) => e === "swap:directSettled" && p?.txId === orderId,
    )?.[1];

  it("announces a completed Bitcoin → card order as delivered", async () => {
    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "COMPLETED", terminal: true });

    startSwapKitOrderTracking({ ...topupOrder("sk_card_done"), destination: "card" });
    await new Promise((r) => setTimeout(r, 0));

    expect(settlement("sk_card_done")).toEqual({
      txId: "sk_card_done",
      destination: "card",
      ok: true,
    });
  });

  it("announces a dead Bitcoin → card order that delivered nothing, so the card credit goes now", async () => {
    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "REFUNDED", terminal: true });
    mocks.trackSwapKitSwap.mockResolvedValue({ status: "REFUNDED", terminal: true });
    mocks.getErc20BalanceUnits.mockResolvedValue(0n);
    mocks.getBaseMainnetErc20Balance.mockResolvedValue(0n);

    startSwapKitOrderTracking({ ...topupOrder("sk_card_dead"), destination: "card" });
    await new Promise((r) => setTimeout(r, 0));

    expect(settlement("sk_card_dead")).toEqual({
      txId: "sk_card_dead",
      destination: "card",
      ok: false,
    });
  });

  it("announces nothing for a wallet order, which owes the card nothing", async () => {
    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "COMPLETED", terminal: true });

    startSwapKitOrderTracking(topupOrder("sk_wallet_done"));
    await new Promise((r) => setTimeout(r, 0));

    expect(settlement("sk_wallet_done")).toBeUndefined();
  });

  it("keeps the pending row on non-terminal poll-budget exhaustion", async () => {
    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "AWAITING_FUNDING" });

    startSwapKitOrderTracking(topupOrder("sk_slow"));
    await new Promise((r) => setTimeout(r, 0));

    expect(clearedRow("sk_slow")).toBe(false);
    expect(mocks.removeOrder).not.toHaveBeenCalledWith("sk_slow");
  });

  it("replays a bounded externally funded BTC deposit without re-sending it", async () => {
    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "PENDING" });

    startSwapKitOrderTracking({
      ...topupOrder("sk_btc_funded"),
      recovery: {
        externallyFundedDeposit: true,
        depositTo: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT",
        depositAmount: "1000",
        depositTxHash: "btc-deposit-txid",
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.runSwapKitSwapLoop).toHaveBeenCalledWith(
      "sk_btc_funded",
      expect.objectContaining({
        externallyFundedDeposit: true,
        depositTxHash: "btc-deposit-txid",
      }),
    );
  });

  it("does not trust an externally funded marker with a mismatched amount", async () => {
    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "PENDING" });

    startSwapKitOrderTracking({
      ...topupOrder("sk_btc_unbound"),
      recovery: {
        externallyFundedDeposit: true,
        depositTo: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT",
        depositAmount: "999",
        depositTxHash: "btc-deposit-txid",
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.runSwapKitSwapLoop.mock.calls[0][1]).not.toHaveProperty("externallyFundedDeposit");
  });

  it("keeps the pending row when a failed order's recovery cannot settle", async () => {
    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "FAILED", terminal: true });
    // Recovery sees the order still live (non-terminal, not awaiting our
    // signature) → escalateToRecovery returns false, so the row is kept.
    mocks.trackSwapKitSwap.mockResolvedValue({ status: "PENDING" });

    startSwapKitOrderTracking(topupOrder("sk_stuck"));
    await new Promise((r) => setTimeout(r, 0));

    expect(clearedRow("sk_stuck")).toBe(false);
    expect(mocks.removeOrder).not.toHaveBeenCalledWith("sk_stuck");
  });

  it("clears the pending row once a failed order's recovery settles", async () => {
    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "FAILED", terminal: true });
    // Order is dead and delivered nothing → escalateToRecovery removes the
    // order and returns true, so the pending row is cleared.
    mocks.trackSwapKitSwap.mockResolvedValue({ status: "FAILED", terminal: true });
    mocks.getBaseMainnetErc20Balance.mockResolvedValue(0n);
    mocks.getErc20BalanceUnits.mockResolvedValue(0n);

    startSwapKitOrderTracking(topupOrder("sk_settled"));
    await new Promise((r) => setTimeout(r, 0));

    expect(clearedRow("sk_settled")).toBe(true);
  });

  // A USDC order's dollars ARE what the user bought, so nothing converts them
  // forward — but the row may only be retired once they have actually arrived.
  // `AWAITING_SIGNATURE` reaches the same branch, and dropping the row there
  // would retire an order whose dollars have not landed, with nothing left to
  // resume it and the pending row the user is watching gone with it.
  it("keeps an undelivered USDC order awaiting our signature", async () => {
    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "FAILED", terminal: true });
    mocks.trackSwapKitSwap.mockResolvedValue({ status: "AWAITING_SIGNATURE" });
    mocks.getBaseMainnetErc20Balance.mockResolvedValue(0n);
    mocks.getErc20BalanceUnits.mockResolvedValue(0n);

    startSwapKitOrderTracking({ ...topupOrder("sk_usdc_pending"), stable: "USDC_BASE" });
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.removeOrder).not.toHaveBeenCalledWith("sk_usdc_pending");
    expect(clearedRow("sk_usdc_pending")).toBe(false);
  });

  it("retires a USDC order once its dollars have landed where they were meant to", async () => {
    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "FAILED", terminal: true });
    mocks.trackSwapKitSwap.mockResolvedValue({ status: "AWAITING_SIGNATURE" });
    // 10 USDC delivered, against a zero baseline.
    mocks.getBaseMainnetErc20Balance.mockResolvedValue(10_000_000n);
    mocks.getErc20BalanceUnits.mockResolvedValue(10_000_000n);

    startSwapKitOrderTracking({
      ...topupOrder("sk_usdc_done"),
      // A wallet order settles to the owner EOA, which is where the hub already
      // delivered — what resolveSettleTarget returns for that destination.
      settleTarget: "0x1111111111111111111111111111111111111111",
      stable: "USDC_BASE",
    });
    await new Promise((r) => setTimeout(r, 0));

    // Settling to the EOA IS the delivery for a wallet order — nothing to move.
    expect(mocks.sendTokenOnBase).not.toHaveBeenCalled();
    expect(mocks.removeOrder).toHaveBeenCalledWith("sk_usdc_done");
  });

  // The hub always delivers to the EOA, but a CARD order was accepted against
  // the Wirex smart account. Retiring it at the EOA would leave the dollars on
  // the wallet with the card never funded and the pending row — the only way
  // back — gone with it.
  it("forwards a card order's dollars to the card before retiring it", async () => {
    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "FAILED", terminal: true });
    mocks.trackSwapKitSwap.mockResolvedValue({ status: "AWAITING_SIGNATURE" });
    mocks.getBaseMainnetErc20Balance.mockResolvedValue(10_000_000n);
    mocks.getErc20BalanceUnits.mockResolvedValue(10_000_000n);

    startSwapKitOrderTracking({
      ...topupOrder("sk_usdc_card"),
      destination: "card" as const,
      settleTarget: "0x3333333333333333333333333333333333333333",
      stable: "USDC_BASE",
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.sendTokenOnBase).toHaveBeenCalledWith(
      expect.objectContaining({
        toAddress: "0x3333333333333333333333333333333333333333",
        amount: "10.000000",
      }),
    );
    expect(mocks.removeOrder).toHaveBeenCalledWith("sk_usdc_card");
  });

  it("keeps a card order whose forward has not mined, and records its hash", async () => {
    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "FAILED", terminal: true });
    mocks.trackSwapKitSwap.mockResolvedValue({ status: "AWAITING_SIGNATURE" });
    mocks.getBaseMainnetErc20Balance.mockResolvedValue(10_000_000n);
    mocks.getErc20BalanceUnits.mockResolvedValue(10_000_000n);
    // Broadcast, no receipt yet: the dollars may or may not have moved.
    mocks.getBaseTransactionOutcome.mockResolvedValue("pending");

    startSwapKitOrderTracking({
      ...topupOrder("sk_usdc_card_unconfirmed"),
      destination: "card" as const,
      settleTarget: "0x3333333333333333333333333333333333333333",
      stable: "USDC_BASE",
    });
    await new Promise((r) => setTimeout(r, 0));

    // The hash is what the next resume asks about. Persisted before anything is
    // concluded, because a lost one is a second transfer.
    expect(mocks.addOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        txId: "sk_usdc_card_unconfirmed",
        recovery: expect.objectContaining({ forwardTxHash: "0xforward" }),
      }),
    );
    expect(mocks.removeOrder).not.toHaveBeenCalledWith("sk_usdc_card_unconfirmed");
    expect(clearedRow("sk_usdc_card_unconfirmed")).toBe(false);
  });

  // The EOA balance still reads the pre-inclusion figure while the forward is in
  // the mempool, so the balance alone says "nothing forwarded". Sending again on
  // that basis moves the recovered dollars twice.
  it("does not re-broadcast a forward that is still in the mempool", async () => {
    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "FAILED", terminal: true });
    mocks.trackSwapKitSwap.mockResolvedValue({ status: "AWAITING_SIGNATURE" });
    mocks.getBaseMainnetErc20Balance.mockResolvedValue(10_000_000n);
    mocks.getErc20BalanceUnits.mockResolvedValue(10_000_000n);
    mocks.getBaseTransactionOutcome.mockResolvedValue("pending");

    startSwapKitOrderTracking({
      ...topupOrder("sk_usdc_card_retry"),
      destination: "card" as const,
      settleTarget: "0x3333333333333333333333333333333333333333",
      stable: "USDC_BASE",
      recovery: { forwardTxHash: "0xearlier" },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.sendTokenOnBase).not.toHaveBeenCalled();
    expect(mocks.removeOrder).not.toHaveBeenCalledWith("sk_usdc_card_retry");
  });

  it("retires the order once the recorded forward has mined", async () => {
    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "FAILED", terminal: true });
    mocks.trackSwapKitSwap.mockResolvedValue({ status: "AWAITING_SIGNATURE" });
    mocks.getBaseMainnetErc20Balance.mockResolvedValue(10_000_000n);
    mocks.getErc20BalanceUnits.mockResolvedValue(10_000_000n);
    mocks.getBaseTransactionOutcome.mockResolvedValue("success");

    startSwapKitOrderTracking({
      ...topupOrder("sk_usdc_card_mined"),
      destination: "card" as const,
      settleTarget: "0x3333333333333333333333333333333333333333",
      stable: "USDC_BASE",
      recovery: { forwardTxHash: "0xearlier" },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.sendTokenOnBase).not.toHaveBeenCalled();
    expect(mocks.removeOrder).toHaveBeenCalledWith("sk_usdc_card_mined");
  });

  // A reverted forward moved nothing, so the order may send again — but only
  // after the dead hash is cleared, or the next resume would read that
  // transaction's outcome as the new one's.
  it("clears a reverted forward before sending another", async () => {
    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "FAILED", terminal: true });
    mocks.trackSwapKitSwap.mockResolvedValue({ status: "AWAITING_SIGNATURE" });
    mocks.getBaseMainnetErc20Balance.mockResolvedValue(10_000_000n);
    mocks.getErc20BalanceUnits.mockResolvedValue(10_000_000n);
    mocks.getBaseTransactionOutcome.mockResolvedValueOnce("reverted").mockResolvedValue("success");

    startSwapKitOrderTracking({
      ...topupOrder("sk_usdc_card_reverted"),
      destination: "card" as const,
      settleTarget: "0x3333333333333333333333333333333333333333",
      stable: "USDC_BASE",
      recovery: { forwardTxHash: "0xdead" },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.addOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        txId: "sk_usdc_card_reverted",
        recovery: expect.objectContaining({ forwardTxHash: undefined }),
      }),
    );
    expect(mocks.sendTokenOnBase).toHaveBeenCalled();
    expect(mocks.removeOrder).toHaveBeenCalledWith("sk_usdc_card_reverted");
  });

  it("refreshes the card balance when a card top-up completes (not for wallet)", async () => {
    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "COMPLETED", terminal: true });
    startSwapKitOrderTracking({ ...topupOrder("sk_card"), destination: "card" });
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.emit).toHaveBeenCalledWith("card:refreshBalance");

    mocks.emit.mockClear();
    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "COMPLETED", terminal: true });
    startSwapKitOrderTracking(topupOrder("sk_wallet_dest")); // destination "wallet"
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.emit).not.toHaveBeenCalledWith("card:refreshBalance");
  });

  it("refreshes the card balance for a legacy order with no destination (defaults to card)", async () => {
    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "COMPLETED", terminal: true });
    const { destination: _omit, ...legacy } = topupOrder("sk_legacy");
    startSwapKitOrderTracking(legacy);
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.emit).toHaveBeenCalledWith("card:refreshBalance");
  });

  it("binds the forward CoW order to the order's receiver and amounts", async () => {
    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "PENDING" });

    startSwapKitOrderTracking(topupOrder("sk_cow"));
    await new Promise((r) => setTimeout(r, 0));

    const options = mocks.runSwapKitSwapLoop.mock.calls[0][1];
    await options.signTypedData({ actionId: "cow" });

    expect(mocks.signCowOrderOnBase).toHaveBeenCalledWith(
      { actionId: "cow" },
      expect.objectContaining({
        receiver: "0x2222222222222222222222222222222222222222",
        maxSellAmount: 10_000_000n,
        minBuyAmount: 9_000_000n,
      }),
    );
  });

  it("caps the forward approval at the accepted USDC plus tolerance", async () => {
    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "PENDING" });

    startSwapKitOrderTracking(topupOrder("sk_approval"));
    await new Promise((r) => setTimeout(r, 0));

    const options = mocks.runSwapKitSwapLoop.mock.calls[0][1];
    await options.signAction({ to: "0x0", data: "0x0", value: 0n });

    // expectedUsdc 10 * APPROVAL_TOLERANCE 1.02 = 10.2 USDC -> 10_200_000 units.
    expect(mocks.signAndBroadcastBaseMainnetTx).toHaveBeenCalledWith(
      expect.objectContaining({ maxApprovalUnits: 10_200_000n }),
    );
  });
});

describe("orphaned top-up reconciliation on hydrate", () => {
  it("drops a btc_to_eur row whose order is gone, keeps a live row and non-topup rows", async () => {
    // One durable order still exists (sk_live); sk_orphan's COMPLETED/recovered
    // order was already removed but its TTL-exempt Bitcoin row survived a crash
    // mid-clear; merc is an unrelated (incoming) purchase row.
    mocks.listOrders.mockReturnValue([
      {
        txId: "sk_live",
        settleTarget: "0x2222222222222222222222222222222222222222",
        expectedUsdc: 10,
        minEurc: 9,
        usdcBaseline: "0",
        sats: 1,
        createdAt: 1,
        attempts: 0,
      },
    ]);
    mocks.listPendingPurchases.mockReturnValue([
      { id: "sk_orphan", direction: "btc_to_eur", createdAt: 1 },
      { id: "sk_live", direction: "btc_to_eur", createdAt: 1 },
      { id: "merc", source: "mercuryo", createdAt: 1 },
    ]);
    mocks.runSwapKitSwapLoop.mockResolvedValue({ status: "PENDING" });

    await hydrateAndResumeSwapKitOrders();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.removePendingPurchase).toHaveBeenCalledWith("sk_orphan");
    expect(mocks.removePendingPurchase).not.toHaveBeenCalledWith("sk_live");
    expect(mocks.removePendingPurchase).not.toHaveBeenCalledWith("merc");
  });

  it("does NOT reconcile when owner discovery (swap_list) failed", async () => {
    // Local storage is empty AND the server list threw — the local order set is
    // not authoritative, so a row missing locally might still back a live
    // server order. It must survive until a later hydration confirms.
    mocks.listOrders.mockReturnValue([]);
    mocks.listSwapKitSwaps.mockRejectedValue(new Error("network down"));
    mocks.listPendingPurchases.mockReturnValue([
      { id: "sk_maybe_live", direction: "btc_to_eur", createdAt: 1 },
    ]);

    await hydrateAndResumeSwapKitOrders();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.removePendingPurchase).not.toHaveBeenCalledWith("sk_maybe_live");
  });

  // The wallet's activity list has the same orphan, and the user sees it: a
  // swap that COMPLETED while this app was closed keeps its "Pending broadcast"
  // row forever, while opening it says the money was delivered.
  it("drops a wallet swap row whose order finished, and keeps live and foreign rows", async () => {
    mocks.listOrders.mockReturnValue([
      {
        txId: "sk_live",
        settleTarget: "0x2222222222222222222222222222222222222222",
        expectedUsdc: 10,
        minEurc: 9,
        usdcBaseline: "0",
        sats: 1,
        createdAt: 1,
        attempts: 0,
      },
    ]);
    mocks.listPendingWalletTransfers.mockResolvedValue([
      { orderId: "sk_done", source: "swapkit", amount: 21, createdAt: "1" },
      { orderId: "sk_live", source: "swapkit", amount: 5, createdAt: "1" },
      { orderId: "mercuryo-1", source: "mercuryo", amount: 5, createdAt: "1" },
      { orderId: null, txHash: "0xabc", source: null, amount: 5, createdAt: "1" },
    ]);
    mocks.runSwapKitSwapLoop.mockResolvedValue({ status: "PENDING" });

    await hydrateAndResumeSwapKitOrders();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.removePendingWalletTransfer).toHaveBeenCalledWith(null, "sk_done");
    expect(mocks.removePendingWalletTransfer).toHaveBeenCalledTimes(1);
  });

  // A route can write its pending row while hydration is already running: it is
  // then missing from the live set for a reason that has nothing to do with
  // being settled, and deleting it would hide a swap whose funds are moving.
  it("never judges a row that appeared after owner discovery took its snapshot", async () => {
    mocks.listOrders.mockReturnValue([]);
    mocks.listPendingWalletTransfers
      .mockResolvedValueOnce([]) // the snapshot: nothing pending yet
      .mockResolvedValue([{ orderId: "sk_just_started", source: "swapkit", amount: 5 }]);
    mocks.runSwapKitSwapLoop.mockResolvedValue({ status: "PENDING" });

    await hydrateAndResumeSwapKitOrders();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.removePendingWalletTransfer).not.toHaveBeenCalled();
  });

  it("leaves wallet swap rows alone when owner discovery failed", async () => {
    mocks.listOrders.mockReturnValue([]);
    mocks.listSwapKitSwaps.mockRejectedValue(new Error("network down"));
    mocks.listPendingWalletTransfers.mockResolvedValue([
      { orderId: "sk_maybe_live", source: "swapkit", amount: 21, createdAt: "1" },
    ]);

    await hydrateAndResumeSwapKitOrders();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.removePendingWalletTransfer).not.toHaveBeenCalled();
  });
});

// Regression: a resumed CoW order must fail closed when the server omits the
// minimum hub amount, exactly like the create-time path. `minBuyAmount:
// undefined` does not mean "no minimum" — it skips the floor entirely and signs
// an order with no bound on what returns.
describe("resumed CoW signing hub-amount floor", () => {
  const provider = "0x2222222222222222222222222222222222222222";

  async function captureSignTypedData() {
    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "PENDING" });
    // maxSellEurc > 0 is what wires the signTypedData (CoW) leg in.
    startSwapKitPendingTracking("order-hub", "0xdeposit", 100);
    await Promise.resolve();
    return mocks.runSwapKitSwapLoop.mock.calls.at(-1)?.[1]?.signTypedData;
  }

  it("throws when requiredHubAmount is missing", async () => {
    const signTypedData = await captureSignTypedData();
    expect(() => signTypedData({}, { assist: { providerDeposit: provider } })).toThrow(
      /minimum hub amount/i,
    );
    expect(mocks.signCowOrderOnBase).not.toHaveBeenCalled();
  });

  it("throws when requiredHubAmount is zero", async () => {
    const signTypedData = await captureSignTypedData();
    expect(() =>
      signTypedData({}, { assist: { providerDeposit: provider, requiredHubAmount: 0 } }),
    ).toThrow(/minimum hub amount/i);
    expect(mocks.signCowOrderOnBase).not.toHaveBeenCalled();
  });

  it("signs with a positive minBuyAmount when requiredHubAmount is stated", async () => {
    const signTypedData = await captureSignTypedData();
    signTypedData({}, { assist: { providerDeposit: provider, requiredHubAmount: 9 } });
    expect(mocks.signCowOrderOnBase).toHaveBeenCalledTimes(1);
    const opts = mocks.signCowOrderOnBase.mock.calls[0][1];
    expect(opts.maxSellAmount).toBe(105_000_000n);
    expect(typeof opts.minBuyAmount).toBe("bigint");
    expect(opts.minBuyAmount > 0n).toBe(true);
  });
});

// The claim-time ceiling is what the user accepted; a live read may only narrow.
describe("sweep approval ceiling", () => {
  const sweepRow = {
    kind: "discovered" as const,
    txId: "sweep-ceiling-bound",
    settleTarget: "0x1111111111111111111111111111111111111111",
    expectedUsdc: 0,
    usdcBaseline: "0",
    sats: 0,
    createdAt: Date.now(),
    attempts: 0,
    recovery: {
      provider: "sweep" as const,
      chainId: 1,
      approvalToken: "0x3333333333333333333333333333333333333333",
      approvalMaxUnits: "11370000",
    },
  };

  const ceilingFor = async (liveUnits: bigint): Promise<bigint | undefined> => {
    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "PENDING" });
    mocks.signAndBroadcastSwapKitEvmTx.mockResolvedValueOnce({ hash: "0xhash" });
    mocks.getErc20BalanceUnits.mockResolvedValueOnce(liveUnits);
    startSwapKitOrderTracking(sweepRow);
    await vi.waitFor(() => expect(mocks.runSwapKitSwapLoop).toHaveBeenCalled());
    const options = mocks.runSwapKitSwapLoop.mock.calls.at(-1)?.[1];
    await options.signAction({
      chainId: 1,
      to: "0x2222222222222222222222222222222222222222",
      data: "0x1234",
      value: 0n,
    });
    return mocks.signAndBroadcastSwapKitEvmTx.mock.calls.at(-1)?.[1]?.maxApprovalUnits;
  };

  it("never approves more than the amount the claim accepted", async () => {
    // Balance grew tenfold after the claim: the extra was never on the sheet.
    expect(await ceilingFor(100_000_000n)).toBe(11_370_000n);
  });

  it("refuses outright when the live read says the wallet is empty", async () => {
    expect(await ceilingFor(0n)).toBe(0n);
  });

  it("narrows to the live balance when it has fallen since the claim", async () => {
    // 5_000_000 * 1.02 = 5_100_000, below the accepted 11_370_000.
    expect(await ceilingFor(5_000_000n)).toBe(5_100_000n);
  });
});

// A sweep claim emits its own pending row; the discovered path owns clearing it.
describe("sweep terminal lifecycle", () => {
  it("clears the pending row before dropping the durable order", async () => {
    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "COMPLETED", terminal: true });

    startSwapKitOrderTracking({
      kind: "discovered",
      txId: "sweep-terminal",
      settleTarget: "0x1111111111111111111111111111111111111111",
      expectedUsdc: 0,
      usdcBaseline: "0",
      sats: 0,
      createdAt: Date.now(),
      attempts: 0,
      recovery: {
        provider: "sweep",
        chainId: 1,
        approvalToken: "0x3333333333333333333333333333333333333333",
        approvalMaxUnits: "11370000",
      },
    });

    await vi.waitFor(() => expect(mocks.removeOrder).toHaveBeenCalledWith("sweep-terminal"));
    expect(mocks.emit).toHaveBeenCalledWith("wallet:clearPendingTransfer", {
      txHash: null,
      orderId: "sweep-terminal",
    });
  });
});

describe("cold-start resume ceiling", () => {
  it("handles LI.FI as the BTC→EURC final hub action without requiring a CoW signature", async () => {
    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "PENDING" });
    mocks.signAndBroadcastBaseMainnetTx.mockResolvedValueOnce({ hash: "0xlifi" });

    startSwapKitOrderTracking({
      kind: "card_topup",
      destination: "wallet",
      txId: "btc-eurc-lifi",
      settleTarget: "0x2222222222222222222222222222222222222222",
      expectedUsdc: 10,
      minEurc: 9,
      usdcBaseline: "0",
      sats: 1000,
      createdAt: 1,
      attempts: 0,
    });
    await vi.waitFor(() => expect(mocks.runSwapKitSwapLoop).toHaveBeenCalled());

    const options = mocks.runSwapKitSwapLoop.mock.calls.at(-1)?.[1];
    const parsed = {
      chainId: 8453,
      to: "0x2222222222222222222222222222222222222222",
      data: "0x1234",
      value: 0n,
    };
    await options.signAction(parsed);

    expect(mocks.signAndBroadcastBaseMainnetTx).toHaveBeenCalledWith({
      ...parsed,
      maxApprovalUnits: 10_200_000n,
    });
    expect(options.signTypedData).toEqual(expect.any(Function));
  });

  it("bounds a resumed order by the quote cap, not by what already left", async () => {
    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "PENDING" });
    mocks.signAndBroadcastBaseMainnetTx.mockResolvedValueOnce({ hash: "0xhash" });

    // 21 EURC quoted, accepted live at 21.213563 (inside the 5% drift). The row
    // keeps the spend for display and the quote as the ceiling — resuming from
    // the spend would apply the multiplier a second time and authorize
    // 22.274…, past the 22.05 the quote allowed.
    resumeSwapKitPendingTracking([
      {
        orderId: "resume-cap",
        txHash: null,
        source: "swapkit",
        amount: 21.213563,
        maxSellEurc: 21,
      },
    ]);
    await vi.waitFor(() => expect(mocks.runSwapKitSwapLoop).toHaveBeenCalled());

    const options = mocks.runSwapKitSwapLoop.mock.calls[0]?.[1];
    const parsed = {
      chainId: 8453,
      to: "0x2222222222222222222222222222222222222222",
      data: "0x1",
      value: 0n,
    };
    await options.signAction(parsed);
    // 21 * 1.05 = 22.05 EURC, in 6-decimal units — NOT 21.213563 * 1.05.
    expect(mocks.signAndBroadcastBaseMainnetTx).toHaveBeenCalledWith({
      ...parsed,
      maxApprovalUnits: 22_050_000n,
    });
  });

  it("resumes unbounded-by-amount when the row predates the cap", async () => {
    mocks.runSwapKitSwapLoop.mockResolvedValueOnce({ status: "PENDING" });

    resumeSwapKitPendingTracking([
      { orderId: "resume-legacy", txHash: null, source: "swapkit", amount: 21.213563 },
    ]);
    await vi.waitFor(() => expect(mocks.runSwapKitSwapLoop).toHaveBeenCalled());

    const options = mocks.runSwapKitSwapLoop.mock.calls[0]?.[1];
    expect(options).not.toHaveProperty("signTypedData");
  });
});

// An order stuck at AWAITING_SIGNATURE is the server saying "your wallet said
// it would sign this and hasn't". When the wallet in question can never sign it
// — a read-only discovered row, or an order a direct swap created and then
// abandoned unsigned — that status is permanent, and polling it is a loop that
// runs for the life of the install and can never change anything.
describe("orders awaiting a signature that will never come", () => {
  const strandedSummary = (overrides: Record<string, unknown> = {}) => ({
    txId: "sk_stranded",
    status: "AWAITING_SIGNATURE",
    settleTarget: "0x2222222222222222222222222222222222222222",
    createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  });

  const listing = (transactions: Array<Record<string, unknown>>) => ({
    fromAddress: "0x1111111111111111111111111111111111111111",
    includeTerminal: false,
    since: null as number | null,
    limit: 100,
    transactions,
  });

  it("leaves direct-journal orders to the bounded direct resume loop", async () => {
    const staleDiscovered = {
      kind: "discovered",
      txId: "sk_direct",
      settleTarget: "0x1111111111111111111111111111111111111111",
      expectedUsdc: 0,
      usdcBaseline: "0",
      sats: 0,
      createdAt: Date.now(),
      attempts: 0,
    };
    let rows = [staleDiscovered];
    mocks.listOrders.mockImplementation(() => rows);
    mocks.removeOrder.mockImplementation(async (txId: string) => {
      rows = rows.filter((row) => row.txId !== txId);
    });
    mocks.listDirectSwaps.mockReturnValue([{ txId: "sk_direct" }]);
    mocks.listSwapKitSwaps.mockResolvedValue(
      listing([
        strandedSummary({
          txId: "sk_direct",
          status: "AWAITING_SIGNATURE",
          createdAt: new Date().toISOString(),
        }),
      ]),
    );

    await hydrateAndResumeSwapKitOrders();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.removeOrder).toHaveBeenCalledWith("sk_direct");
    expect(mocks.addOrder).not.toHaveBeenCalled();
    expect(mocks.runSwapKitSwapLoop).not.toHaveBeenCalled();
    expect(mocks.resumeDirectEvmSwaps).toHaveBeenCalledTimes(1);
  });

  it("never adopts one the server has been holding for hours", async () => {
    mocks.listSwapKitSwaps.mockResolvedValue(listing([strandedSummary()]));

    await hydrateAndResumeSwapKitOrders();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.addOrder).not.toHaveBeenCalled();
    expect(mocks.runSwapKitSwapLoop).not.toHaveBeenCalled();
  });

  it("never adopts a fresh one this app created and walked away from", async () => {
    // Minutes old, so the age rule alone would still adopt it — but the direct
    // swap recorded that it abandoned this order before broadcasting.
    mocks.listAbandonedSwapOrders.mockResolvedValue(new Set(["sk_stranded"]));
    mocks.listSwapKitSwaps.mockResolvedValue(
      listing([strandedSummary({ createdAt: new Date().toISOString() })]),
    );

    await hydrateAndResumeSwapKitOrders();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.addOrder).not.toHaveBeenCalled();
    expect(mocks.runSwapKitSwapLoop).not.toHaveBeenCalled();
  });

  it("drops a row adopted on an earlier start, so this start is the last to poll it", async () => {
    // The store, behaving like the store: what is removed is gone from the list
    // the resume loop reads back.
    let rows = [
      {
        kind: "discovered",
        txId: "sk_stranded",
        settleTarget: "0x2222222222222222222222222222222222222222",
        expectedUsdc: 0,
        usdcBaseline: "0",
        sats: 0,
        createdAt: Date.now() - 3 * 60 * 60 * 1000,
        attempts: 0,
      },
    ];
    mocks.listOrders.mockImplementation(() => rows);
    mocks.removeOrder.mockImplementation(async (txId: string) => {
      rows = rows.filter((row) => row.txId !== txId);
    });
    mocks.listSwapKitSwaps.mockResolvedValue(listing([strandedSummary()]));

    await hydrateAndResumeSwapKitOrders();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.removeOrder).toHaveBeenCalledWith("sk_stranded");
    expect(mocks.runSwapKitSwapLoop).not.toHaveBeenCalled();
  });

  it("leaves a card topup alone — it carries the bounds its own legs sign under", async () => {
    mocks.listOrders.mockReturnValue([
      {
        kind: "card_topup",
        txId: "sk_topup",
        settleTarget: "0x2222222222222222222222222222222222222222",
        expectedUsdc: 18,
        minEurc: 16,
        usdcBaseline: "0",
        sats: 30_000,
        createdAt: Date.now() - 3 * 60 * 60 * 1000,
        attempts: 0,
      },
    ]);
    mocks.listSwapKitSwaps.mockResolvedValue(listing([strandedSummary({ txId: "sk_topup" })]));
    mocks.runSwapKitSwapLoop.mockResolvedValue({ status: "AWAITING_SIGNATURE" });

    await hydrateAndResumeSwapKitOrders();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.removeOrder).not.toHaveBeenCalledWith("sk_topup");
    expect(mocks.runSwapKitSwapLoop).toHaveBeenCalledWith("sk_topup", expect.anything());
  });

  it("leaves an armed sweep claim alone — that one signs its own converts", async () => {
    mocks.listOrders.mockReturnValue([
      {
        kind: "discovered",
        txId: "sk_sweep",
        settleTarget: "0x1111111111111111111111111111111111111111",
        expectedUsdc: 0,
        usdcBaseline: "0",
        sats: 0,
        createdAt: Date.now() - 3 * 60 * 60 * 1000,
        attempts: 0,
        recovery: {
          provider: "sweep",
          chainId: 8453,
          approvalToken: "0x3333333333333333333333333333333333333333",
          approvalMaxUnits: "1000",
        },
      },
    ]);
    mocks.listSwapKitSwaps.mockResolvedValue(listing([strandedSummary({ txId: "sk_sweep" })]));
    mocks.runSwapKitSwapLoop.mockResolvedValue({ status: "AWAITING_SIGNATURE" });

    await hydrateAndResumeSwapKitOrders();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.removeOrder).not.toHaveBeenCalledWith("sk_sweep");
    expect(mocks.runSwapKitSwapLoop).toHaveBeenCalledWith("sk_sweep", expect.anything());
  });
});
