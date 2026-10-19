// The Move sheet's swap, from price to acceptance to execution.
//
// It is a hook rather than sheet state because the ORDER of the two calls is
// the safety property, not a detail of the screen: `requestQuotes` prices and
// creates nothing, so it may run as often as the user likes, and only
// `confirm` — the user accepting one of those prices — is allowed to move
// money. Every pair goes through the same two steps, so no direction can grow
// a shortcut past the confirmation.
//
// Which pairs work is not written down anywhere here: a pair is routable when
// `quoteSwap` answers with an executable quote for it, and not otherwise.
import { useCallback, useRef, useState } from "react";
import { errMsg } from "../../../lib/errorMessage";
import { reportErrorToSupport } from "../../../lib/support/reportErrorToSupport";
import { isUserCancelledAuth } from "../../../lib/support/isUserCancelledAuth";
import { bitcoinBalanceStore } from "../../../services/bitcoin/BitcoinBalanceStore";
import {
  executeSwap,
  quoteSwap,
  type SwapAssetId,
  type SwapExecution,
  type SwapQuote,
} from "../../../services/swapkit/SwapContract";
import { noteV2MoveBaseline } from "../../../services/swapkit/SwapKitV2MoveAccounting";
import { noteV2MoveCommitted } from "../../../services/swapkit/SwapKitV2MoveStatus";
import { spendsArkadeBalance } from "../moveBookkeeping";

export type MoveSwapRequest = {
  from: SwapAssetId;
  to: SwapAssetId;
  amount: number;
  /** Which bitcoin wallet pays; the two rails share one asset id. */
  sendSource?: "arkade" | "onchain";
  /** Where the receive side settles, when the rail names its own address. */
  settleTarget?: string;
  /** Which of the app's own balances that address IS, when it is one of them. */
  destination?: "card";
};

/** Which fullscreen wait the sheet is showing, if any. Pricing only: accepting
 * a quote closes the sheet, so there is no post-acceptance wait to show. */
export type MoveSwapBusy = "quoting";

/**
 * What a finished move hands back. The destination rail's bookkeeping lives
 * with the caller — only it knows which rail was chosen — and it cannot do that
 * from a bare "done": it needs what was bought and which order bought it.
 * `execution` is null for a swap that failed AFTER paying, where the durable
 * tracker owns the outcome and no result exists yet.
 */
export type MoveSwapExecuted = {
  quote: SwapQuote;
  execution: SwapExecution | null;
};

/**
 * The server refused the commit because the accepted price no longer holds —
 * its re-quote fell outside the bounds the user accepted, or the accepted
 * option is gone. Nothing was created or signed, so this is not a failure to
 * report: the answer is simply a fresh price to accept again.
 */
export function isPriceMovedRefusal(error: unknown): boolean {
  const message = errMsg(error);
  return (
    /commit re-quote: .*(below minimumSettleAmount|exceeds acceptedDepositAmount)/i.test(message) ||
    /is not among the current quote options/i.test(message) ||
    // The server commits the exact option that was accepted and no longer
    // re-prices; an accepted option past its validity comes back as expired.
    /quote[_ ]expired/i.test(message)
  );
}

export function useMoveSwap(options: {
  onExecuted: (result: MoveSwapExecuted) => void;
  /** Fires when a swap fails BEFORE any order exists (nothing moved) and the
   * sheet has already closed for snappiness — the parent re-opens so the user
   * can retry. Not called once an order is handed off: the pill owns it then. */
  onPreHandoffFailure?: () => void;
  /** Fires when the accepted price moved before the commit: nothing was
   * created, and fresh prices for the same move are being requested. The
   * sheet restores the move so the user can accept the new price. */
  onRequote?: (request: MoveSwapRequest) => void;
}) {
  const { onExecuted, onPreHandoffFailure, onRequote } = options;
  const [quotes, setQuotes] = useState<SwapQuote[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<MoveSwapBusy | null>(null);
  const [failed, setFailed] = useState(false);
  // The pair was priced and nothing runnable came back. Carried on the button,
  // never as an error line.
  const [noRoute, setNoRoute] = useState(false);
  // The actionable version of `noRoute`, when the contract named a bound the
  // user can meet. Null means the generic "no route right now".
  const [noRouteReason, setNoRouteReason] = useState<string | null>(null);
  // What the last prices were for, so a retry can ask again for the same move
  // without the sheet having to hand it over a second time.
  const lastRequestRef = useRef<MoveSwapRequest | null>(null);
  const failedQuoteIdRef = useRef<string | null>(null);

  const reset = useCallback(() => {
    setQuotes(null);
    setSelectedId(null);
    setFailed(false);
    setNoRoute(false);
  }, []);

  const requestQuotes = useCallback(async (request: MoveSwapRequest) => {
    lastRequestRef.current = request;
    // `failed` is deliberately left alone: a retry re-prices from the try-again
    // screen, and that screen must stay up until fresh prices are in.
    setNoRoute(false);
    setNoRouteReason(null);
    setBusy("quoting");
    try {
      const priced = await quoteSwap(request);
      // Ranked best-first by the contract, runnable ones ahead of the rest, so
      // the head of the list is the offer to preselect.
      const preferred =
        priced.find((quote) => quote.executable && quote.id !== failedQuoteIdRef.current) ??
        priced.find((quote) => quote.executable);
      if (!preferred) {
        setQuotes(null);
        setSelectedId(null);
        setNoRoute(true);
        return;
      }
      setQuotes(priced);
      setSelectedId(preferred.id);
    } catch (error) {
      // A pair no engine covers throws the same way a provider outage does, and
      // means the same thing to the user: there is nothing to accept.
      setQuotes(null);
      setSelectedId(null);
      setNoRoute(true);
      // Except when the contract names an amount the user can act on. "No route
      // right now" and "Minimum 10 000 sats" are different problems and only
      // one of them has a fix; collapsing both into the generic line made the
      // floor message dead code.
      const message = errMsg(error);
      setNoRouteReason(/minimum/i.test(message) ? message : null);
    } finally {
      setBusy(null);
    }
  }, []);

  const selectQuote = useCallback((id: string) => setSelectedId(id), []);

  const confirm = useCallback(async () => {
    const accepted = quotes?.find((quote) => quote.id === selectedId) ?? null;
    if (!accepted?.executable) return;
    // Bitcoin leaves this wallet before anything arrives, so the balance is
    // anchored at "what is showing minus what is going" BEFORE the payment: the
    // send emits its own refreshes while the swap runs, and arming afterwards
    // could subtract the same sats from an already-debited read.
    //
    // Only the rail that PAYS may be anchored: the anchor restates the arkade
    // balance, and the two bitcoin rails are one asset here. A move off the
    // legacy on-chain wallet leaves the arkade sats where they are — its own
    // rail is read from the chain, which shows the spend as soon as it is
    // broadcast, and the durable order carries the pending row meanwhile.
    const spendsArkade = spendsArkadeBalance(accepted);
    if (spendsArkade) {
      bitcoinBalanceStore.holdArkadeOutgoingBalance("move_swap", accepted.sendAmount);
    }

    // Accepting the price is the LAST thing the user does. The sheet closes on
    // the handoff — the moment an order exists — and the global move-status pill
    // carries it from there. Nothing after this point is worth holding a screen
    // for: every remaining step runs unattended, and the outcome reaches the
    // user through the pill, the pending rows and the balances either way.
    let handedOff = false;
    const handOff = (orderId: string) => {
      if (handedOff) return;
      handedOff = true;
      // What this move is about to do to which balances, captured against the
      // figures currently on screen. The terminal event applies both legs from
      // it, so the numbers move the instant the order completes rather than
      // when some later refetch catches up.
      noteV2MoveBaseline({
        orderId,
        from: accepted.from,
        to: accepted.to,
        sendAmount: accepted.sendAmount,
        receiveAmount: accepted.receiveAmount,
      });
      noteV2MoveCommitted({ orderId, from: accepted.from, to: accepted.to });
      failedQuoteIdRef.current = null;
      reset();
      // The order id is what the home books a card credit against (and what
      // the card's settlement confirms or reverts). The rest of the execution
      // is not known yet: the funds may still be leaving.
      onExecuted({
        quote: accepted,
        execution: {
          orderId,
          txHash: null,
          sentAmount: accepted.sendAmount,
          quotedReceive: accepted.receiveAmount,
        },
      });
    };

    try {
      const execution = await executeSwap(accepted, { onOrderId: handOff });
      // A fee-bearing rail debits more than it quotes, and the hold was armed
      // before the fee was known. Re-arm it at what actually left, or the
      // balance reads as spendable sats that are already gone. This still runs
      // after the sheet closed — the store is app-wide, not the sheet's.
      if (spendsArkade && execution.sentAmount > accepted.sendAmount) {
        bitcoinBalanceStore.holdArkadeOutgoingBalance("move_swap", execution.sentAmount);
      }
      // An engine that settled without ever announcing an order id (no v2 order
      // to track) still has to release the sheet.
      if (execution.orderId) handOff(execution.orderId);
      else if (!handedOff) {
        handedOff = true;
        failedQuoteIdRef.current = null;
        reset();
        onExecuted({ quote: accepted, execution });
      }
    } catch (error) {
      const postPayment = Boolean((error as { postPayment?: boolean })?.postPayment);
      // Same flag as isUnresolvedCommitOutcome (SwapKitV2CommitFlow).
      const unresolved = Boolean((error as { unresolved?: boolean })?.unresolved);
      console.warn(
        `[MoveSwap] swap failed engine=${accepted.engine} postPayment=${postPayment} unresolved=${unresolved}`,
      );
      // Already handed off: the order exists and the tracker owns it. Reporting
      // this on a sheet the user has left would be a second screen for a move
      // that is still in flight — the pill says what happened to it.
      if (handedOff) return;
      if (postPayment || unresolved) {
        // The funds already left (postPayment), or the server named an order
        // this device could not record yet (unresolved), which relaunch recovery
        // adopts and funds. Either way the durable row and its recovery own
        // this now: another price here could pay a second route. The Bitcoin
        // hold stays for the same reason.
        failedQuoteIdRef.current = null;
        reset();
        onExecuted({ quote: accepted, execution: null });
        return;
      }
      // Pre-handoff: no order reached this device, so nothing was signed and
      // nothing moved — including a commit whose reply was lost. The failure
      // belongs here, with a fresh price to accept instead.
      if (spendsArkade) {
        bitcoinBalanceStore.revertArkadeOutgoingBalance("move_swap_failed");
      }
      // Cancelling the passkey prompt is a decision, not a fault: nothing moved,
      // the hold is already reverted above, and the sheet should return to the
      // amount the user was editing rather than raise a failure and open a
      // support chat about their own Cancel.
      if (isUserCancelledAuth(error)) {
        failedQuoteIdRef.current = null;
        return;
      }
      // The price moved between accepting and committing: ask again and show
      // the new price. No error screen, no support report — nothing happened.
      const request = lastRequestRef.current;
      if (request && isPriceMovedRefusal(error)) {
        failedQuoteIdRef.current = null;
        onRequote?.(request);
        void requestQuotes(request);
        return;
      }
      failedQuoteIdRef.current = accepted.id;
      setFailed(true);
      // The sheet may already be closed (snappy accept); the parent re-opens it
      // so this failure is not swallowed. In-sheet `failed` still renders if it
      // is still mounted — both paths are safe because nothing moved.
      onPreHandoffFailure?.();
      void reportErrorToSupport({ error, userMessage: "Move swap failed" }).catch(() => {});
    }
  }, [quotes, selectedId, reset, onExecuted, onPreHandoffFailure, onRequote, requestQuotes]);

  // Recovery is a solution, not a message: ask for prices again and put the
  // user back on a list with an alternative to the one that just failed
  // preselected. Staying on this screen until they are in — flipping back to
  // the wait screen mid-recovery reads as a second failure.
  const retry = useCallback(() => {
    const request = lastRequestRef.current;
    if (!request) {
      reset();
      return;
    }
    void requestQuotes(request).finally(() => setFailed(false));
  }, [requestQuotes, reset]);

  return {
    quotes,
    selectedQuote: quotes?.find((quote) => quote.id === selectedId) ?? null,
    selectedId,
    busy,
    failed,
    noRoute,
    noRouteReason,
    requestQuotes,
    selectQuote,
    confirm,
    retry,
    reset,
  };
}
