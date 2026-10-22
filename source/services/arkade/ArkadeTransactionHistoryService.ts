import { readArkadePendingLnurlSwapsCache } from "./ArkadeReceiveOrchestrator";
import {
  arkadeCounterparties,
  arkAddressForScript,
  arkAddressScript,
  type Counterparty,
} from "./arkadeCounterparty";
import { getOrCreateWallet } from "./internal/walletCache";
import type { ArkadePendingLnurlSwap } from "./types/lnurl";

export type ArkadeRawTransaction = {
  id?: string;
  txid?: string;
  createdAt?: Date | string | number;
  type?: string;
  amount?: number | string;
  settled?: boolean;
  /** An on-chain deposit into Arkade (the SDK's `key.boardingTxid`). */
  boarding?: boolean;
  /** That deposit's onchain txid. */
  boardingTxid?: string;
  /** The offchain transaction (the SDK's `key.arkTxid`). */
  arkTxid?: string;
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
  /** The other party's output scripts (hex), for naming a saved contact. */
  counterpartyScripts?: string[];
  /** The same as Ark addresses, for the Nuri names lookup (#1782). */
  counterpartyAddresses?: string[];
  /** An onchain deposit into Arkade (the SDK's `key.boardingTxid`). The SDK
   * tags it, it sets no `kind`, so this is what says boarding. */
  boarding?: true;
  /** That deposit's onchain txid: the one onchain receive this row is. */
  boardingTxid?: string;
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
    boarding:
      isRecord(r.key) && typeof r.key.boardingTxid === "string" && r.key.boardingTxid !== "",
    boardingTxid:
      isRecord(r.key) && typeof r.key.boardingTxid === "string" && r.key.boardingTxid
        ? r.key.boardingTxid.toLowerCase()
        : undefined,
    arkTxid:
      isRecord(r.key) && typeof r.key.arkTxid === "string" && r.key.arkTxid
        ? r.key.arkTxid
        : undefined,
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

/** Whether the Ark indexer has this offchain transaction; null when unreadable. */
export async function isArkadeVirtualTxKnown(txid: string): Promise<boolean | null> {
  try {
    const wallet = (await getOrCreateWallet()) as unknown as {
      indexerProvider?: { getVirtualTxs(txids: string[]): Promise<{ txs?: unknown[] }> };
    };
    if (!wallet.indexerProvider) return null;
    const { txs } = await wallet.indexerProvider.getVirtualTxs([txid]);
    return Array.isArray(txs) && txs.length > 0;
  } catch {
    return null;
  }
}

export function getArkadePendingLnurlSwapsSnapshot(): ArkadePendingLnurlSwap[] {
  return readArkadePendingLnurlSwapsCache().map((row) => ({ ...row }));
}

/**
 * Both sides of each offchain payment, keyed by arkTxid, and the wallet's own
 * Ark address (to write the other side's scripts as addresses); empty on any
 * failure.
 */
async function counterpartiesOf(
  history: ArkadeRawTransaction[],
): Promise<{ parties: Map<string, Counterparty>; ownAddress: string }> {
  const none = { parties: new Map<string, Counterparty>(), ownAddress: "" };
  const txids = history.flatMap((tx) => (tx.arkTxid ? [tx.arkTxid] : []));
  if (txids.length === 0) return none;
  try {
    const wallet = await getOrCreateWallet();
    const ownAddress = String((await wallet.getAddress()) || "");
    const own = arkAddressScript(ownAddress);
    if (!own) return none;
    const parties = await arkadeCounterparties(wallet.indexerProvider, txids, new Set([own]));
    return { parties, ownAddress };
  } catch {
    return none;
  }
}

function counterpartyFor(
  tx: ArkadeRawTransaction,
  parties: Map<string, Counterparty>,
): string[] | undefined {
  const party = tx.arkTxid ? parties.get(tx.arkTxid.toLowerCase()) : undefined;
  if (!party) return undefined;
  return String(tx.type).toLowerCase() === "sent" ? party.paidTo : party.paidFrom;
}

export async function getUnifiedTransactionHistory(opts: {
  legacyAddress?: string;
}): Promise<UnifiedTransaction[]> {
  const results: UnifiedTransaction[] = [];

  try {
    const arkHistory = await getArkadeTransactionHistory();
    const { parties, ownAddress } = await counterpartiesOf(arkHistory);
    for (const [index, tx] of arkHistory.entries()) {
      const scripts = counterpartyFor(tx, parties);
      const addresses = (scripts ?? []).flatMap((script) => {
        const address = arkAddressForScript(script, ownAddress);
        return address ? [address] : [];
      });
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
        // A received Arkade payment is in the wallet the moment it lands,
        // preconfirmed or not; an onchain deposit still waiting to board is
        // not. A send stays pending until it settles.
        status:
          tx.settled || (String(tx.type).toLowerCase() !== "sent" && !tx.boarding)
            ? "confirmed"
            : "pending",
        source: "arkade",
        kind: tx.kind || "offchain",
        txid: tx.txid,
        isMigrationTx: false,
        // A receive is named by who paid, a send by who got paid.
        ...(tx.boarding ? { boarding: true as const } : {}),
        ...(tx.boardingTxid ? { boardingTxid: tx.boardingTxid } : {}),
        counterpartyScripts: scripts,
        ...(addresses.length > 0 ? { counterpartyAddresses: addresses } : {}),
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
