import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEthereumAddress: vi.fn(),
  getBaseMainnetErc20Balance: vi.fn(),
  signAndBroadcastBaseMainnetTx: vi.fn(),
  executeSwapKitSwap: vi.fn(),
  routeSwapKitSwap: vi.fn(),
  fetchCuratedRoutes: vi.fn(),
  trackSwapKitSwap: vi.fn(),
  runSwapKitBroadcastStatusLoop: vi.fn(),
  runSwapKitSwapLoop: vi.fn(),
  claimSwapLoop: vi.fn(),
  releaseSwapLoop: vi.fn(),
  listOrders: vi.fn(),
  addDirectSwap: vi.fn(),
  removeDirectSwap: vi.fn(),
  noteDeliberateUsdc: vi.fn(),
  clampDeliberateUsdc: vi.fn(),
  getDeliberateUsdc: vi.fn(),
}));

vi.mock("../../lib/secureKeyStorage", () => ({
  getEthereumAddress: mocks.getEthereumAddress,
}));
vi.mock("../base/BaseTokenTransferService", () => ({
  getBaseMainnetErc20Balance: mocks.getBaseMainnetErc20Balance,
  signAndBroadcastBaseMainnetTx: mocks.signAndBroadcastBaseMainnetTx,
}));
vi.mock("./SwapKitDirectSwapStore", () => ({
  SwapKitDirectSwapStore: {
    hydrate: vi.fn().mockResolvedValue(undefined),
    add: mocks.addDirectSwap,
    addDurable: vi.fn().mockResolvedValue(undefined),
    remove: mocks.removeDirectSwap,
    retireUnsignedDurable: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockReturnValue([]),
  },
  noteDeliberateUsdc: mocks.noteDeliberateUsdc,
  clampDeliberateUsdc: mocks.clampDeliberateUsdc,
  getDeliberateUsdc: mocks.getDeliberateUsdc,
  noteAbandonedSwapOrder: vi.fn().mockResolvedValue(undefined),
  listAbandonedSwapOrders: vi.fn().mockResolvedValue(new Set<string>()),
}));
vi.mock("./SwapKitOrderStore", () => ({
  SwapKitOrderStore: { list: mocks.listOrders },
}));
vi.mock("./SwapKitService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./SwapKitService")>()),
  executeSwapKitSwap: mocks.executeSwapKitSwap,
  routeSwapKitSwap: mocks.routeSwapKitSwap,
  fetchCuratedRoutes: mocks.fetchCuratedRoutes,
  trackSwapKitSwap: mocks.trackSwapKitSwap,
  runSwapKitBroadcastStatusLoop: mocks.runSwapKitBroadcastStatusLoop,
  runSwapKitSwapLoop: mocks.runSwapKitSwapLoop,
  claimSwapLoop: mocks.claimSwapLoop,
  releaseSwapLoop: mocks.releaseSwapLoop,
}));

import { recoverStrandedUsdc } from "./SwapKitUsdcRecoveryService";

const EOA = "0x1111111111111111111111111111111111111111";
const SETTLE = "0x2222222222222222222222222222222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.clampDeliberateUsdc.mockResolvedValue(0);
  mocks.noteDeliberateUsdc.mockResolvedValue(undefined);
  mocks.getEthereumAddress.mockResolvedValue(EOA);
  mocks.claimSwapLoop.mockReturnValue(true);
  // 20 USDC on the EOA, base units (6 decimals) — the live-balance clamp reads
  // this both when pricing and again before signing.
  mocks.getBaseMainnetErc20Balance.mockResolvedValue(20_000_000n);
  // runDirectEvmSwap only executes a curated route that is executable AND
  // productionReady (isExecutableRoute), preferring the pinned lifi provider.
  // The legacy swap_route fallback marks quotes non-executable, so it can never
  // reach execution — the priced curated option is the real recovery path.
  mocks.fetchCuratedRoutes.mockResolvedValue([
    {
      routeId: "lifi-usdc-base-eurc-base",
      path: ["USDC_BASE", "EURC_BASE"],
      providers: ["lifi"],
      totalDeposit: 11,
      totalSettle: 10.5,
      effectiveRate: 10.5 / 11,
      executable: true,
      productionReady: true,
      legs: [{ etaSeconds: 30 }],
    },
  ]);
  mocks.routeSwapKitSwap.mockResolvedValue({ bestExecutable: { settleAmount: 11 } });
  mocks.executeSwapKitSwap.mockResolvedValue({
    txId: "sk_recovery",
    fund: { amount: 11 },
    receive: { amount: 10.5 },
    assist: { signer: EOA },
    actions: [
      {
        type: "sign_and_broadcast_evm_tx",
        chainId: 8453,
        tx: { to: SETTLE, data: "0xdeadbeef", value: "0x0" },
      },
    ],
  });
  mocks.signAndBroadcastBaseMainnetTx.mockResolvedValue({ hash: "0xhash", gas: 1n });
});

const run = () => recoverStrandedUsdc({ settleTarget: SETTLE, usdcAmount: 11, minEurc: 10 });

const SIGN_PARSED = { chainId: 8453, to: SETTLE, data: "0xdeadbeef" as `0x${string}`, value: 0n };

// runSwapKitSwapLoop drives signing through its signAction callback and returns
// the final tracked status. Each case signs once, then settles per its status.
const loopReturning = (status: { status: string; terminal: boolean; explanation?: string }) =>
  mocks.runSwapKitSwapLoop.mockImplementation(
    async (
      _txId: string,
      options: { signAction: (parsed: typeof SIGN_PARSED) => Promise<unknown> },
    ) => {
      await options.signAction(SIGN_PARSED);
      return status;
    },
  );

describe("recoverStrandedUsdc settlement", () => {
  it("treats a non-terminal poll-budget exhaustion as not recovered", async () => {
    // The status loop returns the LAST status when it runs out of polls.
    // Reporting that as recovered would let the caller delete the durable
    // order that is still driving the swap.
    loopReturning({ status: "PROCESSING", terminal: false });

    await expect(run()).rejects.toThrow(/has not settled yet/);
  });

  it("rejects a terminal non-COMPLETED status", async () => {
    loopReturning({ status: "REFUNDED", terminal: true, explanation: "refunded onchain" });

    await expect(run()).rejects.toThrow(/refunded onchain/);
  });

  it("reports recovered only on a terminal COMPLETED", async () => {
    loopReturning({ status: "COMPLETED", terminal: true });

    await expect(run()).resolves.toMatchObject({ txId: "sk_recovery" });
  });
});
