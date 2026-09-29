import { EventBus } from "../events/AppEventBusService";
import { finishInFlight, startSendInFlight } from "../money/announce";
import { getCacheValue, setCacheValue } from "../balance/TransactionCacheService";

export type PendingBitcoinSend = {
  txid: string;
  amountSats: number;
  createdAt: string;
  toAddress?: string | null;
  local?: boolean;
  /**
   * Which bitcoin wallet paid. The two rails are separate balances on the home
   * board, so a row without it cannot be shown on the one that is actually
   * short. Absent on rows written before this existed: those all came from the
   * arkade corridor, which is what the reader assumes.
   */
  source?: "arkade" | "onchain";
};

const CACHE_KEY = "bitcoin:pending-sends:v1";
const MAX_ENTRIES = 20;
const TTL_MS = 24 * 60 * 60 * 1000;
const LOCAL_TTL_MS = 20 * 60 * 1000;

let memory: PendingBitcoinSend[] = [];
let loaded = false;
let loading: Promise<void> | null = null;

const normalizeId = (txid: string): string =>
  String(txid || "")
    .trim()
    .toLowerCase();

const emitChange = () => {
  try {
    EventBus.emit("bitcoin:pendingSendsChanged");
  } catch {}
};

const persist = async () => {
  await setCacheValue(CACHE_KEY, memory);
};

const ensureLoaded = async () => {
  if (loaded) return;
  if (loading) return loading;
  loading = (async () => {
    try {
      const cached = await getCacheValue<PendingBitcoinSend[]>(CACHE_KEY);
      if (Array.isArray(cached)) {
        memory = cached.filter((entry) => {
          const txid = normalizeId(entry?.txid || "");
          const amount = Number(entry?.amountSats ?? 0);
          return !!txid && Number.isFinite(amount) && amount > 0;
        });
      }
    } catch {}
    loaded = true;
    loading = null;
  })();
  return loading;
};

const add = async (payload: {
  txid: string;
  amountSats: number;
  toAddress?: string | null;
  local?: boolean;
  source?: "arkade" | "onchain";
  /** Set when the sats land on this wallet's OTHER bitcoin rail. */
  toRail?: "arkade" | "onchain" | null;
}): Promise<void> => {
  await ensureLoaded();
  const txid = normalizeId(payload.txid);
  const amount = Number(payload.amountSats);
  if (!txid || !Number.isFinite(amount) || amount <= 0) return;
  const entry: PendingBitcoinSend = {
    txid: payload.txid,
    amountSats: amount,
    createdAt: new Date().toISOString(),
    toAddress: payload.toAddress ?? null,
    local: payload.local === true,
    source: payload.source === "onchain" ? "onchain" : "arkade",
  };
  memory = [entry, ...memory.filter((item) => normalizeId(item.txid) !== txid)].slice(
    0,
    MAX_ENTRIES,
  );
  await persist();
  emitChange();
  // Also announce it as money in flight, so the board's pending strip has ONE
  // source. A send has no destination screen: the sats are going to someone
  // else, and an "arriving" row would state money the wallet is not getting.
  void startSendInFlight({
    id: entry.txid,
    rail: entry.source === "onchain" ? "onchain" : "arkade",
    amount: entry.amountSats,
    unit: "sats",
    toRail: payload.toRail ?? null,
  }).catch(() => {});
};

const remove = async (txid: string): Promise<void> => {
  await ensureLoaded();
  const id = normalizeId(txid);
  if (!id) return;
  const before = memory.length;
  const removed = memory.find((item) => normalizeId(item.txid) === id);
  memory = memory.filter((item) => normalizeId(item.txid) !== id);
  if (memory.length !== before) {
    await persist();
    emitChange();
    if (removed) void finishInFlight(removed.txid).catch(() => {});
  }
};

const list = async (): Promise<PendingBitcoinSend[]> => {
  await ensureLoaded();
  return memory.slice();
};

const prune = async (ttlMs: number = TTL_MS): Promise<void> => {
  await ensureLoaded();
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
  const cutoff = Date.now() - ttlMs;
  const next = memory.filter((entry) => {
    const ts = Date.parse(entry.createdAt || "");
    if (!Number.isFinite(ts)) return true;
    const entryTtl = entry.local ? LOCAL_TTL_MS : ttlMs;
    return ts >= Date.now() - entryTtl && ts >= cutoff;
  });
  if (next.length !== memory.length) {
    memory = next;
    await persist();
    emitChange();
  }
};

/**
 * The in-flight sends that belong to ONE bitcoin rail, newest first. Both rails
 * are their own balance and their own board row, so a send is listed where the
 * money left from — never on both, and never on the other one.
 */
export function pendingSendsForRail(
  rows: readonly PendingBitcoinSend[],
  rail: "arkade" | "onchain",
): PendingBitcoinSend[] {
  return rows.filter((row) => (row.source ?? "arkade") === rail);
}

export const PendingBitcoinSendsStore = {
  add,
  remove,
  list,
  prune,
  ensureLoaded,
};
