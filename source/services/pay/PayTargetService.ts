/**
 * Turning a chosen rail into something a stranger can pay.
 *
 * Direct rails produce a payable value out of the recipient's own public
 * record and create nothing. Lightning is the one exception: the recipient's
 * app receives bitcoin on-chain only, so a Lightning payer funds a SwapKit
 * order (BTC_LN -> BTC) that settles to the recipient's on-chain address — the
 * page shows that order's invoice and follows the order until it lands.
 * Token swaps are paid in-page by the payer's own wallet (PayWalletSwapService).
 *
 * Nothing here reads the payer's wallet: the pay page is opened by strangers.
 */

import { randomUUID } from "expo-crypto";
import { decodeBolt11Facts } from "../../lib/bitcoin/lightning";
import {
  addressTarget,
  exactBaseUnits,
  formatBaseUnits,
  type PayTarget,
  paySourceDecimals,
} from "../../lib/pay/payTarget";
import type { PayRail } from "../../lib/pay/selectPayRail";
import { getCacheValue, setCacheValue } from "../balance/TransactionCacheService";
import {
  asSwapKitV2OrderId,
  commitSwapKitV2,
  getSwapKitV2Status,
  isSwapKitV2Terminal,
  quoteSwapKitV2,
} from "../swapkit/SwapKitV2Service";

const BTC_DECIMALS = 8;

// Pay is opened by strangers without a Nuri wallet. The order's random
// recovery capability is kept in this browser only, under its own namespace.
const payOrderKey = (id: string) => `pay:v2:${id}`;

/** Where a Lightning -> on-chain order stands, from the payer's side of it. */
export type PayOrderStatus = { state: "waiting" | "settled" | "failed" };

/**
 * The order behind a Lightning swap invoice, read once. Anything terminal that
 * is not COMPLETED is a failure: the invoice of a dead order must not be paid.
 */
export async function readPayOrderStatus(orderId: string): Promise<PayOrderStatus> {
  const recoveryKey = await getCacheValue<string>(payOrderKey(orderId));
  if (!recoveryKey) throw new Error("Payment order recovery information is missing.");
  const status = await getSwapKitV2Status(asSwapKitV2OrderId(orderId), { recoveryKey });
  if (isSwapKitV2Terminal(status)) {
    return { state: status.status === "COMPLETED" ? "settled" : "failed" };
  }
  return { state: "waiting" };
}

/**
 * The one payable thing for this rail, or null when the rail cannot produce one.
 * Null is a real answer — the page carries it on the button, never as error text.
 */
export async function buildPayTarget(
  rail: PayRail,
  amount: string | number | null,
  /**
   * `settle`: `amount` is what the RECIPIENT must receive (a link with a fixed
   * amount). Only a swap tells the two apart — Lightning is quoted on the
   * recipient's side; a direct rail sends the same figure it receives.
   */
  side: "deposit" | "settle" = "deposit",
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
      return addressTarget(rail, rail.address, units);
    case "evm-stable":
      return addressTarget(rail, rail.address, units);
    // Any token, any supported chain: the recipient's own address. There is no
    // amount to bind (the token is the payer's choice), so the QR is the bare
    // address; the recipient's found-money sweep converts what arrives.
    case "evm-any":
      return addressTarget(rail, rail.address, null);
    // Paid in-page by the payer's wallet (PayWalletSwapService), never a QR.
    case "wallet-swap":
      return null;
    case "btc-lightning":
      return await lightningSwapTarget(rail, units, side);
    default:
      return null;
  }
}

/**
 * A BOLT11 that pays the recipient ON-CHAIN: a SwapKit order BTC_LN -> BTC
 * settling to the recipient's published bitcoin address, funded by the
 * payer's Lightning wallet.
 *
 * The amount is what the payer sends (deposit side). The order is committed on
 * the exact quote the server returned (quoteId + accepted bounds), and the
 * invoice it hands back is decoded and must state exactly that amount, not be
 * expired, and be the order's only action — otherwise nothing is shown. The
 * recovery key and the commit request are kept in this browser, so a reload
 * adopts the same order instead of creating a second one.
 */
async function lightningSwapTarget(
  rail: Extract<PayRail, { kind: "btc-lightning" }>,
  amountSats: bigint | null,
  side: "deposit" | "settle",
): Promise<PayTarget | null> {
  if (amountSats === null || amountSats <= 0n || amountSats > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  const settleSide = side === "settle";
  const request = {
    from: "BTC_LN",
    to: "BTC",
    amount: formatBaseUnits(amountSats, BTC_DECIMALS),
    side,
    settleTarget: rail.settleTarget,
    // A Lightning payer has no address of their own on this page; the order is
    // owned by a random per-payment id and recovered only with its recoveryKey.
    owner: `pay:${randomUUID()}`,
    capabilities: ["pay_lightning_invoice"],
  };
  const intentKey = payOrderKey(`ln-intent:${rail.settleTarget}:${side}:${request.amount}`);
  let commitRequest = await getCacheValue<Parameters<typeof commitSwapKitV2>[0]>(intentKey);
  if (!commitRequest) {
    const quote = await quoteSwapKitV2(request);
    const sats = (value: string) => exactBaseUnits(value, BTC_DECIMALS);
    const options = quote.options.filter((option) => {
      const deposit = sats(option.depositAmount);
      const settled = sats(option.settleAmount);
      return (
        option.requiredCapabilities.length === 1 &&
        option.requiredCapabilities[0] === "pay_lightning_invoice" &&
        deposit !== null &&
        deposit > 0n &&
        settled !== null &&
        settled > 0n &&
        // Deposit side: the payer sends exactly what they typed. Settle side:
        // the recipient gets at least the link's amount.
        (settleSide ? settled >= amountSats : deposit === amountSats)
      );
    });
    if (options.length === 0) return null;
    // Deposit side: most bitcoin arriving wins. Settle side: least paid wins.
    const best = options.reduce((a, b) =>
      settleSide
        ? sats(b.depositAmount)! < sats(a.depositAmount)!
          ? b
          : a
        : sats(b.settleAmount)! > sats(a.settleAmount)!
          ? b
          : a,
    );
    commitRequest = {
      ...request,
      recoveryKey: `${randomUUID()}${randomUUID()}`.replace(/-/g, ""),
      idempotencyKey: randomUUID(),
      optionId: best.optionId,
      ...(best.quoteId ? { quoteId: best.quoteId } : {}),
      acceptedDepositAmount: best.depositAmount,
      minimumSettleAmount: best.settleAmount,
    };
    await setCacheValue(intentKey, commitRequest);
  }
  const recoveryKey = commitRequest.recoveryKey;
  if (!recoveryKey) throw new Error("Payment order recovery information is missing.");
  let order: Awaited<ReturnType<typeof commitSwapKitV2>>;
  try {
    order = await commitSwapKitV2(commitRequest);
  } catch (error) {
    // A lost response is retried with this exact request (same idempotency
    // key); a quote the server no longer honours is dropped for a fresh one.
    if (/expired|new quote/i.test(String((error as Error)?.message ?? error))) {
      await setCacheValue(intentKey, null);
    }
    throw error;
  }
  // A commit that did not produce an order is dropped, so the next try quotes afresh.
  if (!order.orderId?.startsWith("ord_")) {
    await setCacheValue(intentKey, null);
    return null;
  }
  await setCacheValue(payOrderKey(order.orderId), recoveryKey);
  await setCacheValue(intentKey, null);
  if (isSwapKitV2Terminal(order) || order.actions.length !== 1) return null;
  const action = order.actions[0];
  if (!action || action.kind !== "pay_lightning_invoice" || action.state !== "ready") return null;
  const invoice = String(action.request.invoice || "").trim();
  if (!invoice) return null;

  let facts: ReturnType<typeof decodeBolt11Facts>;
  try {
    facts = decodeBolt11Facts(invoice);
  } catch {
    return null;
  }
  // The figure that leaves the payer's wallet is the one inside the invoice:
  // what they typed, or on a fixed link the deposit the accepted quote named.
  const expectedSats = settleSide
    ? exactBaseUnits(commitRequest.acceptedDepositAmount ?? "", BTC_DECIMALS)
    : amountSats;
  if (expectedSats === null || BigInt(facts.amountSats) !== expectedSats) return null;
  const invoiceExpiry = facts.expiresAt * 1000;
  const deadline = action.deadline ? Date.parse(action.deadline) : Number.NaN;
  const expiresAtMs = Number.isFinite(deadline) ? Math.min(invoiceExpiry, deadline) : invoiceExpiry;
  if (expiresAtMs <= Date.now()) return null;

  return {
    kind: "invoice",
    value: invoice,
    uri: invoice,
    asset: "BTC_LN",
    amount: expectedSats.toString(),
    decimals: 0,
    expiresAtMs,
    trackOrderId: order.orderId,
  };
}
