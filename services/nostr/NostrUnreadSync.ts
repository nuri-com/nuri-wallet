import {
  NOSTR_SYNC_INTERVAL_MS,
  NOSTR_LAST_SYNC_SKEW_SEC,
  NOSTR_SOCKET_TIMEOUT_MS,
} from "../../config/constants";
import { EventBus } from "../events/AppEventBusService";
import { NOSTR_KINDS, type NostrEvent } from "../../lib/nostr/nostr";
import { getAuthData, storeAuthData } from "../../lib/secureKeyStorage";
import {
  NOSTR_MESSAGES_CACHE_KEY,
  NOSTR_PUBKEY_CACHE_KEY,
  NOSTR_SUPPORT_LAST_SYNC_CACHE_KEY,
  NOSTR_SUPPORT_PENDING_EVENTS_CACHE_KEY,
  NOSTR_SUPPORT_SEEN_IDS_CACHE_KEY,
  NOSTR_SUPPORT_UNREAD_CACHE_KEY,
} from "../../lib/nostr/storage";

import { DEFAULT_NOSTR_RELAYS } from "../../config/endpoints";
import { NOSTR_SYNC_WINDOW_SEC, NOSTR_MAX_SEEN_IDS } from "../../config/constants";
const RELAY_URLS = [
  String(process.env.EXPO_PUBLIC_NOSTR_BACKUP_RELAY || "").trim(),
  ...DEFAULT_NOSTR_RELAYS,
].filter(Boolean);
const SYNC_WINDOW_SEC = NOSTR_SYNC_WINDOW_SEC;
const MAX_SEEN_IDS = NOSTR_MAX_SEEN_IDS;

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
let queued = false;
let chatActive = false;
const autoOpenedPendingIds = new Set<string>();

EventBus.on("support:chatActive", (payload?: { active?: boolean }) => {
  chatActive = Boolean(payload?.active);
});

const isHexId = (value: string) => /^[0-9a-f]{64}$/i.test(value);

const parseSeenIds = (raw: string | null): string[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((id) => String(id || "").trim()).filter((id) => id.length > 0);
  } catch {
    return [];
  }
};

const normalizePendingEvent = (raw: any): NostrEvent | null => {
  if (!raw || typeof raw !== "object") return null;
  const id = String((raw as any).id || "")
    .trim()
    .toLowerCase();
  if (!isHexId(id)) return null;
  const pubkey = String((raw as any).pubkey || "")
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pubkey)) return null;
  const created_at = Number((raw as any).created_at);
  if (!Number.isFinite(created_at)) return null;
  const kind = Number((raw as any).kind);
  if (!Number.isFinite(kind)) return null;
  const tags = Array.isArray((raw as any).tags) ? (raw as any).tags : [];
  const content = String((raw as any).content ?? "");
  const sig = typeof (raw as any).sig === "string" ? (raw as any).sig : undefined;
  return { id, pubkey, created_at, kind, tags, content, sig };
};

const parsePendingEvents = (raw: string | null): NostrEvent[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizePendingEvent).filter(Boolean) as NostrEvent[];
  } catch {
    return [];
  }
};

const trimPendingEvents = (events: NostrEvent[]): NostrEvent[] => {
  if (events.length <= MAX_SEEN_IDS) return events;
  const ordered = [...events].sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  return ordered.slice(ordered.length - MAX_SEEN_IDS);
};

const parseTimestamp = (raw: string | null): number => {
  if (!raw) return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
};

const loadSeedIds = async (): Promise<string[]> => {
  try {
    const [rawSeen, rawMessages] = await Promise.all([
      getAuthData(NOSTR_SUPPORT_SEEN_IDS_CACHE_KEY),
      getAuthData(NOSTR_MESSAGES_CACHE_KEY),
    ]);
    const ids = parseSeenIds(rawSeen);
    if (rawMessages) {
      try {
        const parsed = JSON.parse(rawMessages);
        if (Array.isArray(parsed)) {
          parsed.forEach((item) => {
            const id = String((item as any)?.id || "").trim();
            if (id.length > 0 && isHexId(id)) {
              ids.push(id);
            }
          });
        }
      } catch {
        // Ignore bad cache payloads
      }
    }
    return ids;
  } catch {
    return [];
  }
};

const loadPendingEvents = async (): Promise<NostrEvent[]> => {
  try {
    const raw = await getAuthData(NOSTR_SUPPORT_PENDING_EVENTS_CACHE_KEY);
    return parsePendingEvents(raw);
  } catch {
    return [];
  }
};

const storePendingEvents = async (events: NostrEvent[]): Promise<void> => {
  try {
    await storeAuthData(NOSTR_SUPPORT_PENDING_EVENTS_CACHE_KEY, JSON.stringify(events));
  } catch {
    // Best-effort cache write
  }
};

const getLastSync = async (): Promise<number> => {
  try {
    const raw = await getAuthData(NOSTR_SUPPORT_LAST_SYNC_CACHE_KEY);
    return parseTimestamp(raw);
  } catch {
    return 0;
  }
};

const setLastSync = async (value: number): Promise<void> => {
  const safe = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  if (!safe) return;
  try {
    await storeAuthData(NOSTR_SUPPORT_LAST_SYNC_CACHE_KEY, String(safe));
  } catch {
    // Best-effort cache write
  }
};

const getCachedUnreadCount = async (): Promise<number> => {
  try {
    const raw = await getAuthData(NOSTR_SUPPORT_UNREAD_CACHE_KEY);
    const count = Number(raw);
    if (!Number.isFinite(count) || count <= 0) return 0;
    return Math.floor(count);
  } catch {
    return 0;
  }
};

const setCachedUnreadCount = async (count: number): Promise<void> => {
  const safe = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  try {
    await storeAuthData(NOSTR_SUPPORT_UNREAD_CACHE_KEY, String(safe));
  } catch {
    // Best-effort cache write
  }
  EventBus.emit("support:unreadCount", safe);
};

const storeSeenIds = async (ids: string[]): Promise<void> => {
  try {
    await storeAuthData(NOSTR_SUPPORT_SEEN_IDS_CACHE_KEY, JSON.stringify(ids));
  } catch {
    // Best-effort cache write
  }
};

const syncSupportUnread = async (): Promise<void> => {
  if (inFlight || chatActive) return;
  inFlight = true;
  try {
    const rawPubkey = await getAuthData(NOSTR_PUBKEY_CACHE_KEY);
    const pubkeyHex = String(rawPubkey || "")
      .trim()
      .toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(pubkeyHex)) return;

    const [seedIds, previousCount, lastSync, pendingEvents] = await Promise.all([
      loadSeedIds(),
      getCachedUnreadCount(),
      getLastSync(),
      loadPendingEvents(),
    ]);
    const seenSet = new Set<string>(seedIds);
    const pendingIds = new Set<string>(pendingEvents.map((event) => event.id));
    let seenIds = [...seenSet];
    let pending = [...pendingEvents];
    let newCount = 0;
    let updatedSeen = false;
    let updatedPending = false;

    const relayUrls = Array.from(
      new Set(RELAY_URLS.map((url) => String(url || "").trim()).filter(Boolean)),
    );
    if (relayUrls.length === 0) return;
    const nowSec = Math.floor(Date.now() / 1000);
    const since =
      lastSync > 0
        ? Math.max(0, lastSync - NOSTR_LAST_SYNC_SKEW_SEC)
        : Math.max(0, nowSec - SYNC_WINDOW_SEC);

    const syncRelay = async (relayUrl: string): Promise<void> =>
      await new Promise<void>((resolve) => {
        let done = false;
        const subId = `unread-${pubkeyHex.slice(0, 8)}-${Date.now()}`;
        const ws = new WebSocket(relayUrl);

        let timeout: ReturnType<typeof setTimeout> | null = null;
        const finalize = () => {
          if (done) return;
          done = true;
          if (timeout) {
            clearTimeout(timeout);
            timeout = null;
          }
          try {
            ws.close();
          } catch {}
          resolve();
        };

        timeout = setTimeout(finalize, NOSTR_SOCKET_TIMEOUT_MS);

        ws.onopen = () => {
          try {
            ws.send(
              JSON.stringify([
                "REQ",
                subId,
                {
                  kinds: [NOSTR_KINDS.GIFT_WRAP, NOSTR_KINDS.DM],
                  "#p": [pubkeyHex],
                  since,
                },
              ]),
            );
          } catch {
            finalize();
          }
        };

        ws.onmessage = (event) => {
          if (typeof event.data !== "string") return;
          let parsed: any;
          try {
            parsed = JSON.parse(event.data);
          } catch {
            return;
          }
          if (!Array.isArray(parsed) || parsed.length < 2) return;
          const type = parsed[0];
          if (type === "EOSE") {
            finalize();
            return;
          }
          if (type !== "EVENT") return;
          const nostrEvent = parsed[2];
          const kind = Number(nostrEvent?.kind);
          if (!nostrEvent || (kind !== NOSTR_KINDS.GIFT_WRAP && kind !== NOSTR_KINDS.DM)) {
            return;
          }
          const eventId = String(nostrEvent.id || "").trim();
          if (!eventId || !isHexId(eventId) || seenSet.has(eventId) || pendingIds.has(eventId)) {
            return;
          }
          seenSet.add(eventId);
          seenIds.push(eventId);
          newCount += 1;
          updatedSeen = true;
          const normalized = normalizePendingEvent(nostrEvent);
          if (normalized) {
            pending.push(normalized);
            pendingIds.add(eventId);
            updatedPending = true;
          }
        };

        ws.onerror = () => {
          finalize();
        };

        ws.onclose = () => {
          finalize();
        };
      });

    await Promise.all(relayUrls.map((relayUrl) => syncRelay(relayUrl)));

    if (updatedSeen) {
      if (seenIds.length > MAX_SEEN_IDS) {
        seenIds = seenIds.slice(seenIds.length - MAX_SEEN_IDS);
      }
      await storeSeenIds(seenIds);
    }

    if (pending.length > MAX_SEEN_IDS) {
      pending = trimPendingEvents(pending);
      updatedPending = true;
    }

    if (updatedPending) {
      await storePendingEvents(pending);
    }

    const pendingIdsToOpen = pending
      .map((event) => String(event.id || "").trim())
      .filter((id) => id && !autoOpenedPendingIds.has(id));
    if (newCount > 0 || pendingIdsToOpen.length > 0) {
      pendingIdsToOpen.forEach((id) => autoOpenedPendingIds.add(id));
      EventBus.emit("support:incomingMessage", {
        count: Math.max(newCount, pendingIdsToOpen.length),
      });
    }

    const nextCount = Math.max(previousCount + newCount, pending.length);
    if (nextCount !== previousCount) {
      await setCachedUnreadCount(nextCount);
    }
    await setLastSync(nowSec);
  } finally {
    inFlight = false;
    if (queued) {
      queued = false;
      void syncSupportUnread();
    }
  }
};

export const requestSupportUnreadSync = (): void => {
  if (inFlight) {
    queued = true;
    return;
  }
  void syncSupportUnread();
};

export const startSupportUnreadSync = (): void => {
  if (timer) return;
  requestSupportUnreadSync();
  timer = setInterval(() => {
    requestSupportUnreadSync();
  }, NOSTR_SYNC_INTERVAL_MS);
};

export const stopSupportUnreadSync = (): void => {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
};
