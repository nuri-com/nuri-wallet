// Usernames for the addresses in the activity lists (#1708).
//
// The server names an address only when exactly one Nuri user proved it, so a
// name here is safe to show. Answers are remembered per address: a name for a
// week, "nobody" for a day (someone may prove it meanwhile). A list asks once
// for all the addresses it does not know yet, in chunks of the server's limit,
// so opening a history costs at most one request and usually none.
//
// Pure store; the server call and storage are injected (services/arkade/nuriNames).

export const NAME_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const NO_NAME_TTL_MS = 24 * 60 * 60 * 1000;
export const NAMES_PER_REQUEST = 100;
const MAX_ENTRIES = 1000;

export type NameEntry = { name: string | null; at: number };

export type NuriNameStoreDeps = {
  /** Lowercase address -> username|null, or null when the lookup could not run. */
  fetchNames: (addresses: string[]) => Promise<Record<string, string | null> | null>;
  load: () => Promise<Record<string, NameEntry>>;
  save: (entries: Record<string, NameEntry>) => void;
  now: () => number;
};

export type NuriNameStore = {
  /** The username, null for nobody, undefined when not known yet. */
  get: (address: string) => string | null | undefined;
  lookup: (addresses: string[]) => Promise<void>;
  subscribe: (listener: () => void) => () => void;
  version: () => number;
};

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const USERNAME = /^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])?$/;

export function createNuriNameStore(deps: NuriNameStoreDeps): NuriNameStore {
  let entries: Record<string, NameEntry> = {};
  let loaded: Promise<void> | null = null;
  let version = 0;
  const asking = new Set<string>();
  const listeners = new Set<() => void>();

  const ensureLoaded = (): Promise<void> => {
    loaded ??= deps
      .load()
      .then((stored) => {
        // Answers that arrived while loading are newer than the stored ones.
        entries = { ...stored, ...entries };
        if (Object.keys(stored).length > 0) notify();
      })
      .catch(() => {});
    return loaded;
  };

  const fresh = (entry: NameEntry | undefined): boolean =>
    Boolean(entry) &&
    deps.now() - (entry as NameEntry).at <
      ((entry as NameEntry).name ? NAME_TTL_MS : NO_NAME_TTL_MS);

  const notify = () => {
    version += 1;
    for (const listener of listeners) listener();
  };

  const prune = () => {
    const keys = Object.keys(entries);
    if (keys.length <= MAX_ENTRIES) return;
    keys
      .sort((a, b) => entries[a].at - entries[b].at)
      .slice(0, keys.length - MAX_ENTRIES)
      .forEach((key) => {
        delete entries[key];
      });
  };

  return {
    get: (address) => {
      const entry = entries[address.trim().toLowerCase()];
      return fresh(entry) ? (entry as NameEntry).name : undefined;
    },
    lookup: async (addresses) => {
      await ensureLoaded();
      const wanted = [
        ...new Set(addresses.map((a) => a.trim().toLowerCase()).filter((a) => EVM_ADDRESS.test(a))),
      ].filter((a) => !fresh(entries[a]) && !asking.has(a));
      if (wanted.length === 0) return;
      for (const a of wanted) asking.add(a);
      try {
        let changed = false;
        for (let i = 0; i < wanted.length; i += NAMES_PER_REQUEST) {
          const chunk = wanted.slice(i, i + NAMES_PER_REQUEST);
          const names = await deps.fetchNames(chunk).catch((): null => null);
          if (!names) break;
          const at = deps.now();
          for (const a of chunk) {
            const name = names[a];
            entries[a] = {
              name: typeof name === "string" && USERNAME.test(name) ? name : null,
              at,
            };
          }
          changed = true;
        }
        if (changed) {
          prune();
          deps.save(entries);
          notify();
        }
      } finally {
        for (const a of wanted) asking.delete(a);
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => version,
  };
}
