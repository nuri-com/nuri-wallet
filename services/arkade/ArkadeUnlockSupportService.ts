import { reportErrorToSupport } from "../../lib/support/reportErrorToSupport";
import type { ArkadeReceiveUnlockResult } from "./ArkadeReceiveUnlockService";

// Hardcoded help line (matches the Mercuryo support-report flow); the full error
// goes into the silent diagnostic dump.
const UNLOCK_HELP_MESSAGE = "My payment unlock did not work, please help!";

function isUnlockResult(value: unknown): value is ArkadeReceiveUnlockResult {
  return typeof value === "object" && value !== null && "ok" in value && "errors" in value;
}

/** What the wallet looked like when the run failed — the boarding figures first,
 *  since a sweep that cannot move is what this report is usually about. */
function describeUnlockState(state: ArkadeReceiveUnlockResult["state"]): string {
  return [
    `status=${state.status}`,
    `actionable=${state.actionableCount}/${state.actionableSats}sats`,
    `items=${state.actionableItems.map((item) => `${item.kind}:${item.count}`).join(",") || "none"}`,
    `boarding_pending=${state.boardingPendingCount}`,
    `boarding_sweep_ready=${state.boardingSweepReadyCount}/${state.boardingSweepReadySats}sats`,
    // The rows above are the server's unverified view when this is set — the
    // local wallet never built, so a sweep could not even be attempted.
    state.boardingWalletUnavailable ? "boarding_wallet=unavailable" : null,
    `ln_claimable=${state.lnReceiveClaimableCount}`,
    `vtxo_pending=${state.arkadeWalletPendingVtxoCount}`,
    `detail=${state.detail}`,
    state.lastError ? `last_error=${state.lastError}` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

// Report an Arkade receive-unlock failure to support — opens the support chat and
// sends a silent diagnostic dump instead of surfacing an on-screen error. Accepts
// either a failed unlock result or a thrown error.
export function reportUnlockFailureToSupport(failure: unknown): void {
  let error: unknown = failure;
  if (isUnlockResult(failure)) {
    const detail =
      Array.isArray(failure.errors) && failure.errors.length > 0
        ? failure.errors.join("; ")
        : "unknown";
    // The run already wrote down what it did, step by step, and what the wallet
    // looked like while doing it. Sending only the last error meant a boarding
    // sweep that failed reported one line and nothing about the state it failed
    // in — the dump carries the whole thing, the chat still shows one line.
    error = new Error(
      [
        `Payment Received unlock failed: ${detail}`,
        describeUnlockState(failure.state),
        Array.isArray(failure.logs) && failure.logs.length > 0
          ? `steps:\n${failure.logs.join("\n")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }
  // Fire-and-forget, but guard the promise so a rejected emit/dump can't become
  // an unhandled rejection.
  void reportErrorToSupport({
    error,
    userMessage: UNLOCK_HELP_MESSAGE,
    appSnapshot: { activeTab: "bitcoin" },
  }).catch(() => {});
}
