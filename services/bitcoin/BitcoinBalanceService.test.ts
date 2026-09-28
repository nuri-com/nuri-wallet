import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_BITCOIN_BALANCE, type BitcoinBalance } from "./balanceShape";

const MUSIG2 = "bc1qmusig2";
const arkadeProvider = { getBalance: vi.fn() };
const onchainProvider = { getBalance: vi.fn() };
let musig2Address = MUSIG2;

vi.mock("./providers/registry", () => ({
  getBtcL2Provider: () => arkadeProvider,
  getBtcL2ProviderFor: () => onchainProvider,
}));
vi.mock("./WalletService", () => ({
  walletService: { getAddressSnapshot: () => ({ musig2Address }) },
}));

const { getBitcoinBalance } = await import("./BitcoinBalanceService");

function onchainBalance(confirmed: number, unconfirmed: number, txCount: number): BitcoinBalance {
  const total = confirmed + unconfirmed;
  return {
    total,
    byChannel: { onchain: total, arkade: 0, lightning: 0 },
    detail: {
      onchain: { confirmed, unconfirmed, txCount },
      arkade: { boardingConfirmed: 0, boardingUnconfirmed: 0 },
    },
  };
}

describe("getBitcoinBalance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    musig2Address = MUSIG2;
    arkadeProvider.getBalance.mockResolvedValue({
      ...EMPTY_BITCOIN_BALANCE,
      total: 7_000,
      byChannel: { onchain: 0, arkade: 7_000, lightning: 0 },
    });
    onchainProvider.getBalance.mockResolvedValue(onchainBalance(1_000, 200, 3));
  });

  it("reads only the current v4 L1 address", async () => {
    const read = await getBitcoinBalance({});
    expect(onchainProvider.getBalance).toHaveBeenCalledTimes(1);
    expect(onchainProvider.getBalance).toHaveBeenCalledWith({
      address: MUSIG2,
      forceFresh: undefined,
    });
    expect(read.byChannel.onchain).toBe(1_200);
    expect(read.detail.onchain).toEqual({
      confirmed: 1_000,
      unconfirmed: 200,
      txCount: 3,
      spendable: 1_200,
    });
    expect(read.total).toBe(7_000);
  });

  it("reports a failed read instead of a false zero", async () => {
    onchainProvider.getBalance.mockRejectedValue(new Error("429"));
    const read = await getBitcoinBalance({});
    expect(read.onchainRead).toBe("failed");
    expect(read.byChannel.onchain).toBe(0);
    expect(read.detail.onchain.spendable).toBe(0);
  });

  it("reads no L1 balance for an arkade-only identity", async () => {
    musig2Address = "";
    const read = await getBitcoinBalance({});
    expect(onchainProvider.getBalance).not.toHaveBeenCalled();
    expect(read.onchainRead).toBe("ok");
    expect(read.byChannel.onchain).toBe(0);
  });
});
