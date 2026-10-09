// screens/wirex/hooks/useWirex3dsChallenges.ts
// Owns the pending in-app 3DS challenge poll (fetch on mount + AppState →
// active + `card:refresh`, which a tapped 3DS push emits) and the respond
// action. The push carries no challenge data — it only says one is waiting, so
// every path here still reads the pending list from the server.
// The presentational Wirex3dsApprovalModal consumes this state.
// A challenge no longer returned by a later fetch is treated as
// resolved/expired and dropped (Wirex documents expiry but not the TTL —
// never hard-code one). SECURITY: never logs merchant/amount/card data;
// only counts and transaction_id.
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { EventBus } from "../../../services/events/AppEventBusService";
import { createViewEpoch, submit3dsResponse } from "../../../lib/wirex/threeDsResponse";
import { wirexService, type Wirex3dsChallenge } from "../../../services/wirex/WirexService";

export interface Wirex3dsState {
  // The approved challenge while its confirmation shows, else the first
  // pending one (shown one at a time).
  challenge: Wirex3dsChallenge | null;
  approved: boolean;
  visible: boolean;
  responding: boolean;
  respond: (approve: boolean) => void;
  done: () => void;
  dismiss: () => void;
}

export function useWirex3dsChallenges(params: {
  wallet: string | null;
  enabled: boolean; // gate: only poll once the account has a card
}): Wirex3dsState {
  const { wallet, enabled } = params;
  const [challenges, setChallenges] = useState<Wirex3dsChallenge[]>([]);
  const [visible, setVisible] = useState(false);
  const [responding, setResponding] = useState(false);
  // Held after the server accepted an Approve, until the user taps Done.
  const [approved, setApproved] = useState<Wirex3dsChallenge | null>(null);
  const [viewEpoch] = useState(createViewEpoch);
  // Generation counter: each fetch bumps it; a resolution whose token no
  // longer matches is stale (params changed or unmounted) and is ignored.
  const fetchToken = useRef(0);
  // Synchronous in-flight guard: `responding` state flips only on the next
  // render, so a rapid second tap (Approve then Decline) could start a second
  // signed respond for the same challenge. The ref closes that window.
  const respondInFlight = useRef(false);

  const refetch = useCallback(async () => {
    const token = ++fetchToken.current;
    if (!enabled || !wallet) {
      setChallenges([]);
      setVisible(false);
      return;
    }
    try {
      const list = await wirexService.list3dsPending(wallet);
      if (token !== fetchToken.current) return;
      setChallenges(list);
      // A fresh non-empty poll re-surfaces the modal even after a manual
      // dismiss — the challenge is still blocking the user's checkout.
      setVisible(list.length > 0);
    } catch {
      // Silent fail: keep previous state, no error UI.
      console.warn("[useWirex3dsChallenges] pending fetch failed");
    }
  }, [enabled, wallet]);

  useEffect(() => {
    void refetch();
    let lastAppState: AppStateStatus = AppState.currentState;
    const subscription = AppState.addEventListener("change", (next: AppStateStatus) => {
      const prev = lastAppState;
      lastAppState = next;
      if (next !== "active" || prev === "active") return;
      void refetch();
    });
    // Card-tab press fires resetMainScreensUi() (which dismisses this view)
    // followed by card:refresh — re-polling here re-surfaces a still-pending
    // challenge, so a dismissed approval stays reachable within the same
    // foreground session (the checkout is blocked on it).
    const offCardRefresh = EventBus.on("card:refresh", () => {
      void refetch();
    });
    return () => {
      subscription.remove();
      offCardRefresh();
      // Invalidate any in-flight fetch so it can't resolve after unmount.
      fetchToken.current += 1;
      // A session change: no earlier response may show its confirmation.
      viewEpoch.invalidate();
      setApproved(null);
    };
  }, [refetch, viewEpoch]);

  // Hide once the list empties — respond removed the last challenge, or a
  // poll returned none. (refetch sets visibility for non-empty results.)
  useEffect(() => {
    if (challenges.length === 0) setVisible(false);
  }, [challenges]);

  const respond = useCallback(
    (approve: boolean) => {
      if (respondInFlight.current) return;
      const current = challenges[0];
      if (!current) return;
      respondInFlight.current = true;
      setResponding(true);
      const epoch = viewEpoch.capture();
      void (async () => {
        try {
          const outcome = await submit3dsResponse(
            () => wirexService.respond3ds({ transactionId: current.transactionId, approve }),
            approve,
          );
          if (outcome === "failed") {
            // Silent fail: modal stays open so the user can retry.
            console.warn(
              `[useWirex3dsChallenges] respond failed transaction_id=${current.transactionId}`,
            );
            return;
          }
          if (outcome === "approved" && viewEpoch.isCurrent(epoch)) setApproved(current);
          // Functional update: a foreground poll can land while the respond
          // call is in flight — filter the freshest list, not the tap-time
          // closure, so its result is never overwritten.
          setChallenges((prev) => prev.filter((c) => c.transactionId !== current.transactionId));
          // Pick up any remaining/expired state from the server.
          void refetch();
        } finally {
          respondInFlight.current = false;
          setResponding(false);
        }
      })();
    },
    [challenges, refetch, viewEpoch],
  );

  const done = useCallback(() => setApproved(null), []);
  // Referentially stable — the screen wires this into an EventBus reset handler.
  const dismiss = useCallback(() => {
    viewEpoch.invalidate();
    setVisible(false);
    setApproved(null);
  }, [viewEpoch]);

  return {
    challenge: approved ?? challenges[0] ?? null,
    approved: approved != null,
    visible: visible || approved != null,
    responding,
    respond,
    done,
    dismiss,
  };
}
