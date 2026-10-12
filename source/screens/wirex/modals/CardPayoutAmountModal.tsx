// @screen wirex.card-payout-amount
// How much goes to a saved card. Send asks the server for a quote, refuses one
// that does not fit the balance, then signs that exact quote.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Footer,
  Header,
  IconButton,
  Scroll,
  Text,
  Topbar,
  TopbarTitle,
  TopbarTrailing,
  View,
} from "@ds";
import AmountDisplay, { EUR_FLAG, USD_FLAG } from "../../../components/AmountDisplay";
import AmountKeypad from "../../../components/AmountKeypad";
import DsSheetHost from "../../../components/DsSheetHost";
import { t } from "../../../lib/i18n";
import { useKeypadFit } from "../../../lib/useKeypadFit";
import {
  isPayoutCurrencyToken,
  payoutDebitCandidates,
  type PayoutCurrency,
  type PayoutDebitToken,
} from "../../../lib/wirex/cardPayout";
import { startSepaInFlight } from "../../../services/money/announce";
import { startMovePill } from "../../../services/wallet/CardTransferPill";
import { wirexService, type WirexPayoutCard } from "../../../services/wirex/WirexService";

type Props = {
  visible: boolean;
  onClose: () => void;
  wallet: string;
  card: WirexPayoutCard | null;
  currency: PayoutCurrency;
  onSuccess: () => void;
};

// Digits with at most two decimals, the way the other send sheets take them.
function clampAmount(raw: string): string {
  const s = raw.replace(/,/g, ".");
  const match = s.match(/^(\d+)(?:\.(\d*))?/);
  if (!match) return "";
  const decimals = (match[2] ?? "").replace(/\D/g, "").slice(0, 2);
  if (s.includes(".") && !decimals) return `${match[1]}.`;
  return decimals ? `${match[1]}.${decimals}` : match[1];
}

const CardPayoutAmountModal: React.FC<Props> = ({
  visible,
  onClose,
  wallet,
  card,
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
  const keypadFit = useKeypadFit();

  useEffect(() => {
    opening.current += 1;
    if (!visible) return;
    setAmount("");
    setSendError(null);
    setSubmitting(false);
    setTokens(null);
    let cancelled = false;
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
  // The card's own currency is the one the title states. A same-currency token
  // too small for the amount is out; a token in another currency is judged by
  // its quote (the fee-inclusive debit in that token), never against this figure.
  const own = tokens?.find((x) => isPayoutCurrencyToken(x, currency)) ?? null;
  const payable = (tokens ?? []).filter(
    (x) => !isPayoutCurrencyToken(x, currency) || value <= x.balance,
  );
  const exceeds = tokens != null && tokens.length > 0 && payable.length === 0;
  const disabled = submitting || !card || !tokens?.length || !(value > 0) || exceeds;

  const edit = (next: string) => {
    if (submitting) return;
    setSendError(null);
    setAmount(clampAmount(next));
  };

  const send = useCallback(async () => {
    if (disabled || !card) return;
    const mine = opening.current;
    const current = () => opening.current === mine;
    setSubmitting(true);
    try {
      // The first token whose quote fits pays: the debit includes the fee and
      // is stated in that token, so it is compared with that token's balance.
      let quote: Awaited<ReturnType<typeof wirexService.cardTransferEstimate>> | null = null;
      for (const token of payable) {
        const estimate = await wirexService.cardTransferEstimate({
          recipientId: card.recipientId,
          amount: typed,
          currency,
          tokenAddress: token.tokenAddress,
        });
        if (!current()) return;
        if (estimate.debitAmount == null || estimate.debitAmount <= token.balance) {
          quote = estimate;
          break;
        }
      }
      if (!quote) {
        setSendError(t("screen.CardPayout.feeHint"));
        return;
      }
      // Closed or reopened while quoting: nothing is signed for it.
      if (!current()) return;
      const transfer = await wirexService.cardTransfer(quote);
      if (!transfer.ok) throw new Error("wirex_card_transfer_rejected");
      // Followed like a bank send: the bank feed lists the card transfer by
      // id. Kept even when the sheet moved on, so the money is still tracked.
      if (transfer.transferId) {
        void startSepaInFlight({
          transferId: transfer.transferId,
          amount: value,
          fiat: currency,
        }).catch(() => {});
        startMovePill().settleByRows(transfer.transferId);
      }
      // Accepted without an id: nothing to follow, so no pill ever says
      // "Completed" for it.
      if (current()) onSuccess();
    } catch {
      // Keep the sheet open and say so. Never log card or amount details.
      console.warn("[CardPayoutAmountModal] send failed");
      if (current()) setSendError(t("screen.CardPayout.sendFailedHint"));
    } finally {
      if (current()) setSubmitting(false);
    }
  }, [disabled, card, payable, typed, currency, value, onSuccess]);

  const hint =
    tokens != null && tokens.length === 0
      ? t("screen.SepaAmountConfirmationModal.noTokenHint")
      : exceeds
        ? t("screen.SepaAmountConfirmationModal.insufficientHint")
        : sendError;
  const title = own
    ? t("screen.CardPayout.amountTitleWithBalance", { amount: own.balance.toFixed(2) })
    : t("screen.CardPayout.amountTitle");
  const cardLabel = useMemo(
    () => (card ? t("screen.CardPayout.cardRow", { last4: card.last4 }) : ""),
    [card],
  );

  return (
    <DsSheetHost visible={visible} onClose={onClose} mode="full">
      <Header safeAreaTop chrome="canvas">
        <Topbar surface="transparent" layout="fluid">
          <TopbarTitle>{title}</TopbarTitle>
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
              {card?.name || cardLabel}
            </Text>
            <Text size="md" muted>
              {cardLabel}
            </Text>
          </View>

          <AmountDisplay
            primaryAmount={amount || "0"}
            primaryImage={currency === "USD" ? USD_FLAG : EUR_FLAG}
            primaryUnit={currency}
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

      <Footer
        safeAreaBottom
        chrome="canvas"
        direction="column"
        align="stretch"
        paddingBottom="sm"
        paddingX="lg"
        gap="sm"
      >
        <Button
          size="lg"
          variant="solid"
          accent="lilac"
          onPress={send}
          disabled={disabled}
          accessibilityLabel={t("screen.SepaAmountConfirmationModal.sendA11yLabel")}
        >
          {value > 0
            ? t("screen.CardPayout.sendCtaLabel", {
                amount: typed,
                currency,
                last4: card?.last4 ?? "",
              })
            : t("screen.CardPayout.sendCtaLabelNoAmount", { last4: card?.last4 ?? "" })}
        </Button>
      </Footer>
    </DsSheetHost>
  );
};

export default CardPayoutAmountModal;
