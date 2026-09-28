import { describe, expect, it } from "vitest";
import { resolveLightningBounds } from "./lightningLimits";

const CORRIDOR = { corridorMinSats: 500, corridorMaxSats: 50_000 };

describe("resolveLightningBounds", () => {
  it("uses the corridor's band when the recipient states none", () => {
    expect(resolveLightningBounds(CORRIDOR)).toEqual({ minSats: 500, maxSats: 50_000 });
  });

  // The amount has to satisfy both parties, so the tighter limit binds on each
  // side: a provider that will not take more than 20 000 has already declared
  // 30 000 invalid, and offering it produces a generic failure after the fact.
  it("takes the recipient's ceiling when it is lower than the corridor's", () => {
    expect(resolveLightningBounds({ ...CORRIDOR, providerMaxSats: 20_000 })).toMatchObject({
      maxSats: 20_000,
    });
  });

  it("keeps the corridor's ceiling when the recipient allows more", () => {
    expect(resolveLightningBounds({ ...CORRIDOR, providerMaxSats: 1_000_000 })).toMatchObject({
      maxSats: 50_000,
    });
  });

  it("takes the recipient's floor when it is higher than the corridor's", () => {
    expect(resolveLightningBounds({ ...CORRIDOR, providerMinSats: 1_000 })).toMatchObject({
      minSats: 1_000,
    });
  });

  it("keeps the corridor's floor when the recipient asks for less", () => {
    expect(resolveLightningBounds({ ...CORRIDOR, providerMinSats: 1 })).toMatchObject({
      minSats: 500,
    });
  });

  // A recipient that stated nothing usable is a recipient with no band of its
  // own — never a band of zero.
  it.each([
    ["null", null],
    ["zero", 0],
    ["not a number", Number.NaN],
  ])("ignores a %s provider limit", (_label, value) => {
    expect(
      resolveLightningBounds({ ...CORRIDOR, providerMinSats: value, providerMaxSats: value }),
    ).toEqual({ minSats: 500, maxSats: 50_000 });
  });

  it("can be tighter on both sides at once", () => {
    expect(
      resolveLightningBounds({ ...CORRIDOR, providerMinSats: 2_000, providerMaxSats: 10_000 }),
    ).toEqual({ minSats: 2_000, maxSats: 10_000 });
  });
});
