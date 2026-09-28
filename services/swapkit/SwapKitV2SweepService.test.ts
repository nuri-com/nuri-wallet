import { beforeEach, describe, expect, it, vi } from "vitest";

const cache = new Map<string, unknown>();
vi.mock("../balance/TransactionCacheService", () => ({
  getCacheValue: async (key: string) => cache.get(key) ?? null,
  setCacheValue: async (key: string, value: unknown) => {
    cache.set(key, value);
  },
}));
vi.mock("../../lib/secureKeyStorage", () => ({
  getEthereumAddress: vi.fn().mockResolvedValue("0x1111111111111111111111111111111111111111"),
}));
const sweepMock = vi.fn();
vi.mock("./SwapKitV2Service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./SwapKitV2Service")>()),
  sweepSwapKitV2: (...args: unknown[]) => sweepMock(...args),
}));
const trackMock = vi.fn();
vi.mock("./SwapKitV2PendingTracker", () => ({
  startSwapKitV2Tracking: (...args: unknown[]) => trackMock(...args),
  emitV2SwapRefresh: vi.fn(),
}));
vi.mock("./SwapKitV2OrderStore", () => ({
  SwapKitV2OrderStore: { upsert: vi.fn(), hydrate: vi.fn() },
}));
const resolveTokenMock = vi.fn();
vi.mock("./SwapKitTokenRegistry", () => ({
  isSignableChain: (chainId: number) => [8453, 42161].includes(chainId),
  resolveCanonicalToken: (...args: unknown[]) => resolveTokenMock(...args),
}));
vi.mock("./SwapKitEvmSigner", () => ({ SWAPKIT_SWEEP_CHAIN_IDS: [8453, 42161] }));
vi.mock("./SwapKitSweepService", () => ({ sendErc20OnChain: vi.fn() }));
vi.mock("../base/BaseTokenTransferService", () => ({ sendTokenOnBase: vi.fn() }));
vi.mock("./SatoraHtlcRefundService", () => ({
  parseRefundableLocks: (raw: unknown) => (Array.isArray(raw) ? raw : []),
  isTrustedSatoraCoordinator: () => true,
  executeSatoraRefund: vi.fn().mockResolvedValue({ status: "confirmed", txHash: "0xr" }),
}));
vi.mock("./SwapKitV2Executors", () => ({
  makeStandardV2Executors: () => ({}),
}));
vi.mock("./SwapKitV2RecoveryKey", () => ({
  getSwapKitV2RecoveryKey: vi.fn().mockResolvedValue("r".repeat(64)),
}));

import { claimSwapKitSweep, makeSweepV2Executors, scanClaimBlocker } from "./SwapKitV2SweepService";
import { sendErc20OnChain } from "./SwapKitSweepService";

const ARB_TBTC = {
  chainId: 42161,
  address: "0xabc0000000000000000000000000000000000abc",
  symbol: "TBTC",
  asset: "TBTC_ARBITRUM",
  decimals: 18,
};

beforeEach(() => {
  cache.clear();
  sweepMock.mockReset();
  trackMock.mockReset();
  resolveTokenMock.mockReset().mockResolvedValue({
    chainId: 42161,
    address: ARB_TBTC.address,
    decimals: 18,
    symbol: "TBTC",
  });
  vi.mocked(sendErc20OnChain)
    .mockReset()
    .mockResolvedValue("0xsent" as never);
});

describe("scanClaimBlocker", () => {
  it("accepts a claimable off-Base balance", async () => {
    await expect(
      scanClaimBlocker({ ...ARB_TBTC, amount: "0.00012345", signable: true }),
    ).resolves.toBeNull();
  });

  it("refuses unsignable chains, server errors, missing identity", async () => {
    // A non-canonical token on Base is route residue, NOT a held balance: the
    // wallet holds only EURC and USDC there, and the board already states
    // those. Rejecting the whole chain hid money the user could not otherwise
    // reach (Taner, #1361 review 5317893389). It may still be blocked for an
    // honest reason — just never for being on Base.
    expect((await scanClaimBlocker({ ...ARB_TBTC, chainId: 8453, amount: "1" })) ?? "").not.toMatch(
      /on Base/,
    );
    await expect(scanClaimBlocker({ ...ARB_TBTC, amount: "1", signable: false })).resolves.toMatch(
      /not signable/,
    );
    await expect(
      scanClaimBlocker({ ...ARB_TBTC, amount: "1", error: "no executable v2 sweep option" }),
    ).resolves.toMatch(/no executable/);
    resolveTokenMock.mockResolvedValue(null);
    await expect(scanClaimBlocker({ ...ARB_TBTC, amount: "1" })).resolves.toMatch(
      /no local transfer path/,
    );
  });

  it("refuses when gas sponsorship is not ready", async () => {
    await expect(
      scanClaimBlocker({
        ...ARB_TBTC,
        amount: "1",
        readyToConfirm: false,
        gas: { ready: false },
      }),
    ).resolves.toMatch(/gas sponsorship/);
  });
});

describe("makeSweepV2Executors send_asset bounds", () => {
  const item = { ...ARB_TBTC, amount: "0.5" };
  const ctx = { orderId: "ord_1" as never, actionId: "act_1" };

  it("moves the exact scanned token, capped at the detected balance", async () => {
    const executors = await makeSweepV2Executors(item);
    expect(executors).not.toBeNull();
    const result = await executors?.send_asset?.(
      {
        asset: "TBTC_ARBITRUM",
        amount: "0.5",
        to: "0x2222222222222222222222222222222222222222",
        tokenContract: ARB_TBTC.address,
        chainId: 42161,
      },
      ctx,
    );
    expect(result?.txHash).toBe("0xsent");
  });

  it("refuses an amount above the detected balance", async () => {
    const executors = await makeSweepV2Executors(item);
    await expect(
      executors?.send_asset?.(
        {
          asset: "TBTC_ARBITRUM",
          amount: "0.6",
          to: "0x2222222222222222222222222222222222222222",
          tokenContract: ARB_TBTC.address,
          chainId: 42161,
        },
        ctx,
      ),
    ).rejects.toThrow(/exceeds the detected balance/);
  });

  it("refuses an impostor token contract and a foreign chain", async () => {
    const executors = await makeSweepV2Executors(item);
    await expect(
      executors?.send_asset?.(
        {
          asset: "TBTC_ARBITRUM",
          amount: "0.1",
          to: "0x2222222222222222222222222222222222222222",
          tokenContract: "0x9999999999999999999999999999999999999999",
          chainId: 42161,
        },
        ctx,
      ),
    ).rejects.toThrow(/not the scanned contract/);
    await expect(
      executors?.send_asset?.(
        {
          asset: "TBTC_ARBITRUM",
          amount: "0.1",
          to: "0x2222222222222222222222222222222222222222",
          tokenContract: ARB_TBTC.address,
          chainId: 1,
        },
        ctx,
      ),
    ).rejects.toThrow(/does not match the scanned balance/);
  });

  // The live engine names the asset by canonical id only (no tokenContract /
  // chainId). The id must be exactly the scanned balance — symbol AND chain —
  // and the transfer always moves the executor's own canonical token, so a
  // malformed request can never redirect it to another asset.
  it("funds from the canonical asset id alone, as the live server sends it", async () => {
    const executors = await makeSweepV2Executors(item);
    await expect(
      executors?.send_asset?.(
        { asset: "TBTC_ARBITRUM", amount: "0.1", to: "0x2222222222222222222222222222222222222222" },
        ctx,
      ),
    ).resolves.toEqual({ txHash: "0xsent" });
  });

  it("refuses an asset id naming another token or another chain", async () => {
    const executors = await makeSweepV2Executors(item);
    for (const asset of ["USDC_ARBITRUM", "TBTC_ETH", "TBTC", "", "TBTC_NOWHERE"]) {
      await expect(
        executors?.send_asset?.(
          { asset, amount: "0.1", to: "0x2222222222222222222222222222222222222222" },
          ctx,
        ),
      ).rejects.toThrow(/asset|not the scanned balance/);
    }
  });

  it("returns null when the token identity cannot be established", async () => {
    resolveTokenMock.mockResolvedValue(null);
    await expect(makeSweepV2Executors(item)).resolves.toBeNull();
  });

  it("small tBTC-Arbitrum balances survive with full 18-decimal precision", async () => {
    // Regression (plan Phase 4): a small high-decimal balance must not be
    // rounded down to six decimals, and the sent amount never exceeds raw.
    const tiny = { ...ARB_TBTC, amount: "0.000123456789012345" };
    const executors = await makeSweepV2Executors(tiny);
    const result = await executors?.send_asset?.(
      {
        asset: "TBTC_ARBITRUM",
        amount: "0.000123456789012345",
        to: "0x2222222222222222222222222222222222222222",
        tokenContract: ARB_TBTC.address,
        chainId: 42161,
      },
      { orderId: "ord_2" as never, actionId: "act_2" },
    );
    expect(result?.txHash).toBe("0xsent");
    const [, , sentAmount] = vi.mocked(sendErc20OnChain).mock.calls.at(-1) ?? [];
    expect(sentAmount).toBe("0.000123456789012345");
  });
});

describe("claimSwapKitSweep outcome accounting", () => {
  it("starts trackable orders, refuses unbindable ones, counts server errors unresolved", async () => {
    sweepMock.mockResolvedValue({
      items: [
        {
          ...ARB_TBTC,
          amount: "0.5",
          order: { mode: "commit", orderId: "ord_ok1", status: "AWAITING_ACTION", actions: [] },
        },
        { ...ARB_TBTC, amount: "0.5", error: "AUTO_CONVERT_BLOCKED: reserved" },
        {
          ...ARB_TBTC,
          address: "0xdead00000000000000000000000000000000dead",
          amount: "1",
          order: { mode: "commit", orderId: "ord_bad1", status: "AWAITING_ACTION", actions: [] },
        },
      ],
      refundable: [],
    });
    // Third item: registry resolves the canonical token, but the scanned
    // contract differs → unbindable → refused locally.
    const outcome = await claimSwapKitSweep();
    expect(outcome).toEqual({ started: 1, refusedLocally: 1, unresolved: 1, refunded: 0 });
    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock.mock.calls[0][0]).toBe("ord_ok1");
  });

  it("skips already-terminal replayed orders without counting them", async () => {
    sweepMock.mockResolvedValue({
      items: [
        {
          ...ARB_TBTC,
          amount: "0.5",
          order: { mode: "commit", orderId: "ord_done", status: "COMPLETED", actions: [] },
        },
      ],
      refundable: [],
    });
    const outcome = await claimSwapKitSweep();
    expect(outcome).toEqual({ started: 0, refusedLocally: 0, unresolved: 0, refunded: 0 });
    expect(trackMock).not.toHaveBeenCalled();
  });

  it("executes trusted refundable locks first", async () => {
    sweepMock.mockResolvedValue({
      items: [],
      refundable: [
        {
          refundable: true,
          chainId: 42161,
          coordinatorAddress: "0xc",
          preimageHash: `0x${"a".repeat(64)}`,
        },
      ],
    });
    const outcome = await claimSwapKitSweep();
    expect(outcome.refunded).toBe(1);
  });
});

// The claim is the user's whole part in a sweep. The "we found money" screen
// must close the moment the first order is adopted — everything after that runs
// unattended and is carried by the pill and the pending rows, so holding the
// screen until the whole run finishes is a wait with nothing in it.
describe("claimSwapKitSweep handoff", () => {
  it("hands off at the FIRST adopted order, not at the end of the run", async () => {
    const seen: number[] = [];
    trackMock.mockImplementation(() => {
      seen.push(-1);
    });
    sweepMock.mockResolvedValue({
      items: [
        {
          ...ARB_TBTC,
          amount: "0.5",
          order: { mode: "commit", orderId: "ord_a", status: "AWAITING_ACTION", actions: [] },
        },
        {
          ...ARB_TBTC,
          amount: "0.25",
          order: { mode: "commit", orderId: "ord_b", status: "AWAITING_ACTION", actions: [] },
        },
      ],
      refundable: [],
    });
    const handoff = vi.fn(() => seen.push(0));
    const outcome = await claimSwapKitSweep(handoff);

    expect(outcome.started).toBe(2);
    expect(handoff).toHaveBeenCalledTimes(1);
    // Fired after the first tracked order and BEFORE the second one was armed.
    expect(seen).toEqual([-1, 0, -1]);
  });

  it("does not hand off when nothing was armed or refunded", async () => {
    sweepMock.mockResolvedValue({ items: [], refundable: [] });
    const handoff = vi.fn();
    await claimSwapKitSweep(handoff);
    expect(handoff).not.toHaveBeenCalled();
  });

  it("hands off for a run that only refunded", async () => {
    sweepMock.mockResolvedValue({
      items: [],
      refundable: [
        {
          refundable: true,
          chainId: 42161,
          coordinatorAddress: "0xc",
          preimageHash: `0x${"b".repeat(64)}`,
        },
      ],
    });
    const handoff = vi.fn();
    const outcome = await claimSwapKitSweep(handoff);
    expect(outcome.refunded).toBe(1);
    expect(handoff).toHaveBeenCalledTimes(1);
  });
});

// From Taner's review of #1361 (5317893389): the scan rejected EVERY Base asset
// as "a held balance, not a find". Only EURC and USDC are balances this wallet
// holds and the board already states; anything else on Base is route residue -
// money stranded mid-swap that the user has no other way to reach - and
// rejecting the whole chain hid it.
describe("Base residue is claimable; the wallet's own Base balances are not", () => {
  const EURC = "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42";
  const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const baseItem = (address: string, symbol: string) => ({
    chainId: 8453,
    address,
    symbol,
    asset: `${symbol}_BASE`,
    amount: 10,
    signable: true,
    readyToConfirm: true,
  });

  beforeEach(() => {
    resolveTokenMock.mockReset();
    resolveTokenMock.mockReturnValue({
      chainId: 8453,
      address: "0x4200000000000000000000000000000000000006",
      symbol: "WETH",
      decimals: 18,
    });
  });

  it("rejects the wallet's own EURC and USDC", async () => {
    expect(await scanClaimBlocker(baseItem(EURC, "EURC"))).toMatch(/held balance/);
    expect(await scanClaimBlocker(baseItem(USDC, "USDC"))).toMatch(/held balance/);
  });

  it("is case-insensitive about the contract address", async () => {
    expect(await scanClaimBlocker(baseItem(EURC.toUpperCase(), "EURC"))).toMatch(/held balance/);
  });

  it("does NOT dismiss another Base token for being on Base", async () => {
    const blocker = await scanClaimBlocker(
      baseItem("0x4200000000000000000000000000000000000006", "WETH"),
    );
    expect(blocker ?? "").not.toMatch(/held balance/);
  });
});
