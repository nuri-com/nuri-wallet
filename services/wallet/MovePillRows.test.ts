import { beforeEach, describe, expect, it, vi } from "vitest";

// "Completed" on the pill and the pending rows leaving are one moment.
vi.mock("../events/AppEventBusService", () => {
  const handlers = new Map<string, Set<(p: unknown) => void>>();
  return {
    EventBus: {
      emit: (name: string, payload?: unknown) => {
        for (const h of handlers.get(name) ?? []) h(payload);
      },
      on: (name: string, h: (p: unknown) => void) => {
        const set = handlers.get(name) ?? new Set();
        set.add(h);
        handlers.set(name, set);
        return () => set.delete(h);
      },
    },
  };
});
vi.mock("../balance/TransactionCacheService", () => ({
  getCacheValue: async (): Promise<null> => null,
  setCacheValue: async (): Promise<void> => {},
}));
vi.mock("../base/BaseTokenTransferService", () => ({
  getBaseTransactionOutcome: async (): Promise<string> => "pending",
}));
vi.mock("../bitcoin/PendingBitcoinSendsStore", () => ({
  PendingBitcoinSendsStore: { list: async (): Promise<unknown[]> => [] },
}));
vi.mock("../app/PendingPurchasesStore", () => ({
  PendingPurchasesStore: { hydrate: async (): Promise<void> => {}, list: (): unknown[] => [] },
}));
vi.mock("../balance/PendingWalletTransfersStore", () => ({
  PendingWalletTransfersStore: { list: async (): Promise<unknown[]> => [] },
}));
vi.mock("../swapkit/SwapKitV2OrderStore", () => ({
  SwapKitV2OrderStore: { hydrate: async (): Promise<void> => {}, get: (): null => null },
}));
vi.mock("../swapkit/SwapKitV2Service", () => ({
  SWAPKIT_V2_TERMINAL_STATUSES: new Set(["COMPLETED"]),
}));
vi.mock("../wirex/WirexService", () => ({
  wirexService: {
    hasUnresolvedWithdrawal: async (): Promise<boolean> => true,
    isSepaTransferSettled: async (): Promise<null> => null,
  },
}));
vi.mock("../app/ForegroundPoller", () => ({
  createForegroundPoller: () => ({ start: (): void => {}, stop: (): void => {} }),
}));
vi.mock("../app/NetworkStatusService", () => ({
  getNetworkStatus: () => ({ isWaitingForNetwork: false }),
}));
vi.mock("../../lib/support/isUserCancelledAuth", () => ({
  isUserCancelledAuth: (): boolean => false,
}));
vi.mock("../../lib/wirex/withdrawRollback", () => ({
  shouldRevertOptimisticWithdraw: (): boolean => true,
}));

import { MoneyInFlightStore } from "../money/MoneyInFlightStore";
import { retireRowsOfFinishedMoves } from "../money/InFlightDoneWatcher";
import { clearV2Moves, listV2Moves } from "../swapkit/SwapKitV2MoveStatus";
import { startMovePill, withCardTransferPill } from "./CardTransferPill";

const flush = () => new Promise((r) => setTimeout(r, 0));
const withdrawal = (id: string) =>
  MoneyInFlightStore.start({
    id,
    from: { rail: "visa", amount: 5, unit: "EUR" },
    to: { rail: "wallet", amount: 5, unit: "EUR" },
    kind: "card_withdraw",
    createdAt: new Date().toISOString(),
  });

beforeEach(() => {
  MoneyInFlightStore._resetForTests();
  clearV2Moves();
});

describe("pill and rows finish together", () => {
  it("a withdrawal: Completed on the pill takes its rows the same instant", async () => {
    await withCardTransferPill(
      async () => {
        await withdrawal("w1");
        return { inFlightId: "w1" };
      },
      null,
      { completesOnResolve: true, inFlightIdOf: (r) => r.inFlightId },
    );
    expect(listV2Moves().at(-1)?.phase).toBe("completed");
    retireRowsOfFinishedMoves(listV2Moves());
    await flush();
    expect(MoneyInFlightStore.list()).toHaveLength(0);
  });

  it("a running move keeps its rows", async () => {
    await withdrawal("w2");
    retireRowsOfFinishedMoves([{ orderId: "x", phase: "processing", inFlightId: "w2" }]);
    await flush();
    expect(MoneyInFlightStore.list()).toHaveLength(1);
  });

  it("a send settled by its rows says Completed exactly when they clear", async () => {
    const pill = startMovePill();
    expect(listV2Moves().at(-1)?.phase).toBe("preparing");
    await MoneyInFlightStore.start({
      id: "tx1",
      from: { rail: "onchain", amount: 2500, unit: "sats" },
      to: { rail: "arkade", amount: 2500, unit: "sats" },
      kind: "send",
      createdAt: new Date().toISOString(),
    });
    pill.settleByRows("tx1");
    await flush();
    expect(listV2Moves().at(-1)?.phase).toBe("processing");
    await MoneyInFlightStore.finish("tx1");
    await flush();
    expect(listV2Moves().at(-1)?.phase).toBe("completed");
  });

  it("a send refused before signing leaves no pill", () => {
    const pill = startMovePill();
    pill.drop();
    expect(listV2Moves()).toHaveLength(0);
  });
});
