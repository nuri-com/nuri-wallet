/**
 * The one thing a payer has to pay.
 *
 * Every rail ends here — a boarding address, an arkade address, an EVM address,
 * a BOLT11, a swap's deposit address — so the page renders one component and
 * knows one shape. Phase 2's "connect wallet" toggle changes HOW this is paid,
 * never WHAT: it hangs off this value, so adding it needs no change to the
 * resolver or the rail selector.
 *
 * AMOUNTS ARE INTEGERS HERE, in the asset's smallest unit — sats, or the token's
 * base units. Everything the payer sees and everything the QR encodes is derived
 * from that ONE integer, so the figure on screen and the figure a wallet reads
 * cannot drift apart. A figure that cannot be expressed exactly in those units
 * (more decimals than the asset has, or a float that only round-trips through an
 * exponent) is not rounded into one — it produces no target at all.
 */

import { ARBITRUM_USDC, BASE_EURC, BASE_USDC } from "../../config/network";
import type { PayRail, PaySourceAsset } from "./selectPayRail";

/** Satoshis per bitcoin, as an exponent: BIP-21 states the amount in BTC. */
const BTC_DECIMALS = 8;

type Erc20Token = { address: `0x${string}`; decimals: number; chainId: number };

/**
 * The ERC-20 a source asset IS, on the chain the payer sends it from. Written
 * per source rather than per rail because a swap's deposit sits on the SOURCE
 * chain, not on the recipient's.
 */
const SOURCE_TOKENS: Partial<Record<PaySourceAsset, Erc20Token>> = {
  USDC_BASE: BASE_USDC,
  EURC_BASE: BASE_EURC,
  USDC_ARBITRUM: ARBITRUM_USDC,
};

/**
 * How many smallest units make one of what the payer is sending. The Bitcoin
 * rails count in sats and have no sub-unit, so they are 0.
 */
export function paySourceDecimals(source: PaySourceAsset): number {
  return SOURCE_TOKENS[source]?.decimals ?? 0;
}

/**
 * The figure in the asset's smallest unit, or null when it cannot be said in
 * them exactly.
 *
 * Never float arithmetic: `0.0000005 * 1e6` is `0.5`, and rounding that invents
 * a unit nobody entered — the QR would carry 1 while the page displayed 0. The
 * decimal TEXT is split instead, and anything with more decimals than the asset
 * has is refused rather than truncated. A number that JavaScript only prints in
 * exponent form is refused for the same reason: `1e-7` has no exact reading
 * here, and guessing one is how a payment goes wrong.
 */
export function exactBaseUnits(value: string | number, decimals: number): bigint | null {
  const text = typeof value === "number" ? numberText(value) : String(value ?? "").trim();
  if (!text || !/^\d+(\.\d+)?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) return null;
  const units = BigInt(`${whole}${fraction.padEnd(decimals, "0")}`);
  return units > 0n ? units : null;
}

function numberText(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const text = String(value);
  // Exponent form, or anything else that is not a plain decimal, is refused by
  // the caller's own pattern — this only has to avoid handing it a lie.
  return text;
}

/**
 * The exact figure written out in whole units of the asset, shifted rather than
 * divided so nothing is lost on the way to the page or into a URI. `pad` keeps
 * every decimal place, which BIP-21 wants and a person does not.
 */
export function formatBaseUnits(units: bigint, decimals: number, pad = false): string {
  if (decimals <= 0) return units.toString();
  const digits = units.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals);
  const shown = pad ? fraction : fraction.replace(/0+$/, "");
  return shown ? `${whole}.${shown}` : whole;
}

export type PayTarget = {
  /** An address is copied or scanned; an invoice is paid once and expires. */
  kind: "address" | "invoice";
  /** The bare address or invoice, for address-only consumers. */
  value: string;
  /**
   * What the QR encodes. Same as `value` unless the rail has a URI scheme that
   * can carry the amount too, so the payer never retypes a figure they already
   * entered here. The pay-link copy action uses this exact URI too, preserving
   * the chain, token and amount instead of copying only the bare address.
   */
  uri: string;
  /** SwapKit asset id the payer is sending, for display and for Phase 2. */
  asset: string;
  /**
   * The exact figure to send, in the asset's smallest unit — sats, or the
   * token's base units. Null when open-ended. Held as a string so the one
   * integer the QR was built from is the one the screen prints.
   */
  amount: string | null;
  /** How many of those units make one whole asset; 0 for sats. */
  decimals: number;
  /**
   * When this stops being payable, unix ms — an invoice's own expiry, read off
   * the invoice. Null for an address, which does not go stale. A target past
   * this must not be shown: the payer would find out only in their own wallet,
   * after scanning.
   */
  expiresAtMs: number | null;
  /** Present only for swap rails — the order to poll for arrival. */
  trackTxId: string | null;
};

/**
 * EIP-681, ERC-20 form: the token is the target, the recipient and the amount
 * are its transfer arguments. The amount is already in the token's own base
 * units — a decimal there would be read as a different number.
 */
function erc20Uri(token: Erc20Token, address: string, units: bigint): string {
  return `ethereum:${token.address}@${token.chainId}/transfer?address=${address}&uint256=${units}`;
}

/**
 * The address as the payer's wallet should receive it.
 *
 * A bare address makes the payer retype an amount they already entered here,
 * and retyping an amount is where a payment goes wrong. Both schemes below are
 * the ones this app's own scanner reads (`lib/qr/universalQrParser.ts`), so a
 * nuri wallet scanning a nuri pay link gets the amount filled in too.
 *
 * Rails with no URI scheme (arkade) keep the bare address: inventing a scheme
 * no wallet understands would make the QR unscannable, not smarter.
 */
function addressUri(rail: PayRail, address: string, units: bigint | null): string {
  if (units === null || units <= 0n) return address;

  if (rail.kind === "btc-onchain") {
    // BIP-21 states the amount in BTC, never in sats — and always as a plain
    // decimal, because an exponent form (1e-7) is not a number any wallet
    // parses. The sats integer is shifted, not divided.
    return `bitcoin:${address}?amount=${formatBaseUnits(units, BTC_DECIMALS, true)}`;
  }

  if (rail.kind === "evm-stable") {
    return erc20Uri(rail.asset === "EURC_BASE" ? BASE_EURC : BASE_USDC, address, units);
  }

  return address;
}

/**
 * The swap provider's deposit address as an exact payment request.
 *
 * A swap deposit is an EXACT-amount order: the provider quoted a figure and
 * settles nothing for an underfunded one, while the payer's own wallet is the
 * only thing that can enforce it. So the amount and the token belong in the QR,
 * on the SOURCE chain — the app knows both, because the source asset is the one
 * the payer picked on this page.
 *
 * A source with no URI scheme here keeps the bare address: encoding it as the
 * wrong chain's token would be worse than making the payer read the figure.
 */
export function swapDepositUri(
  source: PaySourceAsset,
  address: string,
  units: bigint | null,
): string {
  if (units === null || units <= 0n) return address;
  const token = SOURCE_TOKENS[source];
  return token ? erc20Uri(token, address, units) : address;
}

export function addressTarget(rail: PayRail, value: string, units: bigint | null): PayTarget {
  return {
    kind: "address",
    value,
    uri: addressUri(rail, value, units),
    asset: rail.source,
    amount: units === null ? null : units.toString(),
    decimals: paySourceDecimals(rail.source),
    expiresAtMs: null,
    trackTxId: null,
  };
}
