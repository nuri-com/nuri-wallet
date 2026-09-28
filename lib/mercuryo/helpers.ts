// Mercuryo status/log helpers. Deliberately free of side effects and of any
// react-native or expo import, so the background tracker and its tests can use
// them without pulling in a browser module (see ./checkoutBrowser).
import { SATS_PER_BTC } from "../bitcoin/convert";

const MERCURYO_FLOW_LOG_PREFIX = "[MercuryoFlow][Mercurio]";

export const normalizeMtid = (value: unknown): string =>
  String(value || "")
    .trim()
    .toLowerCase();

export const mercuryoFlowLog = (event: string, payload?: Record<string, unknown>) => {
  try {
    if (payload && Object.keys(payload).length > 0) {
      console.log(`${MERCURYO_FLOW_LOG_PREFIX} ${event}`, payload);
      return;
    }
    console.log(`${MERCURYO_FLOW_LOG_PREFIX} ${event}`);
  } catch {}
};

export const safeUrlForLog = (rawUrl: string) => {
  const raw = String(rawUrl || "").trim();
  if (!raw) return "";
  if (raw === "about:blank") return raw;
  try {
    // @ts-ignore
    const u = new URL(raw);
    const safeParams = new URLSearchParams();
    const mtid =
      u.searchParams.get("merchant_transaction_id") ||
      u.searchParams.get("merchantTransactionId") ||
      "";
    if (mtid) safeParams.set("merchant_transaction_id", `${mtid.slice(0, 12)}…`);
    const status = u.searchParams.get("status") || "";
    if (status) safeParams.set("status", status.slice(0, 24));
    const q = safeParams.toString();
    return `${u.origin}${u.pathname}${q ? `?${q}` : ""}`;
  } catch {
    const noQuery = raw.split("?")[0];
    return noQuery.length > 140 ? `${noQuery.slice(0, 140)}…` : noQuery;
  }
};

export const normalizeMercuryoStatus = (value: unknown): string =>
  String(value || "")
    .trim()
    .toLowerCase();

export const isMercuryoPaidStatus = (status: string): boolean =>
  status === "paid" || status === "completed" || status === "success";

export const isMercuryoFailedStatus = (status: string): boolean =>
  status === "failed" ||
  status === "order_failed" ||
  status === "payment_failed" ||
  status === "verification_failed" ||
  status === "declined" ||
  status === "decline" ||
  status === "card_declined" ||
  status === "kyc_failed" ||
  status === "aml_failed" ||
  status === "chargeback" ||
  status === "refunded" ||
  status === "error" ||
  status === "rejected" ||
  status === "expired" ||
  status === "order_expired";

export const isMercuryoCancelledStatus = (status: string): boolean =>
  status === "cancelled" ||
  status === "canceled" ||
  status === "order_cancelled" ||
  status === "order_canceled";

export const getMercuryoFailureExplanation = (
  status: string,
  _failureReason?: string,
  paymentMethod?: string,
): string => {
  const normalized = normalizeMercuryoStatus(status);
  const method = String(paymentMethod || "")
    .trim()
    .toLowerCase();

  if (
    normalized === "order_failed" ||
    normalized === "payment_failed" ||
    normalized === "declined" ||
    normalized === "decline" ||
    normalized === "card_declined" ||
    normalized === "failed"
  ) {
    const via = method === "apple" || method === "applepay" ? " in Apple Pay" : "";
    return `Your card was rejected by your bank${via}. Try a different card or try again.`;
  }
  if (normalized === "verification_failed" || normalized === "kyc_failed") {
    return "Identity verification was not completed. Please try again.";
  }
  if (normalized === "expired" || normalized === "order_expired") {
    return "Payment session expired. Please try again.";
  }
  if (normalized === "cancelled" || normalized === "canceled") {
    return "Payment was cancelled. No charge was made.";
  }
  return "Payment failed. Please try again with a different card.";
};

export const parseSatsFromMercuryoItem = (raw: unknown): number | undefined => {
  if (!raw || typeof raw !== "object") return undefined;
  const item = raw as Record<string, unknown>;
  const directCandidates = [
    item?.cryptoAmountSats,
    item?.crypto_amount_sats,
    item?.amountSats,
    item?.amount_sats,
  ];
  for (const raw of directCandidates) {
    const n = Number(raw ?? 0);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  const btcCandidates = [
    item?.cryptoAmount,
    item?.crypto_amount,
    item?.cryptoAmountBtc,
    item?.crypto_amount_btc,
    item?.amountBtc,
    item?.amount_btc,
  ];
  for (const raw of btcCandidates) {
    if (raw == null) continue;
    const normalized = String(raw).trim().replace(",", ".");
    const btcVal = Number(normalized);
    if (!Number.isFinite(btcVal) || btcVal <= 0) continue;
    const sats = Math.round(btcVal * SATS_PER_BTC);
    if (Number.isFinite(sats) && sats > 0) return sats;
  }
  return undefined;
};

export const parseFailureReason = (raw: unknown): string | undefined => {
  if (!raw || typeof raw !== "object") return undefined;
  const item = raw as Record<string, unknown>;
  const candidates = [
    item?.failureReason,
    item?.failure_reason,
    item?.declineReason,
    item?.decline_reason,
    item?.reason,
    item?.errorMessage,
    item?.error_message,
    item?.statusDescription,
    item?.status_description,
    item?.message,
    (item?.error as { message?: unknown } | undefined)?.message,
  ];
  for (const raw of candidates) {
    const value = String(raw || "").trim();
    if (value) return value;
  }
  return undefined;
};
