import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PayRail } from "../../lib/pay/selectPayRail";

const resolveLnurlPayRequest = vi.fn();
const requestLnurlInvoice = vi.fn();
const decodeBolt11Facts = vi.fn();

vi.mock("../bitcoin/LnurlService", () => ({
  resolveLnurlPayRequest: (...args: unknown[]) => resolveLnurlPayRequest(...args),
  requestLnurlInvoice: (...args: unknown[]) => requestLnurlInvoice(...args),
}));
const commit = vi.fn();
const quote = vi.fn();
const status = vi.fn();
const cache = new Map<string, unknown>();
vi.mock("expo-crypto", () => ({
  randomUUID: () => "random-recovery-token-at-least-32-characters",
}));
vi.mock("../balance/TransactionCacheService", () => ({
  getCacheValue: async (key: string) => cache.get(key),
  setCacheValue: async (key: string, value: unknown) => {
    cache.set(key, value);
  },
}));
vi.mock("../swapkit/SwapKitV2Service", async (original) => ({
  ...(await original<typeof import("../swapkit/SwapKitV2Service")>()),
  quoteSwapKitV2: (...args: unknown[]) => quote(...args),
  commitSwapKitV2: (...args: unknown[]) => commit(...args),
  getSwapKitV2Status: (...args: unknown[]) => status(...args),
}));
const executeSwapKitSwap = commit;
vi.mock("../swapkit/SwapKitService", () => ({
  executeSwapKitSwap: () => {
    throw new Error("v1 forbidden");
  },
}));
vi.mock("../../lib/bitcoin/lightning", () => ({
  decodeBolt11Facts: (...args: unknown[]) => decodeBolt11Facts(...args),
}));

const { buildPayTarget, readPayOrderStatus } = await import("./PayTargetService");

const LN_RAIL: PayRail = {
  kind: "lightning",
  source: "BTC_LN",
  lightningAddress: "someone@nuri.com",
};

const HOUR_FROM_NOW_SEC = () => Math.trunc(Date.now() / 1000) + 3600;

describe("lightning pay targets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveLnurlPayRequest.mockResolvedValue({
      callback: "https://nuri.com/lnurlp/callback",
      minSendableMsats: 1_000,
      maxSendableMsats: 100_000_000,
    });
    requestLnurlInvoice.mockResolvedValue("lnbc1invoice");
  });

  it("returns the invoice when it states exactly the requested amount", async () => {
    decodeBolt11Facts.mockReturnValue({ amountSats: 5_000, expiresAt: HOUR_FROM_NOW_SEC() });
    const target = await buildPayTarget(LN_RAIL, "5000");
    expect(target?.value).toBe("lnbc1invoice");
    expect(target?.amount).toBe("5000");
    expect(target?.decimals).toBe(0);
    expect(target?.expiresAtMs).toBeGreaterThan(Date.now());
  });

  it("refuses an invoice for a different amount than the payer asked for", async () => {
    decodeBolt11Facts.mockReturnValue({ amountSats: 500_000, expiresAt: HOUR_FROM_NOW_SEC() });
    expect(await buildPayTarget(LN_RAIL, "5000")).toBeNull();
  });

  it("refuses an invoice that cannot be decoded, and one already expired", async () => {
    decodeBolt11Facts.mockImplementation(() => {
      throw new Error("lightning invoice amount missing or invalid");
    });
    expect(await buildPayTarget(LN_RAIL, "5000")).toBeNull();

    decodeBolt11Facts.mockReset();
    decodeBolt11Facts.mockReturnValue({
      amountSats: 5_000,
      expiresAt: Math.trunc(Date.now() / 1000) - 1,
    });
    expect(await buildPayTarget(LN_RAIL, "5000")).toBeNull();
  });

  it("mints nothing outside the endpoint's own bounds", async () => {
    resolveLnurlPayRequest.mockResolvedValue({
      callback: "https://nuri.com/lnurlp/callback",
      minSendableMsats: 10_000_000,
      maxSendableMsats: 100_000_000,
    });
    expect(await buildPayTarget(LN_RAIL, "5000")).toBeNull();
    expect(requestLnurlInvoice).not.toHaveBeenCalled();
  });
});

const SWAP_RAIL: PayRail = {
  kind: "swap",
  source: "USDC_ARBITRUM",
  from: "USDC_ARBITRUM",
  to: "USDC_BASE",
  settleTarget: "0x00993cA379abd3F6c79E439c54a1AB2e7c95234B",
};
const REFUND = "0x0000000000000000000000000000000000009999";

describe("swap deposit targets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    quote.mockResolvedValue({
      options: [
        {
          optionId: "deposit",
          depositAmount: "12.5",
          settleAmount: "12",
          requiredCapabilities: ["send_asset"],
        },
      ],
    });
  });

  it("returns the provider's own funding figure, not the entered one", async () => {
    executeSwapKitSwap.mockResolvedValue({
      orderId: "ord_1",
      actions: [
        {
          actionId: "fund",
          kind: "send_asset",
          state: "ready",
          request: {
            asset: "USDC_ARBITRUM",
            to: "0x0000000000000000000000000000000000001234",
            amount: 12.5,
          },
        },
      ],
    });
    const target = await buildPayTarget(SWAP_RAIL, "12", REFUND);
    expect(target?.amount).toBe("12500000");
    expect(target?.decimals).toBe(6);
    expect(target?.trackTxId).toBe("ord_1");
    expect(target?.uri).toContain("uint256=12500000");
  });

  it("refuses an order that states no funding amount", async () => {
    executeSwapKitSwap.mockResolvedValue({
      orderId: "ord_2",
      actions: [
        {
          actionId: "fund",
          kind: "send_asset",
          state: "ready",
          request: { asset: "USDC_ARBITRUM", to: "0x0000000000000000000000000000000000001234" },
        },
      ],
    });
    expect(await buildPayTarget(SWAP_RAIL, "12", REFUND)).toBeNull();
  });

  it("refuses an order denominated in sats, and one with no refund address", async () => {
    executeSwapKitSwap.mockResolvedValue({
      orderId: "ord_3",
      actions: [
        {
          actionId: "fund",
          kind: "send_asset",
          state: "ready",
          request: {
            asset: "USDC_ARBITRUM",
            to: "0x0000000000000000000000000000000000001234",
            amount: 12.5,
            amountSats: 25_000,
          },
        },
      ],
    });
    expect(await buildPayTarget(SWAP_RAIL, "12", REFUND)).toBeNull();

    expect(await buildPayTarget(SWAP_RAIL, "12", "  ")).toBeNull();
    expect(executeSwapKitSwap).toHaveBeenCalledTimes(1);
  });
});

describe("figures the page cannot say exactly", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    quote.mockResolvedValue({
      options: [
        {
          optionId: "deposit",
          depositAmount: "12.5",
          settleAmount: "12",
          requiredCapabilities: ["send_asset"],
        },
      ],
    });
  });

  it("refuses a typed figure with more precision than the token has", async () => {
    const USDC_RAIL: PayRail = {
      kind: "evm-stable",
      source: "USDC_BASE",
      asset: "USDC_BASE",
      address: "0x00993cA379abd3F6c79E439c54a1AB2e7c95234B",
    };
    // Half a base unit: rounding it would encode 1 in the QR and print 0.
    expect(await buildPayTarget(USDC_RAIL, "0.0000005")).toBeNull();
    const ok = await buildPayTarget(USDC_RAIL, "0.000001");
    expect(ok?.amount).toBe("1");
    expect(ok?.uri).toContain("uint256=1");
  });

  it("refuses a quote it would have to round", async () => {
    executeSwapKitSwap.mockResolvedValue({
      orderId: "ord_4",
      actions: [
        {
          actionId: "fund",
          kind: "send_asset",
          state: "ready",
          request: {
            asset: "USDC_ARBITRUM",
            to: "0x0000000000000000000000000000000000001234",
            amount: 12.3456789,
          },
        },
      ],
    });
    expect(await buildPayTarget(SWAP_RAIL, "12", REFUND)).toBeNull();
  });

  it("refuses a deposit whose order it cannot follow", async () => {
    executeSwapKitSwap.mockResolvedValue({
      actions: [
        {
          actionId: "fund",
          kind: "send_asset",
          state: "ready",
          request: {
            asset: "USDC_ARBITRUM",
            to: "0x0000000000000000000000000000000000001234",
            amount: 12.5,
          },
        },
      ],
    });
    expect(await buildPayTarget(SWAP_RAIL, "12", REFUND)).toBeNull();
  });
});

describe("the refund address gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    quote.mockResolvedValue({
      options: [
        {
          optionId: "deposit",
          depositAmount: "12.5",
          settleAmount: "12",
          requiredCapabilities: ["send_asset"],
        },
      ],
    });
  });

  it("creates no order for a refund address that is not a real EVM address", async () => {
    expect(await buildPayTarget(SWAP_RAIL, "12", "foo")).toBeNull();
    expect(await buildPayTarget(SWAP_RAIL, "12", "0x1234")).toBeNull();
    // Mixed case with a wrong EIP-55 checksum — a typo in a pasted address.
    expect(
      await buildPayTarget(SWAP_RAIL, "12", "0x00993Ca379abd3F6c79E439c54a1AB2e7c95234B"),
    ).toBeNull();
    expect(executeSwapKitSwap).not.toHaveBeenCalled();
  });
});

describe("funding shapes this route cannot use", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    quote.mockResolvedValue({
      options: [
        {
          optionId: "deposit",
          depositAmount: "12.5",
          settleAmount: "12",
          requiredCapabilities: ["send_asset"],
        },
      ],
    });
  });

  it("refuses an invoice-funded order on an EVM swap source", async () => {
    executeSwapKitSwap.mockResolvedValue({
      orderId: "ord_5",
      actions: [
        {
          actionId: "fund",
          kind: "send_asset",
          state: "ready",
          request: { asset: "USDC_ARBITRUM", payInvoice: "lnbc1invoice", amount: 12.5 },
        },
      ],
    });
    // A BOLT11 asks for bitcoin; the payer picked USDC on Arbitrum, and the
    // label above the QR would still say so.
    expect(await buildPayTarget(SWAP_RAIL, "12", REFUND)).toBeNull();
  });
});

describe("v2 deposit contract", () => {
  it("quotes only external deposit actions and pins exact bounds on commit", async () => {
    quote.mockResolvedValue({
      options: [
        {
          optionId: "deposit",
          depositAmount: "12.5",
          settleAmount: "12",
          requiredCapabilities: ["send_asset"],
        },
      ],
    });
    commit.mockResolvedValue({
      orderId: "ord_pay",
      status: "AWAITING_ACTION",
      actions: [
        {
          kind: "send_asset",
          state: "ready",
          request: { asset: "USDC_ARBITRUM", to: REFUND, amount: "12.5" },
        },
      ],
    });
    await buildPayTarget(SWAP_RAIL, "12", REFUND);
    expect(quote).toHaveBeenLastCalledWith(
      expect.objectContaining({ amount: "12", capabilities: ["send_asset"], owner: REFUND }),
    );
    expect(commit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        optionId: "deposit",
        acceptedDepositAmount: "12.5",
        minimumSettleAmount: "12",
        recoveryKey: expect.any(String),
      }),
    );
    status.mockResolvedValue({ orderId: "ord_pay", status: "COMPLETED", actions: [] });
    expect(await readPayOrderStatus("ord_pay")).toEqual({ state: "settled", phase: null });
    expect(status).toHaveBeenLastCalledWith("ord_pay", { recoveryKey: expect.any(String) });
  });
  it("creates nothing when the quote needs wallet signing", async () => {
    commit.mockClear();
    quote.mockResolvedValue({
      options: [{ optionId: "sign", requiredCapabilities: ["execute_evm_call"] }],
    });
    expect(await buildPayTarget(SWAP_RAIL, "12", REFUND)).toBeNull();
    expect(commit).not.toHaveBeenCalled();
  });
});

it("retries a lost commit response with the same persisted request", async () => {
  cache.clear();
  quote.mockResolvedValue({
    options: [
      {
        optionId: "deposit",
        depositAmount: "12",
        settleAmount: "11",
        requiredCapabilities: ["send_asset"],
      },
    ],
  });
  commit.mockRejectedValueOnce(new Error("response lost"));
  await expect(buildPayTarget(SWAP_RAIL, "12", REFUND)).rejects.toThrow("response lost");
  const first = commit.mock.calls.at(-1)?.[0];
  quote.mockResolvedValue({
    options: [
      {
        optionId: "new-price",
        depositAmount: "13",
        settleAmount: "12",
        requiredCapabilities: ["send_asset"],
      },
    ],
  });
  commit.mockResolvedValue({
    orderId: "ord_retry",
    actions: [
      {
        kind: "send_asset",
        state: "ready",
        request: { asset: "USDC_ARBITRUM", to: REFUND, amount: "12" },
      },
    ],
  });
  await buildPayTarget(SWAP_RAIL, "12", REFUND);
  expect(commit.mock.calls.at(-1)?.[0]).toEqual(first);
});

it.each([
  {
    kind: "send_asset",
    state: "blocked",
    request: { asset: "USDC_ARBITRUM", to: REFUND, amount: "12" },
  },
  { kind: "send_asset", state: "ready", request: { asset: "USDC_BASE", to: REFUND, amount: "12" } },
  {
    kind: "send_asset",
    state: "ready",
    deadline: "2000-01-01T00:00:00Z",
    request: { asset: "USDC_ARBITRUM", to: REFUND, amount: "12" },
  },
])("does not display an unpayable funding action", async (action) => {
  cache.clear();
  quote.mockResolvedValue({
    options: [
      {
        optionId: "deposit",
        depositAmount: "12",
        settleAmount: "11",
        requiredCapabilities: ["send_asset"],
      },
    ],
  });
  commit.mockResolvedValue({ orderId: "ord_unpayable", actions: [action] });
  expect(await buildPayTarget(SWAP_RAIL, "12", REFUND)).toBeNull();
});
