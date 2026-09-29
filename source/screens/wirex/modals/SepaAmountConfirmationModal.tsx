// @screen wirex.sepa-confirm
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { startSepaInFlight } from "../../../services/money/announce";

import {
  Button,
  Footer,
  Header,
  IconAvatar,
  IconButton,
  Scroll,
  Text,
  Topbar,
  TopbarTitle,
  TopbarTrailing,
  View,
} from "@ds";

import AmountKeypad from "../../../components/AmountKeypad";
import DsSheetHost from "../../../components/DsSheetHost";
import { formatIbanForDisplay } from "../../../lib/ibanFormat";
import { t } from "../../../lib/i18n";

import { wirexService } from "../../../services/wirex/WirexService";
import { pickSepaDebitToken } from "../../../lib/wirex/sepa";

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
const EUR_FLAG = require("../../../assets/flags/eur.png");
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
  const [debitToken, setDebitToken] = useState<DebitToken | null>(null);
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
      onSuccess();
    } catch {
      // No error UI exists for SEPA (no design). Do NOT log any PII. Fall back
      // to the send screen so the user can retry, rather than stranding them on
      // a confirmation with a silently re-enabled button.
      console.warn("[SepaAmountConfirmationModal] send failed");
      onClose();
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
    onClose,
  ]);

  // Only actionable failures stay near the amount. The available balance is in
  // the header, matching the other send screens.
  const amountHint = !debitToken
    ? t("screen.SepaAmountConfirmationModal.noTokenHint")
    : exceedsBalance
      ? t("screen.SepaAmountConfirmationModal.insufficientHint")
      : null;
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

      <Scroll>
        <View
          direction="column"
          align="stretch"
          justify="between"
          gap="sm"
          paddingX="lg"
          paddingBottom="lg"
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

          <View direction="column" align="center" justify="center" gap="sm" fill="grow">
            <View direction="row" align="center" justify="center" gap="sm">
              <IconAvatar size="sm" source={EUR_FLAG} />
              <Text
                size="3xl"
                align="center"
                accessibilityLabel={t("screen.SepaAmountConfirmationModal.amountA11yLabel", {
                  currency: CURRENCY_CODE,
                })}
              >
                {displayAmount || "0"}
              </Text>
            </View>
            {amountHint ? (
              <Text size="md" muted align="center">
                {amountHint}
              </Text>
            ) : null}
          </View>

          <View direction="column" align="stretch" justify="end" gap="lg">
            <AmountKeypad onDigit={handleDigit} onDecimal={handleDecimal} onDelete={handleDelete} />
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
