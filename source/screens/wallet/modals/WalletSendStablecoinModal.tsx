// @screen wallet.send
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Keyboard } from "react-native";
import * as Clipboard from "expo-clipboard";

import {
  Button,
  ButtonText,
  Footer,
  Header,
  IconButton,
  Scroll,
  Text,
  TextField,
  TextFieldButton,
  TextFieldLabel,
  Topbar,
  TopbarTitle,
  TopbarTrailing,
  View,
} from "@ds";

import AmountDisplay, { EUR_FLAG, USD_FLAG } from "../../../components/AmountDisplay";
import AmountKeypad from "../../../components/AmountKeypad";
import { useKeypadFit } from "../../../lib/useKeypadFit";
import DsSheetHost from "../../../components/DsSheetHost";
import { BASE_EURC } from "../../../config/network";
import { STABLECOIN_MIN_SEND_AMOUNT } from "../../../config/constants";
import { t } from "../../../lib/i18n";
import { isEnsName, resolveEnsName } from "../../../lib/qr/resolveEns";
import { toNuriUsername } from "../../../lib/pay/nuriUsername";
import { resolvePayRecipient } from "../../../lib/pay/resolvePayRecipient";
import { createRecipientLookupGate } from "../../../lib/pay/recipientLookupGate";
import { isValidEvmAddress } from "../../../lib/validation";
import { scannedAmountPrefill } from "../../../lib/amounts";
import { useFiatAmountInput } from "../../../lib/useFiatAmountInput";
import { sendTokenOnBase } from "../../../services/base/BaseTokenTransferService";
import { EventBus } from "../../../services/events/AppEventBusService";
import { sendEuroToCard } from "../../../services/wallet/CardTransferService";
import { startCardTopUpInFlight, startSendInFlight } from "../../../services/money/announce";

import type { WalletSendStablecoinProps } from "../../../types/wallet";
import AddressBookSuggestions, {
  useAddressBookContacts,
} from "../../../components/AddressBookSuggestions";
import { recipientWithName, savedContactFor } from "../../../lib/addressBook/contact";
import { acceptsWalletSend } from "../../addressBook/addressBookModel";
import { startMovePill } from "../../../services/wallet/CardTransferPill";
import { reportErrorToSupport } from "../../../lib/support/reportErrorToSupport";

type Props = WalletSendStablecoinProps;

const WalletSendStablecoinModal: React.FC<Props> = ({
  visible,
  onClose,
  prefilledAddress,
  prefilledAmount,
  maxStablecoinAvailable,
  toCard = false,
  token,
  onSuccess,
}) => {
  const {
    amount,
    setAmount,
    handleChangeText,
    parsedAmount,
    exceedsBalance,
    isBelowMinimum,
    availableDisplay,
  } = useFiatAmountInput({
    maxAmount: maxStablecoinAvailable,
    minAmount: STABLECOIN_MIN_SEND_AMOUNT,
  });
  const [isRequesting, setIsRequesting] = useState(false);
  // A short screen compacts the keypad before it scrolls.
  const keypadFit = useKeypadFit();
  // A failed transfer used to only reach console.warn: the spinner stopped and
  // the user was left unable to tell "sent", "failed" and "still going" apart
  // (issue #893). On a money screen that silence is the worst of the three.
  // The failure is carried by the CTA alone — the raw error (an RPC rejection,
  // a revert string) is diagnostics, not something a user can act on.
  const [sendFailed, setSendFailed] = useState(false);
  // Opened without an address (the scanner's "enter address" path), this sheet
  // starts on its own recipient step — the same shape the Bitcoin send has:
  // "Who are you sending to?", one field with Paste, then the amount. A scanned
  // address and a card top-up skip it, they already know the recipient.
  const [manualRecipient, setManualRecipient] = useState("");
  const [recipientConfirmed, setRecipientConfirmed] = useState(false);
  // An ENS name typed here resolves on Next, the same way the scanner resolves
  // one it reads. `resolvedRecipient` holds the 0x it mapped to, so the send
  // uses the address while the field keeps showing what the user typed.
  const [resolvedRecipient, setResolvedRecipient] = useState<string | null>(null);
  const [resolvingRecipient, setResolvingRecipient] = useState(false);
  const [recipientUnresolvable, setRecipientUnresolvable] = useState(false);
  // The lookup itself failed (directory/RPC unreachable) — retryable, and not
  // the same as "no such name".
  const [recipientLookupFailed, setRecipientLookupFailed] = useState(false);
  const lookupGate = useRef(createRecipientLookupGate());
  const recipientFieldRef = useRef<React.ComponentRef<typeof TextField>>(null);
  const typedRecipient = manualRecipient.trim();
  // What the field holds right now, for a lookup that lands long after it began.
  const typedRecipientRef = useRef(typedRecipient);
  typedRecipientRef.current = typedRecipient;
  const recipient = (prefilledAddress || resolvedRecipient || typedRecipient).trim();
  const manualEntry = !prefilledAddress && !toCard;
  const onRecipientStep = manualEntry && !recipientConfirmed;
  // Exact scanned amount (full token precision). The input DISPLAYS at most
  // 2 decimals, but this exact string is what gets sent — display-capped,
  // never rounded or truncated in the background. Cleared the moment the
  // user edits the field: a manual entry is its own intent.
  const [exactScannedAmount, setExactScannedAmount] = useState<string | null>(null);
  const amountEditable = !isRequesting;
  // The scan keeps full precision, so it can top the balance by less than the
  // 2-decimal display shows (scanned 1.004, held 1.00). Checked on the exact
  // string so the CTA blocks there too.
  const scannedExceedsBalance =
    exactScannedAmount != null &&
    maxStablecoinAvailable != null &&
    Number(exactScannedAmount) > maxStablecoinAvailable;
  const overBalance = exceedsBalance || scannedExceedsBalance;

  // Reset the amount once on open, pre-filling if provided. Must NOT depend on
  // amountEditable: the CTA toggles isRequesting (=> amountEditable), which would
  // re-fire this and blank the field mid-transfer.
  useEffect(() => {
    // Opening or closing the sheet abandons any lookup still in flight.
    lookupGate.current.invalidate();
    if (!visible) return;
    // A failure belongs to the attempt that produced it — reopening the sheet
    // must not greet the user with a stale "Try again".
    setSendFailed(false);
    setManualRecipient("");
    setRecipientConfirmed(false);
    setResolvedRecipient(null);
    setResolvingRecipient(false);
    setRecipientUnresolvable(false);
    setRecipientLookupFailed(false);
    // A scanned amount is always kept, even above the balance (#1486): the
    // field shows what the QR asked for and the CTA stays blocked with the
    // "exceeds balance" hint, instead of silently emptying the field.
    const prefill = scannedAmountPrefill(prefilledAmount);
    setExactScannedAmount(prefill.exact);
    setAmount(prefill.display);
    // No balance dependency: the prefill no longer depends on it, and a balance
    // refresh must not reset the recipient or an amount the user edited.
  }, [visible, prefilledAmount, setAmount]);

  const validAddress = useMemo(() => isValidEvmAddress(recipient), [recipient]);
  const acceptsSavedDestination = useMemo(
    () => acceptsWalletSend(token?.code === "USD" ? "USDC" : "EURC"),
    [token?.code],
  );
  // A recipient that is a saved contact shows by name (picked, scanned or pasted).
  const savedContacts = useAddressBookContacts(visible && !toCard);
  const savedRecipient = useMemo(
    () => savedContactFor(savedContacts, recipient, acceptsSavedDestination),
    [savedContacts, recipient, acceptsSavedDestination],
  );

  // A manual keypad edit is its own intent — it drops the exact scan string.
  const handleDigit = (digit: string) => {
    if (!amountEditable) return;
    setExactScannedAmount(null);
    handleChangeText(amount + digit);
  };
  const handleDecimal = () => {
    if (!amountEditable) return;
    setExactScannedAmount(null);
    handleChangeText(`${amount}.`);
  };
  const handleDelete = () => {
    if (!amountEditable) return;
    setExactScannedAmount(null);
    handleChangeText(amount.slice(0, -1));
  };

  const handleSend = async () => {
    const addr = recipient.trim();
    if (!addr) {
      console.log("[WalletSendStablecoinModal] Address missing");
      return;
    }
    if (!validAddress) {
      console.log("[WalletSendStablecoinModal] Invalid recipient address");
      return;
    }
    if (parsedAmount <= 0) {
      console.log("[WalletSendStablecoinModal] Invalid amount");
      return;
    }
    if (isBelowMinimum) {
      console.log("[WalletSendStablecoinModal] Amount below minimum");
      return;
    }
    if (scannedExceedsBalance) {
      console.log("[WalletSendStablecoinModal] Exact scanned amount exceeds balance");
      return;
    }
    if (exceedsBalance) {
      console.log("[WalletSendStablecoinModal] Amount exceeds available balance");
      return;
    }

    setIsRequesting(true);
    setSendFailed(false);
    try {
      Keyboard.dismiss();
    } catch {}
    try {
      // The exact scan string (full precision) wins over the displayed,
      // 2-decimal-capped field; manual input is used as typed. parseUnits gets
      // the string untouched (trailing dot stripped).
      const sendAmount = (exactScannedAmount ?? amount).replace(/\.$/, "");
      // Euro → card is one move with one implementation, wherever it starts:
      // the service owns the transfer AND the events it raises, so this screen
      // only reports the outcome.
      const euroToCard = toCard && !token;
      const { hash: txHash, confirmed } = euroToCard
        ? await sendEuroToCard(sendAmount).then((r) => ({
            hash: r.txHash,
            confirmed: r.confirmed,
          }))
        : await sendTokenOnBase({
            toAddress: addr as `0x${string}`,
            amount: sendAmount,
            tokenAddress: token?.address ?? BASE_EURC.address,
            tokenDecimals: token?.decimals ?? BASE_EURC.decimals,
            // A card top-up does not wait for the receipt: it is a move between
            // the user's own two balances, so once the transfer is broadcast
            // without an error the sheet closes and both balances move
            // optimistically. A send to someone else still waits, because its
            // success screen has to be true.
            awaitReceipt: !toCard,
          });

      // Guarded on the branch above: the euro → card service raises these for
      // itself, and emitting them twice files the transfer twice.
      if (!euroToCard && !confirmed) {
        const fiat = token?.code === "USD" ? ("USD" as const) : ("EUR" as const);
        void (
          toCard
            ? startCardTopUpInFlight({ id: txHash, amount: parsedAmount, fiat })
            : startSendInFlight({
                id: txHash,
                rail: fiat === "USD" ? "dollar" : "wallet",
                amount: parsedAmount,
              })
        ).catch(() => {});
      }
      if (!euroToCard) {
        if (confirmed) {
          try {
            EventBus.emit("wallet:refresh");
            setTimeout(() => EventBus.emit("wallet:refresh"), 4000);
            EventBus.emit("transactions:refresh");
            setTimeout(() => EventBus.emit("transactions:refresh"), 4000);
          } catch {}
        } else {
          try {
            EventBus.emit("wallet:pendingTransfer", {
              amountFiat: parsedAmount,
              // Which of the two balances at this address paid. Without it a
              // dollar send was listed on the euro rail, as euros.
              fiat: token?.code === "USD" ? "USD" : "EUR",
              txHash,
              to: addr,
              source: "base-mainnet",
              createdAt: new Date().toISOString(),
            });
          } catch {}
        }
      }

      // A send to someone else is reported by the status pill: Completed when
      // it confirmed, else Processing until its receipt, then Completed or
      // failed. A card top-up keeps its own reporting.
      if (!toCard) startMovePill().settleByRows(confirmed ? null : txHash);
      try {
        onSuccess?.({
          amount: parsedAmount,
          txHash,
          confirmed,
        });
      } catch {}
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to submit EUR transfer";
      console.warn("[WalletSendStablecoinModal] Transfer error:", msg);
      setSendFailed(true);
      void reportErrorToSupport({
        error: err,
        userMessage: toCard ? "Card top-up transfer failed" : "EUR transfer failed",
      }).catch(() => {});
    } finally {
      setIsRequesting(false);
    }
  };

  const confirmRecipient = async () => {
    if (validAddress) {
      setRecipientConfirmed(true);
      return;
    }
    // `lennard`, `lennard.nuri.eth` and `lennard@nuri.com` are one Nuri user:
    // read their EVM address from the Nuri directory. Any other `.eth` name is
    // an ordinary ENS lookup.
    const nuriUsername = toNuriUsername(typedRecipient);
    if (!nuriUsername && !isEnsName(typedRecipient)) return;
    const submitted = typedRecipient;
    const ticket = lookupGate.current.begin(submitted);
    // Apply nothing unless this is still the lookup for what is on screen.
    const stillCurrent = () => lookupGate.current.isCurrent(ticket, typedRecipientRef.current);
    setResolvingRecipient(true);
    setRecipientUnresolvable(false);
    setRecipientLookupFailed(false);
    try {
      const address = nuriUsername
        ? ((await resolvePayRecipient(nuriUsername))?.evmAddress ?? null)
        : await resolveEnsName(submitted);
      if (!stillCurrent()) return;
      if (!address || !isValidEvmAddress(address)) {
        setRecipientUnresolvable(true);
        return;
      }
      setResolvedRecipient(address);
      setRecipientConfirmed(true);
    } catch {
      // The directory or RPC could not be reached: that says nothing about
      // whether the user exists, so it must not read as "no such name".
      if (stillCurrent()) setRecipientLookupFailed(true);
    } finally {
      if (stillCurrent()) setResolvingRecipient(false);
    }
  };

  // Any edit to the recipient abandons a lookup still in flight for the old one.
  const resetRecipientLookup = () => {
    lookupGate.current.invalidate();
    setResolvedRecipient(null);
    setResolvingRecipient(false);
    setRecipientUnresolvable(false);
    setRecipientLookupFailed(false);
  };

  const handlePasteRecipient = async () => {
    // Invalidate before awaiting the clipboard: a lookup landing during that
    // wait must not advance the sheet for the recipient being replaced.
    lookupGate.current.invalidate();
    setResolvingRecipient(false);
    try {
      const clip = (await Clipboard.getStringAsync()).trim();
      if (clip) {
        setManualRecipient(clip);
        resetRecipientLookup();
      }
    } catch {
      // Clipboard refused (permission, empty) — the field stays typable.
    }
  };

  // An ENS name or a Nuri username is a legitimate recipient here: Next
  // resolves it. Only a value that is none of those blocks the step.
  const recipientEntryUsable =
    validAddress || isEnsName(typedRecipient) || toNuriUsername(typedRecipient) !== null;

  const isCtaDisabled = onRecipientStep
    ? !recipientEntryUsable || resolvingRecipient
    : isRequesting || !validAddress || parsedAmount <= 0 || overBalance || isBelowMinimum;

  // The token decides the code: a USDC send must not render "EUR". No token is
  // the euro send (BASE_EURC), stated in the currency it moves — never the
  // display currency.
  const currencySymbol = token?.symbol ?? "EUR";
  const assetLabel = token?.code === "USD" ? "USDC Base" : "EURC Base";
  const availableAmountLabel = availableDisplay == null ? null : availableDisplay.toFixed(2);
  const headerTitle = availableAmountLabel
    ? t("screen.WalletSendStablecoinModal.headlineWithBalance", {
        asset: assetLabel,
        amount: availableAmountLabel,
      })
    : t("screen.WalletSendStablecoinModal.headline", { asset: assetLabel });

  // No below-minimum hint here: the CTA label carries the exact same
  // "Minimum €X" text (minimumLabel) whenever that state is active.
  const recipientHint = recipientLookupFailed
    ? t("screen.WalletSendStablecoinModal.lookupFailed")
    : recipientUnresolvable
      ? t("screen.WalletSendStablecoinModal.ensNotFound")
      : typedRecipient.length > 0 && !recipientEntryUsable
        ? t("screen.WalletSendStablecoinModal.invalidAddressError")
        : null;

  // Amount-step only. The recipient step has its own hint (recipientHint) and
  // owns the address message — carrying it here too printed it twice.
  const amountHint = overBalance
    ? t("screen.WalletSendStablecoinModal.exceedsBalanceHint")
    : !onRecipientStep && recipient.length > 0 && !validAddress
      ? t("screen.WalletSendStablecoinModal.invalidAddressError")
      : null;

  // A failed attempt only relabels the CTA: still the same button, still the
  // same tap, so retrying costs the user nothing to figure out.
  const ctaLabel = onRecipientStep
    ? resolvingRecipient
      ? t("screen.WalletSendStablecoinModal.loadingLabel")
      : t("screen.WalletSendStablecoinModal.ctaNext")
    : isRequesting
      ? t("screen.WalletSendStablecoinModal.loadingLabel")
      : isBelowMinimum && parsedAmount > 0
        ? t("screen.WalletSendStablecoinModal.minimumLabel", {
            symbol: currencySymbol,
            amount: STABLECOIN_MIN_SEND_AMOUNT,
          })
        : sendFailed
          ? t("screen.WalletSendStablecoinModal.tryAgainLabel")
          : t("screen.WalletSendStablecoinModal.sendLabel");

  // The failure state is carried by the label alone, so the accessible name has
  // to carry it too — otherwise assistive tech announces "Send EUR" on a button
  // that is really a retry.
  const ctaA11yLabel = onRecipientStep
    ? t("screen.WalletSendStablecoinModal.ctaNext")
    : sendFailed && !isRequesting
      ? t("screen.WalletSendStablecoinModal.tryAgainLabel")
      : t("screen.WalletSendStablecoinModal.sendA11yLabel", { symbol: token?.code ?? "EUR" });

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
          <View direction="column" align="stretch" justify="start" gap="sm">
            {/* Card top-up hides the AA address — internal detail, not a recipient the
                user picked. A scanned wallet address stays visible for verification. */}
            {toCard ? null : onRecipientStep ? (
              <TextField
                ref={recipientFieldRef}
                value={manualRecipient}
                onChangeText={(next) => {
                  setManualRecipient(next);
                  resetRecipientLookup();
                }}
                autoCapitalize="none"
                accessibilityLabel={t("screen.WalletSendStablecoinModal.recipientLabel")}
              >
                <TextFieldLabel>
                  {t("screen.WalletSendStablecoinModal.recipientLabel")}
                </TextFieldLabel>
                <TextFieldButton
                  accessibilityLabel={t("common.paste")}
                  onPress={() => void handlePasteRecipient()}
                >
                  {t("common.paste")}
                </TextFieldButton>
              </TextField>
            ) : (
              <View variant="soft" radius="md" paddingX="lg" paddingY="md" align="stretch">
                <Text size="sm" mono muted flow="truncate" lines={1}>
                  {savedRecipient
                    ? recipientWithName(savedRecipient.label, recipient)
                    : resolvedRecipient && typedRecipient
                      ? `${typedRecipient} (${resolvedRecipient.slice(0, 6)}…${resolvedRecipient.slice(-4)})`
                      : recipient}
                </Text>
              </View>
            )}
            {/* Saved recipients matching what is typed; nothing when none match. */}
            <AddressBookSuggestions
              active={visible && onRecipientStep && !toCard}
              query={manualRecipient}
              accepts={acceptsSavedDestination}
              onPick={({ destination }) => {
                setManualRecipient(destination.raw);
                resetRecipientLookup();
              }}
            />
          </View>

          {onRecipientStep ? (
            <View direction="column" align="center" justify="center" gap="sm" fill="grow">
              {recipientHint ? (
                <Text size="md" muted align="center">
                  {recipientHint}
                </Text>
              ) : null}
            </View>
          ) : (
            <AmountDisplay
              primaryAmount={amount || "0"}
              primaryImage={token?.code === "USD" ? USD_FLAG : EUR_FLAG}
              primaryUnit={token?.code === "USD" ? "USDC" : "EURC"}
              message={amountHint ? { text: amountHint, tone: "info" } : null}
            />
          )}

          <View direction="column" align="stretch" justify="end" gap="lg">
            {onRecipientStep ? null : (
              <AmountKeypad
                compact={keypadFit.compact}
                onDigit={handleDigit}
                onDecimal={handleDecimal}
                onDelete={handleDelete}
              />
            )}
          </View>
        </View>
      </Scroll>

      <Footer
        safeAreaBottom
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
          disabled={isCtaDisabled}
          onPress={() => {
            if (onRecipientStep) {
              Keyboard.dismiss();
              void confirmRecipient();
              return;
            }
            void handleSend();
          }}
          accessibilityLabel={ctaA11yLabel}
        >
          <ButtonText>{ctaLabel}</ButtonText>
        </Button>
      </Footer>
    </DsSheetHost>
  );
};

export default WalletSendStablecoinModal;
