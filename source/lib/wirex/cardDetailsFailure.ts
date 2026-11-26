// lib/wirex/cardDetailsFailure.ts
// Why a card-details reveal failed, as one short, non-sensitive reason (#1448).
//
// The result poll used to surface only `GET /card/details/result failed: error`:
// no HTTP status, no step, nothing to tell a refusal from a dropped connection.
// The server now names the failed Wirex step (`wirex_card_details_failed:
// <step>:http_<status>[:<reason>]`, banking-nuri-com #280); this module keeps that
// code, adds the HTTP status of the poll itself, and classifies transport
// failures, so support dumps carry a concrete cause.
//
// SECURITY: the reason never carries the payload. Only documented values are
// kept, from allowlists: the server's step names (server-wirex-aa card-details
// steps), Wirex's `error_reason` codes, and the bare/terminal codes the result
// route answers with. One `http_<status>` segment is allowed, only in its
// documented position. A code outside the allowlists, even one shaped like an
// identifier (an alphabetic token, base64url of a PAN), becomes
// `unrecognized`; an unknown reason after a known step+status is dropped to
// `unrecognized` while the step and status are kept. Free text (which could
// echo a URL, a body or card data) is never copied.

/** Consecutive transport failures of the read-only result poll that are retried. */
export const CARD_DETAILS_RESULT_TRANSIENT_RETRIES = 2;

const STEP_PREFIX = "wirex_card_details_failed";
const HTTP_SEGMENT = /^http_[1-5]\d{2}$/;

/** Steps of the card-details reveal, as the server names them (banking #280). */
const KNOWN_STEPS = new Set([
  "get_user",
  "issue_user_scoped_token",
  "issue_action_token",
  "get_card",
  "get_card_details",
  "get_card_cvv",
  "unknown_step",
]);

/** Wirex `error_reason` / `code` values a refused step may carry. */
const KNOWN_REASONS = new Set([
  "ErrorGeneral",
  "ErrorNotFound",
  "ErrorForbidden",
  "ErrorUnauthorized",
  "ErrorValidation",
  "ErrorBadRequest",
  "ErrorInvalidRequest",
  "ErrorTooManyRequests",
  "ErrorInternal",
  "SignatureInvalid",
  "InvalidSignature",
  "TokenExpired",
  "ActionTokenExpired",
  "CardBlocked",
  "CardNotFound",
  "CardNotActive",
  "card_blocked",
  "invalid_user_id",
  "unauthorized",
  "forbidden",
  "not_found",
]);

/** Whole codes without a status: envelope fallbacks and terminal statuses. */
const KNOWN_BARE_CODES = new Set([
  STEP_PREFIX,
  "error",
  "failed",
  "declined",
  "rejected",
  "denied",
  "expired",
  "cancelled",
  "canceled",
  "session_expired",
  "session_not_found",
  "not_approved",
  "unauthorized",
  "forbidden",
  "not_found",
]);

/**
 * The code itself when every part is a documented value, else `unrecognized`.
 *
 * Two shapes only:
 * - a bare code from KNOWN_BARE_CODES (`error`, `declined`, ...);
 * - `wirex_card_details_failed:<known step>:http_<status>[:<reason>]`, the
 *   reason kept only when it is a known Wirex code (else `unrecognized`).
 */
export function safeCardDetailsCode(code: string): string {
  const trimmed = code.trim();
  if (KNOWN_BARE_CODES.has(trimmed)) return trimmed;
  const segments = trimmed.split(":");
  if (segments.length !== 3 && segments.length !== 4) return "unrecognized";
  const [prefix, step, status, reason] = segments;
  if (prefix !== STEP_PREFIX || !KNOWN_STEPS.has(step) || !HTTP_SEGMENT.test(status)) {
    return "unrecognized";
  }
  const base = `${STEP_PREFIX}:${step}:${status}`;
  if (reason === undefined) return base;
  return `${base}:${KNOWN_REASONS.has(reason) ? reason : "unrecognized"}`;
}

/** No answer reached us: offline, DNS, TLS, aborted or timed out. */
export function isCardDetailsTransportFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return true;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("network request failed") ||
    msg.includes("failed to fetch") ||
    msg.includes("network error") ||
    // Firefox: "NetworkError when attempting to fetch resource."
    msg.includes("networkerror") ||
    msg.includes("fetch failed") ||
    msg.includes("load failed") ||
    msg.includes("timed out") ||
    msg.includes("timeout")
  );
}

export type CardDetailsFailureInput =
  | { kind: "refused"; code: string; httpStatus?: number | null }
  | { kind: "terminal_status"; status: string }
  | { kind: "still_pending"; attempts: number }
  | { kind: "transport" }
  | { kind: "non_json"; httpStatus?: number | null }
  | { kind: "no_data" }
  | { kind: "unknown" };

function httpPart(status?: number | null): string {
  return typeof status === "number" && Number.isFinite(status) ? `:http_${status}` : "";
}

/** `card_details_result:<class>[:http_<status>][:<server code>]` */
export function cardDetailsFailureReason(input: CardDetailsFailureInput): string {
  const prefix = "card_details_result";
  switch (input.kind) {
    case "refused":
      return `${prefix}:refused${httpPart(input.httpStatus)}:${safeCardDetailsCode(input.code)}`;
    case "terminal_status":
      return `${prefix}:terminal_status:${safeCardDetailsCode(input.status)}`;
    case "still_pending":
      return `${prefix}:still_pending:${input.attempts}`;
    case "transport":
      return `${prefix}:transport`;
    case "non_json":
      return `${prefix}:non_json${httpPart(input.httpStatus)}`;
    case "no_data":
      return `${prefix}:no_data`;
    default:
      return `${prefix}:unknown`;
  }
}
