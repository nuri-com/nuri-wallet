import { describe, expect, it } from "vitest";
import { swapRouteCardDetail } from "./formatting";

describe("swap route presentation", () => {
  it("distinguishes same-path providers by name and ETA", () => {
    expect(
      swapRouteCardDetail({
        path: ["EURC_BASE", "USDC_BASE"],
        providers: ["lifi"],
        etaSeconds: 30,
      }),
    ).toBe("LI.FI · ~30 sec");
    expect(
      swapRouteCardDetail({
        path: ["EURC_BASE", "USDC_BASE"],
        providers: ["cow"],
        etaSeconds: 90,
      }),
    ).toBe("CoW · ~2 min");
  });
});
