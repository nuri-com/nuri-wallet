// Reverse-swap claim machinery for the Arkade receive flow: status helpers,
// SDK reach-in shapes, and the persist/watch/direct-claim primitives.
import { emitArkadeReceiveUnlockProgress } from "./receiveUpdatedEvents";
import { logArkadeWalletSignTrace } from "./logging";
import { errorMessageText, truncateForLog } from "./utils";
import type { ArkadeLightning } from "./types";

const ARKADE_LN_RECEIVE_CLAIM_TIMEOUT_MS = 120_000;
const ARKADE_LN_RECEIVE_CLAIM_WATCHDOG_MS = 12_000;

export function isReverseFinalStatus(status: string): boolean {
  return isReverseSuccessfulFinalStatus(status) || isReverseFailedFinalStatus(status);
}

export function isReverseSuccessfulFinalStatus(status: string): boolean {
  const normalized = String(status || "")
    .trim()
    .toLowerCase();
  return normalized === "invoice.settled";
}

export function isReverseFailedFinalStatus(status: string): boolean {
  const normalized = String(status || "")
    .trim()
    .toLowerCase();
  return ["transaction.refunded", "transaction.failed", "invoice.expired", "swap.expired"].includes(
    normalized,
  );
}

export function isReverseClaimableStatus(status: string): boolean {
  const normalized = String(status || "")
    .trim()
    .toLowerCase();
  return normalized === "transaction.mempool" || normalized === "transaction.confirmed";
}

export function isDuplicateOffchainClaimError(error: unknown): boolean {
  const msg = errorMessageText(error).toLowerCase();
  return (
    msg.includes("duplicate") ||
    msg.includes("already claimed") ||
    msg.includes("already settled") ||
    msg.includes("invoice already paid") ||
    msg.includes("vhtlc is already spent") ||
    (msg.includes("vhtlc") && msg.includes("already spent"))
  );
}

// Minimal SDK reach-in shapes for the receive flow. The actual SDK exports a
// BoltzReverseSwap interface; we extend it with the mutable `.status` field
// the recovery flow writes (the SDK marks the swap private in setters).
export type ReceiveReverseSwap = {
  id?: string;
  type?: string;
  createdAt?: number;
  status?: string;
  preimage?: string;
  request?: { claimPublicKey?: string; [key: string]: unknown } | null;
  response?: Record<string, unknown> | null;
};

// Lightning SDK methods we reach into. `savePendingReverseSwap` is private on
// ExpoArkadeSwaps but exposed via the singleton in dev; we tolerate both that
// and the fallback `swapRepository.saveSwap` path.
export type ReceiveLightningSdk = {
  savePendingReverseSwap?: (swap: ReceiveReverseSwap) => Promise<void>;
  swapRepository?: { saveSwap?: (swap: ReceiveReverseSwap) => Promise<void> };
  getSwapManager?: () => ReceiveSwapManager | null;
  claimVHTLC?: (swap: ReceiveReverseSwap) => Promise<void>;
  refreshSwapsStatus?: () => Promise<void>;
  getPendingReverseSwaps?: () => Promise<ReceiveReverseSwap[]>;
  getSwapHistory?: () => Promise<ReceiveReverseSwap[]>;
  restoreSwaps?: () => Promise<{ reverseSwaps?: ReceiveReverseSwap[] }>;
  enrichReverseSwapPreimage?: (swap: ReceiveReverseSwap, preimage: string) => unknown;
  getSwapStatus?: (id: string) => Promise<{ status?: string }>;
  wallet?: {
    offchainTapscript?: unknown;
    identity?: { compressedPublicKey?: () => Promise<Uint8Array> };
  };
};

export type ReceiveSwapManager = {
  isProcessing?: (id: string) => Promise<boolean> | boolean;
  hasSwap?: (id: string) => Promise<boolean> | boolean;
  addSwap?: (swap: ReceiveReverseSwap) => Promise<void>;
  removeSwap?: (id: string) => Promise<unknown> | unknown;
};

export async function persistAndWatchReverseSwap(
  lightning: ArkadeLightning,
  swap: ReceiveReverseSwap,
  reason: string,
  status?: string,
): Promise<void> {
  const id = String(swap?.id || "");
  if (!id) return;
  if (status) {
    swap.status = status;
  }
  let saved = false;
  const lightningSdk = lightning as unknown as ReceiveLightningSdk;
  try {
    if (typeof lightningSdk.savePendingReverseSwap === "function") {
      await lightningSdk.savePendingReverseSwap(swap);
      saved = true;
    } else if (typeof lightningSdk?.swapRepository?.saveSwap === "function") {
      await lightningSdk.swapRepository.saveSwap(swap);
      saved = true;
    }
  } catch (error: unknown) {
    logArkadeWalletSignTrace("ln_receive_swap_repository", {
      status: "failed",
      reason,
      id: truncateForLog(id, 16),
      err: truncateForLog(error instanceof Error ? error.message : String(error || "unknown"), 150),
      expected_next: "continue_manual_claim_scan",
    });
  }

  let watched = false;
  try {
    const manager =
      typeof lightningSdk.getSwapManager === "function" ? lightningSdk.getSwapManager() : null;
    if (manager && typeof manager.addSwap === "function") {
      await manager.addSwap(swap);
      watched = true;
    }
  } catch (error: unknown) {
    logArkadeWalletSignTrace("ln_receive_swap_manager", {
      status: "failed",
      reason,
      id: truncateForLog(id, 16),
      err: truncateForLog(error instanceof Error ? error.message : String(error || "unknown"), 150),
      expected_next: "continue_manual_claim_scan",
    });
  }

  logArkadeWalletSignTrace("ln_receive_swap_integrated", {
    status: "ok",
    reason,
    id: truncateForLog(id, 16),
    swap_status: String(swap?.status || "n/a"),
    saved: saved ? 1 : 0,
    watched: watched ? 1 : 0,
    expected_next: "sdk_swap_manager_or_manual_claim",
  });
}

export async function readSwapManagerFlag(
  manager: ReceiveSwapManager | null,
  method: "isProcessing" | "hasSwap",
  swapId: string,
): Promise<{ value: boolean; error: string }> {
  const fn = manager?.[method];
  if (!manager || typeof fn !== "function") {
    return { value: false, error: "" };
  }
  try {
    return { value: Boolean(await fn.call(manager, swapId)), error: "" };
  } catch (error: unknown) {
    return {
      value: false,
      error: truncateForLog(
        error instanceof Error ? error.message : String(error || "unknown"),
        90,
      ),
    };
  }
}

export async function removeReverseSwapManagerWatchForDirectClaim(
  manager: { removeSwap?: (swapId: string) => Promise<unknown> | unknown } | null | undefined,
  id: string,
  reason: string,
): Promise<void> {
  if (!manager || typeof manager.removeSwap !== "function") return;
  try {
    await manager.removeSwap(id);
    logArkadeWalletSignTrace("ln_receive_swap_manager", {
      status: "removed_for_direct_claim",
      reason,
      id: truncateForLog(id, 16),
      expected_next: "direct_claim_vhtlc",
    });
  } catch (error: unknown) {
    logArkadeWalletSignTrace("ln_receive_swap_manager", {
      status: "remove_failed",
      reason,
      id: truncateForLog(id, 16),
      err: truncateForLog(error instanceof Error ? error.message : String(error || "unknown"), 140),
      expected_next: "direct_claim_vhtlc",
    });
  }
}

export async function claimReverseSwapWithVhtlc(
  lightning: ArkadeLightning,
  swap: ReceiveReverseSwap,
  id: string,
  reason: string,
): Promise<void> {
  const lightningSdk = lightning as unknown as ReceiveLightningSdk;
  const claimFn = lightningSdk?.claimVHTLC;
  if (typeof claimFn !== "function") {
    throw new Error("claimVHTLC unavailable");
  }
  const claimStartMs = Date.now();
  let progressEmitted = false;
  const watchdog = setInterval(() => {
    const elapsedMs = Date.now() - claimStartMs;
    logArkadeWalletSignTrace("ln_receive_manual_claim", {
      status: "claim_waiting",
      reason,
      id: truncateForLog(id, 16),
      elapsed_ms: elapsedMs,
      expected_next: "sdk_claim_vhtlc_result",
    });
    if (!progressEmitted) {
      progressEmitted = true;
      emitArkadeReceiveUnlockProgress({
        phase: "claim_waiting",
        reason,
        id: truncateForLog(id, 16),
        elapsedMs,
      });
    }
  }, ARKADE_LN_RECEIVE_CLAIM_WATCHDOG_MS);
  try {
    logArkadeWalletSignTrace("ln_receive_manual_claim", {
      status: "direct_claim_start",
      reason,
      id: truncateForLog(id, 16),
      timeout_ms: ARKADE_LN_RECEIVE_CLAIM_TIMEOUT_MS,
      expected_next: "sdk_claim_vhtlc",
    });
    await Promise.race([
      claimFn.call(lightningSdk, swap),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `ln_receive_claim_vhtlc timeout after ${ARKADE_LN_RECEIVE_CLAIM_TIMEOUT_MS}ms`,
              ),
            ),
          ARKADE_LN_RECEIVE_CLAIM_TIMEOUT_MS,
        ),
      ),
    ]);
    logArkadeWalletSignTrace("ln_receive_manual_claim", {
      status: "direct_claim_ok",
      reason,
      id: truncateForLog(id, 16),
      dur_ms: Date.now() - claimStartMs,
      expected_next: "refresh_wallet_summary",
    });
  } catch (error: unknown) {
    logArkadeWalletSignTrace("ln_receive_manual_claim", {
      status: "direct_claim_failed",
      reason,
      id: truncateForLog(id, 16),
      dur_ms: Date.now() - claimStartMs,
      err: truncateForLog(error instanceof Error ? error.message : String(error || "unknown"), 170),
      expected_next: "claim_failed_cooldown",
    });
    throw error;
  } finally {
    clearInterval(watchdog);
  }
}
