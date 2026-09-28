import { beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "0x3333333333333333333333333333333333333333";
const REFUNDABLE_LOCK = {
  preimageHash: `0x${"ab".repeat(32)}`,
  chainId: 42161,
  coordinatorAddress: "0xdb76F29f1d04D1202f56a34549869b070DFcBfF0",
  token: "0x6c84a8f1c29108F47a79964b5Fe888D4f4D0dE40",
  claimAddress: "0x5ce278AAec6d9fa67bFcaF98512fE5175dFEebac",
  amountRaw: "149011072672818",
  timelock: 1789090352,
  refundable: true,
};

const mocks = vi.hoisted(() => ({
  sweepSwapKit: vi.fn(),
  trackSwapKitSwap: vi.fn(),
  getEthereumAddress: vi.fn(),
  getCacheValue: vi.fn(),
  setCacheValue: vi.fn(),
  addOrder: vi.fn(),
  listOrders: vi.fn(),
  startTracking: vi.fn(),
  emitRefresh: vi.fn(),
  estimateGas: vi.fn(),
  sendTransaction: vi.fn(),
  getPrivateKey: vi.fn(),
  resolveCanonicalToken: vi.fn(),
  emitEvent: vi.fn(),
  executeSatoraRefund: vi.fn(),
}));

vi.mock("../events/AppEventBusService", () => ({
  EventBus: { emit: mocks.emitEvent, on: vi.fn(() => () => {}) },
}));

// The registry the sweep binds against — the same LI.FI-backed resolution the
// server uses. Stubbed with the canonical answers for the chains under test.
vi.mock("./SwapKitTokenRegistry", () => ({
  isSignableChain: (chainId: number) => [1, 10, 100, 137, 8453, 42161].includes(Number(chainId)),
  resolveCanonicalToken: mocks.resolveCanonicalToken,
}));

vi.mock("./SwapKitService", () => ({
  sweepSwapKit: mocks.sweepSwapKit,
  trackSwapKitSwap: mocks.trackSwapKitSwap,
}));
vi.mock("./SatoraHtlcRefundService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./SatoraHtlcRefundService")>()),
  executeSatoraRefund: mocks.executeSatoraRefund,
}));
// The deposit transfer is now awaited before an order is persisted, so the
// ERC-20 send has to resolve for a deposit-style claim to count.
vi.mock("viem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("viem")>()),
  createPublicClient: () => ({ estimateGas: mocks.estimateGas }),
  createWalletClient: () => ({ sendTransaction: mocks.sendTransaction }),
}));
vi.mock("viem/accounts", () => ({
  privateKeyToAccount: () => ({ address: "0x1111111111111111111111111111111111111111" }),
}));
vi.mock("../../lib/crypto", () => ({
  bytesToHex: () => "00".repeat(32),
  zeroize: vi.fn(),
}));
vi.mock("../../lib/secureKeyStorage", () => ({
  getEthereumAddress: mocks.getEthereumAddress,
  getPrivateKey: mocks.getPrivateKey,
}));
vi.mock("../balance/TransactionCacheService", () => ({
  getCacheValue: mocks.getCacheValue,
  setCacheValue: mocks.setCacheValue,
}));
// Hand-written rather than partial: the real module pulls in the Nostr backup
// stack, which this suite has no business loading.
vi.mock("./SwapKitOrderStore", () => ({
  SWEEP_FUNDING_STATUS: "FUNDING",
  SwapKitOrderStore: {
    add: mocks.addOrder,
    list: mocks.listOrders,
  },
}));
vi.mock("./SwapKitPendingTracker", () => ({
  startSwapKitOrderTracking: mocks.startTracking,
  emitSwapRefresh: mocks.emitRefresh,
}));
vi.mock("./SwapKitEvmSigner", () => ({
  SWAPKIT_SWEEP_CHAIN_IDS: [1, 10, 56, 100, 137, 8453, 42161, 43114],
  getSweepViemChain: (chainId: number) => ({ id: Number(chainId), name: `chain-${chainId}` }),
  getSweepChainIdByLabel: (label: string) =>
    ({ ethereum: 1, base: 8453, arbitrum: 42161, "arbitrum one": 42161 })[
      String(label).toLowerCase()
    ],
}));

import { checkSwapKitSweep, claimSwapKitSweep, scanClaimBlocker } from "./SwapKitSweepService";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getEthereumAddress.mockResolvedValue("0x1111111111111111111111111111111111111111");
  mocks.getCacheValue.mockResolvedValue(null);
  mocks.addOrder.mockResolvedValue(undefined);
  mocks.listOrders.mockReturnValue([]);
  mocks.trackSwapKitSwap.mockResolvedValue(undefined);
  mocks.getPrivateKey.mockResolvedValue(new Uint8Array(32));
  mocks.estimateGas.mockResolvedValue(100_000n);
  mocks.sendTransaction.mockResolvedValue(`0x${"ab".repeat(32)}`);
  mocks.resolveCanonicalToken.mockImplementation(async (chainId: number, symbol: string) => {
    const key = `${chainId}:${String(symbol).toUpperCase()}`;
    const canonical: Record<string, { address: string; decimals: number }> = {
      "42161:USDC": { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
      "42161:USDT": { address: "0x4444444444444444444444444444444444444444", decimals: 6 },
      "42161:TBTC": { address: "0x6c84a8f1c29108F47a79964b5Fe888D4f4D0dE40", decimals: 18 },
      "8453:USDC": { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
      "137:DAI": { address: "0x5555555555555555555555555555555555555555", decimals: 18 },
    };
    const hit = canonical[key];
    return hit ? { chainId: Number(chainId), symbol, ...hit } : null;
  });
});

describe("claimSwapKitSweep approval binding", () => {
  it("persists the exact scanned chain and token contract on the order", async () => {
    mocks.sweepSwapKit.mockResolvedValueOnce({
      items: [
        {
          chainId: 42161,
          chain: "arbitrum",
          symbol: "USDC",
          address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
          amount: 11.37,
          convert: { txId: "sweep-1" },
        },
      ],
    });

    await expect(claimSwapKitSweep()).resolves.toMatchObject({ started: 1 });
    expect(mocks.addOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        txId: "sweep-1",
        recovery: expect.objectContaining({
          provider: "sweep",
          chainId: 42161,
          approvalToken: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        }),
      }),
    );
  });

  it("does not arm a sweep action without a valid local token binding", async () => {
    mocks.sweepSwapKit.mockResolvedValueOnce({
      items: [{ chainId: 1, convert: { txId: "sweep-unbound" } }],
    });

    await expect(claimSwapKitSweep()).resolves.toMatchObject({ started: 0 });
    expect(mocks.addOrder).not.toHaveBeenCalled();
  });

  it("declares only chains a sweep can actually be carried through on", async () => {
    mocks.sweepSwapKit.mockResolvedValueOnce({ items: [] });

    await claimSwapKitSweep();
    // The signer supports eight chains, but funding and the approval ceiling
    // both need a SWEEP_TOKENS entry — advertising the rest would have the
    // server arm orders this app then refuses, stranding them server-side.
    expect(mocks.sweepSwapKit).toHaveBeenCalledWith(
      expect.objectContaining({ signableChains: [1, 10, 100, 137, 8453, 42161] }),
    );
  });
});

describe("claimSwapKitSweep deposit fundability", () => {
  const ARBITRUM_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
  const DEPOSIT = "0x2222222222222222222222222222222222222222";

  it("arms a deposit whose instruction arrives as a send_asset action", async () => {
    mocks.sweepSwapKit.mockResolvedValueOnce({
      items: [
        {
          chainId: 42161,
          chain: "arbitrum",
          symbol: "USDC",
          address: ARBITRUM_USDC,
          amount: 11.37,
          convert: {
            txId: "sweep-send-asset",
            actions: [{ type: "send_asset", to: DEPOSIT, amount: "11.37" }],
          },
        },
      ],
    });

    await expect(claimSwapKitSweep()).resolves.toMatchObject({ started: 1 });
    expect(mocks.addOrder).toHaveBeenCalledWith(
      expect.objectContaining({ txId: "sweep-send-asset" }),
    );
  });

  it("does not count a deposit whose transfer failed, and leaves its intent behind", async () => {
    // A throw is not proof the transfer never went out, so the intent row stays
    // as the record that the outcome is unknown — but it never becomes an order
    // and is never tracked, because nothing here can fund or retry it.
    mocks.sendTransaction.mockRejectedValueOnce(new Error("rpc down"));
    mocks.sweepSwapKit.mockResolvedValueOnce({
      items: [
        {
          chainId: 42161,
          chain: "arbitrum",
          symbol: "USDC",
          address: ARBITRUM_USDC,
          amount: 11.37,
          convert: {
            txId: "sweep-transfer-failed",
            actions: [{ type: "send_asset", to: DEPOSIT, amount: "11.37" }],
          },
        },
      ],
    });

    await expect(claimSwapKitSweep()).resolves.toMatchObject({ started: 0 });
    expect(mocks.addOrder).toHaveBeenCalledTimes(1);
    expect(mocks.addOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        txId: "sweep-transfer-failed",
        recovery: expect.objectContaining({ status: "FUNDING", depositTo: DEPOSIT }),
      }),
    );
    expect(mocks.startTracking).not.toHaveBeenCalled();
  });

  it("journals the bounded funding intent before the deposit is broadcast", async () => {
    // The whole point: a kill between the broadcast and the order row must not
    // leave moved funds with no local record at all.
    const order: string[] = [];
    mocks.addOrder.mockImplementation(async (row: { recovery?: { status?: string } }) => {
      order.push(`add:${row.recovery?.status}`);
    });
    mocks.sendTransaction.mockImplementationOnce(async () => {
      order.push("broadcast");
      return `0x${"ab".repeat(32)}`;
    });
    mocks.sweepSwapKit.mockResolvedValueOnce({
      items: [
        {
          chainId: 42161,
          chain: "arbitrum",
          symbol: "USDC",
          address: ARBITRUM_USDC,
          amount: 11.37,
          convert: {
            txId: "sweep-journaled",
            actions: [{ type: "send_asset", to: DEPOSIT, amount: "11.37" }],
          },
        },
      ],
    });

    await expect(claimSwapKitSweep()).resolves.toMatchObject({ started: 1 });
    expect(order).toEqual(["add:FUNDING", "broadcast", "add:PROCESSING"]);
    // The intent carries what the transfer was, so it stays reconstructible
    // from durable state alone.
    expect(mocks.addOrder).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        recovery: expect.objectContaining({
          status: "FUNDING",
          depositTo: DEPOSIT,
          depositAmount: "11.37",
        }),
      }),
    );
    // Only the funded row carries a hash, and only it is tracked.
    expect(mocks.addOrder).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        recovery: expect.objectContaining({
          status: "PROCESSING",
          depositTxHash: `0x${"ab".repeat(32)}`,
        }),
      }),
    );
  });

  it("does not count a deposit above the scanned balance even within approval headroom", async () => {
    // 1% headroom is for router allowances, not for funds leaving the wallet.
    mocks.sweepSwapKit.mockResolvedValueOnce({
      items: [
        {
          chainId: 42161,
          chain: "arbitrum",
          symbol: "USDC",
          address: ARBITRUM_USDC,
          amount: 11.37,
          convert: {
            txId: "sweep-within-headroom",
            actions: [{ type: "send_asset", to: DEPOSIT, amount: "11.42" }],
          },
        },
      ],
    });

    await expect(claimSwapKitSweep()).resolves.toMatchObject({ started: 0 });
    expect(mocks.addOrder).not.toHaveBeenCalled();
  });

  it("does not count a deposit asset this app has no transfer path for", async () => {
    mocks.sweepSwapKit.mockResolvedValueOnce({
      items: [
        {
          chainId: 137,
          chain: "polygon",
          symbol: "USDT",
          address: TOKEN,
          amount: 25,
          convert: {
            txId: "sweep-unsupported-asset",
            fund: { sendToAddress: DEPOSIT, amount: "25" },
          },
        },
      ],
    });

    await expect(claimSwapKitSweep()).resolves.toMatchObject({ started: 0 });
    expect(mocks.addOrder).not.toHaveBeenCalled();
  });

  it("does not count an item whose scanned contract is not the canonical token", async () => {
    mocks.sweepSwapKit.mockResolvedValueOnce({
      items: [
        {
          chainId: 42161,
          chain: "arbitrum",
          symbol: "USDC",
          // Labelled arbitrum:USDC but a different contract — approving on the
          // strength of the symbol would move real USDC.
          address: TOKEN,
          amount: 11.37,
          convert: {
            txId: "sweep-wrong-contract",
            actions: [{ type: "send_asset", to: DEPOSIT, amount: "11.37" }],
          },
        },
      ],
    });

    await expect(claimSwapKitSweep()).resolves.toMatchObject({ started: 0 });
    expect(mocks.addOrder).not.toHaveBeenCalled();
  });

  it("does not count an action item whose contract is not the canonical token", async () => {
    // Supported chain and symbol, different contract. unfundableDepositReason
    // returns early for an action-style convert (no deposit address), so the
    // identity bind has to hold here too — otherwise this arbitrary address is
    // persisted as approvalToken while the ceiling is derived from the
    // canonical token's decimals.
    mocks.sweepSwapKit.mockResolvedValueOnce({
      items: [
        {
          chainId: 42161,
          chain: "arbitrum",
          symbol: "USDC",
          address: TOKEN,
          amount: 11.37,
          convert: { txId: "sweep-impostor-token" },
        },
      ],
    });

    await expect(claimSwapKitSweep()).resolves.toMatchObject({ started: 0 });
    expect(mocks.addOrder).not.toHaveBeenCalled();
  });

  it("does not count an action order whose approval cannot be bounded", async () => {
    // Ethereum USDC: advertised by signableChains, but no SWEEP_TOKENS entry, so
    // no ceiling can be derived and the signer would refuse the first approval.
    mocks.sweepSwapKit.mockResolvedValueOnce({
      items: [
        {
          chainId: 1,
          chain: "ethereum",
          symbol: "USDC",
          address: TOKEN,
          amount: 40,
          convert: { txId: "sweep-unboundable-action" },
        },
      ],
    });

    await expect(claimSwapKitSweep()).resolves.toMatchObject({ started: 0 });
    expect(mocks.addOrder).not.toHaveBeenCalled();
  });

  it("persists the detected-amount ceiling for a later approval", async () => {
    mocks.sweepSwapKit.mockResolvedValueOnce({
      items: [
        {
          chainId: 42161,
          chain: "arbitrum",
          symbol: "USDC",
          address: ARBITRUM_USDC,
          amount: 11.37,
          convert: {
            txId: "sweep-ceiling",
            actions: [{ type: "send_asset", to: DEPOSIT, amount: "11.37" }],
          },
        },
      ],
    });

    await expect(claimSwapKitSweep()).resolves.toMatchObject({ started: 1 });
    expect(mocks.addOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        recovery: expect.objectContaining({ approvalMaxUnits: "11597400" }),
      }),
    );
  });

  it("does not count a deposit asking for more than the scan detected", async () => {
    mocks.sweepSwapKit.mockResolvedValueOnce({
      items: [
        {
          chainId: 42161,
          chain: "arbitrum",
          symbol: "USDC",
          address: ARBITRUM_USDC,
          amount: 11.37,
          convert: {
            txId: "sweep-over-amount",
            actions: [{ type: "send_asset", to: DEPOSIT, amount: "50" }],
          },
        },
      ],
    });

    await expect(claimSwapKitSweep()).resolves.toMatchObject({ started: 0 });
    expect(mocks.addOrder).not.toHaveBeenCalled();
  });

  it("does not count a deposit with no detected balance to cap against", async () => {
    mocks.sweepSwapKit.mockResolvedValueOnce({
      items: [
        {
          chainId: 42161,
          chain: "arbitrum",
          symbol: "USDC",
          address: ARBITRUM_USDC,
          // Scan reported no usable amount: the server's stated amount would
          // then be the only figure, with nothing to cap it against.
          amount: "not-a-number",
          convert: {
            txId: "sweep-no-detected",
            actions: [{ type: "send_asset", to: DEPOSIT, amount: "11.37" }],
          },
        },
      ],
    });

    await expect(claimSwapKitSweep()).resolves.toMatchObject({ started: 0 });
    expect(mocks.addOrder).not.toHaveBeenCalled();
  });

  it("does not count a deposit whose amount is missing", async () => {
    mocks.sweepSwapKit.mockResolvedValueOnce({
      items: [
        {
          chainId: 42161,
          chain: "arbitrum",
          symbol: "USDC",
          address: ARBITRUM_USDC,
          convert: {
            txId: "sweep-no-amount",
            actions: [{ type: "send_asset", to: DEPOSIT }],
          },
        },
      ],
    });

    await expect(claimSwapKitSweep()).resolves.toMatchObject({ started: 0 });
    expect(mocks.addOrder).not.toHaveBeenCalled();
  });
});

// The read-only scan carries no `convert`, so the funding guard cannot speak for
// it — these pin the scan-time verdict itself, which is what the claim will act
// on for the identity of the balance.
// Zero-start is not one outcome. The sheet only holds itself open on a SETTLED
// refusal, so a run has to say whether anything was left hanging alongside it.
describe("claimSwapKitSweep zero-start outcomes", () => {
  const ARBITRUM_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
  const DEPOSIT = "0x2222222222222222222222222222222222222222";

  it("reports a settled refusal when the only item is one this app turned down", async () => {
    mocks.sweepSwapKit.mockResolvedValueOnce({
      items: [
        {
          chainId: 42161,
          chain: "arbitrum",
          symbol: "USDC",
          address: TOKEN,
          amount: 11.37,
          convert: {
            txId: "sweep-wrong-contract",
            actions: [{ type: "send_asset", to: DEPOSIT, amount: "11.37" }],
          },
        },
      ],
    });

    await expect(claimSwapKitSweep()).resolves.toEqual({
      started: 0,
      refusedLocally: 1,
      unresolved: 0,
      refunded: 0,
    });
  });

  it("does not call a mixed run settled when a refusal sits next to an unarmed item", async () => {
    mocks.sweepSwapKit.mockResolvedValueOnce({
      items: [
        {
          chainId: 42161,
          chain: "arbitrum",
          symbol: "USDC",
          address: TOKEN,
          amount: 11.37,
          convert: {
            txId: "sweep-wrong-contract",
            actions: [{ type: "send_asset", to: DEPOSIT, amount: "11.37" }],
          },
        },
        // Armed by nothing: the server reports the balance with an error instead
        // of a convert, which may well succeed on a later attempt.
        {
          chainId: 42161,
          chain: "arbitrum",
          symbol: "USDC",
          address: ARBITRUM_USDC,
          amount: 5,
          error: "route temporarily unavailable",
        },
      ],
    });

    await expect(claimSwapKitSweep()).resolves.toEqual({
      started: 0,
      refusedLocally: 1,
      unresolved: 1,
      refunded: 0,
    });
  });

  it("counts a funding transfer of unknown outcome as unresolved, not refused", async () => {
    mocks.sendTransaction.mockRejectedValueOnce(new Error("rpc down"));
    mocks.sweepSwapKit.mockResolvedValueOnce({
      items: [
        {
          chainId: 42161,
          chain: "arbitrum",
          symbol: "USDC",
          address: ARBITRUM_USDC,
          amount: 11.37,
          convert: {
            txId: "sweep-transfer-unknown",
            actions: [{ type: "send_asset", to: DEPOSIT, amount: "11.37" }],
          },
        },
      ],
    });

    await expect(claimSwapKitSweep()).resolves.toEqual({
      started: 0,
      refusedLocally: 0,
      unresolved: 1,
      refunded: 0,
    });
  });

  it("counts a pending refund as unresolved, never recovered", async () => {
    mocks.executeSatoraRefund.mockResolvedValueOnce({ txHash: "0xpending", status: "pending" });
    mocks.sweepSwapKit.mockResolvedValueOnce({ items: [], refundable: [REFUNDABLE_LOCK] });

    await expect(claimSwapKitSweep()).resolves.toEqual({
      started: 0,
      refusedLocally: 0,
      unresolved: 1,
      refunded: 0,
    });
  });

  it("counts only a confirmed refund as recovered", async () => {
    mocks.executeSatoraRefund.mockResolvedValueOnce({ txHash: "0xconfirmed", status: "confirmed" });
    mocks.sweepSwapKit.mockResolvedValueOnce({ items: [], refundable: [REFUNDABLE_LOCK] });

    await expect(claimSwapKitSweep()).resolves.toEqual({
      started: 0,
      refusedLocally: 0,
      unresolved: 0,
      refunded: 1,
    });
  });
});

describe("scanClaimBlocker", () => {
  const ARBITRUM_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

  it("clears a canonical Arbitrum USDC balance", async () => {
    expect(
      await scanClaimBlocker({
        chainId: 42161,
        chain: "arbitrum",
        symbol: "USDC",
        address: ARBITRUM_USDC,
        amount: 17.92,
      } as never),
    ).toBeNull();
  });

  it("clears it even when the server labels the chain and symbol differently", async () => {
    expect(
      await scanClaimBlocker({
        chainId: 42161,
        chain: "arbitrum_one",
        // The server always sends the canonical id alongside the display symbol
        // (sweep.mjs pushes `asset` with every balance), so a variant label still
        // resolves through the asset head.
        asset: "USDC_ARBITRUM",
        symbol: "USDC.e",
        address: ARBITRUM_USDC,
        amount: 17.92,
      } as never),
    ).toBeNull();
  });

  it("refuses a non-canonical contract wearing the same chain and symbol", async () => {
    const blocker = await scanClaimBlocker({
      chainId: 42161,
      chain: "arbitrum",
      symbol: "USDC",
      address: TOKEN,
      amount: 17.92,
    } as never);
    expect(blocker).toContain("no local transfer path");
  });

  it("refuses a token on a chain with no local transfer path", async () => {
    const blocker = await scanClaimBlocker({
      chainId: 137,
      chain: "polygon",
      symbol: "USDT",
      address: TOKEN,
      amount: 42,
    } as never);
    expect(blocker).toContain("no local transfer path");
  });

  it("refuses the canonical token on a chain it is not deployed to here", async () => {
    const blocker = await scanClaimBlocker({
      chainId: 1,
      chain: "ethereum",
      symbol: "USDC",
      address: ARBITRUM_USDC,
      amount: 5,
    } as never);
    expect(blocker).toContain("no local transfer path");
  });

  it("refuses a Base balance — the wallet holds both currencies there", async () => {
    // The scan is told one `baseCurrency` to leave alone, so with euro AND dollar
    // held on Base the other one comes back as a find. Announcing it would offer
    // the user their own balance as money we discovered.
    const blocker = await scanClaimBlocker({
      chainId: 8453,
      chain: "base",
      symbol: "USDC",
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount: 25,
    } as never);
    expect(blocker).toContain("a held balance");
  });

  it("announces Base residue that is not one of the wallet's own currencies", async () => {
    // Residue a route delivered lives on Base too. A LI.FI BTC-source route handed the
    // wallet TITN and the blanket Base rule kept the rescue from ever offering it, so the
    // balance sat invisible while the user was told nothing had been found.
    mocks.resolveCanonicalToken.mockResolvedValue({
      chainId: 8453,
      address: "0xe62bfbE57763ec24c0F130426F34DbCe11Fc5B06",
      decimals: 18,
      symbol: "TITN",
    } as never);
    const blocker = await scanClaimBlocker({
      chainId: 8453,
      chain: "base",
      asset: "TITN_BASE",
      symbol: "TITN",
      address: "0xe62bfbE57763ec24c0F130426F34DbCe11Fc5B06",
      amount: 1459.7643410383596, // the runtime value of the 18-decimal balance (Biome: no precision loss)
    } as never);
    expect(blocker).toBeNull();
  });

  it("refuses an unusable detected amount", async () => {
    expect(
      await scanClaimBlocker({
        chainId: 42161,
        chain: "arbitrum",
        symbol: "USDC",
        address: ARBITRUM_USDC,
        amount: 0,
      } as never),
    ).toBe("scan reported no detected balance");
  });
});

// The server's sweep asset list lives in its own repo and is wider than this
// app's: signableChains is chain-granular, so it arms USDT/tBTC on Arbitrum too.
// The sheet must never announce money the claim would then refuse.
describe("checkSwapKitSweep announcement", () => {
  const ARBITRUM_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

  it("counts only the balances this app can carry, and re-totals the headline", async () => {
    mocks.sweepSwapKit.mockResolvedValueOnce({
      found: 2,
      sweepable: 2,
      totalUsd: 42,
      items: [
        {
          chainId: 42161,
          chain: "arbitrum",
          symbol: "USDC",
          address: ARBITRUM_USDC,
          amount: 5.42,
          usd: 5.42,
        },
        // Armed by the server, no transfer path here.
        { chainId: 42161, chain: "arbitrum", symbol: "USDT", address: TOKEN, amount: 36, usd: 36 },
      ],
    });

    const result = await checkSwapKitSweep({ force: true });
    expect(result?.items).toHaveLength(1);
    expect(result?.sweepable).toBe(1);
    expect(result?.totalUsd).toBeCloseTo(5.42);
  });

  it("announces Arbitrum tBTC as found money the app can carry", async () => {
    mocks.sweepSwapKit.mockResolvedValueOnce({
      found: 1,
      sweepable: 1,
      totalUsd: 14.9,
      items: [
        {
          chainId: 42161,
          chain: "arbitrum",
          asset: "TBTC_ARBITRUM",
          symbol: "tBTC",
          address: "0x6c84a8f1c29108F47a79964b5Fe888D4f4D0dE40",
          amount: 0.000186,
          usd: 14.9,
        },
      ],
    });

    const result = await checkSwapKitSweep({ force: true });
    expect(result?.items).toHaveLength(1);
    expect(result?.items?.[0]).toMatchObject({ asset: "TBTC_ARBITRUM", symbol: "tBTC" });
    expect(result?.sweepable).toBe(1);
    expect(result?.totalUsd).toBeCloseTo(14.9);
  });

  it("offers no sheet at all when nothing found is carryable", async () => {
    mocks.sweepSwapKit.mockResolvedValueOnce({
      found: 1,
      sweepable: 1,
      totalUsd: 36,
      items: [
        { chainId: 42161, chain: "arbitrum", symbol: "USDT", address: TOKEN, amount: 36, usd: 36 },
      ],
    });

    await expect(checkSwapKitSweep({ force: true })).resolves.toBeNull();
  });

  it("does not surface a sheet for a malformed refundable entry with a truthy flag", async () => {
    // Server hands back a refundable entry that is truthy on `.refundable` but
    // missing every field the parser requires. The raw filter would announce a
    // sheet that then recovers nothing and closes as if handled; the fail-closed
    // parser drops it, so no sheet appears.
    mocks.sweepSwapKit.mockResolvedValueOnce({
      found: 0,
      sweepable: 0,
      totalUsd: 0,
      items: [],
      refundable: [{ refundable: true }],
    });

    await expect(checkSwapKitSweep({ force: true })).resolves.toBeNull();
  });

  it("does not surface a sheet for a refundable lock on an untrusted coordinator", async () => {
    // Well-formed and flagged refundable, but the coordinator is not an
    // allowlisted Satora deployment. executeSatoraRefund would refuse it
    // deterministically, so announcing it would trap the sheet in a
    // show → refuse → close → re-offer loop.
    mocks.sweepSwapKit.mockResolvedValueOnce({
      found: 0,
      sweepable: 0,
      totalUsd: 0,
      items: [],
      refundable: [
        {
          preimageHash: `0x${"ab".repeat(32)}`,
          chainId: 42161,
          coordinatorAddress: "0x000000000000000000000000000000000000dEaD",
          token: "0x6c84a8f1c29108F47a79964b5Fe888D4f4D0dE40",
          claimAddress: "0x5ce278AAec6d9fa67bFcaF98512fE5175dFEebac",
          amountRaw: "149011072672818",
          timelock: 1789090352,
          refundable: true,
        },
      ],
    });

    await expect(checkSwapKitSweep({ force: true })).resolves.toBeNull();
  });
});

// Three taps in production armed three sibling order sets for the same balances.
describe("claimSwapKitSweep concurrency", () => {
  it("runs one confirm for concurrent calls and hands all of them the same outcome", async () => {
    mocks.sweepSwapKit.mockResolvedValueOnce({
      items: [
        {
          chainId: 42161,
          chain: "arbitrum",
          symbol: "USDC",
          address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
          amount: 11.37,
          convert: { txId: "sweep-once" },
        },
      ],
    });

    const outcomes = await Promise.all([
      claimSwapKitSweep(),
      claimSwapKitSweep(),
      claimSwapKitSweep(),
    ]);

    const confirms = mocks.sweepSwapKit.mock.calls.filter((call) => call[0]?.confirm === true);
    expect(confirms).toHaveLength(1);
    expect(mocks.addOrder).toHaveBeenCalledTimes(1);
    expect(outcomes[0]).toBe(outcomes[1]);
    expect(outcomes[1]).toBe(outcomes[2]);
  });

  it("lets a later claim run once the first has settled", async () => {
    mocks.sweepSwapKit.mockResolvedValue({ items: [] });

    await claimSwapKitSweep();
    await claimSwapKitSweep();

    const confirms = mocks.sweepSwapKit.mock.calls.filter((call) => call[0]?.confirm === true);
    expect(confirms).toHaveLength(2);
  });
});

// Some scan shapes carry the chain label only; rejecting those makes the balance
// both unannounceable and unclaimable.
describe("scanClaimBlocker without chainId", () => {
  it("resolves the chain from the label", async () => {
    expect(
      await scanClaimBlocker({
        chain: "arbitrum",
        asset: "USDC_ARBITRUM",
        symbol: "USDC",
        address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        amount: 5.42,
      } as never),
    ).toBeNull();
  });

  it("still refuses a label it cannot map", async () => {
    const blocker = await scanClaimBlocker({
      chain: "some-l2",
      asset: "USDC_SOMEL2",
      symbol: "USDC",
      address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      amount: 5.42,
    } as never);
    expect(blocker).toContain("no local transfer path");
  });
});

// Without a pending row the sheet closes onto an unchanged balance for the
// minute the conversion runs.
describe("claimSwapKitSweep pending row", () => {
  it("announces the wait on the wallet list, keyed by the order id", async () => {
    mocks.sweepSwapKit.mockResolvedValueOnce({
      items: [
        {
          chainId: 42161,
          chain: "arbitrum",
          symbol: "USDC",
          address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
          amount: 5.42,
          usd: 5.42,
          convert: { txId: "sweep-pending-row" },
        },
      ],
    });

    await claimSwapKitSweep();

    expect(mocks.emitEvent).toHaveBeenCalledWith(
      "wallet:pendingTransfer",
      expect.objectContaining({ orderId: "sweep-pending-row", amountFiat: 5.42, txHash: null }),
    );
  });

  it("announces nothing when the claim carried nothing", async () => {
    mocks.sweepSwapKit.mockResolvedValueOnce({
      items: [
        { chainId: 42161, chain: "arbitrum", symbol: "USDT", address: TOKEN, amount: 9, usd: 9 },
      ],
    });

    await claimSwapKitSweep();

    expect(mocks.emitEvent).not.toHaveBeenCalledWith("wallet:pendingTransfer", expect.anything());
  });
});

// The scan accepts a label-only item, so the claim has to bind one too — or the
// same balance is announced and then counted as a settled local refusal.
describe("claimSwapKitSweep without chainId", () => {
  it("binds an action-style convert from the chain label", async () => {
    mocks.sweepSwapKit.mockResolvedValueOnce({
      items: [
        {
          chain: "arbitrum",
          asset: "USDC_ARBITRUM",
          symbol: "USDC",
          address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
          amount: 5.42,
          convert: { txId: "sweep-label-only" },
        },
      ],
    });

    await expect(claimSwapKitSweep()).resolves.toMatchObject({
      started: 1,
      refusedLocally: 0,
    });
    expect(mocks.addOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        txId: "sweep-label-only",
        recovery: expect.objectContaining({ chainId: 42161 }),
      }),
    );
  });
});
