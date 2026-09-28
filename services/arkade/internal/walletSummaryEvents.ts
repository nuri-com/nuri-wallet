// Listener registry for wallet-summary load events. Lives in internal/ so the
// loader (./walletSummary) can notify receive-flow modules (./receiveAutoClaim,
// ./receiveAutoSweep) WITHOUT importing them — those modules used to be
// imported back into walletSummary.ts, which formed an intra-internal cycle
// flagged on PR #546. Receive modules now register themselves at module load
// (top-level), and the loader just emits.
//
// Importing types is fine (zero-runtime); importing the receive modules from
// here would re-introduce the cycle, so don't.
import type { ArkadeWalletSummary, ArkadeWalletSummaryOptions } from "../types/wallet";

export type ArkadeWalletSummaryLoadedListener = (
  summary: ArkadeWalletSummary,
  options: ArkadeWalletSummaryOptions,
) => void;

const listeners: Set<ArkadeWalletSummaryLoadedListener> = new Set();

export function addArkadeWalletSummaryListener(listener: ArkadeWalletSummaryLoadedListener): void {
  listeners.add(listener);
}

export function removeArkadeWalletSummaryListener(
  listener: ArkadeWalletSummaryLoadedListener,
): void {
  listeners.delete(listener);
}

export function emitArkadeWalletSummaryLoaded(
  summary: ArkadeWalletSummary,
  options: ArkadeWalletSummaryOptions,
): void {
  for (const listener of listeners) {
    try {
      listener(summary, options);
    } catch (err: unknown) {
      console.error("[ArkadeWalletSummary] listener threw:", err);
    }
  }
}
