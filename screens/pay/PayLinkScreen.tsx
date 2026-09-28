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
  TextField,
  Topbar,
  TopbarTitle,
  TopbarTrailing,
  View,
} from "@ds";
import GotPaidIllustration from "../../assets/illustrations/gotpaid.svg";
import AmountKeypad from "../../components/AmountKeypad";
import BrandStatusView from "../../components/BrandStatusView";
import ChoiceSheet from "../../components/ChoiceSheet";
import PayTargetView from "../../components/PayTargetView";
import PayLinkSummary from "../../components/PayLinkSummary";
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
import { usePayOrderStatus } from "./hooks/usePayOrderStatus";

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
  { image: number; glyph: string | null; decimals: boolean; unit: string }
> = {
  BTC: { image: BTC_LOGO, glyph: null, decimals: false, unit: "sats" },
  BTC_LN: { image: LIGHTNING_LOGO, glyph: null, decimals: false, unit: "sats" },
  BTC_ARKADE: { image: BTC_LOGO, glyph: null, decimals: false, unit: "sats" },
  USDC_BASE: { image: USD_FLAG, glyph: "$", decimals: true, unit: "USDC" },
  EURC_BASE: { image: EUR_FLAG, glyph: "€", decimals: true, unit: "EURC" },
  USDC_ARBITRUM: { image: USD_FLAG, glyph: "$", decimals: true, unit: "USDC" },
};

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
  const [refundAddress, setRefundAddress] = useState("");
  const { target, busy, failed, request, reset } = usePayLinkTarget();

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
  const sources = recipient ? availablePaySources(recipient) : [];

  // The first rail the recipient has is pre-selected: with the destination
  // fixed, an empty card would ask the payer to choose before it shows them
  // anything, and the chip is right there to change it.
  useEffect(() => {
    if (!source && sources.length > 0) setSource(sources[0] ?? null);
  }, [source, sources]);

  const rail: PayRail | null = recipient && source ? selectPayRail(source, recipient) : null;
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
  const needsRefund = rail?.kind === "swap";
  // A refund address has to be a real EVM address, not merely typed in: it is
  // where the money goes if the swap fails, and a typo is a destination the
  // payer does not control. The CTA stays disabled — the page shows no errors.
  const refundValid = isValidEvmAddress(refundAddress);
  // A figure the payer TYPED is never dropped: on the rails where an amount is
  // optional, an unrepresentable one used to fall back to an amountless QR, so
  // someone who entered `.5` got a request for nothing. Optional means "while
  // the field is empty", not "whenever it cannot be read".
  const canSubmit =
    Boolean(rail) && (amountStated ? amountValid : !needsAmount) && (!needsRefund || refundValid);

  const pickSource = useCallback(
    (next: PaySourceAsset) => {
      reset();
      setAmount("");
      setRefundAddress("");
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
    void request(rail, amountStated ? typedAmount : null, refundAddress.trim());
  }, [rail, amountStated, typedAmount, refundAddress, request]);

  // An address is funded by hand, so the amount has to be readable next to it —
  // a swap deposit especially, where the provider's quoted figure is the only
  // one the order settles for and it need not be the one that was entered. An
  // invoice carries its own amount and gets none.
  const exactAmount =
    target && target.kind === "address" && target.amount !== null && look
      ? t(`${K}.sendExactly`, { amount: `${exactAmountText(target)} ${look.unit}` })
      : null;

  // A swap deposit has an order behind it, and the payer funds it from a wallet
  // this page cannot see — so the order is the only thing that can say whether
  // the money arrived. A direct rail has none and polls nothing.
  const order = usePayOrderStatus(target?.trackTxId ?? null);
  // Only the wait has a line to carry: a settled order replaces the target
  // outright, and a failed one is the retry view.
  const orderStatus = order?.state === "waiting" ? order.phase || t(`${K}.orderWaiting`) : null;

  // The wait and the failure are the app's own swap screens, so producing
  // something to pay looks like every other move while it runs. An order that
  // ended anywhere but COMPLETED lands here too: its deposit address must stop
  // being offered, because nothing will settle what is sent to it now.
  // Try again means the FORM, not the same request again. Nothing the payer
  // could change lives in the overlay, and the request that failed will fail
  // the same way — an amount outside the endpoint's bounds, a pair with no
  // route. `reset` keeps what they typed, so they land back on it.
  const stalled = failed || order?.state === "failed";
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

            {/* Summary stays visible when the keypad becomes a payment target.
                The quoted integer wins over the typed amount on swap deposits. */}
            {recipient && rail && look && !overlay && order?.state !== "settled" ? (
              <PayLinkSummary
                username={username}
                sourceLabel={t(`${K}.asset.${rail.source}`)}
                image={look.image}
                amount={
                  target?.amount !== null && target
                    ? amountFigure(exactAmountText(target) ?? "", look)
                    : amountFigure(amount, look)
                }
                onPickSource={() => setPicking(true)}
              />
            ) : null}

            {/* A swap can fail, and a stranger's funds then have nowhere to go.
                Under the card, because it belongs to this move and to no other:
                the direct rails never ask for it. */}
            {rail?.kind === "swap" && !target && !overlay ? (
              <TextField
                onChangeText={setRefundAddress}
                autoCapitalize="none"
                disabled={busy}
                placeholder={t(`${K}.refundPlaceholder`)}
                accessibilityLabel={t(`${K}.refundLabel`)}
              />
            ) : null}

            {/* A terminal order takes its deposit address with it. Settled, the
                order is closed and a second transfer to it settles nothing;
                failed, nothing will settle what is sent at all. Either way the
                address must stop being scannable, copyable and scrollable-to. */}
            {order?.state === "settled" ? (
              <View direction="column" align="stretch" fill="grow">
                <BrandStatusView
                  title={t(`${K}.orderSettled`)}
                  illustration={<GotPaidIllustration width={241} height={213} />}
                />
              </View>
            ) : null}

            {rail && target && !overlay && order?.state !== "settled" ? (
              <PayTargetView
                target={target}
                label={t(`${K}.asset.${rail.source}`)}
                {...(exactAmount ? { exactAmount } : {})}
                {...(orderStatus ? { status: orderStatus } : {})}
              />
            ) : null}
          </View>
        </Scroll>

        {recipient && rail && !target && !overlay ? (
          <Footer
            safeAreaBottom
            direction="column"
            align="stretch"
            gap="sm"
            paddingX="lg"
            paddingBottom="sm"
          >
            <AmountKeypad
              onDigit={(digit) => changeAmount(`${amount}${digit}`)}
              {...(look?.decimals ? { onDecimal: () => changeAmount(`${amount}.`) } : {})}
              onDelete={() => changeAmount(amount.slice(0, -1))}
            />
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
        // Six rails do not fit a bottom sheet: the DS caps a sheet and clips
        // what is past the cap, so on web the last rows cannot be reached.
        mode="full"
        items={sources.map((option) => ({
          key: option,
          image: SOURCE_LOOK[option].image,
          label: t(`${K}.asset.${option}`),
        }))}
        onSelect={pickSource}
      />
    </Screen>
  );
};

export default PayLinkScreen;
