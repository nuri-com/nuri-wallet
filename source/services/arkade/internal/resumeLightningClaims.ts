// Core resume routine for arkade lightning receive: refresh swaps, fetch
// pending server-side, scan + claim claimable reverse swaps.
import { bytesToHex } from "../../../lib/bytes";
import { shortTime } from "../../../lib/logShared";
import {
  arkadeReceiveSync,
  type ArkadeLnurlPendingSwap,
  type ArkadeReceiveLightningRow,
  type ArkadeReceiveOwner,
  type ArkadeReceiveRestore,
} from "../ArkadeApiService";
import { ArkadeRemoteIdentity } from "../ArkadeRemoteIdentity";
import {
  claimInFlightSwapIds,
  deleteLnReceiveClaimCooldown,
  getLnReceiveClaimCooldown,
  setLnReceiveClaimCooldown,
} from "./lnClaimCooldown";
import { getArkadeReceiveOwner } from "./identity";
import { emitTrace, logArkadeWalletSignTrace } from "./logging";
import {
  getPendingLnurlSwapsCacheAgeMs,
  getPendingLnurlSwapsCount,
  readPendingLnurlSwapsCache,
  setPendingLnurlSwaps,
} from "./pendingLnurlSwaps";
import { assertArkadeRecoveryCsvCompatible } from "./recovery";
import type { ArkadeLightningClaimSummary } from "./receiveUpdatedEvents";
import type { ArkadePendingLnurlSwap } from "../types/lnurl";
import { deriveArkadeReceiveStageStatus, setReceiveStage } from "./receiveStage";
import {
  claimReverseSwapWithVhtlc,
  isDuplicateOffchainClaimError,
  isReverseClaimableStatus,
  isReverseFailedFinalStatus,
  isReverseFinalStatus,
  isReverseSuccessfulFinalStatus,
  persistAndWatchReverseSwap,
  readSwapManagerFlag,
  removeReverseSwapManagerWatchForDirectClaim,
  type ReceiveLightningSdk,
  type ReceiveReverseSwap,
} from "./reverseSwapClaim";
import type { ArkadeLightning, ArkadeWallet } from "./types";
import { truncateForLog } from "./utils";
import { getCachedArkadeWallet, getOrCreateWallet } from "./walletCache";

const ARKADE_PENDING_FETCH_FAILURE_DEDUPE_MS = 30_000;
const ARKADE_CACHED_CLAIMABLE_RESTORE_MAX_AGE_MS = 15_000;

let lastPendingFetchFailureDetail = "";
let lastPendingFetchFailureAtMs = 0;

export function clearLnReceiveResumeDedupeState(): void {
  lastPendingFetchFailureDetail = "";
  lastPendingFetchFailureAtMs = 0;
}

type ServerPendingReceive = {
  id: string;
  receiveId: string;
  preimageHex: string;
  preimageHashHex: string;
  status: string;
  createdAtMs: number;
  updatedAtMs: number;
  restoreSwap: ReceiveReverseSwap | null;
};

function stripLightningReceiveId(value: unknown): string {
  const raw = String(value || "").trim();
  return raw.startsWith("lightning:") ? raw.slice("lightning:".length) : raw;
}

function receiveRowSwapId(row: ArkadeReceiveLightningRow): string {
  return (
    String(row?.swap_id || "").trim() ||
    stripLightningReceiveId(row?.receive_id) ||
    stripLightningReceiveId(row?.id)
  );
}

function receiveRowReceiveId(row: ArkadeReceiveLightningRow, swapId: string): string {
  return String(row?.receive_id || row?.id || (swapId ? `lightning:${swapId}` : "")).trim();
}

function normalizeCreatedAtSeconds(value: unknown): number {
  const num = Number(value || 0);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return num > 10_000_000_000 ? Math.trunc(num / 1000) : Math.trunc(num);
}

function asRestoreObject(
  value: ArkadeReceiveRestore | null | undefined,
): ArkadeReceiveRestore | null {
  if (!value || typeof value !== "object") return null;
  return value;
}

function buildReverseSwapFromServerRestore(
  row: ArkadeReceiveLightningRow,
  swapId: string,
): ReceiveReverseSwap | null {
  const restore = asRestoreObject(row.restore);
  if (!restore) return null;
  const id = String(restore.id || swapId || "").trim();
  const preimage = String(restore.preimage || "")
    .trim()
    .toLowerCase();
  if (!id || !preimage) return null;
  const request = restore.request && typeof restore.request === "object" ? restore.request : null;
  const response =
    restore.response && typeof restore.response === "object" ? restore.response : null;
  if (!request || !response) return null;
  return {
    id,
    type: "reverse",
    createdAt: normalizeCreatedAtSeconds(restore.createdAt || row.created_at_ms),
    preimage,
    status: String(restore.status || row.boltz_status || row.status || ""),
    request,
    response,
  };
}

function mapReceiveRowToPendingSwap(row: ArkadeReceiveLightningRow): ArkadeLnurlPendingSwap {
  const swapId = receiveRowSwapId(row);
  const restore = asRestoreObject(row.restore);
  const preimageHex = String(row.preimage_hex || restore?.preimage || "")
    .trim()
    .toLowerCase();
  return {
    id: swapId,
    username: String(row.username || ""),
    invoice: String(row.invoice || ""),
    preimage_hex: preimageHex,
    preimage_hash_hex: String(row.preimage_hash_hex || row.payment_hash_hex || "")
      .trim()
      .toLowerCase(),
    amount_msat: Number(row.amount_msat || 0),
    status: String(row.boltz_status || row.status || ""),
    created_at_ms: Number(row.created_at_ms || 0),
    updated_at_ms: Number(row.updated_at_ms || 0),
  };
}

function mapReceiveRowToPendingReceive(
  row: ArkadeReceiveLightningRow,
): ServerPendingReceive | null {
  const swapId = receiveRowSwapId(row);
  if (!swapId) return null;
  const restore = asRestoreObject(row.restore);
  const preimageHex = String(row.preimage_hex || restore?.preimage || "")
    .trim()
    .toLowerCase();
  const preimageHashHex = String(row.preimage_hash_hex || row.payment_hash_hex || "")
    .trim()
    .toLowerCase();
  if (!preimageHex || !preimageHashHex) return null;
  return {
    id: swapId,
    receiveId: receiveRowReceiveId(row, swapId),
    preimageHex,
    preimageHashHex,
    status: String(row.boltz_status || row.status || ""),
    createdAtMs: Number(row.created_at_ms || 0),
    updatedAtMs: Number(row.updated_at_ms || 0),
    restoreSwap: buildReverseSwapFromServerRestore(row, swapId),
  };
}

function mapCachedSwapToReceiveRow(row: ArkadePendingLnurlSwap): ArkadeReceiveLightningRow {
  return {
    id: row.id ? `lightning:${row.id}` : "",
    receive_id: row.id ? `lightning:${row.id}` : "",
    type: "lightning",
    status: row.status,
    boltz_status: row.status,
    swap_id: row.id,
    username: row.username,
    invoice: row.invoice,
    preimage_hex: row.preimageHex,
    preimage_hash_hex: row.preimageHashHex,
    amount_msat: row.amountMsat,
    created_at_ms: row.createdAtMs,
    updated_at_ms: row.updatedAtMs,
    restore: row.restore ? (row.restore as ArkadeReceiveRestore) : null,
  };
}

function mapCachedSwapToPendingReceive(row: ArkadePendingLnurlSwap): ServerPendingReceive | null {
  return mapReceiveRowToPendingReceive(mapCachedSwapToReceiveRow(row));
}

export async function resumeArkadeLightningClaimsCore(
  lightning: ArkadeLightning,
  options?: {
    allowPrompt?: boolean;
    reason?: string;
  },
): Promise<ArkadeLightningClaimSummary> {
  const allowPrompt = options?.allowPrompt === true;
  const assertionReason = options?.reason || "ln_receive_claim";
  const lightningSdk = lightning as unknown as ReceiveLightningSdk;
  const cachedReceiveRows = readPendingLnurlSwapsCache();
  const cachedClaimableCount = cachedReceiveRows.filter((row) =>
    isReverseClaimableStatus(row.status),
  ).length;
  const cachedReceiveRowsAgeMs = getPendingLnurlSwapsCacheAgeMs();
  const reusableCachedClaimableRows = cachedReceiveRows
    .filter((row) => isReverseClaimableStatus(row.status))
    .map((row) => mapCachedSwapToPendingReceive(row))
    .filter((row): row is ServerPendingReceive =>
      Boolean(row?.id && row.preimageHex && row.preimageHashHex && row.restoreSwap),
    );
  const canUseCachedClaimableRows =
    cachedReceiveRowsAgeMs <= ARKADE_CACHED_CLAIMABLE_RESTORE_MAX_AGE_MS &&
    cachedClaimableCount > 0 &&
    reusableCachedClaimableRows.length === cachedClaimableCount;
  logArkadeWalletSignTrace("ln_receive_manual_claim", {
    status: "start",
    reason: assertionReason,
    prompt: allowPrompt ? 1 : 0,
    ln_receive_pending_count: Math.max(0, cachedReceiveRows.length - cachedClaimableCount),
    ln_receive_claimable_count: cachedClaimableCount,
    expected_next: "refresh_swaps_status",
  });
  if (typeof lightningSdk.refreshSwapsStatus === "function" && !canUseCachedClaimableRows) {
    const refreshStartMs = Date.now();
    emitTrace({
      atMs: refreshStartMs,
      op: "ln_receive_manual_claim",
      status: "refresh_start",
    });
    try {
      await lightningSdk.refreshSwapsStatus();
      emitTrace({
        atMs: Date.now(),
        op: "ln_receive_manual_claim",
        status: "refresh_ok",
        detail: `durMs=${Date.now() - refreshStartMs}`,
      });
    } catch (error: unknown) {
      const detail = truncateForLog(
        error instanceof Error ? error.message : String(error || "unknown"),
        170,
      );
      emitTrace({
        atMs: Date.now(),
        op: "ln_receive_manual_claim",
        status: "refresh_failed",
        detail: `durMs=${Date.now() - refreshStartMs} err=${detail}`,
      });
    }
  } else if (canUseCachedClaimableRows) {
    emitTrace({
      atMs: Date.now(),
      op: "ln_receive_manual_claim",
      status: "refresh_skip",
      detail: `source=cached_claimable_restore claimable=${reusableCachedClaimableRows.length} ageMs=${cachedReceiveRowsAgeMs}`,
    });
  } else {
    emitTrace({
      atMs: Date.now(),
      op: "ln_receive_manual_claim",
      status: "refresh_skip",
      detail: "refreshSwapsStatus unavailable",
    });
  }

  const historyStartMs = Date.now();
  let historySource = "history";
  let history: ReceiveReverseSwap[] = [];
  if (typeof lightningSdk.getPendingReverseSwaps === "function") {
    try {
      const pendingReverseSwaps = await lightningSdk.getPendingReverseSwaps();
      history = Array.isArray(pendingReverseSwaps) ? pendingReverseSwaps : [];
      historySource = "pending_reverse";
    } catch (error: unknown) {
      emitTrace({
        atMs: Date.now(),
        op: "ln_receive_manual_claim",
        status: "history_pending_failed",
        detail: truncateForLog(
          error instanceof Error ? error.message : String(error || "unknown"),
          170,
        ),
      });
    }
  }
  if (historySource === "history" && typeof lightningSdk.getSwapHistory === "function") {
    history = (await lightningSdk.getSwapHistory()) as ReceiveReverseSwap[];
  }
  emitTrace({
    atMs: Date.now(),
    op: "ln_receive_manual_claim",
    status: "history",
    detail: `durMs=${Date.now() - historyStartMs} swaps=${Array.isArray(history) ? history.length : 0} source=${historySource}`,
  });

  const reverseSwaps: ReceiveReverseSwap[] = Array.isArray(history)
    ? historySource === "pending_reverse"
      ? history
      : history.filter((swap) => String(swap?.type || "") === "reverse")
    : [];
  let ownCompressedPubkeyHex = "";
  try {
    const key = await lightningSdk?.wallet?.identity?.compressedPublicKey?.();
    if (key && key.length > 0) {
      ownCompressedPubkeyHex = bytesToHex(key).toLowerCase();
    }
  } catch {}
  const ownReverseSwaps = ownCompressedPubkeyHex
    ? reverseSwaps.filter((swap) => {
        const claimPk = String(swap?.request?.claimPublicKey || "").toLowerCase();
        return !claimPk || claimPk === ownCompressedPubkeyHex;
      })
    : reverseSwaps;
  const knownById = new Map<string, ReceiveReverseSwap>();
  for (const swap of ownReverseSwaps) {
    const id = String(swap?.id || "");
    if (id) {
      knownById.set(id, swap);
    }
  }
  emitTrace({
    atMs: Date.now(),
    op: "ln_receive_manual_claim",
    status: "scope",
    detail: `reverse=${reverseSwaps.length} own=${ownReverseSwaps.length} localLocks=${claimInFlightSwapIds.size}`,
  });

  let receiveOwner: ArkadeReceiveOwner | null = null;
  const getReceiveOwner = async () => {
    if (receiveOwner) return receiveOwner;
    receiveOwner = await getArkadeReceiveOwner();
    return receiveOwner;
  };

  const pendingSwapById = new Map<string, ServerPendingReceive>();
  let receiveSyncSucceeded = false;
  let pendingSource = "receive_sync";
  if (canUseCachedClaimableRows) {
    for (const pending of reusableCachedClaimableRows) {
      pendingSwapById.set(pending.id, pending);
    }
    receiveSyncSucceeded = true;
    pendingSource = "cached_claimable_restore";
    emitTrace({
      atMs: Date.now(),
      op: "ln_receive_manual_claim",
      status: "pending_fetch",
      detail: `rows=${cachedReceiveRows.length} active=${cachedReceiveRows.length} claim_packages=${pendingSwapById.size} source=${pendingSource}`,
    });
    logArkadeWalletSignTrace("ln_receive_sync_counts", {
      ln_receive_pending_count: Math.max(0, cachedReceiveRows.length - pendingSwapById.size),
      ln_receive_claimable_count: pendingSwapById.size,
      rows: cachedReceiveRows.length,
      active: cachedReceiveRows.length,
      source: pendingSource,
      expected_next: pendingSwapById.size > 0 ? "selected_swap_id" : "idle",
    });
    const pendingFetchCounts = {
      pendingCount: Math.max(0, cachedReceiveRows.length - pendingSwapById.size),
      claimableCount: pendingSwapById.size,
      claimedCount: 0,
      settledCount: 0,
      failedCount: 0,
    };
    setReceiveStage(
      deriveArkadeReceiveStageStatus(pendingFetchCounts),
      pendingFetchCounts,
      `source=${pendingSource}`,
    );
  } else {
    try {
      const pendingStartMs = Date.now();
      const owner = await getReceiveOwner();
      const receiveResponse = await arkadeReceiveSync(owner);
      const lightningRows: ArkadeReceiveLightningRow[] = Array.isArray(receiveResponse?.lightning)
        ? receiveResponse.lightning
        : Array.isArray(receiveResponse?.receives)
          ? receiveResponse.receives.filter(
              (row): row is ArkadeReceiveLightningRow => row?.type === "lightning",
            )
          : [];
      const pendingRows = lightningRows.map((row) => mapReceiveRowToPendingSwap(row));
      // Terminal rows (settled/refunded/expired/failed) are retained server-side
      // as evidence; they are not pending work and must not enter the cache.
      const activePendingRows = pendingRows.filter((row) => !isReverseFinalStatus(row.status));
      const activeLightningRows = lightningRows.filter(
        (row) => !isReverseFinalStatus(String(row.boltz_status || row.status || "")),
      );
      setPendingLnurlSwaps(activeLightningRows);
      for (const row of lightningRows) {
        const pending = mapReceiveRowToPendingReceive(row);
        if (!pending) continue;
        // A claim package is only actionable once the provider reports the lockup as
        // claimable. Unpaid (swap.created) and final rows must not arm the
        // claim loop or count as claimable.
        if (!isReverseClaimableStatus(pending.status)) continue;
        pendingSwapById.set(pending.id, pending);
      }
      const failedRowCount = pendingRows.filter((row) =>
        isReverseFailedFinalStatus(row.status),
      ).length;
      const settledRowCount = pendingRows.filter((row) =>
        isReverseSuccessfulFinalStatus(row.status),
      ).length;
      emitTrace({
        atMs: Date.now(),
        op: "ln_receive_manual_claim",
        status: "pending_fetch",
        detail: `durMs=${Date.now() - pendingStartMs} rows=${pendingRows.length} active=${activePendingRows.length} claim_packages=${pendingSwapById.size} source=receive_sync`,
      });
      logArkadeWalletSignTrace("ln_receive_sync_counts", {
        ln_receive_pending_count: Math.max(0, activePendingRows.length - pendingSwapById.size),
        ln_receive_claimable_count: pendingSwapById.size,
        rows: pendingRows.length,
        active: activePendingRows.length,
        source: "receive_sync",
        expected_next: pendingSwapById.size > 0 ? "selected_swap_id" : "idle",
      });
      const pendingFetchCounts = {
        pendingCount: Math.max(0, activePendingRows.length - pendingSwapById.size),
        claimableCount: pendingSwapById.size,
        claimedCount: 0,
        settledCount: settledRowCount,
        failedCount: failedRowCount,
      };
      setReceiveStage(
        deriveArkadeReceiveStageStatus(pendingFetchCounts),
        pendingFetchCounts,
        "source=receive_sync",
      );
      receiveSyncSucceeded = true;
    } catch (error: unknown) {
      const detail = truncateForLog(
        error instanceof Error ? error.message : String(error || "unknown"),
        170,
      );
      const now = Date.now();
      if (
        detail !== lastPendingFetchFailureDetail ||
        now - lastPendingFetchFailureAtMs > ARKADE_PENDING_FETCH_FAILURE_DEDUPE_MS
      ) {
        lastPendingFetchFailureDetail = detail;
        lastPendingFetchFailureAtMs = now;
        emitTrace({
          atMs: now,
          op: "ln_receive_manual_claim",
          status: "pending_fetch_failed",
          detail,
        });
      }
    }
  }

  const needsSdkRestore =
    pendingSwapById.size > 0 &&
    Array.from(pendingSwapById.entries()).some(
      ([swapId, pendingSwap]) => !knownById.has(swapId) && !pendingSwap.restoreSwap,
    );
  if (needsSdkRestore && typeof lightningSdk.restoreSwaps === "function") {
    const restoreStartMs = Date.now();
    const restored = await lightningSdk.restoreSwaps();
    const restoredReverseSwaps: ReceiveReverseSwap[] = Array.isArray(restored?.reverseSwaps)
      ? restored.reverseSwaps.filter((swap) => pendingSwapById.has(String(swap?.id || "")))
      : [];
    emitTrace({
      atMs: Date.now(),
      op: "ln_receive_manual_claim",
      status: "pending_restore",
      detail: `durMs=${Date.now() - restoreStartMs} reverse=${restoredReverseSwaps.length}`,
    });
    for (const swap of restoredReverseSwaps) {
      const id = String(swap?.id || "");
      if (!id || knownById.has(id)) continue;
      knownById.set(id, swap);
    }
  }

  for (const [swapId, pendingSwap] of pendingSwapById.entries()) {
    let swap = knownById.get(swapId);
    if (!swap && pendingSwap.restoreSwap) {
      swap = pendingSwap.restoreSwap;
      knownById.set(swapId, swap);
      await persistAndWatchReverseSwap(lightning, swap, assertionReason, pendingSwap.status);
      emitTrace({
        atMs: Date.now(),
        op: "ln_receive_manual_claim",
        status: "pending_restored_from_server",
        id: swapId,
        detail: `source=${pendingSource}`,
      });
    }
    if (!swap) {
      emitTrace({
        atMs: Date.now(),
        op: "ln_receive_manual_claim",
        status: "pending_missing_local",
        id: swapId,
        detail: "no matching local/server restore swap",
      });
      continue;
    }
    const localPreimage = String(swap?.preimage || "")
      .trim()
      .toLowerCase();
    if (localPreimage) {
      continue;
    }
    try {
      if (typeof lightningSdk.enrichReverseSwapPreimage === "function") {
        lightningSdk.enrichReverseSwapPreimage(swap, pendingSwap.preimageHex);
      } else {
        swap.preimage = pendingSwap.preimageHex;
      }
      await persistAndWatchReverseSwap(lightning, swap, assertionReason, pendingSwap.status);
      emitTrace({
        atMs: Date.now(),
        op: "ln_receive_manual_claim",
        status: "pending_enriched",
        id: swapId,
        detail: `source=${pendingSource}`,
      });
    } catch (error: unknown) {
      const detail = truncateForLog(
        error instanceof Error ? error.message : String(error || "unknown"),
        170,
      );
      emitTrace({
        atMs: Date.now(),
        op: "ln_receive_manual_claim",
        status: "pending_enrich_failed",
        id: swapId,
        detail,
      });
    }
  }
  if (!receiveSyncSucceeded || pendingSwapById.size <= 0) {
    logArkadeWalletSignTrace("ln_receive_sync_counts", {
      ln_receive_pending_count: receiveSyncSucceeded ? getPendingLnurlSwapsCount() : 0,
      ln_receive_claimable_count: pendingSwapById.size,
      source: pendingSource,
      status: receiveSyncSucceeded ? "none" : "fetch_failed",
      expected_next: "do_not_claim_local_sdk_state",
    });
    return {
      scanned: 0,
      claimable: 0,
      claimed: 0,
      settled: 0,
      final: 0,
      failed: 0,
    };
  }

  let claimable = 0;
  let claimed = 0;
  let settled = 0;
  let final = 0;
  let failed = 0;
  const manager =
    typeof lightningSdk.getSwapManager === "function" ? lightningSdk.getSwapManager() : null;
  emitTrace({
    atMs: Date.now(),
    op: "ln_receive_manual_claim",
    status: "manager",
    detail: `enabled=${manager ? 1 : 0} hasProc=${manager?.isProcessing ? 1 : 0} hasWatch=${manager?.hasSwap ? 1 : 0}`,
  });

  const knownSwaps = Array.from(knownById.values());
  const inFlightLocks = knownSwaps.some((swap) => {
    const id = String(swap?.id || "");
    return id && claimInFlightSwapIds.has(id);
  });
  if (
    knownSwaps.length > 0 &&
    !inFlightLocks &&
    knownSwaps.every((swap) => String(swap?.status || "") === "swap.created")
  ) {
    return {
      scanned: 0,
      claimable: 0,
      claimed: 0,
      settled: 0,
      final: 0,
      failed: 0,
    };
  }

  const scanIds = Array.from(pendingSwapById.keys());
  const statusCounts: Map<string, number> = new Map();

  for (const id of scanIds) {
    if (!id) continue;
    const swap = knownById.get(id);

    const localStatus = swap
      ? String(swap?.status || "")
      : String(pendingSwapById.get(id)?.status || "");
    let status = localStatus;
    const syncStartMs = Date.now();
    try {
      const remote = await lightningSdk.getSwapStatus(id);
      status = String(remote?.status || status || "");
      if (swap) {
        await persistAndWatchReverseSwap(lightning, swap, assertionReason, status);
      }
      emitTrace({
        atMs: Date.now(),
        op: "ln_receive_manual_claim",
        status: "status_sync",
        id,
        detail: `durMs=${Date.now() - syncStartMs} local=${localStatus || "n/a"} remote=${status || "n/a"}`,
      });
    } catch (error: unknown) {
      const detail = truncateForLog(
        error instanceof Error ? error.message : String(error || "unknown"),
        170,
      );
      emitTrace({
        atMs: Date.now(),
        op: "ln_receive_manual_claim",
        status: "status_sync_failed",
        id,
        detail: `durMs=${Date.now() - syncStartMs} local=${localStatus || "n/a"} err=${detail}`,
      });
    }

    emitTrace({
      atMs: Date.now(),
      op: "ln_receive_manual_claim",
      status: "scan",
      id,
      detail: `status=${status || "n/a"}`,
    });
    const normalizedStatus = String(status || "n/a")
      .trim()
      .toLowerCase();
    statusCounts.set(normalizedStatus, (statusCounts.get(normalizedStatus) || 0) + 1);

    if (isReverseSuccessfulFinalStatus(status)) {
      settled += 1;
      continue;
    }
    if (isReverseFailedFinalStatus(status)) {
      final += 1;
      failed += 1;
      emitTrace({
        atMs: Date.now(),
        op: "ln_receive_manual_claim",
        status: "final_retained",
        id,
        detail: `status=${status || "n/a"} reason=server_evidence_retained`,
      });
      continue;
    }
    if (isReverseFinalStatus(status)) {
      final += 1;
      continue;
    }
    if (!isReverseClaimableStatus(status)) {
      console.log(
        `🔐 [${shortTime()} ArkadeReceiveAutoClaim.resumeClaims] claim_skip_not_claimable id=${truncateForLog(id, 12)} status=${status || "n/a"}`,
      );
      continue;
    }

    if (!swap) {
      emitTrace({
        atMs: Date.now(),
        op: "ln_receive_manual_claim",
        status: "pending_missing_local",
        id,
        detail: `status=${status || "n/a"}`,
      });
      continue;
    }

    if (!pendingSwapById.has(id)) {
      emitTrace({
        atMs: Date.now(),
        op: "ln_receive_manual_claim",
        status: "swap_manager_owner",
        id,
        detail: `status=${status || "n/a"} reason=no_server_pending_swap`,
      });
      continue;
    }

    claimable += 1;
    const cooldown = getLnReceiveClaimCooldown(id);
    if (cooldown) {
      failed += 1;
      setReceiveStage(
        "failed",
        {
          pendingCount: getPendingLnurlSwapsCount(),
          claimableCount: claimable,
          claimedCount: claimed,
          settledCount: settled,
          failedCount: failed,
        },
        `id=${id} action=claim_cooldown reason=${cooldown.reason}`,
      );
      emitTrace({
        atMs: Date.now(),
        op: "ln_receive_manual_claim",
        status: "claim_cooldown",
        id,
        detail: `reason=${cooldown.reason} remainingMs=${Math.max(0, Math.trunc(cooldown.remainingMs))}`,
      });
      continue;
    }
    const localLockActive = claimInFlightSwapIds.has(id);
    const [managerProcessingFlag, managerWatchingFlag] = await Promise.all([
      readSwapManagerFlag(manager, "isProcessing", id),
      readSwapManagerFlag(manager, "hasSwap", id),
    ]);
    const managerProcessing = managerProcessingFlag.value;
    const managerWatching = managerWatchingFlag.value;
    setReceiveStage(
      localLockActive || managerProcessing ? "claiming" : "claimable",
      {
        pendingCount: getPendingLnurlSwapsCount(),
        claimableCount: claimable,
        claimedCount: claimed,
        settledCount: settled,
        failedCount: failed,
      },
      `id=${id} remote=${status || "n/a"}`,
    );
    emitTrace({
      atMs: Date.now(),
      op: "ln_receive_manual_claim",
      status: "decision",
      id,
      detail:
        `status=${status || "n/a"} localLock=${localLockActive ? 1 : 0} ` +
        `managerProc=${managerProcessing ? 1 : 0} managerWatch=${managerWatching ? 1 : 0} ` +
        `procErr=${managerProcessingFlag.error || "none"} watchErr=${managerWatchingFlag.error || "none"}`,
    });

    if (localLockActive) {
      emitTrace({
        atMs: Date.now(),
        op: "ln_receive_manual_claim",
        status: "already_claiming",
        id,
        detail: "local claim lock active",
      });
      continue;
    }
    if (managerProcessing) {
      emitTrace({
        atMs: Date.now(),
        op: "ln_receive_manual_claim",
        status: "already_claiming",
        id,
        detail: "swap manager processing claim",
      });
      continue;
    }
    if (managerWatching && !isReverseClaimableStatus(status)) {
      emitTrace({
        atMs: Date.now(),
        op: "ln_receive_manual_claim",
        status: "already_claiming",
        id,
        detail: "swap manager is watching with auto actions enabled",
      });
      continue;
    }
    const lightningWallet = lightningSdk?.wallet || null;
    let claimWallet: ArkadeWallet | null = lightningWallet?.offchainTapscript
      ? (lightningWallet as unknown as ArkadeWallet)
      : null;
    if (!claimWallet) {
      claimWallet = getCachedArkadeWallet() || (await getOrCreateWallet());
    }
    await assertArkadeRecoveryCsvCompatible(claimWallet, "ln_receive_claim");
    claimInFlightSwapIds.add(id);
    try {
      const claimStartMs = Date.now();
      logArkadeWalletSignTrace("selected_swap_id", {
        swap_id: truncateForLog(id, 24),
        ln_receive_claimable_count: pendingSwapById.size,
        expected_next: "receive_claim_scope_enter",
      });
      setReceiveStage(
        "claiming",
        {
          pendingCount: getPendingLnurlSwapsCount(),
          claimableCount: claimable,
          claimedCount: claimed,
          settledCount: settled,
          failedCount: failed,
        },
        `id=${id} action=claim_start`,
      );
      emitTrace({
        atMs: claimStartMs,
        op: "ln_receive_manual_claim",
        status: "claim_start",
        id,
      });
      if (managerWatching) {
        await removeReverseSwapManagerWatchForDirectClaim(manager, id, assertionReason);
      }
      const lightningIdentityRaw = (lightningWallet as unknown as { identity?: unknown } | null)
        ?.identity;
      const claimWalletIdentityRaw = (claimWallet as unknown as { identity?: unknown }).identity;
      const claimIdentity =
        lightningIdentityRaw instanceof ArkadeRemoteIdentity
          ? lightningIdentityRaw
          : claimWalletIdentityRaw instanceof ArkadeRemoteIdentity
            ? claimWalletIdentityRaw
            : null;
      if (!claimIdentity) {
        throw new Error("Arkade receive claim identity unavailable");
      }
      await claimIdentity.withReceiveClaimApproval(id, assertionReason, () =>
        claimReverseSwapWithVhtlc(lightning, swap, id, assertionReason),
      );
      // Loaded at call time, not at module scope: the static import closed the
      // receiveAutoClaim → resumeLightningClaims → receiveAutoClaim cycle
      // (issue #875). This is the single use, it already sits in an async claim
      // path, and the refresh is fire-and-forget — so deferring costs nothing
      // and removes the edge entirely rather than tolerating it.
      // EXCEPTION to the no-dynamic-imports rule (AGENTS.md): cycle-breaking edge whose
      // target is statically imported by ArkadeReceiveUnlockService and receiveAutoSweep,
      // so receiveAutoClaim is always in the web bundle.
      void import("./receiveAutoClaim").then((m) =>
        m.scheduleArkadeReceiveBalanceRefresh("ln_receive_claimed"),
      );
      claimed += 1;
      deleteLnReceiveClaimCooldown(id);
      setReceiveStage(
        "claiming",
        {
          pendingCount: getPendingLnurlSwapsCount(),
          claimableCount: claimable,
          claimedCount: claimed,
          settledCount: settled,
          failedCount: failed,
        },
        `id=${id} action=claimed`,
      );
      emitTrace({
        atMs: Date.now(),
        op: "ln_receive_manual_claim",
        status: "claimed",
        id,
        detail: `durMs=${Date.now() - claimStartMs}`,
      });
    } catch (error: unknown) {
      if (isDuplicateOffchainClaimError(error)) {
        emitTrace({
          atMs: Date.now(),
          op: "ln_receive_manual_claim",
          status: "already_claiming",
          id,
          detail: "duplicate offchain tx; claim already in progress",
        });
        try {
          const after = await lightningSdk.getSwapStatus(id);
          const afterStatus = String(after?.status || "");
          if (afterStatus.toLowerCase() === "invoice.settled") {
            settled += 1;
            continue;
          }
          emitTrace({
            atMs: Date.now(),
            op: "ln_receive_manual_claim",
            status: "pending",
            id,
            detail: `status=${afterStatus || "n/a"}`,
          });
        } catch {}
        continue;
      }
      failed += 1;
      const cooldown = setLnReceiveClaimCooldown(id, error);
      setReceiveStage(
        "failed",
        {
          pendingCount: getPendingLnurlSwapsCount(),
          claimableCount: claimable,
          claimedCount: claimed,
          settledCount: settled,
          failedCount: failed,
        },
        `id=${id} action=claim_failed`,
      );
      emitTrace({
        atMs: Date.now(),
        op: "ln_receive_manual_claim",
        status: "claim_failed",
        id,
        detail:
          `${truncateForLog(error instanceof Error ? error.message : String(error || "unknown"), 170)} ` +
          `retryMs=${cooldown.retryMs} reason=${cooldown.reason}`,
      });
    } finally {
      claimInFlightSwapIds.delete(id);
    }
  }

  emitTrace({
    atMs: Date.now(),
    op: "ln_receive_manual_claim",
    status: "summary",
    detail: `scanned=${scanIds.length} statuses=${
      Array.from(statusCounts.entries())
        .map(([status, count]) => `${status}:${count}`)
        .join(",") || "none"
    } claimable=${claimable} claimed=${claimed} settled=${settled} final=${final} failed=${failed}`,
  });
  setReceiveStage(
    deriveArkadeReceiveStageStatus({
      pendingCount: getPendingLnurlSwapsCount(),
      claimableCount: claimable,
      claimedCount: claimed,
      settledCount: settled,
      failedCount: failed,
    }),
    {
      pendingCount: getPendingLnurlSwapsCount(),
      claimableCount: claimable,
      claimedCount: claimed,
      settledCount: settled,
      failedCount: failed,
    },
    `source=summary scanned=${scanIds.length} final=${final}`,
  );

  return {
    scanned: scanIds.length,
    claimable,
    claimed,
    settled,
    final,
    failed,
  };
}
