import { useEffect, useState } from "react";
import { EventBus } from "../../services/events/AppEventBusService";
import { getSupportUnreadCount, SUPPORT_PUBKEY } from "./unread";

/**
 * Unread support messages: seeded once, then follows the app-wide broadcast
 * from NostrUnreadSync. Every surface that badges support reads this one hook.
 */
export function useSupportUnreadCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const seeded = await getSupportUnreadCount(SUPPORT_PUBKEY);
        if (mounted) setCount(seeded);
      } catch {}
    })();
    const off = EventBus.on("support:unreadCount", (payload?: unknown) => {
      const next = typeof payload === "number" ? payload : Number(payload);
      if (mounted && Number.isFinite(next)) setCount(Math.max(0, Math.floor(next)));
    });
    return () => {
      mounted = false;
      off();
    };
  }, []);
  return count;
}
