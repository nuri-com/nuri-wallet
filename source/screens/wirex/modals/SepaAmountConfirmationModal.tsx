// @screen wirex.sepa-confirm
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { startSepaInFlight } from "../../../services/money/announce";
import { startMovePill } from "../../../services/wallet/CardTransferPill";

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

import AmountDisplay, { EUR_FLAG } from "../../../components/AmountDisplay";
import AmountKeypad from "../../../components/AmountKeypad";
import { useKeypadFit } from "../../../lib/useKeypadFit";
import DsSheetHost from "../../../components/DsSheetHost";
import { formatIbanForDisplay } from "../../../lib/ibanFormat";
import { t } from "../../../lib/i18n";

import { wirexService } from "../../../services/wirex/WirexService";
import { pickSepaDebitToken, sepaEstimateDebit } from "../../../lib/wirex/sepa";

type DebitToken = { tokenAddress: string; tokenSymbol: string; balance: number };

type Props = {
  visible: boolean;
  onClose: () => void;
  wallet: string;
  accountId: string;
  iban: string;
  bic: string;
  firstName: string;
  lastName: string;
  reference?: string;
  onSuccess: () => void;
};

const CURRENCY_CODE = "EUR";

// The fee is debit - amount. A euro token debits 1:1, so the largest amount
// that fits is the balance minus that fee; other tokens convert at a rate, so
// only the plain hint applies there.
function feeShortfallHint(balance: number, debit: number, amount: number, symbol: string): string {
  const max = Math.floor((balance - (debit - amount)) * 100) / 100;
  if (!/EUR/i.test(symbol) || !(max > 0)) return t("screen.SepaAmountConfirmationModal.feeHint");
  return t("screen.SepaAmountConfirmationModal.feeHintWithMax", { amount: max.toFixed(2) });
}
const SepaAmountConfirmationModal: React.FC<Props> = ({
  visible,
  onClose,
  wallet,
  accountId,
  iban,
  bic,
  firstName,
  lastName,
  reference,
  onSuccess,
}) => {
  const [amount, setAmount] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  // A short screen compacts the keypad before it scrolls.
  const keypadFit = useKeypadFit();
  const [debitToken, setDebitToken] = useState<DebitToken | null>(null);
  // Why the last Send did not go out. Shown under the amount; the sheet stays
  // open so the user can correct the amount instead of guessing (#1536).
  const [sendError, setSendError] = useState<string | null>(null);
  const amountEditable = !submitting;

  const recipientLabel = useMemo(() => {
    return [firstName, lastName]
      .map((s) => (s || "").trim())
      .filter(Boolean)
      .join(" ");
  }, [firstName, lastName]);

  // Reset amount when the sheet opens/closes
  useEffect(() => {
    if (!visible) {
      setDebitToken(null);
      return;
    }
    setAmount("");
    setSendError(null);
  }, [visible]);

  // Load the wallet and pick a debit token when the sheet opens
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await wirexService.getWallet(wallet);
        const token = pickSepaDebitToken(result.balances);
        if (!cancelled) setDebitToken(token);
      } catch (err) {
        if (!cancelled) {
          setDebitToken(null);
          console.warn("[SepaAmountConfirmationModal] failed to load wallet balances", err);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, wallet]);

  const clampAmountString = useCallback((raw: string): string => {
    if (!raw) return "";
    const s = String(raw).replace(/,/g, ".");
    const trailingDot = s.endsWith(".") && !s.includes("..");
    const match = s.match(/^(\d+)(?:\.(\d*))?/);
    if (!match) return "";
    const intPart = match[1] || "0";
    let decRaw = match[2] || "";
    decRaw = decRaw.replace(/[^0-9]/g, "");
    decRaw = decRaw.slice(0, 2);
    if (trailingDot && decRaw.length === 0) {
      return `${intPart}.`;
    }
    return decRaw.length > 0 ? `${intPart}.${decRaw}` : intPart;
  }, []);

  const handleChangeText = (text: string) => {
    setSendError(null);
    setAmount(clampAmountString(text));
  };

  // DS keypad handlers — same entry semantics the other send flows use.
  const handleDigit = (digit: string) => {
    if (!amountEditable) return;
    handleChangeText(amount + digit);
  };
  const handleDecimal = () => {
    if (!amountEditable) return;
    handleChangeText(`${amount || "0"}.`);
  };
  const handleDelete = () => {
    if (!amountEditable) return;
    handleChangeText(amount.slice(0, -1));
  };

  const displayAmount = useMemo(() => clampAmountString(amount), [amount, clampAmountString]);
  const labelAmount = displayAmount && displayAmount.length > 0 ? displayAmount : "0";
  const amountNumber = useMemo(() => Number(labelAmount || "0"), [labelAmount]);
  const maxAvailable = useMemo(() => {
    if (!debitToken) return null;
    if (!Number.isFinite(debitToken.balance)) return null;
    return Math.max(0, Number(debitToken.balance));
  }, [debitToken]);
  const hasKnownBalance = maxAvailable != null;
  const exceedsBalance = useMemo(() => {
    if (maxAvailable == null) return false;
    return Number.isFinite(amountNumber) && amountNumber > maxAvailable;
  }, [amountNumber, maxAvailable]);
  const isSendDisabled =
    submitting ||
    !debitToken ||
    !Number.isFinite(amountNumber) ||
    amountNumber <= 0 ||
    !hasKnownBalance ||
    exceedsBalance;

  const handleSend = useCallback(async () => {
    if (submitting) return;
    if (!debitToken) return;
    const amt = Number(labelAmount || "0");
    if (maxAvailable == null) return;
    if (!Number.isFinite(amt) || amt <= 0) return;
    if (amt > maxAvailable) return;

    setSubmitting(true);
    try {
      const cleanIban = iban.replace(/\s+/g, "").toUpperCase();
      const cleanBic = bic.trim().toUpperCase();
      const recipientName = [firstName, lastName]
        .map((s) => (s || "").trim())
        .filter(Boolean)
        .join(" ");
      const cleanReference = (reference ?? "").trim();
      const est = await wirexService.sepaEstimate({
        wallet,
        accountId,
        amount: labelAmount,
        iban: cleanIban,
        bic: cleanBic,
        recipientName,
        tokenAddress: debitToken.tokenAddress,
        reference: cleanReference || undefined,
      });
      if (!est.estimationId) throw new Error("wirex_sepa_estimation_id_missing");
      // Wirex debits amount + fee from the token. Refuse before signing when
      // that does not fit, instead of letting Wirex fail `insufficient_funds`.
      const debit = sepaEstimateDebit(est.raw, debitToken.tokenAddress);
      if (debit != null && debit > maxAvailable) {
        setSendError(feeShortfallHint(maxAvailable, debit, amt, debitToken.tokenSymbol));
        return;
      }
      const transfer = await wirexService.sepaTransfer({
        wallet,
        accountId,
        tokenAddress: debitToken.tokenAddress,
        iban: cleanIban,
        bic: cleanBic,
        recipientName,
        amount: labelAmount,
        reference: cleanReference || undefined,
        estimationId: est.estimationId,
      });
      // A 200 envelope can still carry { ok: false } (provider rejected). Only
      // show completion on a real success, else keep the modal open like a throw.
      if (!transfer.ok) throw new Error("wirex_sepa_transfer_rejected");
      if (transfer.transferId) {
        void startSepaInFlight({
          transferId: transfer.transferId,
          amount: Number(labelAmount),
          fiat: /usd/i.test(debitToken.tokenSymbol) ? "USD" : "EUR",
        }).catch(() => {});
      }
      // The same status pill as every other move: Processing while the bank
      // transfer is pending, then Completed or failed as the bank feed says.
      // Without a transfer id there is nothing to follow, and no pill claims
      // an outcome it cannot know.
      if (transfer.transferId) startMovePill().settleByRows(transfer.transferId);
      onSuccess();
    } catch {
      // Keep the sheet open and say why. Closing it silently made a rejected
      // transfer look like nothing happened (#1536). Do NOT log any PII.
      console.warn("[SepaAmountConfirmationModal] send failed");
      setSendError(t("screen.SepaAmountConfirmationModal.sendFailedHint"));
    } finally {
      setSubmitting(false);
    }
  }, [
    submitting,
    debitToken,
    labelAmount,
    maxAvailable,
    iban,
    bic,
    wallet,
    accountId,
    firstName,
    lastName,
    reference,
    onSuccess,
  ]);

  // Only actionable failures stay near the amount. The available balance is in
  // the header, matching the other send screens.
  const amountHint = !debitToken
    ? t("screen.SepaAmountConfirmationModal.noTokenHint")
    : exceedsBalance
      ? t("screen.SepaAmountConfirmationModal.insufficientHint")
      : sendError;
  const headerTitle =
    maxAvailable == null
      ? t("screen.SepaAmountConfirmationModal.headerTitle")
      : t("screen.SepaAmountConfirmationModal.headerTitleWithBalance", {
          amount: maxAvailable.toFixed(2),
        });

  return (
    <DsSheetHost visible={visible} onClose={onClose} mode="full">
      <Header safeAreaTop chrome="canvas">
        <Topbar surface="transparent" layout="fluid">
          <TopbarTitle>{headerTitle}</TopbarTitle>
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
          <View direction="column" align="stretch" justify="start" gap="xl">
            <View
              variant="soft"
              radius="md"
              padding="lg"
              direction="column"
              align="stretch"
              gap="xs"
            >
              <Text size="md" emphasis>
                {recipientLabel}
              </Text>
              <Text size="md" muted>
                {formatIbanForDisplay(iban)}
              </Text>
            </View>
          </View>

          <AmountDisplay
            primaryAmount={displayAmount || "0"}
            primaryImage={EUR_FLAG}
            primaryUnit={CURRENCY_CODE}
            message={amountHint ? { text: amountHint, tone: sendError ? "alert" : "info" } : null}
          />

          <View direction="column" align="stretch" justify="end" gap="lg">
            <AmountKeypad
              compact={keypadFit.compact}
              onDigit={handleDigit}
              onDecimal={handleDecimal}
              onDelete={handleDelete}
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
          onPress={handleSend}
          disabled={isSendDisabled}
          accessibilityLabel={t("screen.SepaAmountConfirmationModal.sendA11yLabel")}
        >
          {amountNumber > 0
            ? t("screen.SepaAmountConfirmationModal.sendCtaLabel", {
                amount: labelAmount,
                currency: CURRENCY_CODE,
                name: firstName,
              })
            : // No "Send 0 EUR" — the amount joins the label once one is typed.
              t("screen.SepaAmountConfirmationModal.sendCtaLabelNoAmount", {
                currency: CURRENCY_CODE,
                name: firstName,
              })}
        </Button>
      </Footer>
    </DsSheetHost>
  );
};

export default SepaAmountConfirmationModal;
