// The Cash history's view of the card's withdrawals (see lib/wirex/cardWithdrawals).
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { fetchCardBurns } from "./cardWithdrawals";
import { wirexAccountService } from "./WirexAccountService";

const LOG_TAG = "[CardWithdrawals]";

const subscribe = (listener: () => void) => wirexAccountService.subscribe(listener);
const cardAddress = () => (wirexAccountService.accountAddress() ?? "").toLowerCase();

/**
 * The transactions in which the signed-in card withdrew, for the Cash history:
 * a payment arriving in one of them is the user's own card, not a stranger.
 * Read when the list opens and again once the card's address is known; `reload`
 * reads again (the list calls it on every refresh, so a failed read or a
 * withdrawal that lands while the list is open is picked up). A failed read
 * keeps the transactions already known.
 */
export function useCardWithdrawalTxs(active: boolean): {
  txs: ReadonlySet<string>;
  reload: () => void;
} {
  const card = useSyncExternalStore(subscribe, cardAddress, cardAddress);
  const [txs, setTxs] = useState<ReadonlySet<string>>(() => new Set());
  const [round, setRound] = useState(0);
  const reload = useCallback(() => setRound((n) => n + 1), []);
  const readFor = useRef("");

  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` is the re-read trigger, not a value read
  useEffect(() => {
    if (readFor.current !== card) {
      // Another card's withdrawals never label this one's Cash.
      readFor.current = card;
      setTxs(new Set());
    }
    if (!active || !card) return;
    let live = true;
    fetchCardBurns(card)
      .then((burns) => {
        if (live) setTxs(new Set(burns.map((b) => b.txHash)));
      })
      .catch((e) => {
        console.log(`${LOG_TAG} not loaded`, {
          message: e instanceof Error ? e.message : "unknown",
        });
      });
    return () => {
      live = false;
    };
  }, [active, card, round]);

  return { txs, reload };
}
