import { BTC_PREFETCH_TTL_MS, BTC_AUTO_HEAD_REFRESH_TTL_MS } from "../../../config/constants";
import type { AddressTx } from "../../../types/bitcoin";
import { blockchainService } from "../../bitcoin/BlockchainService";
import { EventBus } from "../../events/AppEventBusService";
import { getCacheValue, setCacheValue } from "../TransactionCacheService";
import { bumpNetworkSource } from "../../logging/NetworkLogger";
import { getBitcoinTransactionsCacheKey, getBitcoinTransactionsMetaCacheKey } from "./cacheKeys";

export type BitcoinTransactionsFetchParams = {
  address?: string | null;
  auto?: boolean;
};

export type BitcoinTransactionsFetchResult = {
  txs: AddressTx[] | null;
  error: string | null;
};

const lastBtcPrefetchAt = new Map<string, number>();
const lastBtcAutoHeadRefreshAt = new Map<string, number>();

const normalizeBtcTxid = (t: AddressTx | null | undefined): string => {
  const raw = t?.txid ? String(t.txid) : "";
  return raw.trim().toLowerCase();
};

const mergeBitcoinTxHead = (
  head: AddressTx[] | null | undefined,
  cached: AddressTx[] | null | undefined,
): AddressTx[] => {
  const headList = Array.isArray(head) ? head : [];
  const cachedList = Array.isArray(cached) ? cached : [];
  const out: AddressTx[] = [];
  const seen = new Set<string>();

  for (const tx of headList) {
    const txid = normalizeBtcTxid(tx);
    if (!txid || seen.has(txid)) continue;
    seen.add(txid);
    out.push(tx);
  }

  for (const tx of cachedList) {
    const txid = normalizeBtcTxid(tx);
    if (!txid || seen.has(txid)) continue;
    if (!tx?.status?.confirmed) continue;
    seen.add(txid);
    out.push(tx);
  }

  return out;
};

const computeBitcoinMempoolNetSats = (txs: AddressTx[], address: string): number => {
  const addrKey = String(address || "")
    .trim()
    .toLowerCase();
  if (!addrKey) return 0;
  const list = Array.isArray(txs) ? txs : [];
  let net = 0;
  for (const t of list) {
    if (t?.status?.confirmed) continue;
    const vin = Array.isArray(t?.vin) ? t.vin : [];
    const vout = Array.isArray(t?.vout) ? t.vout : [];
    let spent = 0;
    let received = 0;
    for (const input of vin) {
      const a = input?.prevout?.scriptpubkey_address;
      if (!a) continue;
      if (String(a).trim().toLowerCase() !== addrKey) continue;
      const v = Number(input?.prevout?.value ?? 0);
      if (Number.isFinite(v)) spent += v;
    }
    for (const out of vout) {
      const a = out?.scriptpubkey_address;
      if (!a) continue;
      if (String(a).trim().toLowerCase() !== addrKey) continue;
      const v = Number(out?.value ?? 0);
      if (Number.isFinite(v)) received += v;
    }
    net += received - spent;
  }
  return Number.isFinite(net) ? Math.trunc(net) : 0;
};

const computeBitcoinPendingIncomingTxid = (txs: AddressTx[], address: string): string | null => {
  const addrKey = String(address || "")
    .trim()
    .toLowerCase();
  if (!addrKey) return null;
  const list = Array.isArray(txs) ? txs : [];
  for (const t of list) {
    if (t?.status?.confirmed) continue;
    const txid = String(t?.txid || "").trim();
    if (!txid) continue;
    const vin = Array.isArray(t?.vin) ? t.vin : [];
    const vout = Array.isArray(t?.vout) ? t.vout : [];
    let spent = 0;
    let received = 0;
    for (const input of vin) {
      const a = input?.prevout?.scriptpubkey_address;
      if (!a) continue;
      if (String(a).trim().toLowerCase() !== addrKey) continue;
      const v = Number(input?.prevout?.value ?? 0);
      if (Number.isFinite(v)) spent += v;
    }
    for (const out of vout) {
      const a = out?.scriptpubkey_address;
      if (!a) continue;
      if (String(a).trim().toLowerCase() !== addrKey) continue;
      const v = Number(out?.value ?? 0);
      if (Number.isFinite(v)) received += v;
    }
    const txNet = received - spent;
    if (Number.isFinite(txNet) && txNet > 0) return txid;
  }
  return null;
};

const btcHeadRefreshInFlight = new Map<string, Promise<AddressTx[]>>();

export async function fetchBitcoinTransactions(
  params: BitcoinTransactionsFetchParams,
): Promise<BitcoinTransactionsFetchResult> {
  const address = (params.address ?? "").trim();
  if (!address) {
    return { txs: [], error: null };
  }
  bumpNetworkSource("bitcoin:txs:fetch");
  try {
    const list = await blockchainService.fetchAllAddressTransactions(address);
    const cacheKey = getBitcoinTransactionsCacheKey(address);
    if (cacheKey) {
      try {
        await setCacheValue(cacheKey, list);
      } catch {}
    }
    const metaKey = getBitcoinTransactionsMetaCacheKey(address);
    if (metaKey) {
      try {
        await setCacheValue(metaKey, true);
      } catch {}
    }
    try {
      const mempoolNetSats = computeBitcoinMempoolNetSats(list, address);
      const pendingIncomingTxid = computeBitcoinPendingIncomingTxid(list, address);
      EventBus.emit("bitcoin:mempoolNet", {
        address,
        mempoolNetSats,
        pendingIncomingTxid,
      });
    } catch {}
    return { txs: list, error: null };
  } catch (e) {
    return {
      txs: null,
      error: e instanceof Error ? e.message : "Failed to load transactions",
    };
  }
}

export async function refreshBitcoinTransactionsHead(
  params: BitcoinTransactionsFetchParams,
): Promise<BitcoinTransactionsFetchResult> {
  const address = (params.address ?? "").trim();
  const cacheKey = getBitcoinTransactionsCacheKey(address);
  const metaKey = getBitcoinTransactionsMetaCacheKey(address);
  if (!address || !cacheKey) {
    return { txs: [], error: null };
  }

  if (params.auto) {
    const now = Date.now();
    const lastAt = lastBtcAutoHeadRefreshAt.get(cacheKey) ?? 0;
    if (now - lastAt < BTC_AUTO_HEAD_REFRESH_TTL_MS) {
      try {
        const cached = await getCacheValue<AddressTx[]>(cacheKey);
        if (Array.isArray(cached)) {
          return { txs: cached, error: null };
        }
      } catch {}
    }
    lastBtcAutoHeadRefreshAt.set(cacheKey, now);
  }

  const inFlight = btcHeadRefreshInFlight.get(cacheKey);
  if (inFlight) {
    try {
      const list = await inFlight;
      return { txs: list, error: null };
    } catch (e) {
      return {
        txs: null,
        error: e instanceof Error ? e.message : "Failed to refresh transactions",
      };
    }
  }

  const run = (async () => {
    bumpNetworkSource("bitcoin:txs:head");
    const head = await blockchainService.fetchAddressTransactions(address);
    let cached: AddressTx[] | null = null;
    let isFull = false;
    try {
      cached = await getCacheValue<AddressTx[]>(cacheKey);
    } catch {}
    if (metaKey) {
      try {
        const meta = await getCacheValue<boolean>(metaKey);
        if (typeof meta === "boolean") {
          isFull = meta;
        } else {
          // Backfill existing full caches from older app versions.
          isFull = Array.isArray(cached) && cached.length > 0;
        }
      } catch {
        isFull = Array.isArray(cached) && cached.length > 0;
      }
    }
    const merged = mergeBitcoinTxHead(head, cached);
    try {
      await setCacheValue(cacheKey, merged);
    } catch {}
    if (metaKey) {
      try {
        await setCacheValue(metaKey, isFull);
      } catch {}
    }
    try {
      const mempoolNetSats = computeBitcoinMempoolNetSats(head, address);
      const pendingIncomingTxid = computeBitcoinPendingIncomingTxid(head, address);
      EventBus.emit("bitcoin:mempoolNet", {
        address,
        mempoolNetSats,
        pendingIncomingTxid,
      });
    } catch {}
    return merged;
  })();

  btcHeadRefreshInFlight.set(cacheKey, run);
  try {
    const list = await run;
    return { txs: list, error: null };
  } catch (e) {
    return { txs: null, error: e instanceof Error ? e.message : "Failed to refresh transactions" };
  } finally {
    btcHeadRefreshInFlight.delete(cacheKey);
  }
}

export async function prefetchBitcoinTransactionsIfNeeded(
  params: BitcoinTransactionsFetchParams,
): Promise<void> {
  const cacheKey = getBitcoinTransactionsCacheKey(params.address ?? null);
  if (!cacheKey) return;
  try {
    const cached = await getCacheValue<AddressTx[]>(cacheKey);
    if (Array.isArray(cached) && cached.length > 0) {
      return;
    }
  } catch {}
  const now = Date.now();
  const lastAt = lastBtcPrefetchAt.get(cacheKey) ?? 0;
  if (now - lastAt < BTC_PREFETCH_TTL_MS) {
    return;
  }
  lastBtcPrefetchAt.set(cacheKey, now);
  try {
    bumpNetworkSource("bitcoin:txs:prefetch");
    await refreshBitcoinTransactionsHead(params);
  } catch {}
}
