import { EventBus } from "../events/AppEventBusService";
import { finishInFlight, startSendInFlight } from "../money/announce";
import { getCacheValue, setCacheValue } from "../balance/TransactionCacheService";

export type PendingBitcoinSend = {
  txid: string;
  amountSats: number;
  createdAt: string;
  toAddress?: string | null;
  local?: boolean;
  /** Never age-prune: a send may have crossed its irreversible boundary. */
  reconciliationRequired?: boolean;
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

// Every mutation runs one at a time and publishes to memory only after its
// write lands, so memory never claims a row disk does not have (or the reverse).
let tail: Promise<unknown> = Promise.resolve();
const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
  const run = tail.then(operation, operation);
  tail = run.catch(() => {});
  return run;
};
const commit = async (next: PendingBitcoinSend[]): Promise<void> => {
  await setCacheValue(CACHE_KEY, next);
  memory = next;
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
  reconciliationRequired?: boolean;
  source?: "arkade" | "onchain";
  /** Set when the sats land on this wallet's OTHER bitcoin rail. */
  toRail?: "arkade" | "onchain" | null;
}): Promise<void> =>
  serialized(async () => {
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
      reconciliationRequired: payload.reconciliationRequired === true,
      source: payload.source === "onchain" ? "onchain" : "arkade",
    };
    const next = [entry, ...memory.filter((item) => normalizeId(item.txid) !== txid)];
    // The cap bounds ordinary spinner rows, never a record that protects against
    // repeating an ambiguous spend. At most one direct-send reconciliation row
    // can exist because that row blocks another direct send at the boundary.
    await commit(next.filter((item, index) => index < MAX_ENTRIES || item.reconciliationRequired));
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
  });

const remove = async (txid: string): Promise<void> =>
  serialized(async () => {
    await ensureLoaded();
    const id = normalizeId(txid);
    if (!id) return;
    const removed = memory.find((item) => normalizeId(item.txid) === id);
    if (!removed) return;
    await commit(memory.filter((item) => normalizeId(item.txid) !== id));
    emitChange();
    void finishInFlight(removed.txid).catch(() => {});
  });

/** A reconciliation-required send the wallet now knows: it becomes an ordinary
 * pending row, cleared once it settles. */
const markKnown = async (txid: string): Promise<void> =>
  serialized(async () => {
    await ensureLoaded();
    const id = normalizeId(txid);
    if (!memory.some((item) => normalizeId(item.txid) === id && item.reconciliationRequired))
      return;
    await commit(
      memory.map((item) =>
        normalizeId(item.txid) === id
          ? { ...item, local: false, reconciliationRequired: false }
          : item,
      ),
    );
    emitChange();
  });

const list = async (): Promise<PendingBitcoinSend[]> => {
  await ensureLoaded();
  return memory.slice();
};

const prune = async (ttlMs: number = TTL_MS): Promise<void> =>
  serialized(async () => {
    await ensureLoaded();
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
    const cutoff = Date.now() - ttlMs;
    const next = memory.filter((entry) => {
      if (entry.reconciliationRequired) return true;
      const ts = Date.parse(entry.createdAt || "");
      if (!Number.isFinite(ts)) return true;
      const entryTtl = entry.local ? LOCAL_TTL_MS : ttlMs;
      return ts >= Date.now() - entryTtl && ts >= cutoff;
    });
    if (next.length !== memory.length) {
      await commit(next);
      emitChange();
    }
  });

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
  markKnown,
  list,
  prune,
  ensureLoaded,
};
