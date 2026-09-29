import type { NostrEvent } from "./nostr";

export type RelayPublishResult = { tried: number; opened: number; ackedOk: number };

/** Send one signed Nostr event to one relay, resolving on OK ack or timeout. */
export async function sendNostrEventToRelay(
  relayUrl: string,
  nostrEvent: NostrEvent,
  timeoutMs: number,
): Promise<{ opened: boolean; ackedOk: boolean }> {
  return await new Promise((resolve) => {
    let opened = false;
    let finalized = false;
    const ws = new WebSocket(relayUrl);

    const finalize = (ackedOk: boolean) => {
      if (finalized) return;
      finalized = true;
      try {
        ws.close();
      } catch {}
      resolve({ opened, ackedOk });
    };

    const timer = setTimeout(() => finalize(false), Math.max(500, timeoutMs));

    ws.onopen = () => {
      opened = true;
      try {
        ws.send(JSON.stringify(["EVENT", nostrEvent]));
      } catch {
        clearTimeout(timer);
        finalize(false);
      }
    };

    ws.onerror = () => {
      clearTimeout(timer);
      finalize(false);
    };

    ws.onclose = () => {
      clearTimeout(timer);
      finalize(false);
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let parsed: any;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!Array.isArray(parsed) || parsed.length < 3) return;
      if (parsed[0] !== "OK") return;
      const eventId = String(parsed[1] || "");
      if (nostrEvent.id && eventId !== nostrEvent.id) return;
      const ok = Boolean(parsed[2]);
      clearTimeout(timer);
      finalize(ok);
    };
  });
}

export type NostrRelayFilter = {
  kinds?: number[];
  authors?: string[];
  "#d"?: string[];
  limit?: number;
};

/** Fetch the newest event matching a filter from one relay (EOSE or timeout ends it). */
export function fetchNewestNostrEventFromRelay(
  relayUrl: string,
  filter: NostrRelayFilter,
  timeoutMs: number,
): Promise<NostrEvent | null> {
  return new Promise((resolve) => {
    let newest: NostrEvent | null = null;
    let finalized = false;
    const ws = new WebSocket(relayUrl);
    const subId = `nuri-${Math.random().toString(36).slice(2, 10)}`;

    const finalize = () => {
      if (finalized) return;
      finalized = true;
      try {
        ws.close();
      } catch {}
      resolve(newest);
    };

    const timer = setTimeout(finalize, Math.max(500, timeoutMs));

    ws.onopen = () => {
      try {
        ws.send(JSON.stringify(["REQ", subId, filter]));
      } catch {
        clearTimeout(timer);
        finalize();
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      finalize();
    };
    ws.onclose = () => {
      clearTimeout(timer);
      finalize();
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let parsed: any;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!Array.isArray(parsed)) return;
      if (parsed[0] === "EVENT" && parsed[1] === subId && parsed[2]) {
        const candidate = parsed[2] as NostrEvent;
        if (!newest || Number(candidate.created_at || 0) > Number(newest.created_at || 0)) {
          newest = candidate;
        }
        return;
      }
      if (parsed[0] === "EOSE" && parsed[1] === subId) {
        clearTimeout(timer);
        finalize();
      }
    };
  });
}

/** Newest matching event across a relay list (per-relay newest, then global newest). */
export async function fetchNewestNostrEventFromRelays(
  relayUrls: string[],
  filter: NostrRelayFilter,
  timeoutMs: number,
): Promise<NostrEvent | null> {
  const urls = Array.from(new Set(relayUrls.map((u) => String(u || "").trim()).filter(Boolean)));
  const results = await Promise.all(
    urls.map((url) => fetchNewestNostrEventFromRelay(url, filter, timeoutMs)),
  );
  return (
    results
      .filter((event): event is NostrEvent => Boolean(event))
      .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))[0] ?? null
  );
}

/** Publish one signed event to a deduplicated relay list, returning ack counts. */
export async function publishNostrEventToRelays(
  relayUrls: string[],
  nostrEvent: NostrEvent,
  timeoutMs: number,
): Promise<RelayPublishResult> {
  const urls = Array.from(new Set(relayUrls.map((u) => String(u || "").trim()).filter(Boolean)));
  const results = await Promise.all(
    urls.map((url) => sendNostrEventToRelay(url, nostrEvent, timeoutMs)),
  );
  return {
    tried: urls.length,
    opened: results.filter((r) => r.opened).length,
    ackedOk: results.filter((r) => r.ackedOk).length,
  };
}
