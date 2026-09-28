// Stable → BTC over SwapKit v2: quote via swap(mode:"quote"), execute via
// swap(mode:"commit") + the v2 action loop. Replaces the v1
// StableToBtcSwapService path (route ids, swap_execute, fund instructions,
// CoW client binding) with the v2 contract: the commit response's bound
// actions ARE the execution — nothing is reconstructed client-side.
import { newOp, LOG_EMOJI } from "../../lib/OperationLogUtils";
import { t } from "../../lib/i18n";
import { isValidEvmAddress } from "../../lib/validation";
import {
  SWAPKIT_V2_ACTION_KINDS,
  type SwapKitV2QuoteOption,
  type SwapKitV2QuoteResponse,
  quoteSwapKitV2,
} from "./SwapKitV2Service";
import { ownBitcoinDestinations } from "../bitcoin/ownDestinations";
import { commitAndTrackV2Order } from "./SwapKitV2CommitFlow";
import { baseStableToken, type BaseStableAssetId } from "./SwapKitStableAssets";
import { settleBindingForOrder } from "./SwapKitV2EvmRouteBinding";
import { standardEvmLoopOptions, SWAPKIT_V2_EVM_SOURCE_CAPABILITIES } from "./SwapKitV2Executors";

const SOURCE = "services/swapkit/SwapKitV2StableToBtcService.ts";
void SOURCE;

/** The wallet's standard capability declaration for v2 quote/commit. */
export const SWAPKIT_V2_WALLET_CAPABILITIES = SWAPKIT_V2_ACTION_KINDS.filter(
  // Normal order flows never fund a server-named address themselves.
  (kind) => kind !== "send_asset",
);

export type V2StableToBtcQuote = {
  optionId: string;
  /** Server quoteId of this option; the commit sends it back verbatim. */
  quoteId?: string;
  from: string;
  to: string;
  /** Stable the user spends, decimal. */
  depositAmount: number;
  /** BTC-side settle, decimal BTC (never sats — canonical unit rule). */
  settleAmount: number;
  requiredCapabilities: string[];
  etaSeconds?: number;
  limits: SwapKitV2QuoteOption["limits"];
  /** Provider prefix of the optionId, display only. */
  provider: string | null;
};

export type V2StableToBtcUnavailable = { provider?: string; reason?: string };

function toV2Quote(option: SwapKitV2QuoteOption): V2StableToBtcQuote {
  return {
    optionId: option.optionId,
    ...(option.quoteId ? { quoteId: option.quoteId } : {}),
    from: option.from,
    to: option.to,
    depositAmount: Number(option.depositAmount),
    settleAmount: Number(option.settleAmount),
    requiredCapabilities: option.requiredCapabilities ?? [],
    ...(option.expectedSettlement?.p50Seconds
      ? { etaSeconds: Number(option.expectedSettlement.p50Seconds) }
      : {}),
    limits: option.limits ?? null,
    provider: option.optionId.split(":")[0] || null,
  };
}

/**
 * Quote the pair. The server prices ONLY options this wallet's declared
 * capabilities can finish; everything else arrives as structured unavailable.
 */
export async function quoteV2StableToBtc(args: {
  fromAsset: BaseStableAssetId;
  to: string;
  amount: number;
  side: "deposit" | "settle";
  owner: string;
  settleTarget?: string;
  refundAddress?: string;
}): Promise<{ options: V2StableToBtcQuote[]; unavailable: V2StableToBtcUnavailable[] }> {
  const owner = args.owner.trim();
  if (!owner || !isValidEvmAddress(owner)) throw new Error("Base wallet address not available.");
  const from = baseStableToken(args.fromAsset).asset;
  const response: SwapKitV2QuoteResponse = await quoteSwapKitV2({
    from,
    to: args.to,
    amount: String(args.amount),
    side: args.side,
    owner,
    ...(args.settleTarget ? { settleTarget: args.settleTarget } : {}),
    refundAddress: args.refundAddress ?? owner,
    capabilities: SWAPKIT_V2_EVM_SOURCE_CAPABILITIES,
    signerClass: { evm: "eoa" },
  });
  return {
    options: (response.options ?? []).map(toV2Quote),
    unavailable: (response.unavailable ?? []).map((entry) => ({
      ...(entry.provider ? { provider: entry.provider } : {}),
      ...(entry.reason ? { reason: entry.reason } : {}),
    })),
  };
}

export type ExecuteV2StableToBtcArgs = {
  fromAsset: BaseStableAssetId;
  to: string;
  amount: number;
  side: "deposit" | "settle";
  /** The exact option the user accepted from the quote. */
  optionId: string;
  /** Server quoteId of the accepted option; sent back verbatim on commit. */
  quoteId?: string;
  /** The deposit the accepted quote stated — execution refuses drift above it
   * only through the server's own bound actions; this is persisted as the
   * resume-time bound. */
  quotedDeposit: number;
  /** The receive amount the accepted quote stated, in the settled asset's unit
   * (BTC for on-chain/Arkade). Bound as the immutable minimumSettleAmount. */
  quotedReceive: number;
  owner: string;
  settleTarget: string;
  refundAddress?: string;
  onStatus?: (text: string) => void;
  onOrderId?: (orderId: string) => void;
};

/**
 * Commit the accepted option and drive its action stream in the background.
 * The idempotency key is persisted BEFORE the request: a crash between commit
 * request and response retries into the SAME engine order.
 */
export async function executeV2StableToBtc(
  args: ExecuteV2StableToBtcArgs,
): Promise<{ orderId: string }> {
  const op = newOp("SwapKitV2StableToBtc", "executeV2StableToBtc", LOG_EMOJI.bitcoin);
  try {
    const owner = args.owner.trim();
    if (!owner || !isValidEvmAddress(owner)) throw new Error("Base wallet address not available.");
    const settleTarget = args.settleTarget.trim();
    if (!settleTarget) throw new Error("Recipient is missing.");
    if (!args.optionId) throw new Error("The accepted option is missing.");
    if (!Number.isFinite(args.quotedDeposit) || args.quotedDeposit <= 0) {
      throw new Error("The accepted quote is missing.");
    }
    const from = baseStableToken(args.fromAsset).asset;
    const refundAddress = args.refundAddress ?? owner;

    args.onStatus?.(t("swap.status.exchanging"));

    const source = baseStableToken(args.fromAsset);
    const { orderId } = await commitAndTrackV2Order({
      flow: "stable_to_btc",
      owner,
      from,
      to: args.to,
      amount: String(args.amount),
      side: args.side,
      settleTarget,
      refundAddress,
      acceptedDeposit: String(args.quotedDeposit),
      acceptedDepositAmount: String(args.quotedDeposit),
      minimumSettleAmount: String(args.quotedReceive),
      capabilities: SWAPKIT_V2_EVM_SOURCE_CAPABILITIES,
      optionId: args.optionId,
      ...(args.quoteId ? { quoteId: args.quoteId } : {}),
      // Restart parity: persist the exact inputs the live approval ceiling is
      // derived from, so rebuildV2ExecutorsForOrder() reproduces the SAME
      // bounded set. Without it a resumed order installs the default unbounded
      // executors and its still-ready approval-bearing call is rejected.
      executorSpec: {
        flow: "standard_evm",
        chainId: source.chainId,
        tokenDecimals: source.decimals,
        sourceToken: source.token,
        acceptedDeposit: String(args.quotedDeposit),
      },
      loopOptions: standardEvmLoopOptions(
        source.chainId,
        args.quotedDeposit,
        source.decimals,
        source.token,
        settleBindingForOrder({
          to: args.to,
          settleTarget,
        }),
      ),
      onOrderId: args.onOrderId,
      // The BTC destination rail (arkade/onchain) has no transfer store, so give
      // the move store the sats it receives to render the incoming leg.
      // quotedReceive is decimal BTC (canonical unit) — the Bitcoin rails count
      // in sats, so convert.
      moveAmounts: {
        sendAmount: args.quotedDeposit,
        receiveAmount: Math.round(args.quotedReceive * 100_000_000),
      },
      own: { ...(await ownBitcoinDestinations()), evm: owner },
      // Pending-row surface: the wallet UI shows the in-flight spend immediately.
      pendingRow: (id) => ({
        event: "wallet:pendingTransfer",
        payload: {
          amountFiat: args.quotedDeposit,
          fiat: args.fromAsset === "USDC_BASE" ? "USD" : "EUR",
          maxSellEurc: args.quotedDeposit,
          txHash: null,
          orderId: id,
          depositAddress: null,
          source: "swapkit",
          createdAt: new Date().toISOString(),
        },
      }),
    });

    op.log("v2 order committed", { orderId: `${orderId}`, optionId: args.optionId });
    op.end("Executed");
    return { orderId };
  } catch (e) {
    op.error("execute failed", e instanceof Error ? e.message : String(e));
    op.end("ERR");
    throw e;
  }
}
