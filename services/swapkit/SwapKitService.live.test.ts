import { describeLiveIfEnv } from "../../test/liveEnv";
import { expect, it } from "vitest";
import { isValidEvmAddress } from "../../lib/validation";
import {
  executeSwapKitSwap,
  routeSwapKitSwap,
  type SwapKitCreateResponse,
  type SwapKitRouteResponse,
} from "./SwapKitService";

const LIVE_ENV = ["NURI_LIVE_CONTRACTS"];
const BTC_LN = "BTC_LN";
const EURC_BASE = "EURC_BASE";
const LIVE_SETTLE_TARGET = "0x000000000000000000000000000000000000dEaD";
const LIVE_REFUND_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const SAMPLE_SATS = 10_000;

function numeric(value: unknown): number | null {
  const n =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

function collectRouteCandidates(route: SwapKitRouteResponse) {
  return [route.bestExecutable, route.best, ...(route.quotes ?? [])].filter(
    (quote): quote is NonNullable<typeof quote> => Boolean(quote),
  );
}

function expectRouteShape(route: SwapKitRouteResponse) {
  const candidates = collectRouteCandidates(route);
  expect(candidates.length).toBeGreaterThan(0);
  expect(
    candidates.some((quote) => {
      const rate = numeric(quote.rate ?? quote.limits?.rate ?? quote.effectiveRate);
      return rate != null && rate > 0;
    }),
  ).toBe(true);

  const limits = candidates
    .map((quote) => quote.limits)
    .find((candidate) => {
      const min = numeric(candidate?.min);
      const max = numeric(candidate?.max);
      return min != null && max != null && min >= 0 && max > min;
    });
  expect(limits, "an executable quote must include valid min/max limits").toBeDefined();
}

function fundingInstruction(swap: SwapKitCreateResponse): string {
  return String(
    swap.fund?.payInvoice ??
      swap.fund?.invoice ??
      swap.fund?.bolt11 ??
      swap.fund?.paymentRequest ??
      swap.fund?.sendToAddress ??
      swap.fund?.address ??
      "",
  ).trim();
}

function normalizeLightningInvoice(value: string): string | null {
  const withoutPrefix = value.toLowerCase().startsWith("lightning:")
    ? value.slice("lightning:".length)
    : value;
  return /^ln(bc|tb|bcrt)[a-z0-9]+$/i.test(withoutPrefix) ? withoutPrefix : null;
}

function isSwapKitSimulationPlaceholder(value: string): boolean {
  return /^<<.+>>$/.test(value);
}

function receiveAsset(swap: SwapKitCreateResponse): string | null {
  const asset = swap.receive?.asset ?? swap.legs?.at(-1)?.receive?.asset;
  return typeof asset === "string" && asset.trim().length > 0 ? asset.trim() : null;
}

describeLiveIfEnv("SwapKit MCP live contracts", LIVE_ENV, () => {
  it("returns shaped route quotes and limits in both directions", async () => {
    const btcToEurc = await routeSwapKitSwap({
      from: BTC_LN,
      to: EURC_BASE,
      sats: SAMPLE_SATS,
      side: "deposit",
      recipient: LIVE_SETTLE_TARGET,
    });
    expectRouteShape(btcToEurc);

    const eurcToBtc = await routeSwapKitSwap({
      from: EURC_BASE,
      to: BTC_LN,
      sats: SAMPLE_SATS,
      side: "settle",
      refundAddress: LIVE_REFUND_ADDRESS,
    });
    expectRouteShape(eurcToBtc);
  });

  it("simulates a BTC Lightning to Base EURC execution with parseable funding and receive shape", async () => {
    const quote = await routeSwapKitSwap({
      from: BTC_LN,
      to: EURC_BASE,
      sats: SAMPLE_SATS,
      side: "deposit",
      recipient: LIVE_SETTLE_TARGET,
    });
    const quoteRate = collectRouteCandidates(quote)
      .map((item) => numeric(item.rate ?? item.limits?.rate ?? item.effectiveRate))
      .find((rate): rate is number => rate != null && rate > 0);
    expect(quoteRate).toBeDefined();
    expect(quoteRate as number).toBeGreaterThan(0);

    const swap = await executeSwapKitSwap({
      from: BTC_LN,
      to: EURC_BASE,
      sats: SAMPLE_SATS,
      settleTarget: LIVE_SETTLE_TARGET,
      fromAddress: LIVE_REFUND_ADDRESS,
      simulate: true,
      includeQr: false,
    });

    const txId = swap.txId ?? swap.track?.txId ?? swap.id ?? swap.orderId;
    if (txId != null) {
      expect(typeof txId).toBe("string");
      expect(String(txId).trim().length).toBeGreaterThan(0);
    }

    const fund = fundingInstruction(swap);
    expect(fund.length).toBeGreaterThan(0);
    expect(isValidEvmAddress(fund), "BTC_LN funding must not be an EVM address").toBe(false);
    expect(
      normalizeLightningInvoice(fund) != null || isSwapKitSimulationPlaceholder(fund),
      "BTC_LN funding must be a Lightning invoice or SwapKit simulation placeholder",
    ).toBe(true);

    const receiveAmount = numeric(
      swap.receive?.amount ?? swap.legs?.at(-1)?.receive?.amount ?? swap.route?.totalSettle,
    );
    expect(receiveAmount).not.toBeNull();
    expect(receiveAmount as number).toBeGreaterThan(0);
    const receiveAssetId = receiveAsset(swap);
    expect(receiveAssetId).not.toBeNull();
    expect(receiveAssetId).toBe(EURC_BASE);
  });
});
