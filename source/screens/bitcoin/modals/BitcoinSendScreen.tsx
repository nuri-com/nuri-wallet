// @screen bitcoin.send
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Keyboard, Platform } from "react-native";
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
  Topbar,
  TopbarTitle,
  TopbarTrailing,
  View,
} from "@ds";
import type { TextFieldHandle } from "@ds";

import AddressBookSuggestions, {
  useAddressBookContacts,
} from "../../../components/AddressBookSuggestions";
import {
  type Destination,
  recipientWithName,
  savedContactFor,
} from "../../../lib/addressBook/contact";
import AmountKeypad from "../../../components/AmountKeypad";
import AmountDisplay, {
  BTC_LOGO,
  SATS_UNIT,
  bitcoinSecondaryAmount,
  fiatImageFor,
} from "../../../components/AmountDisplay";
import { useKeypadFit } from "../../../lib/useKeypadFit";
import { acceptsBitcoinSend, bitcoinSendCost } from "../../addressBook/addressBookModel";
import DsSheetHost from "../../../components/DsSheetHost";
import { btcSpotPriceService } from "../../../services/pricing/BtcSpotPriceService";
import { log } from "../../../services/logging/LoggerService";
import {
  ARKADE_BITCOIN_ONCHAIN_MIN_SEND_SATS,
  ARKADE_LIGHTNING_MAX_SEND_SATS,
  ARKADE_LIGHTNING_MIN_SEND_SATS,
  BITCOIN_LNURL_MIN_SEND_SATS,
} from "../../../config/constants";
import { EventBus } from "../../../services/events/AppEventBusService";
import { PendingBitcoinSendsStore } from "../../../services/bitcoin/PendingBitcoinSendsStore";
import {
  bitcoinBalanceStore,
  OUTGOING_ARKADE_SEND_HOLD_TTL_MS,
} from "../../../services/bitcoin/BitcoinBalanceStore";
import { isArkAddress, isValidBitcoinAddressMainnet } from "../../../lib/bitcoin/address";
import { parseBitcoinUri } from "../../../lib/bitcoin/uri";
import { sendBitcoin, type BitcoinSendTarget } from "../../../services/bitcoin/BitcoinSendService";
import {
  assertDirectArkadeSendCanStart,
  isDirectArkadeSendReconciliationRequiredError,
  sendDirectArkadeWithReconciliation,
} from "../../../services/bitcoin/DirectArkadeSendReconciliationService";
import {
  estimateOnchainSendFeeSats,
  sendBitcoinOnchainFromMusig2,
} from "../../../services/bitcoin/OnchainSendService";
import { errMsg as errMsgText } from "../../../lib/errorMessage";
import type {
  ArkadeLightningSendAuthenticatedPayload,
  ArkadeLightningSendSubmittedPayload,
} from "../../../services/arkade/ArkadeLightningSendService";
import {
  isArkadeLightningLockupMismatchError,
  prefetchArkadeLightningQuote,
} from "../../../services/arkade/ArkadeLightningSendService";
import { clearPrefetchedArkadeIntentsLightningQuote } from "../../../services/swapkit/SwapKitArkadeLightningSendService";
import { reportErrorToSupport } from "../../../lib/support/reportErrorToSupport";
import { isUserCancelledAuth } from "../../../lib/support/isUserCancelledAuth";
import { isArkadeMaxSendAmountError } from "../../../services/arkade/internal/maxSendAmount";
import { isArkadeVtxoTooFreshError } from "../../../services/arkade/internal/settlementExpiryGap";
import { getArkadeWalletSummary } from "../../../services/arkade/ArkadeWalletService";
import {
  getArkadeArkSendMinimumSats,
  getArkadeOnchainSendMinimumSats,
} from "../../../services/arkade/ArkadeSendService";
import { isBelowVtxoMinimum } from "../../../services/arkade/internal/sendMinimums";
import { t } from "../../../lib/i18n";
import { useCurrencyToggle, useKeypadEntry } from "../../../lib/useCurrencyToggle";
import { useLiveBtcPrice } from "../../../lib/bitcoin/useLiveBtcPrice";
import { satsFromAmountEntry } from "../../../lib/bitcoin/convert";
import { sanitizeDigits, sanitizeFiatDigits } from "../../../lib/sanitizeDigits";
import { useHomeCurrency } from "../../../lib/currency/useHomeCurrency";
import { decodeBolt11Facts, isBolt11Invoice } from "../../../lib/bitcoin/lightning";
import {
  LIGHTNING_TO_BITCOIN_MIN_SATS,
  LIGHTNING_TO_BITCOIN_SPREAD_MULTIPLIER,
} from "../../../services/swapkit/LightningToBitcoinLimits";
import {
  checkRemitInvoice,
  type RemitInvoiceRefusal,
  remitPressOutcome,
} from "../../../lib/remit/remitInvoiceGuard";
import {
  formatTanzanianMobileNumber,
  normalizeTanzanianMobileNumber,
} from "../../../lib/remit/tanzaniaPhone";
import { kenyaMpesaDestination, normalizeKenyanMobileNumber } from "../../../lib/remit/kenyaPhone";
import type { ZapRemitDestination } from "../../../lib/remit/zapremitForm";
import { flagForIso2 } from "../../../lib/countryFlags";
import PayoutAbroadSheet from "../../../components/PayoutAbroadSheet";
import {
  checkRemitPayment,
  createRemitLightningInvoice,
  createTzOrder,
  createZapRemitLightningInvoice,
  getZapRemitTerms,
  localToSats,
  quoteRemitSats,
  quoteTzPayout,
  tzPaymentLapsed,
  type ZapRemitTerms,
} from "../../../services/remit/RemitService";
import {
  btcRailRefundAddress,
  executeV2BtcToStable,
  quoteV2BtcToStable,
} from "../../../services/swapkit/SwapKitV2BtcToStableService";
import { paysBySwap, TZ_METHODS } from "../../../lib/remit/zapremitForm";
import { resolveLightningBounds } from "../../../lib/bitcoin/lightningLimits";
import { maxFundAmountSats } from "../../../services/swapkit/SwapKitArkadeIntentsCreate";
import { sendArkadeToBitcoinViaLightning } from "../../../services/swapkit/SwapKitV2ArkadeToBtcService";
import { SwapKitV2Error } from "../../../services/swapkit/SwapKitV2Service";
import { type MovePill, startMovePill } from "../../../services/wallet/CardTransferPill";
import { getEthereumAddress } from "../../../lib/secureKeyStorage";
import {
  isLnurlPaymentInput,
  normalizeLightningInput,
  resolveLnurlPayRequest,
} from "../../../services/bitcoin/LnurlService";
import { isNuriLightningAddress, toNuriUsername } from "../../../lib/pay/nuriUsername";
import { resolvePayRecipient } from "../../../lib/pay/resolvePayRecipient";
import { nuriUsernameDestination } from "../../../lib/pay/nuriUsernameDestination";
import { bitcoinDestination } from "../../../lib/addressBook/nuriContacts";
import { rememberNuriPayment } from "../../../services/addressBook/nuriContactSync";
import { createRecipientLookupGate } from "../../../lib/pay/recipientLookupGate";
import type { BitcoinSendProps } from "../../../types/bitcoin";
import { groupCount } from "../../../lib/formatting";

type Props = BitcoinSendProps;

// A saved Bitcoin destination the recipient field would accept: the contacts
// list never offers one that leaves Next disabled.
function acceptsPayableBitcoin(destination: Destination): boolean {
  if (!acceptsBitcoinSend(destination)) return false;
  const raw = destination.raw.trim();
  return isValidBitcoinAddressMainnet(raw) || isArkAddress(raw) || isLnurlPaymentInput(raw);
}

const TZS_FLAG = require("../../../assets/flags/tza.png");

// `availableAtMs` is 0 when the wait could not be derived from the wallet's
// VTXO expiries — then the copy stays vague rather than naming a wrong time.
function formatOnchainTooFreshMessage(availableAtMs: number): string {
  const remainingMs = Number.isFinite(availableAtMs) ? availableAtMs - Date.now() : 0;
  if (remainingMs <= 0) return t("screen.BitcoinSendScreen.errorOnchainTooFresh");
  const remainingMinutes = Math.ceil(remainingMs / 60_000);
  if (remainingMinutes < 60) {
    return t("screen.BitcoinSendScreen.errorOnchainTooFreshMinutes", {
      minutes: String(remainingMinutes),
    });
  }
  return t("screen.BitcoinSendScreen.errorOnchainTooFreshHours", {
    hours: String(Math.ceil(remainingMs / 3_600_000)),
  });
}

export default function BitcoinSendScreen({
  visible,
  presetAddress,
  presetPayout,
  presetAmountSats,
  allowAmountEdit = true,
  sendSource = "arkade",
  onClose,
  onSendSuccess,
}: Props) {
  type InputMode = "sats" | "fiat";
  const [toAddress, setToAddress] = useState(presetAddress ?? "");
  // A short screen compacts the keypad before it scrolls.
  const keypadFit = useKeypadFit();
  const [busy, setBusy] = useState(false);
  // Confirming hands the send to the status pill, exactly like a move from the
  // Move sheet: the sheet steps away at once, the pill says "Preparing" (keep
  // the app open) until the wallet has signed, and the passkey prompt appears
  // when it is needed. The form is kept, not reset: a send refused before any
  // money moved brings the sheet back with its figures and the reason.
  const [handedOff, setHandedOff] = useState(false);
  const movePillRef = useRef<MovePill | null>(null);
  const handOffToPill = useCallback(() => {
    movePillRef.current?.drop();
    movePillRef.current = startMovePill();
    setHandedOff(true);
  }, []);
  const takeBackFromPill = useCallback(() => {
    movePillRef.current?.drop();
    movePillRef.current = null;
    setHandedOff(false);
  }, []);
  // Preview UI removed; build and approve happen in one step now
  const [fiatPerBtc, setFiatPerBtc] = useState<number | null>(null);
  const fiatCode = useHomeCurrency();
  const [balanceSats, setBalanceSats] = useState<number | null>(null);
  // What an OFFBOARD may move. Everything spendable can go over Lightning or to
  // an ark address; only a VTXO the server will accept as a settlement input can
  // leave on-chain, and a freshly settled one cannot for about a day.
  const [settleableSats, setSettleableSats] = useState<number | null>(null);
  // What the MuSig2 rail's own transaction will cost in miner fee, read from the
  // builder's fee model when the sheet opens. Zero until it answers, and unused
  // on the arkade corridor.
  const [onchainSendFeeSats, setOnchainSendFeeSats] = useState(0);
  // The server's own offboard floor, read live: it moved from 3000 to 330 sats
  // without a release, and a hardcoded figure here refuses sends the server
  // would accept.
  const [onchainMinSats, setOnchainMinSats] = useState(ARKADE_BITCOIN_ONCHAIN_MIN_SEND_SATS);
  // The node's floor for an ark-to-ark send (a new VTXO), read live. Null until
  // the node answers; the send re-reads it and refuses on its own.
  const [arkMinSats, setArkMinSats] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [localAmountLocked, setLocalAmountLocked] = useState(false);
  const [submittedAmountLocked, setSubmittedAmountLocked] = useState(false);
  // A send that failed holds the sheet still: keypad gone, Confirm replaced by
  // Try again, which only returns to the form. Nothing resubmits until the user
  // confirms again (#1546).
  const [sendFailed, setSendFailed] = useState(false);
  const failSend = useCallback((message: string) => {
    setErrorMessage(message);
    setSendFailed(true);
  }, []);
  const clearSendFailure = useCallback(() => {
    setSendFailed(false);
    setErrorMessage(null);
  }, []);
  const [overBalanceUnlock, setOverBalanceUnlock] = useState(false);
  const recipientFieldRef = useRef<TextFieldHandle>(null);
  // Manual entry is staged: recipient first (keyboard), then — after Next —
  // amount (keypad). Re-focusing the field returns to the recipient stage so
  // the system keyboard and the DS keypad never show together.
  const [recipientConfirmed, setRecipientConfirmed] = useState(false);
  const [recipientFocused, setRecipientFocused] = useState(false);
  // A Nuri username typed as the recipient is being looked up (on Next).
  const [resolvingUsername, setResolvingUsername] = useState(false);
  const usernameLookupGate = useRef(createRecipientLookupGate());
  // What the field holds right now, for a lookup that lands long after it began.
  const toAddressRef = useRef(toAddress);
  toAddressRef.current = toAddress;
  // The Nuri user a username lookup turned into the address in the field: a
  // send that goes there saves them in the address book (#1770).
  const nuriRecipientRef = useRef<{ username: string; address: string } | null>(null);
  // Any change to the recipient (typing, paste, preset) and any open/close
  // abandons a username lookup still in flight for the old one.
  useEffect(() => {
    usernameLookupGate.current.invalidate();
    setResolvingUsername(false);
  }, [toAddress, visible]);
  const [lnurlMinSats, setLnurlMinSats] = useState<number | null>(null);
  // What is on screen RIGHT NOW, for the LNURL resolution to read when it
  // lands: it may answer long after it was started, and the state it captured
  // then is not what the user is looking at.
  // The amount as the screen currently reads it, whichever field is active, for
  // callbacks that land long after they were started.
  const currentSatsRef = useRef(0);
  // The recipient's OWN ceiling. A provider may advertise less than the
  // corridor allows, and an amount above it is one the provider has already
  // declared invalid — refusing it here beats a generic failure after the
  // pay-request round trip.
  const [lnurlMaxSats, setLnurlMaxSats] = useState<number | null>(null);
  // A bank or mobile money account abroad, picked in the abroad sheet. It
  // stands in for the typed recipient: the field is empty while it is set.
  const [abroadDestination, setAbroadDestination] = useState<ZapRemitDestination | null>(null);
  const [abroadOpen, setAbroadOpen] = useState(false);
  // Which wallet actually pays. A Lightning target has no on-chain rail, so it
  // moves the whole screen — balance, minimum, hold — onto arkade even when the
  // user opened this from the on-chain row.
  const recipientIsLightning = useMemo(() => {
    // A payout abroad is paid with a BOLT11 minted at confirm time.
    if (abroadDestination) return true;
    const normalized = normalizeLightningInput(toAddress.trim());
    if (isBolt11Invoice(normalized)) return true;
    if (isLnurlPaymentInput(normalized) && !isNuriLightningAddress(normalized)) return true;
    // A phone number is paid by minting a BOLT11 for it at confirm time, so it
    // is a Lightning recipient for every purpose this flag governs — which
    // balance the screen reads, holds and spends from.
    return (
      normalizeTanzanianMobileNumber(toAddress) !== null ||
      normalizeKenyanMobileNumber(toAddress) !== null
    );
  }, [toAddress, abroadDestination]);
  const effectiveSendSource: "arkade" | "onchain" = recipientIsLightning ? "arkade" : sendSource;
  // A bolt11 with no amount, or one this screen cannot decode: recognised as an
  // invoice, but not payable on a corridor that quotes against its figure.
  const [invoiceUnpayable, setInvoiceUnpayable] = useState(false);
  // The shilling figure the user types when the recipient is a phone number.
  // It is entry only: what the screen prices, checks and finally spends is the
  // sats the corridor quotes back for it, written into the sats field below so
  // every existing balance and corridor guard applies unchanged.
  const [remitDigits, setRemitDigits] = useState("");
  const [remitQuoting, setRemitQuoting] = useState(false);
  // An invoice already minted and shown to the user at ITS price, waiting for
  // the second press. The corridor adds its fee on top of what `quote_tzs`
  // prices, so the invoice is routinely dearer than the figure the amount was
  // typed against — that is a price to state and have accepted, not one to pay
  // quietly and not a reason to refuse the send.
  const [remitPendingInvoice, setRemitPendingInvoice] = useState<{
    invoice: string;
    sats: number;
    sessionId: string | null;
    receiverName: string | null;
    feeTZS: number | null;
    /**
     * A destination that takes USDC only (a Tanzanian bank): no invoice, but
     * an accepted swap of this many sats into the exact USDC the order asks,
     * settled straight to the order's address.
     */
    swap?: {
      optionId: string;
      quoteId?: string;
      settleExact: string;
      payTo: string;
      expectedUsdc: number | null;
      /** The earlier of the order's lapse and the swap option's validity. */
      expiresAt: number | null;
    };
  } | null>(null);
  const [remitQuoteFailed, setRemitQuoteFailed] = useState(false);
  // Kenyan numbers: ZapRemit pays a named recipient, so the screen asks for
  // the name. Every ZapRemit payout is priced from its rate and method band.
  const [remitName, setRemitName] = useState("");
  const [remitNameFocused, setRemitNameFocused] = useState(false);
  const [zapTerms, setZapTerms] = useState<ZapRemitTerms | null>(null);
  // Whether the current amount lock came from an invoice, so replacing the
  // recipient releases only the lock this screen put on.
  const invoiceLockedAmountRef = useRef(false);
  const amountEditable =
    !submittedAmountLocked &&
    !sendFailed &&
    ((allowAmountEdit && !localAmountLocked) || overBalanceUnlock);
  // Decide focus-on-open from the preset recipient (stable for the whole modal
  // session), not the live value. Empty preset → focus the recipient field
  // (manual recipient entry); preset → keypad entry, nothing to focus.
  const presetRecipientEmpty = !presetAddress?.trim();
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
    onBeforeToggle: () => {
      setErrorMessage(null);
    },
  });
  const arkadeLightningSendActiveRef = useRef(false);
  const arkadePendingIdRef = useRef<string | null>(null);
  const arkadeLocalPendingIdRef = useRef<string | null>(null);
  const arkadeSubmittedTxidRef = useRef<string | null>(null);
  const arkadeSubmittedClosedRef = useRef(false);
  const arkadeSendAttemptIdRef = useRef(0);
  // Idempotency for the corridor, stable across retries of the SAME intent: a
  // confirm that failed after the invoice was minted must return that invoice,
  // not open a second payout to the same phone.
  const remitSessionSeedRef = useRef<string>("");
  const lockSubmittedAmount = useCallback(
    (submittedSats: number) => {
      const safeSats = Math.max(0, Math.trunc(Number(submittedSats) || 0));
      if (safeSats > 0) {
        setInputMode("sats");
        setSatsDigits(String(safeSats));
      }
      setSubmittedAmountLocked(true);
      try {
        recipientFieldRef.current?.blur();
      } catch {}
      try {
        Keyboard.dismiss();
      } catch {}
    },
    [setInputMode, setSatsDigits],
  );
  const closeAndNotifyRefresh = useCallback(async () => {
    try {
      EventBus.emit("bitcoin:refresh");
    } catch {}
    try {
      EventBus.emit("bitcoin:syncWallet");
    } catch {}
    try {
      onClose();
    } catch {}
  }, [onClose]);

  const removeArkadePending = useCallback(async (...ids: Array<string | null | undefined>) => {
    const unique = Array.from(
      new Set(ids.map((id) => String(id || "").trim()).filter((id) => id.length > 0)),
    );
    await Promise.all(
      unique.map(async (id) => {
        try {
          await PendingBitcoinSendsStore.remove(id);
        } catch {}
      }),
    );
  }, []);

  const handleArkadeSendAuthenticated = useCallback(
    (payload?: ArkadeLightningSendAuthenticatedPayload) => {
      if (!arkadeLightningSendActiveRef.current) return;
      if (arkadeSubmittedClosedRef.current || arkadePendingIdRef.current) return;
      const amountSats = Math.max(
        0,
        Math.trunc(Number(payload?.amountSats || payload?.finalAmountSats || 0)),
      );
      if (amountSats <= 0) return;
      bitcoinBalanceStore.holdArkadeOutgoingBalance(
        "lightning_send_authenticated",
        amountSats,
        OUTGOING_ARKADE_SEND_HOLD_TTL_MS,
      );
      const localId = `arkade-send-${arkadeSendAttemptIdRef.current}-${payload?.id || Date.now()}`;
      arkadePendingIdRef.current = localId;
      arkadeLocalPendingIdRef.current = localId;
      arkadeSubmittedClosedRef.current = true;
      void (async () => {
        try {
          await PendingBitcoinSendsStore.add({
            txid: localId,
            amountSats,
            toAddress: payload?.recipient || toAddress || null,
            local: true,
            // Lightning is an arkade-only corridor, whichever rail the sheet was
            // opened from.
            source: "arkade",
          });
          if (
            arkadePendingIdRef.current !== localId &&
            arkadeLocalPendingIdRef.current !== localId
          ) {
            await removeArkadePending(localId);
          }
        } catch (error: unknown) {
          log("Arkade authenticated pending record failed", error);
        }
        try {
          log(
            `🔐 STEP Arkade_v4=1 step=wallet_send_authenticated_modal_close status=ok kind=${payload?.kind || "lightning"} sats=${amountSats} pending_id=${localId} expected_next=balance_pending_spinner src=screens/bitcoin/modals/BitcoinSendScreen.tsx#handleArkadeSendAuthenticated`,
          );
        } catch {}
        await closeAndNotifyRefresh();
      })();
    },
    [closeAndNotifyRefresh, removeArkadePending, toAddress],
  );

  const handleArkadeSendSubmitted = useCallback(
    (payload?: ArkadeLightningSendSubmittedPayload) => {
      if (!arkadeLightningSendActiveRef.current) return;
      const txid = String(payload?.txid || "").trim();
      const amountSats = Math.max(0, Math.trunc(Number(payload?.amountSats || 0)));
      if (!txid || amountSats <= 0) return;
      if (arkadeSubmittedTxidRef.current === txid) return;
      const previousPendingId = arkadeLocalPendingIdRef.current || arkadePendingIdRef.current;
      const shouldClose = !arkadeSubmittedClosedRef.current;
      arkadePendingIdRef.current = txid;
      arkadeSubmittedTxidRef.current = txid;
      arkadeSubmittedClosedRef.current = true;
      void (async () => {
        if (previousPendingId && previousPendingId !== txid) {
          await removeArkadePending(previousPendingId);
        }
        try {
          await PendingBitcoinSendsStore.add({
            txid,
            amountSats,
            toAddress: payload?.kind === "lnurl" ? payload.recipient || toAddress || null : null,
            source: "arkade",
          });
        } catch (error: unknown) {
          log("Arkade send pending record failed", error);
        }
        try {
          log(
            `🔐 STEP Arkade_v4=1 step=wallet_send_submitted_modal_close status=ok kind=${payload?.kind || "lightning"} sats=${amountSats} txid=${txid.slice(0, 12)}... expected_next=balance_pending_spinner src=screens/bitcoin/modals/BitcoinSendScreen.tsx#handleArkadeSendSubmitted`,
          );
        } catch {}
        if (shouldClose) {
          await closeAndNotifyRefresh();
          return;
        }
        try {
          EventBus.emit("bitcoin:refresh");
          EventBus.emit("bitcoin:syncWallet");
        } catch {}
      })();
    },
    [closeAndNotifyRefresh, removeArkadePending, toAddress],
  );

  useEffect(() => {
    const offAuthenticated = EventBus.on<ArkadeLightningSendAuthenticatedPayload>(
      "bitcoin:sendAuthenticated",
      handleArkadeSendAuthenticated,
    );
    const offSubmitted = EventBus.on<ArkadeLightningSendSubmittedPayload>(
      "bitcoin:sendSubmitted",
      handleArkadeSendSubmitted,
    );
    return () => {
      offAuthenticated();
      offSubmitted();
    };
  }, [handleArkadeSendAuthenticated, handleArkadeSendSubmitted]);

  const scheduleSendSuccess = useCallback(
    (txId: string) => {
      const nuri = nuriRecipientRef.current;
      if (nuri && nuri.address === toAddressRef.current.trim()) {
        void rememberNuriPayment(nuri.username, [
          bitcoinDestination(nuri.address, isArkAddress(nuri.address)),
        ]).catch(() => {});
      }
      if (!onSendSuccess) return;
      const delay = Platform.OS === "ios" ? 350 : 200;
      setTimeout(() => {
        try {
          onSendSuccess({ txId });
        } catch {}
      }, delay);
    },
    [onSendSuccess],
  );

  // If the caller provides a preset address when opening, reflect it in the
  // field. An explicit empty string is authoritative (clears the field for the
  // manual recipient-entry path); `undefined` means "no preset".
  //
  // A scanned or handed-over `name@nuri.com` is a Nuri user whose Lightning
  // address cannot receive yet: it is swapped for the address the directory
  // lists for this sheet's rail, as a typed username is on Next.
  useEffect(() => {
    if (visible && typeof presetAddress === "string") {
      setToAddress(presetAddress.trim());
    }
  }, [visible, presetAddress]);
  // Declared after the effect that invalidates the lookup gate on every
  // recipient change, so this lookup's ticket is taken after that reset.
  useEffect(() => {
    if (!visible || typeof presetAddress !== "string") return;
    const preset = presetAddress.trim();
    if (toAddress.trim() !== preset) return;
    const username = isNuriLightningAddress(preset) ? toNuriUsername(preset) : null;
    if (!username) return;
    const ticket = usernameLookupGate.current.begin(preset);
    const stillCurrent = () => usernameLookupGate.current.isCurrent(ticket, toAddressRef.current);
    setResolvingUsername(true);
    setErrorMessage(null);
    void resolvePayRecipient(username)
      .then((recipient) => {
        if (!stillCurrent()) return;
        const destination = nuriUsernameDestination(recipient, sendSource);
        if (destination) {
          nuriRecipientRef.current = { username, address: destination };
          setToAddress(destination);
        } else setErrorMessage(t("screen.BitcoinSendScreen.errorUsernameNotFound"));
      })
      .catch(() => {
        if (stillCurrent())
          setErrorMessage(t("screen.BitcoinSendScreen.errorUsernameLookupFailed"));
      })
      .finally(() => {
        if (stillCurrent()) setResolvingUsername(false);
      });
  }, [visible, presetAddress, toAddress, sendSource]);
  useEffect(() => {
    if (!visible) {
      return;
    }

    let mounted = true;

    const loadFeesAndBalance = async () => {
      try {
        // Bind the spendable figure to the wallet the send actually debits. The
        // two balances are independent, so the Arkade summary would block a
        // funded MuSig2 wallet when Arkade is low and — worse — allow confirming
        // an on-chain send the on-chain wallet cannot cover when Arkade is high.
        // Arkade counts settled sats, INCLUDING the ones still inside the
        // server's min-expiry gap: that gap bars a VTXO as a SETTLEMENT input —
        // an offboard or a re-settle — and an offchain send never joins a batch
        // round, so it spends them like any other. Preconfirmed sats stay out:
        // those are not final yet. Counting only the first figure refused
        // Lightning payments for a day against a wallet the corridor would have
        // paid from.
        if (effectiveSendSource === "onchain") {
          const { byChannel, detail } = bitcoinBalanceStore.getSnapshot().bitcoinBalance;
          // The send builds from the one MuSig2 address the app derives, so it
          // is capped by that address's own balance. `byChannel.onchain` is the
          // sum the user owns and stays on the board; what this screen may
          // offer is the part of it attributed to that address.
          const spendable = Math.max(0, detail.onchain.spendable ?? byChannel.onchain);
          // Read before the balance is published so the two never disagree: the
          // amount entered here is what the RECIPIENT receives and the miner fee
          // comes out of the same wallet on top, so the whole balance is never
          // sendable and a max-send with no headroom failed inside the builder.
          const feeSats = await estimateOnchainSendFeeSats();
          if (mounted) {
            setOnchainSendFeeSats(feeSats);
            setBalanceSats(spendable);
            setSettleableSats(spendable);
          }
        } else {
          const summary = await getArkadeWalletSummary({
            scheduleAutoClaim: false,
            scheduleAutoRecover: false,
            scheduleAutoBoardingSweep: false,
          });
          // Spendable: settled, the settled ones still inside the server's
          // min-expiry gap, and the preconfirmed ones. All three fund an
          // offchain send — the SDK's own coin selection takes them.
          const spendable =
            (Number(summary.balanceSettledSats) || 0) +
            (Number(summary.balanceTooFreshSats) || 0) +
            (Number(summary.balancePreconfirmedSats) || 0);
          // Settleable: only the settled ones the server will accept as a
          // settlement input, which is what an on-chain exit needs.
          if (mounted) {
            setBalanceSats(Math.max(0, spendable));
            setSettleableSats(Math.max(0, Number(summary.balanceSettledSats) || 0));
          }
        }
      } catch (_e) {
        if (mounted) setInfoMessage("Balance unavailable");
      }
    };
    void loadFeesAndBalance();
    void getArkadeOnchainSendMinimumSats()
      .then((min: number) => {
        if (mounted && Number.isFinite(min) && min > 0) setOnchainMinSats(Math.trunc(min));
      })
      .catch(() => {});
    void getArkadeArkSendMinimumSats()
      .then((min: number | null) => {
        if (mounted && min !== null) setArkMinSats(min);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [visible, effectiveSendSource]);

  // The fiat side is typed and shown in the display currency, so its price is
  // read in that same currency — typed euros divide by a euro price, typed
  // dollars by a dollar price. A switch drops the old price first: a figure in
  // one currency must never be divided by a rate in the other.
  useEffect(() => {
    if (!visible) return;
    let mounted = true;
    setFiatPerBtc(null);
    void (async () => {
      try {
        const snap = await btcSpotPriceService.getFresh(fiatCode);
        if (!mounted) return;
        if (snap.valid && snap.price !== null && snap.price > 0) {
          setFiatPerBtc(snap.price);
        } else {
          setInfoMessage(t("screen.BitcoinSendScreen.infoFiatPriceUnavailable"));
        }
      } catch (_e) {
        if (mounted) setInfoMessage(t("screen.BitcoinSendScreen.infoFiatPriceUnavailable"));
      }
    })();
    return () => {
      mounted = false;
    };
  }, [visible, fiatCode]);

  // A payout destination named by a scanned code (a TanQR merchant) is the
  // recipient: the sheet opens on the amount.
  useEffect(() => {
    if (!visible || !presetPayout) return;
    setAbroadDestination(presetPayout);
    setRecipientConfirmed(true);
  }, [visible, presetPayout]);

  // If a preset amount (in sats) is provided, populate the sats field
  useEffect(() => {
    if (!visible) return;
    if (!presetAmountSats) return;
    const sats = Number(sanitizeDigits(presetAmountSats));
    if (!Number.isFinite(sats)) return;
    setSatsDigits(String(Math.max(0, Math.floor(sats))));
  }, [visible, presetAmountSats, setSatsDigits]);
  // Arkade sends carry no client-estimated onchain fee — the corridor quotes its
  // own and takes it out of what it moves. The MuSig2 rail is the opposite: it
  // pays a miner fee on top of what the recipient receives, out of the same
  // wallet, so the screen holds that much back from what it offers.
  const estimatedFeeSats = effectiveSendSource === "onchain" ? onchainSendFeeSats : 0;
  const trimmedToAddress = toAddress.trim();
  const normalizedRecipient = normalizeLightningInput(trimmedToAddress);
  const isRecipientBolt11 = isBolt11Invoice(normalizedRecipient);
  // `name@nuri.com` is a Nuri user, paid at their Arkade address: their
  // Lightning address cannot receive yet, so it never selects the LN rail.
  const isRecipientLnurl =
    isLnurlPaymentInput(normalizedRecipient) && !isNuriLightningAddress(normalizedRecipient);
  const isRecipientBitcoinAddress = isValidBitcoinAddressMainnet(trimmedToAddress);
  const isRecipientArk = isArkAddress(trimmedToAddress);
  // Arkade to a Bitcoin address always runs over the Lightning corridor (the
  // offboard is never used), so the corridor's floor is the real minimum.
  const isArkadeToBitcoinAddress =
    isRecipientBitcoinAddress &&
    !isRecipientBolt11 &&
    !isRecipientLnurl &&
    effectiveSendSource !== "onchain";
  const bitcoinAddressMinSats = isArkadeToBitcoinAddress
    ? Math.max(onchainMinSats, LIGHTNING_TO_BITCOIN_MIN_SATS)
    : onchainMinSats;
  // The recipient as the corridor is asked for it, or null when this is not a
  // Tanzanian or Kenyan mobile number. Null is what every branch below reads,
  // so a half-typed number never selects the rail. A destination picked in the
  // abroad sheet takes the place of a typed one.
  const tzPhone = abroadDestination ? null : normalizeTanzanianMobileNumber(trimmedToAddress);
  const kePhone =
    abroadDestination || tzPhone ? null : normalizeKenyanMobileNumber(trimmedToAddress);
  // Every ZapRemit payout, Kenyan number or abroad sheet, as one destination.
  const zapDestination = useMemo(
    () => abroadDestination ?? (kePhone ? kenyaMpesaDestination(kePhone, remitName) : null),
    [abroadDestination, kePhone, remitName],
  );
  const remitCountry: string | null = tzPhone ? "TZ" : (zapDestination?.country ?? null);
  // Which corridor and method prices the amount: a change starts the figure over.
  const remitRailKey = tzPhone
    ? "TZ"
    : zapDestination
      ? `${zapDestination.country}:${zapDestination.methodCode}:${zapDestination.currency}`
      : null;
  const isRecipientRemitPhone = remitCountry !== null;
  // A Tanzanian bank: paid by a swap into USDC, outside the Lightning band.
  const isSwapPayout = paysBySwap(zapDestination);
  const remitCurrency = zapDestination?.currency ?? "TZS";
  const zapCountry = zapDestination?.country ?? null;
  const zapMethod = zapDestination?.methodCode ?? null;
  const zapProvider = zapDestination?.provider ?? null;
  const remitAmount = useMemo(() => {
    const parsed = Number(sanitizeDigits(remitDigits));
    return Number.isFinite(parsed) ? Math.floor(parsed) : 0;
  }, [remitDigits]);
  // ZapRemit's own band for the method. Out of it, the quote would be refused.
  const zapBandLabel =
    zapDestination && zapTerms !== null && remitAmount > 0
      ? remitAmount < zapTerms.min
        ? t("screen.BitcoinSendScreen.remitMinimum", {
            amount: groupCount(zapTerms.min),
            currency: remitCurrency,
          })
        : remitAmount > zapTerms.max
          ? t("screen.BitcoinSendScreen.remitMaximum", {
              amount: groupCount(zapTerms.max),
              currency: remitCurrency,
            })
          : null
      : null;

  // A scanned or pasted invoice already fixes the amount and the payee, so the
  // corridor quote can be fetched while the user reviews it instead of after
  // they confirm. Read-only (no order, no signature, no prompt), used at most
  // once and only for this exact invoice; dropped when the sheet closes.
  useEffect(() => {
    if (!visible || !isRecipientBolt11) return;
    const handle = setTimeout(() => {
      void prefetchArkadeLightningQuote(normalizedRecipient);
    }, 300);
    return () => clearTimeout(handle);
  }, [visible, isRecipientBolt11, normalizedRecipient]);
  useEffect(() => {
    if (!visible) clearPrefetchedArkadeIntentsLightningQuote();
  }, [visible]);

  // The recipient decides which figure caps the send. A Bitcoin address used to
  // be bound by what may be SETTLED, because the only way out was the offboard
  // and it can spend nothing else. The corridor changed that: it pays a BOLT11,
  // which spends the balance the same way any offchain send does, so fresh and
  // preconfirmed sats can leave through it.
  //
  // So the cap is whichever rail can carry the money, which is NOT a single
  // figure: above the corridor floor the whole balance is reachable, below it
  // only the settleable part is. Taking the larger of the two keeps both sends
  // possible; `sendsOverCorridor` then decides which one actually runs, and
  // `spendSats` reserves the corridor's fee when it does.
  const maxSpendableSats = useMemo(() => {
    if (!isRecipientBitcoinAddress) {
      if (balanceSats === null) return null;
      return Math.max(0, balanceSats - estimatedFeeSats);
    }
    if (balanceSats === null && settleableSats === null) return null;
    const viaOffboard = settleableSats ?? 0;
    // The corridor can only take the balance if the floor is reachable at all.
    const viaCorridor =
      (balanceSats ?? 0) >= LIGHTNING_TO_BITCOIN_MIN_SATS ? (balanceSats ?? 0) : 0;
    return Math.max(0, Math.max(viaOffboard, viaCorridor) - estimatedFeeSats);
  }, [balanceSats, settleableSats, isRecipientBitcoinAddress, estimatedFeeSats]);
  const availableSatsDisplay = useMemo(() => {
    if (maxSpendableSats === null) return null;
    return Math.max(0, Math.floor(maxSpendableSats));
  }, [maxSpendableSats]);
  // Current sats — derived from active input mode
  const currentSats = useMemo(() => {
    return satsFromAmountEntry(isSatsMode, satsDigits, fiatDigits, fiatPerBtc);
  }, [isSatsMode, satsDigits, fiatDigits, fiatPerBtc]);
  currentSatsRef.current = currentSats;
  // Which rail this particular send takes. Keyed on the ENTERED AMOUNT, not the
  // balance: a wallet holding 20,000 fresh sats sending 3,000 is below the
  // corridor floor, so the offboard runs — and the offboard cannot spend fresh
  // vtxos, which is the too-fresh failure a balance-keyed flag would wave
  // through after the screen had already accepted the amount.
  const sendsOverCorridor = useMemo(
    () => currentSats >= LIGHTNING_TO_BITCOIN_MIN_SATS,
    [currentSats],
  );
  // What the wallet actually has to cover. A Lightning target funds a lockup
  // carrying the invoice's sats PLUS the corridor's spread, so comparing the
  // invoice amount alone left an amount near the full balance enabled — it
  // created the order and then failed the service's own funding check.
  //
  // A Bitcoin address on the corridor is the same shape: what the recipient
  // gets is the entered figure, the provider's spread rides on top, and the
  // Intents lockup adds its fee again. Without this, Max passed the check and
  // then failed after confirmation.
  const spendSats = useMemo(() => {
    // A bank swap spends exactly the accepted option's sats, no Lightning reserve.
    if (isSwapPayout) return currentSats;
    if (isRecipientBolt11 || isRecipientLnurl || isRecipientRemitPhone) {
      return maxFundAmountSats(currentSats);
    }
    if (isRecipientBitcoinAddress && sendsOverCorridor) {
      // The provider's spread is not known until it quotes, so reserve the
      // observed ~2.2% band. Over-reserving refuses a send the corridor might
      // have taken; under-reserving accepts one it cannot.
      return maxFundAmountSats(Math.ceil(currentSats * LIGHTNING_TO_BITCOIN_SPREAD_MULTIPLIER));
    }
    return currentSats;
  }, [
    currentSats,
    isSwapPayout,
    isRecipientBolt11,
    isRecipientLnurl,
    isRecipientRemitPhone,
    isRecipientBitcoinAddress,
    sendsOverCorridor,
  ]);
  const exceedsBalance = useMemo(() => {
    if (maxSpendableSats == null) return false;
    return spendSats > maxSpendableSats;
  }, [spendSats, maxSpendableSats]);
  // A Bitcoin send BELOW the corridor floor runs on the offboard, which can
  // only spend settled vtxos. The cap above is the larger of the two rails, so
  // this case has to be named separately or the screen accepts an amount the
  // offboard then refuses with the too-fresh error, after confirmation.
  const exceedsSettleableForOffboard = useMemo(() => {
    if (!isRecipientBitcoinAddress || sendsOverCorridor) return false;
    if (settleableSats == null) return false;
    return spendSats > Math.max(0, settleableSats - estimatedFeeSats);
  }, [isRecipientBitcoinAddress, sendsOverCorridor, settleableSats, spendSats, estimatedFeeSats]);
  // The two amount rows flip together: number and the same currency image used
  // on the home cards. Text codes beside the number are redundant here.
  const secondaryAmount = useMemo(() => {
    if (isRecipientRemitPhone) {
      // Nothing quoted yet is not "0 sats" — a zero here reads as a free send.
      return currentSats > 0 ? groupCount(currentSats) : "\u2014";
    }
    return bitcoinSecondaryAmount(isSatsMode, currentSats, fiatPerBtc);
  }, [isSatsMode, currentSats, fiatPerBtc, isRecipientRemitPhone]);

  useLiveBtcPrice(visible, fiatCode, satsDigits, fiatDigits, setFiatPerBtc);

  const handlePasteRecipient = useCallback(async () => {
    // Invalidate before awaiting the clipboard: a username lookup landing
    // during that wait must not advance the sheet for the recipient being
    // replaced.
    usernameLookupGate.current.invalidate();
    setResolvingUsername(false);
    try {
      const text = await Clipboard.getStringAsync();
      const raw = (text || "").trim();
      if (!raw) return;
      const parsed = parseBitcoinUri(raw);
      // BIP21 `ark=<ark1…>` extension takes highest precedence: route through
      // the Ark address instead of the on-chain fallback. Carry a bip21 amount
      // if present, mirroring the on-chain branch below.
      if (parsed?.ark) {
        const arkAddr = parsed.ark.trim();
        if (!isArkAddress(arkAddr)) {
          // BIP21 ark= present but invalid: reject rather than downgrading to
          // the on-chain rail.
          setErrorMessage(t("screen.BitcoinSendScreen.errorInvalidAddress"));
          return;
        }
        setToAddress(arkAddr);
        if (parsed.amountSats != null) {
          setInputMode("sats");
          setSatsDigits(String(parsed.amountSats));
          setLocalAmountLocked(true);
        } else {
          setLocalAmountLocked(false);
        }
        return;
      }
      // BIP21 + BOLT-11 unified URI: prefer the lightning fallback. The
      // confirm-time classifier routes bolt11/lnurl automatically; bolt11
      // carries its own amount so lock it.
      if (parsed?.lightning) {
        setToAddress(parsed.lightning);
        setLocalAmountLocked(isBolt11Invoice(parsed.lightning));
        return;
      }
      if (parsed) {
        setToAddress(parsed.address.trim());
        if (parsed.amountSats != null) {
          setInputMode("sats");
          setSatsDigits(String(parsed.amountSats));
          setLocalAmountLocked(true);
        } else {
          setLocalAmountLocked(false);
        }
        return;
      }
      setToAddress(raw);
      setLocalAmountLocked(false);
    } catch {}
  }, [setInputMode, setSatsDigits]);

  const handleRemitDigitsChange = useCallback((raw: string) => {
    setRemitDigits(sanitizeDigits(raw));
    setErrorMessage(null);
  }, []);
  const handleSatsChange = useCallback(
    (raw: string) => {
      if (!amountEditable) return;
      const sanitized = sanitizeDigits(raw);
      setSatsDigits(sanitized);
      setErrorMessage(null);
      setInfoMessage(null);
    },
    [amountEditable, setSatsDigits],
  );

  const handleFiatChange = useCallback(
    (raw: string) => {
      if (!amountEditable) return;
      const sanitized = sanitizeFiatDigits(raw);
      setFiatDigits(sanitized);
      setErrorMessage(null);
      setInfoMessage(null);
    },
    [amountEditable, setFiatDigits],
  );

  // Keypad → the mode-specific sanitizing handlers.
  const { handleDigit, handleDecimal, handleDelete } = useKeypadEntry({
    // On the phone rail the keypad types shillings, never sats: the sats field
    // is written by the quote and is not the user's to edit.
    isModeA: isRecipientRemitPhone ? true : isSatsMode,
    digitsA: isRecipientRemitPhone ? remitDigits : satsDigits,
    digitsB: fiatDigits,
    onChangeA: isRecipientRemitPhone ? handleRemitDigitsChange : handleSatsChange,
    onChangeB: handleFiatChange,
  });

  const describeRemitRefusal = useCallback((refusal: RemitInvoiceRefusal): string => {
    switch (refusal) {
      case "amount_missing":
        return t("screen.BitcoinSendScreen.errorInvoiceAmountMissing");
      case "exceeds_balance":
        return t("screen.BitcoinSendScreen.errorExceedsBalance");
      case "below_corridor_minimum":
        return t("screen.BitcoinSendScreen.minimumSatsLabel", {
          amount: String(ARKADE_LIGHTNING_MIN_SEND_SATS),
        });
      case "above_corridor_maximum":
        return t("screen.BitcoinSendScreen.maximumSatsLabel", {
          amount: groupCount(ARKADE_LIGHTNING_MAX_SEND_SATS),
        });
      default:
        return t("screen.BitcoinSendScreen.errorSendFailed");
    }
  }, []);

  const handleConfirm = useCallback(() => {
    const run = async () => {
      console.log("[BitcoinSendScreen] handleConfirm", {
        sats: currentSats,
      });

      const addr = toAddress.trim();
      const lightningRequest = normalizeLightningInput(addr);
      const isArk = isArkAddress(addr);
      if (!isArk && addr.toLowerCase().startsWith("ark1")) {
        setErrorMessage(t("screen.BitcoinSendScreen.errorInvalidAddress"));
        recipientFieldRef.current?.focus();
        return;
      }
      const isBolt11 = !isArk && isBolt11Invoice(lightningRequest);
      const isLnurl =
        !isArk &&
        isLnurlPaymentInput(lightningRequest) &&
        !isNuriLightningAddress(lightningRequest);
      // Read again here rather than from render state: this runs after an await
      // chain, and the rail that gets paid must be the one this string names.
      // A destination from the abroad sheet has no string; it is the state.
      const tzRecipient = isArk || abroadDestination ? null : normalizeTanzanianMobileNumber(addr);
      const keRecipient =
        isArk || tzRecipient || abroadDestination ? null : normalizeKenyanMobileNumber(addr);
      const zapRecipient =
        abroadDestination ?? (keRecipient ? kenyaMpesaDestination(keRecipient, remitName) : null);
      const isRemit = tzRecipient !== null || zapRecipient !== null;
      log(
        `🔐 STEP Arkade_v4=1 step=wallet_send_confirm_pressed status=start sats=${currentSats} target=${isArk ? "ark_send" : isBolt11 ? "bolt11" : isLnurl ? "lnurl" : addr ? "bitcoin_onchain" : "missing"} amount_source=${isBolt11 ? "bolt11_invoice" : "ui_amount"} expected_next=validate_send_target src=screens/bitcoin/modals/BitcoinSendScreen.tsx#handleConfirm`,
      );
      if (!addr && !abroadDestination) {
        log(
          `🔐 STEP Arkade_v4=1 step=wallet_send_confirm_blocked status=blocked why=missing_target expected_next=user_enters_recipient src=screens/bitcoin/modals/BitcoinSendScreen.tsx#handleConfirm`,
        );
        setErrorMessage(t("screen.BitcoinSendScreen.errorInvalidAddress"));
        return;
      }
      // A bolt11 invoice carries its own amount, so the keypad figure is not
      // what gets paid and an empty one is not a reason to stop.
      if (!isBolt11 && currentSats <= 0) {
        log(
          `🔐 STEP Arkade_v4=1 step=wallet_send_confirm_blocked status=blocked why=amount_required target=${isLnurl ? "lnurl" : "bitcoin_onchain"} expected_next=user_enters_amount src=screens/bitcoin/modals/BitcoinSendScreen.tsx#handleConfirm`,
        );
        setErrorMessage(t("screen.BitcoinSendScreen.errorAmountGreaterThanZero"));
        return;
      }
      // An ark recipient gets a new VTXO, which the node refuses below its floor.
      // Say the floor here instead of after the passkey prompt.
      if (isArk && isBelowVtxoMinimum(currentSats, arkMinSats)) {
        log(
          `🔐 STEP Arkade_v4=1 step=wallet_send_confirm_blocked status=blocked why=below_vtxo_minimum sats=${currentSats} min_sats=${arkMinSats} target=ark_send expected_next=user_enters_minimum_amount src=screens/bitcoin/modals/BitcoinSendScreen.tsx#handleConfirm`,
        );
        setErrorMessage(
          t("screen.BitcoinSendScreen.minimumSatsLabel", { amount: String(arkMinSats) }),
        );
        return;
      }
      // A send above the spendable figure fails at settlement, after a passkey
      // prompt — stop it here.
      // The recipient's own ceiling, enforced where the send is actually
      // dispatched and not only on the button. A provider that advertises less
      // than the corridor has already declared a larger amount invalid.
      // A Tanzanian bank is paid by a swap, not over Lightning: its quote is its limit.
      // An Arkade-funded send to a Bitcoin address pays a Lightning invoice of
      // exactly this figure, so the same ceiling holds. Without it the order
      // was committed and the funding refused after the sheet had closed.
      const arkadeToBitcoinAddress =
        !isArk &&
        !isBolt11 &&
        !isLnurl &&
        !isRemit &&
        effectiveSendSource !== "onchain" &&
        isValidBitcoinAddressMainnet(addr);
      if (isBolt11 || isLnurl || arkadeToBitcoinAddress || (isRemit && !paysBySwap(zapRecipient))) {
        const ceiling = Math.min(
          isLnurl
            ? (lnurlMaxSats ?? ARKADE_LIGHTNING_MAX_SEND_SATS)
            : ARKADE_LIGHTNING_MAX_SEND_SATS,
          ARKADE_LIGHTNING_MAX_SEND_SATS,
        );
        if (currentSats > ceiling) {
          setErrorMessage(
            t("screen.BitcoinSendScreen.maximumSatsLabel", { amount: groupCount(ceiling) }),
          );
          return;
        }
      }
      // Below the corridor floor this send runs on the offboard, which cannot
      // spend fresh vtxos. Refuse here rather than after the passkey prompt.
      if (exceedsSettleableForOffboard && settleableSats !== null) {
        setErrorMessage(
          t("screen.BitcoinSendScreen.maxAvailableLabel", {
            amount: groupCount(Math.max(0, settleableSats - estimatedFeeSats)),
          }),
        );
        return;
      }
      if (exceedsBalance) {
        setErrorMessage(
          isRecipientBitcoinAddress &&
            balanceSats !== null &&
            maxSpendableSats !== null &&
            balanceSats > maxSpendableSats
            ? t("screen.BitcoinSendScreen.maxAvailableLabel", {
                amount: groupCount(maxSpendableSats),
              })
            : t("screen.BitcoinSendScreen.errorExceedsBalance"),
        );
        return;
      }
      // Onchain recipient must be a valid mainnet BTC address. Without the guard
      // a garbage address falls through to the dispatch and fails late/opaquely
      // after a passkey prompt. Reject inline instead (same treatment as an
      // empty recipient).
      if (!isArk && !isBolt11 && !isLnurl && !isRemit && !isValidBitcoinAddressMainnet(addr)) {
        log(
          `🔐 STEP Arkade_v4=1 step=wallet_send_confirm_blocked status=blocked why=invalid_bitcoin_address target=bitcoin_onchain expected_next=user_fixes_recipient src=screens/bitcoin/modals/BitcoinSendScreen.tsx#handleConfirm`,
        );
        setErrorMessage(t("screen.BitcoinSendScreen.errorInvalidAddress"));
        return;
      }
      if (
        !isBolt11 &&
        !isLnurl &&
        isValidBitcoinAddressMainnet(addr) &&
        // The same live figure the label states. Comparing against the constant
        // here refused a send the screen had just called valid, and quoted the
        // server's number back while enforcing the old one.
        currentSats < bitcoinAddressMinSats
      ) {
        log(
          `🔐 STEP Arkade_v4=1 step=wallet_send_confirm_blocked status=blocked why=below_onchain_minimum sats=${currentSats} min_sats=${bitcoinAddressMinSats} target=bitcoin_onchain expected_next=user_enters_minimum_amount src=screens/bitcoin/modals/BitcoinSendScreen.tsx#handleConfirm`,
        );
        setErrorMessage(
          t("screen.BitcoinSendScreen.minimumSatsLabel", {
            amount: String(bitcoinAddressMinSats),
          }),
        );
        return;
      }
      // The on-chain rail spends the MuSig2 wallet through its own signing
      // round, not the arkade provider. Split before the dispatch below so
      // neither path can debit the other's balance.
      //
      // A Lightning recipient never takes this branch, whichever balance the
      // source picker last landed on: the MuSig2 wallet has no Lightning rail,
      // and handing it an invoice as `toAddress` would build a P2TR spend to a
      // string that is not an address. Only the arkade corridor pays these, and
      // `effectiveSendSource` has already moved the balance this screen reads
      // and holds to match.
      if (effectiveSendSource === "onchain") {
        try {
          setBusy(true);
          setErrorMessage(null);
          setInfoMessage(null);
          lockSubmittedAmount(currentSats);
          handOffToPill();
          const result = await sendBitcoinOnchainFromMusig2({
            toAddress: addr,
            amountSats: currentSats,
          });
          // Out: Completed is the moment its pending row clears.
          movePillRef.current?.settleByRows(result.txid);
          movePillRef.current = null;
          // The same "Sending" row the arkade corridor writes: this sheet closes
          // on success and the on-chain rail's own history takes a confirmation
          // to catch up, so without a row the broadcast leaves no trace at all.
          // Cleared by the reconciler once the tx confirms.
          if (result.txid) {
            void PendingBitcoinSendsStore.add({
              txid: result.txid,
              amountSats: currentSats,
              toAddress: addr,
              source: "onchain",
            }).catch(() => {});
          }
          await closeAndNotifyRefresh();
          scheduleSendSuccess(result.txid);
        } catch (e: unknown) {
          // Nothing left the wallet: the sheet comes back with the reason.
          takeBackFromPill();
          setSubmittedAmountLocked(false);
          if (!isUserCancelledAuth(e)) {
            failSend(errMsgText(e, t("screen.BitcoinSendScreen.errorSendFailed")));
          }
        } finally {
          setBusy(false);
        }
        return;
      }
      // ARKADE CORRIDOR → EXTERNAL ON-CHAIN BITCOIN ADDRESS.
      // The recipient is a plain on-chain Bitcoin address and the source is the
      // arkade balance. The direct Arkade→Bitcoin corridor is disabled
      // server-side and instant offboard is unsafe (some vtxos cannot offboard
      // instantly), so always route Lightning→Bitcoin: commit a BTC_LN→BTC
      // SwapKit order (settleTarget = the recipient address) and fund it by
      // paying the bound Lightning invoice out of arkade. It runs as a tracked
      // order — this sheet closes on accept and the pill + BTC-leg pending row
      // report progress, exactly like a stable→BTC swap.
      if (!isArk && !isBolt11 && !isLnurl && !isRemit && isValidBitcoinAddressMainnet(addr)) {
        const owner = await getEthereumAddress();
        if (!owner) {
          failSend(t("screen.BitcoinSendScreen.errorSendFailed"));
          return;
        }
        // Success is claimed only once an ORDER EXISTS. Firing it before the
        // quote+commit round-trip showed the user a sent payment that a
        // rejection then swallowed — no order, no pill, nothing to reconcile.
        // The commit is the cheap half (the funding action runs in the
        // background after it), so awaiting it costs a moment and buys an
        // honest outcome.
        try {
          setBusy(true);
          setErrorMessage(null);
          setInfoMessage(null);
          lockSubmittedAmount(currentSats);
          handOffToPill();
          await sendArkadeToBitcoinViaLightning({ toAddress: addr, sats: currentSats, owner });
          // The committed order's own pill carries it from here.
          movePillRef.current?.handedOff();
          movePillRef.current = null;
        } catch (error: unknown) {
          takeBackFromPill();
          setSubmittedAmountLocked(false);
          // A cancelled passkey is the user's own decision, not a failure.
          if (!isUserCancelledAuth(error)) {
            const isRefused =
              (error instanceof SwapKitV2Error && error.code === "provider_refused") ||
              /solver refused|exposure_cap|provider_at_capacity|insufficient_float/i.test(
                error instanceof Error ? error.message : String(error),
              );
            if (isRefused) {
              // The partner is full: nothing was funded. Say so; the user
              // decides whether to try again or send another way.
              failSend(t("screen.BitcoinSendScreen.errorSendPartnerFull"));
              return;
            }
            failSend(errMsgText(error, t("screen.BitcoinSendScreen.errorSendFailed")));
          }
          return;
        } finally {
          setBusy(false);
        }
        // Committed: the tracked order owns it from here and raises the pill +
        // Bitcoin-rail pending row.
        await closeAndNotifyRefresh();
        return;
      }
      try {
        setBusy(true);
        setErrorMessage(null);
        setInfoMessage(null);
        lockSubmittedAmount(currentSats);
        // The phone rail has no payable string until now: the corridor mints a
        // BOLT11 for this shilling amount and this number, and pays the phone
        // out itself once that invoice settles. Minting moves no money, so a
        // user who stops here has sent nothing.
        let remitInvoice: string | null = null;
        // Held by the send operation itself, not in form state: the Lightning
        // path closes this sheet from its `authenticated` event, long before
        // `sendBitcoin` resolves, and anything the close-reset clears would be
        // gone by the time the nudge below runs.
        let remitSessionId: string | null = null;
        if (isRemit) {
          // A press on this rail either fetches a price or pays one that has
          // already been shown — never both. The button for the first press
          // says price, so it must not be able to move money, whatever the
          // invoice turns out to cost. Deciding that by comparing the invoice
          // against the quote let an equal or cheaper invoice pay straight from
          // the quote button.
          // A bank swap whose order or quote has lapsed is never executed:
          // this press fetches a fresh order and quote and shows them again.
          const pending =
            remitPendingInvoice?.swap && tzPaymentLapsed(remitPendingInvoice.swap.expiresAt)
              ? null
              : remitPendingInvoice;
          if (remitPressOutcome(pending !== null) === "show_price") {
            let created: {
              invoice: string;
              sessionId: string | null;
              receiverName: string | null;
              feeTZS: number | null;
            };
            if (zapRecipient) {
              if (keRecipient && !remitName.trim()) {
                throw new Error(t("screen.BitcoinSendScreen.remitNameLabel"));
              }
              if (zapBandLabel) throw new Error(zapBandLabel);
              let invoice: string;
              if (zapRecipient.provider === "tz") {
                const order = await createTzOrder(remitAmount, zapRecipient.recipient);
                if (order.invoice) {
                  invoice = order.invoice;
                } else if (order.usdc) {
                  // USDC only (a bank): swap the sats into the order's exact
                  // USDC, settled straight to its address. The server prices
                  // the deposit for that exact amount; nothing moves yet.
                  const owner = await getEthereumAddress();
                  const refundAddress = await btcRailRefundAddress("BTC_ARKADE", "arkade");
                  if (!owner || !refundAddress) {
                    throw new Error(t("screen.BitcoinSendScreen.errorSendFailed"));
                  }
                  const { options } = await quoteV2BtcToStable({
                    rail: "BTC_ARKADE",
                    toStable: "USDC_BASE",
                    sats: 0,
                    owner,
                    settleTarget: order.usdc.payTo,
                    refundAddress,
                    settleExact: order.usdc.amount,
                  });
                  const option = options[0];
                  if (!option || !(option.sats > 0)) {
                    throw new Error(t("screen.BitcoinSendScreen.errorRemitRateUnavailable"));
                  }
                  if (maxSpendableSats !== null && option.sats > maxSpendableSats) {
                    throw new Error(t("screen.BitcoinSendScreen.errorExceedsBalance"));
                  }
                  setRemitPendingInvoice({
                    invoice: "",
                    sats: option.sats,
                    sessionId: null,
                    receiverName: zapRecipient.summary,
                    feeTZS: null,
                    swap: {
                      optionId: option.optionId,
                      ...(option.quoteId ? { quoteId: option.quoteId } : {}),
                      settleExact: order.usdc.amount,
                      payTo: order.usdc.payTo,
                      expectedUsdc: option.expectedUsdc,
                      expiresAt:
                        [order.expiresAt, option.validUntilMs]
                          .filter((v): v is number => v !== null)
                          .sort((a, b) => a - b)[0] ?? null,
                    },
                  });
                  setSubmittedAmountLocked(false);
                  setInputMode("sats");
                  setSatsDigits(String(option.sats));
                  setInfoMessage(
                    t("screen.BitcoinSendScreen.remitConfirmTo", { name: zapRecipient.summary }),
                  );
                  return;
                } else {
                  throw new Error(t("screen.BitcoinSendScreen.errorRemitRateUnavailable"));
                }
              } else {
                const zap = await createZapRemitLightningInvoice({
                  country: zapRecipient.country,
                  methodCode: zapRecipient.methodCode,
                  currency: zapRecipient.currency,
                  amount: remitAmount,
                  recipient: zapRecipient.recipient,
                });
                invoice = zap.invoice;
              }
              // The service's price is the invoice itself; it states no separate fee.
              created = {
                invoice,
                sessionId: null,
                receiverName: zapRecipient.summary,
                feeTZS: null,
              };
            } else if (tzRecipient) {
              if (!remitSessionSeedRef.current) {
                remitSessionSeedRef.current = `${Date.now().toString(36)}${Math.random()
                  .toString(36)
                  .slice(2, 8)}`;
              }
              created = await createRemitLightningInvoice({
                amountTZS: remitAmount,
                phoneNumber: tzRecipient,
                // The recipient is part of the identity of this request. Without
                // it a failed press, an edited phone number and the same shilling
                // amount reuse one key, and the corridor may answer the second
                // recipient with the first one's invoice.
                clientReference: `nuri-${remitSessionSeedRef.current}-${tzRecipient.replace(
                  /\D/g,
                  "",
                )}-${remitAmount}`,
              });
            } else {
              throw new Error(t("screen.BitcoinSendScreen.errorInvalidAddress"));
            }
            // The invoice's own figure, never the corridor's `amountSats`: what
            // leaves the wallet is what is written inside the invoice.
            const mintedSats = decodeBolt11Facts(created.invoice).amountSats;
            const mintRefusal = checkRemitInvoice({
              invoiceSats: mintedSats,
              acceptedSats: mintedSats,
              maxSpendableSats,
              minSats: ARKADE_LIGHTNING_MIN_SEND_SATS,
              maxSats: ARKADE_LIGHTNING_MAX_SEND_SATS,
              fundingSatsFor: maxFundAmountSats,
            });
            if (mintRefusal) throw new Error(describeRemitRefusal(mintRefusal));
            setRemitPendingInvoice({
              invoice: created.invoice,
              sats: mintedSats,
              sessionId: created.sessionId,
              receiverName: created.receiverName,
              feeTZS: created.feeTZS,
            });
            setSubmittedAmountLocked(false);
            setInputMode("sats");
            setSatsDigits(String(mintedSats));
            setInfoMessage(
              zapRecipient
                ? t("screen.BitcoinSendScreen.remitConfirmTo", {
                    name: created.receiverName ?? "",
                  })
                : created.receiverName
                  ? t("screen.BitcoinSendScreen.remitConfirmWithName", {
                      name: created.receiverName,
                      fee: created.feeTZS === null ? "\u2014" : groupCount(created.feeTZS),
                    })
                  : t("screen.BitcoinSendScreen.remitConfirmFee", {
                      fee: created.feeTZS === null ? "\u2014" : groupCount(created.feeTZS),
                    }),
            );
            return;
          }
          // Second press: pay the invoice already shown, at the price it was
          // shown at. Re-minting would fetch a new one at a new price.
          if (pending.swap) {
            // The accepted swap into the order's exact USDC. A tracked order:
            // its own pill and rows carry it from here, like any swap.
            if (maxSpendableSats !== null && pending.sats > maxSpendableSats) {
              throw new Error(t("screen.BitcoinSendScreen.errorExceedsBalance"));
            }
            const owner = await getEthereumAddress();
            if (!owner) throw new Error(t("screen.BitcoinSendScreen.errorSendFailed"));
            handOffToPill();
            // A refused commit (an expired option, a moved price) drops the
            // shown quote, so Try again quotes afresh instead of resubmitting it.
            await executeV2BtcToStable({
              rail: "BTC_ARKADE",
              toStable: "USDC_BASE",
              sats: pending.sats,
              optionId: pending.swap.optionId,
              ...(pending.swap.quoteId ? { quoteId: pending.swap.quoteId } : {}),
              quotedReceiveStable: Number(pending.swap.settleExact),
              expectedUsdc: pending.swap.expectedUsdc,
              owner,
              settleTarget: pending.swap.payTo,
              destination: "external",
              settleExact: pending.swap.settleExact,
            }).catch((err) => {
              setRemitPendingInvoice(null);
              throw err;
            });
            movePillRef.current?.handedOff();
            movePillRef.current = null;
            setBusy(false);
            await closeAndNotifyRefresh();
            return;
          }
          const payRefusal = checkRemitInvoice({
            invoiceSats: pending.sats,
            acceptedSats: pending.sats,
            maxSpendableSats,
            minSats: ARKADE_LIGHTNING_MIN_SEND_SATS,
            maxSats: ARKADE_LIGHTNING_MAX_SEND_SATS,
            fundingSatsFor: maxFundAmountSats,
          });
          if (payRefusal) throw new Error(describeRemitRefusal(payRefusal));
          remitInvoice = pending.invoice;
          remitSessionId = pending.sessionId;
        }
        const target: BitcoinSendTarget = isArk
          ? { kind: "ark_send", address: addr, amountSats: currentSats }
          : remitInvoice
            ? { kind: "bolt11", invoice: remitInvoice }
            : isBolt11
              ? { kind: "bolt11", invoice: lightningRequest }
              : isLnurl
                ? { kind: "lnurl", lnurl: lightningRequest, amountSats: currentSats }
                : { kind: "bitcoin_onchain", address: addr, amountSats: currentSats };
        // An unresolved direct send is a wallet-wide uncertainty. Check before
        // starting a new pill or balance hold; the boundary callback re-checks
        // immediately before wallet.send for race safety.
        if (target.kind === "ark_send") await assertDirectArkadeSendCanStart();
        // Money is about to move: the pill takes over from the sheet.
        handOffToPill();
        arkadeLightningSendActiveRef.current = target.kind === "bolt11" || target.kind === "lnurl";
        arkadeSendAttemptIdRef.current += 1;
        arkadePendingIdRef.current = null;
        arkadeLocalPendingIdRef.current = null;
        arkadeSubmittedTxidRef.current = null;
        arkadeSubmittedClosedRef.current = false;
        log(
          `🔐 STEP Arkade_v4=1 step=wallet_send_dispatch kind=${target.kind} sats=${currentSats} src=screens/bitcoin/modals/BitcoinSendScreen.tsx#handleConfirm`,
        );
        if (!arkadeLightningSendActiveRef.current) {
          // Deduct what is leaving before dispatch. A lightning send only knows
          // its final amount once authenticated, so that path arms its own hold.
          bitcoinBalanceStore.holdArkadeOutgoingBalance(
            "send_dispatch",
            currentSats + estimatedFeeSats,
            // The bitcoin_onchain target below is a collaborative exit: its
            // change only settles a round later, so it keeps the long anchor.
            // Every other target on this branch settles with the send itself.
            target.kind === "bitcoin_onchain" ? undefined : OUTGOING_ARKADE_SEND_HOLD_TTL_MS,
          );
        }
        const result =
          target.kind === "ark_send"
            ? await sendDirectArkadeWithReconciliation({
                address: target.address,
                amountSats: target.amountSats,
              })
            : await sendBitcoin(target);
        // The corridor pays the phone once it sees its invoice settled. Telling
        // it now is what makes that prompt rather than leaving the shillings on
        // the server's own polling interval. Fire-and-forget on purpose: the
        // sats have left, and a failed nudge must not read as a failed send.
        if (remitSessionId) {
          void checkRemitPayment(remitSessionId).catch(() => {});
        }
        if (arkadeSubmittedClosedRef.current) {
          const pendingId = arkadePendingIdRef.current;
          const localPendingId = arkadeLocalPendingIdRef.current;
          const submittedTxid = arkadeSubmittedTxidRef.current;
          await removeArkadePending(localPendingId, pendingId, submittedTxid);
          bitcoinBalanceStore.clearArkadeOutgoingBalanceHold("lightning_send_success");
          // A Lightning payment is final when it resolves.
          movePillRef.current?.settleByRows(null);
          movePillRef.current = null;
          try {
            EventBus.emit("bitcoin:refresh");
            EventBus.emit("bitcoin:syncWallet");
          } catch {}
        } else {
          bitcoinBalanceStore.clearArkadeOutgoingBalanceHold("send_success");
          // The board's spinner row: sats are on their way and neither balance
          // nor history shows them yet. Only the lightning path recorded one, so
          // an ark send and a collaborative exit left the user with no sign that
          // anything had happened. Cleared by the reconciler once the send shows
          // up in the transaction list (or confirms on-chain). Direct Arkade
          // success already atomically replaced its boundary placeholder.
          if (result.txid && result.kind !== "ark_send") {
            void PendingBitcoinSendsStore.add({
              txid: result.txid,
              amountSats: currentSats,
              toAddress: addr,
              // This branch is the arkade corridor — the on-chain rail returned
              // above — so the sats leave the arkade balance even when the
              // recipient is an on-chain address.
              source: "arkade",
            }).catch(() => {});
          }
          // sendBitcoin emits bitcoin:refresh + bitcoin:syncWallet on success;
          // closeAndNotifyRefresh re-emits + closes. Double emit is harmless
          // because each listener is idempotent.
          movePillRef.current?.settleByRows(result.txid || null);
          movePillRef.current = null;
          await closeAndNotifyRefresh();
          scheduleSendSuccess(result.txid || result.paymentHash || result.kind);
        }
      } catch (e: any) {
        const pendingId = arkadePendingIdRef.current;
        const localPendingId = arkadeLocalPendingIdRef.current;
        const submittedTxid = arkadeSubmittedTxidRef.current;
        const closedAfterSubmitted = arkadeSubmittedClosedRef.current;
        const directArkadeReconciliationRequired = isDirectArkadeSendReconciliationRequiredError(e);
        // Signed and gone: the pill states the failure. Refused before that:
        // the sheet comes back with its figures and says why.
        if (
          (closedAfterSubmitted || directArkadeReconciliationRequired) &&
          !isUserCancelledAuth(e)
        ) {
          movePillRef.current?.fail();
          movePillRef.current = null;
        } else {
          takeBackFromPill();
        }
        // Once direct wallet.send may have started, the durable local row and
        // outgoing hold are the only safe truth. Never turn an ambiguous spend
        // back into available balance or a retryable form.
        if (!directArkadeReconciliationRequired) {
          bitcoinBalanceStore.revertArkadeOutgoingBalance("send_error");
          if (localPendingId || pendingId || submittedTxid) {
            await removeArkadePending(localPendingId, pendingId, submittedTxid);
          }
        }
        if (directArkadeReconciliationRequired || localPendingId || pendingId || submittedTxid) {
          try {
            EventBus.emit("bitcoin:refresh");
            EventBus.emit("bitcoin:syncWallet");
          } catch {}
        }
        setSubmittedAmountLocked(false);
        // A bolt11 amount is protocol-fixed: offering the user a smaller
        // maximum cannot make that invoice payable.
        if (isArkadeMaxSendAmountError(e) && amountEditable && !isBolt11) {
          const maxAmountSats = Math.max(0, Math.trunc(Number(e.maxAmountSats || 0)));
          if (maxAmountSats > 0) {
            setInputMode("sats");
            setSatsDigits(String(maxAmountSats));
            setErrorMessage(null);
            setInfoMessage(t("screen.BitcoinSendScreen.infoMaxAmountEntered"));
            return;
          }
        }
        // The Ark server only settles VTXOs that are close enough to expiry, so
        // a just-received balance cannot exit onchain yet. Name the wait instead
        // of surfacing the server's raw rejection.
        if (isArkadeVtxoTooFreshError(e)) {
          failSend(formatOnchainTooFreshMessage(Number(e.availableAtMs || 0)));
          return;
        }
        // Diagnostic: dump the raw error in every shape we can extract so
        // we can identify which layer threw it (SDK, http, identity, etc.).
        try {
          const name = e?.name ?? "(no name)";
          const message = e instanceof Error ? e.message : String(e);
          const code = (e?.code ?? e?.cause?.code ?? "(no code)") as unknown;
          const status = (e?.status ?? e?.cause?.status ?? "(no status)") as unknown;
          const cause = e?.cause ? (e.cause.message ?? String(e.cause)) : "(no cause)";
          let jsonDump = "";
          try {
            jsonDump = JSON.stringify(e, Object.getOwnPropertyNames(e || {}));
          } catch {
            jsonDump = "(unserializable)";
          }
          const stack = e?.stack
            ? String(e.stack).split("\n").slice(0, 6).join(" | ")
            : "(no stack)";
          console.log("[BitcoinSendScreen] arkade send threw", {
            name,
            code,
            status,
            cause,
            message,
            stack,
            jsonDump,
          });
        } catch (logErr) {
          console.log(
            "[BitcoinSendScreen] arkade send threw + diagnostic-log also failed",
            String(logErr),
          );
        }
        log("Send error", e);
        // A dismissed passkey prompt is the user's own decision, not a fault:
        // nothing was sent, nothing is broken, and opening a support chat about
        // it is noise. Reset quietly and let them try again when they mean to.
        if (isUserCancelledAuth(e)) {
          if (!closedAfterSubmitted) setErrorMessage("");
          return;
        }
        // Provider/SDK error text is never put in front of the user. The screen
        // says one generic line; the full error goes to support, which opens the
        // chat with the diagnostic dump attached.
        void reportErrorToSupport({
          error: e,
          userMessage: "Bitcoin send failed",
        }).catch(() => {});
        // Closed after submit: the modal is gone, so only the support chat remains.
        if (!closedAfterSubmitted) {
          // A lockup the corridor cannot rebuild is refused before the wallet
          // sends, so the sats are still here — and no retry closes the gap that
          // caused it. Both are things "please try again" gets wrong, so that
          // one class says what actually happened.
          failSend(
            isArkadeLightningLockupMismatchError(e)
              ? t("screen.BitcoinSendScreen.errorLightningLockupUnavailable")
              : t("screen.BitcoinSendScreen.errorSendFailed"),
          );
        }
      } finally {
        arkadeLightningSendActiveRef.current = false;
        arkadePendingIdRef.current = null;
        arkadeLocalPendingIdRef.current = null;
        arkadeSubmittedTxidRef.current = null;
        arkadeSubmittedClosedRef.current = false;
        setBusy(false);
      }
      return;
    };
    void run();
  }, [
    currentSats,
    estimatedFeeSats,
    exceedsBalance,
    maxSpendableSats,
    balanceSats,
    isRecipientBitcoinAddress,
    onchainMinSats,
    bitcoinAddressMinSats,
    arkMinSats,
    lnurlMaxSats,
    // The shilling figure the invoice is minted for. Without it here, confirm
    // would close over the amount as it stood when the recipient was entered.
    remitAmount,
    remitName,
    zapBandLabel,
    abroadDestination,
    remitPendingInvoice,
    setInfoMessage,
    describeRemitRefusal,
    effectiveSendSource,
    amountEditable,
    toAddress,
    lockSubmittedAmount,
    setInputMode,
    setSatsDigits,
    closeAndNotifyRefresh,
    removeArkadePending,
    scheduleSendSuccess,
    handOffToPill,
    takeBackFromPill,
    failSend,
  ]);

  // When the send modal is closed, reset the form state so each open starts fresh.
  useEffect(() => {
    if (!visible) {
      setHandedOff(false);
      console.log("[BitcoinSendScreen] modal closed, resetting form state");
      setToAddress("");
      setSatsDigits("");
      setFiatDigits("");
      setErrorMessage(null);
      setInfoMessage(null);
      setLocalAmountLocked(false);
      setSubmittedAmountLocked(false);
      setSendFailed(false);
      setOverBalanceUnlock(false);
      setRecipientConfirmed(false);
      setRecipientFocused(false);
      setRemitDigits("");
      setRemitQuoting(false);
      setRemitQuoteFailed(false);
      setRemitPendingInvoice(null);
      setRemitName("");
      setRemitNameFocused(false);
      setZapTerms(null);
      setAbroadDestination(null);
      setAbroadOpen(false);
      remitSessionSeedRef.current = "";
    }
  }, [visible, setSatsDigits, setFiatDigits]);

  // The shilling amount belongs to the phone number it was typed against.
  // Leaving it in place when the recipient changes carried one recipient's
  // figure onto the next, and the sats it had already priced with it. The
  // same holds across countries and methods: a TZS figure is not a KES one.
  useEffect(() => {
    setRemitDigits("");
    setRemitPendingInvoice(null);
    setRemitQuoting(false);
    setRemitQuoteFailed(false);
    setZapTerms(null);
  }, [remitRailKey]);

  // The name belongs to the Kenyan number it was typed for.
  useEffect(() => {
    setRemitName("");
  }, [kePhone]);

  // A shilling figure is not a sats figure, and only the corridor knows the rate
  // it will actually mint at. The quote is debounced against the typing and its
  // answer is written into the sats field, which is what the balance check, the
  // corridor limits and the CTA all read — so the phone rail is priced by the
  // same machinery as every other Lightning send rather than beside it.
  //
  // This figure is what the screen SHOWS. What gets paid is the amount inside
  // the invoice minted at confirm, which is re-checked against the balance there.
  useEffect(() => {
    if (!visible || !isRecipientRemitPhone) return;
    // A new shilling figure invalidates an invoice minted for the previous one —
    // and the line naming its payee and fee with it. Left up, that text reads as
    // though it priced the amount now on screen.
    setRemitPendingInvoice(null);
    setInfoMessage(null);
    if (remitAmount <= 0) {
      setSatsDigits("");
      setRemitQuoting(false);
      setRemitQuoteFailed(false);
      return;
    }
    // The fiat half of the toggle is EUR/USD against the BTC price; a shilling
    // amount is neither, so the entry stays on the sats half and the toggle is
    // closed while this rail is selected.
    setInputMode("sats");
    let cancelled = false;
    setRemitQuoting(true);
    setRemitQuoteFailed(false);
    const handle = setTimeout(async () => {
      try {
        let sats: number;
        if (zapProvider === "tz") {
          // Tanzanian orders: the service's own price for the amount; the
          // order's invoice (or the swap quote, for a bank) states the real one.
          const method = TZ_METHODS.find((m) => m.code === zapMethod);
          if (method) setZapTerms({ btcRate: 0, min: method.min, max: method.max });
          sats = (await quoteTzPayout(remitAmount)).sats;
          if (cancelled) return;
        } else if (zapCountry && zapMethod) {
          // ZapRemit has no quote without a recipient, so the shown figure
          // comes from its reference rate; the invoice states the real price.
          const terms = await getZapRemitTerms(zapCountry, zapMethod, remitCurrency);
          if (cancelled) return;
          setZapTerms(terms);
          sats = localToSats(remitAmount, terms.btcRate);
        } else {
          sats = await quoteRemitSats(remitAmount);
        }
        if (cancelled) return;
        setSatsDigits(String(Math.max(0, Math.floor(sats))));
        setRemitQuoteFailed(false);
      } catch {
        if (cancelled) return;
        // No rate, no amount: leaving the previous quote on screen would price
        // this shilling figure at the rate of the last one.
        setSatsDigits("");
        setRemitQuoteFailed(true);
      } finally {
        if (!cancelled) setRemitQuoting(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [
    visible,
    isRecipientRemitPhone,
    zapProvider,
    zapCountry,
    zapMethod,
    remitCurrency,
    remitAmount,
    setSatsDigits,
    setInputMode,
  ]);

  // Preview approval removed; approval starts immediately after building
  // The recipient field is free text, so a typed or pasted invoice reaches here
  // as readily as a scanned one. Both flags are the single choke point for the
  // rest of this screen — the label, the LNURL pay-request fetch, the minimum
  // and the confirm gate all hang off them.
  const recipientFieldLabel = isRecipientBolt11
    ? t("screen.BitcoinSendScreen.lightningInvoiceRecipientLabel")
    : isRecipientLnurl
      ? t("screen.BitcoinSendScreen.lnurlRecipientLabel")
      : isRecipientRemitPhone
        ? t(
            remitCountry === "KE"
              ? "screen.BitcoinSendScreen.phoneRecipientLabelKenya"
              : "screen.BitcoinSendScreen.phoneRecipientLabel",
          )
        : t("screen.BitcoinSendScreen.recipientLabel");
  const isBelowArkadeOnchainMinimum =
    isRecipientBitcoinAddress &&
    !isRecipientBolt11 &&
    !isRecipientLnurl &&
    currentSats > 0 &&
    currentSats < bitcoinAddressMinSats;
  const isBelowArkSendMinimum = isRecipientArk && isBelowVtxoMinimum(currentSats, arkMinSats);

  // Pull the LNURL pay request when the recipient is a lightning address /
  // LNURL, then enforce max(LNURL min, our floor) and pre-fill the amount to
  // that minimum so the user starts above the limit.
  useEffect(() => {
    // Cleared for EVERY recipient change, not only when the recipient stops
    // being an LNURL: replacing one Lightning address with another left the
    // previous provider's band in force through the debounce and the request,
    // so confirm could refuse a valid amount or admit one the new provider had
    // already declared too large.
    setLnurlMinSats(null);
    setLnurlMaxSats(null);
    if (!visible || !isRecipientLnurl) {
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const params = await resolveLnurlPayRequest(normalizedRecipient);
        if (cancelled) return;
        const min = Math.max(
          Math.ceil(params.minSendableMsats / 1000),
          BITCOIN_LNURL_MIN_SEND_SATS,
        );
        setLnurlMinSats(min);
        const max = Math.floor(params.maxSendableMsats / 1000);
        setLnurlMaxSats(Number.isFinite(max) && max > 0 ? max : null);
        if (amountEditable) {
          // Only seed an amount the user has not chosen. A slow endpoint can
          // answer after they have typed, and replacing 2 000 with the
          // provider's 500 just before confirm pays a number they never
          // entered. A figure already above the minimum stands.
          // What the user has actually entered, in whichever field is active:
          // in fiat mode the sats field is empty even when they have typed an
          // amount, and reading it alone replaced their figure with the
          // provider's minimum when a slow endpoint answered.
          const enteredSats = currentSatsRef.current;
          if (!Number.isFinite(enteredSats) || enteredSats < min) {
            setInputMode("sats");
            setSatsDigits(String(min));
          }
        }
      } catch (err) {
        log("[BitcoinSendScreen] LNURL pay request resolution failed", err);
        if (!cancelled) {
          setLnurlMinSats(BITCOIN_LNURL_MIN_SEND_SATS);
          // The resolution failed, so this recipient has stated no ceiling of
          // its own. Carrying the previous one over would hold a new recipient
          // to a limit that was never theirs.
          setLnurlMaxSats(null);
        }
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [visible, isRecipientLnurl, normalizedRecipient, amountEditable, setInputMode, setSatsDigits]);

  // A bolt11 invoice states its own amount, and that amount is what gets paid.
  // Without this the keypad keeps showing the zero the user never typed while
  // confirm pays the invoice — two different numbers on one screen, the larger
  // of which is invisible.
  useEffect(() => {
    if (!visible) return;
    if (!isRecipientBolt11) {
      // Replacing an invoice with an ark or on-chain recipient must give the
      // keypad back: the lock belonged to that invoice's amount, and leaving it
      // on strands the user on a figure they cannot edit for a target that
      // never stated one.
      if (invoiceLockedAmountRef.current) {
        invoiceLockedAmountRef.current = false;
        setLocalAmountLocked(false);
      }
      // The refusal belonged to that invoice too. Carrying it into the next
      // recipient leaves confirm disabled for the rest of the session with
      // nothing on screen explaining why.
      setInvoiceUnpayable(false);
      return;
    }
    try {
      const { amountSats, expiresAt } = decodeBolt11Facts(normalizedRecipient);
      // Expired is unpayable, and it has to say so here: the amount decodes
      // fine, so without this the keypad locks, Confirm enables and the user
      // approves a payment that only fails afterwards.
      if (Number.isFinite(expiresAt) && expiresAt > 0 && Date.now() / 1000 >= expiresAt) {
        throw new Error("lightning invoice has expired");
      }
      setInputMode("sats");
      setSatsDigits(String(amountSats));
      setLocalAmountLocked(true);
      invoiceLockedAmountRef.current = true;
      setInvoiceUnpayable(false);
    } catch {
      // An amountless or undecodable invoice has nothing this rail can pay:
      // the corridor is exact-out and quotes against the invoice's own figure.
      // Say so here rather than at confirm, three steps later.
      invoiceLockedAmountRef.current = false;
      setLocalAmountLocked(false);
      setInvoiceUnpayable(true);
    }
  }, [visible, isRecipientBolt11, normalizedRecipient, setInputMode, setSatsDigits]);

  // Both parties state limits and the amount has to satisfy both, so the floor
  // is the higher and the ceiling the lower. One helper decides it for the
  // keypad, the CTA and the confirm path alike — three copies of this rule is
  // three places for them to disagree about what is payable.
  const lightningBounds = resolveLightningBounds({
    corridorMinSats: isRecipientLnurl
      ? Math.max(BITCOIN_LNURL_MIN_SEND_SATS, ARKADE_LIGHTNING_MIN_SEND_SATS)
      : ARKADE_LIGHTNING_MIN_SEND_SATS,
    corridorMaxSats: ARKADE_LIGHTNING_MAX_SEND_SATS,
    // A BOLT11 states an amount rather than a band, so only an LNURL recipient
    // contributes one.
    providerMinSats: isRecipientLnurl ? lnurlMinSats : null,
    providerMaxSats: isRecipientLnurl ? lnurlMaxSats : null,
  });
  // The phone rail pays over the same Lightning corridor, so the same band
  // governs it. Leaving it out left the min/max guard off the CTA entirely: a
  // below-minimum amount reached minting and came back as a downstream refusal
  // instead of naming the minimum, and an over-maximum one was caught only at
  // confirm.
  // An Arkade-funded send to a Bitcoin address pays a Lightning invoice of the
  // entered figure, so the Lightning ceiling governs it too; its floor is the
  // corridor's (bitcoinAddressMinSats).
  const onLightningBand =
    isRecipientLnurl ||
    isRecipientBolt11 ||
    (isRecipientRemitPhone && !isSwapPayout) ||
    isArkadeToBitcoinAddress;
  const lnurlMinFloorSats = onLightningBand ? lightningBounds.minSats : null;
  const isBelowLnurlMinimum =
    lnurlMinFloorSats != null && currentSats > 0 && currentSats < lnurlMinFloorSats;
  const lightningMaxCeilingSats = lightningBounds.maxSats;
  const isAboveLightningMaximum = onLightningBand && currentSats > lightningMaxCeilingSats;

  // A locked scanned amount that exceeds spendable funds would strand the
  // user on a disabled confirm with a non-editable field. Release the lock
  // once the loaded balance/fee estimate shows the preset is not payable.
  // Bolt11 stays locked: its amount is protocol-fixed, so editing cannot
  // make the invoice payable.
  useEffect(() => {
    if (!visible || amountEditable || isRecipientBolt11) return;
    if (currentSats > 0 && exceedsBalance) {
      setOverBalanceUnlock(true);
    }
  }, [visible, amountEditable, isRecipientBolt11, currentSats, exceedsBalance]);

  // Over the cap because this rail cannot move the rest yet, not because the
  // wallet is short: the sats are there and spend fine offchain. Say the figure
  // this send may use instead of calling the balance insufficient.
  const overBalanceMessage = useMemo(() => {
    // Below the floor the offboard runs, and it reaches only the settleable
    // part. Name that figure rather than the combined cap, which this send
    // cannot actually use.
    if (exceedsSettleableForOffboard && settleableSats !== null) {
      return t("screen.BitcoinSendScreen.maxAvailableLabel", {
        amount: groupCount(Math.max(0, settleableSats - estimatedFeeSats)),
      });
    }
    if (!exceedsBalance || maxSpendableSats === null) return null;
    if (isRecipientBitcoinAddress && balanceSats !== null && balanceSats > maxSpendableSats) {
      return t("screen.BitcoinSendScreen.maxAvailableLabel", {
        amount: groupCount(maxSpendableSats),
      });
    }
    return t("screen.BitcoinSendScreen.errorExceedsBalance");
  }, [
    exceedsBalance,
    exceedsSettleableForOffboard,
    maxSpendableSats,
    isRecipientBitcoinAddress,
    balanceSats,
    settleableSats,
    estimatedFeeSats,
  ]);

  const ctaLabel = busy
    ? t("screen.BitcoinSendScreen.ctaPreparing")
    : remitQuoting
      ? t("screen.BitcoinSendScreen.ctaQuoting")
      : remitQuoteFailed
        ? t("screen.BitcoinSendScreen.errorRemitRateUnavailable")
        : // An invoice this rail cannot pay says so on the button. A disabled CTA
          // with no words is the user staring at a screen that will not move.
          invoiceUnpayable
          ? t("screen.BitcoinSendScreen.errorInvoiceAmountMissing")
          : zapBandLabel
            ? zapBandLabel
            : isBelowArkadeOnchainMinimum
              ? t("screen.BitcoinSendScreen.minimumSatsLabel", {
                  amount: String(bitcoinAddressMinSats),
                })
              : isBelowArkSendMinimum && arkMinSats !== null
                ? t("screen.BitcoinSendScreen.minimumSatsLabel", {
                    amount: String(arkMinSats),
                  })
                : isBelowLnurlMinimum && lnurlMinFloorSats != null
                  ? t("screen.BitcoinSendScreen.minimumSatsLabel", {
                      amount: String(lnurlMinFloorSats),
                    })
                  : isAboveLightningMaximum
                    ? t("screen.BitcoinSendScreen.maximumSatsLabel", {
                        amount: groupCount(lightningMaxCeilingSats),
                      })
                    : // On the phone rail the first press only fetches the corridor's
                      // real price: the quote under it excludes the corridor fee, so
                      // nothing payable has been named yet. The button says that
                      // rather than offering a "Confirm" for a figure about to change.
                      isRecipientRemitPhone && !remitPendingInvoice && currentSats > 0
                      ? t("screen.BitcoinSendScreen.ctaGetQuote")
                      : currentSats > 0
                        ? t("screen.BitcoinSendScreen.ctaConfirmWithFee", {
                            total: groupCount(currentSats + estimatedFeeSats),
                          })
                        : t("screen.BitcoinSendScreen.ctaConfirm");

  // The phone rail reads the other way round from every other one: the figure
  // the user chose is the shilling amount, and the sats underneath are what the
  // corridor quoted for it.
  const primaryAmount = isRecipientRemitPhone
    ? groupCount(remitAmount)
    : isSatsMode
      ? groupCount(currentSats)
      : fiatDigits || "0";
  const fiatImage = fiatImageFor(fiatCode);
  const primaryImage = isRecipientRemitPhone
    ? zapCountry
      ? (flagForIso2(zapCountry) ?? BTC_LOGO)
      : TZS_FLAG
    : isSatsMode
      ? BTC_LOGO
      : fiatImage;
  const secondaryImage = isRecipientRemitPhone ? BTC_LOGO : isSatsMode ? fiatImage : BTC_LOGO;
  // What a screen reader says after each figure: the images carry the unit visually.
  const primaryUnit = isRecipientRemitPhone ? remitCurrency : isSatsMode ? SATS_UNIT : fiatCode;
  const secondaryUnit = isRecipientRemitPhone ? SATS_UNIT : isSatsMode ? fiatCode : SATS_UNIT;

  const recipientLooksValid =
    isRecipientBolt11 ||
    isRecipientLnurl ||
    isRecipientBitcoinAddress ||
    isRecipientArk ||
    isRecipientRemitPhone;
  // `lennard` or `lennard.nuri.eth`: a Nuri user, paid at the address the Nuri
  // directory lists for the rail this sheet pays from (on-chain or Arkade).
  // Their `@nuri.com` Lightning address cannot receive yet, so it is never the
  // destination picked here.
  const recipientNuriUsername = recipientLooksValid ? null : toNuriUsername(trimmedToAddress);
  // Kenya pays a named recipient: the recipient stage stays up until a name is in.
  const needsRemitName = kePhone !== null;
  const remitNameMissing = needsRemitName && !remitName.trim();
  // A destination from the abroad sheet is a finished recipient.
  const manualEntryActive =
    !abroadDestination &&
    (presetRecipientEmpty || needsRemitName) &&
    (!recipientConfirmed || recipientFocused || remitNameFocused || remitNameMissing);
  // One suggestion per contact: the destination this wallet pays cheapest.
  const suggestionCost = useMemo(() => bitcoinSendCost(effectiveSendSource), [effectiveSendSource]);
  // A recipient that is a saved contact shows by name (picked, scanned or pasted).
  const savedContacts = useAddressBookContacts(visible);
  const savedRecipient = useMemo(
    () => savedContactFor(savedContacts, trimmedToAddress, acceptsBitcoinSend),
    [savedContacts, trimmedToAddress],
  );
  const headerTitle =
    availableSatsDisplay == null
      ? t("screen.BitcoinSendScreen.headline")
      : t("screen.BitcoinSendScreen.headlineWithBalance", {
          amount: groupCount(availableSatsDisplay),
        });
  const handleRecipientNext = async () => {
    try {
      recipientFieldRef.current?.blur();
    } catch {}
    try {
      Keyboard.dismiss();
    } catch {}
    if (recipientNuriUsername) {
      const submitted = trimmedToAddress;
      const ticket = usernameLookupGate.current.begin(submitted);
      const stillCurrent = () => usernameLookupGate.current.isCurrent(ticket, toAddressRef.current);
      setResolvingUsername(true);
      setErrorMessage(null);
      try {
        const destination = nuriUsernameDestination(
          await resolvePayRecipient(recipientNuriUsername),
          sendSource,
        );
        // The user replaced the name (or closed the sheet) while this ran:
        // this answer is for a recipient that is no longer on screen.
        if (!stillCurrent()) return;
        if (!destination) {
          setErrorMessage(t("screen.BitcoinSendScreen.errorUsernameNotFound"));
          return;
        }
        nuriRecipientRef.current = { username: recipientNuriUsername, address: destination };
        setToAddress(destination);
      } catch {
        // An outage is not an unknown user: say we could not check.
        if (stillCurrent()) {
          setErrorMessage(t("screen.BitcoinSendScreen.errorUsernameLookupFailed"));
        }
        return;
      } finally {
        if (stillCurrent()) setResolvingUsername(false);
      }
    }
    setRecipientConfirmed(true);
  };

  return (
    <>
      <DsSheetHost
        visible={visible && !handedOff}
        onClose={() => void closeAndNotifyRefresh()}
        mode="full"
        onOpenComplete={() => {
          if (presetRecipientEmpty) recipientFieldRef.current?.focus();
        }}
      >
        <Header safeAreaTop chrome="canvas">
          <Topbar surface="transparent" layout="fluid">
            <TopbarTitle>{headerTitle}</TopbarTitle>
            <TopbarTrailing>
              <IconButton
                icon="cross"
                variant="soft"
                accessibilityLabel={t("common.close")}
                onPress={() => void closeAndNotifyRefresh()}
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
            paddingTop="lg"
            paddingBottom={keypadFit.compact ? "sm" : "lg"}
            fill="grow"
          >
            <View direction="column" align="stretch" justify="start" gap="sm">
              {manualEntryActive ? (
                <TextField
                  ref={recipientFieldRef}
                  value={toAddress}
                  onChangeText={setToAddress}
                  autoCapitalize="none"
                  disabled={busy}
                  onFocus={() => setRecipientFocused(true)}
                  onBlur={() => setRecipientFocused(false)}
                  accessibilityLabel={recipientFieldLabel}
                >
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
                    {zapDestination
                      ? zapDestination.summary
                      : isRecipientRemitPhone
                        ? formatTanzanianMobileNumber(trimmedToAddress)
                        : savedRecipient
                          ? recipientWithName(savedRecipient.label, trimmedToAddress)
                          : trimmedToAddress}
                  </Text>
                </View>
              )}
              {manualEntryActive && needsRemitName ? (
                <TextField
                  value={remitName}
                  onChangeText={(name) => {
                    setRemitName(name);
                    // An invoice minted for one name is not one for the next.
                    setRemitPendingInvoice(null);
                    setInfoMessage(null);
                  }}
                  placeholder={t("screen.BitcoinSendScreen.remitNameLabel")}
                  autoCapitalize="words"
                  disabled={busy}
                  onFocus={() => setRemitNameFocused(true)}
                  onBlur={() => setRemitNameFocused(false)}
                  accessibilityLabel={t("screen.BitcoinSendScreen.remitNameLabel")}
                />
              ) : null}
              {/* Every payable contact while the field is empty, then the ones matching what is typed. */}
              <AddressBookSuggestions
                active={visible && manualEntryActive}
                query={toAddress}
                accepts={acceptsPayableBitcoin}
                cost={suggestionCost}
                payUsername
                onPick={({ destination, username }) => {
                  // A Nuri contact: their username, looked up on Next.
                  setToAddress(username ? `@${username}` : destination.raw);
                  setErrorMessage(null);
                }}
              />
              {manualEntryActive && !trimmedToAddress ? (
                <Button
                  size="lg"
                  variant="soft"
                  disabled={busy}
                  onPress={() => {
                    try {
                      recipientFieldRef.current?.blur();
                      Keyboard.dismiss();
                    } catch {}
                    setAbroadOpen(true);
                  }}
                >
                  <ButtonText>{t("screen.BitcoinSendScreen.ctaPayAbroad")}</ButtonText>
                </Button>
              ) : null}
            </View>

            {manualEntryActive ? (
              <View direction="column" align="stretch" justify="start" gap="sm" fill="grow">
                {errorMessage ? (
                  <Text size="md" emphasis align="center">
                    {errorMessage}
                  </Text>
                ) : null}
              </View>
            ) : (
              <>
                <AmountDisplay
                  primaryAmount={primaryAmount}
                  primaryImage={primaryImage}
                  primaryUnit={primaryUnit}
                  secondary={{
                    amount: secondaryAmount,
                    image: secondaryImage,
                    unit: secondaryUnit,
                  }}
                  onToggle={toggleInputMode}
                  // A BOLT11's amount is protocol-fixed and lives in the sats
                  // field alone. Switching to fiat left the screen and the CTA
                  // reading zero while the service still paid the invoice's
                  // real amount — two numbers on one screen, the true one
                  // invisible. Nothing to switch between, so nothing to press.
                  // A failed send holds its amount and reason until Try again.
                  toggleDisabled={
                    invoiceLockedAmountRef.current || isRecipientRemitPhone || sendFailed
                  }
                  message={
                    errorMessage
                      ? { text: errorMessage, tone: "alert" }
                      : exceedsBalance
                        ? { text: overBalanceMessage, tone: "alert" }
                        : infoMessage
                          ? { text: infoMessage, tone: "info" }
                          : null
                  }
                />

                {amountEditable ? (
                  <AmountKeypad
                    compact={keypadFit.compact}
                    onDigit={handleDigit}
                    onDecimal={isSatsMode ? undefined : handleDecimal}
                    onDelete={handleDelete}
                  />
                ) : null}
              </>
            )}
          </View>
        </Scroll>

        <Footer safeAreaBottom direction="column" align="stretch" paddingBottom="sm" paddingX="lg">
          {manualEntryActive ? (
            <Button
              size="lg"
              variant="solid"
              accent="lilac"
              onPress={() => void handleRecipientNext()}
              disabled={
                busy ||
                resolvingUsername ||
                remitNameMissing ||
                (!recipientLooksValid && !recipientNuriUsername)
              }
            >
              <ButtonText>{t("screen.BitcoinSendScreen.ctaNext")}</ButtonText>
            </Button>
          ) : (
            <Button
              size="lg"
              variant="solid"
              accent="lilac"
              onPress={sendFailed ? clearSendFailure : handleConfirm}
              disabled={
                busy ||
                (!sendFailed &&
                  (exceedsBalance ||
                    exceedsSettleableForOffboard ||
                    isBelowArkadeOnchainMinimum ||
                    isBelowArkSendMinimum ||
                    isBelowLnurlMinimum ||
                    isAboveLightningMaximum ||
                    invoiceUnpayable ||
                    zapBandLabel !== null ||
                    remitQuoting ||
                    remitQuoteFailed ||
                    (currentSats <= 0 && !isRecipientBolt11)))
              }
            >
              <ButtonText>{sendFailed ? t("common.tryAgain") : ctaLabel}</ButtonText>
            </Button>
          )}
        </Footer>
      </DsSheetHost>
      <PayoutAbroadSheet
        visible={visible && !handedOff && abroadOpen}
        payWith="bitcoin"
        onClose={() => setAbroadOpen(false)}
        onDone={(destination) => {
          setAbroadDestination(destination);
          setAbroadOpen(false);
          setToAddress("");
          setRemitName("");
          setRecipientConfirmed(true);
          setErrorMessage(null);
          setInfoMessage(null);
        }}
      />
    </>
  );
}
