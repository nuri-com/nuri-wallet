import { beforeEach, expect, it, vi } from "vitest";

// The server decides which V2 swaps are pending. The user saw two "pending"
// rows for EURC->BTC attempts from the day before while swap_list returned no
// order: their orders finished/expired while the app was not watching (or
// their commit never produced one), and nothing ever cleared the local rows.
const m = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  removed: [] as string[],
  listOrders: vi.fn(),
  getStatus: vi.fn(),
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
  EventBus: { emit: vi.fn(), on: () => () => {} },
}));
vi.mock("./SwapKitV2MoveAccounting", () => ({
  applyV2TerminalBalances: vi.fn(),
  holdV2ArkadeFunding: vi.fn(),
  releaseV2ArkadeFunding: vi.fn(),
  restoreV2ArkadeReservations: async (): Promise<void> => {},
}));
vi.mock("../balance/PendingWalletTransfersStore", () => ({
  PendingWalletTransfersStore: {
    list: async () => m.rows.slice(),
    remove: async (_tx: string | null, orderId: string) => {
      m.removed.push(orderId);
    },
  },
}));
vi.mock("./SwapKitV2Service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./SwapKitV2Service")>();
  return { ...actual, listSwapKitV2Orders: m.listOrders, getSwapKitV2Status: m.getStatus };
});

import { SwapKitV2OrderStore } from "./SwapKitV2OrderStore";
import { resumeSwapKitV2Orders } from "./SwapKitV2PendingTracker";

beforeEach(() => {
  m.removed.length = 0;
  m.listOrders.mockReset();
  m.getStatus.mockReset();
  SwapKitV2OrderStore._resetForTests();
  vi.spyOn(SwapKitV2OrderStore, "hydrate").mockResolvedValue(undefined as never);
});

it("drops pending swap rows the server has no live order for, keeps live ones and non-swaps", async () => {
  m.rows = [
    { orderId: "ord_expired", source: "swapkit", amount: 6 },
    { orderId: "ord_otherkey", source: "swapkit", amount: 7 },
    { orderId: "pending:expo:0xowner:1:abc", source: "swapkit", amount: 7 },
    { orderId: "ord_live", source: "swapkit", amount: 5 },
    { orderId: "sk_v1order", source: "swapkit", amount: 4 },
    { orderId: null, txHash: "0xcardtransfer", source: "base-mainnet", amount: 3 },
  ];
  m.listOrders.mockResolvedValue({ owner: "0xowner", count: 0, orders: [] });
  m.getStatus.mockImplementation(async (id: string) => {
    if (id === "ord_expired") return { orderId: id, status: "EXPIRED", actions: [] };
    if (id === "ord_live") return { orderId: id, status: "IN_FLIGHT", actions: [] };
    // ord_otherkey: the server will not authenticate our key. That is NOT
    // proof the order is gone, so its row must survive (Taner, #1361 review
    // 5317893389) — the row is the user's only handle on money in flight.
    throw new Error("unknown order or unauthorized recoveryKey");
  });

  await resumeSwapKitV2Orders();

  expect(m.removed.sort()).toEqual(["ord_expired", "pending:expo:0xowner:1:abc"].sort());
});

it("keeps every row when the server cannot be reached", async () => {
  m.rows = [{ orderId: "ord_expired", source: "swapkit", amount: 6 }];
  m.listOrders.mockRejectedValue(new Error("network down"));
  await resumeSwapKitV2Orders();
  expect(m.removed).toEqual([]);

  m.listOrders.mockResolvedValue({ owner: "0xowner", count: 0, orders: [] });
  m.getStatus.mockRejectedValue(new Error("SwapKit v2 swap_status failed (http 503)"));
  await resumeSwapKitV2Orders();
  expect(m.removed).toEqual([]);
});
