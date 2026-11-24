// screens/wirex/hooks/useCardPayoutFlow.ts
// Send from Visa & Banking to a card: pick a saved payout card (or add one),
// then the amount. The hand-off between sheets is the screen's, so each step
// opens through `handOff`.
import { useCallback, useRef, useState } from "react";
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
  // The cards already saved with Wirex, for the add screen: adding one of them
  // again would list it twice (#1753). Empty when the list could not be read.
  const [savedCards, setSavedCards] = useState<WirexPayoutCard[]>([]);
  // Bumped whenever the flow closes or restarts: a card list that answers
  // late never opens a sheet over whatever the user moved on to.
  const generation = useRef(0);

  const start = useCallback(async () => {
    const mine = ++generation.current;
    const current = () => generation.current === mine;
    setLoadFailed(false);
    try {
      const list = await wirexService.listPayoutCards();
      if (!current()) return;
      setSavedCards(list);
      // No saved card yet: straight to adding one.
      if (list.length === 0) handOff(() => current() && setAddVisible(true));
      else handOff(() => current() && setCards(list));
    } catch {
      if (!current()) return;
      setSavedCards([]);
      setLoadFailed(true);
      handOff(() => current() && setCards([]));
    }
  }, [handOff]);

  // A card picked in the address book. The add screen opens at once; its saved
  // Wirex twin, if any, is offered as soon as the saved list answers. A list
  // that stalls or fails only means no offer, never a sheet that does not open.
  const startWith = useCallback(
    (card: CardPayoutPrefill) => {
      const mine = ++generation.current;
      const current = () => generation.current === mine;
      setSavedCards([]);
      handOff(() => {
        if (!current()) return;
        setPrefill(card);
        setAddVisible(true);
      });
      wirexService.listPayoutCards().then(
        (list) => {
          if (current()) setSavedCards(list);
        },
        () => {
          // Unreadable list: the add screen still works, it just cannot offer.
        },
      );
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
    generation.current += 1;
    setCards(null);
    setAddVisible(false);
    setPrefill(null);
    setCard(null);
    setSavedCards([]);
  }, []);

  return {
    cards,
    loadFailed,
    closePick: () => {
      generation.current += 1;
      setCards(null);
    },
    pick,
    addVisible,
    closeAdd: () => {
      setAddVisible(false);
      setPrefill(null);
    },
    prefill,
    savedCards,
    startWith,
    added,
    card,
    closeAmount: () => setCard(null),
    start,
    closeAll,
  };
}
