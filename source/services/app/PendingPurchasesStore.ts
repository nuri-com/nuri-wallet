import AsyncStorage from "@react-native-async-storage/async-storage";
import { EventBus } from "../events/AppEventBusService";

export type PendingPurchase = {
  id: string; // merchantTransactionId
  createdAt: number;
  amountFiat: number;
  amountSats?: number;
  fiat: string; // e.g., 'EUR'
  crypto: string; // e.g., 'BTC'
  payment: string; // e.g., 'applepay'
  source?: string; // e.g., 'mercuryo' | 'swapkit'
  // A BTC→EUR swap (topup) whose sats ORIGINATE from the Bitcoin wallet, as
  // opposed to the default "Received Bitcoin" rows. Drives the Bitcoin pending
  // row's direction-aware label + live-status subtitle.
  direction?: "btc_to_eur";
  destination?: "card" | "wallet";
  address: string; // destination wallet
  openUrl: string; // link to reopen widget/status
};

// Single source of truth for "is this a source-rendered (Mercuryo) pending row".
export const isMercuryoPending = (p?: { source?: string } | null): boolean => {
  const src = String(p?.source || "")
    .trim()
    .toLowerCase();
  return src !== "swapkit";
};

const memory: PendingPurchase[] = [];

const TTL_MS = 24 * 60 * 60 * 1000; // 24h
export const PENDING_PURCHASES_STORAGE_KEY = "@nuri:pending_purchases:v1";

let hydratePromise: Promise<void> | null = null;
let isHydrated = false;

const isPendingPurchase = (value: unknown): value is PendingPurchase => {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    item.id.trim().length > 0 &&
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
      (typeof item.amountSats === "number" && Number.isFinite(item.amountSats))) &&
    (item.source === undefined || typeof item.source === "string") &&
    (item.direction === undefined || item.direction === "btc_to_eur") &&
    (item.destination === undefined || item.destination === "card" || item.destination === "wallet")
  );
};

// Awaited by the mutating methods so a write is durable before the operation
// reports complete (app may be killed right after a purchase or placeholder
// removal). Swallows write errors: persistence is best-effort, memory is the
// source of truth for the running session.
const persist = async () => {
  if (!isHydrated) return;
  try {
    await AsyncStorage.setItem(PENDING_PURCHASES_STORAGE_KEY, JSON.stringify(memory));
  } catch {}
};

const mergeIntoMemory = (items: PendingPurchase[]) => {
  const byId = new Map<string, PendingPurchase>();
  for (const item of [...items, ...memory]) {
    byId.set(item.id, item);
  }
  memory.splice(
    0,
    memory.length,
    ...Array.from(byId.values()).sort((a, b) => b.createdAt - a.createdAt),
  );
};

export const PendingPurchasesStore = {
  hydrate() {
    if (hydratePromise) return hydratePromise;
    hydratePromise = (async () => {
      // Read failure and corrupt payload must be treated differently: a corrupt
      // payload is safe to overwrite, but after a failed READ the persisted rows
      // may still be intact — flushing the (possibly empty) in-memory state
      // would destroy them.
      let raw: string | null = null;
      let readFailed = false;
      try {
        raw = await AsyncStorage.getItem(PENDING_PURCHASES_STORAGE_KEY);
      } catch {
        readFailed = true;
      }
      if (raw) {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            mergeIntoMemory(parsed.filter(isPendingPurchase));
          }
        } catch {}
      }
      isHydrated = true;
      await PendingPurchasesStore.cleanup();
      if (!readFailed) {
        await persist();
      }
      try {
        EventBus.emit("bitcoin:pendingPurchasesChanged");
      } catch {}
    })();
    return hydratePromise;
  },
  async add(item: PendingPurchase) {
    // de-dup by id
    const idx = memory.findIndex((p) => p.id === item.id);
    if (idx >= 0) memory.splice(idx, 1);
    memory.unshift(item);
    await persist();
    try {
      EventBus.emit("bitcoin:pendingPurchasesChanged");
    } catch {}
    try {
      console.log("[PendingPurchasesStore] add", {
        id: `${String(item.id || "").slice(0, 12)}…`,
        amountSats: item.amountSats,
        amountFiat: item.amountFiat,
        count: memory.length,
      });
    } catch {}
  },
  async remove(id: string) {
    const idx = memory.findIndex((p) => p.id === id);
    if (idx >= 0) memory.splice(idx, 1);
    await persist();
    try {
      EventBus.emit("bitcoin:pendingPurchasesChanged");
    } catch {}
    try {
      console.log("[PendingPurchasesStore] remove", {
        id: `${String(id || "").slice(0, 12)}…`,
        count: memory.length,
      });
    } catch {}
  },
  list(): PendingPurchase[] {
    return memory.slice();
  },
  // Full wipe for factory reset / soft logout: empties singleton memory and the
  // persisted AsyncStorage copy (wipeAllKeychainData only clears Keychain, so
  // this key must be removed here). Awaits any in-flight hydrate() first so a
  // late merge cannot repopulate memory and persist the rows back.
  async clear() {
    try {
      await hydratePromise;
    } catch {}
    memory.splice(0, memory.length);
    try {
      EventBus.emit("bitcoin:pendingPurchasesChanged");
    } catch {}
    // Deliberately NOT swallowed: reset/logout callers must know if the
    // persisted copy could not be removed.
    await AsyncStorage.removeItem(PENDING_PURCHASES_STORAGE_KEY);
    try {
      console.log("[PendingPurchasesStore] clear");
    } catch {}
  },
  // Memory is pruned synchronously (before the first await), so callers that
  // fire-and-forget this and read list() right after still see pruned rows.
  async cleanup(ttlMs: number = TTL_MS) {
    const cutoff = Date.now() - ttlMs;
    const removedIds: string[] = [];
    for (let i = memory.length - 1; i >= 0; i--) {
      // Durable SwapKit BTC→EUR top-up rows back a SwapKitOrderStore order that
      // is retained until completion or successful/no-funds recovery — never
      // expire them by wall-clock TTL, or the Bitcoin activity row disappears on
      // a later app start while the durable order and possibly in-flight funds
      // remain. The tracker removes the row on terminal/settled instead.
      if (memory[i].direction === "btc_to_eur") continue;
      if (memory[i].createdAt < cutoff) {
        try {
          removedIds.push(memory[i].id);
        } catch {}
        memory.splice(i, 1);
      }
    }
    if (removedIds.length > 0) {
      await persist();
      try {
        EventBus.emit("bitcoin:pendingPurchasesChanged");
      } catch {}
      try {
        console.log("[PendingPurchasesStore] cleanup", {
          removed: removedIds.length,
          ids: removedIds.map((id) => `${String(id || "").slice(0, 12)}…`),
          count: memory.length,
        });
      } catch {}
    }
  },
};
