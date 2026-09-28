import { beforeEach, expect, it, vi } from "vitest";

// A commit the server refuses because the accepted price moved is not a
// failure: nothing was created or signed. The sheet asks for prices again and
// shows the new one — no error screen, no support report.
const m = vi.hoisted(() => ({
  quoteSwap: vi.fn(),
  executeSwap: vi.fn(),
  report: vi.fn(),
  slots: [] as unknown[],
  cursor: 0,
}));

// Just enough React to run the hook as a plain function: state lives in slots
// that survive re-renders.
vi.mock("react", () => {
  const slot = <T>(init: () => T): [number, T] => {
    const i = m.cursor++;
    if (!(i in m.slots)) m.slots[i] = init();
    return [i, m.slots[i] as T];
  };
  return {
    useState: (initial: unknown) => {
      const [i, value] = slot(() => initial);
      return [
        value,
        (next: unknown): void => {
          m.slots[i] = next;
        },
      ];
    },
    useRef: (initial: unknown) => slot(() => ({ current: initial }))[1],
    useCallback: (fn: unknown) => fn,
  };
});
vi.mock("../../../services/swapkit/SwapContract", () => ({
  quoteSwap: m.quoteSwap,
  executeSwap: m.executeSwap,
}));
vi.mock("../../../lib/support/reportErrorToSupport", () => ({ reportErrorToSupport: m.report }));
vi.mock("../../../lib/support/isUserCancelledAuth", () => ({ isUserCancelledAuth: () => false }));
vi.mock("../../../services/bitcoin/BitcoinBalanceStore", () => ({
  bitcoinBalanceStore: {
    holdArkadeOutgoingBalance: vi.fn(),
    revertArkadeOutgoingBalance: vi.fn(),
  },
}));
vi.mock("../../../services/swapkit/SwapKitV2MoveAccounting", () => ({
  noteV2MoveBaseline: vi.fn(),
}));
vi.mock("../../../services/swapkit/SwapKitV2MoveStatus", () => ({ noteV2MoveCommitted: vi.fn() }));
vi.mock("../moveBookkeeping", () => ({ spendsArkadeBalance: () => false }));

import { useMoveSwap } from "./useMoveSwap";

const quote = (id: string, receiveAmount: number) => ({
  id,
  engine: "stable-to-btc",
  from: "EURC_BASE",
  to: "BTC",
  sendAmount: 7,
  receiveAmount,
  executable: true,
});
const request = { from: "EURC_BASE", to: "BTC", amount: 7, settleTarget: "bc1pboarding" } as never;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const callbacks = {
  onExecuted: vi.fn(),
  onPreHandoffFailure: vi.fn(),
  onRequote: vi.fn(),
};
const render = () => {
  m.cursor = 0;
  return useMoveSwap(callbacks);
};

beforeEach(() => {
  m.slots.length = 0;
  for (const fn of [m.quoteSwap, m.executeSwap, m.report, ...Object.values(callbacks)]) {
    fn.mockReset();
  }
  m.report.mockResolvedValue(undefined);
});

it("re-quotes and shows the fresh price when the commit refuses a moved price", async () => {
  m.quoteSwap.mockResolvedValueOnce([quote("q1", 8489)]).mockResolvedValueOnce([quote("q2", 8430)]);
  m.executeSwap.mockRejectedValue(
    new Error("commit re-quote: settleAmount 0.0000843 is below minimumSettleAmount 0.00008489"),
  );

  await render().requestQuotes(request);
  await render().confirm();
  await settle();

  const after = render();
  expect(after.failed).toBe(false);
  expect(m.report).not.toHaveBeenCalled();
  expect(callbacks.onPreHandoffFailure).not.toHaveBeenCalled();
  expect(callbacks.onRequote).toHaveBeenCalledWith(request);
  expect(m.quoteSwap).toHaveBeenCalledTimes(2);
  expect(after.selectedQuote?.receiveAmount).toBe(8430);
});

it("re-quotes when the server says the accepted quote expired", async () => {
  m.quoteSwap.mockResolvedValueOnce([quote("q1", 8489)]).mockResolvedValueOnce([quote("q2", 8430)]);
  m.executeSwap.mockRejectedValue(
    Object.assign(new Error("quote expired for lifi:EURC_BASE->BTC; request a new quote"), {
      code: "quote_expired",
    }),
  );

  await render().requestQuotes(request);
  await render().confirm();
  await settle();

  const after = render();
  expect(after.failed).toBe(false);
  expect(m.report).not.toHaveBeenCalled();
  expect(callbacks.onRequote).toHaveBeenCalledWith(request);
  expect(after.selectedQuote?.receiveAmount).toBe(8430);
});

it("still reports any other pre-commit failure", async () => {
  m.quoteSwap.mockResolvedValue([quote("q1", 8489)]);
  m.executeSwap.mockRejectedValue(new Error("network down"));

  await render().requestQuotes(request);
  await render().confirm();

  expect(render().failed).toBe(true);
  expect(m.report).toHaveBeenCalledOnce();
  expect(callbacks.onRequote).not.toHaveBeenCalled();
});
