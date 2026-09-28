import { useEffect, useRef, useState } from "react";
import { getEthereumAddress } from "../../lib/secureKeyStorage";
import { hasOpenSurface, subscribeOpenSurfaces } from "../../lib/ui/openSurfaces";
import { EventBus } from "../../services/events/AppEventBusService";
import { SwapKitOrderStore } from "../../services/swapkit/SwapKitOrderStore";
import { getSwapKitLastStatus } from "../../services/swapkit/SwapKitPendingTracker";
import { isWalletOpenRecovery } from "../../services/swapkit/SwapKitWalletOpenRecovery";
import SwapStatusDetailSheet from "./SwapStatusDetailSheet";

/** One presentation per order per unlocked-owner session; no new recovery engine.
 *
 * Why defer and dedupe (incident 2026-09-13, #1325): this host fires on wallet
 * unlock, the busiest UI moment. hasOpenSurface lets signing/payment sheets win;
 * the shown-set keeps one order to one prompt per session so a dismissed sheet
 * never nags. Dismissal deletes nothing; the tracker row and its receipt gate
 * are untouched. */
export default function SwapKitWalletOpenRecoveryHost({
  owner,
  enabled,
}: { owner: string; enabled: boolean }) {
  const [orderId, setOrderId] = useState<string | null>(null);
  const shown = useRef(new Set<string>());
  const current = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) {
      current.current = null;
      setOrderId(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      clearTimeout(timer);
      // Let sibling sheets register first, including signing/payment surfaces.
      timer = setTimeout(() => {
        if (cancelled || current.current || hasOpenSurface()) return;
        void getEthereumAddress()
          .then((unlockedOwner) => {
            if (
              cancelled ||
              current.current ||
              hasOpenSurface() ||
              unlockedOwner?.toLowerCase() !== owner.toLowerCase()
            )
              return;
            const candidate = SwapKitOrderStore.list().find(
              (order) =>
                !shown.current.has(order.txId) &&
                isWalletOpenRecovery(order, getSwapKitLastStatus(order.txId), owner),
            );
            if (!candidate) return;
            shown.current.add(candidate.txId);
            current.current = candidate.txId;
            setOrderId(candidate.txId);
          })
          .catch(() => {});
      }, 0);
    };
    const reset = () => {
      current.current = null;
      setOrderId(null);
    };
    // Subscribe BEFORE the initial scan: both warm cache and late hydration work.
    const offTrack = EventBus.on("swapkit:trackUpdated", check);
    const offRefresh = EventBus.on("transactions:refresh", check);
    const offReset = EventBus.on("ui:resetMainScreens", reset);
    const offSurfaces = subscribeOpenSurfaces(check);
    check();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      offTrack();
      offRefresh();
      offReset();
      offSurfaces();
    };
  }, [enabled, owner]);

  return enabled && orderId ? (
    <SwapStatusDetailSheet
      key={orderId}
      visible
      orderId={orderId}
      onClose={() => {
        current.current = null;
        setOrderId(null);
      }}
    />
  ) : null;
}
