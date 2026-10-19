import type { SwapKitV2OrderView } from "./SwapKitV2Service";
import {
  SWAPKIT_V2_ACTION_KINDS,
  SWAPKIT_V2_TERMINAL_STATUSES,
  SwapKitV2Error,
} from "./SwapKitV2Service";
import { isRefusedBeforeBroadcast } from "./SwapKitV2ActionService";

const SAFE_TOKEN = /[^a-z0-9_.:-]+/g;
const KNOWN_KINDS: ReadonlySet<string> = new Set(SWAPKIT_V2_ACTION_KINDS);
// Order lifecycle statuses the app knows. Any other value is logged as
// "unknown": a provider-carried status could hold an invoice, address or key.
const KNOWN_STATUSES: ReadonlySet<string> = new Set([
  "COMMITTING",
  "COMMITTED",
  "AWAITING_ACTION",
  "FUNDED",
  "IN_FLIGHT",
  "PROCESSING",
  "SETTLING",
  ...SWAPKIT_V2_TERMINAL_STATUSES,
]);

function token(value: unknown, fallback: string): string {
  const safe = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(SAFE_TOKEN, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return safe || fallback;
}

/**
 * Public-safe context for the one-line support diagnostic emitted when a v2
 * tracker stops. Never includes Error.message or action request data: either
 * may contain an invoice, address, provider body, signature or recovery key.
 */
export function formatV2TrackingFailureDiagnostic(
  error: unknown,
  view: SwapKitV2OrderView | null | undefined,
): string {
  const typed = error instanceof SwapKitV2Error ? error : null;
  const failureClass = typed?.code
    ? token(typed.code, "swapkit_v2_error")
    : typed?.httpStatus
      ? `http_${typed.httpStatus}`
      : token((error as { name?: unknown } | null | undefined)?.name, "unexpected_error");
  // The view may be the malformed response that stopped the tracker.
  const actions: unknown[] = Array.isArray(view?.actions) ? view.actions : [];
  const action = actions.find(
    (candidate): candidate is { kind?: unknown; state?: unknown } =>
      typeof candidate === "object" &&
      candidate !== null &&
      ((candidate as { state?: unknown }).state === "ready" ||
        (candidate as { state?: unknown }).state === "blocked"),
  );
  // Only known kinds are logged: an unknown "kind" may carry an invoice or address.
  const kind = KNOWN_KINDS.has(String(action?.kind))
    ? String(action?.kind)
    : action
      ? "unknown"
      : "none";
  const sideEffect = isRefusedBeforeBroadcast(error)
    ? "none"
    : typed?.code === "unsupported_action_kind"
      ? "none"
      : typed?.code === "action_reconciliation_required"
        ? "possible"
        : "unknown";

  return [
    `class=${failureClass}`,
    `http=${typed?.httpStatus || 0}`,
    `status=${KNOWN_STATUSES.has(String(view?.status ?? "").toUpperCase()) ? String(view?.status).toLowerCase() : "unknown"}`,
    `action=${kind}`,
    `action_state=${token(action?.state, "none")}`,
    `side_effect=${sideEffect}`,
  ].join(" ");
}
