import { describe, expect, it } from "vitest";
import {
  assertEvmCallBoundToRoute,
  assertTypedDataBoundToRoute,
  lifiNonEvmReceiverFor,
  settleBindingForOrder,
  type SwapKitV2EvmRouteBinding,
} from "./SwapKitV2EvmRouteBinding";
import live from "./__fixtures__/lifi-live-calldata.json";

// Calldata here is captured from LIVE li.quest quotes (read-only, no order).
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const EURC = "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42" as const;
const LIFI = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
const COW_RELAYER = "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110";
const OWNER = "0x00993cA379abd3F6c79E439c54a1AB2e7c95234B" as const;
const STRANGER = "0x9999999999999999999999999999999999999999" as const;
const DEPOSIT = 20_000_000n; // the accepted 20 USDC, exactly as quoted

const route = (
  settle: SwapKitV2EvmRouteBinding["settle"],
  chainId = 8453,
  sourceToken: `0x${string}` = USDC,
) => ({
  chainId,
  sourceToken,
  settle,
});
const eurcTo = (receiver: string) =>
  settleBindingForOrder({ to: "EURC_BASE", settleTarget: receiver });
const btcTo = (address: string) => settleBindingForOrder({ to: "BTC", settleTarget: address });
const call = (data: string, chainId = 8453, to = LIFI) => ({ chainId, to, data });
const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const approve = (spender: string, amount: bigint) =>
  `0x095ea7b3${word(spender)}${word(amount.toString(16))}`;

describe("approvals", () => {
  it("signs an approve of a route provider for the accepted deposit", () => {
    for (const spender of [LIFI, COW_RELAYER]) {
      expect(() =>
        assertEvmCallBoundToRoute(
          call(approve(spender, DEPOSIT), 8453, USDC),
          route(eurcTo(OWNER)),
          DEPOSIT,
          OWNER,
        ),
      ).not.toThrow();
    }
  });
  it("refuses an approve to a stranger", () => {
    expect(() =>
      assertEvmCallBoundToRoute(
        call(approve(STRANGER, 1n), 8453, USDC),
        route(eurcTo(OWNER)),
        DEPOSIT,
        OWNER,
      ),
    ).toThrow(/not a contract of the accepted route/);
  });
  it("refuses an approve above the accepted deposit", () => {
    expect(() =>
      assertEvmCallBoundToRoute(
        call(approve(LIFI, DEPOSIT + 1n), 8453, USDC),
        route(eurcTo(OWNER)),
        DEPOSIT,
        OWNER,
      ),
    ).toThrow(/exceeds the accepted deposit/);
  });
  it("refuses any non-approve call on the source token", () => {
    expect(() =>
      assertEvmCallBoundToRoute(
        call("0xa9059cbb", 8453, USDC),
        route(eurcTo(OWNER)),
        DEPOSIT,
        OWNER,
      ),
    ).toThrow(/Only an approve/);
  });
  it("refuses a call to an unknown contract", () => {
    expect(() =>
      assertEvmCallBoundToRoute(
        call("0xdeadbeef", 8453, STRANGER),
        route(eurcTo(OWNER)),
        DEPOSIT,
        OWNER,
      ),
    ).toThrow(/not a contract of the accepted route/);
  });
});

describe("LI.FI calls pay the committed recipient", () => {
  it("accepts the live USDC→EURC swap to the committed recipient", () => {
    expect(() =>
      assertEvmCallBoundToRoute(
        call(live.stableToStable.data),
        route(eurcTo(OWNER)),
        DEPOSIT,
        OWNER,
      ),
    ).not.toThrow();
  });
  it("refuses the same swap when the committed recipient is someone else", () => {
    expect(() =>
      assertEvmCallBoundToRoute(
        call(live.stableToStable.data),
        route(eurcTo(STRANGER)),
        DEPOSIT,
        OWNER,
      ),
    ).toThrow(/not the committed recipient/);
  });

  // Stable → on-chain BTC (and → Arkade via the boarding address) stays open.
  it("accepts the live USDC→BTC bridge to the committed Bitcoin address", () => {
    for (const leg of [live.stableToBtcP2wpkh, live.stableToBtcTaproot]) {
      expect(() =>
        assertEvmCallBoundToRoute(call(leg.data), route(btcTo(leg.btcAddress)), DEPOSIT, OWNER),
      ).not.toThrow();
    }
  });
  it("still refuses a Bitcoin bridge that spends more than the accepted deposit", () => {
    expect(() =>
      assertEvmCallBoundToRoute(
        call(live.stableToBtcP2wpkh.data),
        route(btcTo(live.stableToBtcP2wpkh.btcAddress)),
        1n,
        OWNER,
      ),
    ).toThrow(/spends more than the accepted deposit/);
  });
  it("still refuses a Bitcoin bridge when the order settles on an EVM chain", () => {
    expect(() =>
      assertEvmCallBoundToRoute(
        call(live.stableToBtcP2wpkh.data),
        route(eurcTo(OWNER)),
        DEPOSIT,
        OWNER,
      ),
    ).toThrow();
  });

  // The sweep's tBTC on Arbitrum → EURC on Base (a LI.FI Mayan bridge).
  it("accepts the live tBTC-Arbitrum → EURC-Base sweep bridge to this wallet", () => {
    const leg = live.sweepTbtcArbitrumToEurcBase;
    expect(() =>
      assertEvmCallBoundToRoute(
        call(leg.data, leg.chainId),
        route(eurcTo(OWNER), leg.chainId, leg.sourceToken as `0x${string}`),
        BigInt(leg.fromAmount),
        OWNER,
      ),
    ).not.toThrow();
  });
  it("refuses that sweep bridge when the committed recipient differs", () => {
    const leg = live.sweepTbtcArbitrumToEurcBase;
    expect(() =>
      assertEvmCallBoundToRoute(
        call(leg.data, leg.chainId),
        route(eurcTo(STRANGER), leg.chainId, leg.sourceToken as `0x${string}`),
        BigInt(leg.fromAmount),
        OWNER,
      ),
    ).toThrow(/not the committed recipient/);
  });

  it("refuses LI.FI calldata with no readable destination", () => {
    expect(() =>
      assertEvmCallBoundToRoute(call("0xdeadbeef"), route(eurcTo(OWNER)), DEPOSIT, OWNER),
    ).toThrow(/no readable destination/);
  });

  it("reproduces LI.FI's Bitcoin receiver encoding for every address type", () => {
    for (const [address, expected] of Object.entries(live.nonEvmReceiverVectors)) {
      expect(lifiNonEvmReceiverFor(address)).toBe(expected);
    }
  });
});

// Taner (129ca492) #1: a LI.FI call must spend only this order's token, at
// most the accepted deposit, and (same-chain) buy the committed token — so an
// allowance left on another token or a larger one can never be pulled by it.
describe("LI.FI calls spend only the accepted deposit of the source token", () => {
  const usdcTo = (receiver: string) =>
    settleBindingForOrder({ to: "USDC_BASE", settleTarget: receiver });
  const s2sFrom = BigInt(live.stableToStable.fromAmount ?? "20000000");

  it("same-chain swap: refuses another source token, more than the deposit, another buy token", () => {
    const data = call(live.stableToStable.data);
    expect(() =>
      assertEvmCallBoundToRoute(data, route(eurcTo(OWNER), 8453, EURC), s2sFrom, OWNER),
    ).toThrow(/not this order's source token/);
    expect(() =>
      assertEvmCallBoundToRoute(data, route(eurcTo(OWNER)), s2sFrom - 1n, OWNER),
    ).toThrow(/spends more than the accepted deposit/);
    expect(() => assertEvmCallBoundToRoute(data, route(usdcTo(OWNER)), s2sFrom, OWNER)).toThrow(
      /other than the committed settlement token/,
    );
  });

  it("USDC→BTC bridge: refuses another source token or more than the deposit", () => {
    const leg = live.stableToBtcP2wpkh;
    const from = BigInt(leg.fromAmount ?? "20000000");
    expect(() =>
      assertEvmCallBoundToRoute(
        call(leg.data),
        route(btcTo(leg.btcAddress), 8453, EURC),
        from,
        OWNER,
      ),
    ).toThrow(/not this order's source token/);
    expect(() =>
      assertEvmCallBoundToRoute(call(leg.data), route(btcTo(leg.btcAddress)), from - 1n, OWNER),
    ).toThrow(/spends more than the accepted deposit/);
  });

  it("sweep bridge (tBTC Arbitrum → EURC Base): refuses another token or more than the detected balance", () => {
    const leg = live.sweepTbtcArbitrumToEurcBase;
    const from = BigInt(leg.fromAmount);
    const usdcArb = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;
    expect(() =>
      assertEvmCallBoundToRoute(
        call(leg.data, leg.chainId),
        route(eurcTo(OWNER), leg.chainId, usdcArb),
        from,
        OWNER,
      ),
    ).toThrow(/not this order's source token/);
    expect(() =>
      assertEvmCallBoundToRoute(
        call(leg.data, leg.chainId),
        route(eurcTo(OWNER), leg.chainId, leg.sourceToken as `0x${string}`),
        from - 1n,
        OWNER,
      ),
    ).toThrow(/spends more than the accepted deposit/);
  });
});

describe("typed data", () => {
  const settle = eurcTo(OWNER);
  const bounds = { chainId: 8453, sourceToken: USDC, ceiling: DEPOSIT, settle, wallet: OWNER };
  const cow = (message: Record<string, unknown> = {}, domain: Record<string, unknown> = {}) => ({
    domain: {
      name: "Gnosis Protocol",
      version: "v2",
      chainId: 8453,
      verifyingContract: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
      ...domain,
    },
    primaryType: "Order",
    message: {
      sellToken: USDC,
      buyToken: EURC,
      receiver: OWNER,
      sellAmount: "20000000",
      buyAmount: "1",
      feeAmount: "0",
      ...message,
    },
  });
  it("signs the CoW order for the accepted swap, whatever buy amount the server quoted", () => {
    expect(assertTypedDataBoundToRoute(cow(), bounds)).toBe("cow_order");
  });
  it("treats a zero receiver as the signer itself", () => {
    expect(assertTypedDataBoundToRoute(cow({ receiver: `0x${"0".repeat(40)}` }), bounds)).toBe(
      "cow_order",
    );
  });
  it("refuses a CoW order paying another receiver or selling more than the deposit", () => {
    expect(() => assertTypedDataBoundToRoute(cow({ receiver: STRANGER }), bounds)).toThrow(
      /receiver/,
    );
    expect(() => assertTypedDataBoundToRoute(cow({ sellAmount: "20000001" }), bounds)).toThrow(
      /above the accepted/,
    );
  });
  it("refuses permits and other primary types", () => {
    expect(() => assertTypedDataBoundToRoute({ ...cow(), primaryType: "Permit" }, bounds)).toThrow(
      /not an order/,
    );
  });
});
