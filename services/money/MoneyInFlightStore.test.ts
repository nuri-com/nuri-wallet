import { beforeEach, describe, expect, it } from "vitest";

// THE RULE: a move shows on the screen it leaves AND the screen it arrives on.
//
// This test walks every move the Move sheet can hold and fails when either end
// is missing. It exists because this area produced a run of one-off bugs - the
// card pockets drew rows only for bitcoin purchases, Visa USD drew nothing
// ever, and a bitcoin-to-bitcoin move drew nothing at all - each fixed
// individually while the next one waited. A new rail or route cannot be added
// without both of its ends appearing here.
import {
  MONEY_RAILS,
  MoneyInFlightStore,
  type MoneyInFlight,
  type MoneyRail,
  railLeg,
} from "./MoneyInFlightStore";

// The Move sheet's own pairing rule (screens/home/movePairs.ts): the card's
// pockets pay out only to the wallet holding the same currency; every other
// source reaches every other rail. The IBAN is not a Move rail - it is the same
// Wirex euros the card's euro pocket states.
const exitsFor = (from: MoneyRail): MoneyRail[] | null => {
  if (from === "visaUsd") return ["dollar"];
  if (from === "visa") return ["wallet"];
  return null;
};

const MOVE_PAIRS: Array<[MoneyRail, MoneyRail]> = [];
for (const from of MONEY_RAILS) {
  const exits = exitsFor(from);
  for (const to of MONEY_RAILS) {
    if (from === to) continue;
    if (exits !== null && !exits.includes(to)) continue;
    MOVE_PAIRS.push([from, to]);
  }
}

const unitFor = (rail: MoneyRail) =>
  rail === "onchain" || rail === "arkade"
    ? ("sats" as const)
    : rail === "dollar" || rail === "visaUsd"
      ? ("USD" as const)
      : ("EUR" as const);

const move = (from: MoneyRail, to: MoneyRail, id = `ord_${from}_${to}`): MoneyInFlight => ({
  id,
  from: { rail: from, amount: 100, unit: unitFor(from) },
  to: { rail: to, amount: 90, unit: unitFor(to) },
  kind: "swap",
  createdAt: new Date().toISOString(),
});

beforeEach(() => {
  MoneyInFlightStore._resetForTests();
});

describe("every move shows on both of its screens", () => {
  it("covers every pair the Move sheet can hold", () => {
    // 4 wallets x 5 exits + 2 card pockets x 1 exit.
    expect(MOVE_PAIRS.length).toBe(22);
  });

  it.each(MOVE_PAIRS)("%s -> %s draws a row on both rails", (from, to) => {
    const record = move(from, to);
    const source = railLeg(record, from);
    const destination = railLeg(record, to);

    expect(source, `${from} (source) must draw a row`).not.toBeNull();
    expect(source?.direction).toBe("out");
    expect(source?.leg.amount).toBe(100);

    expect(destination, `${to} (destination) must draw a row`).not.toBeNull();
    expect(destination?.direction).toBe("in");
    expect(destination?.leg.amount).toBe(90);

    // And no OTHER rail claims it.
    for (const rail of MONEY_RAILS) {
      if (rail === from || rail === to) continue;
      expect(railLeg(record, rail), `${rail} must not claim this move`).toBeNull();
    }
  });
});

describe("money leaving the app, and money arriving from outside it", () => {
  it("a send to someone else debits its rail and credits nothing", () => {
    const send: MoneyInFlight = {
      id: "txid1",
      from: { rail: "arkade", amount: 10_000, unit: "sats" },
      to: null,
      kind: "send",
      createdAt: new Date().toISOString(),
    };
    expect(railLeg(send, "arkade")?.direction).toBe("out");
    for (const rail of MONEY_RAILS) {
      if (rail === "arkade") continue;
      expect(railLeg(send, rail)).toBeNull();
    }
  });

  it("a purchase credits its rail and debits nothing", () => {
    const buy: MoneyInFlight = {
      id: "buy1",
      from: null,
      to: { rail: "onchain", amount: 50_000, unit: "sats" },
      kind: "purchase",
      createdAt: new Date().toISOString(),
    };
    expect(railLeg(buy, "onchain")?.direction).toBe("in");
    for (const rail of MONEY_RAILS) {
      if (rail === "onchain") continue;
      expect(railLeg(buy, rail)).toBeNull();
    }
  });

  it("a move whose two ends are the same rail shows the spend only", () => {
    // Arkade -> Lightning: the money leaves and returns on one screen. One row.
    const record = move("arkade", "arkade", "ord_same");
    expect(railLeg(record, "arkade")?.direction).toBe("out");
  });
});

describe("one record, one clear", () => {
  it("retires both ends of a move in a single call", async () => {
    await MoneyInFlightStore.start(move("wallet", "visaUsd", "ord_x"));
    expect(MoneyInFlightStore.list()).toHaveLength(1);
    await MoneyInFlightStore.finish("ord_x");
    expect(MoneyInFlightStore.list()).toHaveLength(0);
  });

  it("re-announcing a move replaces it rather than drawing a second row", async () => {
    await MoneyInFlightStore.start(move("arkade", "wallet", "ord_y"));
    await MoneyInFlightStore.start(move("arkade", "wallet", "ord_y"));
    expect(MoneyInFlightStore.list()).toHaveLength(1);
  });

  it("refuses a record that names no screen at all", async () => {
    await MoneyInFlightStore.start({
      id: "bad",
      from: null,
      to: null,
      kind: "swap",
      createdAt: new Date().toISOString(),
    });
    expect(MoneyInFlightStore.list()).toHaveLength(0);
  });
});
