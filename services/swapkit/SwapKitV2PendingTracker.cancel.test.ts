import { beforeEach, describe, expect, it, vi } from "vitest";

// An order the wallet refused to act on before anything left it (a binding
// refusal, a stale provider call) must not sit forever as "Action required":
// when the server confirms it is unfunded it is cancelled there and removed
// here. A funded order — the server refuses the cancel — keeps the old path.
const mocks = vi.hoisted(() => ({
  recoveryKey: vi.fn(),
  runLoop: vi.fn(),
  cancel: vi.fn(),
  emit: vi.fn(),
  applyBalances: vi.fn(),
}));

vi.mock("../../lib/secureKeyStorage", () => ({ getEthereumAddress: vi.fn() }));
vi.mock("./SwapKitV2RecoveryKey", () => ({ getSwapKitV2RecoveryKey: mocks.recoveryKey }));
vi.mock("./SwapKitV2ResumeExecutors", () => ({ rebuildV2ExecutorsForOrder: vi.fn() }));
vi.mock("./SwapKitV2ActionService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./SwapKitV2ActionService")>();
  return { ...actual, runSwapKitV2OrderLoop: mocks.runLoop };
});
vi.mock("./SwapKitV2Executors", () => ({
  makeStandardV2Executors: () => ({}),
  makeRecoveryOnlyV2Executors: () => ({}),
}));
vi.mock("./SwapKitDirectEvmSwapService", () => ({ DIRECT_SWAP_SETTLED_EVENT: "settled" }));
vi.mock("../events/AppEventBusService", () => ({
  EventBus: { emit: mocks.emit, on: () => () => {} },
}));
vi.mock("./SwapKitV2MoveAccounting", () => ({ applyV2TerminalBalances: mocks.applyBalances }));
vi.mock("./SwapKitV2Service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./SwapKitV2Service")>();
  return { ...actual, cancelSwapKitV2Order: mocks.cancel };
});
const cache = new Map<string, unknown>();
vi.mock("../balance/TransactionCacheService", () => ({
  getCacheValue: async (key: string) => cache.get(key) ?? null,
  setCacheValue: async (key: string, value: unknown) => {
    cache.set(key, value);
  },
}));

import { executeAndSubmitV2Action } from "./SwapKitV2ActionService";
import { releaseSwapLoop } from "./SwapKitLoopRegistry";
import { clearV2Moves, getV2Move } from "./SwapKitV2MoveStatus";
import { startSwapKitV2Tracking } from "./SwapKitV2PendingTracker";
import { SwapKitV2OrderStore } from "./SwapKitV2OrderStore";
import { SwapKitV2Error, asSwapKitV2OrderId } from "./SwapKitV2Service";
import commit from "./__fixtures__/lifi-eurc-btc-commit.json";

const ID = commit.orderId;
const [approval, relaySwap] = commit.actions;
// What the server returns once the approval was submitted: only the Relay call
// is left, now ready.
const awaitingSwap = {
  ...commit,
  actions: [{ ...relaySwap, state: "ready" as const, blockedReason: null as string | null }],
};

// The executor's refusal, produced by the real dispatcher so the error carries
// exactly the tag the tracker reads.
async function refusalFromDispatcher(): Promise<unknown> {
  return executeAndSubmitV2Action(asSwapKitV2OrderId(ID), awaitingSwap.actions[0], {
    recoveryKey: "k".repeat(64),
    executors: {
      execute_evm_call: async () => {
        throw new Error("LI.FI bridge does not match this order's settlement.");
      },
    },
  }).catch((error: unknown) => error);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  cache.clear();
  clearV2Moves();
  releaseSwapLoop(ID);
  SwapKitV2OrderStore._resetForTests();
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.recoveryKey.mockResolvedValue("k".repeat(64));
  await SwapKitV2OrderStore.upsert({
    orderId: ID,
    owner: "0x00993cA379abd3F6c79E439c54a1AB2e7c95234B",
    from: "EURC_BASE",
    to: "BTC",
    amount: "7",
    side: "deposit",
    settleTarget: commit.accepted.settleTarget,
    idempotencyKey: "idem",
    recoveryKey: "k".repeat(64),
    status: "AWAITING_ACTION",
    flow: "stable_to_btc",
    createdAt: 1,
    updatedAt: 1,
  });
});

describe("an unfunded order the wallet refused", () => {
  it("is cancelled on the server and removed from the device", async () => {
    const refusal = await refusalFromDispatcher();
    mocks.runLoop.mockImplementation(
      async (_view: unknown, _id: string, options: { onUpdate?: (v: unknown) => void }) => {
        options.onUpdate?.(awaitingSwap);
        throw refusal;
      },
    );
    mocks.cancel.mockResolvedValue({ ...commit, status: "EXPIRED", actions: [] });

    startSwapKitV2Tracking(ID, commit as never);
    await vi.waitFor(() => expect(mocks.cancel).toHaveBeenCalled());
    await settle();

    expect(mocks.cancel).toHaveBeenCalledWith(ID, { recoveryKey: "k".repeat(64) });
    // Never "Action required": the move ends, its row and pending row go.
    expect(getV2Move(ID)?.phase).toBe("failed");
    expect(SwapKitV2OrderStore.get(ID)).toBeNull();
    expect(mocks.emit).toHaveBeenCalledWith("wallet:clearPendingTransfer", {
      txHash: null,
      orderId: ID,
    });
  });

  it("is cancelled when the route needs an action this order cannot run", async () => {
    mocks.runLoop.mockRejectedValue(
      new SwapKitV2Error("SwapKit v2 route needs an action this flow cannot execute", {
        code: "unsupported_action_kind",
      }),
    );
    mocks.cancel.mockResolvedValue({ ...commit, status: "EXPIRED", actions: [] });

    startSwapKitV2Tracking(ID, commit as never);
    await vi.waitFor(() => expect(mocks.cancel).toHaveBeenCalled());
    await settle();

    expect(SwapKitV2OrderStore.get(ID)).toBeNull();
    expect(getV2Move(ID)?.phase).toBe("failed");
  });
});

describe("what is never cancelled", () => {
  it("keeps a funded order when the server refuses the cancel", async () => {
    const refusal = await refusalFromDispatcher();
    mocks.runLoop.mockRejectedValue(refusal);
    mocks.cancel.mockRejectedValue(new Error("cancel: order has moved funds"));

    startSwapKitV2Tracking(ID, commit as never);
    await vi.waitFor(() => expect(getV2Move(ID)?.phase).toBe("action_required"));

    expect(SwapKitV2OrderStore.get(ID)).not.toBeNull();
  });

  it("does not cancel after a failure that may have broadcast", async () => {
    mocks.runLoop.mockRejectedValue(
      new SwapKitV2Error("started without durable evidence", {
        code: "action_reconciliation_required",
      }),
    );

    startSwapKitV2Tracking(ID, commit as never);
    await vi.waitFor(() => expect(getV2Move(ID)?.phase).toBe("action_required"));

    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(SwapKitV2OrderStore.get(ID)).not.toBeNull();
  });

  it("does not cancel an order whose live action this device already journaled", async () => {
    // Evidence for the approval exists here, so its submit may not have landed.
    cache.set("swapkit:v2-evidence:v2", {
      [`${ID}\u0000${approval.actionId}`]: { txHash: "0xabc", result: {} },
    });
    const refusal = await refusalFromDispatcher();
    mocks.runLoop.mockImplementation(
      async (_view: unknown, _id: string, options: { onUpdate?: (v: unknown) => void }) => {
        options.onUpdate?.(commit);
        throw refusal;
      },
    );

    startSwapKitV2Tracking(ID, commit as never);
    await vi.waitFor(() => expect(getV2Move(ID)?.phase).toBe("action_required"));

    expect(mocks.cancel).not.toHaveBeenCalled();
  });
});
