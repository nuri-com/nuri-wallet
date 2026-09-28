import { beforeEach, describe, expect, it, vi } from "vitest";

// Taner, #1361 review 5318630782 item 1: the reservation was started and not
// awaited, and a failed write was swallowed. Funding could therefore broadcast
// before the hold was durable, and after a crash those committed sats read as
// spendable again — which is the one case the hold exists for.
//
// Two rules pinned here:
//   1. nothing executes until the reservation is on disk;
//   2. a write that fails STOPS the order rather than funding without a hold.
const m = vi.hoisted(() => ({
  reserve: vi.fn(),
  release: vi.fn(),
  runLoop: vi.fn(),
  needsUser: vi.fn(),
  order: [] as string[],
}));

vi.mock("../../lib/secureKeyStorage", () => ({ getEthereumAddress: async () => "0xowner" }));
vi.mock("./SwapKitV2RecoveryKey", () => ({
  getSwapKitV2RecoveryKey: async (): Promise<string> => "r".repeat(64),
}));
vi.mock("./SwapKitV2ResumeExecutors", () => ({
  rebuildV2ExecutorsForOrder: async (): Promise<null> => null,
}));
vi.mock("./SwapKitV2Executors", () => ({
  makeStandardV2Executors: () => ({}),
  makeRecoveryOnlyV2Executors: () => ({}),
}));
vi.mock("./SwapKitDirectEvmSwapService", () => ({ DIRECT_SWAP_SETTLED_EVENT: "settled" }));
vi.mock("../events/AppEventBusService", () => ({
  EventBus: { emit: vi.fn(), on: (): (() => void) => () => {} },
}));
vi.mock("../money/announce", () => ({
  finishInFlight: async (): Promise<void> => {},
  startSwapInFlight: async (): Promise<void> => {},
}));
vi.mock("./SwapKitV2MoveStatus", () => ({
  noteV2MoveNeedsUser: m.needsUser,
  noteV2MoveStatus: vi.fn(),
  restoreV2Move: vi.fn(),
}));
vi.mock("./SwapKitV2MoveAccounting", () => ({
  applyV2TerminalBalances: vi.fn(),
  holdV2ArkadeFunding: async (id: string, sats: number): Promise<void> => {
    m.order.push("reserve");
    await m.reserve(id, sats);
  },
  releaseV2ArkadeFunding: m.release,
  restoreV2ArkadeReservations: async (): Promise<void> => {},
}));
vi.mock("./SwapKitV2ActionService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./SwapKitV2ActionService")>();
  return {
    ...actual,
    runSwapKitV2OrderLoop: async (...args: unknown[]) => {
      m.order.push("loop");
      return m.runLoop(...args);
    },
  };
});

import { releaseSwapLoop } from "./SwapKitLoopRegistry";
import { SwapKitV2OrderStore } from "./SwapKitV2OrderStore";
import { startSwapKitV2Tracking } from "./SwapKitV2PendingTracker";

const ORDER = "ord_durable";
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const view = {
  mode: "commit" as const,
  orderId: ORDER,
  status: "PROCESSING",
  actions: [] as never[],
};

beforeEach(() => {
  releaseSwapLoop(ORDER);
  SwapKitV2OrderStore._resetForTests();
  m.order.length = 0;
  m.reserve.mockReset();
  m.release.mockReset();
  m.runLoop.mockReset();
  m.needsUser.mockReset();
  m.runLoop.mockResolvedValue({ ...view, status: "COMPLETED" });
});

describe("the reservation is durable before anything can be funded", () => {
  it("reserves BEFORE the action loop runs", async () => {
    m.reserve.mockResolvedValue(undefined);
    startSwapKitV2Tracking(ORDER, view, {
      fromAsset: "BTC_ARKADE",
      holdArkadeSats: 11_106,
    });
    await settle();
    await settle();

    expect(m.reserve).toHaveBeenCalledWith(ORDER, 11_106);
    expect(m.order[0]).toBe("reserve");
    expect(m.order).toContain("loop");
  });

  it("does NOT run the action loop when the reservation cannot be written", async () => {
    // A hold that never reached disk does not survive the crash it exists for.
    // Refusing costs the user a retry; funding without it risks spending the
    // same sats twice after a restart.
    m.reserve.mockRejectedValue(new Error("disk full"));
    startSwapKitV2Tracking(ORDER, view, {
      fromAsset: "BTC_ARKADE",
      holdArkadeSats: 11_106,
    });
    await settle();
    await settle();

    expect(m.order).not.toContain("loop");
    expect(m.runLoop).not.toHaveBeenCalled();
    expect(m.needsUser).toHaveBeenCalledWith(ORDER, expect.stringContaining("reserve"));
  });

  it("does not reserve for a non-Arkade source", async () => {
    m.reserve.mockResolvedValue(undefined);
    startSwapKitV2Tracking(ORDER, view, {
      fromAsset: "EURC_BASE",
      holdArkadeSats: 0,
    });
    await settle();
    await settle();

    expect(m.reserve).not.toHaveBeenCalled();
    expect(m.order).toContain("loop");
  });
});
