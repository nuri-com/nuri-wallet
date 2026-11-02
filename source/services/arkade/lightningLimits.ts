// Binds the Lightning limits store to the server's live-card answer and to React.
import { useEffect, useSyncExternalStore } from "react";
import { arkadeLightningLimits } from "./ArkadeApiService";
import {
  type ArkadeLightningLimits,
  getArkadeLightningLimits,
  refreshArkadeLightningLimits as refreshFrom,
  subscribeArkadeLightningLimits,
} from "./internal/lightningLimitsStore";

/** Re-read the limits from the server unless they are fresh. */
export function refreshArkadeLightningLimits(): Promise<void> {
  return refreshFrom(arkadeLightningLimits);
}

/**
 * The current limits. Each time `active` turns true (the sheet opens; the
 * sheets stay mounted while hidden) they are re-read unless fresh.
 */
export function useArkadeLightningLimits(active: boolean): ArkadeLightningLimits {
  useEffect(() => {
    if (active) void refreshArkadeLightningLimits();
  }, [active]);
  return useSyncExternalStore(subscribeArkadeLightningLimits, getArkadeLightningLimits);
}
