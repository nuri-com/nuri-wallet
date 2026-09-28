import { beforeEach, describe, expect, it, vi } from "vitest";

// 2026-09-24, from the user's device: an Arkade -> EURC order completed and the
// EURC arrived at 16:49. An hour later, with the user touching nothing,
// swap_status failed (right after a 26s swap_list timeout), the tracking loop
// stopped, and the app showed an orange "Action required / Continue" pill plus
// a "Pending" row for a swap that was already paid.
//
// Two rules pinned here:
//   1. A terminal view reconciles wherever it is SEEN, not only where the loop
//      returns normally - otherwise a loop that dies after the order completed
//      leaves the pending row on screen for good.
//   2. A failed READ never becomes "Action required". That claim is only true
//      when the order's own view carries a step for the user; otherwise
//      Continue just repeats the same failing read.
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
vi.mock("./SwapKitV2MoveAccounting", () => ({ applyV2TerminalBalances: mocks.applyBalances }));
vi.mock("./SwapKitV2Service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./SwapKitV2Service")>();
  return {
    ...actual,
    getSwapKitV2Status: mocks.getStatus,
    listSwapKitV2Orders: mocks.listOrders,
  };
});

import { releaseSwapLoop } from "./SwapKitLoopRegistry";
import { clearV2Moves, getV2Move } from "./SwapKitV2MoveStatus";
import { SwapKitV2OrderStore } from "./SwapKitV2OrderStore";
import { startSwapKitV2Tracking } from "./SwapKitV2PendingTracker";

const ORDER = "ord_9e2e158d31a8943589cf9210a73ae288a179caa7535333b18aa86a942e4397ff";
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const view = (status: string, actions: unknown[] = []) => ({
  mode: "commit" as const,
  orderId: ORDER,
  status,
  actions: actions as never[],
});

describe("a completed swap never stays pending, and a failed read never demands action", () => {
  beforeEach(() => {
    clearV2Moves();
    releaseSwapLoop(ORDER);
    SwapKitV2OrderStore._resetForTests();
    for (const fn of Object.values(mocks)) fn.mockReset();
    mocks.getEthereumAddress.mockResolvedValue("0xowner");
    mocks.recoveryKey.mockResolvedValue("r".repeat(64));
    mocks.rebuildExecutors.mockResolvedValue(null);
  });

  it("clears the pending row when the order completed and the loop then failed", async () => {
    // The loop reports COMPLETED through onUpdate, then dies exactly as the
    // device's did.
    mocks.runLoop.mockImplementation(async (_initial, _id, options) => {
      options.onUpdate?.(view("COMPLETED"));
      throw new Error("SwapKit v2 Swap_status failed");
    });
    startSwapKitV2Tracking(ORDER, view("PROCESSING"));
    await settle();
    await settle();

    expect(mocks.emit).toHaveBeenCalledWith(
      "wallet:clearPendingTransfer",
      expect.objectContaining({ orderId: ORDER }),
    );
    expect(mocks.applyBalances).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER }),
      "COMPLETED",
    );
    expect(getV2Move(ORDER)?.blockedReason).toBeFalsy();
  });

  it("does not claim the user must act when the order has no step for them", async () => {
    mocks.runLoop.mockImplementation(async (_initial, _id, options) => {
      options.onUpdate?.(view("PROCESSING")); // still running, nothing to sign
      throw new Error("SwapKit v2 Swap_status failed");
    });
    startSwapKitV2Tracking(ORDER, view("PROCESSING"));
    await settle();
    await settle();

    expect(getV2Move(ORDER)?.blockedReason).toBeFalsy();
  });

  it("still asks the user when the order really is waiting on them", async () => {
    mocks.runLoop.mockImplementation(async (_initial, _id, options) => {
      options.onUpdate?.(
        view("AWAITING_ACTION", [
          {
            actionId: "act_1",
            kind: "arkade_send",
            request: {},
            state: "ready",
            idempotencyKey: "i1",
          },
        ]),
      );
      throw new Error("SwapKit v2 Swap_status failed");
    });
    startSwapKitV2Tracking(ORDER, view("PROCESSING"));
    await settle();
    await settle();

    expect(getV2Move(ORDER)?.blockedReason).toBeTruthy();
  });
});
