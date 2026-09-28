// Internal VTXO debug-line formatting shared by prod-tier and debug-tier arkade code.
import { isPastExpiry, type VirtualCoin } from "@arkade-os/sdk";

// SDK 0.5 removed `isExpired`. Its body was
// `n.isSwept || (n.expiresAt !== undefined && n.expiresAt.getTime() <= Date.now())`
// (sdk 0.4.62). `isPastExpiry` covers the expiry half and now takes the clock
// explicitly; the swept half is restored here so this stays the same predicate.
const isExpired = (coin: VirtualCoin): boolean =>
  Boolean((coin as { isSwept?: boolean }).isSwept) || isPastExpiry(coin, { timestamp: new Date() });
import { MEMPOOL_API_BASE_URL } from "../../../config/endpoints";
import { errMsg } from "../../../lib/errorMessage";
import { isRecord, truncateForLog } from "./utils";

function normalizeArkadeExpiryMs(value: unknown): number {
  const raw = Number(value || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw < 10_000_000_000 ? Math.trunc(raw * 1000) : Math.trunc(raw);
}

function formatArkadeExpiry(value: unknown): string {
  const raw = Number(value || 0);
  if (!Number.isFinite(raw) || raw <= 0) return "none";
  const ms = normalizeArkadeExpiryMs(raw);
  const iso = ms > 0 ? new Date(ms).toISOString() : "n/a";
  return `${iso}/raw=${Math.trunc(raw)}`;
}

function normalizeArkadeCreatedMs(value: unknown): number {
  const raw = Number(value || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw < 10_000_000_000 ? Math.trunc(raw * 1000) : Math.trunc(raw);
}

function formatArkadeCreated(value: unknown): string {
  const ms = normalizeArkadeCreatedMs(value);
  return ms > 0 ? new Date(ms).toISOString() : "n/a";
}

function formatDurationHours(ms: number): string {
  if (!Number.isFinite(ms)) return "n/a";
  const sign = ms < 0 ? "-" : "";
  const totalMinutes = Math.floor(Math.abs(ms) / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${sign}${hours}h${minutes}m`;
}

function getVtxoState(coin: unknown): string {
  const record = isRecord(coin) ? coin : null;
  const virtualStatus = record && isRecord(record.virtualStatus) ? record.virtualStatus : null;
  return String(virtualStatus?.state || "")
    .trim()
    .toLowerCase();
}

function getVtxoCreatedMs(coin: unknown): number {
  const record = isRecord(coin) ? coin : null;
  const createdAt = record?.createdAt;
  if (createdAt instanceof Date) return createdAt.getTime();
  return normalizeArkadeCreatedMs(createdAt);
}

function getVtxoCommitmentTxids(coin: unknown): string[] {
  const record = isRecord(coin) ? coin : null;
  const virtualStatus = record && isRecord(record.virtualStatus) ? record.virtualStatus : null;
  const raw = virtualStatus?.commitmentTxIds;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => String(item || "").trim())
    .filter((item) => /^[0-9a-fA-F]{64}$/.test(item));
}

async function fetchCommitmentTxStatus(txid: string): Promise<string> {
  const short = `${txid.slice(0, 12)}...`;
  try {
    const res = await fetch(`${MEMPOOL_API_BASE_URL}/tx/${encodeURIComponent(txid)}/status`);
    if (!res.ok) return `${short}=http_${res.status}`;
    const data: unknown = await res.json();
    const record = isRecord(data) ? data : null;
    if (record?.confirmed) {
      return `${short}=confirmed:${String(record?.block_height || "n/a")}`;
    }
    return `${short}=mempool`;
  } catch (error: unknown) {
    return `${short}=unknown:${truncateForLog(errMsg(error, "fetch_failed"), 48)}`;
  }
}

export function formatVtxoDebugLine(coin: unknown): string {
  const record = isRecord(coin) ? coin : {};
  const txid = String(record.txid || "n/a");
  const vout = Number.isFinite(Number(record.vout)) ? Math.trunc(Number(record.vout)) : 0;
  const value = Number(record.value || 0);
  const state = getVtxoState(coin) || "n/a";
  const virtualStatus = isRecord(record.virtualStatus) ? record.virtualStatus : null;
  const expiryRaw = virtualStatus?.batchExpiry;
  let expired = false;
  try {
    expired = isExpired(coin as VirtualCoin);
  } catch {}
  const spendable = !record.isSpent && !expired;
  return [
    `id=${txid.slice(0, 12)}:${vout}`,
    `value=${Number.isFinite(value) ? Math.trunc(value) : 0}`,
    `state=${state}`,
    `spendable=${spendable ? 1 : 0}`,
    `spent=${record.isSpent ? 1 : 0}`,
    `unrolled=${record.isUnrolled ? 1 : 0}`,
    `expiry=${formatArkadeExpiry(expiryRaw)}`,
  ].join(" ");
}

export async function formatPendingVtxoDebugLine(coin: unknown): Promise<string> {
  const record = isRecord(coin) ? coin : {};
  const txid = String(record.txid || "n/a");
  const vout = Number.isFinite(Number(record.vout)) ? Math.trunc(Number(record.vout)) : 0;
  const value = Number(record.value || 0);
  const createdMs = getVtxoCreatedMs(coin);
  const ageMs = createdMs > 0 ? Date.now() - createdMs : 0;
  const commitments = getVtxoCommitmentTxids(coin);
  const commitmentStatuses = await Promise.all(
    commitments.slice(0, 3).map(fetchCommitmentTxStatus),
  );
  return [
    `id=${txid.slice(0, 12)}:${vout}`,
    `value=${Number.isFinite(value) ? Math.trunc(value) : 0}`,
    `origin=${txid.slice(0, 12)}:${vout}`,
    `created=${formatArkadeCreated(createdMs)}`,
    `age=${formatDurationHours(ageMs)}`,
    `commitments=${commitmentStatuses.join(",") || "none"}`,
    `spent=${record.isSpent ? 1 : 0}`,
    `settledBy=${String(record.settledBy || "none").slice(0, 12)}`,
  ].join(" ");
}
