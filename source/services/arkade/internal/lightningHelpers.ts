// Internal lightning helpers — invoice-prefix and expiry assertions, shared by
// prod-tier and debug-tier arkade code. Limits and claim polling were removed
// with Boltz (see note below).
import type { Network } from "./legacySwapTypes";

export type ArkadeLightningLimits = {
  network: Network;
  minSwapSats: number;
  maxSwapSats: number;
};

function parseInvoicePrefix(invoice: string): string {
  const raw = String(invoice || "")
    .trim()
    .toLowerCase();
  const known = raw.match(/^(lnbcrt|lntbs|lntb|lnbc)/);
  if (known?.[1]) return known[1];
  const sep = raw.indexOf("1");
  if (sep <= 0) return "";
  return raw.slice(0, sep);
}

function expectedInvoicePrefixes(network: Network): string[] {
  switch (network) {
    case "bitcoin":
      return ["lnbc"];
    case "testnet":
      return ["lntb"];
    case "signet":
      return ["lntbs", "lntb"];
    case "mutinynet":
      return ["lntbs"];
    case "regtest":
      return ["lnbcrt"];
    default:
      return [];
  }
}

export function assertInvoicePrefixForNetwork(
  invoice: string,
  network: Network,
  op: "create" | "pay",
): string {
  const prefix = parseInvoicePrefix(invoice);
  if (!prefix) {
    throw new Error(`${op} invoice missing prefix`);
  }
  const expected = expectedInvoicePrefixes(network);
  if (expected.length > 0 && !expected.includes(prefix)) {
    throw new Error(
      `${op} invoice network mismatch prefix=${prefix} expected=${expected.join("|")} network=${network}`,
    );
  }
  return prefix;
}

export { parseInvoicePrefix };

// getOnchainProbeUrl/getOnchainEsploraUrl fed the deleted Boltz claim path only.

// Removed with Boltz: getArkToBtcMinimumReceiveSats, claimArkToBtcSwapWithPolling
// and getLightningLimitsInternal drove the Boltz swap API (getFees, getSwapStatus,
// claimBtc). Boltz is shut down so those endpoints never answer; the helpers were
// reachable only from the debug lab. Lightning send runs through SwapKit now.

export const LIGHTNING_FUNDING_EXPIRY_MARGIN_SEC = 60;

/**
 * Refuse an invoice that has expired, or is too close to expiry to be paid,
 * at the moment the money would move. Route creation, the server intent and the
 * passkey approval all happen between the first check and this one.
 */
/**
 * Refuses to fund once the payee's own pay-by moment has passed: a remit
 * corridor fails a payout funded after its price hold, though the invoice
 * itself still settles.
 */
export function assertPayeeStillHolding(
  payBy: number | null | undefined,
  nowMs: number = Date.now(),
): void {
  if (payBy != null && nowMs > payBy) {
    throw new Error("payee price hold has ended; get a new price");
  }
}

/**
 * The payee's pay-by moment as the SDK send deadline (`validUntil`, whole
 * UNIX seconds, refused at or after it). Rounded down, so it never ends later
 * than the hold. Undefined when the payee states none.
 */
export function sendDeadlineSeconds(payBy: number | null | undefined): number | undefined {
  if (payBy == null || !Number.isFinite(payBy)) return undefined;
  return Math.max(1, Math.floor(payBy / 1000));
}

export function assertInvoiceStillPayable(expiresAt: number, nowMs: number = Date.now()): void {
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return;
  const secondsLeft = expiresAt - nowMs / 1000;
  if (secondsLeft <= 0) {
    throw new Error("lightning invoice has expired");
  }
  if (secondsLeft < LIGHTNING_FUNDING_EXPIRY_MARGIN_SEC) {
    throw new Error("lightning invoice expires too soon to be paid");
  }
}
