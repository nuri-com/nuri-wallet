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
  TopbarTrailing,
  View,
} from "@ds";
import GotPaidIllustration from "../../assets/illustrations/gotpaid.svg";
import AmountKeypad from "../../components/AmountKeypad";
import BrandStatusView from "../../components/BrandStatusView";
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
import { parsePayLink } from "../../lib/pay/payLinkPath";
import { PAY_WALLET_AVAILABLE } from "../../lib/pay/payWallet";
import { type PayRecipient, resolvePayRecipient } from "../../lib/pay/resolvePayRecipient";
import { useKeypadFit } from "../../lib/useKeypadFit";
import { isValidEvmAddress } from "../../lib/validation";
import {
  availablePaySources,
  type PayRail,
  type PaySourceAsset,
  railRequiresAmount,
  selectPayRail,
} from "../../lib/pay/selectPayRail";
import { usePayLinkTarget } from "./hooks/usePayLinkTarget";
import { usePayOrderStatus } from "./hooks/usePayOrderStatus";
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
  USDC_BASE: { image: USD_FLAG, glyph: "$", decimals: true, unit: "USDC" },
  EURC_BASE: { image: EUR_FLAG, glyph: "€", decimals: true, unit: "EURC" },
  // The payer names the token in the wallet panel; this card shows no figure.
  EVM_WALLET: { glyph: null, decimals: true, unit: "" },
  EVM_ANY: { glyph: null, decimals: true, unit: "" },
};

/** Sources the page pays without the keypad: the wallet panel or a bare address. */
const NO_KEYPAD = new Set<PaySourceAsset>(["EVM_WALLET", "EVM_ANY"]);

/** What the link asks for: its currency (`?to=`) and a fixed amount (`?amount=`). */
function initialLink(): ReturnType<typeof parsePayLink> {
  return parsePayLink(typeof window === "undefined" ? "" : window.location.search);
}

/**
 * A fixed link amount written in a source's own keypad unit: sats for Bitcoin,
 * the stable itself otherwise. Only sources that land in the link's currency
 * are offered on such a link, so the unit always matches.
 */
function fixedKeypadAmount(amount: string, source: PaySourceAsset): string {
  if (source !== "BTC" && source !== "BTC_LN") return amount;
  const sats = exactBaseUnits(amount, 8);
  return sats === null ? "" : sats.toString();
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
  // A short screen compacts the keypad before it scrolls.
  const keypadFit = useKeypadFit();
  const [link] = useState(initialLink);
  const { settle } = link;
  // A link with an amount fixes it: no keypad, the recipient's figure is what
  // is requested (a swap is quoted on the recipient's side).
  const fixedAmount = link.amount;

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
  const sources = (recipient ? availablePaySources(recipient, settle, link) : []).filter(
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
  // The connect-wallet swap pays the recipient's address for the link's
  // currency: their EVM address for a stable, their bitcoin address for BTC.
  const walletRecipient =
    rail?.kind === "wallet-swap" &&
    (settle === "BTC" ? rail.settleTarget.length > 0 : isValidEvmAddress(rail.settleTarget))
      ? rail.settleTarget
      : null;
  const wallet = usePayWalletSwap(walletRecipient, settle, fixedAmount);
  const keypad = !(source && NO_KEYPAD.has(source)) && !fixedAmount;
  const look = source ? SOURCE_LOOK[source] : null;
  const needsAmount = rail ? railRequiresAmount(rail) : false;
  // The typed figure has to be expressible in the asset's own smallest unit,
  // exactly. More decimals than the asset has is not a smaller payment — it is
  // a figure this page would have to round, and the rounded number is the one
  // the wallet would send. The CTA stays disabled instead.
  const typedAmount = (fixedAmount && source ? fixedKeypadAmount(fixedAmount, source) : amount)
    .replace(",", ".")
    .trim();
  const amountStated = typedAmount !== "";
  const typedUnits =
    source && amountStated ? exactBaseUnits(typedAmount, paySourceDecimals(source)) : null;
  const amountValid = typedUnits !== null;
  // A figure the payer TYPED is never dropped: on the rails where an amount is
  // optional, an unrepresentable one used to fall back to an amountless QR, so
  // someone who entered `.5` got a request for nothing. Optional means "while
  // the field is empty", not "whenever it cannot be read".
  const canSubmit =
    Boolean(rail) && (fixedAmount ? amountValid : amountStated ? amountValid : !needsAmount);

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
    void request(
      rail,
      amountStated ? typedAmount : null,
      // The only swap behind a QR is Lightning: on a fixed link it is quoted on
      // the recipient's side, so they get the link's amount.
      fixedAmount ? "settle" : "deposit",
    );
  }, [rail, amountStated, typedAmount, request, fixedAmount]);

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
  // A Lightning payment funds a swap order; it is followed until the bitcoin
  // lands onchain, and a dead order withdraws its invoice.
  const order = usePayOrderStatus(target?.trackOrderId ?? null);
  const stalled = failed || order?.state === "failed";
  const overlay = stalled ? (
    <SwapTryAgainView onRetry={reset} retrying={busy} />
  ) : busy ? (
    <SwapProcessingView phase="route" />
  ) : null;
  // The amount form: the keypad scrolls with the content so a short screen can
  // compact it, and the CTA stays in the footer.
  const showForm = Boolean(recipient && rail && rail.kind !== "wallet-swap" && !target && !overlay);
  // A connected wallet's own card (token -> @username) and its wait and result
  // screens replace the summary; the card's arrow keeps the other ways to pay.
  const walletPair =
    rail?.kind === "wallet-swap" &&
    ["connected", "busy", "quoted", "no-route", "insufficient", "paying", "done"].includes(
      wallet.state.step,
    );

  return (
    <Screen>
      {/* grow-SHRINK, not grow: a flexShrink:0 box grows to its CONTENT in a
          browser instead of being capped by the screen, leaving the Scroll
          inside with no bounded height — on the PWA that renders the header and
          nothing else. */}
      <View chrome="canvas" direction="column" align="stretch" fill="grow-shrink">
        <Header safeAreaTop chrome="canvas">
          <Topbar surface="transparent" layout="fluid">
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

        <Scroll onLayout={keypadFit.onViewportLayout}>
          <View
            onLayout={keypadFit.onContentLayout}
            direction="column"
            align="stretch"
            gap={keypadFit.compact ? "sm" : "lg"}
            paddingX="lg"
            paddingBottom={keypadFit.compact ? "sm" : "lg"}
            fill="grow"
          >
            <View direction="column" align="stretch" gap="lg" fill="grow">
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

              {order?.state === "settled" ? (
                <View direction="column" align="stretch" fill="grow">
                  <BrandStatusView
                    title={t(`${K}.orderSettled`)}
                    illustration={<GotPaidIllustration width={241} height={213} />}
                  />
                </View>
              ) : null}

              {/* Summary stays visible when the keypad becomes a payment target. */}
              {recipient &&
              rail &&
              look &&
              !overlay &&
              !walletPair &&
              order?.state !== "settled" ? (
                <PayLinkSummary
                  grow={showForm}
                  to={`@${username}`}
                  sourceLabel={t(`${K}.asset.${rail.source}`)}
                  {...(look.image !== undefined
                    ? { image: look.image }
                    : { icon: "wallet" as const })}
                  amount={
                    source && NO_KEYPAD.has(source)
                      ? null
                      : target?.amount !== null && target
                        ? amountFigure(exactAmountText(target) ?? "", look)
                        : amountFigure(typedAmount, look)
                  }
                  onPickSource={() => setPicking(true)}
                />
              ) : null}

              {/* Any token from the payer's own wallet, swapped in-page into what
                the link asks for. The wallet signs; nothing is shown as a QR. */}
              {rail?.kind === "wallet-swap" && !overlay ? (
                <PayWalletSwapPanel
                  state={wallet.state}
                  fixedAmount={fixedAmount}
                  holdings={wallet.holdings}
                  settleLabel={t(`${K}.asset.${settle}`)}
                  toLabel={`@${username}`}
                  onPickSource={() => setPicking(true)}
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

              {rail && target && !overlay && order?.state !== "settled" ? (
                <PayTargetView
                  target={target}
                  label={t(`${K}.asset.${rail.source}`)}
                  {...(exactAmount ? { exactAmount } : {})}
                  {...(order?.state === "waiting"
                    ? { status: t(`${K}.orderWaiting`) }
                    : rail.kind === "evm-any"
                      ? { status: t(`${K}.anyTokenHint`) }
                      : {})}
                />
              ) : null}
            </View>

            {showForm && keypad ? (
              <AmountKeypad
                compact={keypadFit.compact}
                onDigit={(digit) => changeAmount(`${amount}${digit}`)}
                {...(look?.decimals ? { onDecimal: () => changeAmount(`${amount}.`) } : {})}
                onDelete={() => changeAmount(amount.slice(0, -1))}
              />
            ) : null}
          </View>
        </Scroll>

        {showForm ? (
          <Footer
            safeAreaBottom
            direction="column"
            align="stretch"
            gap="sm"
            paddingX="lg"
            paddingBottom="sm"
          >
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
