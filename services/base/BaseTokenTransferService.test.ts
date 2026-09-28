import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dripBaseGas: vi.fn(),
  getBalance: vi.fn(),
  getGasPrice: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  call: vi.fn(),
  estimateGas: vi.fn(),
  sendTransaction: vi.fn(),
  getPrivateKey: vi.fn(),
}));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({
      getBalance: mocks.getBalance,
      getGasPrice: mocks.getGasPrice,
      waitForTransactionReceipt: mocks.waitForTransactionReceipt,
      call: mocks.call,
      estimateGas: mocks.estimateGas,
    }),
    createWalletClient: () => ({ sendTransaction: mocks.sendTransaction }),
  };
});
vi.mock("../../lib/faucet/FaucetService", () => ({ dripBaseGas: mocks.dripBaseGas }));
vi.mock("../../lib/secureKeyStorage", () => ({ getPrivateKey: mocks.getPrivateKey }));
vi.mock("../swapkit/SwapKitService", () => ({ assertMinedTxMatchesSigned: vi.fn() }));
vi.mock("../logging/LoggerService", () => ({ log: vi.fn() }));

import { ensureBaseMainnetGas, signAndBroadcastBaseMainnetTx } from "./BaseTokenTransferService";

const ADDRESS = "0x1111111111111111111111111111111111111111" as const;
const ROUTER = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE" as const;
// zeroize() wipes the key bytes in place, so each call must get its own copy.
const freshPrivateKey = () => new Uint8Array(32).fill(0x11);
// 200_000 × gasPrice × 2 — the requirement ensureBaseMainnetGas computes.
const GAS_PRICE = 6_000_000n;
const REQUIRED_WEI = 200_000n * GAS_PRICE * 2n;
// balanceOf return data. The faucet's Sybil gate is checked before every drip
// request, so a wallet must hold an eligible token for the relay to be asked.
const HOLDS_TOKEN = { data: `0x${1_000_000n.toString(16).padStart(64, "0")}` };
const HOLDS_NOTHING = { data: `0x${"0".repeat(64)}` };

describe("ensureBaseMainnetGas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getGasPrice.mockResolvedValue(GAS_PRICE);
    mocks.call.mockResolvedValue(HOLDS_TOKEN);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-reads the balance when a retried drip returns already_claimed", async () => {
    // The relay's first attempt submitted the drip and timed out; the retry saw
    // the claim. The pre-request balance is stale — the wallet IS funded.
    mocks.dripBaseGas.mockResolvedValue({
      sent: false,
      reason: "already_claimed",
      transient: false,
    });
    mocks.getBalance.mockResolvedValueOnce(0n).mockResolvedValue(REQUIRED_WEI * 2n);

    const result = await ensureBaseMainnetGas(ADDRESS, { awaitConfirmation: true });

    expect(result).toBe("sufficient");
  });

  it("proceeds on has_gas even when the balance stays below the requirement", async () => {
    // The relay's cutoff is not this gate's cutoff: the real transfer needs far
    // less than the 2× worst-case headroom, so the send must still get to try.
    vi.useFakeTimers();
    mocks.dripBaseGas.mockResolvedValue({ sent: false, reason: "has_gas", transient: false });
    mocks.getBalance.mockResolvedValue(REQUIRED_WEI / 4n);

    const pending = ensureBaseMainnetGas(ADDRESS, { awaitConfirmation: true });
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(pending).resolves.toBe("unknown");
  });

  it("stays fail-open when the relay is unreachable and the wallet holds partial gas", async () => {
    // Enough ETH for the real ~60k-gas transfer, below this gate's 200k × 2×
    // price floor. A faucet outage must not decide that for the user.
    mocks.dripBaseGas.mockResolvedValue({
      sent: false,
      reason: "relay_timeout",
      transient: true,
    });
    mocks.getBalance.mockResolvedValue(REQUIRED_WEI / 3n);

    const result = await ensureBaseMainnetGas(ADDRESS, { awaitConfirmation: true });

    expect(result).toBe("unknown");
  });

  it("stays fail-open when the relay exhausts its 5xx retries", async () => {
    mocks.dripBaseGas.mockResolvedValue({
      sent: false,
      reason: "relay_http_502",
      transient: true,
    });
    mocks.getBalance.mockResolvedValue(0n);

    const result = await ensureBaseMainnetGas(ADDRESS, { awaitConfirmation: true });

    expect(result).toBe("unknown");
  });

  it("refuses when a definitive refusal leaves the wallet empty", async () => {
    mocks.dripBaseGas.mockResolvedValue({ sent: false, reason: "faucet_empty", transient: false });
    mocks.getBalance.mockResolvedValue(0n);

    const result = await ensureBaseMainnetGas(ADDRESS, { awaitConfirmation: true });

    expect(result).toBe("insufficient");
  });

  it("proceeds on a definitive refusal when the wallet holds partial gas", async () => {
    // An empty faucet is not a verdict on the wallet: this gate's floor is the
    // worst case, and a third of it still pays a real ERC20 transfer. Refusing
    // here would throw GAS_TOPUP_UNAVAILABLE before estimateGas ever ran.
    mocks.dripBaseGas.mockResolvedValue({ sent: false, reason: "faucet_empty", transient: false });
    mocks.getBalance.mockResolvedValue(REQUIRED_WEI / 3n);

    const result = await ensureBaseMainnetGas(ADDRESS, { awaitConfirmation: true });

    expect(result).toBe("unknown");
  });

  it("proceeds when a confirmed drip lands short but leaves the wallet funded", async () => {
    // The drip was mined and the balance grew — just not past the worst-case
    // floor. The send still gets its exact estimate.
    vi.useFakeTimers();
    mocks.dripBaseGas.mockResolvedValue({ sent: true, txHash: "0xabc", transient: false });
    mocks.waitForTransactionReceipt.mockResolvedValue({});
    mocks.getBalance.mockResolvedValue(REQUIRED_WEI / 2n);

    const pending = ensureBaseMainnetGas(ADDRESS, { awaitConfirmation: true });
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(pending).resolves.toBe("unknown");
  });

  it("skips the faucet entirely when the balance already covers the requirement", async () => {
    mocks.getBalance.mockResolvedValue(REQUIRED_WEI);

    const result = await ensureBaseMainnetGas(ADDRESS, { awaitConfirmation: true });

    expect(result).toBe("sufficient");
    expect(mocks.dripBaseGas).not.toHaveBeenCalled();
  });

  it("never asks the relay when the wallet holds no faucet-eligible token", async () => {
    // The Sybil gate would answer no_eure. Asking is a request spent on a
    // certain refusal — and on the pre-funding paths it is also the moment the
    // wallet is guaranteed empty, so the request can never succeed.
    mocks.call.mockResolvedValue(HOLDS_NOTHING);
    mocks.getBalance.mockResolvedValue(0n);

    const result = await ensureBaseMainnetGas(ADDRESS, { awaitConfirmation: true });

    expect(mocks.dripBaseGas).not.toHaveBeenCalled();
    expect(result).toBe("insufficient");
  });

  it("still lets a partially funded token-less wallet try its real send", async () => {
    // Skipping the drip must not harden into a refusal: this gate's floor is
    // worst-case, and the ETH already held may well cover the actual transfer.
    mocks.call.mockResolvedValue(HOLDS_NOTHING);
    mocks.getBalance.mockResolvedValue(REQUIRED_WEI / 3n);

    const result = await ensureBaseMainnetGas(ADDRESS, { awaitConfirmation: true });

    expect(mocks.dripBaseGas).not.toHaveBeenCalled();
    expect(result).toBe("unknown");
  });

  it("asks the relay when only one of the eligible tokens has a balance", async () => {
    // Any single eligible token qualifies — the wallet need not hold EURC.
    mocks.call
      .mockResolvedValueOnce(HOLDS_NOTHING)
      .mockResolvedValueOnce(HOLDS_NOTHING)
      .mockResolvedValueOnce(HOLDS_NOTHING)
      .mockResolvedValueOnce(HOLDS_NOTHING)
      .mockResolvedValueOnce(HOLDS_TOKEN);
    mocks.dripBaseGas.mockResolvedValue({ sent: false, reason: "faucet_empty", transient: false });
    mocks.getBalance.mockResolvedValue(0n);

    await ensureBaseMainnetGas(ADDRESS, { awaitConfirmation: true });

    expect(mocks.dripBaseGas).toHaveBeenCalledWith(ADDRESS);
  });

  it("confirms a sent drip by balance when the receipt never arrives", async () => {
    mocks.dripBaseGas.mockResolvedValue({ sent: true, txHash: "0xabc", transient: false });
    mocks.waitForTransactionReceipt.mockRejectedValue(new Error("receipt timeout"));
    mocks.getBalance.mockResolvedValueOnce(0n).mockResolvedValue(REQUIRED_WEI);

    const result = await ensureBaseMainnetGas(ADDRESS, { awaitConfirmation: true });

    expect(result).toBe("sufficient");
  });
});

// Regression for the sk_38670dfb strand (EURC_BASE->USDC_BASE, 2026-09-21): the wallet
// re-estimated gas and broadcast its own result (972,594) against a 965,038 requirement,
// discarding the 2,574,900 limit the server had published for this route. The tx landed at
// index 235 of its block, behind two other EURC transfers, and the aggregator path then
// needed more than those ~7.5k of headroom — reverting with "out of gas: not enough gas
// for reentrancy sentry" and stranding the order in AWAITING_SIGNATURE.
describe("signAndBroadcastBaseMainnetTx gas limit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getGasPrice.mockResolvedValue(GAS_PRICE);
    mocks.call.mockResolvedValue(HOLDS_TOKEN);
    mocks.getBalance.mockResolvedValue(10n ** 18n);
    mocks.waitForTransactionReceipt.mockResolvedValue({ status: "success" });
    mocks.getPrivateKey.mockImplementation(async () => freshPrivateKey());
  });

  // The limit the server published is the provider's own simulation of the
  // route. Re-estimating discards it — which is exactly how sk_38670dfb went
  // out on 972,594 while LI.FI had advised 2,574,900.
  it("broadcasts the server's gas limit verbatim, not its own estimate", async () => {
    mocks.estimateGas.mockResolvedValue(1_000_000n);

    await signAndBroadcastBaseMainnetTx({ to: ROUTER, data: "0xdead", gasLimit: 2_574_900n });

    expect(mocks.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ gas: 2_574_900n }),
    );
  });

  // Including when the advisory is LOWER than the local estimate: the server
  // simulated this exact route, so its number wins in both directions.
  it("broadcasts the server's gas limit even when it is below the local estimate", async () => {
    mocks.estimateGas.mockResolvedValue(1_000_000n);

    await signAndBroadcastBaseMainnetTx({ to: ROUTER, data: "0xdead", gasLimit: 900_000n });

    expect(mocks.sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ gas: 900_000n }));
  });

  // No advisory means nothing authoritative to send; the estimate stands as-is
  // rather than being scaled by an invented multiplier.
  it("falls back to the estimate when the server published no limit", async () => {
    mocks.estimateGas.mockResolvedValue(1_000_000n);

    await signAndBroadcastBaseMainnetTx({ to: ROUTER, data: "0xdead" });

    expect(mocks.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ gas: 1_000_000n }),
    );
  });

  // The drip must cover the limit actually broadcast: viem refuses to send when
  // balance < maxFeePerGas × gas, so a large advisory needs matching funding.
  it("funds the gas check against the broadcast limit, not the estimate", async () => {
    mocks.estimateGas.mockResolvedValue(1_000_000n);

    await signAndBroadcastBaseMainnetTx({ to: ROUTER, data: "0xdead", gasLimit: 2_574_900n });

    expect(mocks.getBalance).toHaveBeenCalled();
    expect(mocks.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ gas: 2_574_900n }),
    );
  });
});
