// Single entry point for "what transactions do I show in the Bitcoin tx list".
//
// Internally fans out to: legacy onchain (mempool.space via existing fetcher)
// and arkade SDK history. Returns a flat unified array of rows plus the
// per-source raw data the screen needs for source-specific UI (explorer link,
// classification) without re-issuing fetches.
//
// Pending purchases (Mercuryo) are NOT history transactions — they are local
// UI state owned by the screen and stay there.

import { getBitcoinTransactionsCacheKey } from "../balance/transactions/cacheKeys";
import { getCacheValue } from "../balance/TransactionCacheService";
import type { UnifiedTransaction } from "../arkade/ArkadeTransactionHistoryService";
import { priceService } from "../pricing/PriceService";
import type { AddressTx } from "../../types/bitcoin";
import { classifyTransaction } from "../../lib/bitcoin/convert";
import { getBtcL2Provider, getBtcL2ProviderFor } from "./providers/registry";
import { walletService } from "./WalletService";
import type { BtcL2GetTransactionsResult } from "./BtcL2Provider";

export type BitcoinTransactionSource = "legacy" | "arkade";

export type BitcoinTransaction = {
  id: string;
  source: BitcoinTransactionSource;
  type: "received" | "sent";
  amountSats: number;
  /** Unix milliseconds. */
  timestamp: number;
  status: "confirmed" | "pending" | "preconfirmed";
  txid?: string;
  kind?: UnifiedTransaction["kind"];
  isMigrationTx?: boolean;
};

export type GetBitcoinTransactionsOptions = {
  address?: string;
  /**
   * "head" calls the incremental legacy refresher; "full" forces a full
   * legacy fetch (cache prime). Arkade is always full each call.
   */
  legacyMode?: "head" | "full";
  /**
   * If true, prefetches fiat prices for every row's timestamp so the screen
   * mapper can synchronously read getCachedPriceAt and bake the fiat string
   * into rows without a second async pass.
   */
  prefetchFiatPrices?: boolean;
};

/**
 * A raw on-chain tx paired with the wallet address that classifies it. Two
 * independent on-chain addresses feed the list — the Arkade boarding address
 * and the MuSig2 wallet's own — and `classifyTransaction` bills a tx against
 * exactly one of them: classifying a MuSig2 tx against the boarding address
 * reports a phantom send. The pairing keeps each tx with the only address that
 * reads it correctly.
 */
export type LegacyOnchainTx = { tx: AddressTx; address: string };

/**
 * Shared key space for the MuSig2 rail while de-duplicating: every address of
 * that one wallet keys to the rail rather than to itself, so a tx more than one
 * of them returns is a single event. No address can equal it.
 */
const MUSIG2_RAIL_KEY = "musig2";

export type BitcoinTransactionsResult = {
  rows: BitcoinTransaction[];
  /** Unfiltered union of what the default provider returned for `opts.address` and that address's db cache (raw). */
  legacyRaw: AddressTx[];
  /** Every on-chain tx that is safe to render, each with its own classifying address: one row per address and txid, minus Arkade commitment txs and minus the rows deduped against Arkade-received rows. The MuSig2 wallet counts as one rail here whatever its addresses, so a tx more than one of them returns is a single row. */
  legacyFiltered: LegacyOnchainTx[];
  /** Whether the legacy fetch was a full fetch (used to decide head vs full next time). */
  isFullCache: boolean;
  /** Non-fatal legacy fetch error (other sources can still have populated rows). */
  error: string | null;
};

/**
 * Reject Arkade server commitment / batch-swap transactions that have the
 * user's address as one input among many. classifyTransaction (single-user
 * wallet logic) mis-bills the server's outputs as huge phantom user sends.
 * A real user-initiated tx either has only user inputs (a send with change)
 * or only non-user inputs (an incoming receive).
 */
function isArkadeCommitmentTx(t: AddressTx, address: string): boolean {
  const vin = t?.vin || [];
  let hasUserInput = false;
  let hasNonUserInput = false;
  for (const v of vin) {
    const a = v?.prevout?.scriptpubkey_address;
    if (!a) continue;
    if (a === address) hasUserInput = true;
    else hasNonUserInput = true;
    if (hasUserInput && hasNonUserInput) return true;
  }
  return false;
}

function legacyRowToTransaction(t: AddressTx, address: string): BitcoinTransaction | null {
  const txid = String(t?.txid || "").trim();
  if (!txid) return null;
  if (isArkadeCommitmentTx(t, address)) return null;
  const display = classifyTransaction(t, address);
  const blockTime = t?.status?.block_time;
  return {
    id: txid,
    source: "legacy",
    type: display.isIncoming ? "received" : "sent",
    amountSats: Math.max(0, Math.trunc(display.amountSats || 0)),
    timestamp: blockTime ? blockTime * 1000 : Date.now(),
    status: t?.status?.confirmed ? "confirmed" : "pending",
    txid,
  };
}

async function prefetchPrices(rows: BitcoinTransaction[]): Promise<void> {
  const stamps = rows
    .filter((r) => r.status !== "pending" && r.timestamp > 0)
    .map((r) => Math.floor(r.timestamp / 1000));
  if (stamps.length === 0) return;
  try {
    await priceService.getPriceForBatch(stamps);
  } catch {}
}

export async function getBitcoinTransactions(
  opts: GetBitcoinTransactionsOptions,
): Promise<BitcoinTransactionsResult> {
  const address = (opts.address || "").trim();
  const legacyMode = opts.legacyMode ?? "head";

  type CachedLegacyResult = { txs: AddressTx[]; error: string | null };
  const providerTask = getBtcL2Provider().getTransactions({
    address,
    legacyMode,
  });

  // The MuSig2 L1 wallet is a second, independent rail. app.nuri.com reads
  // only its current v4 address; legacy history belongs to the external
  // migration product, not this app.
  const addressSnapshot = walletService.getAddressSnapshot();
  const musig2Addresses = [addressSnapshot.musig2Address.trim()].filter(Boolean);
  const onchainTasks: Promise<BtcL2GetTransactionsResult>[] = musig2Addresses.map((addr) =>
    getBtcL2ProviderFor("onchain")
      .getTransactions({ address: addr, legacyMode })
      .catch(
        (e: unknown): BtcL2GetTransactionsResult => ({
          rows: [],
          legacyRaw: [],
          isFullCache: false,
          // Reported, not swallowed: an empty result with no error is
          // indistinguishable from "this wallet has no transactions", and
          // callers then persist the emptiness.
          error: e instanceof Error ? e.message : "onchain history failed",
        }),
      ),
  );

  // Every on-chain address whose history feeds this list, in display order and
  // read exactly once. `opts.address` is the boarding address on the Arkade
  // rail but musig2Address itself on the on-chain one, so without the Set that
  // single address becomes two rails reading the same db cache — and every row
  // it holds is rendered, and exported, twice.
  const railAddresses = Array.from(new Set([address, ...musig2Addresses].filter(Boolean)));

  const readCachedLegacy = async (addr: string): Promise<CachedLegacyResult> => {
    try {
      const cacheKey = getBitcoinTransactionsCacheKey(addr);
      const cached = cacheKey ? await getCacheValue<AddressTx[]>(cacheKey) : null;
      return { txs: Array.isArray(cached) ? cached : [], error: null };
    } catch (e: unknown) {
      return { txs: [], error: e instanceof Error ? e.message : "cached history unavailable" };
    }
  };

  const [providerResult, onchainResults, cachedResults] = await Promise.all([
    providerTask,
    Promise.all(onchainTasks),
    Promise.all(railAddresses.map(readCachedLegacy)),
  ]);

  const onchainByAddress = new Map(musig2Addresses.map((addr, i) => [addr, onchainResults[i]]));
  const cachedByAddress = new Map(railAddresses.map((addr, i) => [addr, cachedResults[i]]));

  const legacyRaw = [
    ...(providerResult.legacyRaw ?? []),
    ...(cachedByAddress.get(address)?.txs ?? []),
  ];

  const rows: BitcoinTransaction[] = [
    ...providerResult.rows,
    ...onchainResults.flatMap((r) => r.rows),
  ];

  // A boarding deposit is the same money twice: once in the Arkade history,
  // once in the boarding address's on-chain history. The Arkade row carries no
  // txid to match on, so amount plus minute (± one, for clock skew) is the key.
  const arkadeReceivedKeys = new Set<string>();
  for (const r of rows) {
    if (r.source === "arkade" && r.type === "received") {
      const tsMin = Math.floor(r.timestamp / 60_000);
      arkadeReceivedKeys.add(`${r.amountSats}|${tsMin}`);
      arkadeReceivedKeys.add(`${r.amountSats}|${tsMin - 1}`);
      arkadeReceivedKeys.add(`${r.amountSats}|${tsMin + 1}`);
    }
  }

  // One pass per rail over everything read for that address: the default
  // provider's raw txs, the on-chain fetch and the db cache.
  // `legacyOnchainProvider` hands its txs back raw and leaves `rows` empty for
  // this function to classify, so without this pass the fetch happens and
  // nothing of it is ever shown. The cache is unioned in rather than kept as a
  // fallback — a head refresh returns the tip and already merges this same
  // cache into its own result, and `seen` collapses the overlap — but it must
  // be read, or a mempool.space rate-limit on one address wipes that rail from
  // the list.
  //
  // `seen` is keyed per rail, so a tx involving two rails still renders on each
  // of them, once as the send and once as the receive. The MuSig2 rail's
  // addresses share one key, so a tx more than one of their histories return is
  // rendered once rather than per address.
  const legacyFiltered: LegacyOnchainTx[] = [];
  const seen = new Set<string>();
  for (const railAddress of railAddresses) {
    const railKey = musig2Addresses.includes(railAddress) ? MUSIG2_RAIL_KEY : railAddress;
    const raw = [
      ...(railAddress === address ? (providerResult.legacyRaw ?? []) : []),
      ...(onchainByAddress.get(railAddress)?.legacyRaw ?? []),
      ...(cachedByAddress.get(railAddress)?.txs ?? []),
    ];
    for (const tx of raw) {
      const row = legacyRowToTransaction(tx, railAddress);
      if (!row) continue;
      const key = `${railKey}|${row.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (railAddress === address && row.type === "received") {
        const tsMin = Math.floor(row.timestamp / 60_000);
        if (arkadeReceivedKeys.has(`${row.amountSats}|${tsMin}`)) continue;
      }
      rows.push(row);
      legacyFiltered.push({ tx, address: railAddress });
    }
  }

  if (opts.prefetchFiatPrices) {
    await prefetchPrices(rows);
  }

  return {
    rows,
    legacyRaw,
    legacyFiltered,
    isFullCache: providerResult.isFullCache,
    error:
      providerResult.error ??
      (onchainResults.find((r) => r.error)?.error || null) ??
      (cachedResults.find((c) => c.error)?.error || null),
  };
}
