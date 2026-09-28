import { describe, expect, it } from "vitest";

import {
  COMPACT_AFTER_MS,
  COMPACT_PILL_SIZE,
  PILL_MORPH_MS,
  fullPillScaleAtCompact,
} from "./movePillGeometry";

describe("compact move pill", () => {
  it("is the DS icon button's circle (48)", () => {
    expect(COMPACT_PILL_SIZE).toBe(48);
  });

  it("scales the full pill to the circle's height, never up", () => {
    expect(fullPillScaleAtCompact(52)).toBeCloseTo(48 / 52, 6);
    expect(fullPillScaleAtCompact(48)).toBe(1);
    expect(fullPillScaleAtCompact(40)).toBe(1);
    expect(fullPillScaleAtCompact(0)).toBe(1);
  });

  it("folds after 8 s and morphs in a visible, smooth duration", () => {
    expect(COMPACT_AFTER_MS).toBe(8000);
    expect(PILL_MORPH_MS).toBeGreaterThanOrEqual(300);
    expect(PILL_MORPH_MS).toBeLessThanOrEqual(400);
  });
});
