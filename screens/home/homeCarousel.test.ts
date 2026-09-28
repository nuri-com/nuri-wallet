import { describe, expect, it } from "vitest";
import {
  homeCarouselEligibleKey,
  sortByHomeValueDescending,
  ungroupedCount,
  ungroupedFiat,
} from "./homeCarousel";

describe("homeCarouselEligibleKey", () => {
  it("falls back to Total Balance when the selected account disappears", () => {
    expect(homeCarouselEligibleKey(["bitcoin", "euro"], "bitcoin")).toBe("bitcoin");
    expect(homeCarouselEligibleKey(["bitcoin", "euro"], "visa")).toBeNull();
  });
});

describe("Total Balance selection", () => {
  it("keeps Total selected as accounts become available", () => {
    expect(homeCarouselEligibleKey([], null)).toBeNull();
    expect(homeCarouselEligibleKey(["bitcoin", "euro", "visa"], null)).toBeNull();
  });

  it("preserves explicitly selected accounts across account refreshes", () => {
    expect(homeCarouselEligibleKey(["bitcoin", "euro", "visa"], "visa")).toBe("visa");
    expect(homeCarouselEligibleKey(["visa", "euro", "bitcoin"], "bitcoin")).toBe("bitcoin");
  });
});

describe("balance-list formatting", () => {
  it("keeps long counts and fiat values ungrouped", () => {
    expect(ungroupedCount(145_924)).toBe("145924");
    expect(ungroupedFiat(12_345.6)).toBe("12345.60");
  });

  it("sorts known EUR values descending and keeps ties stable", () => {
    const rows = [
      { key: "unknown", homeValueEur: null },
      { key: "euro", homeValueEur: 53.21 },
      { key: "bitcoin", homeValueEur: 97.88 },
      { key: "visa", homeValueEur: 53.21 },
    ];

    expect(sortByHomeValueDescending(rows).map(({ key }) => key)).toEqual([
      "bitcoin",
      "euro",
      "visa",
      "unknown",
    ]);
  });
});
