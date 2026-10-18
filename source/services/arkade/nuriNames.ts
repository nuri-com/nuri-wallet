// The app's one name store for activity rows (lib/arkade/nuriNames), backed by
// the Arkade server's address lookup and AsyncStorage.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createNuriNameStore, type NameEntry } from "../../lib/arkade/nuriNames";
import { arkadeLnurlNames } from "./ArkadeApiService";
import { getArkadeLnurlAssertion } from "./internal/identity";

const STORAGE_KEY = "@nuri:nuriNames:v1";

export const nuriNames = createNuriNameStore({
  fetchNames: async (addresses) => {
    // Never a passkey prompt for a label: without a cached login, no names.
    const assertion = await getArkadeLnurlAssertion("lnurl_names", false);
    if (!assertion) return null;
    return (await arkadeLnurlNames(assertion, addresses)).names ?? null;
  },
  load: async () => {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, NameEntry>) : {};
  },
  save: (entries) => {
    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(entries)).catch(() => {});
  },
  now: () => Date.now(),
});

/**
 * Names for `addresses` while `enabled` (a list on screen). Returns a lookup
 * that re-renders the caller when answers arrive.
 */
export function useNuriNames(
  addresses: string[],
  enabled: boolean,
): (address: string | undefined) => string | null {
  const version = useSyncExternalStore(nuriNames.subscribe, nuriNames.version, nuriNames.version);
  const key = useMemo(() => [...new Set(addresses)].sort().join(","), [addresses]);
  useEffect(() => {
    if (!enabled || !key) return;
    void nuriNames.lookup(key.split(","));
  }, [enabled, key]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: version is the store's change signal
  return useMemo(() => (address) => (address ? (nuriNames.get(address) ?? null) : null), [version]);
}
