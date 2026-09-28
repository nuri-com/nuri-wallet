import { describe, expect, it } from "vitest";
import * as btc from "@scure/btc-signer";
import { bytesToHex, hexToBytes } from "../bytes";
import { CSV_BLOCKS } from "../../config/constants";
import { buildCsvLeaf, makeP2TRWithTimelock } from "./BitcoinTaprootCheckSequenceVerifyCSV";
import { deriveMusig2CsvAddress } from "./deriveMusig2CsvAddress";

const USER_COMPRESSED = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const USER_XONLY = USER_COMPRESSED.slice(2);
const AGGREGATED_XONLY = "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";

// The legacy block count is now passed as a BIP68 sequence. It carries no type
// flag and stays under 65536, so every address derived before the Arkade
// migration must still come out byte-identical.
describe("legacy CSV_BLOCKS derivation", () => {
  it("encodes the same leaf as a raw script push", () => {
    const expected = btc.Script.encode([
      hexToBytes(USER_XONLY),
      "CHECKSIGVERIFY",
      CSV_BLOCKS,
      "CHECKSEQUENCEVERIFY",
    ]);
    expect(bytesToHex(buildCsvLeaf(hexToBytes(USER_XONLY), CSV_BLOCKS).script)).toBe(
      bytesToHex(expected),
    );
  });

  it("derives the same address through every entry point", () => {
    const derived = deriveMusig2CsvAddress({
      aggregatedXonly32: AGGREGATED_XONLY,
      userCompressed: USER_COMPRESSED,
      csvSequence: CSV_BLOCKS,
      network: "main",
    });
    expect(derived.address).toBe("bc1pcu74nmnlyrhanpsgqg35xhgc6fua9hzjsrh73ktr55f7k0kqdu2qcrta7q");
    expect(derived.tapMerkleRoot).toHaveLength(32);

    const viaTimelock = makeP2TRWithTimelock(
      hexToBytes(AGGREGATED_XONLY),
      hexToBytes(USER_XONLY),
      { type: "blocks", value: CSV_BLOCKS },
      "main",
    );
    expect(viaTimelock.address).toBe(derived.address);
  });

  it("rejects sequences BIP68 cannot express", () => {
    expect(() => buildCsvLeaf(hexToBytes(USER_XONLY), 0x0040ffff + 1)).toThrow(/BIP68/);
    expect(() => buildCsvLeaf(hexToBytes(USER_XONLY), (1 << 31) | 5)).toThrow();
    expect(() => buildCsvLeaf(hexToBytes(USER_XONLY), 0)).toThrow(/positive integer/);
  });
});
