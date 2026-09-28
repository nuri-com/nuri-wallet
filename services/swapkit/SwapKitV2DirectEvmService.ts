// Base stable ⇄ Base stable over SwapKit v2. One quote/commit; the wallet
// signs exactly the bound Base transaction(s) the commit returns (LI.FI-style
// execute_evm_call or a CoW sign_typed_data — the dispatcher decides by kind).
//
// The v1 service's client-side reconstruction (route ids, retry-on-stale-quote
// re-creates, CoW client bindings) is gone: the server owns routing and
// amounts, and the quote's exact deposit is what the user accepts.
import { newOp, LOG_EMOJI } from "../../lib/OperationLogUtils";
import { getEthereumAddress } from "../../lib/secureKeyStorage";
import { isValidEvmAddress } from "../../lib/validation";
import { type SwapKitV2QuoteOption, quoteSwapKitV2 } from "./SwapKitV2Service";
import { commitAndTrackV2Order } from "./SwapKitV2CommitFlow";
import { readDirectSwapBalance } from "./SwapKitDirectEvmSwapService";
import { baseStableToken, type BaseStableAssetId } from "./SwapKitStableAssets";
import { settleBindingForOrder } from "./SwapKitV2EvmRouteBinding";
import { standardEvmLoopOptions, SWAPKIT_V2_EVM_SOURCE_CAPABILITIES } from "./SwapKitV2Executors";

const SOURCE = "services/swapkit/SwapKitV2DirectEvmService.ts";
void SOURCE;

// The approval ceiling (the accepted deposit) lives in SwapKitV2ApprovalBounds so the resume rebuild can
// reproduce the identical ceiling without importing this service.
export { approvalCeiling } from "./SwapKitV2ApprovalBounds";

// Quotes are usable for a bounded window; past it the user re-quotes.
const DIRECT_QUOTE_TTL_MS = 90_000;

export type V2DirectEvmQuote = {
  optionId: string;
  /** Server quoteId of this option; the commit sends it back verbatim. */
  quoteId?: string;
  from: BaseStableAssetId;
  to: BaseStableAssetId;
  /** Deposit actually priced (clamped to the live balance). */
  sendAmount: number;
  receiveAmount: number;
  rate: number;
  provider: string | null;
  settleTarget: string;
  owner: string;
  etaSeconds?: number;
  quotedAt: number;
  expiresAt: number;
};

/**
 * Price the pair without creating anything. The requested amount is clamped to
 * the live balance first (the one thing that can have moved since the screen
 * loaded); below one base unit returns [] — nothing worth swapping.
 */
export async function quoteV2DirectEvmSwaps(params: {
  from: BaseStableAssetId;
  to: BaseStableAssetId;
  amount: number;
  settleTarget?: string;
}): Promise<V2DirectEvmQuote[]> {
  const source = baseStableToken(params.from);
  const target = baseStableToken(params.to);
  if (source.asset === target.asset) throw new Error("A swap needs two different assets.");
  if (!Number.isFinite(params.amount) || params.amount <= 0) {
    throw new Error(`${source.symbol}→${target.symbol} swap requires a positive amount.`);
  }
  const eoa = await getEthereumAddress();
  if (!eoa || !isValidEvmAddress(eoa)) throw new Error("Ethereum wallet address not available.");
  const settleTarget = params.settleTarget?.trim() || eoa;

  const balance = await readDirectSwapBalance(source, eoa);
  const requested = Math.min(balance, params.amount);
  if (requested < 1 / 10 ** source.decimals) return [];

  const response = await quoteSwapKitV2({
    from: source.asset,
    to: target.asset,
    amount: String(requested),
    side: "deposit",
    owner: eoa,
    settleTarget,
    refundAddress: eoa,
    capabilities: SWAPKIT_V2_EVM_SOURCE_CAPABILITIES,
    signerClass: { evm: "eoa" },
  });
  const quotedAt = Date.now();
  return (response.options ?? []).flatMap((option: SwapKitV2QuoteOption) => {
    const send = Number(option.depositAmount);
    const receive = Number(option.settleAmount);
    // An option with no usable settlement is NOT an option. Coercing it to 0
    // marked it executable and committed `minimumSettleAmount: "0"` — consent
    // to receive nothing for a real spend. Drop it instead; `unavailable[]`
    // already carries the reason the server could not price it.
    if (!Number.isFinite(receive) || receive <= 0) return [];
    // Same for the deposit: the server's term or no option, never the amount
    // that was asked for standing in for one it did not price.
    if (!Number.isFinite(send) || send <= 0) return [];
    return [
      {
        optionId: option.optionId,
        ...(option.quoteId ? { quoteId: option.quoteId } : {}),
        from: params.from,
        to: params.to,
        sendAmount: send,
        receiveAmount: receive,
        rate: send > 0 ? receive / send : 0,
        provider: option.optionId.split(":")[0] || null,
        settleTarget,
        owner: eoa,
        ...(option.expectedSettlement?.p50Seconds
          ? { etaSeconds: Number(option.expectedSettlement.p50Seconds) }
          : {}),
        quotedAt,
        expiresAt: quotedAt + DIRECT_QUOTE_TTL_MS,
      },
    ];
  });
}

export type V2DirectEvmResult = {
  orderId: string;
  swappedAmount: number;
  quotedReceive: number;
};

/**
 * Commit the accepted quote and drive its bound actions in the background.
 * Fails closed on an expired quote — acting on it would execute against a
 * price the user saw for a market that has moved on.
 */
export async function executeV2DirectEvmSwap(params: {
  quote: V2DirectEvmQuote;
  /** "card" when the quote settles to the card account. */
  destination?: "card";
  op?: { scope: string; action: string };
  onOrderId?: (orderId: string) => void;
}): Promise<V2DirectEvmResult> {
  const { quote } = params;
  const op = newOp(
    params.op?.scope ?? "SwapKitV2DirectEvm",
    params.op?.action ?? "executeV2DirectEvmSwap",
    LOG_EMOJI.bitcoin,
  );
  try {
    if (Date.now() > quote.expiresAt) {
      throw new Error("The quote has expired. Check the price again.");
    }
    const source = baseStableToken(quote.from);
    const target = baseStableToken(quote.to);
    // Base stable↔stable: the LI.FI route can carry an approval-bearing
    // execute_evm_call. Bound the allowance to the accepted deposit (the
    // server approves exactly that) and restrict EVM calls to the source chain, else the
    // signer rejects the approval and the route cannot progress (#6).
    const loopOptions = standardEvmLoopOptions(
      source.chainId,
      quote.sendAmount,
      source.decimals,
      source.token,
      settleBindingForOrder({
        to: target.asset,
        settleTarget: quote.settleTarget,
      }),
    );

    const { orderId } = await commitAndTrackV2Order({
      flow: "direct_evm",
      owner: quote.owner,
      from: source.asset,
      to: target.asset,
      amount: String(quote.sendAmount),
      side: "deposit",
      settleTarget: quote.settleTarget,
      refundAddress: quote.owner,
      acceptedDepositAmount: String(quote.sendAmount),
      minimumSettleAmount: String(quote.receiveAmount),
      capabilities: SWAPKIT_V2_EVM_SOURCE_CAPABILITIES,
      optionId: quote.optionId,
      ...(quote.quoteId ? { quoteId: quote.quoteId } : {}),
      executorSpec: {
        flow: "standard_evm",
        chainId: source.chainId,
        tokenDecimals: source.decimals,
        sourceToken: source.token,
        acceptedDeposit: String(quote.sendAmount),
      },
      loopOptions,
      onOrderId: params.onOrderId,
      // A stable→stable swap moves money on BOTH rails at once, so both must
      // show it in flight: an `out` debit on the source rail and an `in` credit
      // on the destination rail. Same orderId, distinct direction — the store
      // keeps them as two rows, and the tracker's clear-by-orderId removes both.
      own: {
        evm: quote.owner,
        card: params.destination === "card" ? quote.settleTarget : null,
      },
      moveAmounts: { sendAmount: quote.sendAmount, receiveAmount: quote.receiveAmount },
      ...(params.destination === "card"
        ? { cardPocket: target.asset === "USDC_BASE" ? ("USD" as const) : ("EUR" as const) }
        : {}),
      pendingRow: (id) => [
        {
          event: "wallet:pendingTransfer",
          payload: {
            amountFiat: quote.sendAmount,
            fiat: source.asset === "USDC_BASE" ? "USD" : "EUR",
            direction: "out",
            txHash: null,
            orderId: id,
            source: "swapkit",
            createdAt: new Date().toISOString(),
          },
        },
        {
          event: "wallet:pendingTransfer",
          payload: {
            amountFiat: quote.receiveAmount,
            fiat: target.asset === "USDC_BASE" ? "USD" : "EUR",
            direction: "in",
            txHash: null,
            orderId: id,
            source: "swapkit",
            createdAt: new Date().toISOString(),
          },
        },
      ],
    });

    op.log("v2 direct swap committed", { orderId: `${orderId}`, optionId: quote.optionId });
    op.end("Executed");
    return { orderId, swappedAmount: quote.sendAmount, quotedReceive: quote.receiveAmount };
  } catch (e) {
    op.error("execute failed", e instanceof Error ? e.message : String(e));
    op.end("ERR");
    throw e;
  }
}
