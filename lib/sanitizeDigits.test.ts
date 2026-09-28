import { describe, expect, it } from "vitest";
import { sanitizeDigits, sanitizeFiatDigits } from "./sanitizeDigits";

describe("sanitizeDigits", () => {
  it("keeps only digits and strips leading zeroes while preserving a single zero", () => {
    expect(sanitizeDigits("abc00123-45")).toBe("12345");
    expect(sanitizeDigits("0000")).toBe("0");
    expect(sanitizeDigits("")).toBe("");
  });
});

describe("sanitizeFiatDigits", () => {
  it("normalizes comma decimals, caps cents, and preserves mid-entry trailing dots", () => {
    expect(sanitizeFiatDigits("0012,345")).toBe("12.34");
    expect(sanitizeFiatDigits("12.")).toBe("12.");
    expect(sanitizeFiatDigits(".5")).toBe("0.5");
  });

  it("ignores non-leading junk and strips redundant leading zeroes", () => {
    expect(sanitizeFiatDigits("0007abc.99")).toBe("7");
    expect(sanitizeFiatDigits("abc")).toBe("");
    expect(sanitizeFiatDigits("")).toBe("");
  });
});
