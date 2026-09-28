import { describe, expect, it } from "vitest";

import {
  ARKADE_RECEIVE_MAX_SATS,
  ARKADE_RECEIVE_MIN_SATS,
  checkReceiveAmountSats,
  isReceivableAmountSats,
} from "./receiveLimits";

describe("receive limits", () => {
  it("refuses amounts the solver refuses", () => {
    expect(checkReceiveAmountSats(0)).toBe("below_min");
    expect(checkReceiveAmountSats(1)).toBe("below_min");
    // 501 was observed refused live with `amount_out_of_range`.
    expect(checkReceiveAmountSats(501)).toBe("below_min");
    expect(checkReceiveAmountSats(ARKADE_RECEIVE_MIN_SATS - 1)).toBe("below_min");
  });

  it("accepts the floor and the ceiling themselves", () => {
    expect(checkReceiveAmountSats(ARKADE_RECEIVE_MIN_SATS)).toBeNull();
    expect(checkReceiveAmountSats(ARKADE_RECEIVE_MAX_SATS)).toBeNull();
  });

  it("refuses above the ceiling, where the fee lands on top of the cap", () => {
    expect(checkReceiveAmountSats(ARKADE_RECEIVE_MAX_SATS + 1)).toBe("above_max");
    expect(checkReceiveAmountSats(50_000)).toBe("above_max");
  });

  it("rejects non-finite input rather than passing it on", () => {
    expect(checkReceiveAmountSats(Number.NaN)).toBe("below_min");
    expect(checkReceiveAmountSats(Number.POSITIVE_INFINITY)).toBe("above_max");
  });

  it("truncates fractional sats instead of rounding up past the cap", () => {
    expect(checkReceiveAmountSats(ARKADE_RECEIVE_MAX_SATS + 0.9)).toBeNull();
    expect(isReceivableAmountSats(1000.7)).toBe(true);
  });
});
