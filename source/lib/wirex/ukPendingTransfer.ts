// A UK payment that may have gone without a confirmation. The server keeps
// one per wallet and refuses the next UK payment until the bank feed settles
// it; this device keeps its own record too, written before the payment is
// sent, so a send whose answer was lost (or an app killed mid-send) blocks the
// next one even before the server has an answer to give.
//
// The device record is released only by the server's word on that payment:
// sent or not sent (settled from Wirex's own record, never by time), or
// unknown, meaning the server never started it. Unknown releases only once the
// signed request is older than the five minutes the server accepts it for, so
// a request still on its way can no longer start it.
//
// Import-free so it is unit-testable without the Wirex service.

export const UK_PENDING_HOLD_MS = 6 * 60 * 1000;

/** The server's code for "an earlier UK payment may have gone". */
export const UK_TRANSFER_UNCONFIRMED_CODE = "uk_transfer_unconfirmed";

export type UkPendingMarker = {
  estimationId: string;
  amount: number;
  /** Epoch ms when the payment was sent. */
  at: number;
};

export function ukPendingKeyFor(wallet: string): string {
  return `wirex:uk:pending:v1:${wallet.toLowerCase()}`;
}

export function serializeUkPendingMarker(marker: UkPendingMarker): string {
  return JSON.stringify(marker);
}

// Anything unreadable still holds: it was written for a payment that may have
// gone, so it is dated now. The caller writes the dated record back
// (ukPendingMarkerNeedsRewrite), so its age counts from the first read.
export function parseUkPendingMarker(
  raw: string | null | undefined,
  now: number,
): UkPendingMarker | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<UkPendingMarker>;
    const at = Number(parsed?.at);
    return {
      estimationId: String(parsed?.estimationId ?? ""),
      amount: Number(parsed?.amount) || 0,
      at: Number.isFinite(at) && at > 0 ? at : now,
    };
  } catch {
    return { estimationId: "", amount: 0, at: now };
  }
}

/** How the server says a UK payment ended. */
export type UkTransferOutcome = "sent" | "not_sent" | "unconfirmed" | "unknown";

export type UkServerAnswer = {
  /** The server holds an unconfirmed UK payment for this wallet. */
  pending: boolean;
  /** How the device's own payment ended, when it was asked about one. */
  outcome: UkTransferOutcome | null;
};

export function parseUkTransferOutcome(value: unknown): UkTransferOutcome | null {
  return value === "sent" || value === "not_sent" || value === "unconfirmed" || value === "unknown"
    ? value
    : null;
}

/** A record read with a fallback date: written back so the date sticks. */
export function ukPendingMarkerNeedsRewrite(
  raw: string | null | undefined,
  marker: UkPendingMarker | null,
): boolean {
  return marker !== null && raw?.trim() !== serializeUkPendingMarker(marker);
}

/**
 * Whether sending to a UK account is held, from this device's record and the
 * server's answer (null: the server could not be asked).
 */
export function ukSendHeld(
  marker: UkPendingMarker | null,
  server: UkServerAnswer | null,
  now: number,
): boolean {
  if (server === null) return marker !== null;
  if (server.pending) return true;
  if (!marker) return false;
  if (server.outcome === "sent" || server.outcome === "not_sent") return false;
  // Only the server's explicit word that it never started it ages out; no answer
  // about this payment (an older server, a partial reply) keeps it. A record too
  // damaged to name its payment cannot be asked about: with nothing pending on
  // the server for this wallet, it ages out the same way.
  if (marker.estimationId && server.outcome !== "unknown") return true;
  return now - marker.at < UK_PENDING_HOLD_MS;
}

// The server's refusals that come before Wirex is called: the quote, the
// signature, or this server's own record of UK payments.
const REFUSED_BEFORE_SENDING = [
  "uk_transfer_quote_expired",
  "uk_transfer_quote_not_for_this_wallet",
  "ts_missing_or_stale",
  "invalid_signature",
  "signature_does_not_match_wallet",
  "signature_replayed",
  "uk_transfer_state_invalid",
];

/**
 * A send's failure that proves nothing went: Wirex refused it outright, or the
 * server refused it before calling Wirex. Every other answer, including one
 * this list does not know, may hide a payment that went.
 */
export function ukSendFailedForSure(serverErrorCode: string | null): boolean {
  if (serverErrorCode == null) return false;
  if (serverErrorCode.startsWith("wirex_uk_transfer_failed:")) return true;
  return REFUSED_BEFORE_SENDING.some((code) => serverErrorCode.startsWith(code));
}
