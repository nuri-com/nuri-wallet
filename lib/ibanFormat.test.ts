import { describe, expect, it } from "vitest";
import { formatIbanForDisplay, normalizeIbanInput } from "./ibanFormat";

describe("IBAN formatting helpers", () => {
  it.each([
    ["DE89 3704-0044_0532.0130/00", "DE89370400440532013000"],
    [" fr14 2004 1010 0505 0001 3m02 606 ", "FR1420041010050500013M02606"],
    [null, ""],
  ] as const)("normalizes %s", (input, expected) => {
    expect(normalizeIbanInput(input)).toBe(expected);
  });

  it("groups normalized IBANs in four-character chunks for display", () => {
    expect(formatIbanForDisplay("de89370400440532013000")).toBe("DE89 3704 0044 0532 0130 00");
    expect(formatIbanForDisplay(undefined)).toBe("");
  });
});
