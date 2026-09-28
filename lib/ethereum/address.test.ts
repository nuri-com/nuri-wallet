import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes } from "../crypto";
import { deriveEthereumAddress } from "./address";

const entropy = hexToBytes("a4f1309a960febb4f07b955bcc56282e785ca175249bca7c9cf1abe952dfe75c");

describe("Ethereum address derivation", () => {
  const wallet = deriveEthereumAddress(entropy);

  it("pins the BIP-44 private key and EIP-55 address for fixed entropy", () => {
    expect(wallet.address).toBe("0x94D8b9D66CEAa204A05A0c52a9442DF917dD7624");
    expect(bytesToHex(wallet.privateKey)).toBe(
      "bfd11f054132fb2b6ae5f334be68664dc86d9a1f5bc7ff5d82f7c25951542a0e",
    );
  });

  it("returns a checksummed address instead of lower-case hex", () => {
    const { address } = wallet;

    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(address).not.toBe(address.toLowerCase());
    expect(address).not.toBe(address.toUpperCase());
  });
});
