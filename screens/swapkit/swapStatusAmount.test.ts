import { describe, expect, it } from "vitest";

import type { SwapKitV2OrderView } from "../../services/swapkit/SwapKitV2Service";
import { type AcceptedLocally, statusSheetAmountLine, swapAmountLine } from "./swapStatusAmount";

const view = (partial: Record<string, unknown>) => partial as unknown as SwapKitV2OrderView;

describe("swapAmountLine", () => {
  it("states the accepted quote on one line before execution exists", () => {
    expect(
      swapAmountLine(
        view({
          status: "AWAITING_SIGNATURE",
          accepted: {
            orderId: "ord_1",
            from: "EURC_BASE",
            to: "BTC",
            acceptedDepositAmount: "6",
            minimumSettleAmount: "0.00006844",
          },
        }),
      ),
    ).toBe("6 EURC → 0.00006844 BTC");
  });

  it("keeps the accepted amounts once execution reports its own", () => {
    expect(
      swapAmountLine(
        view({
          accepted: {
            from: "USDC_BASE",
            to: "BTC_ARKADE",
            acceptedDepositAmount: "10",
            minimumSettleAmount: "0.0001",
          },
          execution: { depositAmount: "10.000001", settleAmount: "0.00010012" },
        }),
      ),
    ).toBe("10 USDC → 0.0001 BTC");
  });

  it("falls back to execution amounts and the path when nothing was accepted", () => {
    expect(
      swapAmountLine(
        view({
          path: ["BTC", "EURC_BASE"],
          execution: { depositAmount: "0.0002", settleAmount: "17.5" },
        }),
      ),
    ).toBe("0.0002 BTC → 17.5 EURC");
  });

  it("shows nothing rather than half a line", () => {
    expect(swapAmountLine(null)).toBeNull();
    expect(swapAmountLine(view({ accepted: { from: "EURC_BASE", to: "BTC" } }))).toBeNull();
  });
});

describe("statusSheetAmountLine", () => {
  // What the wallet persisted at accept time, before the commit request went out.
  const rows: Record<string, AcceptedLocally> = {
    "ord_pending:key-1": {
      from: "EURC_BASE",
      to: "BTC",
      acceptedDepositAmount: "6",
      minimumSettleAmount: "0.00006844",
    },
    ord_real: {
      from: "BTC",
      to: "EURC_BASE",
      acceptedDepositAmount: "0.0002",
      minimumSettleAmount: "17.5",
    },
  };
  const stored = (id: string) => rows[id] ?? null;

  it("states the quote from the pill's provisional id before any server view", () => {
    // Before the fix the sheet rendered swapAmountLine(null): nothing at all.
    expect(statusSheetAmountLine("pending:key-1", null, stored)).toBe("6 EURC → 0.00006844 BTC");
  });

  it("states the quote for a real order while its status is still loading or failed", () => {
    expect(statusSheetAmountLine("ord_real", null, stored)).toBe("0.0002 BTC → 17.5 EURC");
  });

  it("takes the server's view once it arrives", () => {
    const server = view({
      accepted: {
        from: "BTC",
        to: "EURC_BASE",
        acceptedDepositAmount: "0.00020",
        minimumSettleAmount: "17.50",
      },
    });
    expect(statusSheetAmountLine("ord_real", server, stored)).toBe("0.00020 BTC → 17.50 EURC");
  });

  it("shows nothing when neither the server nor the wallet knows the quote", () => {
    expect(statusSheetAmountLine("ord_unknown", null, stored)).toBeNull();
  });
});
