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

import { type PendingPurchase, PendingPurchasesStore } from "./PendingPurchasesStore";

const row = (over: Partial<PendingPurchase> & Pick<PendingPurchase, "id">): PendingPurchase => ({
  createdAt: Date.now(),
  amountFiat: 10,
  fiat: "EUR",
  crypto: "BTC",
  payment: "swap",
  address: "addr",
  openUrl: "",
  ...over,
});

beforeEach(async () => {
  await PendingPurchasesStore.clear();
});

describe("PendingPurchasesStore.cleanup", () => {
  it("expires a stale generic purchase but retains a durable BTC→EUR top-up row", async () => {
    const old = Date.now() - 25 * 60 * 60 * 1000; // 25h ago — past the 24h TTL

    await PendingPurchasesStore.add(
      row({ id: "mercuryo-old", source: "mercuryo", createdAt: old }),
    );
    await PendingPurchasesStore.add(
      // Backs a SwapKitOrderStore order kept until completion/recovery — must
      // survive the wall-clock TTL so its Bitcoin activity row stays visible
      // while funds may still be in flight.
      row({ id: "topup-old", source: "swapkit", direction: "btc_to_eur", createdAt: old }),
    );

    await PendingPurchasesStore.cleanup(); // default 24h TTL

    const ids = PendingPurchasesStore.list().map((p) => p.id);
    expect(ids).not.toContain("mercuryo-old");
    expect(ids).toContain("topup-old");
  });

  it("still expires a stale generic purchase when no top-up rows are present", async () => {
    const old = Date.now() - 25 * 60 * 60 * 1000;
    await PendingPurchasesStore.add(
      row({ id: "mercuryo-only", source: "mercuryo", createdAt: old }),
    );

    await PendingPurchasesStore.cleanup();

    expect(PendingPurchasesStore.list()).toHaveLength(0);
  });
});
