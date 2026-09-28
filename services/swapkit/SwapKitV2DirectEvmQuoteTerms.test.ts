import { beforeEach, describe, expect, it, vi } from "vitest";

// A direct EUR<->USD option is offered only on the server's own terms: a
// deposit it did not price is not replaced by the amount that was asked for.
const mocks = vi.hoisted(() => ({ quote: vi.fn() }));

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
  getEthereumAddress: async (): Promise<string> => "0x1111111111111111111111111111111111111111",
}));
vi.mock("../events/AppEventBusService", () => ({
  EventBus: { emit: vi.fn(), on: (): (() => void) => () => {} },
}));
vi.mock("../balance/TransactionCacheService", () => ({
  getCacheValue: async (): Promise<null> => null,
  setCacheValue: async (): Promise<void> => {},
}));
vi.mock("./SwapKitV2Service", () => ({
  quoteSwapKitV2: mocks.quote,
  commitSwapKitV2: vi.fn(),
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

import { quoteV2DirectEvmSwaps } from "./SwapKitV2DirectEvmService";

const option = (depositAmount: unknown) => ({
  optionId: "lifi:lifi:EURC_BASE->USDC_BASE",
  quoteId: "q_1",
  depositAmount,
  settleAmount: "11.3",
});

beforeEach(() => mocks.quote.mockReset());

describe("direct EUR<->USD quote terms", () => {
  it.each([
    ["missing", undefined],
    ["zero", "0"],
    ["negative", "-3"],
    ["unparseable", "x"],
  ])("drops an option whose deposit is %s", async (_label, depositAmount) => {
    mocks.quote.mockResolvedValue({ options: [option(depositAmount)] });
    const quotes = await quoteV2DirectEvmSwaps({
      from: "EURC_BASE",
      to: "USDC_BASE",
      amount: 10,
    } as never);
    expect(quotes).toHaveLength(0);
  });

  it("offers an option on the deposit the server priced", async () => {
    mocks.quote.mockResolvedValue({ options: [option("9.95")] });
    const [quote] = await quoteV2DirectEvmSwaps({
      from: "EURC_BASE",
      to: "USDC_BASE",
      amount: 10,
    } as never);
    expect(quote.sendAmount).toBe(9.95);
  });
});
