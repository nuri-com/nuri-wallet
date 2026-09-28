import { beforeEach, describe, expect, it, vi } from "vitest";

// Taner, #1361 review 5318314017 item 3: an Arkade-funded swap left its
// committed sats spendable while the funding ran in the background, so a second
// move could race the first and overdraw the wallet.
//
// The rule this pins is the one the app already applies to its internal
// board/offboard transfers: money committed to a move is held from the moment
// it is committed, not from the moment the wallet pays — the server still has
// to create the provider order and issue the funding invoice in between. One
// rule for every path that spends from the same balance.
const m = vi.hoisted(() => ({ hold: vi.fn(), clear: vi.fn() }));

vi.mock("../bitcoin/BitcoinBalanceStore", () => ({
  bitcoinBalanceStore: {
    holdArkadeOutgoingBalance: m.hold,
    clearArkadeOutgoingBalanceHold: m.clear,
    applyOptimisticDebit: vi.fn(),
  },
}));
vi.mock("../balance/WalletBalanceStore", () => ({ walletBalanceStore: {} }));
vi.mock("../balance/TransactionCacheService", () => ({
  getCacheValue: async (): Promise<null> => null,
  setCacheValue: async (): Promise<void> => {},
}));
vi.mock("../balance/UsdcBalanceStore", () => ({ usdcBalanceStore: {} }));
vi.mock("../events/AppEventBusService", () => ({
  EventBus: { emit: vi.fn(), on: (): (() => void) => () => {} },
}));

import { holdV2ArkadeFunding, releaseV2ArkadeFunding } from "./SwapKitV2MoveAccounting";

beforeEach(() => {
  m.hold.mockClear();
  m.clear.mockClear();
});

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("committed Arkade sats are held until the order ends", () => {
  it("holds the committed amount", async () => {
    holdV2ArkadeFunding("ord_a", 11_106);
    await settle();
    expect(m.hold).toHaveBeenCalledWith("v2_order_ord_a", 11_106);
  });

  it("holds the SUM while two orders are in flight, and only drops one on release", async () => {
    // The gap Taner found in the first version: a second order overwrote the
    // first one's hold, and either one finishing cleared it.
    holdV2ArkadeFunding("ord_a", 11_106);
    await settle();
    holdV2ArkadeFunding("ord_b", 7_000);
    await settle();
    expect(m.hold).toHaveBeenLastCalledWith("v2_order_ord_b", 18_106);

    releaseV2ArkadeFunding("ord_a");
    await settle();
    expect(m.hold).toHaveBeenLastCalledWith("v2_order_ord_a_terminal", 7_000);

    releaseV2ArkadeFunding("ord_b");
    await settle();
    expect(m.clear).toHaveBeenLastCalledWith("v2_order_ord_b_terminal");
  });

  it("never holds a nonsense amount", () => {
    holdV2ArkadeFunding("ord_b", 0);
    holdV2ArkadeFunding("ord_b", Number.NaN);
    holdV2ArkadeFunding("ord_b", -5);
    expect(m.hold).not.toHaveBeenCalled();
  });
});
