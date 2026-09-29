// screens/home/hooks/useCardDetailDeepLink.ts
// Drains a queued card-detail request from a support deep link (`show-iban` /
// `show-card-number`).
//
// The intent is parked in lib/cardDetailIntent rather than emitted once, because
// a one-shot emit is lost on a cold start or before the Wirex data has loaded —
// EventBus does not buffer. So it stays parked until the home is mounted AND the
// matching data is ready, and only then is it cleared.
//
// Two triggers, and both are needed: readiness changes cover the cold start and
// the mid-load case, while the explicit nudge covers a home that is already
// mounted and ready, where no state change would re-run the first one.
import { useCallback, useEffect } from "react";
import { clearPendingCardDetail, peekPendingCardDetail } from "../../../lib/cardDetailIntent";
import type { CardDetailTab } from "../../../lib/cardDetailIntent";
import { EventBus } from "../../../services/events/AppEventBusService";

type Params = {
  /** The bank details exist — without them there is nothing to show. */
  bankReady: boolean;
  /** The account's card id, or null while there is no card yet. */
  cardId: string | null;
  cardFrozen: boolean;
  /** Open the details sheet on a given side without fetching anything. */
  openDetails: (tab: CardDetailTab) => void;
  /** Fetch and show the card's secrets. Must be referentially stable. */
  revealCard: () => void | Promise<void>;
};

export function useCardDetailDeepLink({
  bankReady,
  cardId,
  cardFrozen,
  openDetails,
  revealCard,
}: Params): void {
  const drain = useCallback(() => {
    const target = peekPendingCardDetail();
    if (!target) return;
    if (target === "bank") {
      if (!bankReady) return;
      clearPendingCardDetail();
      openDetails("bank");
      return;
    }
    if (!cardId) return;
    clearPendingCardDetail();
    // Wirex 400s the sensitive reveal for a frozen card, so open the sheet and
    // let it show the unfreeze hint instead of fetching.
    if (cardFrozen) {
      openDetails("card");
      return;
    }
    void revealCard();
  }, [bankReady, cardId, cardFrozen, openDetails, revealCard]);

  useEffect(() => {
    drain();
  }, [drain]);

  useEffect(() => EventBus.on("card:drainPendingDetail", drain), [drain]);
}
