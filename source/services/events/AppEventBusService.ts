import { logWithId, LOG_EMOJI, type LogContext } from "../../lib/OperationLogUtils";
type Listener<T = any> = (payload?: T) => void;

const EVENTBUS_LOG_MAX_KEYS = 18;
const EVENTBUS_DEBUG_THROTTLE_MS = 5000;
const EVENTBUS_NOISY_EVENTS = new Set(["support:unreadCount", "support:chatActive"]);

function truncate(text: string, limit: number): string {
  const raw = String(text ?? "");
  if (!raw) return "";
  if (raw.length <= limit) return raw;
  return `${raw.slice(0, limit)}…`;
}

function summarizePayload(payload: any): any {
  if (payload === undefined) return undefined;
  if (payload === null) return null;
  const t = typeof payload;
  if (t === "string") return truncate(payload, 180);
  if (t === "number" || t === "boolean") return payload;
  if (Array.isArray(payload)) return { type: "array", len: payload.length };
  if (t === "object") {
    const keys = Object.keys(payload);
    return {
      type: "object",
      keys: keys.slice(0, EVENTBUS_LOG_MAX_KEYS),
      keyCount: keys.length,
    };
  }
  return { type: t };
}

function inferEventContext(event: string): LogContext {
  const normalized = String(event || "").toLowerCase();
  if (!normalized) return "system";
  if (/\bpoll\b|pending|watchdog|heartbeat|refresh/.test(normalized)) return "poll";
  if (/^ui:|^nav:|open|close|press|tap|copy|paste|submit|confirm|click/.test(normalized))
    return "user";
  if (/init|bootstrap|prefetch|sync|load|network:/.test(normalized)) return "background";
  return "system";
}

class SimpleEventBus {
  private listeners: Record<string, Set<Listener>> = {};
  private emitDebugState = new Map<string, { ts: number; signature: string }>();

  on<T = any>(event: string, listener: Listener<T>): () => void {
    if (!this.listeners[event]) this.listeners[event] = new Set();
    this.listeners[event].add(listener as Listener<T>);
    return () => {
      this.listeners[event]?.delete(listener as Listener<T>);
    };
  }

  emit<T = any>(event: string, payload?: T): void {
    const set = this.listeners[event];
    if (!set || set.size === 0) return;
    try {
      if (EVENTBUS_NOISY_EVENTS.has(event)) {
        // Skip high-frequency support heartbeat events from the default stream.
        for (const fn of Array.from(set)) {
          try {
            fn(payload);
          } catch {}
        }
        return;
      }
      const payloadSummary = summarizePayload(payload);
      const signature = `${set.size}|${JSON.stringify(payloadSummary)}`;
      const now = Date.now();
      const previous = this.emitDebugState.get(event);
      const shouldLog =
        !previous ||
        previous.signature !== signature ||
        now - previous.ts >= EVENTBUS_DEBUG_THROTTLE_MS;

      if (shouldLog) {
        this.emitDebugState.set(event, { ts: now, signature });
        const context = inferEventContext(event);
        logWithId(
          `${LOG_EMOJI.app} EventBus.emit`,
          `${event} listeners=${set.size}`,
          payloadSummary,
          { context },
        );
      }
    } catch {}
    for (const fn of Array.from(set)) {
      try {
        fn(payload);
      } catch {}
    }
  }
}

export const EventBus = new SimpleEventBus();

// Global UI reset: close every overlay/modal the app has open. The home and the
// flow hooks subscribe to 'ui:resetMainScreens' and clear their own state — the
// biometric lock relies on it, so nothing sensitive is left behind the lock.
export const resetMainScreensUi = () => {
  try {
    logWithId(`${LOG_EMOJI.app} EventBus.action`, "ui:resetMainScreens", undefined, {
      context: "user",
    });
  } catch {}
  EventBus.emit("ui:resetMainScreens");
};

// Common events:
// - 'wallet:refresh'
// - 'card:refresh'
// - 'card:refreshBalance'
// - 'wallet:optimisticCredit'  { amount, asset? } — asset names the balance the
//   credit belongs to; omitted means the euro wallet, which every pre-dollar
//   caller meant. The card screen authorised a
//                              withdrawal; the wallet shows it before it lands
// - 'transactions:refresh'
// - 'supportDump:open'
