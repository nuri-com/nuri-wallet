// Sats committed to orders that have not finished yet — one entry per order.
//
// The Bitcoin balance store has a SINGLE outgoing hold: one amount, one timer,
// one reason, for the whole wallet. That is enough for the internal
// board/offboard transfer it was built for, which is one at a time by
// construction. It is not enough for swaps:
//
//   - a second Arkade-funded order OVERWROTE the first one's hold instead of
//     adding to it, so the wallet read as if only the newer one were in flight;
//   - ANY order finishing cleared the single hold, releasing sats another order
//     still had committed;
//   - nothing survived a restart, so a relaunch mid-swap showed the committed
//     sats as spendable again.
//
// So the reservations live here instead: additive, per order, persisted, and
// released only by the order that made them. The balance store keeps its single
// anchor for the transfer path; this layer tells it the CURRENT TOTAL, which is
// the only number the board has to be right about.
import { getCacheValue, setCacheValue } from "../balance/TransactionCacheService";
import { EventBus } from "../events/AppEventBusService";

export type SatsReservation = {
  /** The order that committed these sats. */
  orderId: string;
  /** Which Bitcoin wallet pays. Holds are per rail: an on-chain spend does not
   * reserve Arkade sats. */
  rail: "arkade" | "onchain";
  sats: number;
  createdAt: string;
};

const CACHE_KEY = "bitcoin:sats-reservations:v1";
const CHANGED = "bitcoin:satsReservationsChanged";

let memory: SatsReservation[] = [];
let loaded = false;
let loading: Promise<void> | null = null;

const isReservation = (value: unknown): value is SatsReservation => {
  const row = value as SatsReservation | null;
  return (
    !!row &&
    typeof row === "object" &&
    typeof row.orderId === "string" &&
    row.orderId.length > 0 &&
    (row.rail === "arkade" || row.rail === "onchain") &&
    Number.isFinite(row.sats) &&
    row.sats > 0
  );
};

const emitChange = (): void => {
  try {
    EventBus.emit(CHANGED);
  } catch {}
};

/**
 * Write the ledger. THROWS on failure, deliberately.
 *
 * A reservation that is not on disk does not survive the crash it exists for.
 * Swallowing the write error let funding broadcast against a hold that was
 * never durable, so the caller must be able to refuse to fund.
 */
async function persist(): Promise<void> {
  await setCacheValue(CACHE_KEY, memory);
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  if (!loading) {
    loading = (async () => {
      try {
        const cached = await getCacheValue<SatsReservation[]>(CACHE_KEY);
        if (Array.isArray(cached)) memory = cached.filter(isReservation);
      } catch {}
      loaded = true;
    })();
  }
  await loading;
}

/**
 * Reserve an order's sats. Idempotent by order id: re-arming the same order —
 * a resume, a retry, a second status poll — REPLACES its entry rather than
 * adding a second one, so the same money is never held twice.
 */
async function reserve(entry: {
  orderId: string;
  rail: "arkade" | "onchain";
  sats: number;
}): Promise<void> {
  const sats = Math.trunc(Number(entry.sats));
  const orderId = String(entry.orderId || "").trim();
  if (!orderId || !Number.isFinite(sats) || sats <= 0) return;
  await ensureLoaded();
  const row: SatsReservation = {
    orderId,
    rail: entry.rail,
    sats,
    createdAt: new Date().toISOString(),
  };
  const index = memory.findIndex((item) => item.orderId === orderId);
  const previous = index >= 0 ? memory[index] : null;
  if (index >= 0) memory[index] = row;
  else memory.push(row);
  try {
    await persist();
  } catch (error) {
    // Put memory back the way it was: an in-memory reservation the disk does
    // not know about is the exact state this call exists to prevent.
    if (previous) memory[index] = previous;
    else memory = memory.filter((item) => item.orderId !== orderId);
    throw error;
  }
  emitChange();
}

/** Release ONE order's reservation. Another order's stays exactly as it was. */
async function release(orderId: string): Promise<void> {
  const id = String(orderId || "").trim();
  if (!id) return;
  await ensureLoaded();
  const next = memory.filter((item) => item.orderId !== id);
  if (next.length === memory.length) return;
  const previous = memory;
  memory = next;
  try {
    await persist();
  } catch (error) {
    // A release that did not reach disk must not free the sats in memory
    // either, or a crash would restore a hold the user was told was gone.
    memory = previous;
    throw error;
  }
  emitChange();
}

/** Everything currently reserved on one rail. This is the number the board
 * subtracts, and it is a SUM: two orders in flight hold both amounts. */
function totalFor(rail: "arkade" | "onchain"): number {
  return memory.reduce((sum, row) => (row.rail === rail ? sum + row.sats : sum), 0);
}

function list(): SatsReservation[] {
  return memory.slice();
}

/** Session teardown: a new identity must not inherit these. */
async function clear(): Promise<void> {
  memory = [];
  loaded = true;
  await persist();
  emitChange();
}

export const SatsReservationsStore = {
  reserve,
  release,
  totalFor,
  list,
  clear,
  hydrate: ensureLoaded,
  CHANGED,
  /** Tests only. */
  _resetForTests(): void {
    memory = [];
    loaded = true;
  },
};
