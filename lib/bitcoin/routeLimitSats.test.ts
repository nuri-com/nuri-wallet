import { describe, expect, it } from "vitest";
import { routeMaxSats, routeMinSats } from "./routeLimitSats";

describe("route limits in sats", () => {
  // The shape that broke it: a BTC-denominated minimum truncated to zero, so a
  // 10 000-sat floor fell back to a constant and the UI offered amounts the
  // corridor refuses at creation.
  it("converts a BTC-denominated minimum", () => {
    expect(routeMinSats({ asset: "BTC_LN", unit: "BTC", min: 0.0001 })).toBe(10_000);
  });

  it("takes an explicit sats minimum as it is", () => {
    expect(routeMinSats({ asset: "BTC_LN", minSats: 7_872 })).toBe(7_872);
  });

  it("prefers the sats field when both are present", () => {
    expect(routeMinSats({ asset: "BTC", unit: "BTC", min: 0.0001, minSats: 7_872 })).toBe(7_872);
  });

  // A minimum rounded DOWN is a minimum the provider still refuses; a maximum
  // rounded UP is an amount it will not take.
  it("rounds a minimum up and a maximum down", () => {
    expect(routeMinSats({ asset: "BTC", unit: "BTC", min: 0.000000015 })).toBe(2);
    expect(routeMaxSats({ asset: "BTC", unit: "BTC", max: 0.000000015 })).toBe(1);
  });

  it("treats a bare BTC asset with no unit as BTC-denominated", () => {
    expect(routeMinSats({ asset: "BTC", min: 0.0005 })).toBe(50_000);
  });

  it("leaves a non-Bitcoin limit in its own unit", () => {
    expect(routeMinSats({ asset: "EURC_BASE", unit: "EURC", min: 5 })).toBe(5);
  });

  it.each([[null], [{}], [{ min: 0 }], [{ min: "many" }]])("answers null for %s", (limits) => {
    expect(routeMinSats(limits as never)).toBeNull();
  });
});
