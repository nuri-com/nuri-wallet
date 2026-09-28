/**
 * Turning a chosen rail into something a stranger can pay.
 *
 * The ORDER matters, which is why every rail comes through one entry point: the
 * direct rails produce a payable value out of the recipient's own public record
 * and create nothing, while a swap rail creates a real order the moment it is
 * asked for. Making the create-nothing case the default is what stops a rail
 * from growing a shortcut into creating an order early.
 *
 * Nothing here reads the payer's wallet: the pay page is opened by strangers,
 * and Phase 1 hands them an address or an invoice to pay from wherever they
 * already hold the asset.
 */

import { decodeBolt11Facts } from "../../lib/bitcoin/lightning";
import {
  addressTarget,
  exactBaseUnits,
  formatBaseUnits,
  type PayTarget,
  paySourceDecimals,
  swapDepositUri,
} from "../../lib/pay/payTarget";
import type { PayRail } from "../../lib/pay/selectPayRail";
import { isValidEvmAddress } from "../../lib/validation";
import { requestLnurlInvoice, resolveLnurlPayRequest } from "../bitcoin/LnurlService";
import { randomUUID } from "expo-crypto";
import { getCacheValue, setCacheValue } from "../balance/TransactionCacheService";
import {
  asSwapKitV2OrderId,
  commitSwapKitV2,
  getSwapKitV2Status,
  isSwapKitV2Terminal,
  quoteSwapKitV2,
} from "../swapkit/SwapKitV2Service";

// Pay is opened by strangers without a Nuri wallet. Keep its random recovery
// capability separate from signed-in wallet orders and never arm wallet signers.
const payOrderKey = (id: string) => `pay:v2:${id}`;

const MSATS_PER_SAT = 1000;

/** Where a created swap order stands, from the payer's side of it. */
export type PayOrderStatus = {
  state: "waiting" | "settled" | "failed";
  /** The server's own sentence for the active leg, while there is one. */
  phase: string | null;
};

/**
 * The order behind a swap deposit, read once.
 *
 * The payer funds this from a wallet this app cannot see, so the order is the
 * only thing that can say whether their money arrived. Anything terminal that
 * is not COMPLETED is a failure the page must not present as payable — the
 * deposit address of a dead order takes funds nothing will settle.
 */
export async function readPayOrderStatus(txId: string): Promise<PayOrderStatus> {
  const recoveryKey = await getCacheValue<string>(payOrderKey(txId));
  if (!recoveryKey) throw new Error("Payment order recovery information is missing.");
  const status = await getSwapKitV2Status(asSwapKitV2OrderId(txId), { recoveryKey });
  if (isSwapKitV2Terminal(status)) {
    return { state: status.status === "COMPLETED" ? "settled" : "failed", phase: null };
  }
  return {
    state: "waiting",
    phase: status.status === "AWAITING_ACTION" ? "Waiting for payment" : "Processing payment",
  };
}

/**
 * The one payable thing for this rail, or null when the rail cannot produce one.
 * Null is a real answer — the page carries it on the button, never as error text.
 */
export async function buildPayTarget(
  rail: PayRail,
  amount: string | number | null,
  refundAddress?: string,
): Promise<PayTarget | null> {
  // One conversion, here, for every rail: the exact figure in the asset's own
  // smallest unit. Everything downstream — the QR, the line the payer reads,
  // the invoice that gets minted — is derived from that single integer, so no
  // two of them can round differently. A figure that cannot be said exactly in
  // those units is not a smaller figure; it is no target at all.
  const stated = amount !== null && amount !== "";
  const units = stated ? exactBaseUnits(amount, paySourceDecimals(rail.source)) : null;
  if (stated && units === null) return null;

  switch (rail.kind) {
    case "btc-onchain":
    case "arkade":
      return addressTarget(rail, rail.address, units);
    case "evm-stable":
      return addressTarget(rail, rail.address, units);
    case "lightning":
      return await lightningTarget(rail, units);
    case "swap":
      return await swapTarget(rail, units, refundAddress);
    default:
      return null;
  }
}

/**
 * A BOLT11 for exactly this amount, from the recipient's own LNURL-pay endpoint.
 * An invoice cannot be open-ended, and the endpoint states its own bounds, so an
 * amount outside them produces nothing rather than an invoice the payer's wallet
 * would reject at the last step.
 *
 * LNURL guarantees only that the callback returned a BOLT11 string — never that
 * the invoice is for the amount that was asked for. The figure that leaves the
 * payer's wallet is the one written INSIDE the invoice, so it is decoded and
 * compared here, exactly as the wallet's own send path does
 * (ArkadeLightningSendService). A mismatched, amountless, expired or undecodable
 * invoice is not shown at all: the alternative is a stranger scanning a QR for a
 * larger amount than the page displays.
 */
async function lightningTarget(
  rail: Extract<PayRail, { kind: "lightning" }>,
  amountSats: bigint | null,
): Promise<PayTarget | null> {
  // Sats are this rail's base unit, so the integer already IS the figure.
  if (amountSats === null || amountSats <= 0n || amountSats > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  const requested = Number(amountSats);
  const params = await resolveLnurlPayRequest(rail.lightningAddress);
  const msats = requested * MSATS_PER_SAT;
  if (msats < params.minSendableMsats || msats > params.maxSendableMsats) return null;
  const invoice = await requestLnurlInvoice(params.callback, requested);
  if (!invoice) return null;

  let facts: ReturnType<typeof decodeBolt11Facts>;
  try {
    // Throws on a zero, missing or sub-sat amount, so an open invoice never
    // reaches the comparison below.
    facts = decodeBolt11Facts(invoice);
  } catch {
    return null;
  }
  if (facts.amountSats !== requested) return null;
  const expiresAtMs = facts.expiresAt * 1000;
  // An invoice that has already expired is not payable; the payer would only
  // find out in their own wallet, after scanning.
  if (expiresAtMs <= Date.now()) return null;

  // A BOLT11 already states its own amount, so the QR is the invoice itself.
  return {
    kind: "invoice",
    value: invoice,
    uri: invoice,
    asset: rail.source,
    amount: amountSats.toString(),
    decimals: 0,
    expiresAtMs,
    trackTxId: null,
  };
}

/**
 * A deposit address the payer funds from any wallet, settling into the rail the
 * recipient can use.
 *
 * Fail-closed on the refund address: a stranger's swap that fails has nowhere to
 * return the funds unless they named one, and a swap whose refund would be lost
 * must not be created at all. The server may still refuse the pair — no route is
 * a legitimate answer here, not an error to surface.
 *
 * "Named one" means a real EVM address, checked here the way
 * `StableToBtcSwapService` checks its own. This is the last gate before an order
 * exists: after it, a typo is a refund destination the payer does not control,
 * discovered only once the swap has failed and the money is already gone.
 */
async function swapTarget(
  rail: Extract<PayRail, { kind: "swap" }>,
  amountUnits: bigint | null,
  refundAddress?: string,
): Promise<PayTarget | null> {
  const refund = String(refundAddress || "").trim();
  if (!refund || !isValidEvmAddress(refund)) return null;
  if (amountUnits === null || amountUnits <= 0n) return null;
  const decimals = paySourceDecimals(rail.source);

  const request = {
    from: rail.from,
    to: rail.to,
    settleTarget: rail.settleTarget,
    amount: formatBaseUnits(amountUnits, decimals),
    side: "deposit" as const,
    refundAddress: refund,
    owner: refund,
    capabilities: ["send_asset"],
  };
  const intentKey = payOrderKey(`intent:${JSON.stringify(request)}`);
  let commitRequest = await getCacheValue<Parameters<typeof commitSwapKitV2>[0]>(intentKey);
  if (!commitRequest) {
    const quote = await quoteSwapKitV2(request);
    const option = quote.options.find(
      (candidate) =>
        candidate.requiredCapabilities.length === 1 &&
        candidate.requiredCapabilities[0] === "send_asset",
    );
    if (!option) return null;
    commitRequest = {
      ...request,
      recoveryKey: randomUUID(),
      idempotencyKey: randomUUID(),
      optionId: option.optionId,
      acceptedDepositAmount: option.depositAmount,
      minimumSettleAmount: option.settleAmount,
    };
    // A retry adopts this exact request, even when current quotes have changed.
    await setCacheValue(intentKey, commitRequest);
  }
  const recoveryKey = commitRequest.recoveryKey;
  if (!recoveryKey) throw new Error("Payment order recovery information is missing.");
  const swap = await commitSwapKitV2(commitRequest);
  if (!swap.orderId?.startsWith("ord_")) return null;
  const txId = swap.orderId;
  await setCacheValue(payOrderKey(txId), recoveryKey);
  await setCacheValue(intentKey, null);
  if (isSwapKitV2Terminal(swap) || swap.actions.length !== 1) return null;
  const action = swap.actions[0];
  if (action.kind !== "send_asset" || action.state !== "ready") return null;
  const expiresAtMs = action.deadline ? Date.parse(action.deadline) : null;
  if (expiresAtMs !== null && (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()))
    return null;
  const funding = action.request;
  if (funding.asset !== rail.from || funding.amountSats != null || funding.invoice || funding.memo)
    return null;
  const address = String(funding.to || "").trim();
  if (!isValidEvmAddress(address)) return null;
  const funded = exactBaseUnits(funding.amount as string | number, decimals);
  const cap = exactBaseUnits(commitRequest.acceptedDepositAmount ?? "", decimals);
  if (funded === null || funded <= 0n || cap === null || funded > cap) return null;
  return {
    kind: "address",
    value: address,
    // The deposit is exact-amount, so the amount and the source token go into
    // the QR with it — a scanning wallet is the only thing that can enforce the
    // quote, and this page cannot reconcile an under- or overfunded order.
    uri: swapDepositUri(rail.source, address, funded),
    asset: rail.source,
    amount: funded.toString(),
    decimals,
    // A deposit address has no deadline of its own that this app can read.
    expiresAtMs,
    trackTxId: txId,
  };
}
