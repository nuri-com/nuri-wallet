// The shared commit sequence is the point of SwapKitV2CommitFlow: three flows
// previously ran their own copy of it, and the stable→BTC copy silently omitted
// the `executorSpec` step — so a resumed order lost its approval ceiling and
// stranded mid-route. These tests pin the sequence itself, so a fourth flow (or
// a refactor of an existing one) cannot drop a step again.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  commitSwapKitV2: vi.fn(),
  startSwapKitV2Tracking: vi.fn(),
  emitV2SwapRefresh: vi.fn(),
  persistV2CommitIntent: vi.fn(),
  resolveV2CommitIntent: vi.fn(),
  abandonV2CommitIntent: vi.fn(),
  emit: vi.fn(),
  order: [] as string[],
}));

vi.mock("./SwapKitV2Service", () => ({
  commitSwapKitV2: async (...args: unknown[]) => {
    mocks.order.push("commit");
    return mocks.commitSwapKitV2(...args);
  },
  asSwapKitV2OrderId: (id: string) => id,
}));
vi.mock("./SwapKitV2PendingTracker", () => ({
  startSwapKitV2Tracking: (...args: unknown[]) => {
    mocks.order.push("track");
    return mocks.startSwapKitV2Tracking(...args);
  },
  emitV2SwapRefresh: mocks.emitV2SwapRefresh,
}));
vi.mock("./SwapKitV2OrderStore", () => ({
  abandonV2CommitIntent: async (...args: unknown[]) => {
    mocks.order.push("abandon");
    return mocks.abandonV2CommitIntent(...args);
  },
  persistV2CommitIntent: async (...args: unknown[]) => {
    mocks.order.push("persist");
    return mocks.persistV2CommitIntent(...args);
  },
  resolveV2CommitIntent: async (...args: unknown[]) => {
    mocks.order.push("resolve");
    return mocks.resolveV2CommitIntent(...args);
  },
}));
vi.mock("./SwapKitV2RecoveryKey", () => ({
  getSwapKitV2RecoveryKey: vi.fn(async () => "r".repeat(64)),
}));
vi.mock("../events/AppEventBusService", () => ({ EventBus: { emit: mocks.emit } }));

import { commitAndTrackV2Order, isUnresolvedCommitOutcome } from "./SwapKitV2CommitFlow";

const OWNER = "0x1111111111111111111111111111111111111111";

const spec = (over: Record<string, unknown> = {}) => ({
  flow: "direct_evm" as const,
  owner: OWNER,
  from: "USDC_BASE",
  to: "EURC_BASE",
  amount: "12",
  side: "deposit" as const,
  settleTarget: OWNER,
  refundAddress: OWNER,
  acceptedDepositAmount: "12",
  minimumSettleAmount: "11",
  capabilities: ["execute_evm_call"],
  optionId: "opt_1",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
  mocks.commitSwapKitV2.mockResolvedValue({ orderId: "ord_1", status: "COMMITTED", actions: [] });
});

describe("commitAndTrackV2Order", () => {
  it("commits the accepted option by the quoteId the server returned with it", async () => {
    await commitAndTrackV2Order(spec({ quoteId: "q_00000000-0000-4000-8000-000000000001" }));
    expect(mocks.commitSwapKitV2).toHaveBeenCalledWith(
      expect.objectContaining({
        optionId: "opt_1",
        quoteId: "q_00000000-0000-4000-8000-000000000001",
      }),
    );
  });

  it("persists the intent BEFORE committing, so a lost response retries the same order", async () => {
    await commitAndTrackV2Order(spec());
    expect(mocks.order).toEqual(["persist", "commit", "resolve", "track"]);
  });

  it("commits with the exact idempotency and recovery key it persisted", async () => {
    await commitAndTrackV2Order(spec());
    const persisted = mocks.persistV2CommitIntent.mock.calls[0][0];
    const committed = mocks.commitSwapKitV2.mock.calls[0][0];
    expect(committed.idempotencyKey).toBe(persisted.idempotencyKey);
    expect(committed.recoveryKey).toBe(persisted.recoveryKey);
    expect(persisted.recoveryKey).toHaveLength(64);
  });

  it("forwards the consent bounds unchanged to persist and commit", async () => {
    await commitAndTrackV2Order(
      spec({ acceptedDepositAmount: "0.0003", minimumSettleAmount: "17.2" }),
    );
    for (const call of [
      mocks.persistV2CommitIntent.mock.calls[0][0],
      mocks.commitSwapKitV2.mock.calls[0][0],
    ]) {
      expect(call.acceptedDepositAmount).toBe("0.0003");
      expect(call.minimumSettleAmount).toBe("17.2");
    }
  });

  it("persists the executorSpec every flow supplies", async () => {
    const executorSpec = {
      flow: "standard_evm" as const,
      chainId: 8453,
      tokenDecimals: 6,
      acceptedDeposit: "12",
    };
    await commitAndTrackV2Order(spec({ executorSpec }));
    expect(mocks.persistV2CommitIntent.mock.calls[0][0].executorSpec).toEqual(executorSpec);
  });

  it("announces the order id before tracking can report a terminal state", async () => {
    const seen: string[] = [];
    await commitAndTrackV2Order(spec({ onOrderId: (id: string) => seen.push(id) }));
    expect(seen).toEqual(["ord_1"]);
    expect(mocks.order.indexOf("resolve")).toBeLessThan(mocks.order.indexOf("track"));
  });

  it("emits a flow's pending row keyed by the real order id", async () => {
    await commitAndTrackV2Order(
      spec({
        pendingRow: (id: string) => ({
          event: "wallet:pendingTransfer",
          payload: { orderId: id } as Record<string, unknown>,
        }),
      }),
    );
    expect(mocks.emit).toHaveBeenCalledWith("wallet:pendingTransfer", { orderId: "ord_1" });
  });

  it("emits no row for a flow that has no destination surface", async () => {
    await commitAndTrackV2Order(spec({ pendingRow: (): null => null }));
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("hands the flow's bounded executors to the tracker", async () => {
    const loopOptions = { executors: {}, allowedEvmChains: [8453] };
    await commitAndTrackV2Order(spec({ loopOptions }));
    // The bounded set must arrive intact. The tracker also receives the
    // Arkade funding hold alongside it, so assert containment rather than
    // exact equality — a new field here must not read as a lost executor.
    expect(mocks.startSwapKitV2Tracking).toHaveBeenCalledWith(
      "ord_1",
      expect.anything(),
      expect.objectContaining(loopOptions),
    );
  });
});

// Nothing leaves the wallet until the app signs, and the app signs only the
// actions a commit reply hands it. A commit whose reply never arrives — a
// network drop after the server created the order, a 5xx, a re-quote that
// missed the accepted bounds — therefore has nothing signed behind it. It is a
// plain failure the user retries with a fresh price: never an "unresolved"
// outcome, never an intent kept to re-send a stale commit later.
describe("a commit with no reply is a plain, retryable failure", () => {
  const withRow = () =>
    spec({
      pendingRow: (id: string) => ({ event: "wallet:pendingTransfer", payload: { orderId: id } }),
    });

  it("rethrows the error as-is — never flagged unresolved", async () => {
    const lost = new Error("Network request failed");
    mocks.commitSwapKitV2.mockRejectedValue(lost);

    const error = await commitAndTrackV2Order(withRow()).catch((e: unknown) => e);

    expect(error).toBe(lost);
    expect(isUnresolvedCommitOutcome(error)).toBe(false);
  });

  it("drops its intent so no later resume re-sends the stale commit", async () => {
    mocks.commitSwapKitV2.mockRejectedValue(new Error("Network request failed"));

    await commitAndTrackV2Order(withRow()).catch(() => {});

    const key = mocks.persistV2CommitIntent.mock.calls[0][0].idempotencyKey;
    expect(mocks.abandonV2CommitIntent).toHaveBeenCalledWith(key);
    expect(mocks.order).toEqual(["persist", "commit", "abandon"]);
    expect(mocks.startSwapKitV2Tracking).not.toHaveBeenCalled();
  });

  it("retracts the optimistic pill and pending row", async () => {
    mocks.commitSwapKitV2.mockRejectedValue(
      new Error("commit re-quote: settleAmount 0.00006829 is below minimumSettleAmount 0.00006837"),
    );

    await commitAndTrackV2Order(withRow()).catch(() => {});

    expect(
      mocks.emit.mock.calls.filter(([event]) => event === "wallet:clearPendingTransfer").length,
    ).toBeGreaterThan(0);
  });
});

describe("isUnresolvedCommitOutcome", () => {
  it("recognises spends that can move money before their outcome is known (Wirex withdraw)", () => {
    expect(isUnresolvedCommitOutcome(Object.assign(new Error("x"), { unresolved: true }))).toBe(
      true,
    );
    expect(isUnresolvedCommitOutcome(new Error("plain"))).toBe(false);
    expect(isUnresolvedCommitOutcome(null)).toBe(false);
    expect(isUnresolvedCommitOutcome(undefined)).toBe(false);
  });
});
