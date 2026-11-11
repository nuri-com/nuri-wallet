// screens/wirex/hooks/useUkPayoutFlow.ts
// Send from Visa & Banking to a UK bank account: pick a saved UK payee (or add
// one), then the amount. The hand-off between sheets is the screen's, so each
// step opens through `handOff`.
import { useCallback, useRef, useState } from "react";
import { wirexService, type WirexUkPayee } from "../../../services/wirex/WirexService";

export const ADD_UK_PAYEE_KEY = "add";

export function useUkPayoutFlow(handOff: (open: () => void) => void) {
  // The saved payees while the pick sheet is up; null when it is closed.
  const [payees, setPayees] = useState<WirexUkPayee[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [addVisible, setAddVisible] = useState(false);
  const [payee, setPayee] = useState<WirexUkPayee | null>(null);
  // Bumped whenever the flow closes or restarts: a payee list that answers
  // late never opens a sheet over whatever the user moved on to.
  const generation = useRef(0);

  const start = useCallback(async () => {
    const mine = ++generation.current;
    const current = () => generation.current === mine;
    setLoadFailed(false);
    try {
      const list = await wirexService.listUkPayees();
      if (!current()) return;
      // No saved payee yet: straight to adding one.
      if (list.length === 0) handOff(() => current() && setAddVisible(true));
      else handOff(() => current() && setPayees(list));
    } catch {
      if (!current()) return;
      setLoadFailed(true);
      handOff(() => current() && setPayees([]));
    }
  }, [handOff]);

  const pick = useCallback(
    (key: string) => {
      const chosen = payees?.find((p) => p.payeeId === key) ?? null;
      setPayees(null);
      if (key === ADD_UK_PAYEE_KEY) return handOff(() => setAddVisible(true));
      if (chosen) handOff(() => setPayee(chosen));
    },
    [payees, handOff],
  );

  const added = useCallback(
    (saved: WirexUkPayee) => {
      setAddVisible(false);
      handOff(() => setPayee(saved));
    },
    [handOff],
  );

  const closeAll = useCallback(() => {
    generation.current += 1;
    setPayees(null);
    setAddVisible(false);
    setPayee(null);
  }, []);

  return {
    payees,
    loadFailed,
    closePick: () => {
      generation.current += 1;
      setPayees(null);
    },
    pick,
    addVisible,
    closeAdd: () => setAddVisible(false),
    added,
    payee,
    closeAmount: () => setPayee(null),
    start,
    closeAll,
  };
}
