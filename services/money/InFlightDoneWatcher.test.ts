import { beforeEach, describe, expect, it, vi } from "vitest";

// Every pending row clears itself when its action is done — no producer has to
// remember to. Each kind of record is judged by its own rule; a record whose
// action is still running stays, whatever its age.
const mocks = vi.hoisted(() => ({
  orders: new Map<string, { orderId: string; status: string }>(),
  baseOutcome: vi.fn(async (): Promise<"pending" | "success" | "reverted"> => "pending"),
  sends: [] as Array<{ txid: string }>,
  purchases: [] as Array<{ id: string }>,
  withdrawing: false,
  sepaSettled: false as boolean | null,
}));

vi.mock("../events/AppEventBusService", () => ({
  EventBus: { emit: vi.fn(), on: (): (() => void) => () => {} },
}));
vi.mock("../balance/TransactionCacheService", () => ({
  getCacheValue: async (): Promise<null> => null,
  setCacheValue: async (): Promise<void> => {},
}));
vi.mock("../base/BaseTokenTransferService", () => ({
  getBaseTransactionOutcome: mocks.baseOutcome,
}));
vi.mock("../bitcoin/PendingBitcoinSendsStore", () => ({
  PendingBitcoinSendsStore: { list: async () => mocks.sends },
}));
vi.mock("../app/PendingPurchasesStore", () => ({
  PendingPurchasesStore: { hydrate: async () => {}, list: () => mocks.purchases },
}));
vi.mock("../swapkit/SwapKitV2OrderStore", () => ({
  SwapKitV2OrderStore: {
    hydrate: async () => {},
    get: (id: string) => mocks.orders.get(id) ?? null,
  },
}));
vi.mock("../swapkit/SwapKitV2Service", () => ({
  SWAPKIT_V2_TERMINAL_STATUSES: new Set([
    "COMPLETED",
    "FAILED",
    "REFUNDED",
    "EXPIRED",
    "CANCELLED",
  ]),
}));
vi.mock("../wirex/WirexService", () => ({
  wirexService: {
    hasUnresolvedWithdrawal: async () => mocks.withdrawing,
    isSepaTransferSettled: async () => mocks.sepaSettled,
  },
}));
vi.mock("../app/ForegroundPoller", () => ({
  createForegroundPoller: () => ({ start: () => {}, stop: () => {} }),
}));
vi.mock("../app/NetworkStatusService", () => ({
  getNetworkStatus: () => ({ isWaitingForNetwork: false }),
}));

import { checkInFlightOnce } from "./InFlightDoneWatcher";
import { MoneyInFlightStore, type MoneyInFlight } from "./MoneyInFlightStore";

const OLD = new Date(Date.now() - 10 * 60_000).toISOString();
const HASH = `0x${"ab".repeat(32)}`;

const record = (id: string, kind: MoneyInFlight["kind"]): MoneyInFlight => ({
  id,
  from: { rail: "wallet", amount: 5, unit: "EUR" },
  to: { rail: "visa", amount: 5, unit: "EUR" },
  kind,
  createdAt: OLD,
});
const ids = () => MoneyInFlightStore.list().map((row) => row.id);

beforeEach(() => {
  MoneyInFlightStore._resetForTests();
  mocks.orders.clear();
  mocks.baseOutcome.mockResolvedValue("pending");
  mocks.sends = [];
  mocks.purchases = [];
  mocks.withdrawing = false;
  mocks.sepaSettled = false;
});

describe("every pending row clears itself when its action is done", () => {
  it("a swap: stays while the order runs, clears on a terminal status", async () => {
    mocks.orders.set("ord_1", { orderId: "ord_1", status: "PROCESSING" });
    await MoneyInFlightStore.start(record("ord_1", "swap"));
    await checkInFlightOnce();
    expect(ids()).toEqual(["ord_1"]);
    mocks.orders.set("ord_1", { orderId: "ord_1", status: "COMPLETED" });
    await checkInFlightOnce();
    expect(ids()).toEqual([]);
  });

  it("a card top-up: stays until its Base tx has a receipt", async () => {
    await MoneyInFlightStore.start(record(HASH, "card_topup"));
    await checkInFlightOnce();
    expect(ids()).toEqual([HASH]);
    mocks.baseOutcome.mockResolvedValue("success");
    await checkInFlightOnce();
    expect(ids()).toEqual([]);
  });

  it("a EUR/USD send: same, by its tx hash", async () => {
    await MoneyInFlightStore.start({ ...record(HASH, "send"), to: null });
    mocks.baseOutcome.mockResolvedValue("reverted");
    await checkInFlightOnce();
    expect(ids()).toEqual([]);
  });

  it("a bitcoin send: lives exactly as long as its confirmation entry", async () => {
    mocks.sends = [{ txid: "f".repeat(64) }];
    await MoneyInFlightStore.start({ ...record("f".repeat(64), "send"), to: null });
    await checkInFlightOnce();
    expect(ids()).toHaveLength(1);
    mocks.sends = [];
    await checkInFlightOnce();
    expect(ids()).toEqual([]);
  });

  it("a bitcoin purchase: until its sats arrive", async () => {
    mocks.purchases = [{ id: "mtid_1" }];
    await MoneyInFlightStore.start({ ...record("mtid_1", "purchase"), from: null });
    await checkInFlightOnce();
    expect(ids()).toEqual(["mtid_1"]);
    mocks.purchases = [];
    await checkInFlightOnce();
    expect(ids()).toEqual([]);
  });

  it("a card withdrawal: until the withdrawal is resolved", async () => {
    mocks.withdrawing = true;
    await MoneyInFlightStore.start(record("wirex-withdraw:EURC:5:1", "card_withdraw"));
    await checkInFlightOnce();
    expect(ids()).toHaveLength(1);
    mocks.withdrawing = false;
    await checkInFlightOnce();
    expect(ids()).toEqual([]);
  });

  it("a SEPA transfer: until the bank feed shows it settled; no answer is no verdict", async () => {
    await MoneyInFlightStore.start({ ...record("tr_1", "sepa"), to: null });
    mocks.sepaSettled = null;
    await checkInFlightOnce();
    expect(ids()).toEqual(["tr_1"]);
    mocks.sepaSettled = true;
    await checkInFlightOnce();
    expect(ids()).toEqual([]);
  });

  it("a record just written is not cleared before its backing entry exists", async () => {
    await MoneyInFlightStore.start({
      ...record("g".repeat(64), "send"),
      to: null,
      createdAt: new Date().toISOString(),
    });
    await checkInFlightOnce();
    expect(ids()).toHaveLength(1);
  });

  it("an RPC failure is not a verdict", async () => {
    mocks.baseOutcome.mockRejectedValue(new Error("rpc down"));
    await MoneyInFlightStore.start(record(HASH, "card_topup"));
    await checkInFlightOnce();
    expect(ids()).toEqual([HASH]);
  });
});
