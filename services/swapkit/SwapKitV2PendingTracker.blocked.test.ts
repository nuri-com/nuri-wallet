import { beforeEach, describe, expect, it, vi } from "vitest";

// Who may be told "you have to do something about this move", and when.
//
// The pill's action_required CTA re-arms a STOPPED tracking loop. While a loop
// still holds the order's registry claim, that resume is refused and does
// nothing — so an order whose loop is alive must never be reported as needing
// the user, however blocked its current action looks. The loop is polling and
// will run the action the moment the server unblocks it.
const mocks = vi.hoisted(() => ({
  getEthereumAddress: vi.fn(),
  rebuildExecutors: vi.fn(),
  recoveryKey: vi.fn(),
  getStatus: vi.fn(),
  runLoop: vi.fn(),
  listOrders: vi.fn(),
  emit: vi.fn(),
  applyBalances: vi.fn(),
}));

vi.mock("../../lib/secureKeyStorage", () => ({ getEthereumAddress: mocks.getEthereumAddress }));
vi.mock("./SwapKitV2RecoveryKey", () => ({ getSwapKitV2RecoveryKey: mocks.recoveryKey }));
vi.mock("./SwapKitV2ResumeExecutors", () => ({
  rebuildV2ExecutorsForOrder: mocks.rebuildExecutors,
}));
vi.mock("./SwapKitV2ActionService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./SwapKitV2ActionService")>();
  return { ...actual, runSwapKitV2OrderLoop: mocks.runLoop };
});
vi.mock("./SwapKitV2Executors", () => ({
  makeStandardV2Executors: () => ({ universal: true }),
  makeRecoveryOnlyV2Executors: () => ({ recoveryOnly: true }),
}));
vi.mock("./SwapKitDirectEvmSwapService", () => ({ DIRECT_SWAP_SETTLED_EVENT: "settled" }));
vi.mock("../events/AppEventBusService", () => ({
  EventBus: { emit: mocks.emit, on: () => () => {} },
}));
vi.mock("./SwapKitV2MoveAccounting", () => ({
  applyV2TerminalBalances: mocks.applyBalances,
  holdV2ArkadeFunding: vi.fn(),
  releaseV2ArkadeFunding: vi.fn(),
  restoreV2ArkadeReservations: async (): Promise<void> => {},
}));
vi.mock("./SwapKitV2Service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./SwapKitV2Service")>();
  return {
    ...actual,
    getSwapKitV2Status: mocks.getStatus,
    listSwapKitV2Orders: mocks.listOrders,
  };
});

import { isSwapLoopActive, releaseSwapLoop } from "./SwapKitLoopRegistry";
import { clearV2Moves, getV2Move } from "./SwapKitV2MoveStatus";
import {
  resumeSwapKitV2Order,
  resumeSwapKitV2Orders,
  resumeSwapKitV2TrackingIntake,
  startSwapKitV2Tracking,
  stopAllSwapKitV2Tracking,
} from "./SwapKitV2PendingTracker";
import { SwapKitV2OrderStore } from "./SwapKitV2OrderStore";
import * as actualAction from "./SwapKitV2ActionService";

const ORDER = "ord_blocked1";

const blockedView = {
  mode: "commit" as const,
  orderId: ORDER,
  status: "AWAITING_ACTION",
  actions: [
    {
      actionId: "act_1",
      kind: "arkade_claim",
      request: {},
      state: "blocked" as const,
      blockedReason: "waiting for the counterparty",
      idempotencyKey: "idem_1",
    },
  ],
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// #1 — an order that finished while the app was suspended comes back ALREADY
// terminal. The early return for that case skipped every reconciliation step,
// so the move kept its optimistic pending row, its unconfirmed card credit and
// its pre-swap balances until something unrelated happened to fix them.
describe("an already-terminal order still reconciles", () => {
  beforeEach(() => {
    clearV2Moves();
    releaseSwapLoop(ORDER);
    SwapKitV2OrderStore._resetForTests();
    for (const fn of Object.values(mocks)) fn.mockReset();
    mocks.getEthereumAddress.mockResolvedValue("0xowner");
    mocks.recoveryKey.mockResolvedValue("r".repeat(64));
    mocks.rebuildExecutors.mockResolvedValue(null);
  });

  it("clears the pending row and applies balances without running a loop", async () => {
    const terminalView = { ...blockedView, status: "COMPLETED", actions: [] as never[] };
    startSwapKitV2Tracking(ORDER, terminalView);
    await settle();

    // No loop: there is nothing left to execute.
    expect(mocks.runLoop).not.toHaveBeenCalled();
    // But the optimistic surfaces ARE retired.
    expect(mocks.emit).toHaveBeenCalledWith(
      "wallet:clearPendingTransfer",
      expect.objectContaining({ orderId: ORDER }),
    );
    expect(mocks.applyBalances).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER }),
      "COMPLETED",
    );
  });
});

describe("blocked actions vs. the live loop", () => {
  beforeEach(() => {
    clearV2Moves();
    releaseSwapLoop(ORDER);
    SwapKitV2OrderStore._resetForTests();
    for (const fn of Object.values(mocks)) fn.mockReset();
    mocks.getEthereumAddress.mockResolvedValue("0xowner");
    mocks.recoveryKey.mockResolvedValue("r".repeat(64));
    mocks.rebuildExecutors.mockResolvedValue(null);
  });

  it("reports a blocked action as PROGRESS while its loop is still running", async () => {
    let releaseLoop: (view: unknown) => void = () => {};
    mocks.runLoop.mockImplementation(
      (view: unknown, _id: string, options: { onUpdate?: (v: unknown) => void }) => {
        options.onUpdate?.(view);
        return new Promise((resolve) => {
          releaseLoop = resolve;
        });
      },
    );

    startSwapKitV2Tracking(ORDER, blockedView);
    await settle();

    expect(isSwapLoopActive(ORDER)).toBe(true);
    // Blocked, but the loop owns it — the user has nothing to do.
    expect(getV2Move(ORDER)?.phase).toBe("processing");

    releaseLoop({ ...blockedView, status: "COMPLETED", actions: [] });
    await settle();
  });

  it("refuses Continue while a loop already holds the order", async () => {
    mocks.runLoop.mockImplementation(() => new Promise(() => {}));
    startSwapKitV2Tracking(ORDER, blockedView);
    await settle();

    // Silently resolving here is the bug: the pill would show a CTA that claims
    // the same registry key, does nothing, and never opens the detail sheet.
    await expect(resumeSwapKitV2Order(ORDER)).rejects.toThrow(/already running/i);
  });

  it("publishes action_required only AFTER the loop released its claim", async () => {
    mocks.runLoop.mockRejectedValue(new Error("route needs an action this flow cannot execute"));
    startSwapKitV2Tracking(ORDER, blockedView);
    await settle();

    expect(isSwapLoopActive(ORDER)).toBe(false);
    expect(getV2Move(ORDER)).toMatchObject({
      phase: "action_required",
      blockedReason: expect.stringMatching(/cannot execute/),
    });
    // And the CTA is now runnable: nothing holds the claim.
    await expect(resumeSwapKitV2Order(ORDER)).rejects.not.toThrow(/already running/i);
  });
});

// Taner #2 (5e7df9bb) — a row re-adopted from swap_list after a reinstall has
// no accepted quote on this device. It must never be driven with the
// universal money-moving set.
describe("reinstall recovery", () => {
  it("drives a swap_list-discovered order with recovery-only executors", async () => {
    const WALLET = "0x00993cA379abd3F6c79E439c54a1AB2e7c95234B";
    const ADOPTED = "ord_adopted1";
    mocks.getEthereumAddress.mockResolvedValue(WALLET);
    mocks.recoveryKey.mockResolvedValue("r".repeat(64));
    mocks.rebuildExecutors.mockResolvedValue(null);
    mocks.listOrders.mockResolvedValue({
      owner: WALLET,
      count: 1,
      orders: [{ ...blockedView, orderId: ADOPTED, status: "AWAITING_ACTION" }],
    });
    mocks.getStatus.mockResolvedValue({ ...blockedView, orderId: ADOPTED });
    mocks.runLoop.mockResolvedValue({
      ...blockedView,
      orderId: ADOPTED,
      status: "COMPLETED",
      actions: [],
    });
    vi.spyOn(SwapKitV2OrderStore, "hydrate").mockResolvedValue(undefined as never);
    const rows = new Map<string, unknown>();
    vi.spyOn(SwapKitV2OrderStore, "get").mockImplementation((id: string) => rows.get(id) as never);
    vi.spyOn(SwapKitV2OrderStore, "upsert").mockImplementation(async (row: { orderId: string }) => {
      rows.set(row.orderId, row);
    });
    vi.spyOn(SwapKitV2OrderStore, "listOpen").mockImplementation(() => [...rows.values()] as never);

    await resumeSwapKitV2Orders();
    await vi.waitFor(() => expect(mocks.runLoop).toHaveBeenCalled());
    const options = mocks.runLoop.mock.calls.at(-1)?.[2];
    expect(options.executors).toEqual({ recoveryOnly: true });
    releaseSwapLoop(ADOPTED as never);
  });

  // The incident order: server created it, the commit reply never reached the
  // device, so its first action — the approval + deposit call — was never
  // signed. Adopting it as a bounds-less row failed its loop into "Action
  // required", and Continue re-ran a loop that could not sign it either.
  it("does not adopt a listed order whose ready action a discovered row cannot sign", async () => {
    vi.restoreAllMocks();
    mocks.runLoop.mockClear();
    const WALLET = "0x00993cA379abd3F6c79E439c54a1AB2e7c95234B";
    const UNSIGNED = "ord_5a95320b";
    mocks.getEthereumAddress.mockResolvedValue(WALLET);
    mocks.recoveryKey.mockResolvedValue("r".repeat(64));
    mocks.rebuildExecutors.mockResolvedValue(null);
    mocks.listOrders.mockResolvedValue({
      owner: WALLET,
      count: 1,
      orders: [
        {
          mode: "commit",
          orderId: UNSIGNED,
          status: "AWAITING_ACTION",
          actions: [
            {
              actionId: "act_c825d43d",
              kind: "execute_evm_call",
              request: {},
              state: "ready",
              idempotencyKey: "idem_fund",
            },
          ],
        },
      ],
    });
    vi.spyOn(SwapKitV2OrderStore, "hydrate").mockResolvedValue(undefined as never);
    const rows = new Map<string, unknown>();
    vi.spyOn(SwapKitV2OrderStore, "get").mockImplementation((id: string) => rows.get(id) as never);
    const upsert = vi
      .spyOn(SwapKitV2OrderStore, "upsert")
      .mockImplementation(async (row: { orderId: string }) => {
        rows.set(row.orderId, row);
      });
    vi.spyOn(SwapKitV2OrderStore, "listOpen").mockImplementation(() => [...rows.values()] as never);

    await resumeSwapKitV2Orders();
    await settle();

    expect(upsert).not.toHaveBeenCalled();
    expect(mocks.runLoop).not.toHaveBeenCalled();
    expect(getV2Move(UNSIGNED)).toBeNull();
  });
});

// Taner #4 (ed888cb9) — soft logout cleared the order store while a running
// loop kept its recovery key and executors. stopAllSwapKitV2Tracking aborts
// every loop and resolves only once each has exited.
describe("stopAllSwapKitV2Tracking", () => {
  it("aborts a running loop at once and publishes nothing afterwards", async () => {
    const ID = "ord_logout1";
    mocks.recoveryKey.mockResolvedValue("r".repeat(64));
    vi.spyOn(SwapKitV2OrderStore, "get").mockReturnValue({
      orderId: ID,
      flow: "direct_evm",
      recoveryKey: "r".repeat(64),
    } as never);
    let sawSignal: AbortSignal | undefined;
    let exited = false;
    mocks.runLoop.mockImplementation(
      async (_view: unknown, _id: unknown, options: { signal?: AbortSignal }) => {
        sawSignal = options.signal;
        await new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            exited = true;
            const { SwapKitV2LoopAbortedError } = actualAction;
            reject(new SwapKitV2LoopAbortedError());
          });
        });
      },
    );
    mocks.emit.mockClear();
    startSwapKitV2Tracking(ID, { ...blockedView, orderId: ID });
    await vi.waitFor(() => expect(sawSignal).toBeDefined());
    expect(isSwapLoopActive(ID)).toBe(true);

    stopAllSwapKitV2Tracking();
    expect(sawSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(exited).toBe(true));
    await vi.waitFor(() => expect(isSwapLoopActive(ID)).toBe(false));
    expect(isSwapLoopActive(ID)).toBe(false);
    // An aborted loop is not a failure: no "needs you" pill for the old account.
    expect(getV2Move(ID)?.status).not.toBe("action_required");
  });
});

// Taner (0c7e5c09) — a start while shutdown awaited an existing loop slipped
// past the snapshot and survived the wipe. The intake gate closes first.
describe("stopAllSwapKitV2Tracking intake gate", () => {
  it("refuses a tracker started after logout stopped the trackers", async () => {
    const FIRST = "ord_shutdown_a";
    const LATE = "ord_shutdown_b";
    resumeSwapKitV2TrackingIntake();
    mocks.recoveryKey.mockResolvedValue("r".repeat(64));
    vi.spyOn(SwapKitV2OrderStore, "get").mockReturnValue({
      flow: "direct_evm",
      recoveryKey: "r".repeat(64),
    } as never);
    let releaseFirst: () => void = () => {};
    const started: string[] = [];
    mocks.runLoop
      .mockReset()
      .mockImplementation(async (_v: unknown, id: string, options: { signal?: AbortSignal }) => {
        started.push(id);
        await new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            // Wind down slowly, so shutdown is genuinely mid-await when the late start arrives.
            releaseFirst = () => reject(new actualAction.SwapKitV2LoopAbortedError());
          });
        });
      });

    startSwapKitV2Tracking(FIRST, { ...blockedView, orderId: FIRST });
    await vi.waitFor(() => expect(started).toContain(FIRST));

    stopAllSwapKitV2Tracking();
    // Stopped. A late start must be refused at intake:
    // no loop claim at all. (Started without an initial view so it would have
    // to await a status fetch — a missing gate would hold the claim here.)
    mocks.getStatus.mockImplementation(() => new Promise(() => {}));
    startSwapKitV2Tracking(LATE);
    expect(isSwapLoopActive(LATE)).toBe(false);

    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).not.toContain(LATE);
    expect(isSwapLoopActive(FIRST)).toBe(false);
    expect(isSwapLoopActive(LATE)).toBe(false);
    resumeSwapKitV2TrackingIntake();
  });
});
