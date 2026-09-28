import { describe, expect, it } from "vitest";
import {
  isBtcTxid,
  isConnectivityError,
  isEvmTxHash,
  isNetworkErrorMessage,
  isValidEmail,
  isValidEvmAddress,
  isValidIban,
} from "./validation";

describe("validation helpers", () => {
  it.each([
    ["0xde709f2102306220921060314715629080e2fb77", true],
    ["0xde709f2102306220921060314715629080e2fb77 ", true],
    ["0xDE709F2102306220921060314715629080e2fb77", false],
    ["de709f2102306220921060314715629080e2fb77", false],
  ] as const)("validates EVM address %s", (value, expected) => {
    expect(isValidEvmAddress(value)).toBe(expected);
  });

  it("validates transaction hash shapes", () => {
    const evmHash = `0x${"a".repeat(64)}`;
    const btcTxid = "b".repeat(64);
    expect(isEvmTxHash(evmHash)).toBe(true);
    expect(isEvmTxHash(btcTxid)).toBe(false);
    expect(isBtcTxid(btcTxid)).toBe(true);
    expect(isBtcTxid(evmHash)).toBe(false);
  });

  it.each(["Network request failed", "failed to fetch", "timeout"])(
    "detects connectivity error %s",
    (message) => {
      expect(isConnectivityError(message)).toBe(true);
      expect(isNetworkErrorMessage(message)).toBe(true);
    },
  );

  it("validates emails and normalized IBANs", () => {
    expect(isValidEmail(" user@example.com ")).toBe(true);
    expect(isValidEmail("user@example")).toBe(false);
    expect(isValidIban("DE89 3704 0044 0532 0130 00")).toBe(true);
    expect(isValidIban("DE89 3704 0044 0532 0130 01")).toBe(false);
  });
});
