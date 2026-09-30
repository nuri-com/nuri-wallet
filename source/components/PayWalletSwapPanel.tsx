// @component pay-wallet-swap
// Pay a pay link from a browser wallet in any token: connect, pick one of the
// tokens the wallet holds (LI.FI balances — never a typed symbol), enter the
// amount, see what the recipient receives, sign. State and the flow come from
// usePayWalletSwap; this is the shell.
import type React from "react";
import { useEffect, useState } from "react";
import { Button, ButtonIcon, ButtonText, Text, TextField, View } from "@ds";
import PayWalletTokenPicker, {
  PAY_WALLET_CHAIN_NAME,
  payWalletHoldingKey,
} from "./PayWalletTokenPicker";
import { t } from "../lib/i18n";
import { exactBaseUnits } from "../lib/pay/payTarget";
import type { PayWalletHolding } from "../services/pay/PayWalletBalanceService";
import { displayDecimal, exactDecimal } from "../services/pay/PayWalletSwapService";
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
  // A new account's balances replace the list: drop a pick it no longer holds.
  useEffect(() => {
    if (selectedKey && holdings.status === "ready" && !selected) {
      setSelectedKey(null);
      setAmount("");
    }
  }, [holdings.status, selected, selectedKey]);

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

  if (state.step === "paying" || state.step === "done") {
    return (
      <View direction="column" align="stretch" gap="sm">
        <Text size="md" align="center">
          {progressText(state)}
        </Text>
        {state.step === "done" && state.progress.state !== "settled" ? (
          <Button size="lg" variant="soft" onPress={onReset}>
            <ButtonText>{t(`${K}.tryAgain`)}</ButtonText>
          </Button>
        ) : null}
      </View>
    );
  }

  const busy = state.step === "busy";
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

  return (
    <View direction="column" align="stretch" gap="sm">
      <Button size="sm" variant="soft" onPress={onConnect}>
        <ButtonIcon name="wallet" />
        <ButtonText>
          {t(`${K}.connected`, {
            account: `${state.account.slice(0, 6)}…${state.account.slice(-4)}`,
          })}
        </ButtonText>
      </Button>

      {holdings.status === "loading" || holdings.status === "idle" ? (
        <Text size="sm" muted align="center">
          {t(`${K}.loadingBalances`)}
        </Text>
      ) : null}
      {holdings.status === "failed" ? (
        <Button size="sm" variant="soft" onPress={onRefreshHoldings}>
          <ButtonText>{t(`${K}.balancesFailed`)}</ButtonText>
        </Button>
      ) : null}
      {holdings.status === "ready" && list.length === 0 ? (
        <Text size="sm" muted align="center">
          {t(`${K}.noHoldings`)}
        </Text>
      ) : null}

      {list.length > 0 ? (
        <Button
          size="lg"
          variant="soft"
          disabled={busy}
          onPress={() => setPicking(true)}
          accessibilityLabel={t(`${K}.tokenLabel`)}
        >
          <ButtonText>
            {selected
              ? t(`${K}.selectedToken`, {
                  token: selected.symbol,
                  chain: PAY_WALLET_CHAIN_NAME[selected.chainId] ?? String(selected.chainId),
                })
              : t(`${K}.chooseToken`)}
          </ButtonText>
          <ButtonIcon name="chevron-down" />
        </Button>
      ) : null}

      {fixedAmount ? (
        <Text size="md" align="center">
          {t(`${K}.fixedAmount`, { amount: exactDecimal(fixedAmount), asset: settleLabel })}
        </Text>
      ) : null}

      {selected && !fixedAmount ? (
        <View direction="column" align="stretch" gap="sm">
          <TextField
            value={amount}
            onChangeText={(next) => {
              setAmount(next);
              clearQuote();
            }}
            inputMode="decimal"
            disabled={busy}
            placeholder={t(`${K}.amountPlaceholder`)}
            accessibilityLabel={t(`${K}.amountLabel`)}
          />
          <Button
            size="sm"
            variant="soft"
            disabled={busy}
            onPress={() => {
              setAmount(selected.amount);
              clearQuote();
            }}
          >
            <ButtonText>
              {t(`${K}.max`, { balance: displayDecimal(selected.amount, 4) })}
            </ButtonText>
          </Button>
        </View>
      ) : null}
      {tooMuch ? (
        <Text size="sm" muted align="center">
          {t(`${K}.moreThanBalance`)}
        </Text>
      ) : null}

      {state.step === "quoted" && !fixedAmount ? (
        <Text size="md" align="center">
          {t(`${K}.receives`, {
            amount: exactDecimal(state.quote.option.settleAmount),
            asset: settleLabel,
          })}
        </Text>
      ) : null}
      {(state.step === "quoted" || state.step === "insufficient") && fixedAmount && selected ? (
        <Text size="md" align="center">
          {t(`${K}.youPay`, {
            amount: exactDecimal(state.quote.option.depositAmount),
            token: selected.symbol,
          })}
        </Text>
      ) : null}
      {state.step === "insufficient" ? (
        <Text size="sm" muted align="center">
          {t(`${K}.moreThanBalance`)}
        </Text>
      ) : null}
      {state.step === "no-route" ? (
        <Text size="sm" muted align="center">
          {t(`${K}.noRoute`)}
        </Text>
      ) : null}
      {selected ? (
        state.step === "quoted" ? (
          <Button size="lg" variant="solid" accent="lilac" onPress={onPay}>
            <ButtonIcon name="chevron-right" />
            <ButtonText>{t(`${K}.pay`)}</ButtonText>
          </Button>
        ) : (
          <Button
            size="lg"
            variant="solid"
            accent="lilac"
            disabled={!canQuote || busy || state.step === "insufficient"}
            onPress={() => onQuote(selected, fixedAmount ?? typed)}
          >
            <ButtonText>{busy ? t(`${K}.quoting`) : t(`${K}.quote`)}</ButtonText>
          </Button>
        )
      ) : null}

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
