import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../events/AppEventBusService", () => ({
  EventBus: { emit: vi.fn() },
}));
vi.mock("./MercuryoStatusService", () => ({
  fetchMercuryoStatus: vi.fn(),
}));
vi.mock("../../lib/support/reportErrorToSupport", () => ({
  reportErrorToSupport: vi.fn().mockResolvedValue(undefined),
}));

import { reportErrorToSupport } from "../../lib/support/reportErrorToSupport";
import { PendingPurchasesStore } from "../app/PendingPurchasesStore";
import { MercuryoOrderStore, type MercuryoOrder } from "./MercuryoOrderStore";
import {
  hydrateAndResumeMercuryoOrders,
  startMercuryoOrderTracking,
  stopAllMercuryoTracking,
} from "./MercuryoPendingTracker";
import { fetchMercuryoStatus } from "./MercuryoStatusService";

const order = (over: Partial<MercuryoOrder> = {}): MercuryoOrder => ({
  mtid: "m-1",
  createdAt: Date.now(),
  amountFiat: 25,
  amountSats: 30_000,
  fiat: "EUR",
  crypto: "BTC",
  payment: "applepay",
  address: "bc1qdest",
  openUrl: "https://buybitcoin.nuri.com/buy?merchant_transaction_id=m-1",
  ...over,
});

// A terminal first tick still chains several awaited storage writes, so the
// assertions wait for the loop to actually finish rather than a fixed tick count.
const settle = async (until: () => boolean = () => true) => {
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (until()) return;
  }
};

beforeEach(async () => {
  vi.clearAllMocks();
  // Loops outlive the store, by design — drop them or a previous test's poller
  // keeps writing into the next one.
  stopAllMercuryoTracking();
  await MercuryoOrderStore.clear();
  await PendingPurchasesStore.clear();
});

describe("startMercuryoOrderTracking", () => {
  it("records the order durably before any status is known, and shows no activity row yet", async () => {
    vi.mocked(fetchMercuryoStatus).mockResolvedValue(null);

    await startMercuryoOrderTracking(order());

    // The handoff is durable — this is what survives an app kill in checkout.
    expect(MercuryoOrderStore.list().map((o) => o.mtid)).toEqual(["m-1"]);
    // ...but an unpaid handoff is not a purchase, so nothing is visible.
    expect(PendingPurchasesStore.list()).toEqual([]);
  });

  it("promotes to a visible pending purchase once the provider reports paid", async () => {
    vi.mocked(fetchMercuryoStatus).mockResolvedValue({
      status: "paid",
      amountSats: 31_234,
      transactionId: "tx-1",
    });

    await startMercuryoOrderTracking(order());
    await settle(() => PendingPurchasesStore.list().length > 0);

    const rows = PendingPurchasesStore.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "m-1",
      source: "mercuryo",
      address: "bc1qdest",
      amountFiat: 25,
      // The settled figure replaces the spot estimate captured at handoff.
      amountSats: 31_234,
    });
    // The order is done; nothing should keep polling it.
    expect(MercuryoOrderStore.list()).toEqual([]);
  });

  it("drops the order and reports to support on a failure, leaving no activity row", async () => {
    vi.mocked(fetchMercuryoStatus).mockResolvedValue({
      status: "card_declined",
      failureReason: "insufficient funds",
    });

    await startMercuryoOrderTracking(order());
    await settle(() => MercuryoOrderStore.list().length === 0);

    expect(MercuryoOrderStore.list()).toEqual([]);
    expect(PendingPurchasesStore.list()).toEqual([]);
    expect(reportErrorToSupport).toHaveBeenCalledTimes(1);
  });

  it("stays silent when the user cancels — no charge, nothing to report", async () => {
    vi.mocked(fetchMercuryoStatus).mockResolvedValue({ status: "cancelled" });

    await startMercuryoOrderTracking(order());
    await settle(() => MercuryoOrderStore.list().length === 0);

    expect(MercuryoOrderStore.list()).toEqual([]);
    expect(PendingPurchasesStore.list()).toEqual([]);
    expect(reportErrorToSupport).not.toHaveBeenCalled();
  });

  it("replaces an older placeholder for the same address rather than stacking two", async () => {
    vi.mocked(fetchMercuryoStatus).mockResolvedValue({ status: "paid", amountSats: 1_000 });

    await startMercuryoOrderTracking(order({ mtid: "m-old" }));
    await settle(() => PendingPurchasesStore.list().some((r) => r.id === "m-old"));
    await startMercuryoOrderTracking(order({ mtid: "m-new" }));
    await settle(() => PendingPurchasesStore.list().some((r) => r.id === "m-new"));

    // Both purchases target one address, so one incoming tx would otherwise be
    // matched against two rows.
    expect(PendingPurchasesStore.list().map((r) => r.id)).toEqual(["m-new"]);
  });
});

describe("hydrateAndResumeMercuryoOrders", () => {
  it("picks up an order left open by a previous session", async () => {
    vi.mocked(fetchMercuryoStatus).mockResolvedValue(null);
    await MercuryoOrderStore.add(order({ mtid: "m-resumed" }));
    vi.mocked(fetchMercuryoStatus).mockResolvedValue({ status: "paid", amountSats: 500 });

    await hydrateAndResumeMercuryoOrders();
    await settle(() => PendingPurchasesStore.list().length > 0);

    expect(PendingPurchasesStore.list().map((r) => r.id)).toEqual(["m-resumed"]);
  });

  it("expires an order past the TTL instead of polling it forever", async () => {
    vi.mocked(fetchMercuryoStatus).mockResolvedValue(null);
    const old = Date.now() - 25 * 60 * 60 * 1000; // past the 24h TTL
    await MercuryoOrderStore.add(order({ mtid: "m-stale", createdAt: old }));

    await hydrateAndResumeMercuryoOrders();
    await settle(() => MercuryoOrderStore.list().length === 0);

    expect(MercuryoOrderStore.list()).toEqual([]);
    expect(PendingPurchasesStore.list()).toEqual([]);
    expect(fetchMercuryoStatus).not.toHaveBeenCalled();
  });

  it("does not start a second poller for an order already being followed", async () => {
    vi.mocked(fetchMercuryoStatus).mockResolvedValue(null);

    await startMercuryoOrderTracking(order({ mtid: "m-dup" }));
    const afterStart = vi.mocked(fetchMercuryoStatus).mock.calls.length;
    await hydrateAndResumeMercuryoOrders();

    expect(vi.mocked(fetchMercuryoStatus).mock.calls.length).toBe(afterStart);
  });
});
