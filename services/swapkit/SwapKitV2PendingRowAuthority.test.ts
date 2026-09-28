import { beforeEach, describe, expect, it, vi } from "vitest";

// Three findings from Taner's review of #1361 (5317893389), each pinned by the
// behaviour it protects rather than by the shape of the code.
const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  listOrders: vi.fn(),
  removed: [] as string[],
  rows: [] as Array<Record<string, unknown>>,
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
vi.mock("./SwapKitV2MoveAccounting", () => ({
  applyV2TerminalBalances: vi.fn(),
  holdV2ArkadeFunding: vi.fn(),
  releaseV2ArkadeFunding: vi.fn(),
  restoreV2ArkadeReservations: async (): Promise<void> => {},
}));
vi.mock("../money/announce", () => ({
  finishInFlight: async (): Promise<void> => {},
  startSwapInFlight: async (): Promise<void> => {},
}));
vi.mock("../balance/PendingWalletTransfersStore", () => ({
  PendingWalletTransfersStore: {
    list: async () => mocks.rows.slice(),
    remove: async (_tx: string | null, orderId: string): Promise<void> => {
      mocks.removed.push(orderId);
    },
  },
}));
vi.mock("./SwapKitV2Service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./SwapKitV2Service")>();
  return { ...actual, listSwapKitV2Orders: mocks.listOrders, getSwapKitV2Status: mocks.getStatus };
});

import { SwapKitV2OrderStore } from "./SwapKitV2OrderStore";
import { resumeSwapKitV2Orders } from "./SwapKitV2PendingTracker";

beforeEach(() => {
  mocks.removed.length = 0;
  mocks.getStatus.mockReset();
  mocks.listOrders.mockReset();
  SwapKitV2OrderStore._resetForTests();
  vi.spyOn(SwapKitV2OrderStore, "hydrate").mockResolvedValue(undefined as never);
});

describe("a pending row is only retired by an authoritative answer", () => {
  it("KEEPS the row when the server rejects our recovery key", async () => {
    // An authorization failure says nothing about the order: the wrong key was
    // presented, or the right one refused. The order may be alive and funded,
    // and the row is the user's only handle on money in flight.
    mocks.rows = [{ orderId: "ord_authfail", source: "swapkit", amount: 5 }];
    mocks.listOrders.mockResolvedValue({ orders: [] });
    mocks.getStatus.mockRejectedValue(new Error("unknown order or unauthorized recoveryKey"));

    await resumeSwapKitV2Orders();

    expect(mocks.removed).not.toContain("ord_authfail");
  });

  it("drops the row when the server authoritatively does not know the order", async () => {
    mocks.rows = [{ orderId: "ord_gone", source: "swapkit", amount: 5 }];
    mocks.listOrders.mockResolvedValue({ orders: [] });
    mocks.getStatus.mockRejectedValue(new Error("unknown order"));

    await resumeSwapKitV2Orders();

    expect(mocks.removed).toContain("ord_gone");
  });

  it("keeps the row on any other transport failure", async () => {
    mocks.rows = [{ orderId: "ord_net", source: "swapkit", amount: 5 }];
    mocks.listOrders.mockResolvedValue({ orders: [] });
    mocks.getStatus.mockRejectedValue(new Error("network request failed"));

    await resumeSwapKitV2Orders();

    expect(mocks.removed).not.toContain("ord_net");
  });
});
