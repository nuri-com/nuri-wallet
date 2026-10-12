// screens/wirex/hooks/useCardPayoutFlow.ts
// Send from Visa & Banking to a card: pick a saved payout card (or add one),
// then the amount. The hand-off between sheets is the screen's, so each step
// opens through `handOff`.
import { useCallback, useState } from "react";
import { wirexService, type WirexPayoutCard } from "../../../services/wirex/WirexService";
import type { CardPayoutPrefill } from "../modals/CardPayoutAddModal";

export const ADD_PAYOUT_CARD_KEY = "add";

export function useCardPayoutFlow(handOff: (open: () => void) => void) {
  // The saved cards while the pick sheet is up; null when it is closed.
  const [cards, setCards] = useState<WirexPayoutCard[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [addVisible, setAddVisible] = useState(false);
  // A card picked in the address book: the add screen opens filled in.
  const [prefill, setPrefill] = useState<CardPayoutPrefill | null>(null);
  const [card, setCard] = useState<WirexPayoutCard | null>(null);

  const start = useCallback(async () => {
    setLoadFailed(false);
    try {
      const list = await wirexService.listPayoutCards();
      // No saved card yet: straight to adding one.
      if (list.length === 0) handOff(() => setAddVisible(true));
      else handOff(() => setCards(list));
    } catch {
      setLoadFailed(true);
      handOff(() => setCards([]));
    }
  }, [handOff]);

  const startWith = useCallback(
    (card: CardPayoutPrefill) => {
      handOff(() => {
        setPrefill(card);
        setAddVisible(true);
      });
    },
    [handOff],
  );

  const pick = useCallback(
    (key: string) => {
      const chosen = cards?.find((c) => c.recipientId === key) ?? null;
      setCards(null);
      if (key === ADD_PAYOUT_CARD_KEY) return handOff(() => setAddVisible(true));
      if (chosen) handOff(() => setCard(chosen));
    },
    [cards, handOff],
  );

  const added = useCallback(
    (saved: WirexPayoutCard) => {
      setAddVisible(false);
      setPrefill(null);
      handOff(() => setCard(saved));
    },
    [handOff],
  );

  const closeAll = useCallback(() => {
    setCards(null);
    setAddVisible(false);
    setPrefill(null);
    setCard(null);
  }, []);

  return {
    cards,
    loadFailed,
    closePick: () => setCards(null),
    pick,
    addVisible,
    closeAdd: () => {
      setAddVisible(false);
      setPrefill(null);
    },
    prefill,
    startWith,
    added,
    card,
    closeAmount: () => setCard(null),
    start,
    closeAll,
  };
}
