// @screen pay.link
// The public payment link — `app.nuri.com/pay/@username`, opened by anyone.
//
// Built as the Move sheet, because it IS a move: the same inverted card with a
// From and a To, the same keypad under it, the same single CTA. The one
// difference is the half that cannot be touched — the destination is not a
// picker here, it is the recipient the link names, and it carries no chevron and
// no balance because a stranger knows neither.
//
// Nothing on this screen belongs to the viewer: no wallet, no session, no
// passkey. The recipient's rails come from the public ENS directory; the payer
// says which asset they hold and how much, and the screen hands back the one
// thing to pay.
//
// Phase 1 is QR only: whatever the rail, the payer pays it from a wallet they
// already have. Connectors (EVM, WebLN) are Phase 2 and hang off PayTargetView.
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import {
  Button,
  ButtonText,
  ButtonIcon,
  Footer,
  Header,
  IconButton,
  Screen,
  Scroll,
  Text,
  Topbar,
  TopbarTitle,
  TopbarTrailing,
  View,
} from "@ds";
import AmountKeypad from "../../components/AmountKeypad";
import ChoiceSheet from "../../components/ChoiceSheet";
import PayTargetView from "../../components/PayTargetView";
import PayLinkSummary from "../../components/PayLinkSummary";
import PayWalletSwapPanel from "../../components/PayWalletSwapPanel";
import Spinner from "../../components/Spinner";
import SwapProcessingView, { SwapTryAgainView } from "../../components/SwapProcessingView";
import { groupCount } from "../../lib/formatting";
import { t } from "../../lib/i18n";
import {
  exactBaseUnits,
  formatBaseUnits,
  type PayTarget,
  paySourceDecimals,
} from "../../lib/pay/payTarget";
import { parsePaySettle } from "../../lib/pay/payLinkPath";
import { PAY_WALLET_AVAILABLE } from "../../lib/pay/payWallet";
import { type PayRecipient, resolvePayRecipient } from "../../lib/pay/resolvePayRecipient";
import { isValidEvmAddress } from "../../lib/validation";
import {
  availablePaySources,
  type PayRail,
  type PaySourceAsset,
  railRequiresAmount,
  selectPayRail,
} from "../../lib/pay/selectPayRail";
import { usePayLinkTarget } from "./hooks/usePayLinkTarget";
import { usePayWalletSwap } from "./hooks/usePayWalletSwap";

const K = "screen.PayLink";

const BTC_LOGO = require("../../assets/rails/btc.png");
const LIGHTNING_LOGO = require("../../assets/rails/lightning.png");
const EUR_FLAG = require("../../assets/flags/eur.png");
const USD_FLAG = require("../../assets/flags/usa.png");

/**
 * Every source the page can offer, with the mark the rest of the app gives it.
 *
 * The Bitcoin rails carry a WRITTEN unit and no glyph. Inside the app "₿ 50 000"
 * is read as sats by people who know the wallet counts in them; this page is
 * opened by strangers, for whom "₿1" plainly means one bitcoin — and every rail
 * here consumes the figure as sats. The unit is therefore spelled out, and the
 * keypad's missing decimal point stops meaning "bitcoin has none".
 */
const SOURCE_LOOK: Record<
  PaySourceAsset,
  { image?: number; glyph: string | null; decimals: boolean; unit: string }
> = {
  BTC: { image: BTC_LOGO, glyph: null, decimals: false, unit: "sats" },
  BTC_LN: { image: LIGHTNING_LOGO, glyph: null, decimals: false, unit: "sats" },
  BTC_ARKADE: { image: BTC_LOGO, glyph: null, decimals: false, unit: "sats" },
  USDC_BASE: { image: USD_FLAG, glyph: "$", decimals: true, unit: "USDC" },
  EURC_BASE: { image: EUR_FLAG, glyph: "€", decimals: true, unit: "EURC" },
  // The payer names the token in the wallet panel; this card shows no figure.
  EVM_WALLET: { glyph: null, decimals: true, unit: "" },
  EVM_ANY: { glyph: null, decimals: true, unit: "" },
};

/** Sources the page pays without the keypad: the wallet panel or a bare address. */
const NO_KEYPAD = new Set<PaySourceAsset>(["EVM_WALLET", "EVM_ANY"]);

/** What the recipient receives from an in-page swap, from the link's `?to=`. */
function initialSettle(): "EURC_BASE" | "USDC_BASE" {
  return typeof window === "undefined" ? "EURC_BASE" : parsePaySettle(window.location.search);
}

type SourceLook = (typeof SOURCE_LOOK)[PaySourceAsset];

/** The figure as the payer typed it, in the unit it will actually be read in. */
function amountFigure(typed: string, look: SourceLook | null): string {
  const digits = typed || "0";
  if (!look) return digits;
  return look.glyph ? `${look.glyph}${digits}` : `${digits} ${look.unit}`;
}

/**
 * The figure to send, written out from the SAME integer the QR was built from —
 * never re-derived from what was typed. A swap deposit settles only for the
 * amount the provider quoted, so the line a payer reads and the number a wallet
 * scans have to come from one place or they can disagree.
 */
function exactAmountText(target: PayTarget): string | null {
  if (target.amount === null) return null;
  const units = BigInt(target.amount);
  return target.decimals > 0 ? formatBaseUnits(units, target.decimals) : groupCount(Number(units));
}

type Lookup = { state: "loading" } | { state: "missing" } | { state: "found"; value: PayRecipient };

type Props = { username: string };

const PayLinkScreen: React.FC<Props> = ({ username }) => {
  const [lookup, setLookup] = useState<Lookup>({ state: "loading" });
  const [source, setSource] = useState<PaySourceAsset | null>(null);
  const [picking, setPicking] = useState(false);
  const [amount, setAmount] = useState("");
  const { target, busy, failed, request, reset } = usePayLinkTarget();
  const [settle] = useState(initialSettle);

  useEffect(() => {
    let cancelled = false;
    setLookup({ state: "loading" });
    (async () => {
      try {
        const recipient = await resolvePayRecipient(username);
        if (cancelled) return;
        setLookup(recipient ? { state: "found", value: recipient } : { state: "missing" });
      } catch (e) {
        // An RPC outage is not an unknown username, but the payer can do nothing
        // about either — both end at "this link cannot be paid right now". The
        // difference still matters to us, so it is logged.
        console.warn("[PayLinkScreen] recipient lookup failed:", e);
        if (!cancelled) setLookup({ state: "missing" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [username]);

  const recipient = lookup.state === "found" ? lookup.value : null;
  // Without a wallet picker in this build (no WalletConnect project id), the
  // connect-wallet source is not offered at all.
  const sources = (recipient ? availablePaySources(recipient) : []).filter(
    (option) => option !== "EVM_WALLET" || PAY_WALLET_AVAILABLE,
  );

  // The first rail the recipient has is pre-selected: with the destination
  // fixed, an empty card would ask the payer to choose before it shows them
  // anything, and the chip is right there to change it.
  useEffect(() => {
    if (!source && sources.length > 0) setSource(sources[0] ?? null);
  }, [source, sources]);

  const rail: PayRail | null =
    recipient && source ? selectPayRail(source, recipient, settle) : null;
  const walletRecipient =
    rail?.kind === "wallet-swap" && isValidEvmAddress(rail.settleTarget)
      ? (rail.settleTarget as `0x${string}`)
      : null;
  const wallet = usePayWalletSwap(walletRecipient, settle);
  const keypad = !(source && NO_KEYPAD.has(source));
  const look = source ? SOURCE_LOOK[source] : null;
  const needsAmount = rail ? railRequiresAmount(rail) : false;
  // The typed figure has to be expressible in the asset's own smallest unit,
  // exactly. More decimals than the asset has is not a smaller payment — it is
  // a figure this page would have to round, and the rounded number is the one
  // the wallet would send. The CTA stays disabled instead.
  const typedAmount = amount.replace(",", ".").trim();
  const amountStated = typedAmount !== "";
  const typedUnits =
    source && amountStated ? exactBaseUnits(typedAmount, paySourceDecimals(source)) : null;
  const amountValid = typedUnits !== null;
  // A figure the payer TYPED is never dropped: on the rails where an amount is
  // optional, an unrepresentable one used to fall back to an amountless QR, so
  // someone who entered `.5` got a request for nothing. Optional means "while
  // the field is empty", not "whenever it cannot be read".
  const canSubmit = Boolean(rail) && (amountStated ? amountValid : !needsAmount);

  const pickSource = useCallback(
    (next: PaySourceAsset) => {
      reset();
      setAmount("");
      setSource(next);
      setPicking(false);
    },
    [reset],
  );

  const changeAmount = useCallback((next: string) => {
    if (next.split(".").length > 2) return;
    setAmount(next.replace(/^0+(?=\d)/, ""));
  }, []);

  const submit = useCallback(() => {
    if (!rail) return;
    void request(rail, amountStated ? typedAmount : null);
  }, [rail, amountStated, typedAmount, request]);

  // An address is funded by hand, so the amount has to be readable next to it.
  // An invoice carries its own amount and gets none.
  const exactAmount =
    target && target.kind === "address" && target.amount !== null && look
      ? t(`${K}.sendExactly`, { amount: `${exactAmountText(target)} ${look.unit}` })
      : null;

  // The wait and the failure are the app's own swap screens, so producing
  // something to pay looks like every other move while it runs.
  // Try again means the FORM, not the same request again. Nothing the payer
  // could change lives in the overlay, and the request that failed will fail
  // the same way — an amount outside the endpoint's bounds. `reset` keeps what
  // they typed, so they land back on it.
  const stalled = failed;
  const overlay = stalled ? (
    <SwapTryAgainView onRetry={reset} retrying={busy} />
  ) : busy ? (
    <SwapProcessingView phase="route" />
  ) : null;

  return (
    <Screen>
      {/* grow-SHRINK, not grow: a flexShrink:0 box grows to its CONTENT in a
          browser instead of being capped by the screen, leaving the Scroll
          inside with no bounded height — on the PWA that renders the header and
          nothing else. */}
      <View chrome="canvas" direction="column" align="stretch" fill="grow-shrink">
        <Header safeAreaTop chrome="canvas">
          <Topbar surface="transparent" layout="fluid">
            <TopbarTitle>{t(`${K}.title`, { username })}</TopbarTitle>
            {target || stalled ? (
              <TopbarTrailing>
                <IconButton
                  icon="chevron-left"
                  variant="soft"
                  accessibilityLabel={t("common.back")}
                  onPress={reset}
                />
              </TopbarTrailing>
            ) : null}
          </Topbar>
        </Header>

        <Scroll>
          <View direction="column" align="stretch" gap="lg" paddingX="lg" fill="grow">
            {lookup.state === "loading" ? (
              <View direction="column" align="center" justify="center" fill="grow">
                <Spinner />
              </View>
            ) : null}

            {lookup.state === "missing" ? (
              <Text size="md" muted align="center">
                {t(`${K}.notFound`, { username })}
              </Text>
            ) : null}

            {overlay}

            {/* Summary stays visible when the keypad becomes a payment target. */}
            {recipient && rail && look && !overlay ? (
              <PayLinkSummary
                username={username}
                sourceLabel={t(`${K}.asset.${rail.source}`)}
                {...(look.image !== undefined
                  ? { image: look.image }
                  : { icon: "wallet" as const })}
                amount={
                  !keypad
                    ? null
                    : target?.amount !== null && target
                      ? amountFigure(exactAmountText(target) ?? "", look)
                      : amountFigure(amount, look)
                }
                onPickSource={() => setPicking(true)}
              />
            ) : null}

            {/* Any token from the payer's own wallet, swapped in-page into what
                the link asks for. The wallet signs; nothing is shown as a QR. */}
            {rail?.kind === "wallet-swap" && !overlay ? (
              <PayWalletSwapPanel
                state={wallet.state}
                holdings={wallet.holdings}
                settleLabel={t(`${K}.asset.${settle}`)}
                onConnect={() => void wallet.connect()}
                onRefreshHoldings={wallet.refreshHoldings}
                onQuote={(holding, typed) => void wallet.quote(holding, typed)}
                onPay={() => void wallet.pay()}
                onResume={() => void wallet.resume()}
                onReset={wallet.reset}
              />
            ) : null}

            {rail?.kind === "evm-any" && !target && !overlay ? (
              <Text size="sm" muted align="center">
                {t(`${K}.anyTokenHint`)}
              </Text>
            ) : null}

            {rail && target && !overlay ? (
              <PayTargetView
                target={target}
                label={t(`${K}.asset.${rail.source}`)}
                {...(exactAmount ? { exactAmount } : {})}
                {...(rail.kind === "evm-any" ? { status: t(`${K}.anyTokenHint`) } : {})}
              />
            ) : null}
          </View>
        </Scroll>

        {recipient && rail && rail.kind !== "wallet-swap" && !target && !overlay ? (
          <Footer
            safeAreaBottom
            direction="column"
            align="stretch"
            gap="sm"
            paddingX="lg"
            paddingBottom="sm"
          >
            {keypad ? (
              <AmountKeypad
                onDigit={(digit) => changeAmount(`${amount}${digit}`)}
                {...(look?.decimals ? { onDecimal: () => changeAmount(`${amount}.`) } : {})}
                onDelete={() => changeAmount(amount.slice(0, -1))}
              />
            ) : null}
            <Button
              size="lg"
              variant="solid"
              accent="lilac"
              disabled={!canSubmit || busy}
              onPress={submit}
              accessibilityLabel={t(`${K}.continue`)}
            >
              <ButtonIcon name="chevron-right" />
              <ButtonText>{t(`${K}.continue`)}</ButtonText>
            </Button>
          </Footer>
        ) : null}
      </View>

      <ChoiceSheet
        visible={picking}
        onClose={() => setPicking(false)}
        title={t(`${K}.chooseAsset`)}
        // Seven rails do not fit a bottom sheet: the DS caps a sheet and clips
        // what is past the cap, so on web the last rows cannot be reached.
        mode="full"
        items={sources.map((option) => {
          const image = SOURCE_LOOK[option].image;
          return {
            key: option,
            ...(image !== undefined
              ? { image }
              : { icon: "wallet" as const, accent: "lilac" as const }),
            label: t(`${K}.asset.${option}`),
          };
        })}
        onSelect={pickSource}
      />
    </Screen>
  );
};

export default PayLinkScreen;
