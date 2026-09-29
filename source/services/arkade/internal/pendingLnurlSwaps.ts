// Module-state cache for the live pending-LNURL-swap rows the receive flow
// auto-claim loop consumes. State lives here (not in the orchestrator or a
// debug service) so prod-tier receive code and the orchestrator can read it
// without any DI plumbing.
import type { ArkadeLnurlPendingSwap, ArkadeReceiveLightningRow } from "../ArkadeApiService";
import type { ArkadePendingLnurlSwap, ArkadePendingLnurlSwapRestore } from "../types/lnurl";
import { parseInvoicePrefix } from "./lightningHelpers";
import { logArkadeWalletSignTrace } from "./logging";
import { isReverseClaimableStatus } from "./reverseSwapClaim";

let cachedPendingLnurlSwaps: ArkadePendingLnurlSwap[] = [];
let cachedPendingLnurlSwapsUpdatedAtMs = 0;

type PendingLnurlSwapSource = ArkadeLnurlPendingSwap | ArkadeReceiveLightningRow;

function sourceRecord(row: PendingLnurlSwapSource): Record<string, unknown> {
  return row && typeof row === "object" ? (row as Record<string, unknown>) : {};
}

function stripLightningReceiveId(value: unknown): string {
  const raw = String(value || "").trim();
  return raw.startsWith("lightning:") ? raw.slice("lightning:".length) : raw;
}

function readSwapId(row: PendingLnurlSwapSource): string {
  const source = sourceRecord(row);
  return (
    String(source.swap_id || "").trim() ||
    stripLightningReceiveId(source.receive_id) ||
    stripLightningReceiveId(source.id)
  );
}

function cloneRestore(value: unknown): ArkadePendingLnurlSwapRestore | null {
  if (!value || typeof value !== "object") return null;
  const restore = value as Record<string, unknown>;
  const id = String(restore.id || "").trim();
  const preimage = String(restore.preimage || "")
    .trim()
    .toLowerCase();
  if (!id || !preimage) return null;
  const request =
    restore.request && typeof restore.request === "object"
      ? { ...(restore.request as Record<string, unknown>) }
      : null;
  const response =
    restore.response && typeof restore.response === "object"
      ? { ...(restore.response as Record<string, unknown>) }
      : null;
  return {
    id,
    type: "reverse",
    createdAt: Number(restore.createdAt || 0),
    preimage,
    status: String(restore.status || ""),
    request,
    response,
  };
}

function clonePendingLnurlSwap(row: ArkadePendingLnurlSwap): ArkadePendingLnurlSwap {
  return {
    ...row,
    restore: cloneRestore(row.restore),
  };
}

function mapPendingLnurlSwap(row: PendingLnurlSwapSource): ArkadePendingLnurlSwap {
  const source = sourceRecord(row);
  const amountMsat = Number(row?.amount_msat || 0);
  const restore = cloneRestore(source.restore);
  const preimageHex = String(source.preimage_hex || restore?.preimage || "")
    .trim()
    .toLowerCase();
  return {
    id: readSwapId(row),
    username: String(row?.username || ""),
    invoice: String(source.invoice || ""),
    preimageHex,
    preimageHashHex: String(source.preimage_hash_hex || source.payment_hash_hex || "")
      .trim()
      .toLowerCase(),
    amountSats: Math.max(0, Math.trunc(amountMsat / 1000)),
    amountMsat,
    status: String(source.boltz_status || source.status || ""),
    invoicePrefix: parseInvoicePrefix(String(row?.invoice || "")),
    createdAtMs: Number(row?.created_at_ms || 0),
    updatedAtMs: Number(row?.updated_at_ms || 0),
    restore,
  };
}

export function setPendingLnurlSwaps(rows: PendingLnurlSwapSource[]): ArkadePendingLnurlSwap[] {
  cachedPendingLnurlSwapsUpdatedAtMs = Date.now();
  cachedPendingLnurlSwaps = rows
    .map((row) => mapPendingLnurlSwap(row))
    .filter((row) => row.id)
    .sort((a, b) => {
      const byUpdated = b.updatedAtMs - a.updatedAtMs;
      if (byUpdated !== 0) return byUpdated;
      return b.createdAtMs - a.createdAtMs;
    });
  const unpaidCount = cachedPendingLnurlSwaps.filter((row) => row.status === "swap.created").length;
  const claimableCount = cachedPendingLnurlSwaps.filter((row) =>
    isReverseClaimableStatus(row.status),
  ).length;
  const lnReceivePendingCount = Math.max(0, cachedPendingLnurlSwaps.length - claimableCount);
  if (cachedPendingLnurlSwaps.length > 0) {
    logArkadeWalletSignTrace("lnurl_pending_snapshot", {
      status: "updated",
      ln_receive_pending_count: lnReceivePendingCount,
      ln_receive_claimable_count: claimableCount,
      unpaid_swap_created: unpaidCount,
      expected_next: claimableCount > 0 ? "unlock_wallet_manual_runner" : "idle_no_sign",
    });
  }
  return cachedPendingLnurlSwaps.map(clonePendingLnurlSwap);
}

export function setPendingLnurlSwapsFromReceiveRows(
  rows: ArkadeReceiveLightningRow[],
): ArkadePendingLnurlSwap[] {
  return setPendingLnurlSwaps(rows);
}

export function dropPendingLnurlSwaps(ids: string[]): void {
  if (ids.length === 0 || cachedPendingLnurlSwaps.length === 0) return;
  const remove = new Set(ids.map((id) => String(id || "").trim()).filter(Boolean));
  if (remove.size === 0) return;
  cachedPendingLnurlSwaps = cachedPendingLnurlSwaps.filter((row) => !remove.has(row.id));
}

export function readPendingLnurlSwapsCache(): ArkadePendingLnurlSwap[] {
  return cachedPendingLnurlSwaps.map(clonePendingLnurlSwap);
}

export function getPendingLnurlSwapsCount(): number {
  return cachedPendingLnurlSwaps.length;
}

export function getPendingLnurlSwapsCacheAgeMs(nowMs = Date.now()): number {
  return cachedPendingLnurlSwapsUpdatedAtMs > 0
    ? Math.max(0, nowMs - cachedPendingLnurlSwapsUpdatedAtMs)
    : Number.POSITIVE_INFINITY;
}

export function resetPendingLnurlSwapsCache(): void {
  cachedPendingLnurlSwaps = [];
  cachedPendingLnurlSwapsUpdatedAtMs = 0;
}
