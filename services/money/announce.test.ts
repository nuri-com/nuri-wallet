import { beforeEach, describe, expect, it, vi } from "vitest";

// The bug this pins, end to end: topping the card up from the euro wallet
// showed the money leaving the wallet and NEVER arriving on the card. The card
// pockets had no pending source of their own - the only rows they ever drew
// came from a hand-written special case for bitcoin purchases, so Visa USD
// showed nothing at all, ever.
//
// Card top-ups now announce into the one in-flight store, which names both
// screens, and the card rails read it like any other rail.
const mocks = vi.hoisted(() => ({ emit: vi.fn() }));
vi.mock("../events/AppEventBusService", () => ({
  EventBus: { emit: mocks.emit, on: (): (() => void) => () => {} },
}));
vi.mock("../balance/TransactionCacheService", () => ({
  getCacheValue: async (): Promise<null> => null,
  setCacheValue: async (): Promise<void> => {},
}));

import {
  finishInFlight,
  startCardTopUpInFlight,
  startSendInFlight,
  startSwapInFlight,
} from "./announce";
import { MoneyInFlightStore, railLeg } from "./MoneyInFlightStore";

const OWN = {
  arkade: "ark1own",
  onchain: "bc1own",
  evm: "0xEOA",
  card: "0xCARD",
};

beforeEach(() => {
  MoneyInFlightStore._resetForTests();
  mocks.emit.mockClear();
});

const legs = (id: string) => {
  const record = MoneyInFlightStore.list().find((row) => row.id === id);
  if (!record) return null;
  return {
    from: record.from?.rail ?? null,
    to: record.to?.rail ?? null,
  };
};

describe("a card top-up shows on the wallet AND the card pocket", () => {
  it("euro wallet -> Visa EUR", async () => {
    await startCardTopUpInFlight({ id: "tx1", amount: 25, fiat: "EUR" });
    expect(legs("tx1")).toEqual({ from: "wallet", to: "visa" });
  });

  it("dollar wallet -> Visa USD", async () => {
    await startCardTopUpInFlight({ id: "tx2", amount: 25, fiat: "USD" });
    expect(legs("tx2")).toEqual({ from: "dollar", to: "visaUsd" });
  });
});

describe("a swap names both of its screens, from its assets and addresses", () => {
  it("bitcoin -> card credits the POCKET, not the wallet of the same currency", async () => {
    await startSwapInFlight({
      orderId: "ord1",
      from: "BTC_ARKADE",
      to: "USDC_BASE",
      sendAmount: 10_000,
      receiveAmount: 7,
      settleTarget: OWN.card,
      own: OWN,
      cardPocket: "USD",
    });
    expect(legs("ord1")).toEqual({ from: "arkade", to: "visaUsd" });
  });

  it("bitcoin -> wallet credits the wallet", async () => {
    await startSwapInFlight({
      orderId: "ord2",
      from: "BTC_ARKADE",
      to: "EURC_BASE",
      sendAmount: 10_000,
      receiveAmount: 7,
      settleTarget: OWN.evm,
      own: OWN,
    });
    expect(legs("ord2")).toEqual({ from: "arkade", to: "wallet" });
  });

  it("arkade -> our own on-chain address is a move; both rails draw it", async () => {
    await startSwapInFlight({
      orderId: "ord3",
      from: "BTC_LN",
      to: "BTC",
      sendAmount: 10_000,
      receiveAmount: 9_800,
      settleTarget: OWN.onchain,
      own: OWN,
    });
    expect(legs("ord3")).toEqual({ from: "arkade", to: "onchain" });
  });

  it("arkade -> a STRANGER's address debits arkade and credits nothing", async () => {
    await startSwapInFlight({
      orderId: "ord4",
      from: "BTC_LN",
      to: "BTC",
      sendAmount: 10_000,
      receiveAmount: 9_800,
      settleTarget: "bc1qstranger",
      own: OWN,
    });
    expect(legs("ord4")).toEqual({ from: "arkade", to: null });
  });

  it("stable -> stable draws on both wallets", async () => {
    await startSwapInFlight({
      orderId: "ord5",
      from: "EURC_BASE",
      to: "USDC_BASE",
      sendAmount: 10,
      receiveAmount: 11,
      settleTarget: OWN.evm,
      own: OWN,
    });
    expect(legs("ord5")).toEqual({ from: "wallet", to: "dollar" });
  });
});

describe("plain sends and the single clear", () => {
  it("a bitcoin send debits its rail only", async () => {
    await startSendInFlight({ id: "txid9", rail: "onchain", amount: 5_000 });
    const record = MoneyInFlightStore.list()[0];
    expect(railLeg(record, "onchain")?.direction).toBe("out");
    expect(railLeg(record, "arkade")).toBeNull();
  });

  it("one finish retires both ends of a move", async () => {
    await startCardTopUpInFlight({ id: "tx3", amount: 5, fiat: "EUR" });
    expect(MoneyInFlightStore.list()).toHaveLength(1);
    await finishInFlight("tx3");
    expect(MoneyInFlightStore.list()).toHaveLength(0);
  });
});
