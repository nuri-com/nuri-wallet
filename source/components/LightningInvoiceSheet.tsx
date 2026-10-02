// @screen bitcoin.ln-invoice
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Share } from "react-native";
import { copyToClipboard } from "../lib/copyToClipboard";
import {
  Button,
  ButtonText,
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
import { t } from "../lib/i18n";
import { satsFromAmountEntry } from "../lib/bitcoin/convert";
import { useHomeCurrency } from "../lib/currency/useHomeCurrency";
import { sanitizeDigits, sanitizeFiatDigits } from "../lib/sanitizeDigits";
import { useCurrencyToggle, useKeypadEntry } from "../lib/useCurrencyToggle";
import { useLiveBtcPrice } from "../lib/bitcoin/useLiveBtcPrice";
import { btcSpotPriceService } from "../services/pricing/BtcSpotPriceService";
import AddressQrTile from "./AddressQrTile";
import AmountKeypad from "./AmountKeypad";
import AmountDisplay, {
  BTC_LOGO,
  SATS_UNIT,
  bitcoinSecondaryAmount,
  fiatImageFor,
} from "./AmountDisplay";
import { useKeypadFit } from "../lib/useKeypadFit";
import DsSheetHost from "./DsSheetHost";
import { groupCount } from "../lib/formatting";
import {
  ARKADE_RECEIVE_MAX_SATS,
  ARKADE_RECEIVE_MIN_SATS,
  checkReceiveAmountSats,
} from "../services/arkade/internal/receiveLimits";

type SheetState =
  | { kind: "entering" }
  | { kind: "creating" }
  | { kind: "ready"; invoice: string; expiresAtMs: number; amountSats: number }
  | { kind: "error" };

type Props = {
  visible: boolean;
  onClose: () => void;
  /**
   * Parent performs the createArkadeLightningInvoice round-trip (the server
   * creates and stores the swap) and returns the bolt11 invoice plus the
   * absolute expiry timestamp. If the server has no concrete TTL, parent may
   * default to a sensible value.
   */
  onCreateInvoice: (amountSats: number) => Promise<{ invoice: string; expiresAtMs: number }>;
  lightningAddress?: string | null;
  onOpenSupportChat?: () => void;
};

const LightningInvoiceSheet: React.FC<Props> = ({
  visible,
  onClose,
  onCreateInvoice,
  lightningAddress,
  onOpenSupportChat,
}) => {
  type InputMode = "sats" | "fiat";
  const [fiatPerBtc, setFiatPerBtc] = useState<number | null>(null);
  const fiatSymbol = useHomeCurrency();
  const [state, setState] = useState<SheetState>({ kind: "entering" });
  const [secondsLeft, setSecondsLeft] = useState(0);
  // A short screen compacts the keypad before it scrolls.
  const keypadFit = useKeypadFit();
  const [copied, setCopied] = useState(false);
  const [failureCount, setFailureCount] = useState(0);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  const {
    digitsA: satsDigits,
    digitsB: fiatDigits,
    setDigitsA: setSatsDigits,
    setDigitsB: setFiatDigits,
    setInputMode,
    toggle: toggleInputMode,
    isModeA: isSatsMode,
  } = useCurrencyToggle({
    modeA: "sats" as InputMode,
    modeB: "fiat" as InputMode,
    initialMode: "sats",
    initialDigitsA: "",
    initialDigitsB: "",
    visible,
  });

  // Reset sheet state every time it (re)opens.
  useEffect(() => {
    if (!visible) {
      return;
    }
    setState({ kind: "entering" });
    setSecondsLeft(0);
    setCopied(false);
  }, [visible]);

  // The fiat side is typed in the display currency, so it is priced in it too;
  // a switch drops the old price rather than dividing by a rate in the other.
  useEffect(() => {
    if (!visible) return;
    let mounted = true;
    setFiatPerBtc(null);
    void (async () => {
      try {
        const snapshot = await btcSpotPriceService.getFresh(fiatSymbol);
        if (mounted && snapshot.valid && snapshot.price !== null && snapshot.price > 0) {
          setFiatPerBtc(snapshot.price);
        }
      } catch {}
    })();
    return () => {
      mounted = false;
    };
  }, [visible, fiatSymbol]);

  // Tick the countdown once per second while a ready invoice is showing.
  useEffect(() => {
    if (state.kind !== "ready") return;
    const tick = () => {
      const remaining = Math.max(0, Math.floor((state.expiresAtMs - Date.now()) / 1000));
      setSecondsLeft(remaining);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [state]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  useLiveBtcPrice(visible, fiatSymbol, satsDigits, fiatDigits, setFiatPerBtc);

  const handleSatsChange = useCallback(
    (text: string) => {
      setSatsDigits(sanitizeDigits(text));
      setFailureCount(0);
    },
    [setSatsDigits],
  );

  const handleFiatChange = useCallback(
    (text: string) => {
      setFiatDigits(sanitizeFiatDigits(text));
      setFailureCount(0);
    },
    [setFiatDigits],
  );

  // Keypad → the mode-specific sanitizing handlers.
  const { handleDigit, handleDecimal, handleDelete } = useKeypadEntry({
    isModeA: isSatsMode,
    digitsA: satsDigits,
    digitsB: fiatDigits,
    onChangeA: handleSatsChange,
    onChangeB: handleFiatChange,
  });

  const currentSats = useMemo(() => {
    return satsFromAmountEntry(isSatsMode, satsDigits, fiatDigits, fiatPerBtc);
  }, [isSatsMode, satsDigits, fiatDigits, fiatPerBtc]);

  // Same figures and images as the Bitcoin send screen (AmountDisplay).
  const primaryAmount = isSatsMode ? groupCount(currentSats) : fiatDigits || "0";
  const secondaryAmount = useMemo(
    () => bitcoinSecondaryAmount(isSatsMode, currentSats, fiatPerBtc),
    [isSatsMode, currentSats, fiatPerBtc],
  );
  const fiatImage = fiatImageFor(fiatSymbol);
  const primaryImage = isSatsMode ? BTC_LOGO : fiatImage;
  const secondaryImage = isSatsMode ? fiatImage : BTC_LOGO;

  const parsedAmount =
    Number.isFinite(currentSats) && currentSats > 0 ? Math.trunc(currentSats) : 0;

  // The corridor refuses amounts outside its range, and the payer's wallet only
  // ever sees an opaque HTTP 400. Say so here, before an unpayable invoice is
  // handed out. An untouched field is not an error, so only a typed amount is
  // judged.
  const amountProblem = parsedAmount > 0 ? checkReceiveAmountSats(parsedAmount) : null;
  const amountProblemText =
    amountProblem === "below_min"
      ? t("screen.LightningInvoiceSheet.amountBelowMin", {
          sats: groupCount(ARKADE_RECEIVE_MIN_SATS),
        })
      : amountProblem === "above_max"
        ? t("screen.LightningInvoiceSheet.amountAboveMax", {
            sats: groupCount(ARKADE_RECEIVE_MAX_SATS),
          })
        : "";

  const handleAmountToggle = useCallback(() => {
    setFailureCount(0);
    toggleInputMode();
  }, [toggleInputMode]);

  const submitAmount = useCallback(async () => {
    if (inFlightRef.current) return;
    if (parsedAmount <= 0) return;
    // Belt and braces: the button is disabled, but the corridor's bounds are
    // the reason an invoice would be unpayable, so nothing gets past them.
    if (checkReceiveAmountSats(parsedAmount) !== null) return;
    inFlightRef.current = true;
    setState({ kind: "creating" });
    try {
      const result = await onCreateInvoice(parsedAmount);
      const invoice = String(result?.invoice || "").trim();
      const expiresAtMs = Number(result?.expiresAtMs || 0);
      if (!invoice) throw new Error("empty invoice");
      const ttl = expiresAtMs > Date.now() ? expiresAtMs : Date.now() + 10 * 60 * 1000;
      setFailureCount(0);
      setState({ kind: "ready", invoice, expiresAtMs: ttl, amountSats: parsedAmount });
    } catch (error: unknown) {
      setFailureCount((n) => n + 1);
      console.warn(
        "[LightningInvoiceSheet] create invoice failed:",
        error instanceof Error ? error.message : String(error),
      );
      setState({ kind: "error" });
    } finally {
      inFlightRef.current = false;
    }
  }, [onCreateInvoice, parsedAmount]);

  const handleCopyInvoice = useCallback(async () => {
    if (state.kind !== "ready") return;
    if (await copyToClipboard(state.invoice)) {
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
    }
  }, [state]);

  const handleShareInvoice = useCallback(async () => {
    if (state.kind !== "ready") return;
    try {
      await Share.share({ message: state.invoice });
    } catch {}
  }, [state]);

  const handleReset = useCallback(() => {
    setInputMode("sats");
    setSatsDigits("");
    setFiatDigits("");
    setState({ kind: "entering" });
    setSecondsLeft(0);
    setFailureCount(0);
  }, [setFiatDigits, setInputMode, setSatsDigits]);

  const isExpired = state.kind === "ready" && secondsLeft <= 0;

  const renderEntering = () => (
    <>
      <View variant="soft" radius="md" paddingX="lg" paddingY="md" align="stretch">
        <Text size="sm" mono muted flow="truncate" lines={1}>
          {lightningAddress ?? ""}
        </Text>
      </View>

      <AmountDisplay
        primaryAmount={primaryAmount}
        primaryImage={primaryImage}
        primaryUnit={isSatsMode ? SATS_UNIT : fiatSymbol}
        secondary={{
          amount: secondaryAmount,
          image: secondaryImage,
          unit: isSatsMode ? fiatSymbol : SATS_UNIT,
        }}
        onToggle={handleAmountToggle}
        message={amountProblemText ? { text: amountProblemText, tone: "alert" } : null}
      />

      <AmountKeypad
        compact={keypadFit.compact}
        onDigit={handleDigit}
        onDecimal={isSatsMode ? undefined : handleDecimal}
        onDelete={handleDelete}
      />
    </>
  );

  const renderCreating = () => (
    <View direction="column" align="center" justify="center" gap="sm" fill="grow">
      <Text size="md" muted align="center">
        {t("screen.LightningInvoiceSheet.creating")}
      </Text>
    </View>
  );

  const renderReady = (ready: Extract<SheetState, { kind: "ready" }>) => {
    // The invoice's fixed amount, shown the way the entry screen shows it.
    const readySats = Math.max(0, Math.trunc(ready.amountSats));

    return (
      <>
        <View direction="row" align="center" gap="sm">
          <View
            variant="soft"
            radius="md"
            paddingX="lg"
            paddingY="md"
            direction="column"
            align="stretch"
            gap="xs"
            fill="grow-shrink"
          >
            <Text size="sm" muted>
              {t("screen.LightningInvoiceSheet.invoiceLabel")}
            </Text>
            <Text size="sm" mono flow="truncate" lines={1}>
              {ready.invoice}
            </Text>
          </View>
          <IconButton
            icon={copied ? "check-circle" : "copy"}
            variant="soft"
            accessibilityLabel={t("common.copy")}
            onPress={() => void handleCopyInvoice()}
          />
        </View>

        <View direction="column" align="stretch" justify="center" gap="md" fill="grow">
          {/* The amount block under the QR is the entry screen's, so the tile
              leaves it room: on an iPhone SE the default share hid it under
              the Share button. */}
          <AddressQrTile value={ready.invoice} maxHeightShare={0.28}>
            {/* The button is always the last thing on the sheet, so the expiry
                sits with the invoice it describes. */}
            <Text size="sm" muted align="center">
              {t("screen.LightningInvoiceSheet.expiresShort")}
            </Text>
          </AddressQrTile>
          <AmountDisplay
            fill={false}
            primaryAmount={groupCount(readySats)}
            primaryImage={BTC_LOGO}
            primaryUnit={SATS_UNIT}
            secondary={{
              amount: bitcoinSecondaryAmount(true, readySats, fiatPerBtc),
              image: fiatImageFor(fiatSymbol),
              unit: fiatSymbol,
            }}
          />
        </View>
      </>
    );
  };

  const renderError = () => {
    const persistent = failureCount >= 2;
    return (
      <View direction="column" align="stretch" justify="center" gap="sm" fill="grow">
        <Text size="md" emphasis align="center">
          {t("screen.LightningInvoiceSheet.error")}
        </Text>
        <Text size="md" muted align="center">
          {t(
            persistent
              ? "screen.LightningInvoiceSheet.errorPersistentBody"
              : "screen.LightningInvoiceSheet.errorBody",
          )}
        </Text>
        {persistent && onOpenSupportChat ? (
          <View direction="column" align="stretch" paddingTop="md">
            <Button size="lg" variant="soft" onPress={onOpenSupportChat}>
              <ButtonText>{t("common.contactSupport")}</ButtonText>
            </Button>
          </View>
        ) : null}
      </View>
    );
  };

  const renderBody = () => {
    switch (state.kind) {
      case "entering":
        return renderEntering();
      case "creating":
        return renderCreating();
      case "ready":
        return renderReady(state);
      case "error":
        return renderError();
    }
  };

  const renderFooter = () => {
    switch (state.kind) {
      case "entering":
        return (
          <Button
            size="lg"
            variant="solid"
            accent="lilac"
            disabled={parsedAmount <= 0 || amountProblem !== null}
            onPress={() => {
              void submitAmount();
            }}
          >
            <ButtonText>{t("screen.LightningInvoiceSheet.create")}</ButtonText>
          </Button>
        );
      case "creating":
        return (
          <Button size="lg" variant="solid" accent="lilac" disabled onPress={() => {}}>
            <ButtonText>{t("screen.LightningInvoiceSheet.creating")}</ButtonText>
          </Button>
        );
      case "ready":
        return isExpired ? (
          <Button size="lg" variant="solid" accent="lilac" onPress={handleReset}>
            <ButtonText>{t("screen.LightningInvoiceSheet.tryAgain")}</ButtonText>
          </Button>
        ) : (
          <Button
            size="lg"
            variant="solid"
            accent="lilac"
            onPress={() => void handleShareInvoice()}
          >
            <ButtonText>{t("common.share")}</ButtonText>
          </Button>
        );
      case "error":
        return (
          <Button size="lg" variant="solid" accent="lilac" onPress={handleReset}>
            <ButtonText>{t("screen.LightningInvoiceSheet.tryAgain")}</ButtonText>
          </Button>
        );
    }
  };

  return (
    <DsSheetHost visible={visible} onClose={onClose} mode="full">
      <Header safeAreaTop chrome="canvas">
        <Topbar surface="transparent" layout="fluid">
          <TopbarTitle>{t("screen.LightningInvoiceSheet.title")}</TopbarTitle>
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
          // The send screen's spacing, so the two amount screens line up and the
          // keypad fits an iPhone SE.
          gap={state.kind === "entering" ? "sm" : "lg"}
          paddingX="lg"
          paddingTop="lg"
          // Only the keypad screen trades bottom room for fitting; the created
          // invoice keeps the full gap above its button.
          paddingBottom={state.kind === "entering" && keypadFit.compact ? "sm" : "lg"}
          fill="grow"
        >
          {renderBody()}
        </View>
      </Scroll>

      <Footer safeAreaBottom direction="column" align="stretch" paddingBottom="sm" paddingX="lg">
        {renderFooter()}
      </Footer>
    </DsSheetHost>
  );
};

export default LightningInvoiceSheet;
