// A commit intent that never got its reply has nothing signed behind it: the
// reply replaces the intent row BEFORE any action runs. So an intent left by an
// earlier launch — killed mid-commit, or kept "ambiguous" by an older build —
// is dropped on foreground, never replayed under its stale idempotency key
// (which re-quoted, failed the accepted bounds, and looped forever).
import { beforeEach, describe, expect, it, vi } from "vitest";

const cache = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("../balance/TransactionCacheService", () => ({
  getCacheValue: async () => cache.value,
  setCacheValue: async (_key: string, value: unknown) => {
    cache.value = JSON.parse(JSON.stringify(value));
  },
}));
const emit = vi.hoisted(() => vi.fn());
vi.mock("../events/AppEventBusService", () => ({ EventBus: { emit } }));

import {
  SwapKitV2OrderStore,
  discardUnsignedV2CommitIntents,
  listUnresolvedV2CommitIntents,
  persistV2CommitIntent,
} from "./SwapKitV2OrderStore";

const OWNER = "0x0099000000000000000000000000000000000000";

const intentRow = (key: string, over: Record<string, unknown> = {}) => ({
  orderId: `ord_pending:${key}`,
  owner: OWNER,
  from: "EURC_BASE",
  to: "BTC",
  amount: "6",
  side: "deposit",
  settleTarget: "bc1pboarding",
  acceptedDepositAmount: "6",
  minimumSettleAmount: "0.00006837",
  idempotencyKey: key,
  status: "COMMITTING",
  flow: "stable_to_btc",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

beforeEach(() => {
  cache.value = undefined;
  emit.mockClear();
  SwapKitV2OrderStore._resetForTests();
});

describe("discardUnsignedV2CommitIntents", () => {
  it("drops an intent persisted by an earlier launch, keeping real orders", async () => {
    // What the incident device had on disk: the retained stable_to_btc intent
    // plus an ordinary order that must be left for the tracker.
    cache.value = [
      intentRow("expo:0x0099:1790195713599:qasf0qcy"),
      { ...intentRow("k2"), orderId: "ord_real", status: "IN_FLIGHT" },
    ];

    await discardUnsignedV2CommitIntents();

    expect(listUnresolvedV2CommitIntents()).toEqual([]);
    expect(SwapKitV2OrderStore.list().map((row) => row.orderId)).toEqual(["ord_real"]);
    // Its optimistic pending row goes with it, or it stays pending forever.
    expect(emit).toHaveBeenCalledWith("wallet:clearPendingTransfer", {
      txHash: null,
      orderId: "pending:expo:0x0099:1790195713599:qasf0qcy",
    });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("leaves an intent whose commit is in flight in THIS launch alone", async () => {
    await persistV2CommitIntent({
      idempotencyKey: "live",
      owner: OWNER,
      from: "EURC_BASE",
      to: "BTC",
      amount: "6",
      side: "deposit",
      settleTarget: "bc1pboarding",
      acceptedDepositAmount: "6",
      minimumSettleAmount: "0.00006837",
      flow: "stable_to_btc",
    });

    await discardUnsignedV2CommitIntents();

    // The reply may still arrive and turn this row into the order's durable row.
    expect(listUnresolvedV2CommitIntents().map((row) => row.idempotencyKey)).toEqual(["live"]);
  });
});
