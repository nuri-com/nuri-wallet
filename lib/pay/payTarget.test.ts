import { describe, expect, it } from "vitest";
import { ARBITRUM_USDC, BASE_EURC, BASE_USDC } from "../../config/network";
import {
  addressTarget,
  exactBaseUnits,
  formatBaseUnits,
  paySourceDecimals,
  swapDepositUri,
} from "./payTarget";
import type { PayRail } from "./selectPayRail";

const BTC_RAIL: PayRail = { kind: "btc-onchain", source: "BTC", address: "bc1ptest" };
const ARKADE_RAIL: PayRail = { kind: "arkade", source: "BTC_ARKADE", address: "ark1qtest" };
const USDC_RAIL: PayRail = {
  kind: "evm-stable",
  source: "USDC_BASE",
  asset: "USDC_BASE",
  address: "0x00993cA379abd3F6c79E439c54a1AB2e7c95234B",
};
const EURC_RAIL: PayRail = {
  kind: "evm-stable",
  source: "EURC_BASE",
  asset: "EURC_BASE",
  address: "0x00993cA379abd3F6c79E439c54a1AB2e7c95234B",
};

describe("exact base units", () => {
  it("converts a decimal figure by shifting it, never by multiplying a float", () => {
    expect(exactBaseUnits("12.5", 6)).toBe(12_500_000n);
    expect(exactBaseUnits("0.000001", 6)).toBe(1n);
    expect(exactBaseUnits(12.345678, 6)).toBe(12_345_678n);
    expect(exactBaseUnits("50000", 0)).toBe(50_000n);
  });

  it("refuses a figure the asset cannot hold exactly", () => {
    // Half a base unit: rounding it would put 1 in the QR and 0 on the page.
    expect(exactBaseUnits("0.0000005", 6)).toBeNull();
    expect(exactBaseUnits(0.0000005, 6)).toBeNull();
    expect(exactBaseUnits("12.3456789", 6)).toBeNull();
    expect(exactBaseUnits("0.5", 0)).toBeNull();
  });

  it("refuses everything that is not a plain positive decimal", () => {
    expect(exactBaseUnits("", 6)).toBeNull();
    expect(exactBaseUnits("0", 6)).toBeNull();
    expect(exactBaseUnits("0.000000", 6)).toBeNull();
    expect(exactBaseUnits("-1", 6)).toBeNull();
    expect(exactBaseUnits("1e-7", 6)).toBeNull();
    expect(exactBaseUnits(1e-7, 6)).toBeNull();
    expect(exactBaseUnits(Number.NaN, 6)).toBeNull();
    expect(exactBaseUnits(Number.POSITIVE_INFINITY, 6)).toBeNull();
    expect(exactBaseUnits("12,5", 6)).toBeNull();
    // Half-written figures the keypad can produce: neither is a payable number,
    // and neither may be quietly read as "no amount".
    expect(exactBaseUnits(".5", 6)).toBeNull();
    expect(exactBaseUnits("1.", 6)).toBeNull();
  });

  it("writes the figure back out from the same integer", () => {
    expect(formatBaseUnits(12_500_000n, 6)).toBe("12.5");
    expect(formatBaseUnits(1n, 6)).toBe("0.000001");
    expect(formatBaseUnits(50_000n, 0)).toBe("50000");
    expect(formatBaseUnits(50_000n, 8, true)).toBe("0.00050000");
  });

  it("knows the smallest unit of every source it offers", () => {
    expect(paySourceDecimals("BTC")).toBe(0);
    expect(paySourceDecimals("BTC_LN")).toBe(0);
    expect(paySourceDecimals("USDC_BASE")).toBe(BASE_USDC.decimals);
    expect(paySourceDecimals("USDC_ARBITRUM")).toBe(ARBITRUM_USDC.decimals);
  });
});

describe("pay target URIs", () => {
  it("keeps the bare address readable and puts the URI in the QR", () => {
    const target = addressTarget(BTC_RAIL, "bc1ptest", 50_000n);
    expect(target.value).toBe("bc1ptest");
    expect(target.uri).toBe("bitcoin:bc1ptest?amount=0.00050000");
    expect(target.amount).toBe("50000");
    expect(target.decimals).toBe(0);
  });

  it("states BIP-21 amounts in BTC, never in exponent form", () => {
    expect(addressTarget(BTC_RAIL, "bc1ptest", 10n).uri).toBe("bitcoin:bc1ptest?amount=0.00000010");
  });

  it("builds the EIP-681 ERC-20 transfer form in the token's base units", () => {
    expect(addressTarget(USDC_RAIL, USDC_RAIL.address, 12_500_000n).uri).toBe(
      `ethereum:${BASE_USDC.address}@${BASE_USDC.chainId}/transfer?address=${USDC_RAIL.address}&uint256=12500000`,
    );
    expect(addressTarget(EURC_RAIL, EURC_RAIL.address, 1_000_000n).uri).toBe(
      `ethereum:${BASE_EURC.address}@${BASE_EURC.chainId}/transfer?address=${EURC_RAIL.address}&uint256=1000000`,
    );
  });

  it("keeps a 25 EURC request on Base with the recipient and six-decimal token amount", () => {
    const target = addressTarget(EURC_RAIL, EURC_RAIL.address, exactBaseUnits("25", 6));
    const uri = new URL(target.uri);
    expect(uri.protocol).toBe("ethereum:");
    expect(uri.pathname).toBe("0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42@8453/transfer");
    expect(uri.searchParams.get("address")).toBe(EURC_RAIL.address);
    expect(uri.searchParams.get("uint256")).toBe("25000000");
    expect(formatBaseUnits(BigInt(uri.searchParams.get("uint256") ?? "0"), 6)).toBe("25");
  });

  it("encodes a swap deposit on the source chain, with the quoted amount", () => {
    const deposit = "0x0000000000000000000000000000000000001234";
    expect(swapDepositUri("USDC_ARBITRUM", deposit, 12_345_678n)).toBe(
      `ethereum:${ARBITRUM_USDC.address}@${ARBITRUM_USDC.chainId}/transfer?address=${deposit}&uint256=12345678`,
    );
  });

  it("leaves a swap deposit bare when there is no amount to enforce", () => {
    const deposit = "0x0000000000000000000000000000000000001234";
    expect(swapDepositUri("USDC_ARBITRUM", deposit, null)).toBe(deposit);
    expect(swapDepositUri("BTC", deposit, 1n)).toBe(deposit);
  });

  it("leaves rails without a URI scheme, and amountless targets, bare", () => {
    expect(addressTarget(ARKADE_RAIL, "ark1qtest", 5_000n).uri).toBe("ark1qtest");
    expect(addressTarget(BTC_RAIL, "bc1ptest", null).uri).toBe("bc1ptest");
    expect(addressTarget(USDC_RAIL, USDC_RAIL.address, 0n).uri).toBe(USDC_RAIL.address);
  });
});
