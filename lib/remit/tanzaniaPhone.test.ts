import { describe, expect, it } from "vitest";

import {
  formatTanzanianMobileNumber,
  isTanzanianMobileNumber,
  normalizeTanzanianMobileNumber,
} from "./tanzaniaPhone";

describe("normalizeTanzanianMobileNumber", () => {
  it("accepts every written form of the same number", () => {
    for (const input of [
      "+255765132161",
      "255765132161",
      "0765132161",
      "765132161",
      "+255 765 132 161",
      "+255-765-132-161",
      " 0765 132 161 ",
    ]) {
      expect(normalizeTanzanianMobileNumber(input)).toBe("+255765132161");
    }
  });

  it("rejects what the recipient field otherwise carries", () => {
    for (const input of [
      "",
      "12345",
      "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
      "ark1qqqqqqqq",
      "lnbc1p3xyz",
      "user@getalby.com",
      // A fixed line is not mobile money.
      "+255222110000",
      // Too few and too many subscriber digits.
      "+25576513216",
      "+2557651321610",
    ]) {
      expect(normalizeTanzanianMobileNumber(input)).toBeNull();
      expect(isTanzanianMobileNumber(input)).toBe(false);
    }
  });

  it("groups the number for display", () => {
    expect(formatTanzanianMobileNumber("0765132161")).toBe("+255 765 132 161");
    // Anything it does not recognise is handed back untouched rather than mangled.
    expect(formatTanzanianMobileNumber("not-a-number")).toBe("not-a-number");
  });
});
