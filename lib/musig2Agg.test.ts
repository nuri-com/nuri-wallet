import { describe, expect, it } from "vitest";
import { bytesToHex, utf8ToBytes } from "./crypto";
import { aggregatedPXOnlyHex } from "./musig2Agg";

const clientCompressed = new Uint8Array([
  0x02, 0x79, 0xbe, 0x66, 0x7e, 0xf9, 0xdc, 0xbb, 0xac, 0x55, 0xa0, 0x62, 0x95, 0xce, 0x87, 0x0b,
  0x07, 0x02, 0x9b, 0xfc, 0xdb, 0x2d, 0xce, 0x28, 0xd9, 0x59, 0xf2, 0x81, 0x5b, 0x16, 0xf8, 0x17,
  0x98,
]);
const serverCompressed = new Uint8Array([
  0x03, 0xc6, 0x04, 0x7f, 0x94, 0x41, 0xed, 0x7d, 0x6d, 0x30, 0x45, 0x40, 0x6e, 0x95, 0xc0, 0x7c,
  0xd8, 0x5c, 0x77, 0x8e, 0x4b, 0x8c, 0xef, 0x3c, 0xa7, 0xab, 0xac, 0x09, 0xb9, 0x5c, 0x70, 0x9e,
  0xe5,
]);

describe("MuSig2 key aggregation", () => {
  it("pins the aggregate x-only key for sorted fixed compressed public keys", () => {
    expect(aggregatedPXOnlyHex(clientCompressed, serverCompressed)).toBe(
      "b4dbe554f1c2f1b744a996669aed33637bdb683553443012d95097525f1a312e",
    );
    expect(aggregatedPXOnlyHex(serverCompressed, clientCompressed)).toBe(
      "b4dbe554f1c2f1b744a996669aed33637bdb683553443012d95097525f1a312e",
    );
  });

  it("rejects non-compressed or wrong-length public keys", () => {
    expect(() => aggregatedPXOnlyHex(utf8ToBytes("too short"), serverCompressed)).toThrow(
      "Invalid client compressed key",
    );

    const uncompressedPrefix = new Uint8Array(clientCompressed);
    uncompressedPrefix[0] = 0x04;
    expect(() => aggregatedPXOnlyHex(uncompressedPrefix, serverCompressed)).toThrow(
      "Invalid client compressed key",
    );
  });

  it("does not leak prefix bytes in the x-only aggregate", () => {
    expect(bytesToHex(new Uint8Array([clientCompressed[0], serverCompressed[0]]))).toBe("0203");
    expect(aggregatedPXOnlyHex(clientCompressed, serverCompressed)).toHaveLength(64);
  });
});
