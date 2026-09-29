import { getAuthData, storeAuthData } from "../secureKeyStorage";
import { normalizeNostrPubkey } from "./nostr";
import {
  NOSTR_LAST_READ_CACHE_KEY,
  NOSTR_MESSAGES_CACHE_KEY,
  NOSTR_SUPPORT_PENDING_EVENTS_CACHE_KEY,
  NOSTR_SUPPORT_UNREAD_CACHE_KEY,
} from "./storage";

export const SUPPORT_PUBKEY = "npub1r7y83c4w57jc8skud7e4m6x9qt9g7s6zel6mnvj64lh00lc7tynsdx89vj";

const isHexPubkey = (value: string) => /^[0-9a-f]{64}$/.test(value);

const getLastReadFor = (raw: string | null, pubkeyHex: string): number => {
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return 0;
    const entry = (parsed as Record<string, unknown>)[pubkeyHex];
    return typeof entry === "number" && Number.isFinite(entry) ? entry : 0;
  } catch {
    return 0;
  }
};

const getUnreadStatsForPubkey = (
  rawMessages: string | null,
  rawLastRead: string | null,
  pubkeyHex: string,
): { count: number; ids: Set<string> } => {
  const lastRead = getLastReadFor(rawLastRead, pubkeyHex);
  if (!rawMessages) return { count: 0, ids: new Set() };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMessages);
  } catch {
    return { count: 0, ids: new Set() };
  }
  if (!Array.isArray(parsed)) return { count: 0, ids: new Set() };
  let count = 0;
  const ids = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = String(row.id || "")
      .trim()
      .toLowerCase();
    if (id && isHexPubkey(id)) {
      ids.add(id);
    }
    const counterparty = String(row.counterparty || "")
      .trim()
      .toLowerCase();
    if (!isHexPubkey(counterparty) || counterparty !== pubkeyHex) continue;
    if (row.outgoing) continue;
    const createdAt = Number(row.createdAt);
    if (!Number.isFinite(createdAt)) continue;
    if (createdAt > lastRead) {
      count += 1;
    }
  }
  return { count, ids };
};

export const getNostrUnreadCountForPubkey = async (pubkey: string): Promise<number> => {
  const pubkeyHex = normalizeNostrPubkey(pubkey);
  if (!pubkeyHex) return 0;
  try {
    const [rawMessages, rawLastRead] = await Promise.all([
      getAuthData(NOSTR_MESSAGES_CACHE_KEY),
      getAuthData(NOSTR_LAST_READ_CACHE_KEY),
    ]);
    const stats = getUnreadStatsForPubkey(rawMessages, rawLastRead, pubkeyHex);
    return stats.count;
  } catch {
    return 0;
  }
};

const parseCachedCount = (raw: string | null): number => {
  if (!raw) return 0;
  const count = Number(raw);
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.floor(count);
};

export const getCachedSupportUnreadCount = async (): Promise<number> => {
  try {
    const raw = await getAuthData(NOSTR_SUPPORT_UNREAD_CACHE_KEY);
    return parseCachedCount(raw);
  } catch {
    return 0;
  }
};

export const setCachedSupportUnreadCount = async (count: number): Promise<void> => {
  const safe = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  try {
    await storeAuthData(NOSTR_SUPPORT_UNREAD_CACHE_KEY, String(safe));
  } catch {
    // Best-effort cache write
  }
};

export const getSupportUnreadCount = async (supportPubkey: string): Promise<number> => {
  try {
    const pubkeyHex = normalizeNostrPubkey(supportPubkey);
    if (!pubkeyHex) return 0;
    const [rawMessages, rawLastRead, rawPending, rawCached] = await Promise.all([
      getAuthData(NOSTR_MESSAGES_CACHE_KEY),
      getAuthData(NOSTR_LAST_READ_CACHE_KEY),
      getAuthData(NOSTR_SUPPORT_PENDING_EVENTS_CACHE_KEY),
      getAuthData(NOSTR_SUPPORT_UNREAD_CACHE_KEY),
    ]);
    const stats = getUnreadStatsForPubkey(rawMessages, rawLastRead, pubkeyHex);
    const pendingIds = new Set<string>();
    if (rawPending) {
      try {
        const parsed = JSON.parse(rawPending);
        if (Array.isArray(parsed)) {
          parsed.forEach((item) => {
            const id = String((item as any)?.id || "")
              .trim()
              .toLowerCase();
            if (id && isHexPubkey(id) && !stats.ids.has(id)) {
              pendingIds.add(id);
            }
          });
        }
      } catch {}
    }
    const derivedCount = stats.count + pendingIds.size;
    const cachedCount = parseCachedCount(rawCached);
    return Math.max(derivedCount, cachedCount);
  } catch {
    return 0;
  }
};
