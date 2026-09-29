/**
 * Turning a chosen rail into something a stranger can pay.
 *
 * Every rail here produces a payable value out of the recipient's own public
 * record and creates nothing. Swaps are paid in-page by the payer's own wallet
 * (PayWalletSwapService), never through a deposit address from this file.
 *
 * Nothing here reads the payer's wallet: the pay page is opened by strangers,
 * and Phase 1 hands them an address or an invoice to pay from wherever they
 * already hold the asset.
 */

import { decodeBolt11Facts } from "../../lib/bitcoin/lightning";
import {
  addressTarget,
  exactBaseUnits,
  type PayTarget,
  paySourceDecimals,
} from "../../lib/pay/payTarget";
import type { PayRail } from "../../lib/pay/selectPayRail";
import { requestLnurlInvoice, resolveLnurlPayRequest } from "../bitcoin/LnurlService";

const MSATS_PER_SAT = 1000;

/**
 * The one payable thing for this rail, or null when the rail cannot produce one.
 * Null is a real answer — the page carries it on the button, never as error text.
 */
export async function buildPayTarget(
  rail: PayRail,
  amount: string | number | null,
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
    // Any token, any supported chain: the recipient's own address. There is no
    // amount to bind (the token is the payer's choice), so the QR is the bare
    // address; the recipient's found-money sweep converts what arrives.
    case "evm-any":
      return addressTarget(rail, rail.address, null);
    // Paid in-page by the payer's wallet (PayWalletSwapService), never a QR.
    case "wallet-swap":
      return null;
    case "lightning":
      return await lightningTarget(rail, units);
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
  };
}
