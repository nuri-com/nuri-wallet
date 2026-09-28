import { bech32m } from "bech32";
import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes } from "../crypto";
import { deriveBitcoinAddress } from "./bip86";

const entropy = hexToBytes("f03ffeaca523918ded8df7d7725e90a52967134292f15a91d1549e2e45547b31");

describe("BIP-86 Bitcoin derivation", () => {
  const wallet = deriveBitcoinAddress(entropy);

  it("pins the taproot address, tweaked x-only output key, and private key for fixed entropy", () => {
    expect(wallet.address).toBe("bc1p967prazxrrtfkzq5ukdzjcnn3gfc27p0vznvw8xczq4att0veyps67wsdu");
    expect(bytesToHex(wallet.xOnlyPubkey)).toBe(
      "2ebc11f44618d69b0814e59a2962738a1385782f60a6c71cd8102bd5adecc903",
    );
    expect(bytesToHex(wallet.privateKey)).toBe(
      "a30f6fb61ae5765abb181725af85f9c452cd3683c7980a1b46b519c7f401e143",
    );
  });

  it("encodes the tweaked output key as a mainnet witness-v1 bech32m address", () => {
    const decoded = bech32m.decode(wallet.address);
    const [witnessVersion, ...programWords] = decoded.words;

    expect(decoded.prefix).toBe("bc");
    expect(witnessVersion).toBe(1);
    expect(new Uint8Array(bech32m.fromWords(programWords))).toEqual(wallet.xOnlyPubkey);
    expect(wallet.xOnlyPubkey).toHaveLength(32);
  });
});
