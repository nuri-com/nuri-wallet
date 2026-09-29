import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * A Mercuryo purchase handed off to the browser but not yet paid.
 *
 * Deliberately NOT a `PendingPurchase`: that store is the "this row is visible
 * in the activity list" store, and a handoff is not a purchase — the user may
 * close the browser without paying. This one is invisible; the tracker promotes
 * it to a PendingPurchase only once Mercuryo reports the fiat leg settled.
 *
 * Persisted at handoff rather than at settlement so a purchase survives the app
 * being killed or the sheet being swiped away while checkout runs outside the app.
 */
export type MercuryoOrder = {
  /** merchant_transaction_id — the handle the status endpoint is queried by. */
  mtid: string;
  createdAt: number;
  amountFiat: number;
  /** Estimated at handoff from spot; the settled figure replaces it. */
  amountSats?: number;
  fiat: string;
  crypto: string;
  payment: string;
  /** Destination Bitcoin address the purchase was opened for. */
  address: string;
  /** Checkout URL, so a row can be reopened. */
  openUrl: string;
};

export const MERCURYO_ORDERS_STORAGE_KEY = "@nuri:mercuryo_orders:v1";

// An order the provider never reports on is dropped rather than polled forever.
// Matches the PendingPurchasesStore TTL: past it, an unsettled purchase is not
// something the app can still say anything useful about.
const TTL_MS = 24 * 60 * 60 * 1000; // 24h

const memory: MercuryoOrder[] = [];
let hydratePromise: Promise<void> | null = null;
let isHydrated = false;

const isMercuryoOrder = (value: unknown): value is MercuryoOrder => {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.mtid === "string" &&
    item.mtid.trim().length > 0 &&
    typeof item.createdAt === "number" &&
    Number.isFinite(item.createdAt) &&
    typeof item.amountFiat === "number" &&
    Number.isFinite(item.amountFiat) &&
    typeof item.fiat === "string" &&
    typeof item.crypto === "string" &&
    typeof item.payment === "string" &&
    typeof item.address === "string" &&
    typeof item.openUrl === "string" &&
    (item.amountSats === undefined ||
      (typeof item.amountSats === "number" && Number.isFinite(item.amountSats)))
  );
};

// Awaited by the mutators so a write is durable before they return — the app may
// be killed the moment the browser takes over. Best-effort: `memory` is the
// source of truth for the running session.
const persist = async () => {
  if (!isHydrated) return;
  try {
    await AsyncStorage.setItem(MERCURYO_ORDERS_STORAGE_KEY, JSON.stringify(memory));
  } catch {}
};

function ensureHydrated(): Promise<void> {
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    let parsed: unknown = null;
    try {
      const raw = await AsyncStorage.getItem(MERCURYO_ORDERS_STORAGE_KEY);
      parsed = raw ? JSON.parse(raw) : null;
    } catch {}
    if (Array.isArray(parsed)) {
      const byId = new Map<string, MercuryoOrder>();
      for (const row of parsed) {
        if (isMercuryoOrder(row)) byId.set(row.mtid, row);
      }
      memory.splice(0, memory.length, ...byId.values());
    }
    isHydrated = true;
  })();
  return hydratePromise;
}

export const MercuryoOrderStore = {
  hydrate(): Promise<void> {
    return ensureHydrated();
  },

  /** Synchronous after hydrate(). */
  list(): MercuryoOrder[] {
    return [...memory];
  },

  async add(order: MercuryoOrder): Promise<void> {
    // Hydrate first, or the initial hydrate's splice-replace would drop this row
    // (and persist() no-ops while !isHydrated), losing a handed-off purchase.
    await ensureHydrated();
    const idx = memory.findIndex((o) => o.mtid === order.mtid);
    if (idx >= 0) memory.splice(idx, 1);
    memory.unshift(order);
    await persist();
  },

  async remove(mtid: string): Promise<void> {
    await ensureHydrated();
    const idx = memory.findIndex((o) => o.mtid === mtid);
    if (idx < 0) return;
    memory.splice(idx, 1);
    await persist();
  },

  /** Drops orders past the TTL. Returns the ones removed, for logging. */
  async cleanup(ttlMs: number = TTL_MS): Promise<MercuryoOrder[]> {
    await ensureHydrated();
    const cutoff = Date.now() - ttlMs;
    const expired: MercuryoOrder[] = [];
    for (let i = memory.length - 1; i >= 0; i--) {
      if (memory[i].createdAt >= cutoff) continue;
      expired.push(memory[i]);
      memory.splice(i, 1);
    }
    if (expired.length > 0) await persist();
    return expired;
  },

  async clear(): Promise<void> {
    await ensureHydrated();
    memory.splice(0, memory.length);
    try {
      await AsyncStorage.removeItem(MERCURYO_ORDERS_STORAGE_KEY);
    } catch {}
  },
};
