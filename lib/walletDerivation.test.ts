import { describe, expect, it } from "vitest";
import { bytesToHex, utf8ToBytes } from "./crypto";
import { deriveWalletEntropy } from "./walletDerivation";
import { deriveBitcoinAddress } from "./bitcoin/bip86";
import { deriveEthereumAddress } from "./ethereum/address";

const fixedPrf = utf8ToBytes("nuri phase 4 fixed prf vector");

describe("wallet derivation vectors", () => {
  it("pins chain-separated HKDF entropy for wallet restoration", () => {
    expect(bytesToHex(deriveWalletEntropy(fixedPrf, "bitcoin"))).toBe(
      "f03ffeaca523918ded8df7d7725e90a52967134292f15a91d1549e2e45547b31",
    );
    expect(bytesToHex(deriveWalletEntropy(fixedPrf, "ethereum"))).toBe(
      "a4f1309a960febb4f07b955bcc56282e785ca175249bca7c9cf1abe952dfe75c",
    );
  });

  it("derives stable Bitcoin and Ethereum wallets from the fixed PRF vector", () => {
    const bitcoin = deriveBitcoinAddress(deriveWalletEntropy(fixedPrf, "bitcoin"));
    const ethereum = deriveEthereumAddress(deriveWalletEntropy(fixedPrf, "ethereum"));

    expect(bitcoin.address).toBe("bc1p967prazxrrtfkzq5ukdzjcnn3gfc27p0vznvw8xczq4att0veyps67wsdu");
    expect(bytesToHex(bitcoin.privateKey)).toBe(
      "a30f6fb61ae5765abb181725af85f9c452cd3683c7980a1b46b519c7f401e143",
    );
    expect(bytesToHex(bitcoin.xOnlyPubkey)).toBe(
      "2ebc11f44618d69b0814e59a2962738a1385782f60a6c71cd8102bd5adecc903",
    );

    expect(ethereum.address).toBe("0x94D8b9D66CEAa204A05A0c52a9442DF917dD7624");
    expect(bytesToHex(ethereum.privateKey)).toBe(
      "bfd11f054132fb2b6ae5f334be68664dc86d9a1f5bc7ff5d82f7c25951542a0e",
    );
  });
});
