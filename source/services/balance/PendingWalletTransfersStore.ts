// Euro/dollar transfers that have left the wallet but not settled — the rows the
// wallet rails show as "in flight" and the history modal lists above its
// confirmed entries.
//
// Every producer already announces these on the bus (`wallet:pendingTransfer`,
// cleared by `wallet:clearPendingTransfer`), but the listener lived in the
// Wallet tab's hook. With the tabs gone the events reached nobody: a swap or a
// top-up was recorded durably on the SERVICE side and shown nowhere, so money
// left the balance with no sign of where it went. Ownership belongs to a store,
// not to whichever screen happens to be mounted.
//
// Persisted so a relaunch mid-flight still shows the row, and pruned by age so a
// producer that never announces the end cannot leave one forever.

import type { PendingWalletTransfer } from "../../types/wallet";
import { EventBus } from "../events/AppEventBusService";
import { getCacheValue, setCacheValue } from "./TransactionCacheService";

const CACHE_KEY = "wallet:pending-transfers:v2";
const MAX_ENTRIES = 20;
const TTL_MS = 24 * 60 * 60 * 1000;

let memory: PendingWalletTransfer[] = [];
let loaded = false;
let loading: Promise<void> | null = null;

const idOf = (value: string | null | undefined): string =>
  String(value ?? "")
    .trim()
    .toLowerCase();

const emitChange = () => {
  try {
    EventBus.emit("wallet:pendingTransfersChanged");
  } catch {}
};

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  if (loading) return loading;
  loading = (async () => {
    try {
      const cached = await getCacheValue<PendingWalletTransfer[]>(CACHE_KEY);
      if (Array.isArray(cached)) memory = cached;
    } catch {}
    loaded = true;
    loading = null;
  })();
  return loading;
}

async function persist(): Promise<void> {
  try {
    await setCacheValue(CACHE_KEY, memory);
  } catch {}
}

function matches(
  entry: PendingWalletTransfer,
  txHash?: string | null,
  orderId?: string | null,
  direction?: "in" | "out" | null,
) {
  const tx = idOf(txHash);
  const order = idOf(orderId);
  // A re-announce replaces only the SAME leg: one order writes an `out` (source
  // rail) and an `in` (destination rail) row, and they must coexist. When a
  // direction is given, a match also requires it; a clear (no direction) still
  // removes every leg of the order.
  if (tx && idOf(entry.txHash) === tx) {
    return direction == null || entry.direction === direction;
  }
  if (order && idOf(entry.orderId) === order) {
    return direction == null || entry.direction === direction;
  }
  return false;
}

async function add(entry: PendingWalletTransfer): Promise<void> {
  await ensureLoaded();
  const amount = Number(entry.amount);
  if (!Number.isFinite(amount) || amount <= 0) return;
  // A producer that re-announces the same transfer (a resume, a retry that
  // reached the same order) must replace its row, never add a second one — but
  // the two LEGS of one swap (an `out` on the source rail, an `in` on the
  // destination rail) are different rows sharing an id, so the direction is
  // part of the identity.
  const rest = memory.filter(
    (row) => !matches(row, entry.txHash, entry.orderId, entry.direction ?? null),
  );
  memory = [entry, ...rest].slice(0, MAX_ENTRIES);
  await persist();
  emitChange();
}

async function remove(txHash?: string | null, orderId?: string | null): Promise<void> {
  await ensureLoaded();
  const next = memory.filter((row) => !matches(row, txHash, orderId));
  if (next.length === memory.length) return;
  memory = next;
  await persist();
  emitChange();
}

async function list(): Promise<PendingWalletTransfer[]> {
  await ensureLoaded();
  return memory.slice();
}

/**
 * The rows that belong to ONE stablecoin rail. Euro and dollar are two balances
 * at one address: a dollar spend listed on the euro rail is a debit the euro
 * balance never took, written in the wrong currency, while the rail that paid
 * shows nothing at all.
 */
export function pendingTransfersForFiat(
  rows: readonly PendingWalletTransfer[],
  fiat: "EUR" | "USD",
): PendingWalletTransfer[] {
  // Rows written before the field existed are euro: no dollar producer emitted
  // one, so treating an absent code as USD would move real euro rows off the
  // rail that owns them.
  return rows.filter((row) => (row.fiat ?? "EUR") === fiat);
}

async function prune(ttlMs: number = TTL_MS): Promise<void> {
  await ensureLoaded();
  const cutoff = Date.now() - ttlMs;
  const next = memory.filter((row) => {
    // SwapKit owns terminal reconciliation against the server. A low-fee L1 BTC
    // payout can legitimately remain unconfirmed beyond 24h; age alone must not
    // erase the only durable handle that keeps it visible and polling.
    if (String(row.source || "").startsWith("swapkit")) return true;
    const at = Date.parse(String(row.createdAt || ""));
    return !Number.isFinite(at) || at >= cutoff;
  });
  if (next.length === memory.length) return;
  memory = next;
  await persist();
  emitChange();
}

/** Session teardown: a new identity must not inherit these. */
async function clear(): Promise<void> {
  memory = [];
  loaded = true;
  await persist();
  emitChange();
}

export const PendingWalletTransfersStore = { add, remove, list, prune, clear };

let unsubscribe: Array<() => void> = [];

/** Idempotent — a second call while running is a no-op. */
export function startPendingWalletTransfers(): void {
  if (unsubscribe.length > 0) return;
  unsubscribe = [
    EventBus.on<{
      // Producers state the fiat figure as `amountFiat`; `amount` is the older
      // spelling. Reading only one of them is reading none of the events that
      // matter — every current producer emits `amountFiat`.
      amountFiat?: number;
      amount?: number | string;
      maxSellEurc?: number | null;
      txHash?: string | null;
      orderId?: string | null;
      depositAddress?: string | null;
      paymentHash?: string | null;
      kind?: string;
      // Which stable left (or arrives). Producers that spend the dollar rail
      // state "USD"; everything else is the euro rail it always was.
      fiat?: string | null;
      source?: string | null;
      direction?: "in" | "out" | null;
    }>("wallet:pendingTransfer", (payload) => {
      const amount =
        typeof payload?.amountFiat === "number"
          ? Number(payload.amountFiat)
          : Number(payload?.amount ?? 0);
      if (!Number.isFinite(amount) || amount <= 0) return;
      const rawKind = String(payload?.kind || "");
      const kind: PendingWalletTransfer["kind"] =
        rawKind === "card_topup" || rawKind === "bank_transfer" ? rawKind : "wallet_transfer";
      void add({
        amount,
        maxSellEurc:
          Number.isFinite(Number(payload?.maxSellEurc)) && Number(payload?.maxSellEurc) > 0
            ? Number(payload?.maxSellEurc)
            : null,
        createdAt: new Date().toISOString(),
        txHash: payload?.txHash ?? null,
        orderId: payload?.orderId ?? null,
        depositAddress: payload?.depositAddress ?? null,
        paymentHash: payload?.paymentHash ? String(payload.paymentHash).toLowerCase() : null,
        kind,
        ...(payload?.direction === "in" || payload?.direction === "out"
          ? { direction: payload.direction }
          : {}),
        fiat: String(payload?.fiat || "").toUpperCase() === "USD" ? "USD" : "EUR",
        source: payload?.source ?? null,
      });
    }),
    EventBus.on<{ txHash?: string | null; orderId?: string | null }>(
      "wallet:clearPendingTransfer",
      (payload) => {
        void remove(payload?.txHash, payload?.orderId);
      },
    ),
    // A transfer whose receipt is in is done either way: mined or reverted, it
    // is no longer in flight.
    EventBus.on<{ txHash?: string | null }>("wallet:transferSettled", (payload) => {
      void remove(payload?.txHash, null);
    }),
  ];
  void prune();
}

export function stopPendingWalletTransfers(): void {
  for (const off of unsubscribe) {
    try {
      off();
    } catch {}
  }
  unsubscribe = [];
}
