// screens/wirex/hooks/useWirexCard.ts
// Thin React subscriber over WirexAccountService — the app-lifetime singleton
// that owns all Wirex account data/caching/orchestration. This hook only bridges
// the service to React render: it subscribes for change notifications and returns
// the current snapshot + action state. No logic lives here. SECURITY: never logs
// the wallet address or balance value.
import { useEffect, useState } from "react";
import {
  wirexAccountService,
  type WirexCardSnapshot,
} from "../../../services/wirex/WirexAccountService";

// Re-export so existing `import { type WirexCardSnapshot } from "./hooks/useWirexCard"` keeps working.
export type { WirexCardSnapshot };

export interface WirexCardState extends WirexCardSnapshot {
  actionBusy: boolean;
  actionError: boolean;
  // An issuance failed and no read established whether a card was created, so
  // issuing again is withheld until a later load settles it.
  issueUnresolved: boolean;
  // A non-silent load (mount / pull-to-refresh) is still confirming status.
  revalidating: boolean;
  toggleFreeze: (cardId?: string) => void;
  issueVirtualCard: () => Promise<boolean>;
  closeCard: (cardId: string, last4: string) => Promise<boolean>;
  refetch: () => Promise<WirexCardSnapshot | null>;
  silentRefetch: () => Promise<WirexCardSnapshot | null>;
  pollRefetch: () => Promise<WirexCardSnapshot | null>;
}

export function useWirexCard(): WirexCardState {
  const [, forceRender] = useState(0);
  useEffect(() => {
    const unsub = wirexAccountService.subscribe(() => forceRender((n) => n + 1));
    wirexAccountService.ensureStarted();
    return unsub;
  }, []);
  return {
    ...wirexAccountService.getSnapshot(),
    actionBusy: wirexAccountService.actionBusy,
    actionError: wirexAccountService.actionError,
    issueUnresolved: wirexAccountService.issueUnresolved,
    revalidating: wirexAccountService.revalidating,
    toggleFreeze: (cardId?: string) => wirexAccountService.toggleFreeze(cardId),
    issueVirtualCard: () => wirexAccountService.issueVirtualCard(),
    closeCard: (cardId: string, last4: string) => wirexAccountService.closeCard(cardId, last4),
    refetch: () => wirexAccountService.refresh(true),
    silentRefetch: () => wirexAccountService.silentRefresh(true),
    // Balance-oriented refresh: reuses the 60s status cache instead of forcing
    // the documented ~90s /status path, so a repeating caller stays cheap. The
    // /wallet balance read is never cached, so the figure is still live.
    pollRefetch: () => wirexAccountService.silentRefresh(false),
  };
}
