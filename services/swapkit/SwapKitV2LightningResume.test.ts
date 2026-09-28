import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  list: vi.fn(),
  remove: vi.fn(),
  status: vi.fn(),
  track: vi.fn(),
}));
vi.mock("../arkade/internal/lightningSendStore", () => ({
  getArkadeLightningSendOwnerKey: async () => "owner",
  listArkadeLightningSends: m.list,
  deleteArkadeLightningSend: m.remove,
}));
vi.mock("./SwapKitV2Service", () => ({
  asSwapKitV2OrderId: (id: string) => id,
  isSwapKitV2OrderId: (id: string) => id.startsWith("ord_"),
  getSwapKitV2Status: m.status,
  isSwapKitV2Terminal: (v: { status: string }) =>
    ["COMPLETED", "REFUNDED", "FAILED"].includes(v.status),
}));
vi.mock("./SwapKitV2PendingTracker", () => ({ startSwapKitV2Tracking: m.track }));
vi.mock("./SwapKitV2OrderStore", () => ({
  SwapKitV2OrderStore: { hydrate: async () => {}, get: () => ({ recoveryKey: "saved" }) },
}));
vi.mock("./SwapKitV2RecoveryKey", () => ({ getSwapKitV2RecoveryKey: async () => "fallback" }));
import { checkV2LightningSends } from "./SwapKitV2LightningResume";
beforeEach(() => vi.clearAllMocks());
it("keeps legacy records separate and retires only confirmed v2 terminal records", async () => {
  m.list.mockResolvedValue([
    { txId: "legacy", rfqId: "old" },
    { txId: "ord_ln", rfqId: "new" },
  ]);
  m.status.mockResolvedValue({ orderId: "ord_ln", status: "COMPLETED", actions: [] });
  await checkV2LightningSends("test");
  expect(m.status).toHaveBeenCalledExactlyOnceWith("ord_ln", { recoveryKey: "saved" });
  expect(m.remove).toHaveBeenCalledExactlyOnceWith("owner", "new");
});
it("resumes a funded order through the journaled v2 action loop", async () => {
  m.list.mockResolvedValue([{ txId: "ord_ln", rfqId: "new", fundingTxid: "hash" }]);
  const view = { orderId: "ord_ln", status: "IN_FLIGHT", actions: [] as never[] };
  m.status.mockResolvedValue(view);
  await checkV2LightningSends("wake");
  expect(m.track).toHaveBeenCalledWith("ord_ln", view);
  expect(m.remove).not.toHaveBeenCalled();
});
