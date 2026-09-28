import { describe, expect, it } from "vitest";
import { decodeFunctionData, erc20Abi } from "viem";
import { addressTarget, exactBaseUnits } from "./payTarget";
import { erc20TransferCalldata, walletConnectUnits } from "./walletConnectPay";
import { BASE_USDC } from "../../config/network";

const recipient = "0x1111111111111111111111111111111111111111";

describe("WalletConnect base-unit contract (runtime deferred)", () => {
  it("25 USDC uses the QR's 25000000 integer exactly once in ERC-20 calldata", () => {
    const target = addressTarget(
      { kind: "evm-stable", source: "USDC_BASE", asset: "USDC_BASE", address: recipient },
      recipient,
      exactBaseUnits("25", 6),
    );
    const units = walletConnectUnits(target.amount);
    expect(units).toBe(25_000_000n);
    if (units === null) throw new Error("Expected payable target");
    expect(target.uri).toContain("uint256=25000000");
    const decoded = decodeFunctionData({
      abi: erc20Abi,
      data: erc20TransferCalldata(BASE_USDC.address, target.value, units) as `0x${string}`,
    });
    expect(decoded.functionName).toBe("transfer");
    expect(decoded.args).toEqual([recipient, 25_000_000n]);
  });
  it("retains single base units and integers beyond floating-point precision", () => {
    expect(walletConnectUnits("1")).toBe(1n);
    expect(walletConnectUnits("9007199254740993")).toBe(9007199254740993n);
  });
  it.each([null, "", "0", "-1", "1.5", "1e6", " 25", (2n ** 256n).toString()])(
    "rejects invalid amount %s",
    (amount) => {
      expect(walletConnectUnits(amount)).toBeNull();
    },
  );
  it("rejects malformed addresses and out-of-range transfers", () => {
    expect(() => erc20TransferCalldata("bad", recipient, 1n)).toThrow();
    expect(() => erc20TransferCalldata(BASE_USDC.address, "bad", 1n)).toThrow();
    expect(() => erc20TransferCalldata(BASE_USDC.address, recipient, 0n)).toThrow();
    expect(() => erc20TransferCalldata(BASE_USDC.address, recipient, 2n ** 256n)).toThrow();
  });
});
