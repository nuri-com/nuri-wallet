// @screen wirex.uk-payout-amount
// How many pounds go to a saved UK bank account. Send asks the server for a
// quote, refuses one that does not fit the balance, then signs that exact
// quote. The card holds euros or dollars, so Wirex converts: the quote states
// what leaves the balance.
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  Header,
  IconButton,
  Scroll,
  Text,
  Topbar,
  TopbarTitle,
  TopbarTrailing,
  View,
} from "@ds";
import { clampCentsInput } from "../../../lib/amounts";
import AmountDisplay, { GBP_FLAG } from "../../../components/AmountDisplay";
import AmountKeypad from "../../../components/AmountKeypad";
import DsSheetHost from "../../../components/DsSheetHost";
import AppFooter from "../../../components/AppFooter";
import { t } from "../../../lib/i18n";
import { useKeypadFit } from "../../../lib/useKeypadFit";
import {
  isPayoutCurrencyToken,
  payoutDebitCandidates,
  type PayoutCurrency,
  type PayoutDebitToken,
} from "../../../lib/wirex/cardPayout";
import { formatSortCodeInput } from "../../../lib/wirex/ukPayments";
import { startSepaInFlight } from "../../../services/money/announce";
import { startMovePill } from "../../../services/wallet/CardTransferPill";
import { UK_TRANSFER_UNCONFIRMED_CODE } from "../../../lib/wirex/ukPendingTransfer";
import {
  WirexApiError,
  WirexUkTransferUnconfirmedError,
  wirexService,
  type WirexUkPayee,
  type WirexUkTransferQuote,
} from "../../../services/wirex/WirexService";

type Props = {
  visible: boolean;
  onClose: () => void;
  wallet: string;
  payee: WirexUkPayee | null;
  /** The card's own currency: its balance pays first. */
  currency: PayoutCurrency;
  onSuccess: () => void;
};

const UkPayoutAmountModal: React.FC<Props> = ({
  visible,
  onClose,
  wallet,
  payee,
  currency,
  onSuccess,
}) => {
  const [amount, setAmount] = useState("");
  const [tokens, setTokens] = useState<PayoutDebitToken[] | null>(null);
  // Bumped on every open and close: an answer that arrives for an earlier
  // opening never signs, and never closes or speaks for the sheet now open.
  const opening = useRef(0);
  const [submitting, setSubmitting] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // An earlier UK payment may have gone and is not settled yet: nothing new is
  // quoted or signed until it is. null while that is being checked.
  const [held, setHeld] = useState<boolean | null>(null);
  const keypadFit = useKeypadFit();

  useEffect(() => {
    opening.current += 1;
    if (!visible) return;
    setAmount("");
    setSendError(null);
    setSubmitting(false);
    setTokens(null);
    setHeld(null);
    let cancelled = false;
    wirexService
      .ukSendHeld()
      .then((value) => {
        if (!cancelled) setHeld(value);
      })
      .catch(() => {
        if (!cancelled) setHeld(true);
      });
    wirexService
      .getWallet(wallet)
      .then((result) => {
        if (!cancelled) setTokens(payoutDebitCandidates(result.balances, currency));
      })
      .catch(() => {
        if (!cancelled) setTokens([]);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, wallet, currency]);

  const typed = amount || "0";
  const value = Number(typed);
  // No balance is held in pounds, so every token is judged by its quote (the
  // fee-inclusive debit in that token), never against the pound figure.
  const disabled = submitting || held !== false || !payee || !tokens?.length || !(value > 0);

  const edit = (next: string) => {
    if (submitting) return;
    setSendError(null);
    setAmount(clampCentsInput(next));
  };

  const send = useCallback(async () => {
    if (disabled || !payee || !tokens) return;
    const mine = opening.current;
    const current = () => opening.current === mine;
    setSubmitting(true);
    try {
      // The first token whose quote fits pays: the debit includes the fee and
      // is stated in that token, so it is compared with that token's balance.
      let quote: WirexUkTransferQuote | null = null;
      let paidWith: PayoutDebitToken | null = null;
      for (const token of tokens) {
        const estimate = await wirexService.ukTransferEstimate({
          payeeId: payee.payeeId,
          amount: typed,
          tokenAddress: token.tokenAddress,
        });
        if (!current()) return;
        // A quote that does not say what leaves the balance is never signed.
        if (estimate.debitAmount != null && estimate.debitAmount <= token.balance) {
          quote = estimate;
          paidWith = token;
          break;
        }
      }
      if (!quote || !paidWith) {
        setSendError(t("screen.UkPayment.feeHint"));
        return;
      }
      // Closed or reopened while quoting: nothing is signed for it.
      if (!current()) return;
      // Off while it is sent: only an unconfirmed send keeps it off after.
      setHeld(true);
      const transfer = await wirexService.ukTransfer(quote);
      // Followed like a bank send: the bank feed lists the transfer by id,
      // and the balance it left is the debit token's.
      if (quote.debitAmount != null) {
        void startSepaInFlight({
          transferId: transfer.transferId,
          amount: quote.debitAmount,
          fiat: isPayoutCurrencyToken(paidWith, "USD") ? "USD" : "EUR",
        }).catch(() => {});
      }
      startMovePill().settleByRows(transfer.transferId);
      if (current()) onSuccess();
    } catch (error) {
      // Keep the sheet open and say so. Never log account or amount details.
      console.warn("[UkPayoutAmountModal] send failed");
      if (!current()) return;
      // ukTransfer throws anything but WirexUkTransferUnconfirmedError only when
      // nothing went; a quote refused for an earlier unconfirmed payment holds too.
      const code = error instanceof WirexApiError ? error.code : "";
      if (
        error instanceof WirexUkTransferUnconfirmedError ||
        code.startsWith(UK_TRANSFER_UNCONFIRMED_CODE)
      ) {
        setHeld(true);
        setSendError(t("screen.UkPayment.unconfirmedHint"));
      } else {
        setHeld(false);
        setSendError(t("screen.UkPayment.sendFailedHint"));
      }
    } finally {
      if (current()) setSubmitting(false);
    }
  }, [disabled, payee, tokens, typed, onSuccess]);

  const hint =
    held === true && !sendError
      ? t("screen.UkPayment.unconfirmedHint")
      : tokens != null && tokens.length === 0
        ? t("screen.SepaAmountConfirmationModal.noTokenHint")
        : sendError;
  const payeeRow = payee
    ? t("screen.UkPayment.payeeRow", {
        sortCode: formatSortCodeInput(payee.sortCode),
        last4: payee.accountNumber.slice(-4),
      })
    : "";
  const name = payee?.name || payeeRow;

  return (
    <DsSheetHost visible={visible} onClose={onClose} mode="full">
      <Header safeAreaTop chrome="canvas">
        <Topbar surface="transparent" layout="fluid">
          <TopbarTitle>{t("screen.UkPayment.amountTitle")}</TopbarTitle>
          <TopbarTrailing>
            <IconButton
              icon="cross"
              variant="soft"
              accessibilityLabel={t("common.close")}
              onPress={onClose}
            />
          </TopbarTrailing>
        </Topbar>
      </Header>

      <Scroll onLayout={keypadFit.onViewportLayout}>
        <View
          onLayout={keypadFit.onContentLayout}
          direction="column"
          align="stretch"
          justify="between"
          gap="sm"
          paddingX="lg"
          paddingBottom={keypadFit.compact ? "sm" : "lg"}
          fill="grow"
        >
          <View variant="soft" radius="md" padding="lg" direction="column" align="stretch" gap="xs">
            <Text size="md" emphasis>
              {name}
            </Text>
            <Text size="md" muted>
              {payeeRow}
            </Text>
          </View>

          <AmountDisplay
            primaryAmount={amount || "0"}
            primaryImage={GBP_FLAG}
            primaryUnit="GBP"
            message={hint ? { text: hint, tone: sendError ? "alert" : "info" } : null}
          />

          <View direction="column" align="stretch" justify="end" gap="lg">
            <AmountKeypad
              compact={keypadFit.compact}
              onDigit={(d) => edit(amount + d)}
              onDecimal={() => edit(`${amount || "0"}.`)}
              onDelete={() => edit(amount.slice(0, -1))}
            />
          </View>
        </View>
      </Scroll>

      <AppFooter canvas>
        <Button
          size="lg"
          variant="solid"
          accent="lilac"
          onPress={send}
          disabled={disabled}
          accessibilityLabel={t("screen.SepaAmountConfirmationModal.sendA11yLabel")}
        >
          {value > 0
            ? t("screen.UkPayment.sendCtaLabel", { amount: typed, name })
            : t("screen.UkPayment.sendCtaLabelNoAmount", { name })}
        </Button>
      </AppFooter>
    </DsSheetHost>
  );
};

export default UkPayoutAmountModal;
