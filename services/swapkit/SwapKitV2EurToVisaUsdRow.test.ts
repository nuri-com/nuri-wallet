import { beforeEach, describe, expect, it, vi } from "vitest";

// EUR wallet -> Visa USD, through the REAL chain: the direct swap service,
// the shared commit flow, the announcement and the one list, then the rows the
// Visa USD screen draws. Only the network and the tracker are stubbed.
const CARD = "0x2222222222222222222222222222222222222222";
const OWNER = "0x1111111111111111111111111111111111111111";

vi.mock("../../lib/OperationLogUtils", () => ({
  LOG_EMOJI: { bitcoin: "" },
  newOp: (): Record<string, unknown> => ({
    log: vi.fn(),
    end: vi.fn(),
    fail: vi.fn(),
    error: vi.fn(),
  }),
  logWithId: vi.fn(),
  errorWithId: vi.fn(),
}));
vi.mock("../../lib/secureKeyStorage", () => ({
  getEthereumAddress: async (): Promise<string> => OWNER,
}));
vi.mock("../events/AppEventBusService", () => ({
  EventBus: { emit: vi.fn(), on: (): (() => void) => () => {} },
}));
vi.mock("../balance/TransactionCacheService", () => ({
  getCacheValue: async (): Promise<null> => null,
  setCacheValue: async (): Promise<void> => {},
}));
vi.mock("./SwapKitV2Service", () => ({
  quoteSwapKitV2: vi.fn(),
  commitSwapKitV2: vi.fn(
    async (): Promise<Record<string, unknown>> => ({
      orderId: "ord_card",
      status: "AWAITING_SIGNATURE",
      actions: [],
    }),
  ),
  asSwapKitV2OrderId: (id: string): string => id,
}));
vi.mock("./SwapKitV2PendingTracker", () => ({
  startSwapKitV2Tracking: vi.fn(),
  emitV2SwapRefresh: vi.fn(),
}));
vi.mock("./SwapKitV2RecoveryKey", () => ({
  getSwapKitV2RecoveryKey: async (): Promise<string> => "r".repeat(64),
}));
vi.mock("./SwapKitV2Executors", () => ({
  standardEvmLoopOptions: (): Record<string, never> => ({}),
  SWAPKIT_V2_EVM_SOURCE_CAPABILITIES: ["execute_evm_call"],
}));
vi.mock("./SwapKitV2EvmRouteBinding", () => ({ settleBindingForOrder: (): null => null }));
vi.mock("./SwapKitDirectEvmSwapService", () => ({
  readDirectSwapBalance: async (): Promise<number> => 100,
}));
vi.mock("./SwapKitV2MoveStatus", () => ({
  noteV2MoveCommitted: vi.fn(),
  forgetV2Move: vi.fn(),
}));

import { executeV2DirectEvmSwap } from "./SwapKitV2DirectEvmService";
import { MoneyInFlightStore } from "../money/MoneyInFlightStore";
import { inFlightRowsFor } from "../money/inFlightRows";

beforeEach(() => {
  MoneyInFlightStore._resetForTests();
});

describe("EUR wallet -> Visa USD", () => {
  it("draws an incoming row on the Visa USD screen and an outgoing one on the EUR wallet", async () => {
    await executeV2DirectEvmSwap({
      quote: {
        optionId: "lifi:lifi:EURC_BASE->USDC_BASE",
        from: "EURC_BASE",
        to: "USDC_BASE",
        sendAmount: 3,
        receiveAmount: 3.4,
        rate: 1.13,
        provider: "lifi",
        settleTarget: CARD,
        owner: OWNER,
        quotedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
      destination: "card",
    });
    const records = MoneyInFlightStore.list();
    const card = inFlightRowsFor(records, ["visaUsd"]);
    const wallet = inFlightRowsFor(records, ["wallet"]);
    expect(card).toHaveLength(1);
    expect(card[0].direction).toBe("in");
    expect(card[0].leg.amount).toBeCloseTo(3.4);
    expect(wallet).toHaveLength(1);
    expect(wallet[0].direction).toBe("out");
    // Nothing lands on the USD wallet: the dollars go to the card.
    expect(inFlightRowsFor(records, ["dollar"])).toHaveLength(0);
  });
});
