import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressTx } from "../../types/bitcoin";
import type { BtcL2GetTransactionsResult } from "./BtcL2Provider";

const BOARDING = "bc1qboarding";
const MUSIG2 = "bc1qmusig2";

const boardingProvider = { getTransactions: vi.fn() };
const onchainProvider = { getTransactions: vi.fn() };
let musig2Address = MUSIG2;
/** db cache contents, keyed as `btc:<address>`. */
let cache: Record<string, AddressTx[]> = {};

vi.mock("./providers/registry", () => ({
  getBtcL2Provider: () => boardingProvider,
  getBtcL2ProviderFor: () => onchainProvider,
}));
vi.mock("./WalletService", () => ({
  walletService: { getAddressSnapshot: (): { musig2Address: string } => ({ musig2Address }) },
}));
vi.mock("../balance/TransactionCacheService", () => ({
  getCacheValue: async (key: string): Promise<AddressTx[] | null> => cache[key] ?? null,
}));
vi.mock("../pricing/PriceService", () => ({
  priceService: { getPriceForBatch: async () => {} },
}));

const { getBitcoinTransactions } = await import("./BitcoinTransactionsService");

/** A confirmed tx paying `to` from a stranger — reads as "received" for `to`. */
function receiveTx(txid: string, to: string, sats: number): AddressTx {
  return {
    txid,
    vin: [{ prevout: { scriptpubkey_address: "bc1qstranger", value: sats + 500 } }],
    vout: [{ scriptpubkey_address: to, value: sats }],
    status: { confirmed: true, block_time: 1_700_000_000 },
  } as unknown as AddressTx;
}

const emptyResult: BtcL2GetTransactionsResult = {
  rows: [],
  legacyRaw: [],
  isFullCache: false,
  error: null,
};

describe("getBitcoinTransactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    musig2Address = MUSIG2;
    cache = {};
    boardingProvider.getTransactions.mockResolvedValue({ ...emptyResult });
    onchainProvider.getTransactions.mockResolvedValue({ ...emptyResult });
  });

  it("renders the MuSig2 wallet's raw on-chain history", async () => {
    // The on-chain provider hands its txs back raw and leaves `rows` empty for
    // the service to classify.
    onchainProvider.getTransactions.mockResolvedValue({
      ...emptyResult,
      legacyRaw: [receiveTx("aa", MUSIG2, 40_000)],
    });

    const result = await getBitcoinTransactions({ address: BOARDING });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ id: "aa", type: "received", amountSats: 40_000 });
    expect(result.legacyFiltered).toEqual([
      { tx: expect.objectContaining({ txid: "aa" }), address: MUSIG2 },
    ]);
  });

  it("classifies each rail against its own address", async () => {
    boardingProvider.getTransactions.mockResolvedValue({
      ...emptyResult,
      legacyRaw: [receiveTx("bb", BOARDING, 10_000)],
    });
    onchainProvider.getTransactions.mockResolvedValue({
      ...emptyResult,
      legacyRaw: [receiveTx("cc", MUSIG2, 20_000)],
    });

    const result = await getBitcoinTransactions({ address: BOARDING });

    expect(result.legacyFiltered).toEqual([
      { tx: expect.objectContaining({ txid: "bb" }), address: BOARDING },
      { tx: expect.objectContaining({ txid: "cc" }), address: MUSIG2 },
    ]);
    // Both read as received, which only holds when each is billed against its
    // own address.
    expect(result.rows.map((r) => [r.id, r.type, r.amountSats])).toEqual([
      ["bb", "received", 10_000],
      ["cc", "received", 20_000],
    ]);
  });

  it("keeps the MuSig2 rail from its cache when its fetch fails", async () => {
    boardingProvider.getTransactions.mockResolvedValue({
      ...emptyResult,
      legacyRaw: [receiveTx("bb", BOARDING, 10_000)],
    });
    onchainProvider.getTransactions.mockResolvedValue({
      ...emptyResult,
      error: "429 Too Many Requests",
    });
    cache[`btc:${MUSIG2}`] = [receiveTx("cc", MUSIG2, 20_000)];

    const result = await getBitcoinTransactions({ address: BOARDING });

    // The boarding rail alone would leave the union non-empty, so the caller
    // replaces its rows and the MuSig2 history would vanish on a rate-limit.
    expect(result.legacyFiltered).toEqual([
      { tx: expect.objectContaining({ txid: "bb" }), address: BOARDING },
      { tx: expect.objectContaining({ txid: "cc" }), address: MUSIG2 },
    ]);
  });

  it("does not add the MuSig2 cache on top of a live fetch", async () => {
    // The live fetch already merges this cache into its own result.
    onchainProvider.getTransactions.mockResolvedValue({
      ...emptyResult,
      legacyRaw: [receiveTx("cc", MUSIG2, 20_000)],
    });
    cache[`btc:${MUSIG2}`] = [receiveTx("cc", MUSIG2, 20_000)];

    const result = await getBitcoinTransactions({ address: BOARDING });

    expect(result.rows.map((r) => r.id)).toEqual(["cc"]);
  });

  it("leaves the on-chain pass out when no MuSig2 wallet exists", async () => {
    musig2Address = "";
    boardingProvider.getTransactions.mockResolvedValue({
      ...emptyResult,
      legacyRaw: [receiveTx("dd", BOARDING, 5_000)],
    });

    const result = await getBitcoinTransactions({ address: BOARDING });

    expect(onchainProvider.getTransactions).not.toHaveBeenCalled();
    expect(result.legacyFiltered).toEqual([
      { tx: expect.objectContaining({ txid: "dd" }), address: BOARDING },
    ]);
  });
});
