import { t } from "../../lib/i18n";
import type { SwapKitV2OrderView } from "../../services/swapkit/SwapKitV2Service";

/** One route leg as the server (or the wallet's own record) describes it. */
export type SwapStatusLeg = {
  leg?: string;
  provider?: string;
  terminal?: boolean;
  status?: string;
};

export type LegOutcome = "done" | "failed" | "refunded" | "stopped" | "running" | "waiting";

const FAILED_STATUSES = new Set(["FAILED", "EXPIRED", "CANCELLED"]);

const upper = (value: unknown): string => String(value ?? "").toUpperCase();

/**
 * What one leg's row says (#1706). A leg that stopped running is "Done" only
 * when it actually completed: its own status says COMPLETED, or it carries none
 * and the order itself completed or is still moving on past it. A stopped leg
 * of an order that ended any other way says how it ended, or "Stopped" when
 * nothing tells which.
 */
export function legOutcome(
  leg: SwapStatusLeg,
  orderStatus: string | undefined,
  isActive: boolean,
): LegOutcome {
  if (leg.terminal !== true) return isActive ? "running" : "waiting";
  const own = upper(leg.status);
  if (own === "COMPLETED") return "done";
  if (own === "REFUNDED") return "refunded";
  if (FAILED_STATUSES.has(own)) return "failed";
  const order = upper(orderStatus);
  if (order === "COMPLETED") return "done";
  if (order === "REFUNDED") return "refunded";
  // A later leg still runs, so this one handed its funds on.
  if (!FAILED_STATUSES.has(order) && order !== "") return "done";
  return "stopped";
}

export function legOutcomeLabel(outcome: LegOutcome): string {
  switch (outcome) {
    case "done":
      return t("screen.SwapStatusSheet.stepDone");
    case "failed":
      return t("screen.SwapStatusSheet.stepFailed");
    case "refunded":
      return t("screen.SwapStatusSheet.stepRefunded");
    case "stopped":
      return t("screen.SwapStatusSheet.stepStopped");
    case "running":
      return t("screen.SwapStatusSheet.stepRunning");
    default:
      return t("screen.SwapStatusSheet.stepWaiting");
  }
}

// The server's closed failure reasons (swapkit contract/status.mjs), in words.
const REASON_COPY: Record<string, string> = {
  provider_rejected: "screen.SwapStatusSheet.reason.providerRejected",
  provider_unreachable: "screen.SwapStatusSheet.reason.providerUnreachable",
  action_expired: "screen.SwapStatusSheet.reason.actionExpired",
  underfunded: "screen.SwapStatusSheet.reason.depositMismatch",
  wrong_asset_funded: "screen.SwapStatusSheet.reason.depositMismatch",
  settlement_timeout: "screen.SwapStatusSheet.reason.settlementTimeout",
  signature_rejected: "screen.SwapStatusSheet.reason.transactionRefused",
  onchain_revert: "screen.SwapStatusSheet.reason.transactionRefused",
  refund_failed: "screen.SwapStatusSheet.reason.refundFailed",
};

/**
 * Why the order ended the way it did, in plain words, for a failed or expired
 * order (#1706). The server's failure record names a reason code, not a
 * message, so the code is put into words; a failed order without a known reason
 * says so instead of showing nothing. Nothing is said about where the money is.
 */
export function failureExplanation(view: SwapKitV2OrderView | null): string | null {
  if (!view) return null;
  const status = upper(view.status);
  if (!FAILED_STATUSES.has(status)) return null;
  const failure = view.failure as { reason?: unknown; message?: unknown } | null | undefined;
  const message = typeof failure?.message === "string" ? failure.message.trim() : "";
  if (message) return message;
  const reasonKey = REASON_COPY[String(failure?.reason ?? "")];
  if (reasonKey) return t(reasonKey);
  // The contract closes EXPIRED only when no funds moved.
  if (status === "EXPIRED" && !failure) return t("screen.SwapStatusSheet.reason.expired");
  return t("screen.SwapStatusSheet.reason.unknown");
}

const SUPPORT_FIELD_MAX = 200;
const field = (value: unknown): string =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SUPPORT_FIELD_MAX);

/**
 * The context a swap support request carries (#1706): order, status, route,
 * providers, the server's failure reason and funds verdict, and the raw
 * provider state. The first line is what the chat shows; the rest goes into
 * the silent diagnostic report. Only server status fields: no addresses,
 * amounts or keys.
 */
export function swapSupportContext(
  orderId: string,
  view: SwapKitV2OrderView | null,
  path: readonly string[],
  legs: readonly SwapStatusLeg[],
): string {
  const failure = view?.failure as { reason?: unknown; funds?: unknown; code?: unknown } | null;
  const providers = legs.map((leg) => field(leg.provider)).filter(Boolean);
  const legStates = legs
    .map(
      (leg, index) => `${index + 1}:${field(leg.status) || (leg.terminal ? "terminal" : "open")}`,
    )
    .join(" ");
  return [
    `Swap ${field(orderId)} ${field(view?.status) || "unknown"}${failure?.reason ? ` ${field(failure.reason)}` : ""}`,
    `Route: ${path.map(field).join(" -> ") || "unknown"}`,
    ...(providers.length ? [`Providers: ${providers.join(", ")}`] : []),
    ...(legStates ? [`Legs: ${legStates}`] : []),
    ...(failure?.reason ? [`Failure reason: ${field(failure.reason)}`] : []),
    ...(failure?.code ? [`Failure code: ${field(failure.code)}`] : []),
    ...(failure?.funds ? [`Funds verdict: ${field(failure.funds)}`] : []),
    ...(view?.rawProviderState ? [`Provider state: ${field(view.rawProviderState)}`] : []),
  ].join("\n");
}
