import { describe, expect, it, vi } from "vitest";
import { toSwapTarget, toSwapTargetAsync } from "./toSwapTarget";

const resolveName = vi.fn();
vi.mock("../rpc/chainRpc", () => ({
  withFallback: (_chainId: number, fn: (p: unknown) => unknown) => fn({ resolveName }),
}));

const SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const EVM = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";

describe("toSwapTarget", () => {
  it("maps chain-prefixed URIs (preferred format)", () => {
    expect(toSwapTarget(`solana:${SOL}`)).toMatchObject({
      to: "SOL_SOLANA",
      settleTarget: SOL,
    });
    expect(toSwapTarget(`gno:${EVM}`)).toMatchObject({
      to: "EURE_GNOSIS",
      settleTarget: EVM,
    });
    // query params are dropped from the address
    expect(toSwapTarget(`solana:${SOL}?amount=1`)?.settleTarget).toBe(SOL);
  });

  describe("ENS", () => {
    it("resolves a chain-prefixed name and keeps both name and address", async () => {
      resolveName.mockResolvedValueOnce(EVM);
      const target = await toSwapTargetAsync("gno:vitalik.eth");
      expect(target).toMatchObject({
        to: "EURE_GNOSIS",
        settleTarget: EVM,
        ensName: "vitalik.eth",
      });
      // both the scanned name and the resolved address stay visible — the
      // user signs off on where funds go
      expect(target?.label).toContain("vitalik.eth");
      expect(target?.label).toContain("0x1231");
    });

    it("leaves a BARE name to the native Base path, like a bare 0x", async () => {
      resolveName.mockClear();
      expect(await toSwapTargetAsync("vitalik.eth")).toBeNull();
      expect(resolveName).not.toHaveBeenCalled();
    });

    it("returns null for an unregistered name", async () => {
      resolveName.mockResolvedValueOnce(null);
      expect(await toSwapTargetAsync("gno:nope.eth")).toBeNull();
    });

    it("propagates an RPC outage instead of reporting an invalid address", async () => {
      resolveName.mockRejectedValueOnce(new Error("offline"));
      await expect(toSwapTargetAsync("gno:vitalik.eth")).rejects.toThrow("offline");
    });

    it("does not touch the network for non-ENS input", async () => {
      resolveName.mockClear();
      expect(await toSwapTargetAsync(`gno:${EVM}`)).toMatchObject({ to: "EURE_GNOSIS" });
      expect(resolveName).not.toHaveBeenCalled();
    });
  });

  it("maps every EVM chain prefix, and rejects a malformed address", () => {
    for (const [prefix, asset] of [
      ["xdai", "EURE_GNOSIS"],
      ["arb1", "USDC_ARBITRUM"],
      ["arb", "USDC_ARBITRUM"],
      ["arbitrum", "USDC_ARBITRUM"],
      ["matic", "USDC_POLYGON"],
      ["pol", "USDC_POLYGON"],
      ["polygon", "USDC_POLYGON"],
      ["eth", "USDC_ETH"],
      ["mainnet", "USDC_ETH"],
    ]) {
      expect(toSwapTarget(`${prefix}:${EVM}`)).toMatchObject({ to: asset, settleTarget: EVM });
    }
    expect(toSwapTarget("gno:0xdeadbeef")).toBeNull();
    expect(toSwapTarget(`gno:${SOL}`)).toBeNull();
  });

  it("maps a bare base58 address to Solana", () => {
    expect(toSwapTarget(SOL)).toMatchObject({ to: "SOL_SOLANA", settleTarget: SOL });
  });

  it("maps EIP-681 with a foreign chain id; leaves Base and bare EVM to the native path", () => {
    expect(toSwapTarget(`ethereum:${EVM}@42161`)).toMatchObject({
      to: "USDC_ARBITRUM",
      settleTarget: EVM,
    });
    expect(toSwapTarget(`ethereum:${EVM}@8453`)).toBeNull();
    expect(toSwapTarget(EVM)).toBeNull();
  });

  it("rejects an EIP-681 native-value intent instead of substituting the stable asset", () => {
    // `value` is a native-coin (ETH) payment intent; mapping the chain to its
    // stable asset would settle USDC for an ETH request. Must reject, not swap.
    expect(toSwapTarget(`ethereum:${EVM}@1?value=100000000000000000`)).toBeNull();
    expect(toSwapTarget(`ethereum:${EVM}@137?value=1`)).toBeNull();
    // Fail closed on value forms parseEip681Value doesn't materialize, and on a
    // malformed value — presence of a native value is enough to reject.
    expect(toSwapTarget(`ethereum:${EVM}@1?value=%2B1`)).toBeNull(); // "+1"
    expect(toSwapTarget(`ethereum:${EVM}@1?value=.1e18`)).toBeNull();
    expect(toSwapTarget(`ethereum:${EVM}@1?value=abc`)).toBeNull(); // malformed
    // A valueless (or explicit zero) address intent still maps by chain.
    expect(toSwapTarget(`ethereum:${EVM}@1`)).toMatchObject({
      to: "USDC_ETH",
      settleTarget: EVM,
    });
    expect(toSwapTarget(`ethereum:${EVM}@1?value=0`)).toMatchObject({
      to: "USDC_ETH",
      settleTarget: EVM,
    });
  });

  it("maps caip10 namespaces", () => {
    expect(toSwapTarget(`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${SOL}`)).toMatchObject({
      to: "SOL_SOLANA",
      settleTarget: SOL,
    });
    expect(toSwapTarget(`eip155:100:${EVM}`)).toMatchObject({
      to: "EURE_GNOSIS",
      settleTarget: EVM,
    });
  });

  it("maps monero URIs and bare XMR addresses", () => {
    const XMR = `4${"A".repeat(94)}`;
    expect(toSwapTarget(XMR)).toMatchObject({ to: "XMR_MONERO", settleTarget: XMR });
    expect(toSwapTarget(`monero:${XMR}?tx_amount=1.5`)).toMatchObject({
      to: "XMR_MONERO",
      settleTarget: XMR,
    });
    // Subaddress (8…) and integrated (106 chars) forms parse too.
    expect(toSwapTarget(`8${"A".repeat(94)}`)).toMatchObject({ to: "XMR_MONERO" });
    expect(toSwapTarget(`4${"A".repeat(105)}`)).toMatchObject({ to: "XMR_MONERO" });
    // Wrong length / wrong leading char stays unknown.
    expect(toSwapTarget(`4${"A".repeat(90)}`)).toBeNull();
    expect(toSwapTarget(`9${"A".repeat(94)}`)).toBeNull();
  });

  it("maps zcash URIs and bare addresses; t-address never falls through to Solana", () => {
    const T_ADDR = `t1${"a".repeat(33)}`;
    const ZS_ADDR = `zs1${"a".repeat(75)}`;
    const U_ADDR = `u1${"a".repeat(100)}`;
    expect(toSwapTarget(T_ADDR)).toMatchObject({ to: "ZEC_ZCASH", settleTarget: T_ADDR });
    expect(toSwapTarget(ZS_ADDR)).toMatchObject({ to: "ZEC_ZCASH", settleTarget: ZS_ADDR });
    expect(toSwapTarget(U_ADDR)).toMatchObject({ to: "ZEC_ZCASH", settleTarget: U_ADDR });
    expect(toSwapTarget(`zcash:${T_ADDR}?amount=0.5`)).toMatchObject({
      to: "ZEC_ZCASH",
      settleTarget: T_ADDR,
    });
    // t2 is not a mainnet Zcash prefix — it falls through to the documented
    // bare-base58 Solana default (32–44 chars), same as any other base58 blob.
    expect(toSwapTarget(`t2${"a".repeat(33)}`)).toMatchObject({ to: "SOL_SOLANA" });
  });

  it("rejects unknown prefixes and garbage", () => {
    expect(toSwapTarget("dogecoin:DBXu2kgc3xtvCUWFcxFE3r9hEYgmuaaCyD")).toBeNull();
    expect(toSwapTarget("hello world")).toBeNull();
    expect(toSwapTarget("")).toBeNull();
  });
});
