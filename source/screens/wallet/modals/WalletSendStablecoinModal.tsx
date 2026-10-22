// @screen wallet.send
import React, { useEffect, useMemo, useState } from "react";
import { Keyboard, View as RNView, StyleSheet } from "react-native";

import {
  Button,
  ButtonText,
  Footer,
  Header,
  IconButton,
  NuriScope,
  Scroll,
  Text,
  Topbar,
  TopbarTitle,
  TopbarTrailing,
  View,
} from "@ds";

import { EUR_FLAG, USD_FLAG } from "../../../components/AmountDisplay";
import { groupCount } from "../../../lib/formatting";
import AmountKeypad from "../../../components/AmountKeypad";
import { useKeypadFit } from "../../../lib/useKeypadFit";
import DsSheetHost from "../../../components/DsSheetHost";
import SendFromRow from "../../../components/send/SendFromRow";
import { BASE_EURC } from "../../../config/network";
import { STABLECOIN_MIN_SEND_AMOUNT } from "../../../config/constants";
import { t } from "../../../lib/i18n";
import { evmDestination } from "../../../lib/addressBook/nuriContacts";
import { rememberNuriPayment } from "../../../services/addressBook/nuriContactSync";
import { isValidEvmAddress } from "../../../lib/validation";
import { scannedAmountPrefill } from "../../../lib/amounts";
import { useFiatAmountInput } from "../../../lib/useFiatAmountInput";
import { type BoundTzOffer, tzOfferFor } from "../../../lib/remit/tzOfferBinding";
import { sendTokenOnBase } from "../../../services/base/BaseTokenTransferService";
import { EventBus } from "../../../services/events/AppEventBusService";
import { sendEuroToCard } from "../../../services/wallet/CardTransferService";
import { startCardTopUpInFlight, startSendInFlight } from "../../../services/money/announce";

import type { WalletSendStablecoinProps } from "../../../types/wallet";
import { useAddressBookContacts } from "../../../components/AddressBookSuggestions";
import { savedContactFor } from "../../../lib/addressBook/contact";
import SendRecipientContact from "../../../components/SendRecipientContact";
import { acceptsWalletSend } from "../../addressBook/addressBookModel";
import { startMovePill } from "../../../services/wallet/CardTransferPill";
import { reportErrorToSupport } from "../../../lib/support/reportErrorToSupport";
import { TZ_METHODS, type ZapRemitDestination } from "../../../lib/remit/zapremitForm";
import {
  createTzOrder,
  quoteTzPayout,
  type TzStablePayment,
  tzPaymentLapsed,
} from "../../../services/remit/RemitService";

type Props = WalletSendStablecoinProps;

const WalletSendStablecoinModal: React.FC<Props> = ({
  visible,
  onClose,
  prefilledAddress,
  prefilledAmount,
  presetPayout,
  maxStablecoinAvailable,
  toCard = false,
  token,
  onSuccess,
  person,
  balanceOptions,
  balance,
  onPickBalance,
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
  // A failed transfer used to only reach console.warn: the spinner stopped and
  // the user was left unable to tell "sent", "failed" and "still going" apart
  // (issue #893). On a money screen that silence is the worst of the three.
  // The failure is carried by the CTA alone — the raw error (an RPC rejection,
  // a revert string) is diagnostics, not something a user can act on.
  const [sendFailed, setSendFailed] = useState(false);
  // A Tanzanian bank, Lipa Namba or TanQR paid from this balance: the amount
  // is typed in shillings, the order then states the exact stable amount and
  // the address, and a second press sends exactly that.
  const [payout, setPayout] = useState<ZapRemitDestination | null>(null);
  const [tzsDigits, setTzsDigits] = useState("");
  const [tzEstimate, setTzEstimate] = useState<number | null>(null);
  // The order's offer for the stable it was priced in; another balance paying
  // retires it (a new order is fetched), it is never relabelled.
  const [tzBound, setTzBound] = useState<BoundTzOffer | null>(null);
  const stableCode = token?.code === "USD" ? "USDC" : "EURC";
  const tzsAmount = Number(tzsDigits) || 0;
  const tzPayment = tzOfferFor(tzBound, stableCode);
  const tzMethod = payout ? TZ_METHODS.find((m) => m.code === payout.methodCode) : undefined;
  const tzOutOfBand =
    !!tzMethod && tzsAmount > 0 && (tzsAmount < tzMethod.min || tzsAmount > tzMethod.max);
  const tzStableAmount = tzPayment ? Number(tzPayment.amount) : tzEstimate;
  const tzOverBalance =
    tzStableAmount != null &&
    maxStablecoinAvailable != null &&
    tzStableAmount > maxStablecoinAvailable;
  // Every send reaches this screen with its recipient decided (the recipient
  // sheet, a scan, a contact, Send again) or as a card top-up.
  const recipient = (prefilledAddress ?? "").trim();
  // A short screen compacts the keypad before it scrolls.
  const keypadFit = useKeypadFit();
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
    if (!visible) return;
    // A failure belongs to the attempt that produced it — reopening the sheet
    // must not greet the user with a stale "Try again".
    setSendFailed(false);
    // A scanned TanQR opens straight on the shilling amount for that merchant.
    setPayout(presetPayout ?? null);
    setTzsDigits("");
    setTzEstimate(null);
    setTzBound(null);
    // A scanned amount is always kept, even above the balance (#1486): the
    // field shows what the QR asked for and the CTA stays blocked with the
    // "exceeds balance" hint, instead of silently emptying the field.
    const prefill = scannedAmountPrefill(prefilledAmount);
    setExactScannedAmount(prefill.exact);
    setAmount(prefill.display);
    // No balance dependency: the prefill no longer depends on it, and a balance
    // refresh must not reset the recipient or an amount the user edited.
  }, [visible, prefilledAmount, presetPayout, setAmount]);

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

  // The shown price for the typed shillings; the order states the real one.
  useEffect(() => {
    if (!payout || tzsAmount <= 0 || tzOutOfBand) {
      setTzEstimate(null);
      return;
    }
    let live = true;
    const handle = setTimeout(() => {
      quoteTzPayout(tzsAmount)
        .then((p) => live && setTzEstimate(stableCode === "USDC" ? p.usdc : p.eurc))
        .catch(() => live && setTzEstimate(null));
    }, 400);
    return () => {
      live = false;
      clearTimeout(handle);
    };
  }, [payout, tzsAmount, tzOutOfBand, stableCode]);

  // Any edit to the shillings drops an order already priced for the old amount.
  const editTzs = (next: string) => {
    if (isRequesting) return;
    setTzBound(null);
    setSendFailed(false);
    setTzsDigits(next.replace(/^0+/, "").slice(0, 9));
  };

  // First press: the order, which states the exact amount and address. Nothing
  // moves; an unpaid order lapses on its own.
  const handleTzOrder = async () => {
    if (!payout || tzsAmount <= 0 || tzOutOfBand) return;
    setIsRequesting(true);
    setSendFailed(false);
    try {
      const order = await createTzOrder(tzsAmount, payout.recipient);
      const offer = stableCode === "USDC" ? order.usdc : order.eurc;
      if (!offer) throw new Error(`no ${stableCode} offer`);
      setTzBound({ stable: stableCode, offer });
    } catch (err) {
      setSendFailed(true);
      void reportErrorToSupport({ error: err, userMessage: "Tanzania payout order failed" }).catch(
        () => {},
      );
    } finally {
      setIsRequesting(false);
    }
  };

  // A manual keypad edit is its own intent — it drops the exact scan string.
  const handleDigit = (digit: string) => {
    if (payout) return editTzs(tzsDigits + digit);
    if (!amountEditable) return;
    setExactScannedAmount(null);
    handleChangeText(amount + digit);
  };
  const handleDecimal = () => {
    if (payout || !amountEditable) return;
    setExactScannedAmount(null);
    handleChangeText(`${amount}.`);
  };
  const handleDelete = () => {
    if (payout) return editTzs(tzsDigits.slice(0, -1));
    if (!amountEditable) return;
    setExactScannedAmount(null);
    handleChangeText(amount.slice(0, -1));
  };

  const handleSend = async (exact?: TzStablePayment) => {
    const addr = (exact?.payTo ?? recipient).trim();
    if (exact) {
      if (tzOverBalance) return;
    } else if (!addr) {
      console.log("[WalletSendStablecoinModal] Address missing");
      return;
    }
    if (!exact && !validAddress) {
      console.log("[WalletSendStablecoinModal] Invalid recipient address");
      return;
    }
    if (!exact && parsedAmount <= 0) {
      console.log("[WalletSendStablecoinModal] Invalid amount");
      return;
    }
    if (!exact && isBelowMinimum) {
      console.log("[WalletSendStablecoinModal] Amount below minimum");
      return;
    }
    if (!exact && scannedExceedsBalance) {
      console.log("[WalletSendStablecoinModal] Exact scanned amount exceeds balance");
      return;
    }
    if (!exact && exceedsBalance) {
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
      // A payout order names its own amount, which must arrive exactly.
      const sendAmount = exact?.amount ?? (exactScannedAmount ?? amount).replace(/\.$/, "");
      const sentAmount = exact ? Number(exact.amount) : parsedAmount;
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
                amount: sentAmount,
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
              amountFiat: sentAmount,
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

      // Paid a Nuri user by username: they join the address book (#1770).
      const paidUsername = !exact && !toCard ? person?.nuriUsername : undefined;
      if (paidUsername) {
        void rememberNuriPayment(paidUsername, [evmDestination(addr)]).catch(() => {});
      }

      // A send to someone else is reported by the status pill: Completed when
      // it confirmed, else Processing until its receipt, then Completed or
      // failed. A card top-up keeps its own reporting.
      if (!toCard) startMovePill().settleByRows(confirmed ? null : txHash);
      try {
        onSuccess?.({
          amount: sentAmount,
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

  const isCtaDisabled = payout
    ? isRequesting || tzsAmount <= 0 || tzOutOfBand || tzOverBalance
    : isRequesting || !validAddress || parsedAmount <= 0 || overBalance || isBelowMinimum;

  // The token decides the code: a USDC send must not render "EUR". No token is
  // the euro send (BASE_EURC), stated in the currency it moves — never the
  // display currency. The title names the Cash balance the user picked
  // (Euro / Dollar), not the token or its network.
  const currencySymbol = token?.symbol ?? "EUR";
  const assetLabel = t(
    token?.code === "USD" ? "screen.HomeScreen.railDollar" : "screen.HomeScreen.railEuro",
  );
  const sourceFlag = token?.code === "USD" ? USD_FLAG : EUR_FLAG;
  const currencyGlyph = token?.code === "USD" ? "$" : "\u20ac";
  const onCardAmountStep = !toCard;
  const recipientPerson =
    person ??
    (savedRecipient
      ? { name: savedRecipient.label, nuriUsername: savedRecipient.nuriUsername }
      : null);
  const liftRecipient = onCardAmountStep && recipientPerson !== null;
  const closeButton = (
    <IconButton
      icon="cross"
      variant="soft"
      accessibilityLabel={t("common.close")}
      onPress={onClose}
    />
  );
  const availableAmountLabel = availableDisplay == null ? null : availableDisplay.toFixed(2);
  const headerTitle = availableAmountLabel
    ? t("screen.WalletSendStablecoinModal.headlineWithBalance", {
        asset: assetLabel,
        amount: availableAmountLabel,
      })
    : t("screen.WalletSendStablecoinModal.headline", { asset: assetLabel });

  // Amount-step only. The recipient step has its own hint (recipientHint) and
  // owns the address message — carrying it here too printed it twice.
  const tzHint = !payout
    ? null
    : tzOverBalance
      ? t("screen.WalletSendStablecoinModal.exceedsBalanceHint")
      : tzOutOfBand && tzMethod
        ? tzsAmount < tzMethod.min
          ? t("screen.BitcoinSendScreen.remitMinimum", { amount: `${tzMethod.min} TZS` })
          : t("screen.BitcoinSendScreen.remitMaximum", { amount: `${tzMethod.max} TZS` })
        : tzStableAmount != null
          ? `${tzPayment ? "" : "\u2248 "}${tzStableAmount.toFixed(2)} ${stableCode}`
          : null;
  const amountHint = overBalance
    ? t("screen.WalletSendStablecoinModal.exceedsBalanceHint")
    : recipient.length > 0 && !validAddress
      ? t("screen.WalletSendStablecoinModal.invalidAddressError")
      : null;

  // A failed attempt only relabels the CTA: still the same button, still the
  // same tap, so retrying costs the user nothing to figure out.
  const ctaLabel = payout
    ? isRequesting
      ? t("screen.WalletSendStablecoinModal.loadingLabel")
      : sendFailed
        ? t("screen.WalletSendStablecoinModal.tryAgainLabel")
        : tzPayment
          ? t("screen.BitcoinSendScreen.remitConfirmTo", { name: payout.summary })
          : t("component.PayoutAbroadSheet.continue")
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
  const ctaA11yLabel =
    sendFailed && !isRequesting
      ? t("screen.WalletSendStablecoinModal.tryAgainLabel")
      : t("screen.WalletSendStablecoinModal.sendA11yLabel", { symbol: token?.code ?? "EUR" });

  return (
    <>
      <DsSheetHost visible={visible} onClose={onClose} mode="full">
        {/* The amount card's "From" row already names the balance and what it
            holds, so the amount step has no title. A person recipient then
            takes the top row itself, beside the close button. */}
        {liftRecipient ? (
          <Header safeAreaTop chrome="canvas" />
        ) : (
          <Header safeAreaTop chrome="canvas">
            <Topbar surface="transparent" layout={onCardAmountStep ? "centered" : "fluid"}>
              {onCardAmountStep ? null : <TopbarTitle>{headerTitle}</TopbarTitle>}
              <TopbarTrailing>{closeButton}</TopbarTrailing>
            </Topbar>
          </Header>
        )}

        <Scroll onLayout={keypadFit.onViewportLayout}>
          <View
            onLayout={keypadFit.onContentLayout}
            direction="column"
            align="stretch"
            justify="between"
            gap="sm"
            paddingX="lg"
            {...(liftRecipient ? { paddingTop: "lg" as const } : {})}
            paddingBottom={keypadFit.compact ? "sm" : "lg"}
            fill="grow"
          >
            <View direction="column" align="stretch" justify="start" gap="sm">
              {/* Card top-up hides the AA address — internal detail, not a recipient the
                user picked. A scanned wallet address stays visible for verification. */}
              {toCard ? null : payout ? (
                <View variant="soft" radius="md" paddingX="lg" paddingY="md" align="stretch">
                  <Text size="sm" muted flow="truncate" lines={1}>
                    {payout.summary}
                  </Text>
                </View>
              ) : recipientPerson ? (
                <SendRecipientContact {...recipientPerson} />
              ) : (
                <View variant="soft" radius="md" paddingX="lg" paddingY="md" align="stretch">
                  <Text size="sm" mono muted flow="truncate" lines={1}>
                    {recipient}
                  </Text>
                </View>
              )}
              {/* Raw View: the close button pinned top-right over the lifted
                  recipient, which the DS has no slot for outside a Topbar. */}
              {liftRecipient ? (
                <RNView style={styles.closeOverRecipient}>{closeButton}</RNView>
              ) : null}
            </View>

            {
              // The Move sheet's card: which balance pays (a picker of every
              // balance that can pay this recipient) and the amount, in
              // shillings for a payout abroad.
              <View direction="column" align="stretch" gap="sm" fill="grow">
                <NuriScope mode="dark">
                  <View
                    chrome="subtle"
                    radius="lg"
                    paddingX="lg"
                    paddingY="md"
                    direction="column"
                    align="stretch"
                    fill="grow"
                  >
                    <SendFromRow
                      options={balanceOptions}
                      current={balance ?? (token?.code === "USD" ? "dollar" : "wallet")}
                      fallback={{
                        label:
                          availableDisplay == null
                            ? assetLabel
                            : `${assetLabel} (${availableDisplay.toFixed(2)})`,
                        image: sourceFlag,
                      }}
                      disabled={isRequesting}
                      onPick={onPickBalance}
                    />
                    <View fill="grow" justify="end" align="end">
                      <Text
                        size="3xl"
                        align="end"
                        // Spoken with its unit, as AmountDisplay does.
                        accessibilityLabel={
                          payout ? `${tzsDigits || "0"} TZS` : `${amount || "0"} ${stableCode}`
                        }
                      >
                        {payout
                          ? `TZS ${tzsDigits ? groupCount(Number(tzsDigits)) : "0"}`
                          : `${currencyGlyph} ${amount || "0.00"}`}
                      </Text>
                    </View>
                  </View>
                </NuriScope>
                <Text size="md" align="center" muted>
                  {(payout ? tzHint : amountHint) ?? "\u00a0"}
                </Text>
              </View>
            }

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
              if (payout) {
                // A lapsed order is never paid: a fresh one is fetched and its
                // amount shown again before anything moves.
                if (tzPayment && !tzPaymentLapsed(tzPayment.expiresAt)) void handleSend(tzPayment);
                else void handleTzOrder();
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
    </>
  );
};

const styles = StyleSheet.create({
  closeOverRecipient: { position: "absolute", top: 0, right: 0 },
});

export default WalletSendStablecoinModal;
