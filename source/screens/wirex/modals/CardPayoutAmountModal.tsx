// @screen wirex.card-payout-amount
// How much goes to a saved card. Send asks the server for a quote, refuses one
// that does not fit the balance, then signs that exact quote.
import React, { useCallback, useEffect, useMemo, useState } from "react";
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
  pickPayoutDebitToken,
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
  const [token, setToken] = useState<PayoutDebitToken | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const keypadFit = useKeypadFit();

  useEffect(() => {
    if (!visible) return;
    setAmount("");
    setSendError(null);
    setToken(null);
    let cancelled = false;
    wirexService
      .getWallet(wallet)
      .then((result) => {
        if (!cancelled) setToken(pickPayoutDebitToken(result.balances, currency));
      })
      .catch(() => {
        if (!cancelled) setToken(null);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, wallet, currency]);

  const typed = amount || "0";
  const value = Number(typed);
  const exceeds = token != null && value > token.balance;
  const disabled = submitting || !card || !token || !(value > 0) || exceeds;

  const edit = (next: string) => {
    if (submitting) return;
    setSendError(null);
    setAmount(clampAmount(next));
  };

  const send = useCallback(async () => {
    if (disabled || !card || !token) return;
    setSubmitting(true);
    try {
      const quote = await wirexService.cardTransferEstimate({
        recipientId: card.recipientId,
        amount: typed,
        currency,
        tokenAddress: token.tokenAddress,
      });
      // The debit includes the fee: refuse before signing when it does not fit.
      if (quote.debitAmount != null && quote.debitAmount > token.balance) {
        setSendError(t("screen.CardPayout.feeHint"));
        return;
      }
      const transfer = await wirexService.cardTransfer(quote);
      if (!transfer.ok) throw new Error("wirex_card_transfer_rejected");
      // Followed like a bank send: the bank feed lists the card transfer by id.
      if (transfer.transferId) {
        void startSepaInFlight({
          transferId: transfer.transferId,
          amount: value,
          fiat: currency,
        }).catch(() => {});
      }
      startMovePill().settleByRows(transfer.transferId);
      onSuccess();
    } catch {
      // Keep the sheet open and say so. Never log card or amount details.
      console.warn("[CardPayoutAmountModal] send failed");
      setSendError(t("screen.CardPayout.sendFailedHint"));
    } finally {
      setSubmitting(false);
    }
  }, [disabled, card, token, typed, currency, value, onSuccess]);

  const hint = !token
    ? t("screen.SepaAmountConfirmationModal.noTokenHint")
    : exceeds
      ? t("screen.SepaAmountConfirmationModal.insufficientHint")
      : sendError;
  const title = token
    ? t("screen.CardPayout.amountTitleWithBalance", { amount: token.balance.toFixed(2) })
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
