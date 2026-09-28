import { getCacheValue, setCacheValue } from "../balance/TransactionCacheService";

/**
 * A direct EVM swap the wallet signs itself (SwapKitDirectEvmSwapService).
 *
 * Deliberately NOT a `SwapKitOrder`: those are card-topup orders owned by
 * SwapKitPendingTracker. New curated direct swaps are resumed here through
 * `swap_track`, which rebuilds/signs the selected route action and accepts the
 * broadcast hash. Legacy rows without `tracking:"swap_track"` retain the old
 * provider + broadcast-hash polling path for backward compatibility.
 *
 * No secrets or keys are stored. Curated rows include the public settlement
 * address needed to rebuild the exact accepted route after restart, plus the
 * server order id, broadcast hash, route identity and accepted bounds.
 */
export type DirectSwapRecord = {
  /** SwapKit order id. */
  txId: string;
  /** Provider label; also part of the legacy `swap_status` poll key pair. */
  provider: string;
  routeId?: string;
  tracking?: "swap_track";
  fromAsset: string;
  toAsset: string;
  settleTarget?: string;
  /** EOA that accepted this route; a different login must never resume it. */
  owner?: string;
  /** Deposit-side amount, in the source token. */
  amount: number;
  /** Floor the run accepted on the receive side. */
  minReceive: number;
  chainId: number;
  createdAt: number;
  /**
   * Which of the app's own destinations this swap settles on, when it is not
   * the user's own EOA. Only "card" today, and only a TAG: the address itself
   * is never stored. Without it a resumed run cannot tell whose balance owes a
   * correction when the order finally settles.
   */
  destination?: "card";
  /**
   * Set once the wallet broadcast the swap transaction. A row without this hash
   * is signable only when it also lacks broadcastStartedAt and abandonedAt.
   */
  broadcastHash?: string;
  /** Set durably immediately before the wallet submits the route transaction. */
  broadcastStartedAt?: number;

  /**
   * Hashes of this order's transactions that CONFIRMED as reverted onchain.
   * A same-chain swap is one atomic transaction, so a revert moved nothing and
   * the input token is still in the EOA — the order is safely re-signable. The
   * hashes are kept (never just discarded) so a resumed run can tell a retry
   * from a first attempt and stop after RESIGN_LIMIT of them.
   */
  revertedHashes?: string[];

  /** Durable fail-closed marker written before an unsigned order is retired. */
  abandonedAt?: number;
};

const STORAGE_KEY = "swapkit:directSwaps:v1";

const memory: DirectSwapRecord[] = [];
let hydratePromise: Promise<void> | null = null;
let isHydrated = false;

const isDirectSwapRecord = (value: unknown): value is DirectSwapRecord => {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.txId === "string" &&
    row.txId.trim().length > 0 &&
    typeof row.provider === "string" &&
    typeof row.fromAsset === "string" &&
    typeof row.toAsset === "string" &&
    typeof row.amount === "number" &&
    Number.isFinite(row.amount) &&
    row.amount > 0 &&
    // A row without a usable floor could never be resumed under the bounds the
    // user accepted, so it is not a valid row.
    typeof row.minReceive === "number" &&
    Number.isFinite(row.minReceive) &&
    row.minReceive > 0 &&
    typeof row.chainId === "number" &&
    Number.isFinite(row.chainId) &&
    typeof row.createdAt === "number" &&
    Number.isFinite(row.createdAt) &&
    (row.destination == null || row.destination === "card") &&
    (row.owner == null || (typeof row.owner === "string" && row.owner.trim().length > 0)) &&
    (row.broadcastHash == null ||
      (typeof row.broadcastHash === "string" && row.broadcastHash.trim().length > 0)) &&
    (row.broadcastStartedAt == null ||
      (typeof row.broadcastStartedAt === "number" &&
        Number.isFinite(row.broadcastStartedAt) &&
        row.broadcastStartedAt > 0)) &&
    (row.revertedHashes == null ||
      (Array.isArray(row.revertedHashes) &&
        row.revertedHashes.every((h) => typeof h === "string" && h.trim().length > 0))) &&
    (row.abandonedAt == null ||
      (typeof row.abandonedAt === "number" &&
        Number.isFinite(row.abandonedAt) &&
        row.abandonedAt > 0))
  );
};

const persist = async () => {
  if (!isHydrated) return;
  try {
    await setCacheValue(STORAGE_KEY, memory);
  } catch {}
};

function ensureHydrated(): Promise<void> {
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    let parsed: unknown = null;
    try {
      parsed = await getCacheValue<unknown>(STORAGE_KEY);
    } catch {}
    if (Array.isArray(parsed)) {
      const byId = new Map<string, DirectSwapRecord>();
      for (const row of parsed) {
        if (isDirectSwapRecord(row)) byId.set(row.txId, row);
      }
      // Merge rather than replace: a run that started before the initial
      // hydrate resolved must not lose its row to the completing read.
      for (const row of memory) byId.set(row.txId, row);
      memory.splice(0, memory.length, ...byId.values());
    }
    isHydrated = true;
  })();
  return hydratePromise;
}

export const SwapKitDirectSwapStore = {
  hydrate(): Promise<void> {
    return ensureHydrated();
  },

  /** Insert or replace by txId. Awaited so the write is durable before signing. */
  async add(record: DirectSwapRecord): Promise<void> {
    await ensureHydrated();
    const idx = memory.findIndex((row) => row.txId === record.txId);
    if (idx >= 0) memory.splice(idx, 1);
    memory.unshift(record);
    await persist();
  },

  /** Funds-sensitive write: persist and read back before a signer may run. */
  async addDurable(record: DirectSwapRecord): Promise<void> {
    await ensureHydrated();
    const idx = memory.findIndex((row) => row.txId === record.txId);
    if (idx >= 0) memory.splice(idx, 1);
    memory.unshift(record);
    await setCacheValue(STORAGE_KEY, memory);
    const stored = await getCacheValue<unknown>(STORAGE_KEY);
    const persisted = Array.isArray(stored)
      ? stored.find((row) => isDirectSwapRecord(row) && row.txId === record.txId)
      : null;
    if (
      !persisted ||
      persisted.routeId !== record.routeId ||
      persisted.tracking !== record.tracking ||
      persisted.fromAsset !== record.fromAsset ||
      persisted.toAsset !== record.toAsset ||
      persisted.settleTarget !== record.settleTarget ||
      persisted.owner !== record.owner ||
      persisted.amount !== record.amount ||
      persisted.minReceive !== record.minReceive ||
      persisted.chainId !== record.chainId ||
      persisted.createdAt !== record.createdAt ||
      persisted.destination !== record.destination ||
      persisted.broadcastHash !== record.broadcastHash ||
      persisted.broadcastStartedAt !== record.broadcastStartedAt ||
      (persisted.revertedHashes || []).join(",") !== (record.revertedHashes || []).join(",") ||
      persisted.abandonedAt !== record.abandonedAt
    ) {
      throw new Error(`Direct swap journal write could not be verified for ${record.txId}.`);
    }
  },

  async remove(txId: string): Promise<void> {
    await ensureHydrated();
    const idx = memory.findIndex((row) => row.txId === txId);
    if (idx >= 0) memory.splice(idx, 1);
    await persist();
  },

  /**
   * Make an unsigned row permanently non-signable before removing it. If the
   * removal write fails, the verified abandoned marker remains on disk.
   */
  async retireUnsignedDurable(txId: string): Promise<void> {
    await ensureHydrated();
    const idx = memory.findIndex((row) => row.txId === txId);
    if (idx < 0) throw new Error(`Direct swap journal ${txId} is missing.`);
    const retired = { ...memory[idx], abandonedAt: Date.now() };
    memory.splice(idx, 1, retired);
    await setCacheValue(STORAGE_KEY, memory);
    const marked = await getCacheValue<unknown>(STORAGE_KEY);
    const persistedMarker = Array.isArray(marked)
      ? marked.find((row) => isDirectSwapRecord(row) && row.txId === txId)
      : null;
    if (!persistedMarker || persistedMarker.abandonedAt !== retired.abandonedAt) {
      throw new Error(`Direct swap retirement marker could not be verified for ${txId}.`);
    }

    const markedIdx = memory.findIndex((row) => row.txId === txId);
    if (markedIdx >= 0) memory.splice(markedIdx, 1);
    await setCacheValue(STORAGE_KEY, memory);
    const removed = await getCacheValue<unknown>(STORAGE_KEY);
    if (
      Array.isArray(removed) &&
      removed.some((row) => isDirectSwapRecord(row) && row.txId === txId)
    ) {
      throw new Error(`Direct swap journal removal could not be verified for ${txId}.`);
    }
  },

  list(): DirectSwapRecord[] {
    return memory.slice();
  },

  /** Full wipe for logout/reset; owner binding still fails closed if persistence fails. */
  async clear(): Promise<void> {
    try {
      await hydratePromise;
    } catch {}
    memory.splice(0, memory.length);
    try {
      await setCacheValue(STORAGE_KEY, []);
      // The deliberately-held-USDC counter is gone with the unattended sweep it
      // fed; a wipe clears the key it used to write in case one survives.
      await setCacheValue("swapkit:deliberateUsdc:v1", 0);
    } catch {}
  },
};

// ── Abandoned orders ─────────────────────────────────────────────────────────

const ABANDONED_KEY = "swapkit:abandonedOrders:v1";

/**
 * How long an abandonment record is kept. Long enough to outlive every resume
 * path that could re-adopt the order (owner discovery runs on each app start),
 * short enough that the list cannot grow without bound.
 */
const ABANDONED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type AbandonedOrder = { txId: string; at: number };

const isAbandonedOrder = (value: unknown): value is AbandonedOrder =>
  !!value &&
  typeof value === "object" &&
  typeof (value as AbandonedOrder).txId === "string" &&
  (value as AbandonedOrder).txId.trim().length > 0 &&
  typeof (value as AbandonedOrder).at === "number" &&
  Number.isFinite((value as AbandonedOrder).at);

async function readAbandoned(): Promise<AbandonedOrder[]> {
  try {
    const stored = await getCacheValue<unknown>(ABANDONED_KEY);
    if (!Array.isArray(stored)) return [];
    const cutoff = Date.now() - ABANDONED_TTL_MS;
    return stored.filter(isAbandonedOrder).filter((row) => row.at > cutoff);
  } catch {
    return [];
  }
}

/**
 * Record that this app created a SwapKit order and then walked away from it
 * WITHOUT signing — a requoted attempt whose transaction never broadcast.
 *
 * Such an order sits at AWAITING_SIGNATURE on the server forever: it is waiting
 * for a signature no one will ever produce (the run that could have produced it
 * has ended, and its calldata was stale — re-signing those bytes can only
 * revert). Owner discovery would otherwise adopt it on every app start and poll
 * it for the rest of the install's life. Nothing here can move funds; the order
 * was never funded.
 */
export async function noteAbandonedSwapOrder(txId: string): Promise<void> {
  const id = txId.trim();
  if (!id) return;
  try {
    const rows = await readAbandoned();
    if (rows.some((row) => row.txId === id)) return;
    await setCacheValue(ABANDONED_KEY, [{ txId: id, at: Date.now() }, ...rows]);
  } catch {}
}

/** The order ids this app abandoned before signing. Unreadable storage yields none. */
export async function listAbandonedSwapOrders(): Promise<Set<string>> {
  return new Set((await readAbandoned()).map((row) => row.txId));
}
