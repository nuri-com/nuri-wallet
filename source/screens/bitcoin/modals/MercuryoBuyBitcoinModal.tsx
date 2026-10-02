// @screen bitcoin.buy
import React, { useEffect, useMemo, useState } from "react";
import { Platform, Keyboard } from "react-native";
import {
  Button,
  ButtonText,
  Footer,
  Header,
  IconButton,
  Scroll,
  Topbar,
  TopbarTitle,
  TopbarTrailing,
  View,
} from "@ds";
import AmountDisplay, {
  BTC_LOGO,
  SATS_UNIT,
  fiatImageFor,
} from "../../../components/AmountDisplay";
import AmountKeypad from "../../../components/AmountKeypad";
import { useKeypadFit } from "../../../lib/useKeypadFit";
import DsSheetHost from "../../../components/DsSheetHost";
import { log } from "../../../services/logging/LoggerService";
import { bytesToHex, randomBytes } from "../../../lib/bytes";
import { SATS_PER_BTC } from "../../../lib/bitcoin/convert";
import { btcSpotPriceService } from "../../../services/pricing/BtcSpotPriceService";
import type { MercuryoBuyBitcoinProps } from "../../../types/mercuryo";
import {
  BUY_DEFAULT_EUR,
  DEFAULT_CRYPTO,
  MERCURYO_BUILD_MARKER,
  MERCURYO_MIN_EUR,
} from "../../../config/constants";
import { MERCURYO_BUY_URL } from "../../../config/endpoints";
import { shortValue, shortAddress } from "../../../lib/formatting";
import { mercuryoFlowLog, safeUrlForLog } from "../../../lib/mercuryo/helpers";
import {
  openExternalCheckout,
  prewarmExternalCheckout,
} from "../../../lib/mercuryo/checkoutBrowser";
import { startMercuryoOrderTracking } from "../../../services/mercuryo/MercuryoPendingTracker";
import { t } from "../../../lib/i18n";
import { groupCount } from "../../../lib/formatting";
type Props = MercuryoBuyBitcoinProps;

/**
 * The currency the purchase is PAID in. Checkout, its EUR-denominated minimum
 * and the tracked order are all euros; the display currency never changes
 * what is charged, so this is pinned rather than read from it.
 */
const BUY_FIAT = "EUR" as const;
const getDefaultFiat = () => BUY_FIAT;
// Preselects the payment method inside the widget — Apple Pay comes up already
// selected on iOS. This is the only thing that still differs per platform; the
// wording does not, because which methods exist is Mercuryo's call, not ours.
const DEFAULT_METHOD = Platform.OS === "ios" ? "applepay" : "google";

// Web: Mercuryo's widget blocks iframe embedding, so (like the native external
// browser) we open checkout in a new tab. Opening a blank tab inside the tap
// gesture and navigating it once the URL is fetched avoids popup blockers.
type WebCheckoutTab = { closed?: boolean; location: { href: string } };
const openWebCheckoutTab = (url: string): WebCheckoutTab | null => {
  try {
    const open = (
      globalThis as { open?: (u: string, t?: string, f?: string) => WebCheckoutTab | null }
    ).open;
    if (!open) return null;
    return url ? open(url, "_blank", "noopener,noreferrer") : open("", "_blank");
  } catch {
    return null;
  }
};

const MercuryoBuyBitcoinModal: React.FC<Props> = ({ visible, onClose, bitcoinAddress }) => {
  const [isSubmitting, setIsSubmitting] = useState(false);
  // A short screen compacts the keypad before it scrolls.
  const keypadFit = useKeypadFit();
  const [fiatPerBtc, setFiatPerBtc] = useState<number | null>(null);
  const [loadingPrice, setLoadingPrice] = useState(false);
  const minFiatAmount = MERCURYO_MIN_EUR;
  const [amount, setAmount] = useState<string>(String(BUY_DEFAULT_EUR));

  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot reset on open; minFiatAmount/bitcoinAddress updates must not re-run it and clobber the amount mid-entry
  useEffect(() => {
    if (!visible) return;
    // Open on the shared default, but never below the provider's floor.
    setAmount(String(Math.max(BUY_DEFAULT_EUR, minFiatAmount)));
    setIsSubmitting(false);
    mercuryoFlowLog("modal_open_reset", {
      platform: Platform.OS,
      buildMarker: MERCURYO_BUILD_MARKER,
      minEur: minFiatAmount,
      hasBitcoinAddress: Boolean(String(bitcoinAddress || "").trim()),
      bitcoinAddress: shortAddress(bitcoinAddress),
    });
    const loadPrice = async () => {
      try {
        setLoadingPrice(true);
        const snap = await btcSpotPriceService.getFresh(BUY_FIAT);
        if (snap.valid && snap.price && snap.price > 0) setFiatPerBtc(snap.price);
        else setFiatPerBtc(null);
      } catch {
        setFiatPerBtc(null);
      } finally {
        setLoadingPrice(false);
      }
    };
    void loadPrice();
    const prewarmCheckout = async () => {
      try {
        // Prewarm the browser connection.
        await Promise.allSettled([fetch(MERCURYO_BUY_URL)]);
      } catch {}
      await prewarmExternalCheckout(MERCURYO_BUY_URL);
    };
    void prewarmCheckout();
  }, [visible]);

  const handleChangeText = (text: string) => {
    // Allow free editing; enforce minimum on Buy press
    const digitsOnly = text.replace(/[^0-9]/g, "");
    setAmount(digitsOnly);
  };

  const fiatAmountInt = useMemo(() => {
    const n = Number.parseInt(amount || "0", 10);
    return Number.isFinite(n) ? n : 0;
  }, [amount]);

  const satsAmountInt = useMemo(() => {
    if (!fiatPerBtc || fiatPerBtc <= 0) return 0;
    return Math.round((fiatAmountInt / fiatPerBtc) * SATS_PER_BTC);
  }, [fiatAmountInt, fiatPerBtc]);

  const disabled = useMemo(() => {
    if (!bitcoinAddress) return true;
    return !Number.isFinite(fiatAmountInt) || fiatAmountInt < minFiatAmount;
  }, [bitcoinAddress, fiatAmountInt, minFiatAmount]);

  const handleBuy = async () => {
    if (isSubmitting || disabled) return;
    try {
      setIsSubmitting(true);
      // Web: open the checkout tab now, within the tap gesture, so it isn't
      // popup-blocked; navigated to the real URL once it's built below.
      const webTab = Platform.OS === "web" ? openWebCheckoutTab("") : null;
      // The address the CALLER named is where this purchase settles. Reading one
      // here instead would send the coins to whatever rail this service happens
      // to return — the button was gated on the caller's address while the money
      // went somewhere else.
      const addr = String(bitcoinAddress || "").trim();
      if (!addr) {
        log("[MercuryoBuyBitcoinModal] address missing", "No Bitcoin address available");
        mercuryoFlowLog("buy_blocked_missing_address");
        return;
      }
      let fiatAmount = fiatAmountInt;
      if (!Number.isFinite(fiatAmount) || fiatAmount <= 0) {
        log("[MercuryoBuyBitcoinModal] invalid amount", { amount });
        mercuryoFlowLog("buy_blocked_invalid_amount", { amount });
        return;
      }
      if (fiatAmount < minFiatAmount) {
        setAmount(String(minFiatAmount));
        fiatAmount = minFiatAmount;
        log(
          "[MercuryoBuyBitcoinModal] minimum amount applied",
          `Minimum is ${BUY_FIAT}${minFiatAmount}`,
        );
      }
      // High-entropy, single-field ID (no separators) to avoid provider parsing quirks.
      const now36 = Date.now().toString(36);
      const shortAddr = addr.slice(0, 6) + addr.slice(-6);
      const mtid = `m${bytesToHex(randomBytes(16))}${now36}`;
      const estimatedSats = (() => {
        const rate = Number(fiatPerBtc ?? 0);
        if (!Number.isFinite(rate) || rate <= 0) return undefined;
        const sats = Math.round((fiatAmount / rate) * SATS_PER_BTC);
        return Number.isFinite(sats) && sats > 0 ? sats : undefined;
      })();
      mercuryoFlowLog("buy_start", {
        mtid: shortValue(mtid),
        fiatAmount,
        estimatedSats,
        address: shortAddr,
        paymentMethod: DEFAULT_METHOD,
        fiatCurrency: getDefaultFiat(),
        cryptoCurrency: DEFAULT_CRYPTO,
      });

      const qs = new URLSearchParams({
        address: addr,
        fiatAmount: fiatAmount.toFixed(2),
        paymentMethod: DEFAULT_METHOD,
        currency: DEFAULT_CRYPTO,
        fiatCurrency: getDefaultFiat(),
        merchant_transaction_id: mtid,
      });
      const url = `${MERCURYO_BUY_URL}?${qs.toString()}`;
      mercuryoFlowLog("buy_open_url_ready", {
        mtid: shortValue(mtid),
        fiatAmount,
        url: safeUrlForLog(url),
        hasMtidQuery: url.includes("merchant_transaction_id="),
      });

      // Durable BEFORE the browser takes over: from here the purchase is the
      // tracker's, and it must survive this sheet closing, the app being
      // backgrounded, or the process being killed in checkout.
      await startMercuryoOrderTracking({
        mtid,
        createdAt: Date.now(),
        amountFiat: fiatAmount,
        amountSats: estimatedSats,
        fiat: getDefaultFiat(),
        crypto: DEFAULT_CRYPTO,
        payment: DEFAULT_METHOD,
        address: addr,
        openUrl: url,
      });

      mercuryoFlowLog("buy_checkout_started", {
        mtid: shortValue(mtid),
        platform: Platform.OS,
        targetUrl: safeUrlForLog(url),
      });
      if (Platform.OS === "web") {
        if (webTab && !webTab.closed) {
          try {
            webTab.location.href = url;
          } catch {}
        } else {
          openWebCheckoutTab(url);
        }
      } else {
        void openExternalCheckout(url);
      }
      Keyboard.dismiss();
      // Nothing left for this sheet to show: the purchase now lives in the
      // browser, and the tracker reports it into the activity list.
      onClose();
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      log("[MercuryoBuyBitcoinModal] error", errMessage);
    } finally {
      setIsSubmitting(false);
    }
  };

  // A dash while the price is unknown: zero would read as a free purchase.
  const secondaryAmount = loadingPrice || !fiatPerBtc ? "\u2014" : groupCount(satsAmountInt);
  const handleDigit = (digit: string) => handleChangeText(amount + digit);
  const handleDelete = () => handleChangeText(amount.slice(0, -1));
  return (
    <DsSheetHost visible={visible} onClose={onClose} mode="full">
      <Header safeAreaTop chrome="canvas">
        <Topbar surface="transparent" layout="fluid">
          <TopbarTitle>{t("screen.MercuryoBuyBitcoinModal.headerTitle")}</TopbarTitle>
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
          gap="lg"
          paddingX="lg"
          paddingBottom={keypadFit.compact ? "sm" : "lg"}
          fill="grow"
        >
          <AmountDisplay
            primaryAmount={amount || "0"}
            primaryImage={fiatImageFor(BUY_FIAT)}
            primaryUnit={BUY_FIAT}
            secondary={{ amount: secondaryAmount, image: BTC_LOGO, unit: SATS_UNIT }}
            message={
              !bitcoinAddress
                ? { text: t("screen.MercuryoBuyBitcoinModal.generateAddressHint"), tone: "info" }
                : null
            }
          />

          <AmountKeypad compact={keypadFit.compact} onDigit={handleDigit} onDelete={handleDelete} />
        </View>
      </Scroll>

      <Footer safeAreaBottom direction="column" align="stretch" paddingBottom="sm" paddingX="lg">
        <Button
          size="lg"
          variant="solid"
          accent="lilac"
          disabled={disabled || isSubmitting}
          onPress={() => void handleBuy()}
          accessibilityLabel={t("screen.MercuryoBuyBitcoinModal.buyBitcoinA11yLabel")}
        >
          <ButtonText>
            {isSubmitting
              ? t("screen.MercuryoBuyBitcoinModal.preparing")
              : t("screen.MercuryoBuyBitcoinModal.buyBitcoin")}
          </ButtonText>
        </Button>
      </Footer>
    </DsSheetHost>
  );
};

export default MercuryoBuyBitcoinModal;
