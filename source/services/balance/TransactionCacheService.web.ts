/**
 * Web (PWA) implementation of the transaction cache. The native module uses
 * expo-sqlite, whose web build needs a wa-sqlite WASM worker + COOP/COEP headers
 * — far too much machinery for what is just a key→JSON cache. localStorage gives
 * the same cross-reload persistence with none of it.
 *
 * ponytail: it's a cache. Writes that exceed quota are swallowed (next read is a
 * miss → refetch), exactly as a cold cache behaves.
 */

const PREFIX = "nuri.txcache.";

function ls(): Storage | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

export const getCacheValue = async <T>(key: string): Promise<T | null> => {
  const store = ls();
  if (!store) return null;
  try {
    const raw = store.getItem(PREFIX + key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

export const setCacheValue = async <T>(key: string, value: T): Promise<void> => {
  const store = ls();
  if (!store) return;
  try {
    store.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Quota exceeded / serialization failure — drop it, it's a cache.
  }
};

export const deleteCacheKeys = async (keys: string[]): Promise<void> => {
  const store = ls();
  if (!store || !keys.length) return;
  for (const key of keys) {
    try {
      store.removeItem(PREFIX + key);
    } catch {}
  }
};

export const deleteCacheDatabase = async (): Promise<void> => {
  const store = ls();
  if (!store) return;
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k && k.startsWith(PREFIX)) toRemove.push(k);
    }
    for (const k of toRemove) {
      try {
        store.removeItem(k);
      } catch {}
    }
  } catch {}
};
