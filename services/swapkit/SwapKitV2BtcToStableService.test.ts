import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  quoteSwapKitV2: vi.fn(),
  commitSwapKitV2: vi.fn(),
  asSwapKitV2OrderId: (id: string) => id,
  startSwapKitV2Tracking: vi.fn(),
  emitV2SwapRefresh: vi.fn(),
  persistV2CommitIntent: vi.fn(),
  resolveV2CommitIntent: vi.fn(),
  hydrate: vi.fn(),
  listUnresolvedV2CommitIntents: vi.fn(() => []),
  removeOrder: vi.fn(),
  getArkadeReceiveAddress: vi.fn(),
  getBitcoinReceiveAddress: vi.fn(),
  getBitcoinOnchainSendAddress: vi.fn(),
  getWallet: vi.fn(),
  emit: vi.fn(),
  makeStandardV2Executors: vi.fn(() => ({})),
  makeV2SendAsset: vi.fn(() => vi.fn()),
}));

vi.mock("./SwapKitV2Service", () => ({
  SWAPKIT_V2_ACTION_KINDS: [
    "sign_typed_data",
    "send_asset",
    "pay_lightning_invoice",
    "execute_evm_call",
    "arkade_send",
    "arkade_claim",
    "htlc_material",
  ],
  quoteSwapKitV2: mocks.quoteSwapKitV2,
  commitSwapKitV2: mocks.commitSwapKitV2,
  asSwapKitV2OrderId: (id: string) => mocks.asSwapKitV2OrderId(id),
}));
vi.mock("./SwapKitV2PendingTracker", () => ({
  startSwapKitV2Tracking: mocks.startSwapKitV2Tracking,
  emitV2SwapRefresh: mocks.emitV2SwapRefresh,
}));
vi.mock("./SwapKitV2OrderStore", () => ({
  SwapKitV2OrderStore: { hydrate: mocks.hydrate, remove: mocks.removeOrder },
  listUnresolvedV2CommitIntents: mocks.listUnresolvedV2CommitIntents,
  persistV2CommitIntent: mocks.persistV2CommitIntent,
  resolveV2CommitIntent: mocks.resolveV2CommitIntent,
}));
vi.mock("./SwapKitV2Executors", () => ({
  makeStandardV2Executors: mocks.makeStandardV2Executors,
  makeV2SendAsset: mocks.makeV2SendAsset,
}));
vi.mock("./SwapKitV2RecoveryKey", () => ({
  getSwapKitV2RecoveryKey: vi.fn(async () => "r".repeat(64)),
}));
vi.mock("../arkade/ArkadeAddressService", () => ({
  getArkadeReceiveAddress: mocks.getArkadeReceiveAddress,
}));
vi.mock("../bitcoin/BitcoinAddressService", () => ({
  getBitcoinReceiveAddress: mocks.getBitcoinReceiveAddress,
  getBitcoinOnchainSendAddress: mocks.getBitcoinOnchainSendAddress,
}));
vi.mock("../wirex/WirexService", () => ({
  wirexService: { getWallet: mocks.getWallet },
}));
vi.mock("../arkade/ArkadeSendService", () => ({ sendArkadeBitcoinOnchain: vi.fn() }));
vi.mock("../bitcoin/OnchainSendService", () => ({ sendBitcoinOnchainFromMusig2: vi.fn() }));
vi.mock("../events/AppEventBusService", () => ({ EventBus: { emit: mocks.emit } }));

import {
  btcRailRefundAddress,
  executeV2BtcToStable,
  quoteV2BtcToStable,
  resolveCardSettleTarget,
} from "./SwapKitV2BtcToStableService";

const EOA = "0x1111111111111111111111111111111111111111";
const AA = "0x2222222222222222222222222222222222222222";

const option = (over: Record<string, unknown> = {}) => ({
  optionId: "satora:satora:BTC_ARKADE->EURC_BASE",
  from: "BTC_ARKADE",
  to: "EURC_BASE",
  depositAmount: "0.0003",
  settleAmount: "17.2",
  requiredCapabilities: ["htlc_material", "arkade_send", "sign_typed_data", "execute_evm_call"],
  limits: null as unknown,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getArkadeReceiveAddress.mockResolvedValue("ark1own");
  mocks.getBitcoinReceiveAddress.mockResolvedValue("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq");
  mocks.getBitcoinOnchainSendAddress.mockReturnValue("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq");
  mocks.getWallet.mockResolvedValue({ walletAddress: AA });
  mocks.commitSwapKitV2.mockResolvedValue({ orderId: "ord_1", status: "COMMITTED", actions: [] });
});

describe("quoteV2BtcToStable — one rail, one stable", () => {
  it("passes the exact rail and stable through, sats→decimal BTC", async () => {
    mocks.quoteSwapKitV2.mockResolvedValue({ options: [option()], unavailable: [] });

    const { options } = await quoteV2BtcToStable({
      rail: "BTC_ARKADE",
      toStable: "EURC_BASE",
      sats: 30_000,
      owner: EOA,
      settleTarget: EOA,
      refundAddress: EOA,
    });

    expect(mocks.quoteSwapKitV2).toHaveBeenCalledWith(
      expect.objectContaining({ from: "BTC_ARKADE", to: "EURC_BASE", amount: "0.0003" }),
    );
    expect(options[0]).toMatchObject({ from: "BTC_ARKADE", sats: 30_000, settleAmount: 17.2 });
  });

  it("refuses a non-EVM owner", async () => {
    await expect(
      quoteV2BtcToStable({
        rail: "BTC",
        toStable: "USDC_BASE",
        sats: 30_000,
        owner: "not-an-address",
        settleTarget: EOA,
        refundAddress: EOA,
      }),
    ).rejects.toThrow(/Base wallet address/);
  });
});

describe("executeV2BtcToStable — corridor + funder", () => {
  it("commits with the rail, settleTarget, and refund on the wallet's own arkade rail", async () => {
    const { orderId } = await executeV2BtcToStable({
      rail: "BTC_ARKADE",
      toStable: "EURC_BASE",
      sats: 30_000,
      optionId: "satora:satora:BTC_ARKADE->EURC_BASE",
      quotedReceiveStable: 17.2,
      expectedUsdc: 18.9,
      owner: EOA,
      settleTarget: AA,
      destination: "card",
    });

    expect(orderId).toBe("ord_1");
    // Refund is our OWN arkade address, never a server-named one.
    expect(mocks.getArkadeReceiveAddress).toHaveBeenCalled();
    expect(mocks.commitSwapKitV2).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "BTC_ARKADE",
        to: "EURC_BASE",
        settleTarget: AA,
        refundAddress: "ark1own",
        optionId: "satora:satora:BTC_ARKADE->EURC_BASE",
      }),
    );
    // Card settlement adds no wallet pending row.
    expect(mocks.emit).not.toHaveBeenCalled();
    // The arkade rail funds its VHTLC via arkade_send — no send_asset funder.
    expect(mocks.makeV2SendAsset).not.toHaveBeenCalled();
  });

  it("builds a bounded send_asset funder for the on-chain BTC rail", async () => {
    await executeV2BtcToStable({
      rail: "BTC",
      toStable: "EURC_BASE",
      sats: 30_000,
      optionId: "lifi:lifi:BTC->EURC_BASE",
      quotedReceiveStable: 17.2,
      expectedUsdc: 18.9,
      owner: EOA,
      settleTarget: EOA,
      destination: "wallet",
      sendSource: "onchain",
    });

    // On-chain rail refunds to our OWN bitcoin address and adds a send_asset
    // funder bound to the accepted sats.
    expect(mocks.getBitcoinOnchainSendAddress).toHaveBeenCalled();
    expect(mocks.makeV2SendAsset).toHaveBeenCalledWith(
      expect.objectContaining({ expectedAsset: "BTC", boundSats: 30_000 }),
    );
    // Wallet settlement DOES add a wallet pending row.
    expect(mocks.emit).toHaveBeenCalledWith("wallet:pendingTransfer", expect.any(Object));
  });

  it("runs an option with no hub-USDC leg without imposing an approval cap", async () => {
    // A pure send_asset offboard / Lightning route carries no EVM settle leg;
    // it is still executed, just with no maxApprovalUnits ceiling.
    const { orderId } = await executeV2BtcToStable({
      rail: "BTC",
      toStable: "EURC_BASE",
      sats: 30_000,
      optionId: "bitcoinvn:bitcoinvn:BTC->EURC_BASE",
      quotedReceiveStable: 17.2,
      expectedUsdc: null,
      owner: EOA,
      settleTarget: EOA,
      destination: "wallet",
      sendSource: "onchain",
    });

    expect(orderId).toBe("ord_1");
    // Standard executors built WITHOUT an approval cap.
    expect(mocks.makeStandardV2Executors).toHaveBeenCalledWith({});
  });
});

describe("resolveCardSettleTarget — the account a card move pays", () => {
  it("settles a wallet move on the EOA without asking Wirex", async () => {
    await expect(resolveCardSettleTarget("wallet", EOA, "EURC_BASE")).resolves.toBe(EOA);
    expect(mocks.getWallet).not.toHaveBeenCalled();
  });

  it("resolves the Wirex smart account for the card", async () => {
    await expect(resolveCardSettleTarget("card", EOA, "USDC_BASE")).resolves.toBe(AA);
    expect(mocks.getWallet).toHaveBeenCalledWith(EOA);
  });

  it("refuses a card whose account is not ready", async () => {
    mocks.getWallet.mockResolvedValue({ walletAddress: "" });
    await expect(resolveCardSettleTarget("card", EOA, "EURC_BASE")).rejects.toThrow(
      /Card account is not ready/,
    );
  });
});

// Ported from dev (40cffb27, f575a406): an on-chain BTC deposit paid from the
// MuSig2 wallet declares THAT wallet's address, not the empty boarding one.
describe("btcRailRefundAddress — declared Bitcoin address follows the funding wallet", () => {
  const SEND = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";
  it("declares the MuSig2 send address when the on-chain wallet pays", async () => {
    mocks.getBitcoinOnchainSendAddress.mockReturnValue(SEND);
    expect(await btcRailRefundAddress("BTC", "onchain")).toBe(SEND);
  });
  it("refuses (null), never falls back to the boarding address, while the on-chain wallet is unavailable", async () => {
    mocks.getBitcoinOnchainSendAddress.mockReturnValue("");
    expect(await btcRailRefundAddress("BTC", "onchain")).toBeNull();
  });
  it("keeps the receive address when Arkade funds the BTC rail", async () => {
    mocks.getBitcoinOnchainSendAddress.mockReturnValue(SEND);
    expect(await btcRailRefundAddress("BTC", "arkade")).toBe(
      "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
    );
  });
});
