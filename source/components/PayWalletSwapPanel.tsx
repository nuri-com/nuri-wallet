// @component pay-wallet-swap
// Pay a pay link from a browser wallet in any token: connect, pick one of the
// tokens the wallet holds (LI.FI balances — never a typed symbol), enter the
// amount, see what the recipient receives, sign. State and the flow come from
// usePayWalletSwap; this is the shell.
import type React from "react";
import { useEffect, useState } from "react";
import { Button, ButtonIcon, ButtonText, Text, View } from "@ds";
import GotPaidIllustration from "../assets/illustrations/gotpaid.svg";
import AmountKeypad from "./AmountKeypad";
import BrandStatusView from "./BrandStatusView";
import PayLinkSummary from "./PayLinkSummary";
import SwapProcessingView, { SwapTryAgainView } from "./SwapProcessingView";
import PayWalletTokenPicker, {
  PAY_WALLET_CHAIN_NAME,
  payWalletHoldingKey,
} from "./PayWalletTokenPicker";
import { t } from "../lib/i18n";
import { exactBaseUnits } from "../lib/pay/payTarget";
import {
  type PayWalletHolding,
  payWalletLogoSource,
} from "../services/pay/PayWalletBalanceService";
import { exactDecimal } from "../services/pay/PayWalletSwapService";
import type { PayWalletHoldingsState, PayWalletState } from "../screens/pay/hooks/usePayWalletSwap";

const K = "screen.PayLink.wallet";

type Props = {
  state: PayWalletState;
  /**
   * A link's fixed amount (in `settleLabel`): no amount field — the page
   * quotes what the recipient must receive and shows what the payer spends.
   */
  fixedAmount?: string | null;
  holdings: PayWalletHoldingsState;
  settleLabel: string;
  /** Who or what the To card names; the settled asset when not given. */
  toLabel?: string;
  /** Writes what arrives; "<amount> <settleLabel>" when not given. */
  formatSettle?: (amount: string) => string;
  /** Changes how to pay at all (the pay page's other ways); the arrow opens it. */
  onPickSource?: () => void;
  onConnect: () => void;
  onRefreshHoldings: () => void;
  onQuote: (holding: PayWalletHolding, amount: string) => void;
  onPay: () => void;
  onResume: () => void;
  onReset: () => void;
};

function progressText(state: PayWalletState): string | null {
  if (state.step !== "paying" && state.step !== "done") return null;
  const progress = state.progress;
  if (progress.state === "signing") return t(`${K}.signing`);
  if (progress.state === "waiting") return t(`${K}.waiting`);
  if (progress.state === "settled") return t(`${K}.settled`);
  if (progress.reason === "needs_reconciliation") return t(`${K}.needsReconciliation`);
  if (progress.reason === "pending_payment_differs") return t(`${K}.pendingDiffers`);
  if (progress.reason === "quote_expired") return t(`${K}.quoteExpired`);
  return progress.reason === "rejected" ? t(`${K}.rejected`) : t(`${K}.failed`);
}

const PayWalletSwapPanel: React.FC<Props> = ({
  state,
  fixedAmount = null,
  holdings,
  settleLabel,
  toLabel,
  formatSettle,
  onPickSource,
  onConnect,
  onRefreshHoldings,
  onQuote,
  onPay,
  onResume,
  onReset,
}) => {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [amount, setAmount] = useState("");
  const list = holdings.status === "ready" ? holdings.holdings : [];
  const selected = list.find((holding) => payWalletHoldingKey(holding) === selectedKey) ?? null;
  // The largest balance is picked up front (the list comes sorted by value); a
  // new account's balances replace the pick when it no longer holds it.
  const first = list[0] ?? null;
  useEffect(() => {
    if (holdings.status !== "ready" || selected) return;
    setSelectedKey(first ? payWalletHoldingKey(first) : null);
    setAmount("");
  }, [holdings.status, selected, first]);

  if (state.step === "unavailable") {
    return (
      <Text size="sm" muted align="center">
        {t(`${K}.unavailable`)}
      </Text>
    );
  }

  if (state.step === "idle") {
    return (
      <View direction="column" align="stretch" gap="sm">
        <Button size="lg" variant="solid" accent="lilac" onPress={onConnect}>
          <ButtonIcon name="wallet" />
          <ButtonText>{t(`${K}.connect`)}</ButtonText>
        </Button>
        <Text size="sm" muted align="center">
          {t(`${K}.hint`)}
        </Text>
      </View>
    );
  }

  if (state.step === "pending") {
    const { request, option } = state.pending;
    return (
      <View direction="column" align="stretch" gap="sm">
        <Text size="md" align="center">
          {t(`${K}.pending`, {
            // What the payer spends: on a fixed-amount link the request names
            // the recipient's figure, so the accepted deposit is shown instead.
            amount: exactDecimal(option.depositAmount),
            token: request.token.symbol,
            receives: exactDecimal(option.settleAmount),
            asset: settleLabel,
          })}
        </Text>
        {state.otherAccount ? (
          <Text size="sm" muted align="center">
            {t(`${K}.pendingOtherAccount`, {
              account: `${request.payer.slice(0, 6)}…${request.payer.slice(-4)}`,
            })}
          </Text>
        ) : null}
        <Button size="lg" variant="solid" accent="lilac" onPress={onResume}>
          <ButtonIcon name={state.otherAccount ? "wallet" : "chevron-right"} />
          <ButtonText>{t(state.otherAccount ? `${K}.switchAccount` : `${K}.resume`)}</ButtonText>
        </Button>
      </View>
    );
  }

  // The wait, the result and the failure are the swap screens' own.
  if (state.step === "paying" || (state.step === "done" && state.progress.state === "waiting")) {
    return <SwapProcessingView phase="transfer" statusText={progressText(state)} />;
  }
  if (state.step === "done") {
    return state.progress.state === "settled" ? (
      <BrandStatusView
        title={t(`${K}.settled`)}
        illustration={<GotPaidIllustration width={241} height={213} />}
      />
    ) : (
      <SwapTryAgainView onRetry={onReset} title={progressText(state) ?? undefined} />
    );
  }

  const busy = state.step === "busy";
  const quoted = state.step === "quoted" ? state.quote : null;
  const typed = amount.replace(",", ".").trim();
  const units = selected ? exactBaseUnits(typed, selected.decimals) : null;
  const tooMuch = !fixedAmount && !!selected && units !== null && units > selected.units;
  const canQuote = fixedAmount
    ? !!selected
    : !!selected && units !== null && units > 0n && !tooMuch;
  const clearQuote = () => {
    if (state.step === "quoted" || state.step === "no-route" || state.step === "insufficient")
      onReset();
  };
  const changeAmount = (next: string) => {
    if (!selected || busy) return;
    const [, fraction = ""] = next.split(".");
    if (!/^\d*\.?\d*$/.test(next) || fraction.length > selected.decimals) return;
    setAmount(next.startsWith(".") ? `0${next}` : next.replace(/^0+(?=\d)/, ""));
    clearQuote();
  };

  const chain = selected
    ? (PAY_WALLET_CHAIN_NAME[selected.chainId] ?? String(selected.chainId))
    : null;
  const logo = selected ? payWalletLogoSource(selected.logoURI) : null;
  const sourceLabel = selected
    ? t(`${K}.selectedToken`, { token: selected.symbol, chain })
    : holdings.status === "ready"
      ? t(`${K}.noHoldings`)
      : holdings.status === "failed"
        ? t(`${K}.balancesFailed`)
        : t(`${K}.loadingBalances`);
  const spend = fixedAmount
    ? quoted
      ? exactDecimal(quoted.option.depositAmount)
      : null
    : amount || "0";
  // The Move sheet's one button: it names what is wrong, or what happens next.
  const ctaLabel =
    state.step === "no-route"
      ? t("screen.MoveSheet.noRoute")
      : tooMuch || state.step === "insufficient"
        ? t(`${K}.moreThanBalance`)
        : busy
          ? t(`${K}.quoting`)
          : quoted
            ? t("screen.MoveSheet.confirm")
            : t("screen.MoveSheet.next");

  return (
    <View direction="column" align="stretch" gap="lg" fill="grow">
      <PayLinkSummary
        grow
        to={toLabel ?? settleLabel}
        toAmount={(() => {
          const arrives = fixedAmount ?? quoted?.option.settleAmount ?? null;
          if (arrives === null) return null;
          return formatSettle ? formatSettle(arrives) : `${exactDecimal(arrives)} ${settleLabel}`;
        })()}
        sourceLabel={sourceLabel}
        {...(logo ? { image: logo } : { icon: "wallet" as const })}
        amount={selected && spend !== null ? `${spend} ${selected.symbol}` : null}
        onPickSource={() =>
          holdings.status === "failed"
            ? onRefreshHoldings()
            : list.length > 0 && !busy
              ? setPicking(true)
              : undefined
        }
        {...(onPickSource ? { onArrowPress: onPickSource } : {})}
      />

      {selected && !fixedAmount ? (
        <AmountKeypad
          onDigit={(digit) => changeAmount(`${amount}${digit}`)}
          {...(selected.decimals > 0 ? { onDecimal: () => changeAmount(`${amount}.`) } : {})}
          onDelete={() => changeAmount(amount.slice(0, -1))}
        />
      ) : null}

      <Button
        size="lg"
        variant="solid"
        accent="lilac"
        disabled={
          !selected ||
          busy ||
          state.step === "no-route" ||
          state.step === "insufficient" ||
          (!quoted && !canQuote)
        }
        onPress={() => (quoted ? onPay() : selected && onQuote(selected, fixedAmount ?? typed))}
      >
        <ButtonText>{ctaLabel}</ButtonText>
      </Button>

      <PayWalletTokenPicker
        visible={picking}
        holdings={list}
        onClose={() => setPicking(false)}
        onSelect={(key) => {
          setPicking(false);
          if (key !== selectedKey) {
            setSelectedKey(key);
            setAmount("");
            clearQuote();
          }
        }}
      />
    </View>
  );
};

export default PayWalletSwapPanel;
