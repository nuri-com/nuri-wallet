// Eager resume for persisted Boltz swaps. The SDK persists outgoing submarine
// swaps before funding, and its SwapManager autostart reloads them on
// lightning init — but that init normally happens lazily on the first
// send/receive flow. After an app restart with a non-final persisted swap,
// kick the init from the wallet-summary listener so settlement/refund
// monitoring resumes without waiting for user interaction.
import { getCachedArkadeLightning, getOrCreateLightning } from "./lightningCache";
import { emitTrace } from "./logging";
import { hasPersistedNonFinalArkadeSwaps } from "./storageAdapter";
import { truncateForLog } from "./utils";
import { addArkadeWalletSummaryListener } from "./walletSummaryEvents";

const ARKADE_OUTGOING_SWAP_RESUME_RETRY_MS = 60_000;

let resumeDone = false;
let resumeInFlight: Promise<void> | null = null;
let lastAttemptAtMs = 0;

addArkadeWalletSummaryListener(() => {
  scheduleArkadeOutgoingSwapResumeImpl("wallet_summary");
});

export function scheduleArkadeOutgoingSwapResumeImpl(reason: string): void {
  if (resumeDone || resumeInFlight) return;
  if (getCachedArkadeLightning()) {
    // Lightning already initialized this session — the SwapManager autostart
    // has loaded the persisted swaps.
    resumeDone = true;
    return;
  }
  const now = Date.now();
  if (now - lastAttemptAtMs < ARKADE_OUTGOING_SWAP_RESUME_RETRY_MS) return;
  lastAttemptAtMs = now;
  const run = (async () => {
    if (!(await hasPersistedNonFinalArkadeSwaps())) {
      resumeDone = true;
      emitTrace({
        atMs: Date.now(),
        op: "ln_swap_resume",
        status: "skip",
        detail: `reason=${reason} why=no_non_final_persisted_swaps`,
      });
      return;
    }
    emitTrace({
      atMs: Date.now(),
      op: "ln_swap_resume",
      status: "attempt",
      detail: `reason=${reason} expected_next=swap_manager_autostart`,
    });
    await getOrCreateLightning();
    resumeDone = true;
    emitTrace({
      atMs: Date.now(),
      op: "ln_swap_resume",
      status: "ok",
      detail: `reason=${reason}`,
    });
  })().catch((error: unknown) => {
    emitTrace({
      atMs: Date.now(),
      op: "ln_swap_resume",
      status: "failed",
      detail: `reason=${reason} err=${truncateForLog(
        error instanceof Error ? error.message : String(error || "unknown"),
        170,
      )}`,
    });
  });
  resumeInFlight = run;
  void run.finally(() => {
    if (resumeInFlight === run) {
      resumeInFlight = null;
    }
  });
}

export function resetArkadeOutgoingSwapResumeState(): void {
  resumeDone = false;
  resumeInFlight = null;
  lastAttemptAtMs = 0;
}
