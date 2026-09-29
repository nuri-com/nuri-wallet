import { ensureSettlementMinExpiryGapMs } from "./ArkadeApiService";
import { readArkadePendingLnurlSwapsCache } from "./ArkadeReceiveOrchestrator";
import { getOrCreateWallet } from "./internal/walletCache";
import { partitionVtxosBySettleability } from "./internal/vtxoSettleability";
import type { ArkadePendingLnurlSwap } from "./types/lnurl";

export type ArkadeRawTransaction = {
  id?: string;
  txid?: string;
  createdAt?: Date | string | number;
  type?: string;
  amount?: number | string;
  settled?: boolean;
  kind?: "offchain" | "boarding" | "exit" | "batch" | "lightning_receive" | "lightning_send";
};

export type UnifiedTransaction = {
  id: string;
  type: "sent" | "received";
  amountSats: number;
  timestamp: number;
  status: "confirmed" | "pending" | "preconfirmed";
  source: "legacy" | "arkade" | "lightning";
  kind?: "offchain" | "boarding" | "exit" | "batch" | "lightning_receive" | "lightning_send";
  txid?: string;
  isMigrationTx?: boolean;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function coerceRawTx(v: unknown): ArkadeRawTransaction {
  if (!isRecord(v)) return {};
  const r = v;
  return {
    id: typeof r.id === "string" ? r.id : undefined,
    txid: typeof r.txid === "string" ? r.txid : undefined,
    createdAt:
      r.createdAt instanceof Date
        ? r.createdAt
        : typeof r.createdAt === "string" || typeof r.createdAt === "number"
          ? r.createdAt
          : undefined,
    type: typeof r.type === "string" ? r.type : undefined,
    amount: typeof r.amount === "number" || typeof r.amount === "string" ? r.amount : undefined,
    settled: typeof r.settled === "boolean" ? r.settled : undefined,
    kind: typeof r.kind === "string" ? (r.kind as ArkadeRawTransaction["kind"]) : undefined,
  };
}

export async function getArkadeTransactionHistory(): Promise<ArkadeRawTransaction[]> {
  const wallet = await getOrCreateWallet();
  try {
    const history: unknown = await wallet.getTransactionHistory();
    if (!Array.isArray(history)) return [];
    return history.map(coerceRawTx);
  } catch {
    return [];
  }
}

// The SDK keeps a tx's ids in `key: { arkTxid, commitmentTxid, boardingTxid }`,
// not in a flat `txid`. Pending sends are stored under the txid `wallet.send()`
// returns (the arkTxid), so reconcile against the full set of key txids.
export async function getArkadeHistoryTxidSet(options?: {
  /** Only rows the wallet reports as settled — a send still in flight is not one. */
  settledOnly?: boolean;
}): Promise<Set<string>> {
  const set = new Set<string>();
  try {
    const wallet = await getOrCreateWallet();
    const history: unknown = await wallet.getTransactionHistory();
    if (!Array.isArray(history)) return set;
    for (const row of history) {
      if (!isRecord(row)) continue;
      if (options?.settledOnly && row.settled !== true) continue;
      const key = isRecord(row.key) ? row.key : null;
      for (const candidate of [key?.arkTxid, key?.commitmentTxid, key?.boardingTxid]) {
        const id = String(candidate || "")
          .trim()
          .toLowerCase();
        if (id) set.add(id);
      }
    }
  } catch {}
  return set;
}

export function getArkadePendingLnurlSwapsSnapshot(): ArkadePendingLnurlSwap[] {
  return readArkadePendingLnurlSwapsCache().map((row) => ({ ...row }));
}

/**
 * The txids of receives whose VTXO is settled but still inside the server's min
 * expiry gap — the money arrived and finalized, yet an offboard cannot spend it
 * for about another day. Those rows read as pending rather than confirmed, so
 * the list matches the balance, which already leaves them out.
 */
async function tooFreshReceiveTxids(): Promise<Set<string>> {
  const txids = new Set<string>();
  try {
    if ((await ensureSettlementMinExpiryGapMs()) === null) return txids;
    const wallet = await getOrCreateWallet();
    const { tooFresh } = partitionVtxosBySettleability(await wallet.getVtxos());
    for (const vtxo of tooFresh) {
      const txid = String((vtxo as { txid?: unknown }).txid || "")
        .trim()
        .toLowerCase();
      if (txid) txids.add(txid);
    }
  } catch {
    // Unknown gap or unreadable wallet — leave every row as it was.
  }
  return txids;
}

export async function getUnifiedTransactionHistory(opts: {
  legacyAddress?: string;
}): Promise<UnifiedTransaction[]> {
  const results: UnifiedTransaction[] = [];

  const tooFreshTxids = await tooFreshReceiveTxids();

  try {
    const arkHistory = await getArkadeTransactionHistory();
    for (const [index, tx] of arkHistory.entries()) {
      results.push({
        // The index keeps the fallback unique. `ark-${createdAt}` alone collides
        // whenever two Arkade rows share a timestamp — seen live as a duplicate
        // React key, and React's own warning says such rows may be "duplicated
        // and/or omitted". A silently missing transaction is not acceptable in a
        // history list. Only the fallback is affected; a real txid still wins.
        id: tx.txid || tx.id || `ark-${tx.createdAt}-${index}`,
        type: String(tx.type).toLowerCase() === "sent" ? "sent" : "received",
        amountSats: Number(tx.amount) || 0,
        timestamp:
          tx.createdAt instanceof Date
            ? tx.createdAt.getTime()
            : typeof tx.createdAt === "number"
              ? tx.createdAt
              : Date.parse(String(tx.createdAt)) || Date.now(),
        status:
          tx.settled &&
          !tooFreshTxids.has(
            String(tx.txid || "")
              .trim()
              .toLowerCase(),
          )
            ? "confirmed"
            : "pending",
        source: "arkade",
        kind: tx.kind || "offchain",
        txid: tx.txid,
        isMigrationTx: false,
      });
    }
  } catch {}

  // Pending LNURL swaps (unpaid invoices the user generated) are intent, not
  // history. They belong in a separate "pending invoices" UI surface, not in
  // tx history. Once paid the swap settles and surfaces as a real arkade
  // history row via getArkadeTransactionHistory().

  results.sort((a, b) => b.timestamp - a.timestamp);

  if (opts.legacyAddress) {
    const firstBoarding = results.find((tx) => tx.kind === "boarding" && tx.type === "received");
    if (firstBoarding) {
      firstBoarding.isMigrationTx = true;
    }
  }

  return results;
}
