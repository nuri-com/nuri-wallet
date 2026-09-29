// screens/wirex/hooks/useWirexSendFlow.ts
// Spending the Wirex balance: the choice sheet's two branches — withdraw the
// WEUR back to the owner EOA, or send it out over SEPA. Extracted from
// its screen so the unified home's IBAN and VISA rows can offer the same flow;
// the withdrawal's optimistic debit and its rollback must exist exactly once,
// and this is where they live.
//
// SECURITY / money: the debit is applied when the REQUEST approval is accepted
// (both approvals are signed silently, the whole flow takes ~20s). A failure
// before the execution approval's point of no return takes both sides back; an
// unconfirmed outcome after it keeps them. `debitHandle` identifies this call's
// debit so a
// failure reverts THIS one even if another transfer started meanwhile, and the
// wallet's side of the move travels as an optimistic-credit event because it
// lives on another screen.
import { useCallback, useState } from "react";
import { LOG_EMOJI, errorWithId, logWithId } from "../../../lib/OperationLogUtils";
import { shouldRevertOptimisticWithdraw } from "../../../lib/wirex/withdrawRollback";
import { EventBus } from "../../../services/events/AppEventBusService";
import { wirexAccountService } from "../../../services/wirex/WirexAccountService";
import { wirexService, type WirexWithdrawAsset } from "../../../services/wirex/WirexService";
import { USDC_BASE_TOKEN } from "../../../services/swapkit/SwapKitStableAssets";
import { finishInFlight, startCardWithdrawInFlight } from "../../../services/money/announce";
import type { SepaRecipientData } from "../modals/SepaRecipientModal";
import type { WirexSendChoiceKey } from "../modals/WirexSendChoiceModal";

const SOURCE = "screens/wirex/hooks/useWirexSendFlow.ts";

export type WirexSepaPrefill = {
  iban: string;
  bic: string;
  firstName: string;
  lastName: string;
};

type Params = {
  /** SEPA is withheld until the bank details exist. */
  bankReady: boolean;
};

export function useWirexSendFlow({ bankReady }: Params) {
  const [choiceVisible, setChoiceVisible] = useState(false);
  const [recipientVisible, setRecipientVisible] = useState(false);
  const [amountVisible, setAmountVisible] = useState(false);
  const [recipient, setRecipient] = useState<SepaRecipientData | null>(null);
  const [prefill, setPrefill] = useState<WirexSepaPrefill | null>(null);

  const start = useCallback(() => setChoiceVisible(true), []);

  const handleSelect = useCallback(
    (key: WirexSendChoiceKey) => {
      if (key === "sepa" && !bankReady) return;
      if (key === "sepa") {
        setChoiceVisible(false);
        setRecipientVisible(true);
      }
    },
    [bankReady],
  );

  const handleRecipientContinue = useCallback((data: SepaRecipientData) => {
    setRecipient(data);
    setPrefill(null);
    setRecipientVisible(false);
    setAmountVisible(true);
  }, []);

  /** Send to a known counterparty again — skips straight to the recipient step. */
  const startSepaTo = useCallback((counterparty: WirexSepaPrefill) => {
    setPrefill(counterparty);
    setRecipientVisible(true);
  }, []);

  const closeRecipient = useCallback(() => {
    setRecipientVisible(false);
    setPrefill(null);
  }, []);

  // `asset` names which pocket empties: EURC (the default, and every caller
  // that predates the dollar side) or USDC. Both ends of the move are stated in
  // that currency — the card's pocket, and the wallet rail that receives it.
  const handleWithdraw = useCallback(
    async (amount: string, asset: WirexWithdrawAsset = "EURC"): Promise<{ inFlightId: string }> => {
      // The handle arrives asynchronously for a non-euro pocket (the conversion
      // needs a rate), and the rollback below must not run before it exists — a
      // debit nobody holds the handle for can never be taken back. So the PROMISE
      // is what is kept, and every path that needs the handle awaits it.
      let debitPending: Promise<number | null> | null = null;
      const usd = asset === "USDC";
      // Names the wallet-side credit so it can be taken back by name. The credit
      // crosses a bus into a balance this hook does not own, so there is no handle
      // to keep — only an id both sides agree on.
      const creditMoveId = `wirex-withdraw:${asset}:${amount}:${Date.now()}`;
      try {
        const result = await wirexService.withdrawToWallet(amount, {
          asset,
          // The balances move at the FIRST approval, a few seconds in, not after
          // the second one ~15s later: both are signed silently, so waiting on
          // the second only leaves the user watching unmoved figures. Until the
          // execution approval's point of no return a failure is an ordinary
          // error and the catch below takes both sides back.
          onRequestApproved: () => {
            const value = Number(amount);
            // The card's headline is one euro total, so dollars leaving it are
            // converted on the way out while the dollar row itself steps by the
            // dollars.
            debitPending = usd
              ? wirexAccountService.applyOptimisticDebitIn(value, "USD")
              : Promise.resolve(wirexAccountService.applyOptimisticDebit(value));
            // Both screens show it in flight until the withdrawal is resolved.
            void startCardWithdrawInFlight({
              id: creditMoveId,
              amount: value,
              fiat: usd ? "USD" : "EUR",
            }).catch(() => {});
            // The wallet is the other side of this move and lives on another
            // screen with its own balance, so the credit travels as an event.
            // Without it the money is visibly gone from the card and missing
            // from the wallet for the whole settlement. The token names WHICH
            // wallet rail: a dollar credit posted without one lands on the euro.
            try {
              EventBus.emit("wallet:optimisticCredit", {
                amount: value,
                moveId: creditMoveId,
                ...(usd ? { asset: USDC_BASE_TOKEN.asset } : {}),
              });
            } catch {}
          },
          onSubmitted: () => {
            setChoiceVisible(false);
          },
        });
        // Reconciling a previously pending withdrawal returns the prior result
        // without ever reaching onSubmitted — that withdrawal has succeeded, so
        // the sheet has to close here too. Leaving it open re-enabled the CTA
        // and invited the user to send the same amount a second time.
        setChoiceVisible(false);
        // The optimism above was assigned from what was ASKED for; this is what
        // the server says actually moved. They should never differ — the request
        // refuses to proceed unless the start echoes the asset back — but if they
        // do, the screen is stating the wrong pocket and the wrong rail. Take the
        // debit back and let live reads say what is true; re-applying optimism for
        // a currency the user did not choose would only guess again.
        if (result.asset !== asset) {
          errorWithId(
            `${LOG_EMOJI.card} WirexSendFlow.withdraw`,
            "withdrawal settled in a different asset than requested",
            { requested: asset, settled: result.asset },
            {
              context: "user",
              event: "API_ERR",
              scope: "WirexSendFlow",
              action: "withdrawToWallet",
              source: `${SOURCE}#handleWithdraw`,
            },
          );
          wirexAccountService.revertOptimisticBalance(await debitPending);
          void wirexAccountService.silentRefresh(true);
          try {
            // A refresh cannot undo the wallet's side: the receiving rail's live
            // balance is unchanged and its anchor outranks a read for up to three
            // minutes, so the credit has to be revoked by name — otherwise the
            // rail that was never paid keeps showing the money while the one that
            // actually was shows it too.
            EventBus.emit("wallet:revokeOptimisticCredit", { moveId: creditMoveId });
            EventBus.emit("wallet:refresh");
          } catch {}
        }
        logWithId(
          `${LOG_EMOJI.card} WirexSendFlow.withdraw`,
          "withdraw to wallet completed",
          { status: "success" },
          {
            context: "user",
            event: "FLOW",
            scope: "WirexSendFlow",
            action: "withdrawToWallet",
            source: `${SOURCE}#handleWithdraw`,
          },
        );
        return { inFlightId: creditMoveId };
      } catch (error) {
        errorWithId(
          `${LOG_EMOJI.card} WirexSendFlow.withdraw`,
          "withdraw to wallet failed",
          {
            status: "failed",
            reason: error instanceof Error ? error.message : String(error),
          },
          {
            context: "user",
            event: "API_ERR",
            scope: "WirexSendFlow",
            action: "withdrawToWallet",
            source: `${SOURCE}#handleWithdraw`,
          },
        );
        if (shouldRevertOptimisticWithdraw(error)) {
          // Nothing moved: the row goes with the rolled-back balances.
          void finishInFlight(creditMoveId).catch(() => {});
          wirexAccountService.revertOptimisticBalance(await debitPending);
          // The balances move at the request approval, so a failure before the
          // execution approval went nowhere with the wallet already credited.
          // Take that side back too, or the money shows on both. A credit that
          // was never posted has no handle under this id, so this is a no-op.
          try {
            EventBus.emit("wallet:revokeOptimisticCredit", { moveId: creditMoveId });
          } catch {}
        }
        throw error;
      }
    },
    [],
  );

  return {
    choiceVisible,
    setChoiceVisible,
    recipientVisible,
    closeRecipient,
    amountVisible,
    setAmountVisible,
    recipient,
    prefill,
    start,
    startSepaTo,
    handleSelect,
    handleRecipientContinue,
    handleWithdraw,
  };
}
