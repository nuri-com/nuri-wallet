import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEthereumAddress: vi.fn(),
  getBaseMainnetErc20Balance: vi.fn(),
  fetchCuratedRoutes: vi.fn(),
  routeSwapKitSwap: vi.fn(),
  executeSwapKitSwap: vi.fn(),
  runSwapKitSwapLoop: vi.fn(),
  claimSwapLoop: vi.fn(),
  releaseSwapLoop: vi.fn(),
  signAndBroadcastBaseMainnetTx: vi.fn(),
  signAndBroadcastSwapKitEvmTx: vi.fn(),
  signCowOrderOnBase: vi.fn(),
  storeAdd: vi.fn(),
  storeAddDurable: vi.fn(),
  storeRemove: vi.fn(),
  storeRetireUnsignedDurable: vi.fn(),
  storeList: vi.fn(),
  listAbandonedSwapOrders: vi.fn(),
  noteAbandonedSwapOrder: vi.fn(),
  getBaseTransactionOutcome: vi.fn(),
}));

vi.mock("../../lib/secureKeyStorage", () => ({ getEthereumAddress: mocks.getEthereumAddress }));
vi.mock("../base/BaseTokenTransferService", () => ({
  getBaseMainnetErc20Balance: mocks.getBaseMainnetErc20Balance,
  getBaseTransactionOutcome: mocks.getBaseTransactionOutcome,
  signAndBroadcastBaseMainnetTx: mocks.signAndBroadcastBaseMainnetTx,
  signCowOrderOnBase: mocks.signCowOrderOnBase,
}));
vi.mock("./SwapKitEvmSigner", () => ({
  signAndBroadcastSwapKitEvmTx: mocks.signAndBroadcastSwapKitEvmTx,
}));
vi.mock("./SwapKitDirectSwapStore", () => ({
  SwapKitDirectSwapStore: {
    hydrate: vi.fn(),
    add: mocks.storeAdd,
    addDurable: mocks.storeAddDurable,
    remove: mocks.storeRemove,
    retireUnsignedDurable: mocks.storeRetireUnsignedDurable,
    list: mocks.storeList,
  },
  listAbandonedSwapOrders: mocks.listAbandonedSwapOrders,
  noteAbandonedSwapOrder: mocks.noteAbandonedSwapOrder,
}));
vi.mock("./SwapKitService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./SwapKitService")>()),
  fetchCuratedRoutes: mocks.fetchCuratedRoutes,
  routeSwapKitSwap: mocks.routeSwapKitSwap,
  executeSwapKitSwap: mocks.executeSwapKitSwap,
  runSwapKitSwapLoop: mocks.runSwapKitSwapLoop,
  claimSwapLoop: mocks.claimSwapLoop,
  releaseSwapLoop: mocks.releaseSwapLoop,
}));

import {
  executeDirectEvmSwap,
  quoteDirectEvmSwaps,
  resumeDirectEvmSwaps,
  runDirectEvmSwap,
} from "./SwapKitDirectEvmSwapService";
import { EURC_BASE_TOKEN, USDC_ARBITRUM_TOKEN, USDC_BASE_TOKEN } from "./SwapKitStableAssets";

const EOA = "0x1111111111111111111111111111111111111111";
const ROUTER = "0x2222222222222222222222222222222222222222";
const SPENDER = "0x3333333333333333333333333333333333333333";
// getBaseTransactionOutcome is only consulted for well-formed 32-byte hashes.
const REVERTED_HASH = `0x${"a".repeat(64)}` as const;
const RETRY_HASH = `0x${"b".repeat(64)}` as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getEthereumAddress.mockResolvedValue(EOA);
  mocks.getBaseMainnetErc20Balance.mockResolvedValue(10_000_000n);
  mocks.claimSwapLoop.mockReturnValue(true);
  mocks.storeList.mockReturnValue([]);
  mocks.listAbandonedSwapOrders.mockResolvedValue(new Set<string>());
  mocks.getBaseTransactionOutcome.mockResolvedValue("success");
  mocks.signAndBroadcastBaseMainnetTx.mockImplementation(async (params) => {
    await params.onBeforeBroadcast?.();
    await params.onBroadcast?.("0xbroadcast");
    return { hash: "0xbroadcast", gas: 123n };
  });
  mocks.signAndBroadcastSwapKitEvmTx.mockImplementation(async (_parsed, options) => {
    await options.onBeforeBroadcast?.();
    await options.onBroadcast?.("0xbroadcast");
    return { hash: "0xbroadcast" };
  });
  mocks.signCowOrderOnBase.mockResolvedValue({ signature: "0xsigned" });
});

const acceptedQuote = (provider: "lifi" | "cow") => ({
  source: EURC_BASE_TOKEN,
  target: { asset: USDC_BASE_TOKEN.asset, symbol: USDC_BASE_TOKEN.symbol },
  settleTarget: EOA,
  sendAmount: 10,
  receiveAmount: provider === "lifi" ? 11.58 : 11.54,
  rate: provider === "lifi" ? 1.158 : 1.154,
  provider,
  path: ["EURC_BASE", "USDC_BASE"],
  routeId: `${provider}-eurc-base-usdc-base`,
  executable: true,
  quotedAt: Date.now(),
  expiresAt: Date.now() + 120_000,
});

describe("direct EVM route discovery", () => {
  it("returns every curated EURC→USDC quote with its route identity and ETA", async () => {
    mocks.fetchCuratedRoutes.mockResolvedValue([
      {
        routeId: "lifi-eurc-base-usdc-base",
        path: ["EURC_BASE", "USDC_BASE"],
        providers: ["lifi"],
        totalDeposit: 10,
        totalSettle: 11.58,
        effectiveRate: 1.158,
        executable: true,
        productionReady: true,
        quoteDeadline: "2026-09-10T21:00:00.000Z",
        legs: [{ etaSeconds: 30 }],
      },
      {
        routeId: "cow-eurc-base-usdc-base",
        path: ["EURC_BASE", "USDC_BASE"],
        providers: ["cow"],
        totalDeposit: 10,
        totalSettle: 11.54,
        effectiveRate: 1.154,
        executable: true,
        productionReady: true,
        legs: [{ etaSeconds: 90 }],
      },
    ]);

    const quotes = await quoteDirectEvmSwaps({
      source: EURC_BASE_TOKEN,
      target: { asset: USDC_BASE_TOKEN.asset, symbol: USDC_BASE_TOKEN.symbol },
      settleTarget: EOA,
      amount: 10,
    });

    expect(quotes).toHaveLength(2);
    expect(quotes.map((quote) => quote.routeId)).toEqual([
      "lifi-eurc-base-usdc-base",
      "cow-eurc-base-usdc-base",
    ]);
    expect(quotes.map((quote) => quote.provider)).toEqual(["lifi", "cow"]);
    expect(quotes.map((quote) => quote.etaSeconds)).toEqual([30, 90]);
    expect(mocks.fetchCuratedRoutes).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "EURC_BASE",
        to: "USDC_BASE",
        walletCapabilities: expect.arrayContaining([
          "sign_and_broadcast_evm_tx",
          "sign_typed_data",
        ]),
      }),
    );
  });

  it("keeps all signed swap_route quotes when curated discovery is unavailable", async () => {
    mocks.fetchCuratedRoutes.mockRejectedValue(new Error("old server"));
    mocks.routeSwapKitSwap.mockResolvedValue({
      quotes: [
        { provider: "lifi", settleAmount: 11.58, execution: "phase2" },
        { provider: "cow", settleAmount: 11.54, execution: "phase2" },
        { provider: "bitcoinvn", settleAmount: 11.4, executable: true },
      ],
    });

    const quotes = await quoteDirectEvmSwaps({
      source: EURC_BASE_TOKEN,
      target: { asset: USDC_BASE_TOKEN.asset, symbol: USDC_BASE_TOKEN.symbol },
      settleTarget: EOA,
      amount: 10,
    });

    expect(quotes.map((quote) => quote.provider)).toEqual(["lifi", "cow", "bitcoinvn"]);
  });

  it("does not report a priced but unavailable recovery as a successful zero swap", async () => {
    mocks.fetchCuratedRoutes.mockRejectedValue(new Error("options unavailable"));
    mocks.routeSwapKitSwap.mockResolvedValue({
      quotes: [{ provider: "lifi", settleAmount: 11.58, execution: "phase2" }],
    });

    await expect(
      runDirectEvmSwap({
        source: EURC_BASE_TOKEN,
        target: { asset: USDC_BASE_TOKEN.asset, symbol: USDC_BASE_TOKEN.symbol },
        settleTarget: EOA,
        amount: 10,
        minReceiveRatio: 0.99,
        op: { scope: "test", action: "recovery" },
      }),
    ).rejects.toThrow("No executable SwapKit route is currently available.");
    expect(mocks.executeSwapKitSwap).not.toHaveBeenCalled();
  });
});

describe("selected direct EVM execution", () => {
  // Blocker from review of 9c1351ea: the confirmed-revert branch existed only in
  // resumeDirectEvmSwaps(), so a revert DURING the active loop left
  // liveBroadcastHash pinned and the loop kept handing back the dead hash — the
  // promised retry then needed an app restart. The active run must re-sign too.
  it("re-signs within the active loop after a broadcast confirms as reverted", async () => {
    mocks.executeSwapKitSwap.mockResolvedValue({
      txId: "sk_live_revert",
      route: { totalDeposit: 10, totalSettle: 11.57, path: ["EURC_BASE", "USDC_BASE"] },
      assist: { signer: EOA },
      actions: [{ type: "sign_and_broadcast_evm_tx" }],
    });
    mocks.signAndBroadcastBaseMainnetTx
      .mockImplementationOnce(async (params) => {
        await params.onBeforeBroadcast?.();
        await params.onBroadcast?.(REVERTED_HASH);
        return { hash: REVERTED_HASH, gas: 123n };
      })
      .mockImplementationOnce(async (params) => {
        await params.onBeforeBroadcast?.();
        await params.onBroadcast?.(RETRY_HASH);
        return { hash: RETRY_HASH, gas: 123n };
      });
    mocks.getBaseTransactionOutcome.mockResolvedValue("reverted");
    const action = {
      chainId: 8453,
      to: ROUTER,
      data: "0x1234",
      value: 0n,
      approval: { token: EURC_BASE_TOKEN.token, spender: SPENDER, amount: 10_200_000n },
    };
    mocks.runSwapKitSwapLoop.mockImplementation(async (_txId, options) => {
      await options.signAction(action);
      // The server rebuilds the action and asks again after the revert.
      const second = await options.signAction({ ...action, data: "0xrebuilt" });
      expect(second.hash).toBe(RETRY_HASH);
      return { status: "COMPLETED", terminal: true };
    });

    await executeDirectEvmSwap({
      quote: acceptedQuote("lifi"),
      minReceive: 11.4642,
      op: { scope: "test", action: "lifi" },
    });

    // Signed twice: the dead hash was NOT handed back a second time.
    expect(mocks.signAndBroadcastBaseMainnetTx).toHaveBeenCalledTimes(2);
    expect(
      mocks.storeAddDurable.mock.calls.some(
        ([row]) =>
          row.txId === "sk_live_revert" &&
          Array.isArray(row.revertedHashes) &&
          row.revertedHashes.includes(REVERTED_HASH),
      ),
    ).toBe(true);
  });

  it("stops signing in the active loop once RESIGN_LIMIT reverts are reached", async () => {
    mocks.executeSwapKitSwap.mockResolvedValue({
      txId: "sk_live_hopeless",
      route: { totalDeposit: 10, totalSettle: 11.57, path: ["EURC_BASE", "USDC_BASE"] },
      assist: { signer: EOA },
      actions: [{ type: "sign_and_broadcast_evm_tx" }],
    });
    mocks.getBaseTransactionOutcome.mockResolvedValue("reverted");
    mocks.signAndBroadcastBaseMainnetTx.mockImplementation(async (params) => {
      await params.onBeforeBroadcast?.();
      await params.onBroadcast?.(REVERTED_HASH);
      return { hash: REVERTED_HASH, gas: 123n };
    });
    const action = {
      chainId: 8453,
      to: ROUTER,
      data: "0x1234",
      value: 0n,
      approval: { token: EURC_BASE_TOKEN.token, spender: SPENDER, amount: 10_200_000n },
    };
    mocks.runSwapKitSwapLoop.mockImplementation(async (_txId, options) => {
      // Each attempt after the first observes the previous revert, so the third
      // recorded revert — and the refusal — lands on the fourth request.
      for (let i = 0; i < 4; i++) {
        await options.signAction(action).catch((): undefined => undefined);
      }
      return { status: "PROCESSING", terminal: false };
    });

    await executeDirectEvmSwap({
      quote: acceptedQuote("lifi"),
      minReceive: 11.4642,
      op: { scope: "test", action: "lifi" },
    }).catch((): undefined => undefined);

    // Three signatures maximum, then the order is retired abandoned-first.
    expect(mocks.signAndBroadcastBaseMainnetTx.mock.calls.length).toBeLessThanOrEqual(3);
    expect(mocks.noteAbandonedSwapOrder).toHaveBeenCalledWith("sk_live_hopeless");
  });

  it("executes the accepted LI.FI route and reports its bounded broadcast through swap_track", async () => {
    mocks.executeSwapKitSwap.mockResolvedValue({
      txId: "sk_lifi",
      route: {
        totalDeposit: 10,
        totalSettle: 11.57,
        path: ["EURC_BASE", "USDC_BASE"],
      },
      assist: { signer: EOA },
      actions: [{ type: "sign_and_broadcast_evm_tx" }],
    });
    mocks.runSwapKitSwapLoop.mockImplementation(async (_txId, options) => {
      await options.signAction({
        chainId: 8453,
        to: ROUTER,
        data: "0x1234",
        value: 0n,
        approval: { token: EURC_BASE_TOKEN.token, spender: SPENDER, amount: 10_200_000n },
      });
      return { status: "COMPLETED", terminal: true };
    });

    await executeDirectEvmSwap({
      quote: acceptedQuote("lifi"),
      minReceive: 11.4642,
      op: { scope: "test", action: "lifi" },
    });

    expect(mocks.executeSwapKitSwap).toHaveBeenCalledWith(
      expect.objectContaining({
        routeId: "lifi-eurc-base-usdc-base",
        from: "EURC_BASE",
        to: "USDC_BASE",
      }),
    );
    expect(mocks.signAndBroadcastBaseMainnetTx).toHaveBeenCalledWith(
      expect.objectContaining({ maxApprovalUnits: 10_200_000n }),
    );
    expect(mocks.runSwapKitSwapLoop).toHaveBeenCalledWith(
      "sk_lifi",
      expect.objectContaining({ signAction: expect.any(Function) }),
    );
    expect(mocks.storeAddDurable).toHaveBeenCalledWith(
      expect.objectContaining({
        txId: "sk_lifi",
        routeId: "lifi-eurc-base-usdc-base",
        tracking: "swap_track",
        settleTarget: EOA,
        owner: EOA,
        amount: 10,
        minReceive: 11.4642,
      }),
    );
    expect(
      mocks.storeAddDurable.mock.calls.some(
        ([row]) => Number.isFinite(row.broadcastStartedAt) && row.broadcastHash == null,
      ),
    ).toBe(true);
    expect(
      mocks.storeAddDurable.mock.calls.some(
        ([row]) => Number.isFinite(row.broadcastStartedAt) && row.broadcastHash === "0xbroadcast",
      ),
    ).toBe(true);
  });

  it("executes the accepted CoW route with token, receiver, and accepted output bounds", async () => {
    mocks.executeSwapKitSwap.mockResolvedValue({
      txId: "sk_cow",
      fund: { amount: 10 },
      receive: { amount: 11.53 },
      assist: { signer: EOA },
      actions: [{ type: "sign_typed_data" }],
    });
    mocks.runSwapKitSwapLoop.mockImplementation(async (_txId, options) => {
      await options.signTypedData({ actionId: "cow-action" });
      return { status: "COMPLETED", terminal: true };
    });

    await executeDirectEvmSwap({
      quote: acceptedQuote("cow"),
      minReceive: 11.4,
      op: { scope: "test", action: "cow" },
    });

    expect(mocks.executeSwapKitSwap).toHaveBeenCalledWith(
      expect.objectContaining({ routeId: "cow-eurc-base-usdc-base" }),
    );
    expect(mocks.signCowOrderOnBase).toHaveBeenCalledWith(
      { actionId: "cow-action" },
      expect.objectContaining({
        sellToken: EURC_BASE_TOKEN.token,
        buyToken: USDC_BASE_TOKEN.token,
        receiver: EOA,
        maxSellAmount: 10_200_000n,
        minBuyAmount: 11_400_000n,
      }),
    );
    expect(mocks.signAndBroadcastBaseMainnetTx).not.toHaveBeenCalled();
  });

  it("retires an unsigned tracked order before allowing the caller to retry", async () => {
    mocks.executeSwapKitSwap.mockResolvedValue({
      txId: "sk_unsigned",
      fund: { amount: 10 },
      receive: { amount: 11.57 },
      assist: { signer: EOA },
      actions: [{ type: "sign_and_broadcast_evm_tx" }],
    });
    mocks.runSwapKitSwapLoop.mockRejectedValue(new Error("poll budget exhausted before action"));

    await expect(
      executeDirectEvmSwap({
        quote: acceptedQuote("lifi"),
        minReceive: 11.4,
        op: { scope: "test", action: "unsigned" },
      }),
    ).rejects.toThrow("poll budget exhausted before action");

    expect(mocks.signAndBroadcastBaseMainnetTx).not.toHaveBeenCalled();
    expect(mocks.storeRetireUnsignedDurable).toHaveBeenCalledWith("sk_unsigned");
    expect(mocks.noteAbandonedSwapOrder).toHaveBeenCalledWith("sk_unsigned");
  });

  it("suppresses retry when durable unsigned retirement cannot be verified", async () => {
    mocks.executeSwapKitSwap.mockResolvedValue({
      txId: "sk_unretired",
      fund: { amount: 10 },
      receive: { amount: 11.57 },
      assist: { signer: EOA },
      actions: [{ type: "sign_and_broadcast_evm_tx" }],
    });
    mocks.runSwapKitSwapLoop.mockRejectedValue(new Error("poll budget exhausted before action"));
    mocks.storeRetireUnsignedDurable.mockRejectedValue(new Error("retirement write failed"));

    await expect(
      executeDirectEvmSwap({
        quote: acceptedQuote("lifi"),
        minReceive: 11.4,
        op: { scope: "test", action: "unretired" },
      }),
    ).rejects.toMatchObject({ postPayment: true });
    expect(mocks.noteAbandonedSwapOrder).not.toHaveBeenCalledWith("sk_unretired");
  });

  it("keeps a broadcast-intent journal and blocks retry when the hash outcome is unknown", async () => {
    mocks.executeSwapKitSwap.mockResolvedValue({
      txId: "sk_unknown_after_send",
      fund: { amount: 10 },
      receive: { amount: 11.57 },
      assist: { signer: EOA },
      actions: [{ type: "sign_and_broadcast_evm_tx" }],
    });
    mocks.signAndBroadcastBaseMainnetTx.mockImplementationOnce(async (params) => {
      await params.onBeforeBroadcast?.();
      throw new Error("connection closed after submission");
    });
    mocks.runSwapKitSwapLoop.mockImplementationOnce(async (_txId, options) => {
      const action = {
        chainId: 8453,
        to: ROUTER,
        data: "0xdeadbeef",
        value: 0n,
        approval: { token: EURC_BASE_TOKEN.token, spender: ROUTER, amount: 10_000_000n },
      };
      await options.signAction(action).catch((): undefined => undefined);
      await options.signAction(action);
    });

    const error = await executeDirectEvmSwap({
      quote: acceptedQuote("lifi"),
      minReceive: 11.4,
      op: { scope: "test", action: "unknown-broadcast" },
    }).catch((cause) => cause);

    expect(error).toMatchObject({
      message: "Direct swap broadcast already started; refusing to sign the same order again.",
      postPayment: true,
    });
    expect(mocks.signAndBroadcastBaseMainnetTx).toHaveBeenCalledTimes(1);
    expect(
      mocks.storeAddDurable.mock.calls.some(
        ([row]) => Number.isFinite(row.broadcastStartedAt) && row.broadcastHash === undefined,
      ),
    ).toBe(true);
    expect(mocks.storeRemove).not.toHaveBeenCalledWith("sk_unknown_after_send");
    expect(mocks.noteAbandonedSwapOrder).not.toHaveBeenCalledWith("sk_unknown_after_send");
  });

  it("reuses the in-memory hash instead of rebroadcasting when hash journaling fails", async () => {
    mocks.executeSwapKitSwap.mockResolvedValue({
      txId: "sk_hash_journal_failure",
      fund: { amount: 10 },
      receive: { amount: 11.57 },
      assist: { signer: EOA },
      actions: [{ type: "sign_and_broadcast_evm_tx" }],
    });
    mocks.storeAddDurable
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("durable hash write failed"));
    mocks.runSwapKitSwapLoop.mockImplementationOnce(async (_txId, options) => {
      const action = {
        chainId: 8453,
        to: ROUTER,
        data: "0xdeadbeef",
        value: 0n,
        approval: { token: EURC_BASE_TOKEN.token, spender: ROUTER, amount: 10_000_000n },
      };
      await options.signAction(action).catch((): undefined => undefined);
      await expect(options.signAction(action)).resolves.toEqual({ hash: "0xbroadcast" });
      return { status: "COMPLETED", terminal: true };
    });

    await expect(
      executeDirectEvmSwap({
        quote: acceptedQuote("lifi"),
        minReceive: 11.4,
        op: { scope: "test", action: "hash-journal-failure" },
      }),
    ).resolves.toMatchObject({ txId: "sk_hash_journal_failure" });
    expect(mocks.signAndBroadcastBaseMainnetTx).toHaveBeenCalledTimes(1);
  });

  it("never resumes a direct signer under a different logged-in EOA", async () => {
    mocks.storeList.mockReturnValue([
      {
        txId: "sk_other_owner",
        provider: "cow",
        routeId: "cow-eurc-base-usdc-base",
        tracking: "swap_track",
        fromAsset: "EURC_BASE",
        toAsset: "USDC_BASE",
        settleTarget: EOA,
        owner: "0x9999999999999999999999999999999999999999",
        amount: 10,
        minReceive: 11.4,
        chainId: 8453,
        createdAt: Date.now(),
      },
    ]);

    await resumeDirectEvmSwaps();

    expect(mocks.claimSwapLoop).not.toHaveBeenCalledWith("sk_other_owner");
    expect(mocks.runSwapKitSwapLoop).not.toHaveBeenCalled();
    expect(mocks.signCowOrderOnBase).not.toHaveBeenCalled();
    expect(mocks.storeRemove).toHaveBeenCalledWith("sk_other_owner");
  });

  it("never resumes a direct row marked abandoned", async () => {
    mocks.storeList.mockReturnValue([
      {
        txId: "sk_abandoned",
        provider: "lifi",
        routeId: "lifi-eurc-base-usdc-base",
        tracking: "swap_track",
        fromAsset: "EURC_BASE",
        toAsset: "USDC_BASE",
        settleTarget: EOA,
        owner: EOA,
        amount: 10,
        minReceive: 11.4,
        chainId: 8453,
        createdAt: Date.now(),
        abandonedAt: Date.now(),
      },
    ]);

    await resumeDirectEvmSwaps();

    expect(mocks.claimSwapLoop).not.toHaveBeenCalledWith("sk_abandoned");
    expect(mocks.runSwapKitSwapLoop).not.toHaveBeenCalled();
    expect(mocks.storeRemove).toHaveBeenCalledWith("sk_abandoned");
  });

  it("never resumes a direct row in the abandoned-order registry", async () => {
    mocks.listAbandonedSwapOrders.mockResolvedValue(new Set(["sk_abandoned_registry"]));
    mocks.storeList.mockReturnValue([
      {
        txId: "sk_abandoned_registry",
        provider: "lifi",
        routeId: "lifi-eurc-base-usdc-base",
        tracking: "swap_track",
        fromAsset: "EURC_BASE",
        toAsset: "USDC_BASE",
        settleTarget: EOA,
        owner: EOA,
        amount: 10,
        minReceive: 11.4,
        chainId: 8453,
        createdAt: Date.now(),
      },
    ]);

    await resumeDirectEvmSwaps();

    expect(mocks.claimSwapLoop).not.toHaveBeenCalledWith("sk_abandoned_registry");
    expect(mocks.runSwapKitSwapLoop).not.toHaveBeenCalled();
    expect(mocks.storeRemove).toHaveBeenCalledWith("sk_abandoned_registry");
  });

  it("resumes an already-broadcast route without installing another signer", async () => {
    mocks.storeList.mockReturnValue([
      {
        txId: "sk_broadcast",
        provider: "lifi",
        routeId: "lifi-eurc-base-usdc-base",
        tracking: "swap_track",
        fromAsset: "EURC_BASE",
        toAsset: "USDC_BASE",
        settleTarget: EOA,
        owner: EOA,
        amount: 10,
        minReceive: 11.4,
        chainId: 8453,
        createdAt: Date.now(),
        broadcastHash: "0xalreadybroadcast",
      },
    ]);
    mocks.runSwapKitSwapLoop.mockResolvedValue({ status: "COMPLETED", terminal: true });

    await resumeDirectEvmSwaps();

    expect(mocks.runSwapKitSwapLoop).toHaveBeenCalledWith(
      "sk_broadcast",
      expect.objectContaining({ depositTxHash: "0xalreadybroadcast" }),
    );
    const options = mocks.runSwapKitSwapLoop.mock.calls[0]?.[1];
    expect(options).not.toHaveProperty("signAction");
    expect(options).not.toHaveProperty("signTypedData");
    expect(mocks.signAndBroadcastBaseMainnetTx).not.toHaveBeenCalled();
  });

  // Regression for sk_38670dfb (EURC_BASE->USDC_BASE, 2026-09-21): the swap tx reverted
  // out-of-gas, the server reopened the leg to AWAITING_SIGNATURE, but the wallet kept
  // re-reporting the SAME dead hash (23 times) and never retried. A confirmed revert moved
  // nothing — the input token is still in the EOA — so the row must clear the hash, record
  // it, and sign a freshly rebuilt action.
  it("retries a route whose broadcast confirmed as reverted onchain", async () => {
    mocks.storeList.mockReturnValue([
      {
        txId: "sk_reverted",
        provider: "lifi",
        routeId: "lifi-eurc-base-usdc-base",
        tracking: "swap_track",
        fromAsset: "EURC_BASE",
        toAsset: "USDC_BASE",
        settleTarget: EOA,
        owner: EOA,
        amount: 174,
        minReceive: 198,
        chainId: 8453,
        createdAt: Date.now(),
        broadcastHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    ]);
    mocks.getBaseTransactionOutcome.mockResolvedValue("reverted");
    mocks.runSwapKitSwapLoop.mockResolvedValue({ status: "PROCESSING", terminal: false });

    await resumeDirectEvmSwaps();

    // The dead hash is journalled and cleared…
    expect(
      mocks.storeAddDurable.mock.calls.some(
        ([row]) =>
          row.txId === "sk_reverted" &&
          row.broadcastHash === undefined &&
          Array.isArray(row.revertedHashes) &&
          row.revertedHashes.includes(
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          ),
      ),
    ).toBe(true);
    // …and the resumed run is signable again, no longer pinned to the reverted tx.
    const options = mocks.runSwapKitSwapLoop.mock.calls[0]?.[1];
    expect(options).not.toHaveProperty("depositTxHash");
    expect(options).toHaveProperty("signAction");
    expect(mocks.storeRemove).not.toHaveBeenCalledWith("sk_reverted");
  });

  it("retires a route that has already reverted RESIGN_LIMIT times", async () => {
    mocks.storeList.mockReturnValue([
      {
        txId: "sk_hopeless",
        provider: "lifi",
        routeId: "lifi-eurc-base-usdc-base",
        tracking: "swap_track",
        fromAsset: "EURC_BASE",
        toAsset: "USDC_BASE",
        settleTarget: EOA,
        owner: EOA,
        amount: 174,
        minReceive: 198,
        chainId: 8453,
        createdAt: Date.now(),
        broadcastHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        revertedHashes: [
          "0x1111111111111111111111111111111111111111111111111111111111111111",
          "0x2222222222222222222222222222222222222222222222222222222222222222",
        ],
      },
    ]);
    mocks.getBaseTransactionOutcome.mockResolvedValue("reverted");

    await resumeDirectEvmSwaps();

    expect(mocks.storeRemove).toHaveBeenCalledWith("sk_hopeless");
    expect(mocks.runSwapKitSwapLoop).not.toHaveBeenCalled();
    expect(mocks.signAndBroadcastBaseMainnetTx).not.toHaveBeenCalled();
    // A bare drop leaves the server order AWAITING_SIGNATURE, so owner
    // discovery re-adopts it as a useless row until the intent TTL expires.
    expect(mocks.noteAbandonedSwapOrder).toHaveBeenCalledWith("sk_hopeless");
  });

  // A pending hash has no receipt. Treating "unknown" as reverted would make the wallet sign a
  // SECOND transaction for a swap that is about to land, so only a confirmed revert may retry.
  it("does not retry while the broadcast is still pending", async () => {
    mocks.storeList.mockReturnValue([
      {
        txId: "sk_pending",
        provider: "lifi",
        routeId: "lifi-eurc-base-usdc-base",
        tracking: "swap_track",
        fromAsset: "EURC_BASE",
        toAsset: "USDC_BASE",
        settleTarget: EOA,
        owner: EOA,
        amount: 174,
        minReceive: 198,
        chainId: 8453,
        createdAt: Date.now(),
        broadcastHash: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      },
    ]);
    mocks.getBaseTransactionOutcome.mockResolvedValue("pending");
    mocks.runSwapKitSwapLoop.mockResolvedValue({ status: "PROCESSING", terminal: false });

    await resumeDirectEvmSwaps();

    const options = mocks.runSwapKitSwapLoop.mock.calls[0]?.[1];
    expect(options).toHaveProperty(
      "depositTxHash",
      "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    );
    expect(options).not.toHaveProperty("signAction");
    expect(mocks.signAndBroadcastBaseMainnetTx).not.toHaveBeenCalled();
  });

  it("never re-signs a route whose durable journal says broadcast started but has no hash", async () => {
    mocks.storeList.mockReturnValue([
      {
        txId: "sk_unknown_broadcast",
        provider: "lifi",
        routeId: "lifi-eurc-base-usdc-base",
        tracking: "swap_track",
        fromAsset: "EURC_BASE",
        toAsset: "USDC_BASE",
        settleTarget: EOA,
        owner: EOA,
        amount: 10,
        minReceive: 11.4,
        chainId: 8453,
        createdAt: Date.now(),
        broadcastStartedAt: Date.now(),
      },
    ]);
    mocks.runSwapKitSwapLoop.mockResolvedValue({ status: "PROCESSING", terminal: false });

    await resumeDirectEvmSwaps();

    const options = mocks.runSwapKitSwapLoop.mock.calls[0]?.[1];
    expect(options).not.toHaveProperty("signAction");
    expect(options).not.toHaveProperty("signTypedData");
    expect(options).not.toHaveProperty("depositTxHash");
    expect(mocks.signAndBroadcastBaseMainnetTx).not.toHaveBeenCalled();
  });

  it("does not rebroadcast an Arbitrum resume after an ambiguous first send", async () => {
    mocks.storeList.mockReturnValue([
      {
        txId: "sk_arbitrum_unknown",
        provider: "lifi",
        routeId: "lifi-usdc-arbitrum-eurc-base",
        tracking: "swap_track",
        fromAsset: "USDC_ARBITRUM",
        toAsset: "EURC_BASE",
        settleTarget: EOA,
        owner: EOA,
        amount: 10,
        minReceive: 9.8,
        chainId: 42161,
        createdAt: Date.now(),
      },
    ]);
    mocks.signAndBroadcastSwapKitEvmTx.mockImplementationOnce(async (_parsed, options) => {
      await options.onBeforeBroadcast?.();
      throw new Error("connection closed after submission");
    });
    mocks.runSwapKitSwapLoop.mockImplementationOnce(async (_txId, options) => {
      const action = {
        chainId: 42161,
        to: ROUTER,
        data: "0xdeadbeef",
        value: 0n,
        approval: { token: USDC_ARBITRUM_TOKEN.token, spender: ROUTER, amount: 10_000_000n },
      };
      await options.signAction(action).catch((): undefined => undefined);
      await options.signAction(action);
    });

    await resumeDirectEvmSwaps();

    expect(mocks.signAndBroadcastSwapKitEvmTx).toHaveBeenCalledTimes(1);
    expect(
      mocks.storeAddDurable.mock.calls.some(
        ([row]) => Number.isFinite(row.broadcastStartedAt) && row.broadcastHash === undefined,
      ),
    ).toBe(true);
    expect(mocks.storeRemove).not.toHaveBeenCalledWith("sk_arbitrum_unknown");
  });

  it("resumes an Arbitrum USDC recovery with the correct chain and token", async () => {
    mocks.storeList.mockReturnValue([
      {
        txId: "sk_arbitrum",
        provider: "lifi",
        routeId: "lifi-usdc-arbitrum-eurc-base",
        tracking: "swap_track",
        fromAsset: "USDC_ARBITRUM",
        toAsset: "EURC_BASE",
        settleTarget: EOA,
        owner: EOA,
        amount: 10,
        minReceive: 9.8,
        chainId: 42161,
        createdAt: Date.now(),
        broadcastHash: "0xarbitrum",
      },
    ]);
    mocks.runSwapKitSwapLoop.mockResolvedValue({ status: "COMPLETED", terminal: true });

    await resumeDirectEvmSwaps();

    expect(mocks.runSwapKitSwapLoop).toHaveBeenCalledWith(
      "sk_arbitrum",
      expect.objectContaining({
        depositTxHash: "0xarbitrum",
        allowedActionChains: [42161],
        allowedApprovalTokens: [USDC_ARBITRUM_TOKEN.token],
      }),
    );
  });
});
