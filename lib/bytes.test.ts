import { describe, expect, it } from "vitest";
import {
  assertHexLength,
  base64ToBytes,
  base64urlToBytes,
  bytesToBase64,
  bytesToBase64url,
  bytesToHex,
  concatBytes,
  hexToBytes,
  isHex,
  normalizeHex,
} from "./bytes";

describe("byte helpers", () => {
  it.each(["", "00", "deadBEEF"])("round-trips hex %s", (hex) => {
    expect(bytesToHex(hexToBytes(hex))).toBe(hex.toLowerCase());
  });

  it("rejects malformed hex", () => {
    expect(() => hexToBytes("abc")).toThrow("Invalid hex");
    expect(() => hexToBytes("zz")).toThrow("Invalid hex");
    expect(isHex("deadbeef", 8)).toBe(true);
    expect(isHex("deadbeef", 6)).toBe(false);
    expect(normalizeHex("  DeAdBEEF ")).toBe("deadbeef");
    expect(() => assertHexLength("abc", 4, "field")).toThrow("field must be 4 hex chars");
  });

  it("round-trips base64 and base64url without padding", () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    const encodedUrl = bytesToBase64url(bytes);
    expect(encodedUrl).not.toMatch(/[+/=]/);
    expect(base64urlToBytes(encodedUrl)).toEqual(bytes);
  });

  it("concatenates byte arrays in order", () => {
    expect(concatBytes(new Uint8Array([1, 2]), new Uint8Array(), new Uint8Array([3]))).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });
});
