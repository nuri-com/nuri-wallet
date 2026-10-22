// Internal network inference + URL probe helpers shared by prod-tier and debug-tier arkade code.
import type { Network } from "./legacySwapTypes";
// SDK 0.5 renamed `ArkInfo` to `ArkInfo` (same shape, including `fees` and
// `scheduledSession` read below). Aliased so the local `ArkInfoRaw` wire type
// and every usage keep their names.
import type { ArkInfo } from "@arkade-os/sdk";
import { MEMPOOL_API_BASE_URL } from "../../../config/endpoints";
import { errMsg } from "../../../lib/errorMessage";
import { ARKADE_NODE_INFO_TIMEOUT_MS } from "./constants";
import { emitTrace } from "./logging";
import { truncateForLog } from "./utils";

const ARKADE_PROBE_TIMEOUT_MS = 12_000;
const ARKADE_NODE_INFO_RETRIES = 3;
const ARKADE_NODE_INFO_RETRY_DELAY_MS = 700;

type ArkInfoRaw = {
  boardingExitDelay?: number | string | bigint;
  checkpointTapscript?: string;
  deprecatedSigners?: Array<{ cutoffDate?: number | string | bigint; pubkey?: string }>;
  digest?: string;
  dust?: number | string | bigint;
  fees?: { intentFee?: unknown; txFeeRate?: string };
  forfeitAddress?: string;
  forfeitPubkey?: string;
  network?: string;
  scheduledSession?: {
    duration?: number | string | bigint;
    nextStartTime?: number | string | bigint;
    nextEndTime?: number | string | bigint;
    period?: number | string | bigint;
    fees?: unknown;
  };
  serviceStatus?: Record<string, string>;
  sessionDuration?: number | string | bigint;
  signerPubkey?: string;
  unilateralExitDelay?: number | string | bigint;
  utxoMaxAmount?: number | string | bigint;
  utxoMinAmount?: number | string | bigint;
  version?: string;
  vtxoMaxAmount?: number | string | bigint;
  vtxoMinAmount?: number | string | bigint;
};

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export type ArkadeDependencyProbe = {
  target: "node" | "boltz" | "onchain";
  url: string;
  ok: boolean;
  status: string;
  durMs: number;
  error?: string;
};

export function inferArkadeNetwork(nodeUrl: string): Network {
  const url = String(nodeUrl || "").toLowerCase();
  if (url.includes("mutinynet")) return "mutinynet";
  if (url.includes("signet")) return "signet";
  if (url.includes("testnet")) return "testnet";
  if (url.includes("regtest") || url.includes("localhost") || url.includes("127.0.0.1")) {
    return "regtest";
  }
  return "bitcoin";
}

export async function probeUrl(
  target: "node" | "boltz" | "onchain",
  url: string,
): Promise<ArkadeDependencyProbe> {
  const startMs = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ARKADE_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });
    const out: ArkadeDependencyProbe = {
      target,
      url,
      ok: res.ok,
      status: String(res.status),
      durMs: Date.now() - startMs,
      error: res.ok ? undefined : `http_${res.status}`,
    };
    emitTrace({
      atMs: Date.now(),
      op: "net_probe",
      status: out.ok ? "ok" : "fail",
      id: target,
      detail: `status=${out.status} durMs=${out.durMs} url=${out.url}${out.error ? ` err=${out.error}` : ""}`,
    });
    return out;
  } catch (error: unknown) {
    const isAbort =
      typeof error === "object" &&
      error !== null &&
      (error as { name?: unknown }).name === "AbortError";
    const reason = isAbort
      ? `timeout_${ARKADE_PROBE_TIMEOUT_MS}ms`
      : errMsg(error, "network_failed");
    const out: ArkadeDependencyProbe = {
      target,
      url,
      ok: false,
      status: "ERR",
      durMs: Date.now() - startMs,
      error: reason,
    };
    emitTrace({
      atMs: Date.now(),
      op: "net_probe",
      status: "fail",
      id: target,
      detail: `status=ERR durMs=${out.durMs} url=${out.url} err=${reason}`,
    });
    return out;
  } finally {
    clearTimeout(timer);
  }
}

export function getOnchainProbeUrl(network: Network): string | null {
  switch (network) {
    case "bitcoin":
      return `${MEMPOOL_API_BASE_URL}/blocks/tip/height`;
    case "testnet":
      return "https://mempool.space/testnet/api/blocks/tip/height";
    case "signet":
      return "https://mempool.space/signet/api/blocks/tip/height";
    case "mutinynet":
      return "https://mutinynet.com/api/blocks/tip/height";
    case "regtest":
      return null;
    default:
      return `${MEMPOOL_API_BASE_URL}/blocks/tip/height`;
  }
}

export function getOnchainEsploraUrl(network: Network): string | null {
  const probe = getOnchainProbeUrl(network);
  if (!probe) return null;
  return probe.replace(/\/blocks\/tip\/height$/, "");
}

export function buildWalletNodeCandidates(configuredNodeUrl: string): string[] {
  const normalizedConfigured = String(configuredNodeUrl || "")
    .trim()
    .replace(/\/+$/, "");
  return normalizedConfigured ? [normalizedConfigured] : [];
}

export function parseArkNodeInfo(fromServer: ArkInfoRaw): ArkInfo {
  return {
    boardingExitDelay: BigInt(fromServer.boardingExitDelay ?? 0),
    checkpointTapscript: fromServer.checkpointTapscript ?? "",
    deprecatedSigners: Array.isArray(fromServer.deprecatedSigners)
      ? fromServer.deprecatedSigners
          .filter((signer) => signer != null && typeof signer === "object")
          .map((signer) => ({
            cutoffDate: BigInt(signer.cutoffDate ?? 0),
            pubkey: signer.pubkey ?? "",
          }))
      : [],
    digest: fromServer.digest ?? "",
    dust: BigInt(fromServer.dust ?? 0),
    fees: {
      intentFee: (fromServer.fees?.intentFee ?? {}) as ArkInfo["fees"]["intentFee"],
      txFeeRate: fromServer.fees?.txFeeRate ?? "",
    },
    forfeitAddress: fromServer.forfeitAddress ?? "",
    forfeitPubkey: fromServer.forfeitPubkey ?? "",
    network: fromServer.network ?? "",
    scheduledSession:
      fromServer.scheduledSession != null
        ? {
            duration: BigInt(fromServer.scheduledSession.duration ?? 0),
            nextStartTime: BigInt(fromServer.scheduledSession.nextStartTime ?? 0),
            nextEndTime: BigInt(fromServer.scheduledSession.nextEndTime ?? 0),
            period: BigInt(fromServer.scheduledSession.period ?? 0),
            fees: (fromServer.scheduledSession.fees ?? {}) as NonNullable<
              ArkInfo["scheduledSession"]
            >["fees"],
          }
        : undefined,
    serviceStatus: fromServer.serviceStatus ?? {},
    sessionDuration: BigInt(fromServer.sessionDuration ?? 0),
    signerPubkey: fromServer.signerPubkey ?? "",
    unilateralExitDelay: BigInt(fromServer.unilateralExitDelay ?? 0),
    utxoMaxAmount: BigInt(fromServer.utxoMaxAmount ?? -1),
    utxoMinAmount: BigInt(fromServer.utxoMinAmount ?? 0),
    version: fromServer.version ?? "",
    vtxoMaxAmount: BigInt(fromServer.vtxoMaxAmount ?? -1),
    vtxoMinAmount: BigInt(fromServer.vtxoMinAmount ?? 0),
  };
}

/** How long a read of the node's info is reused. It changes rarely (fees,
 *  floors, keys); every send read it fresh and waited for it. */
const NODE_INFO_REUSE_MS = 60_000;
let recentNodeInfo: { nodeUrl: string; at: number; info: Promise<ArkInfo> } | null = null;

/** The node's info, read at most once a minute (a read in flight is shared,
 *  a failed read is not kept). Fetching it ahead (warmArkadeSend) lets a send
 *  that follows skip the wait. */
export function getRecentArkNodeInfo(nodeUrl: string): Promise<ArkInfo> {
  const now = Date.now();
  if (
    recentNodeInfo &&
    recentNodeInfo.nodeUrl === nodeUrl &&
    now - recentNodeInfo.at < NODE_INFO_REUSE_MS
  ) {
    return recentNodeInfo.info;
  }
  const info = fetchArkNodeInfoWithRetry(nodeUrl);
  const entry = { nodeUrl, at: now, info };
  recentNodeInfo = entry;
  info.catch(() => {
    if (recentNodeInfo === entry) recentNodeInfo = null;
  });
  return info;
}

export async function fetchArkNodeInfoWithRetry(nodeUrl: string): Promise<ArkInfo> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= ARKADE_NODE_INFO_RETRIES; attempt += 1) {
    emitTrace({
      atMs: Date.now(),
      op: "wallet_node_info",
      status: "attempt",
      detail: `attempt=${attempt}/${ARKADE_NODE_INFO_RETRIES} timeoutMs=${ARKADE_NODE_INFO_TIMEOUT_MS}`,
    });

    const startMs = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ARKADE_NODE_INFO_TIMEOUT_MS);
    try {
      const res = await fetch(`${nodeUrl}/v1/info`, {
        method: "GET",
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = truncateForLog(String(await res.text()), 120);
        const notReady =
          res.status === 503 && /server not ready|code["']?\s*:\s*14/i.test(String(body));
        throw new Error(`${notReady ? "node_not_ready " : ""}http_${res.status} ${body}`);
      }
      const raw = (await res.json()) as ArkInfoRaw;
      const parsed = parseArkNodeInfo(raw);
      const signerPubkey = String(parsed?.signerPubkey || "");
      const network = String(parsed?.network || "");
      if (!signerPubkey || !network) {
        throw new Error("node info missing signerPubkey/network");
      }
      emitTrace({
        atMs: Date.now(),
        op: "wallet_node_info",
        status: "ok",
        detail: `attempt=${attempt}/${ARKADE_NODE_INFO_RETRIES} durMs=${Date.now() - startMs} net=${network} signer=${signerPubkey.slice(0, 12)}...`,
      });
      return parsed;
    } catch (error: unknown) {
      lastError = error;
      const isAbort =
        typeof error === "object" &&
        error !== null &&
        (error as { name?: unknown }).name === "AbortError";
      const reason = isAbort
        ? `timeout_${ARKADE_NODE_INFO_TIMEOUT_MS}ms`
        : errMsg(error, "unknown");
      const retrying = attempt < ARKADE_NODE_INFO_RETRIES;
      const isNodeNotReady = /node_not_ready|server not ready|http_503/i.test(reason);
      emitTrace({
        atMs: Date.now(),
        op: "wallet_node_info",
        status: retrying ? "retry" : isNodeNotReady ? "blocked" : "failed",
        detail: `attempt=${attempt}/${ARKADE_NODE_INFO_RETRIES} durMs=${Date.now() - startMs} blocker=${isNodeNotReady ? "node_not_ready" : "none"} err=${truncateForLog(reason, 160)}`,
      });
      if (!retrying) break;
      await sleepMs(ARKADE_NODE_INFO_RETRY_DELAY_MS * attempt);
    } finally {
      clearTimeout(timer);
    }
  }

  const finalReason = errMsg(lastError, "unknown");
  const isNodeNotReady = /node_not_ready|server not ready|http_503/i.test(finalReason);
  throw new Error(`node info bootstrap ${isNodeNotReady ? "blocked" : "failed"}: ${finalReason}`);
}
