// @screen app.home
// Total Balance groups the real accounts into Bitcoin, Cash and Card & Banking.
// Rows select the first rail in each fixed carousel pair; the header returns
// from any rail to Total Balance. Individual rail actions stay independent.
//
// Balance sources: card/arkade-sats/wallet/rate come from the headless balance
// drivers, which run whether or not this screen is mounted; the legacy on-chain
// sats and the Wirex/wallet activation flags are read straight from their
// singleton stores.
//
// This is the app's only screen, so everything that used to depend on a tab
// being mounted lives here: the Wirex readiness poll, the support deep link's
// card-detail drain, and the overlay teardown the biometric lock relies on.
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { type ImageSourcePropType, Platform, StyleSheet, View as RNView } from "react-native";
import { formatUnits } from "viem";
import {
  type Accent,
  Button,
  ButtonText,
  Header,
  IconButton,
  List,
  ListAction,
  ListActionLeadingAvatar,
  ListActionText,
  ListActionTextMuted,
  ListActionTrailIcon,
  ListActionTrailingText,
  ListSeparator,
  Pressable,
  Screen,
  Scroll,
  Text,
  Topbar,
  TopbarTitle,
  TopbarTrailing,
  View,
} from "@ds";
import BalanceRegion from "../../components/BalanceRegion";
import HomeCardCarousel from "../../components/HomeCardCarousel";
import ChoiceSheet from "../../components/ChoiceSheet";
import ReceiveModal from "../../components/ReceiveModal";
import LightningInvoiceSheet from "../../components/LightningInvoiceSheet";
import NotificationBadge from "../../components/NotificationBadge";
import { useSupportUnreadCount } from "../../lib/nostr/useSupportUnreadCount";
import { createArkadeLightningInvoice } from "../../services/arkade/ArkadeLightningReceiveService";
import { groupCount } from "../../lib/formatting";
import type { SwapAssetId } from "../../services/swapkit/SwapContract";
import {
  BTC_ONCHAIN_ASSET,
  EURC_BASE_TOKEN,
  USDC_BASE_TOKEN,
} from "../../services/swapkit/SwapKitStableAssets";
import { getBalancesSnapshot, subscribeBalances } from "../../services/app/BalanceDriversService";
import LogoutConfirmSheet from "../../components/LogoutConfirmSheet";
import { requestUserLogout } from "../../services/app/UserLogoutService";
import { EURC_SCAN_TOKEN, USDC_SCAN_TOKEN } from "../../services/balance/transactions/onchainScan";
import { walletBalanceStore } from "../../services/balance/WalletBalanceStore";
import { usdcBalanceStore } from "../../services/balance/UsdcBalanceStore";
import { CURRENCIES, resolveFiatCode, type FiatCode } from "../../lib/tokens";
import {
  UNKNOWN_FIGURE,
  convertFiat,
  fiatToSatsFrom,
  formatFiat,
  heldWithHome,
  satsToFiatIn,
  sumKnown,
} from "../../lib/currency/displayFiat";
import { useHomeCurrency } from "../../lib/currency/useHomeCurrency";
import { t } from "../../lib/i18n";
import { toSatsFromBtcAmount } from "../../lib/amounts";
import { BASE_CHAIN_ID, BASE_EURC, BASE_USDC } from "../../config/network";

// Every rail is drawn with the mark the money is actually known by, not a
// generic icon — the two fiat flags from the design system's eur.svg / usa.svg,
// and each network's own logo for the rest. All eight are 512px RGBA circles
// bleeding to the edge, so one row cannot sit differently from the next. PNG
// because the DS avatar takes an image source, and RN's Image cannot render SVG.
const LIGHTNING_LOGO = require("../../assets/rails/lightning.png");
// The card's two faces have a logo each — the same Visa mark over the currency's
// own flag. The plain mark stays on the board row, where the card is one thing.
const SEPA_LOGO = require("../../assets/rails/sepa.png");
import { ENS_PARENT_DOMAIN } from "../../config/constants";
import { BTC_LOGO, EUR_FLAG, USD_FLAG, VISA_LOGO } from "../../lib/railMarks";
import { getEthereumAddress } from "../../lib/secureKeyStorage";
import { getArkadeLnurlStatusPersisted } from "../../services/arkade/ArkadeLnurlService";
import { emitArkadeOpenUnlockWallet } from "../../services/arkade/ArkadeReceiveUnlockService";
import type { ArkadeLnurlStatus } from "../../services/arkade/types/lnurl";
import { useArkadeReceiveUnlockState } from "../bitcoin/hooks/useArkadeReceiveUnlock";
import { getRates, type FxRates } from "../../services/pricing/FxRateService";
import { bitcoinBalanceStore } from "../../services/bitcoin/BitcoinBalanceStore";
import {
  addArkadeWalletSummaryListener,
  getArkadeWalletSummarySnapshot,
  removeArkadeWalletSummaryListener,
} from "../../services/arkade/ArkadeWalletService";
import { walletService } from "../../services/bitcoin/WalletService";
import {
  boardOnchainToArkade,
  getOnchainToArkadeTransferableSats,
} from "../../services/bitcoin/BtcRailTransferService";
import { sendArkadeToBitcoinViaLightning } from "../../services/swapkit/SwapKitV2ArkadeToBtcService";
import { hydrateMusig2Address } from "../../services/bitcoin/BitcoinBootstrapService";
import { EventBus } from "../../services/events/AppEventBusService";
import { useWirexCard } from "../wirex/hooks/useWirexCard";
import { useWalletSendFlow } from "../wallet/hooks/useWalletSendFlow";
import SendRecipientSheet from "../../components/send/SendRecipientSheet";
import type { SendBalanceOption } from "../../components/send/SendFromRow";
import { useAddressBookContacts } from "../../components/AddressBookSuggestions";
import { contactAvatar } from "../../lib/addressBook/petAvatar";
import type { Contact, Destination } from "../../lib/addressBook/contact";
import { checkEvmRecipient } from "../../lib/send/evmRecipientCheck";
import { scannedSend } from "../../lib/send/scannedSend";
import { namesEvmNetwork, networkOfChainId, networkOfPrefix } from "../../lib/send/evmNetworks";
import { evmRecipientLookup } from "../../services/pay/evmRecipientLookup";
import { type PayIntent, payIntentBalances, payIntentRecipient } from "../../lib/pay/payIntent";
import { PayIntentGate, fencePayIntentResets } from "../../lib/pay/payIntentGate";
import { takePayIntent } from "../../lib/pay/payIntentStore";
import { resolveEnsName } from "../../lib/qr/resolveEns";
import {
  ark as arkDestination,
  baseEvm as baseDestination,
  namedEvm as namedEvmDestination,
  bitcoin as bitcoinDestination,
  evm as evmDestination,
  lightning as lightningDestination,
  parseRecipientInput,
} from "../../lib/send/recipientInput";
import {
  SEND_BALANCES,
  type SendBalance,
  type SendRecipient,
  defaultSendBalance,
  isBitcoinBalance,
  isSwapRoute,
  recipientFromDestinations,
  recipientRoute,
  routeFor,
  tokenDestination,
} from "../../lib/send/sendRouting";
import WalletSendStablecoinModal from "../wallet/modals/WalletSendStablecoinModal";
import QrScannerModal from "../../components/QrScannerModal";
import { tanQrDestination, type ZapRemitDestination } from "../../lib/remit/zapremitForm";
import { useWirexCardLifecycle } from "../wirex/hooks/useWirexCardLifecycle";
import { useWirexSendFlow } from "../wirex/hooks/useWirexSendFlow";
import { ADD_PAYOUT_CARD_KEY, useCardPayoutFlow } from "../wirex/hooks/useCardPayoutFlow";
import WirexAppleWalletModal from "../wirex/modals/WirexAppleWalletModal";
import type { WirexBankCounterparty } from "../../lib/wirex/cardTransactions";
import SepaRecipientModal from "../wirex/modals/SepaRecipientModal";
import SepaAmountConfirmationModal from "../wirex/modals/SepaAmountConfirmationModal";
import CardPayoutAddModal from "../wirex/modals/CardPayoutAddModal";
import CardPayoutAmountModal from "../wirex/modals/CardPayoutAmountModal";
import WirexCardTransactionsModal from "../wirex/WirexCardTransactionsModal";
import BitcoinSendScreen from "../bitcoin/modals/BitcoinSendScreen";
import BitcoinTransactionsModal from "../bitcoin/modals/BitcoinTransactionsModal";
import WalletTransactionsModal from "../wallet/modals/WalletTransactionsModal";
import {
  isAwaitingReplacementCard,
  isWirexBankReady,
  isWirexCardReady,
} from "../../lib/wirex/cardState";
import { mayRevealCardSecrets, visibleBankDetails } from "../../lib/wirex/accountBlocked";
import { useWirexOnboarding } from "../wirex/hooks/useWirexOnboarding";
import WirexEmailEntryModal from "../wirex/modals/WirexEmailEntryModal";
import WirexCardDetailsModal from "../wirex/WirexCardDetailsModal";
import { detailsSheetCardId } from "../../lib/wirex/cardState";
import MoveSheet, { type MoveOutcome } from "./MoveSheet";
import { cardCreditForMove, cardSettleWalletRail, cardSwapTargetFor } from "./moveBookkeeping";
import { moveDestinationsFor as moveDestinationsForKey, moveSourcePick } from "./movePairs";
import { stableAmountText } from "../../lib/amounts";
import {
  DIRECT_SWAP_SETTLED_EVENT,
  type DirectSwapSettled,
} from "../../services/swapkit/SwapKitDirectEvmSwapService";
import AssetScreen, {
  AssetActivityList,
  type WealthAssetView,
  type WealthBalanceRow,
  type WealthPendingRow,
} from "./AssetScreen";
import {
  MONEY_RAILS,
  MoneyInFlightStore,
  type MoneyInFlight,
  type MoneyRail,
} from "../../services/money/MoneyInFlightStore";
import { inFlightAsWalletTransfers, inFlightRowsFor } from "../../services/money/inFlightRows";
import WalletTopUp from "./WalletTopUp";
import type { PayWalletSettle } from "../../services/pay/PayWalletSwapService";
import {
  clearPendingHomeRail,
  HOME_OPEN_RAIL_EVENT,
  type RailKey,
  takePendingHomeRail,
} from "./rails";
import { homeCarouselEligibleKey, ungroupedCount } from "./homeCarousel";
import { applyVerifiedHomeHandle } from "./homeIdentity";
import SettingsScreen from "../settings/SettingsScreen";
import AddressBookScreen from "../addressBook/AddressBookScreen";
import EsimScreen from "../esim/EsimScreen";
import { startEsimTracking } from "../../services/esim/EsimService";
import type { SaveOffer, SendRoute } from "../addressBook/addressBookModel";
import { isValidEvmAddress } from "../../lib/validation";
import { getAddressBook } from "../../services/addressBook/AddressBookService";
import { verificationRow, wirexActivationStep } from "../settings/settingsModel";
import { closeSettings, openSettings, useSettingsOpen } from "../settings/settingsVisibility";
import { homeGroupOf, homeOverviewGroups, overviewFigure } from "./homeOverview";
import { useCardDetailDeepLink } from "./hooks/useCardDetailDeepLink";
import { useWirexCardReadyPoll } from "./hooks/useWirexCardReadyPoll";
import { useBitcoinBuyFlow } from "../bitcoin/hooks/useBitcoinBuyFlow";
import MercuryoBuyBitcoinModal from "../bitcoin/modals/MercuryoBuyBitcoinModal";
import SweepClaimSheet from "../swapkit/SweepClaimSheet";
import { checkSwapKitSweep } from "../../services/swapkit/SwapKitV2SweepService";
import type { SwapKitV2SweepResult } from "../../services/swapkit/SwapKitV2SweepService";
import { wirexAccountService } from "../../services/wirex/WirexAccountService";
import {
  WirexWithdrawBusyError,
  WirexWithdrawUnconfirmedError,
  type WirexWithdrawAsset,
  wirexService,
} from "../../services/wirex/WirexService";
import { autoSwapAmount, cardSwapStep, foundMoneyAmount } from "../../lib/wirex/cardAutoSwap";
import { errorWithId } from "../../lib/OperationLogUtils";
import { reportErrorToSupport } from "../../lib/support/reportErrorToSupport";
import { isUserCancelledAuth } from "../../lib/support/isUserCancelledAuth";
import { sendDollarToCard, sendEuroToCard } from "../../services/wallet/CardTransferService";
import { withCardTransferPill } from "../../services/wallet/CardTransferPill";
import {
  parkOptimisticMove,
  rememberOptimisticMove,
  settleOptimisticMove,
  takeEarlySettlement,
  takeOptimisticMove,
} from "../../lib/balance/pendingOptimisticMoves";

type Rail = {
  key: RailKey;
  label: string;
  /** The rail's own logo — every rail has one, so no rail draws an icon. */
  image: number;
  /** The Send accent on this rail's detail screen. */
  accent: Accent;
  /** This rail's balance in its own unit, formatted. */
  amount: string;
  /**
   * The same balance as a number — what a move from this rail may spend. Null
   * when it is genuinely UNKNOWN, which is not the same as zero: a cap invented
   * from a figure nobody has read yet is a cap on the wrong money.
   */
  available: number | null;
  /** False for a rail whose balance is already stated by another row. */
  showAmount?: boolean;
  /** One ungrouped line for compact balance lists. */
  listFigure: string;
  /** The balance in the display currency, used only for visual descending order. */
  homeValue: number | null;
  /** The same balance converted to the other currency, formatted. */
  converted: string;
  /**
   * The same two figures written with the currency glyph — what the balance
   * region states. A row has a whole line for its figure and states the ISO
   * code; the region's figure is 3xl, where three letters crowd the number off
   * the line.
   */
  glyph: { amount: string; converted: string };
};

// Stable identity: a fresh array literal would re-run the feed load on every
// render of the transactions modal.
const IBAN_HISTORY_RAILS: Array<"card" | "bank" | "deposits"> = ["bank"];

declare const __DEV__: boolean | undefined;

// The debug hub's way in. It hung on the Nuri logo while the tabs existed; the
// greeting is this screen's equivalent — a title nobody taps by accident eight
// times in under a second.
const DEBUG_UI_ENABLED = typeof __DEV__ !== "undefined" && __DEV__ === true;
const DEBUG_TAP_THRESHOLD = 8;
const DEBUG_TAP_TIMEOUT_MS = 800;

// iOS cannot present a sheet in the same tick another is dismissed (#522).
const MODAL_HANDOFF_DELAY_MS = Platform.OS === "ios" ? 350 : 0;

// What each rail is called in the swap contract. This is only the NAME: which
// pairs actually work is answered by pricing them, never by a table here.
//
// Both bitcoin rows carry the app's one Bitcoin identity — the engines resolve
// the wallet that funds or receives a swap themselves, and the contract has no
// asset for the legacy on-chain one. A rail with no name here is a balance no
// swap engine can address, so the Move sheet transfers it instead of pricing
// it.
// The rails counted in dollars. Everything else on this screen is the home
// currency or sats, so this is the one question a figure has to ask before it
// picks a formatter or a conversion.
// The card counts in the user's main currency, which it settles in.
const railFiat = (key: string | null | undefined, home: FiatCode): FiatCode =>
  key === "dollar" ? "USD" : isCardRail(key) ? home : "EUR";
// The Wirex account, whichever face names it.
const isCardRail = (key: string | null | undefined) => key === "iban" || key === "visa";
const isBtcRail = (key: string | null | undefined) => key === "arkade" || key === "onchain";

// A send that swaps on the way: the Move card with the recipient as its fixed
// destination. `fiat` is what they receive, null for Bitcoin.
const SEND_RECIPIENT_RAIL = "recipient";
type SendSwapTarget = {
  recipient: SendRecipient;
  address: string;
  fiat: "EUR" | "USD" | null;
  asset: SwapAssetId;
  /** A payment request: exactly this arrives (sats for Bitcoin). */
  exactReceive?: number;
};
// How long an amount screen takes to cover the screen it opened over, before
// that one closes underneath it (the sheet's entering animation).
const SEND_SCREEN_HANDOVER_MS = 400;
/** Which amount screen pays a recipient from a balance. */
const sendScreenOf = (
  balance: SendBalance,
  recipient: SendRecipient,
): "wallet" | "bitcoin" | "move" => {
  const route = recipientRoute(balance, recipient);
  if (route?.kind === "payout-direct") return isBitcoinBalance(balance) ? "bitcoin" : "wallet";
  if (route?.kind === "evm-direct") return "wallet";
  if (route?.kind === "bitcoin-direct") return "bitcoin";
  return "move";
};
const shortAddress = (address: string) =>
  address.length > 14 ? `${address.slice(0, 6)}\u2026${address.slice(-4)}` : address;

const RAIL_SWAP_ASSET: Partial<Record<RailKey, SwapAssetId>> = {
  wallet: EURC_BASE_TOKEN.asset,
  dollar: USDC_BASE_TOKEN.asset,
  arkade: BTC_ONCHAIN_ASSET,
  onchain: BTC_ONCHAIN_ASSET,
};

// One figure, two writings. Everywhere an amount shares its line with other
// text — a row, a sheet, a history entry — it states the ISO code, which reads
// the same in every language. The balance region is the exception: its figure is
// 3xl and alone on its line, so it states the glyph and a long balance still
// fits. The digits themselves are formatted once, for both writings.
const BTC_GLYPH = "₿";
const satsDigits = (n: number) => groupCount(n);

const subscribeBitcoinBalance = (listener: () => void) =>
  bitcoinBalanceStore.subscribe(() => listener());
const getBitcoinBalanceSnapshot = () => bitcoinBalanceStore.getSnapshot();
const subscribeAddress = (listener: () => void) => walletService.subscribeAddress(() => listener());
const getAddressSnapshot = () => walletService.getAddressSnapshot();

export type UnifiedHomeScreenProps = {
  // The handle this session just signed in as, when the sign-in itself resolved
  // one (a `/@handle` link). It is the only source that is already available at
  // first paint — everything else has to wait for the LNURL status fetch — so the
  // greeting starts from it instead of showing its nameless fallback first.
  signedInHandle?: string | null;
};

const UnifiedHomeScreen: React.FC<UnifiedHomeScreenProps> = ({ signedInHandle }) => {
  // Parity: Carousel is the only home layout on every platform. It was web-only,
  // so Android/iOS kept the old vertical list — but HomeCardCarousel is native
  // RN (horizontal ScrollView + snapToInterval) and runs identically on native.
  const homeCarouselEnabled = true;
  // Every figure comes from the headless drivers, so the screen needs no parent
  // to feed it and nothing has to stay mounted for a balance to stay fresh.
  const balances = useSyncExternalStore(subscribeBalances, getBalancesSnapshot);
  const cardBalance = balances.cardBalanceEur ?? 0;
  const bitcoinBalanceSats = balances.bitcoinSats;
  const walletBalance = balances.walletBalanceEur;
  const btcFiatRate = balances.btcFiatRate;
  // The display currency every converted figure is stated in. The BTC rate may
  // briefly still be quoted in the previous one after a switch; the helpers
  // bridge that with FX (or say "unknown") until the store re-reads it.
  const home = useHomeCurrency();
  const btcRateCurrency = resolveFiatCode(balances.btcFiatCurrency);
  const [homeIdentity, setHomeIdentity] = useState(() =>
    applyVerifiedHomeHandle(null, signedInHandle, ENS_PARENT_DOMAIN),
  );
  const username = homeIdentity?.username ?? null;
  const ensName = homeIdentity?.ensName ?? null;
  const [openRail, setOpenRail] = useState<RailKey | null>(null);
  // Explicit group/X navigation and app-wide resets cancel old carousel work.
  // Swipes update selection without interrupting the active gesture.
  const [carouselNavigationRevision, setCarouselNavigationRevision] = useState(0);
  const [receiveRail, setReceiveRail] = useState<RailKey | null>(null);
  const [showLightningInvoiceSheet, setShowLightningInvoiceSheet] = useState(false);
  const [evmAddress, setEvmAddress] = useState<string | null>(null);

  const [fxRates, setFxRates] = useState<FxRates | null>(null);
  // Real FX rates, so held euros and dollars can join the display-currency
  // total. A missed read is retried on the next display-currency switch.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `home` is the retry trigger, not a value read
  useEffect(() => {
    if (fxRates) return;
    let cancelled = false;
    getRates()
      .then((rates) => {
        if (!cancelled) setFxRates(rates);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [home, fxRates]);
  const bitcoinSnapshot = useSyncExternalStore(subscribeBitcoinBalance, getBitcoinBalanceSnapshot);
  const addressSnapshot = useSyncExternalStore(subscribeAddress, getAddressSnapshot);
  const wirex = useWirexCard();
  const settingsOpen = useSettingsOpen();
  const [addressBookOpen, setAddressBookOpen] = useState(false);
  const [esimOpen, setEsimOpen] = useState(false);
  // eSIM orders this wallet paid are claimed app-wide, not only while the eSIM
  // page is open: a paid order must always end up as an installable eSIM.
  useEffect(() => startEsimTracking(), []);
  const supportUnread = useSupportUnreadCount();
  // The account email is pinned during Wirex onboarding; Settings lists it only
  // when there is one.
  const debugTapCountRef = useRef(0);
  const debugTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The Move card's hand-off waits out the closing chooser (see `openMove`), so
  // the wait outlives the tap: a reset arriving inside it has nothing to close
  // yet, and the card would open afterwards on rails chosen before the takeover.
  const moveHandoffTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelMoveHandoff = useCallback(() => {
    if (moveHandoffTimerRef.current) {
      clearTimeout(moveHandoffTimerRef.current);
      moveHandoffTimerRef.current = null;
    }
  }, []);
  // Opening a sheet as another closes (iOS cannot present both in one tick).
  // One timer for all of them, so the app-wide reset cancels any that is
  // still waiting instead of opening it over a lock or a logout.
  const handOff = useCallback(
    (open: () => void) => {
      cancelMoveHandoff();
      moveHandoffTimerRef.current = setTimeout(() => {
        moveHandoffTimerRef.current = null;
        open();
      }, MODAL_HANDOFF_DELAY_MS);
    },
    [cancelMoveHandoff],
  );

  const handleGreetingPress = useCallback(() => {
    if (!DEBUG_UI_ENABLED) return;
    debugTapCountRef.current += 1;
    if (debugTapTimerRef.current) clearTimeout(debugTapTimerRef.current);
    debugTapTimerRef.current = setTimeout(() => {
      debugTapCountRef.current = 0;
      debugTapTimerRef.current = null;
    }, DEBUG_TAP_TIMEOUT_MS);
    if (debugTapCountRef.current < DEBUG_TAP_THRESHOLD) return;
    debugTapCountRef.current = 0;
    if (debugTapTimerRef.current) {
      clearTimeout(debugTapTimerRef.current);
      debugTapTimerRef.current = null;
    }
    try {
      EventBus.emit("debug:openHub");
    } catch {}
  }, []);
  // Issuing, closing, revealing and the Apple Wallet add for the account's card.
  // It owns the details sheet, so `reveal` here is that sheet's state.
  const lifecycle = useWirexCardLifecycle(wirex);
  const reveal = lifecycle.reveal;
  // Approval and card issuance both land asynchronously and through no channel
  // the app listens on, so the rails only flip on their own because of this.
  const readiness = useWirexCardReadyPoll(wirex);
  // Wirex is the only banking partner, so the board's "Add virtual account"
  // row IS its signup: it shows while the user has no account, and the
  // "Visa and IBAN" row replaces it once they do.
  const onboarding = useWirexOnboarding({
    onKycFinished: readiness.onKycFinished,
    username,
  });
  // Euro and Dollar send through the wallet's own flow — the choice sheet,
  // the scanner and the transfer sheet are the production ones.
  const walletSend = useWalletSendFlow();
  // Withdraw + SEPA for the two Wirex faces.
  const wirexBankReady = isWirexBankReady(wirex);
  const wirexSend = useWirexSendFlow({ bankReady: wirexBankReady });
  const cardPayout = useCardPayoutFlow(handOff);
  // Subscribe-only: the App-level monitor owns the refreshing. Read here for the
  // arkade rail's pending-sweep row.
  const unlockState = useArkadeReceiveUnlockState();
  // Which rail's transaction list is open.
  const [historyRail, setHistoryRail] = useState<RailKey | null>(null);
  // Euro/dollar that has left the wallet and not settled — the rails' in-flight
  // rows, and the history modal's own pending section.
  const [moneyInFlight, setMoneyInFlight] = useState<MoneyInFlight[]>([]);
  // Sats in the arkade wallet that cannot be spent yet — a VTXO still being
  // finalized, typically the change of a send. Deliberately outside the headline
  // balance (a balance that cannot be sent is a lie) and with no history row of
  // its own, so without this the money simply looks gone. Same figure the
  // activity screen shows under "Pending".
  const [pendingVtxoSats, setPendingVtxoSats] = useState(0);
  // Sats that have been broadcast and not settled — the "Sending" row. The
  // store is written by every send, and until it was read here a send that
  // closed its sheet before history caught up left no sign that it happened.
  // Which bitcoin rail is sending. The row IS the source, so there is no
  // source picker and no send-choice sheet in between.
  const [btcSendSource, setBtcSendSource] = useState<"arkade" | "onchain" | null>(null);
  const [btcSendPrefill, setBtcSendPrefill] = useState<string | undefined>(undefined);
  // A payout destination a scanned code named (a TanQR merchant).
  const [btcSendPayout, setBtcSendPayout] = useState<ZapRemitDestination | undefined>(undefined);
  // A payment request's own amount, when the code carried one. Dropping it sent
  // the user to an empty keypad to guess what they owe.
  const [btcSendAmountSats, setBtcSendAmountSats] = useState<string | undefined>(undefined);
  const [scanVisible, setScanVisible] = useState(false);
  // The one send flow: the recipient step, then the amount screen of the
  // balance that pays. `send` is who it goes to and which balance pays, for
  // as long as one of its screens is open; the balances a Send started from
  // (its card) are preferred when they can pay.
  const [recipientSheetOpen, setRecipientSheetOpen] = useState(false);
  const [scanFromSend, setScanFromSend] = useState(false);
  const [send, setSend] = useState<{ recipient: SendRecipient; balance: SendBalance } | null>(null);
  const sendStartRef = useRef<readonly SendBalance[]>([]);
  // A send that swaps on the way runs on the Move card, with the recipient as
  // its fixed destination.
  const [sendSwap, setSendSwap] = useState<SendSwapTarget | null>(null);
  const sendContacts = useAddressBookContacts(true);
  const [swapVisible, setSwapVisible] = useState(false);
  const [swapFrom, setSwapFrom] = useState<RailKey | null>(null);
  const [swapTo, setSwapTo] = useState<RailKey | null>(null);
  // Add money fixes the card's end as the destination, Send as the source.
  const [moveLock, setMoveLock] = useState<"from" | "to" | null>(null);
  // The two buttons: which card's Add money or Send list is open, which list
  // waits for a card to be picked (the total has none), and the user's own pay
  // page shown for "From another wallet".
  type HomeCard = "onchain" | "wallet" | "visa";
  const [cardSheet, setCardSheet] = useState<{ kind: "add" | "send"; card: HomeCard } | null>(null);
  const [cardPickFor, setCardPickFor] = useState<"add" | "send" | null>(null);
  // `id`: each request starts a fresh flow, even while the last one is still
  // waiting out a closed picker.
  const [topUp, setTopUp] = useState<{
    id: number;
    settle: PayWalletSettle;
    payoutAddress: string;
    rail: Exclude<RailKey, "iban">;
    label: string;
    formatReceive: (amount: string) => string;
  } | null>(null);
  // Closes only the flow that asks: a top-up still paying after its sheet
  // went must not close one started after it.
  const closeTopUp = useCallback(
    (id: number) => setTopUp((current) => (current?.id === id ? null : current)),
    [],
  );
  const [onchainToArkadeAvailableSats, setOnchainToArkadeAvailableSats] = useState<number | null>(
    null,
  );
  // Which bitcoin wallet pays for a top-up. Named explicitly because the
  // service treats "unspecified" as arkade.
  // Which currency a bitcoin top-up settles into. The card holds both, and the
  // destination rail the move named is the only thing that says which.
  // Sats the Move sheet already collected. Null when the top-up was opened on
  // its own (Add money), where the keypad is where the amount comes from.
  // Buying bitcoin through Mercuryo. The order outlives this sheet, so nothing
  // about a purchase depends on it staying open.
  const buyFlow = useBitcoinBuyFlow();
  // Balances stranded on other chains, found by a throttled scan. A null result
  // (nothing found, or the scan failed) shows nothing.
  const [sweepResult, setSweepResult] = useState<SwapKitV2SweepResult | null>(null);

  useEffect(() => {
    setHomeIdentity((current) =>
      applyVerifiedHomeHandle(current, signedInHandle, ENS_PARENT_DOMAIN),
    );
  }, [signedInHandle]);

  // The handle behind the greeting. The persisted snapshot is empty on the first
  // sign-in of a browser/device: the status is fetched by the login bootstrap,
  // which is dispatched un-awaited and resolves after this screen has mounted. A
  // one-shot read therefore left the greeting on its nameless fallback until the
  // user reloaded the page — so this also listens for the status the hydrate
  // broadcasts, which is what makes the name appear without a reload.
  useEffect(() => {
    let cancelled = false;
    // A status from the event wins over the persisted read, whichever order they
    // resolve in: the event carries the live server answer, the snapshot on disk
    // is whatever the previous session happened to leave behind.
    let appliedLiveStatus = false;
    // Only a status that carries a handle is ever applied. The hydrate also
    // broadcasts an empty one when it had no cached PRF assertion to check with,
    // and that means "not known yet", not "this account has no handle" — acting on
    // it would blank a name that is correct. Nothing is lost by ignoring it: a
    // credential switch either reloads the page or unmounts this screen, so there
    // is never a previous account's name left here to clear.
    const applyHandle = (handle: string) => {
      if (!handle) return;
      setHomeIdentity((current) => applyVerifiedHomeHandle(current, handle, ENS_PARENT_DOMAIN));
    };
    // LNURL handles are stored lowercase; the greeting addresses a person.
    const readHandle = (status: ArkadeLnurlStatus | null | undefined): string =>
      status?.registered ? (status.username ?? "").trim() : "";
    const unsubscribeStatus = EventBus.on<ArkadeLnurlStatus>("arkade:lnurl:status", (status) => {
      if (cancelled) return;
      const handle = readHandle(status);
      if (!handle) return;
      appliedLiveStatus = true;
      applyHandle(handle);
    });
    (async () => {
      try {
        const persisted = await getArkadeLnurlStatusPersisted();
        if (!cancelled && !appliedLiveStatus) applyHandle(readHandle(persisted));
      } catch {}
      try {
        // The address is public — read the cached EOA, never a PRF/biometric.
        setEvmAddress(await getEthereumAddress());
      } catch {}
    })();
    return () => {
      cancelled = true;
      unsubscribeStatus();
    };
  }, []);

  // Everything in flight, from the one list that names BOTH of a move's
  // screens. Every rail and every history list reads only this.
  useEffect(() => {
    const read = () => {
      try {
        setMoneyInFlight(MoneyInFlightStore.list());
      } catch {}
    };
    void MoneyInFlightStore.hydrate().then(read);
    return EventBus.on(MoneyInFlightStore.CHANGED, read);
  }, []);

  useEffect(() => {
    const read = () => {
      const sats = Number(getArkadeWalletSummarySnapshot()?.debugPendingVtxoTotalSats || 0);
      setPendingVtxoSats(Number.isFinite(sats) ? Math.max(0, Math.trunc(sats)) : 0);
    };
    read();
    // The summary itself, not only the events that happen to precede it: a
    // settle refreshes the summary without emitting any of these, and the row
    // then states a figure from before it ran.
    addArkadeWalletSummaryListener(read);
    const offs = [
      EventBus.on("bitcoin:refresh", read),
      EventBus.on("arkade:receiveUpdated", read),
      EventBus.on("transactions:refresh", read),
    ];
    return () => {
      removeArkadeWalletSummaryListener(read);
      for (const off of offs) off();
    };
  }, []);

  // Money the user owns on chains this app does not list. The scan takes
  // seconds and is throttled inside the service, so one run per mount is
  // enough to greet them with the claim sheet.
  useEffect(() => {
    void checkSwapKitSweep({ force: false }).then((result) => {
      if (result) setSweepResult(result);
    });
  }, []);

  // A transfer that reverted: the euros never moved, so both sides of it have to
  // be taken back — the debit shown on the wallet and, for a top-up, the credit
  // shown on the card. Each side is claimed by its own scope; a mined transfer
  // just drops the entries.
  useEffect(() => {
    return EventBus.on<{ txHash?: string | null; reverted?: boolean }>(
      "wallet:transferSettled",
      (payload) => {
        const walletHandle = takeOptimisticMove("wallet", payload?.txHash);
        const dollarHandle = takeOptimisticMove("dollar", payload?.txHash);
        const cardHandle = takeOptimisticMove("card", payload?.txHash);
        if (!payload?.reverted) return;
        if (walletHandle != null) {
          walletBalanceStore.revertOptimisticBalance(walletHandle);
          void walletBalanceStore.refresh();
        }
        if (dollarHandle != null) {
          usdcBalanceStore.revertOptimisticBalance(dollarHandle);
          void usdcBalanceStore.refresh();
        }
        if (cardHandle != null) {
          wirexAccountService.revertOptimisticBalance(cardHandle);
          void wirexAccountService.silentRefresh(true);
        }
      },
    );
  }, []);

  // A swap that settled ON the card: its credit was shown the moment the order
  // was created, and only this outcome can confirm or undo it. The same handler
  // serves a run the user watched and one that finished while the app was
  // closed — the resume path announces terminal orders exactly like the
  // foreground one, which is the only way a restart's stale figure is corrected.
  useEffect(() => {
    return EventBus.on<DirectSwapSettled>(DIRECT_SWAP_SETTLED_EVENT, (payload) => {
      if (payload?.destination !== "card") return;
      // When the credit is not parked yet, the outcome is kept for it: see onExecuted below.
      const handle = settleOptimisticMove("card", payload.txId, payload.ok === true);
      if (!payload.ok && handle != null) {
        wirexAccountService.revertOptimisticBalance(handle);
      }
      // Refreshed either way: on success Wirex now holds the real figure, and on
      // failure the reverted card must not be left showing this session's guess.
      void wirexAccountService.silentRefresh(true);
    });
  }, []);

  const satsStr = useCallback((n: number) => `BTC ${satsDigits(n)}`, []);
  const satsGlyph = useCallback((n: number) => `${BTC_GLYPH} ${satsDigits(n)}`, []);
  const listSatsStr = useCallback((n: number) => `BTC ${ungroupedCount(n)}`, []);
  // A balance in the currency it is HELD in — the euro rails in EUR, the dollar
  // rails in USD, whatever the display currency is.
  const heldStr = useCallback((n: number, code: FiatCode) => formatFiat(n, code), []);
  const heldGlyph = useCallback(
    (n: number, code: FiatCode) => formatFiat(n, code, { style: "glyph" }),
    [],
  );
  // A figure CONVERTED into the display currency. Null is unknown ("—").
  const homeStr = useCallback((n: number | null) => formatFiat(n, home), [home]);
  const homeGlyph = useCallback(
    (n: number | null) => formatFiat(n, home, { style: "glyph" }),
    [home],
  );
  const heldList = useCallback(
    (n: number, code: FiatCode) => heldWithHome(n, code, home, fxRates),
    [home, fxRates],
  );

  // BtcFiatRateStore already falls back to its cache, so a failed live fetch
  // still yields a rate here.
  const rate = btcFiatRate != null && Number.isFinite(btcFiatRate) ? btcFiatRate : null;
  const btcQuote = useMemo(() => ({ rate, currency: btcRateCurrency }), [rate, btcRateCurrency]);
  // Held fiat → display currency. Null while FX is unavailable: the row still
  // renders its own money, it just cannot join the converted total yet.
  const toHome = useCallback(
    (amount: number, held: FiatCode) => convertFiat(amount, held, home, fxRates),
    [home, fxRates],
  );
  const satsToHome = useCallback(
    (sats: number) => satsToFiatIn(sats, home, btcQuote, fxRates),
    [home, btcQuote, fxRates],
  );
  const fiatToSats = useCallback(
    (amount: number, held: FiatCode) => fiatToSatsFrom(amount, held, btcQuote, fxRates),
    [btcQuote, fxRates],
  );
  const satsOrUnknown = useCallback(
    (sats: number | null, glyph = false) =>
      sats === null ? UNKNOWN_FIGURE : glyph ? satsGlyph(sats) : satsStr(sats),
    [satsStr, satsGlyph],
  );

  // Which modules exist for this user. Everything below keys off these two.
  const onchainActive = Boolean(addressSnapshot.musig2Address.trim());
  // Approved is not ready: Wirex issues the card and the bank account moments
  // later, and until the card id, balance and smart account are in, the Wirex
  // rails have no figures to state. They stay listed (tapping still starts or
  // resumes signup) — they just do not claim a balance they cannot read yet.
  const cardActive = isWirexCardReady(wirex);

  const arkadeSats = Math.max(0, Math.trunc(bitcoinBalanceSats));
  const onchainSats = onchainActive
    ? Math.max(0, Math.trunc(bitcoinSnapshot.bitcoinBalance.byChannel.onchain))
    : 0;
  const onchainSpendableSats = Math.max(
    0,
    Math.trunc(bitcoinSnapshot.bitcoinBalance.detail.onchain.spendable ?? onchainSats),
  );
  useEffect(() => {
    if (!swapVisible || swapFrom !== "onchain" || swapTo !== "arkade") {
      setOnchainToArkadeAvailableSats(null);
      return;
    }
    let cancelled = false;
    setOnchainToArkadeAvailableSats(null);
    void getOnchainToArkadeTransferableSats(onchainSpendableSats).then((available) => {
      if (!cancelled) setOnchainToArkadeAvailableSats(available);
    });
    return () => {
      cancelled = true;
    };
  }, [swapVisible, swapFrom, swapTo, onchainSpendableSats]);
  const walletEur = walletBalance ?? 0;
  // The dollar rail's figure comes from the same headless driver every other
  // balance does — owning it in this screen meant only this screen could move it,
  // and a send had nothing to hand back when it needed taking back.
  const usdcBalance = balances.walletBalanceUsd;

  // The app has one scanner. The home's scan button and a euro/dollar screen's
  // Send both open it, and it routes on what the code is, never on the page.
  const closeScanner = useCallback(() => setScanVisible(false), []);
  // Each opening and closing of the scanner is a new session: a scan whose
  // recipient check outlives its session is dropped (#1783).
  const scanSessionRef = useRef(0);
  useEffect(() => {
    scanSessionRef.current += 1;
  }, [scanVisible]);
  const addressBookOpenRef = useRef(addressBookOpen);
  addressBookOpenRef.current = addressBookOpen;

  // Home includes every rail, even before its address/account is ready.
  const homeRails: Rail[] = useMemo(() => {
    const list: Rail[] = [];
    const bitcoinRail = (
      key: "onchain" | "arkade",
      label: string,
      image: number,
      sats: number,
    ): Rail => {
      const homeValue = satsToHome(sats);
      return {
        key,
        label,
        available: sats,
        image,
        accent: "orange",
        amount: satsStr(sats),
        converted: homeStr(homeValue),
        listFigure:
          homeValue === null
            ? listSatsStr(sats)
            : `${listSatsStr(sats)} \u2248 ${formatFiat(homeValue, home, { grouped: false })}`,
        homeValue,
        glyph: { amount: satsGlyph(sats), converted: homeGlyph(homeValue) },
      };
    };
    list.push(bitcoinRail("onchain", t("screen.HomeScreen.railBitcoin"), BTC_LOGO, onchainSats));
    list.push(
      bitcoinRail(
        "arkade",
        t("screen.HomeScreen.railBitcoinLightning"),
        LIGHTNING_LOGO,
        arkadeSats,
      ),
    );
    // Listed unconditionally: gating it on the first read made the row appear
    // late and shove the rows under it down. Its figure comes from the cache
    // until the chain answers.
    const usd = usdcBalance ?? 0;
    const usdSats = fiatToSats(usd, "USD");
    list.push({
      key: "dollar",
      label: t("screen.HomeScreen.railDollar"),
      available: usd,
      image: USD_FLAG,
      accent: "lilac",
      amount: heldStr(usd, "USD"),
      converted: satsOrUnknown(usdSats),
      listFigure: heldList(usd, "USD"),
      homeValue: toHome(usd, "USD"),
      glyph: { amount: heldGlyph(usd, "USD"), converted: satsOrUnknown(usdSats, true) },
    });
    const walletSats = fiatToSats(walletEur, "EUR");
    list.push({
      key: "wallet",
      label: t("screen.HomeScreen.railEuro"),
      available: walletEur,
      image: EUR_FLAG,
      accent: "lilac",
      amount: heldStr(walletEur, "EUR"),
      converted: satsOrUnknown(walletSats),
      listFigure: heldList(walletEur, "EUR"),
      homeValue: toHome(walletEur, "EUR"),
      glyph: { amount: heldGlyph(walletEur, "EUR"), converted: satsOrUnknown(walletSats, true) },
    });
    // One Wirex balance, spendable from either face. On the card it is the
    // whole account — both pockets summed in EUR — so the card states it in the
    // display currency (its screen itemises the pockets as held). The IBAN is a
    // euro account and states it in euros.
    const wirexEur = cardActive ? cardBalance : 0;
    const wirexHome = toHome(wirexEur, "EUR");
    const wirexSats = fiatToSats(wirexEur, "EUR");
    const wirexConverted = satsOrUnknown(wirexSats);
    list.push({
      key: "visa",
      label: t("screen.HomeScreen.railVisa"),
      available: wirexEur,
      image: VISA_LOGO,
      accent: "neutral",
      amount: homeStr(wirexHome),
      converted: wirexConverted,
      listFigure: formatFiat(wirexHome, home, { grouped: false }),
      homeValue: wirexHome,
      glyph: { amount: homeGlyph(wirexHome), converted: satsOrUnknown(wirexSats, true) },
    });
    list.push({
      key: "iban",
      label: t("screen.HomeScreen.railIban"),
      available: wirexEur,
      image: SEPA_LOGO,
      accent: "neutral",
      // The board states the Wirex balance ONCE, on the card row: both faces
      // spend the same money, so printing it twice reads as two balances. The
      // rail still carries it for the detail screen and the Move sheet — only
      // the home row stays silent.
      showAmount: false,
      amount: heldStr(wirexEur, "EUR"),
      converted: wirexConverted,
      listFigure: heldList(wirexEur, "EUR"),
      homeValue: wirexHome,
      glyph: { amount: heldGlyph(wirexEur, "EUR"), converted: satsOrUnknown(wirexSats, true) },
    });
    return list;
  }, [
    arkadeSats,
    onchainSats,
    cardActive,
    walletEur,
    cardBalance,
    usdcBalance,
    home,
    satsStr,
    satsGlyph,
    listSatsStr,
    heldStr,
    heldGlyph,
    heldList,
    homeStr,
    homeGlyph,
    toHome,
    satsToHome,
    fiatToSats,
    satsOrUnknown,
  ]);

  // Keep operational eligibility/order (Move defaults) unchanged.
  const rails = useMemo(
    () => homeRails.filter((rail) => rail.key !== "onchain" || onchainActive),
    [homeRails, onchainActive],
  );
  const overviewGroups = homeOverviewGroups({
    bitcoinHome: arkadeSats + onchainSats === 0 ? 0 : satsToHome(arkadeSats + onchainSats),
    walletHome: walletBalance === null ? null : toHome(walletBalance, "EUR"),
    dollarHome: usdcBalance === null ? null : toHome(usdcBalance, "USD"),
    wirexHome: !wirex.isApproved
      ? 0
      : balances.cardBalanceEur === null
        ? null
        : toHome(balances.cardBalanceEur, "EUR"),
  });
  const overviewLabels = {
    bitcoin: t("screen.HomeScreen.railBitcoin"),
    cash: t("screen.HomeScreen.groupCash"),
    banking: t("screen.HomeScreen.groupCardBanking"),
  };
  // Which stable a Move from Cash spends: with money in one, that one; else the
  // main one.
  const cashOnly: "wallet" | "dollar" =
    walletEur > 0 ? "wallet" : (usdcBalance ?? 0) > 0 ? "dollar" : cardSettleWalletRail(home);
  const cashRail: "wallet" | "dollar" = cashOnly;
  // Which bitcoin rail a Move from Bitcoin spends: the funded one.
  const btcRail: "onchain" | "arkade" = onchainActive && onchainSats > 0 ? "onchain" : "arkade";
  const overviewImages = { bitcoin: BTC_LOGO, cash: EUR_FLAG, banking: VISA_LOGO };
  const total = formatFiat(sumKnown(overviewGroups.map((group) => group.amountHome)), home, {
    style: "glyph",
  });
  const homeFlag = home === "USD" ? USD_FLAG : EUR_FLAG;

  const railOf = useCallback(
    (key: RailKey | null) => homeRails.find((rail) => rail.key === key) ?? null,
    [homeRails],
  );

  // A BTC->EUR swap is one movement seen from two rails: money LEAVING the
  // bitcoin side and ARRIVING on the euro or card side. Each rail renders its
  // own sign, which is why this cannot be one shared list.
  const pendingFor = useCallback(
    (key: RailKey | null): WealthPendingRow[] => {
      if (!key) return [];
      const rows: WealthPendingRow[] = [];
      // THE RULE: a move shows on the screen it leaves and the screen it
      // arrives on, and every screen asks the same list. The home has ONE card
      // screen holding both pockets, so it asks for both: a move into the
      // dollar pocket was written correctly and never drawn anywhere. The IBAN
      // face states the card's euro pocket.
      const railsHere: MoneyRail[] =
        key === "visa"
          ? ["visa", "visaUsd"]
          : key === "onchain"
            ? ["onchain", "arkade"]
            : key === "wallet"
              ? ["wallet", "dollar"]
              : MONEY_RAILS.includes(key as MoneyRail)
                ? [key as MoneyRail]
                : [];
      if (railsHere.length > 0) {
        for (const row of inFlightRowsFor(moneyInFlight, railsHere)) {
          const amount = row.leg.amount;
          if (!(amount > 0)) continue;
          const sign = row.direction === "out" ? "\u2212" : "+";
          let figure: string;
          let converted: string;
          if (row.leg.unit === "sats") {
            const sats = Math.max(0, Math.trunc(amount));
            const value = satsToHome(sats);
            figure = satsStr(sats);
            converted = value === null ? UNKNOWN_FIGURE : `${sign} ${homeStr(value)}`;
          } else {
            const sats = fiatToSats(amount, row.leg.unit);
            figure = heldStr(amount, row.leg.unit);
            converted = sats === null ? UNKNOWN_FIGURE : `${sign} ${satsStr(sats)}`;
          }
          const rowRail = row.key.slice(row.key.lastIndexOf("-") + 1) as RailKey;
          rows.push({
            key: row.key,
            onPress: () => setHistoryRail(rowRail === "visaUsd" ? "visa" : rowRail),
            label: t(`screen.HomeScreen.${row.label}`),
            amount: `${sign} ${figure}`,
            converted,
          });
        }
      }
      // The arkade rail's unspendable sats, as the board draws them: one
      // spinner row above the history entry.
      if (key === "onchain" && pendingVtxoSats > 0) {
        rows.push({
          key: "pending-vtxo-balance",
          onPress: () => setHistoryRail("arkade"),
          label: t("screen.BitcoinTransactionsModal.pendingBalanceLabel"),
          amount: satsStr(pendingVtxoSats),
          converted: homeStr(satsToHome(pendingVtxoSats)),
        });
      }
      return rows;
    },
    [moneyInFlight, pendingVtxoSats, satsStr, heldStr, homeStr, satsToHome, fiatToSats],
  );

  // The transfer sheet is opened with the balance that pays (a send, a scan,
  // Send again); that decision lives and dies with the sheet.
  const sendTokenRail = walletSend.sendToWalletRail ?? cashRail;

  // ── The one send flow ──────────────────────────────────────────────────
  // Balances a send can be paid from, in the order a tie is broken.
  const sendBalances = useMemo(
    () => SEND_BALANCES.filter((balance) => balance !== "onchain" || onchainActive),
    [onchainActive],
  );
  const sendHeld: Record<SendBalance, number> = {
    wallet: walletEur,
    dollar: usdcBalance ?? 0,
    arkade: arkadeSats,
    onchain: onchainActive ? onchainSats : 0,
  };
  const sendBalanceLook: Record<
    SendBalance,
    { label: string; image: ImageSourcePropType; held: string }
  > = {
    wallet: {
      label: t("screen.HomeScreen.railEuro"),
      image: EUR_FLAG,
      held: heldStr(walletEur, "EUR"),
    },
    dollar: {
      label: t("screen.HomeScreen.railDollar"),
      image: USD_FLAG,
      held: heldStr(usdcBalance ?? 0, "USD"),
    },
    arkade: {
      label: t("screen.HomeScreen.railBitcoinLightning"),
      image: LIGHTNING_LOGO,
      held: satsStr(arkadeSats),
    },
    onchain: {
      label: t("screen.HomeScreen.railBitcoin"),
      image: BTC_LOGO,
      held: satsStr(onchainSats),
    },
  };
  // Only the balances that can pay this recipient; the rest are not offered.
  const sendBalanceOptions = (recipient: SendRecipient): SendBalanceOption[] =>
    sendBalances
      .filter((balance) => recipientRoute(balance, recipient) !== null)
      .map((balance) => ({
        key: balance,
        label: sendBalanceLook[balance].label,
        sublabel: sendBalanceLook[balance].held,
        image: sendBalanceLook[balance].image,
      }));

  // The amount screen that pays `recipient` from `balance`: the transfer sheet,
  // the Bitcoin send, or the Move card when it swaps on the way.
  const openSend = (recipient: SendRecipient, balance: SendBalance): boolean => {
    const route = recipientRoute(balance, recipient);
    if (!route) return false;
    setSend({ recipient, balance });
    if (route.kind === "payout-direct") {
      if (!recipient.payout) return false;
      if (isBitcoinBalance(balance)) {
        setBtcSendPrefill(undefined);
        setBtcSendAmountSats(undefined);
        setBtcSendPayout(recipient.payout);
        setBtcSendSource(balance);
      } else {
        walletSend.open({ payout: recipient.payout, rail: balance });
      }
      return true;
    }
    if (route.kind === "evm-direct") {
      if (isBitcoinBalance(balance)) return false;
      return walletSend.open({
        address: route.address,
        amount: recipient.amountStable ?? null,
        rail: balance,
      });
    }
    if (route.kind === "bitcoin-direct") {
      if (!isBitcoinBalance(balance)) return false;
      setBtcSendPayout(undefined);
      setBtcSendPrefill(route.target);
      setBtcSendAmountSats(recipient.amountSats);
      setBtcSendSource(balance);
      return true;
    }
    // Paid in a currency the recipient has no address for: swapped on the way,
    // into Bitcoin, or into the stable they asked for (else the main currency).
    // An address on another network is paid in that network's stable (#1783).
    const settleAsset = route.kind === "swap-to-stable" ? route.settleAsset : undefined;
    const fiat: "EUR" | "USD" | null =
      route.kind === "swap-to-bitcoin"
        ? null
        : settleAsset
          ? settleAsset.startsWith("EUR")
            ? "EUR"
            : "USD"
          : route.asset === "USDC" || (route.asset === null && home === "USD")
            ? "USD"
            : "EUR";
    // A request that names its amount is received exactly, whatever pays it.
    const requested = Number(fiat === null ? recipient.amountSats : recipient.amountStable);
    setSendSwap({
      recipient,
      address: route.address,
      ...(Number.isFinite(requested) && requested > 0 ? { exactReceive: requested } : {}),
      fiat,
      asset:
        fiat === null
          ? BTC_ONCHAIN_ASSET
          : (settleAsset ?? (fiat === "USD" ? USDC_BASE_TOKEN.asset : EURC_BASE_TOKEN.asset)),
    });
    setMoveLock("to");
    setSwapFrom(balance);
    setSwapTo(SEND_RECIPIENT_RAIL as RailKey);
    setSwapVisible(true);
    return true;
  };

  // An address that belongs to a saved contact is that person.
  const nameSendRecipient = (input: SendRecipient): SendRecipient => {
    if (input.person || input.payout) return input;
    // A code naming its token, network or amount keeps exactly its addresses.
    const exact = Boolean(
      input.amountSats || input.amountStable || input.destinations.some(namesEvmNetwork),
    );
    return {
      ...recipientFromDestinations(sendContacts, input.destinations, exact),
      ...(input.amountSats ? { amountSats: input.amountSats } : {}),
      ...(input.amountStable ? { amountStable: input.amountStable } : {}),
    };
  };

  // The recipient a send may pay (#1783): a plain 0x... only as the Nuri user
  // it belongs to, otherwise it must name its network. A message when refused.
  // The recipient step runs the same check itself before routeSend.
  const checkSendRecipient = async (input: SendRecipient): Promise<SendRecipient | string> => {
    try {
      const checked = await checkEvmRecipient(
        nameSendRecipient(input),
        evmRecipientLookup(sendContacts),
      );
      return checked ?? t("screen.SendRecipientSheet.needsNetwork");
    } catch {
      return t("screen.WalletSendStablecoinModal.lookupFailed");
    }
  };

  // Any recipient, from anywhere (recipient step, scan, contact, Send again):
  // the balance it starts on is the card Send was pressed on when that can pay.
  // Plain 0x... recipients go through checkSendRecipient first.
  const routeSend = (
    input: SendRecipient,
    started: readonly SendBalance[] = sendStartRef.current,
  ): boolean => {
    sendStartRef.current = [];
    const recipient = nameSendRecipient(input);
    const balance = defaultSendBalance({
      recipient,
      order: sendBalances,
      held: sendHeld,
      started,
    });
    return balance ? openSend(recipient, balance) : false;
  };

  // The amount screen a balance switch is about to close underneath the new one.
  const sendHandoverRef = useRef<{
    screen: "wallet" | "bitcoin" | "move";
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const closeSendScreen = (screen: "wallet" | "bitcoin" | "move") => {
    if (screen === "wallet") walletSend.setIsSendToWalletVisible(false);
    else if (screen === "move") setSwapVisible(false);
    else {
      setBtcSendPrefill(undefined);
      setBtcSendPayout(undefined);
      setBtcSendAmountSats(undefined);
      setBtcSendSource(null);
    }
  };

  // For callbacks handed to other screens: always the current routeSend.
  const routeSendRef = useRef(routeSend);
  routeSendRef.current = routeSend;
  const checkSendRecipientRef = useRef(checkSendRecipient);
  checkSendRecipientRef.current = checkSendRecipient;

  // A payment link opened in the app (`nuri://pay/@name`, or `/?pay=@name` when
  // the installed PWA is handed the same link): the confirm screen for that
  // person, with the link's figure pinned when it names one, opened on the
  // balance whose money lands in the link's currency. The link is queued while
  // the app boots (sign-in, passkey, lock), so it is drained by the first home
  // that can show it rather than lost before there is a listener.
  //
  // Exactly one delivery per link: the queue is the only source, so a link that
  // arrives while this home is up is queued and then drained by the same code
  // that drains a boot-time one. A remount (a language change remounts this
  // screen) therefore finds nothing left to reopen.
  const payIntentContactsRef = useRef(sendContacts);
  payIntentContactsRef.current = sendContacts;
  // Fences each link's lookup: a superseded or dismissed one may not open.
  const payIntentGateRef = useRef(new PayIntentGate());
  const runPayIntent = useCallback(async (intent: PayIntent) => {
    const token = payIntentGateRef.current.begin();
    let recipient: SendRecipient | null = null;
    try {
      recipient = await evmRecipientLookup(payIntentContactsRef.current).nuriUser(intent.username);
    } catch {
      // A directory outage is not a payee: nothing opens, the payer can retry.
      return;
    }
    if (!recipient || !payIntentGateRef.current.isCurrent(token)) return;
    // The link's currency and network narrow the destination, and a rail this
    // person does not have refuses the intent rather than paying something else.
    const pinned = payIntentRecipient(recipient, intent);
    if (!pinned) return;
    routeSendRef.current(pinned, payIntentBalances(intent));
  }, []);
  const runPayIntentRef = useRef(runPayIntent);
  runPayIntentRef.current = runPayIntent;
  useEffect(() => {
    // Both paths take the queue: a live link is queued before its event is
    // emitted, so draining here (never the event payload) consumes it once.
    const drain = () => {
      const queued = takePayIntent();
      if (queued) void runPayIntentRef.current(queued);
    };
    drain();
    const off = EventBus.on("pay:intent", drain);
    // A close-all reset (biometric lock, factory reset, a deep link taking over)
    // closes every screen without unmounting this home: a link whose lookup is
    // still in flight belonged to the screen that just closed.
    const offReset = fencePayIntentResets(payIntentGateRef.current, (event, listener) =>
      EventBus.on(event, listener),
    );
    return () => {
      off();
      offReset();
      // This home is gone: an answer still in flight must not open a screen.
      payIntentGateRef.current.invalidate();
    };
  }, []);

  // Another balance picked on an amount screen: that balance's screen opens on
  // top, and the one it replaces closes underneath once it is covered. The
  // same screen just changes balance.
  const switchSendBalance = (balance: SendBalance) => {
    const current = send;
    if (!current || current.balance === balance) return;
    const before = sendScreenOf(current.balance, current.recipient);
    if (!openSend(current.recipient, balance)) return;
    const after = sendScreenOf(balance, current.recipient);
    // A switch inside the previous one's handover: its pending close is
    // settled now, and never closes the screen that is opening.
    const pending = sendHandoverRef.current;
    if (pending) {
      clearTimeout(pending.timer);
      sendHandoverRef.current = null;
      if (pending.screen !== after) closeSendScreen(pending.screen);
    }
    if (before === after) return;
    const timer = setTimeout(() => {
      sendHandoverRef.current = null;
      closeSendScreen(before);
    }, SEND_SCREEN_HANDOVER_MS);
    sendHandoverRef.current = { screen: before, timer };
  };

  // A scanned recipient: the amount screen opens over the scanner, which then
  // closes underneath it.
  // The recipient, or how to find it (a scanned ENS name): every wait runs in
  // the scanner session the scan started in, so a scan whose scanner closed or
  // reopened meanwhile routes nothing (lib/send/scannedSend).
  const sendScanned = async (
    input: SendRecipient | (() => Promise<SendRecipient | string>),
    started?: readonly SendBalance[],
  ): Promise<string | undefined> => {
    const from = started ?? sendStartRef.current;
    const result = await scannedSend(input, {
      session: () => scanSessionRef.current,
      check: checkSendRecipient,
      route: (recipient) => routeSend(recipient, from),
    });
    if (result.kind === "stale") return undefined;
    if (result.kind === "refused") return result.message;
    if (result.kind === "unroutable") return t("screen.HomeScreen.scanNothingToSend");
    setTimeout(closeScanner, SEND_SCREEN_HANDOVER_MS);
    return undefined;
  };

  // What the open home card holds, one row per rail: Bitcoin = Onchain and
  // Lightning, Cash = euro and dollar, Visa & Banking = the money on the card in
  // each currency it holds. Tapping a row opens that rail's history.
  const groupBalanceRows: WealthBalanceRow[] = useMemo(() => {
    if (openRail === "onchain") {
      return [
        {
          key: "onchain",
          label: t("screen.HomeScreen.rowOnchain"),
          image: BTC_LOGO,
          figure: listSatsStr(onchainSats),
          onPress: () => setHistoryRail("onchain"),
        },
        {
          key: "arkade",
          label: t("screen.HomeScreen.rowLightning"),
          image: LIGHTNING_LOGO,
          figure: listSatsStr(arkadeSats),
          onPress: () => setHistoryRail("arkade"),
        },
      ];
    }
    if (openRail === "wallet") {
      return [
        {
          key: "wallet",
          label: t("screen.HomeScreen.railEuro"),
          image: EUR_FLAG,
          figure: heldList(walletEur, "EUR"),
          onPress: () => setHistoryRail("wallet"),
        },
        {
          key: "dollar",
          label: t("screen.HomeScreen.railDollar"),
          image: USD_FLAG,
          figure: heldList(usdcBalance ?? 0, "USD"),
          onPress: () => setHistoryRail("dollar"),
        },
      ];
    }
    // Visa & Banking states its balance on the card itself.
    return [];
  }, [openRail, onchainSats, arkadeSats, walletEur, usdcBalance, listSatsStr, heldList]);

  // Money on the card in the currency it does not settle in. It cannot be
  // spent through the card's one currency, so from Wirex's minimum of 10 it is
  // swapped into the home currency on its own (Wirex FX: the same two silent
  // approvals as a withdrawal, then the home currency lands on the card). Less
  // than that is offered back as found money, below.
  const cardOtherFiat: FiatCode = home === "USD" ? "EUR" : "USD";
  const cardOtherReading = cardActive ? wirex.balancesByFiat?.[cardOtherFiat] : undefined;
  const cardSwapAmount = autoSwapAmount(cardOtherReading);
  // The reading a swap already ran for (or may have run for, when its outcome
  // is unconfirmed): never swapped again until the balance reads differently,
  // and nothing starts while one is running, so the same money moves once.
  const cardSwapKey = `${cardOtherFiat}:${cardOtherReading ?? 0}`;
  const cardSwapTakenRef = useRef<string | null>(null);
  const cardSwapRunningRef = useRef(false);
  // Bumped when a swap ends, so the latest reading (which may have changed
  // while it ran) is looked at again.
  const [cardSwapEnded, setCardSwapEnded] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `cardSwapEnded` is the re-check trigger when a swap ends, not a value read
  useEffect(() => {
    const step = cardSwapStep({
      running: cardSwapRunningRef.current,
      reading: cardOtherReading,
      key: cardSwapKey,
      taken: cardSwapTakenRef.current,
    });
    // Zero: the money left, so the same amount arriving later is new money.
    if (step === "reset") cardSwapTakenRef.current = null;
    if (step !== "start" || !cardSwapAmount) return;
    cardSwapTakenRef.current = cardSwapKey;
    cardSwapRunningRef.current = true;
    const to = home === "USD" ? "USD" : "EUR";
    // Another card movement (a withdrawal from the Move sheet) holds the card:
    // nothing started, so the reading is not used up. Asked again once it is
    // done, from a fresh reading.
    let busy = false;
    void wirexService
      .swapCardCurrency(to, cardSwapAmount)
      .then((done) => {
        // The money left the card but Wirex did not run the swap: it sits at
        // Wirex's swap address and only support can settle it.
        if (done.fx?.status !== "done") {
          void reportErrorToSupport({
            error: new Error(done.fx?.error ?? "wirex_fx_outcome_missing"),
            userMessage:
              done.fx?.status === "failed"
                ? "Card currency swap did not run"
                : "Card currency swap is unconfirmed",
          }).catch(() => {});
        }
      })
      .catch((error) => {
        if (error instanceof WirexWithdrawBusyError) {
          busy = true;
          cardSwapTakenRef.current = null;
          return;
        }
        if (error instanceof WirexWithdrawUnconfirmedError) {
          void reportErrorToSupport({
            error,
            userMessage: "Card currency swap is unconfirmed",
          }).catch(() => {});
          return;
        }
        // Nothing moved (no capability, a server without swaps, a blip): the
        // same reading is not tried again until the app starts anew.
        errorWithId("💳 UnifiedHomeScreen.cardSwap", "card currency swap failed", {
          reason: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        const ready = busy ? wirexService.whenWithdrawalsIdle() : Promise.resolve();
        void ready
          .then(() => wirexAccountService.silentRefresh(true))
          .catch(() => {})
          .finally(() => {
            cardSwapRunningRef.current = false;
            setCardSwapEnded((n) => n + 1);
          });
      });
  }, [cardSwapAmount, cardSwapKey, cardOtherReading, home, cardSwapEnded]);

  // Under Wirex's swap minimum of 10 the money cannot be swapped, so it is
  // offered back as found money: withdrawn to the wallet holding that currency.
  const cardOtherHeld = foundMoneyAmount(cardOtherReading) ?? 0;
  const [cardFoundVisible, setCardFoundVisible] = useState(false);
  // Offered unprompted for each amount found in a currency; the row on the
  // Visa & Banking card reopens it for as long as the money is there.
  const cardFoundOfferedRef = useRef<string | null>(null);
  // The amount a withdrawal already ran for (or may have run for, when its
  // outcome is unconfirmed): not offered again until the balance reads differently,
  // so the same money is never withdrawn twice.
  const cardFoundKey = `${cardOtherFiat}:${cardOtherHeld}`;
  const [cardFoundClaimed, setCardFoundClaimed] = useState<string | null>(null);
  // A withdrawal still running holds the claim whatever the balance reads, so a
  // balance change mid-approval cannot start a second one.
  const [cardFoundRunning, setCardFoundRunning] = useState(false);
  const cardFoundClaimable =
    cardOtherHeld > 0 && !cardFoundRunning && cardFoundClaimed !== cardFoundKey;
  // Once the card reads zero in that currency the money has left: the same
  // amount arriving later is new money, offered and claimable again.
  useEffect(() => {
    if (cardOtherReading !== 0) return;
    setCardFoundClaimed(null);
    cardFoundOfferedRef.current = null;
  }, [cardOtherReading]);
  useEffect(() => {
    const found = cardFoundKey;
    if (!cardFoundClaimable || cardFoundOfferedRef.current === found || sweepResult != null) return;
    cardFoundOfferedRef.current = found;
    setCardFoundVisible(true);
  }, [cardFoundClaimable, cardFoundKey, sweepResult]);

  // The Move sheet lists the card ONCE, as "Visa", in its settlement currency:
  // the user's main currency. Anything sent to it is a swap into that currency
  // (or a plain transfer from the wallet already holding it), and what it pays
  // out is that currency. Money on the card in the other currency is offered
  // back as found money.
  const moveRails: Rail[] = useMemo(() => {
    // Null until a /wallet read establishes it. The total on its own says
    // NOTHING about the split, so the settlement balance may not be stated from it.
    const byFiat = cardActive ? wirex.balancesByFiat : null;
    const held = byFiat ? (byFiat[home] ?? 0) : null;
    const heldSats = held === null ? null : fiatToSats(held, home);
    return rails.flatMap((rail): Rail[] => {
      if (rail.key === "onchain" && swapFrom === "onchain" && swapTo === "arkade") {
        const available = onchainToArkadeAvailableSats;
        return [
          {
            ...rail,
            available,
            amount: available === null ? UNKNOWN_FIGURE : satsStr(available),
            converted: available === null ? UNKNOWN_FIGURE : homeStr(satsToHome(available)),
          },
        ];
      }
      if (!isCardRail(rail.key)) return [rail];
      // The IBAN spends the same Wirex money the card states; listing both on
      // the Move sheet showed one balance as two.
      if (rail.key === "iban") return [];
      return [
        {
          ...rail,
          available: held,
          amount: held === null ? UNKNOWN_FIGURE : heldStr(held, home),
          converted: satsOrUnknown(heldSats),
          listFigure: held === null ? UNKNOWN_FIGURE : heldList(held, home),
          homeValue: held,
          glyph:
            held === null
              ? { amount: UNKNOWN_FIGURE, converted: UNKNOWN_FIGURE }
              : { amount: heldGlyph(held, home), converted: satsOrUnknown(heldSats, true) },
        },
      ];
    });
  }, [
    rails,
    home,
    swapFrom,
    swapTo,
    onchainToArkadeAvailableSats,
    cardActive,
    wirex.balancesByFiat,
    satsStr,
    heldStr,
    heldGlyph,
    heldList,
    homeStr,
    satsToHome,
    fiatToSats,
    satsOrUnknown,
  ]);

  // The home's three cards: Bitcoin, Cash, Visa & Banking. Each card's figure
  // is its overview group's, in the display currency.
  const carouselRails = overviewGroups.map((group) => ({
    key: group.rail as RailKey,
    label: overviewLabels[group.key],
    image: overviewImages[group.key],
    // Cash holds both pockets, so its card shows both flags, display currency first.
    images:
      group.key === "cash"
        ? [homeFlag, homeFlag === USD_FLAG ? EUR_FLAG : USD_FLAG]
        : [group.key === "bitcoin" ? BTC_LOGO : VISA_LOGO],
    accent: group.key === "bitcoin" ? "orange" : group.key === "cash" ? "lilac" : "neutral",
    amount: overviewFigure(group.amountHome, home),
  })) satisfies { key: RailKey; accent: Accent }[];

  // Total Balance is the starting/reset state; balances never select a rail.
  const selectOverviewRail = useCallback((key: RailKey | null) => {
    setOpenRail(key);
    setCarouselNavigationRevision((revision) => revision + 1);
  }, []);

  const carouselRailKey = homeCarouselEligibleKey(
    carouselRails.map((rail) => rail.key),
    openRail,
  );
  const openedRail = railOf(openRail);
  const carouselOpenedRail = carouselRails.find((rail) => rail.key === carouselRailKey) ?? null;
  // Activation CTA gate: the rails are "inactive" until the card is actually
  // USABLE — `isApproved` alone flips true the moment Sumsub approves, while
  // card/balance/smart-account provision moments later. In that window the
  // visa/iban rows must not offer Move/Send on an account with no figures yet
  // (and an abandoned KYC never reaches approved at all).
  // One rule decides what activating Wirex still needs, for these rows and for
  // the Settings verification row alike.
  const wirexActivationInput = {
    loading: wirex.loading,
    isApproved: wirex.isApproved,
    isRejected: wirex.isRejected,
    verificationStatus: wirex.verificationStatus,
    cardReady: cardActive,
    awaitingReplacementCard: isAwaitingReplacementCard(wirex),
  };
  const wirexActivation = wirexActivationStep(wirexActivationInput);
  const wirexRailsNeedActivation = wirexActivation !== "ready";
  const inactiveWirexRailSelected =
    wirexRailsNeedActivation && (carouselRailKey === "visa" || carouselRailKey === "iban");
  // The detail screen leads with whichever currency the home is showing, and
  // flips with the same control.
  const assetView: WealthAssetView | null = openedRail
    ? {
        label: openedRail.label,
        accent: openedRail.accent,
        primary: openedRail.glyph.amount,
        secondary: openedRail.glyph.converted,
      }
    : null;

  // Funds the server has classified as sweep_ready but that no sweep has moved
  // yet. The sweep is client-only and runs from the unlock modal alone, so a
  // modal that was dismissed (or never opened) leaves nothing on screen saying
  // sats are waiting. This row is that surface, and tapping it reopens the modal.
  const cardFoundExtra =
    openRail === "visa" && cardFoundClaimable ? (
      <List>
        <ListAction
          accessibilityLabel={t("screen.SweepClaimSheet.title")}
          onPress={() => setCardFoundVisible(true)}
        >
          <ListActionLeadingAvatar source={cardOtherFiat === "USD" ? USD_FLAG : EUR_FLAG} />
          <ListActionText>{t("screen.SweepClaimSheet.title")}</ListActionText>
          <ListActionTextMuted>{heldList(cardOtherHeld, cardOtherFiat)}</ListActionTextMuted>
          <ListActionTrailIcon name="chevron-right" />
        </ListAction>
      </List>
    ) : null;

  const pendingSweepExtra =
    openRail === "onchain" && unlockState.boardingSweepReadyCount > 0 ? (
      <List>
        <ListAction
          accessibilityLabel={t("screen.AssetScreen.pendingSweepA11yLabel", {
            amount: groupCount(unlockState.boardingSweepReadySats),
          })}
          onPress={() => emitArkadeOpenUnlockWallet("home_pending_sweep_row")}
        >
          <ListActionLeadingAvatar name="spinner" variant="outline" />
          <ListActionText>{t("screen.AssetScreen.pendingSweepLabel")}</ListActionText>
          <ListActionTextMuted>{t("screen.AssetScreen.pendingSweepStatus")}</ListActionTextMuted>
          <ListActionTrailingText>
            {`${groupCount(unlockState.boardingSweepReadySats)} sats`}
          </ListActionTrailingText>
          <ListActionTrailIcon name="chevron-right" />
        </ListAction>
      </List>
    ) : null;

  const receiveAddress = (() => {
    switch (receiveRail) {
      case "arkade":
        return {
          primary: {
            label: t("screen.HomeScreen.receiveLabelInstant"),
            value: addressSnapshot.currentAddress,
          },
          ...(addressSnapshot.musig2Address
            ? {
                secondary: {
                  label: t("screen.HomeScreen.receiveLabelOnchain"),
                  value: addressSnapshot.musig2Address,
                },
              }
            : {}),
        };
      case "onchain":
        return {
          primary: {
            label: t("screen.HomeScreen.receiveLabelOnchain"),
            value: addressSnapshot.musig2Address,
          },
        };
      // The EVM rails answer with the NAME first and keep the address behind the
      // flip: the name is the half a person can read back. With no handle
      // registered the sheet falls through to the address on its own.
      case "wallet":
      case "dollar":
        return {
          // The QR carries the 0x address on both faces: every wallet can scan it.
          primary: {
            label: t("screen.WalletScreen.ensNameLabel"),
            value: ensName,
            qrValue: evmAddress,
          },
          secondary: { label: t("screen.HomeScreen.receiveLabelEvm"), value: evmAddress },
        };
      default:
        return { primary: { label: "", value: null } };
    }
  })();

  // A bitcoin rail opened without its address loads one instead of waiting to
  // be asked. The retry below covers a generation that FAILED; this covers the
  // case where none ever ran here — the startup hydrate was the only attempt
  // per launch, and a login clears both address caches before hydrating, so one
  // failed wallet init left the sheet empty until the app restarted. The rail
  // and both addresses are the deps, so a failed attempt cannot re-trigger
  // itself, and reopening the sheet is a fresh attempt. No biometrics.
  useEffect(() => {
    if (receiveRail === "arkade" && !addressSnapshot.currentAddress) {
      void walletService.generateNewAddress();
    }
    if (receiveRail === "onchain" && !addressSnapshot.musig2Address) {
      void hydrateMusig2Address();
    }
  }, [receiveRail, addressSnapshot.currentAddress, addressSnapshot.musig2Address]);

  // The Wirex faces have nothing to show before there is an account, so they
  // start the signup instead of opening an empty detail screen. An account that
  // EXISTS but is still in verification resumes that verification — restarting
  // signup would ask for an email it already has and drop the Sumsub session.
  // Same dead end for an APPROVED account whose products never provisioned
  // (e.g. the SDD mandate is still open, caps NotFulfilled): the email is
  // pinned server-side, so a fresh signup answers `wirex_account_email_mismatch`
  // and the user has no way in. The permalink is server-driven and serves
  // exactly the step the account still owes.
  const wirexPendingVerification = wirexActivation === "resume";
  const openRailRow = useCallback(
    (key: RailKey) => {
      if ((key === "iban" || key === "visa") && wirexRailsNeedActivation) {
        if (wirexPendingVerification) void onboarding.continueVerification();
        else onboarding.start();
        return;
      }
      setOpenRail(homeGroupOf(key));
    },
    [
      wirexRailsNeedActivation,
      wirexPendingVerification,
      onboarding.start,
      onboarding.continueVerification,
    ],
  );

  // Deep links and notification taps name a rail, not a screen — this is the
  // only way in, so there is no second navigation path to keep in sync.
  useEffect(() => {
    // A cold start resolved its link before this screen existed, so the request
    // was parked; drain it on mount before listening for live ones.
    const parked = takePendingHomeRail();
    if (parked) openRailRow(parked);
    return EventBus.on<RailKey>(HOME_OPEN_RAIL_EVENT, (key) => {
      if (key) openRailRow(key);
    });
  }, [openRailRow]);

  // The app-wide reset (biometric lock, factory reset, a deep link taking over)
  // must leave nothing open — a details sheet holding card secrets least of all.
  useEffect(
    () =>
      EventBus.on("ui:resetMainScreens", () => {
        try {
          lifecycle.closeAll();
          cancelMoveHandoff();
          setOpenRail(null);
          setCarouselNavigationRevision((revision) => revision + 1);
          closeSettings();
          setAddressBookOpen(false);
          setEsimOpen(false);
          setReceiveRail(null);
          setHistoryRail(null);
          setScanVisible(false);
          setSwapVisible(false);
          setCardSheet(null);
          setCardPickFor(null);
          setRecipientSheetOpen(false);
          setSend(null);
          setTopUp(null);
          setBtcSendSource(null);
          setBtcSendPrefill(undefined);
          setBtcSendPayout(undefined);
          setSweepResult(null);
          setCardFoundVisible(false);
          setDetailsChoiceVisible(false);
          // A link parked for a home that never opened it must not fire after the
          // takeover that just asked everything to close.
          clearPendingHomeRail();
          wirexSend.closeRecipient();
          wirexSend.setAmountVisible(false);
          // The wallet's own sheets hold a recipient and an amount, and the
          // onboarding holds the account email — it was
          // still on screen after the takeover that asked everything to close.
          walletSend.closeAll();
          onboarding.cancel();
          cardPayout.closeAll();
        } catch {}
      }),
    [
      lifecycle.closeAll,
      cancelMoveHandoff,
      wirexSend.closeRecipient,
      wirexSend.setAmountVisible,
      walletSend.closeAll,
      onboarding.cancel,
      cardPayout.closeAll,
    ],
  );

  const retryArkadeAddress = useCallback(() => {
    void walletService.generateNewAddress();
  }, []);

  // Card details fetch the card's secrets as the sheet opens (a frozen card
  // shows the unfreeze hint instead); bank details open without fetching.
  const openCardDetails = useCallback(() => {
    const cardId = wirex.card?.id ?? null;
    if (
      !cardId ||
      !mayRevealCardSecrets(wirex.isAccountBlocked, cardId) ||
      wirex.isFrozen === true
    ) {
      return reveal.open("card");
    }
    return void reveal.reveal({ id: cardId });
  }, [reveal.open, reveal.reveal, wirex.card?.id, wirex.isAccountBlocked, wirex.isFrozen]);
  const openBankDetails = useCallback(() => reveal.open("bank"), [reveal.open]);
  // Details on Visa & Banking asks which one first.
  const [detailsChoiceVisible, setDetailsChoiceVisible] = useState(false);

  // Details on a home card: Visa & Banking opens its details sheet, Bitcoin and
  // Cash their receive addresses.
  const receiveFromRail = useCallback(
    (key: RailKey | null) => {
      if (key === "visa") return openCardDetails();
      if (key === "iban") return openBankDetails();
      setReceiveRail(key === "onchain" ? "arkade" : key);
    },
    [openCardDetails, openBankDetails],
  );

  // A support deep link (`show-iban` / `show-card-number`) parks its target and
  // this drains it once the matching Wirex data exists. App opens the rail's
  // asset screen first, so the sheet lands on top of the right one.
  useCardDetailDeepLink({
    bankReady: isWirexBankReady(wirex),
    cardId: lifecycle.activeCard?.id ?? null,
    cardFrozen: lifecycle.activeCard?.isFrozen === true,
    openDetails: reveal.open,
    revealCard: lifecycle.revealCard,
  });

  // Tap on a bank-rail activity row → send to that counterparty again: the
  // recipient screen opens with IBAN + name prefilled (reference stays empty),
  // then the normal amount/confirm flow follows.
  const handleSendAgain = useCallback(
    (counterparty: WirexBankCounterparty) => {
      const nameParts = counterparty.name.trim().split(/\s+/);
      setHistoryRail(null);
      wirexSend.startSepaTo({
        iban: counterparty.iban,
        bic: counterparty.bic,
        firstName: nameParts[0] ?? "",
        lastName: nameParts.slice(1).join(" "),
      });
    },
    [wirexSend.startSepaTo],
  );

  // Send again on a Cash activity row: the send opens on that address, paid
  // from the currency of the list it was in. Nothing is sent until confirmed.
  const sendAgainFromCash = useCallback(
    (address: string) => {
      const rail = historyRail === "dollar" ? "dollar" : "wallet";
      setHistoryRail(null);
      // A Cash row is a Base transfer: the network is known.
      routeSendRef.current({ destinations: [baseDestination(address)], person: null }, [rail]);
    },
    [historyRail],
  );

  // Paying a saved contact: close Address book and Settings, then hand the
  // destination to the flow a scan of it would open. Nothing new is sent here.
  const payFromAddressBook = useCallback(
    async (
      route: Exclude<SendRoute, { kind: "unsupported" }>,
      destination: Destination,
      contact: Contact,
    ): Promise<string | undefined> => {
      // Same gate as a scanned IBAN: without a ready Wirex bank account the
      // transfer would reach its confirmation with no account to debit.
      if ((route.kind === "sepa" || route.kind === "card") && !wirexBankReady) {
        return t("screen.HomeScreen.scanBankUnavailable");
      }
      // Checked before anything closes: a refused handoff keeps the contact open.
      if (route.kind === "evm" && !isValidEvmAddress(route.address)) {
        return t("screen.AddressBook.invalidAddress");
      }
      // The contact is the recipient, with every address they have: the same
      // checked send as any other, on the balance that pays them best.
      let recipient: SendRecipient | null = null;
      if (route.kind === "bitcoin" || route.kind === "evm" || route.kind === "evm-network") {
        const parsed = route.kind === "bitcoin" ? parseRecipientInput(route.target) : null;
        const destinations =
          route.kind === "evm-network"
            ? [namedEvmDestination(route.address, route.network)]
            : route.kind === "evm"
              ? [
                  destination.type === "crypto" && destination.network === "evm"
                    ? evmDestination(route.address)
                    : baseDestination(route.address),
                ]
              : parsed?.kind === "destinations"
                ? parsed.destinations
                : [];
        if (destinations.length === 0) return undefined;
        const person = contact.nuriUsername
          ? { name: contact.label, nuriUsername: contact.nuriUsername }
          : null;
        const checked = await checkSendRecipientRef.current({ destinations, person });
        // Address book closed meanwhile: nothing opens.
        if (!addressBookOpenRef.current) return undefined;
        if (typeof checked === "string") return checked;
        recipient = checked;
      }
      setAddressBookOpen(false);
      closeSettings();
      setTimeout(() => {
        switch (route.kind) {
          case "bitcoin":
          case "evm":
          case "evm-network":
            if (recipient) routeSendRef.current(recipient, []);
            return;
          case "sepa": {
            const parts = route.holder.trim() ? route.holder.trim().split(/\s+/) : [];
            wirexSend.startSepaTo({
              iban: route.iban,
              bic: route.bic,
              firstName: parts[0] ?? "",
              lastName: parts.slice(1).join(" "),
            });
            return;
          }
          case "card":
            cardPayout.startWith({ name: route.holder, number: route.number });
            return;
        }
      }, MODAL_HANDOFF_DELAY_MS);
      return undefined;
    },
    [wirexBankReady, wirexSend.startSepaTo, cardPayout.startWith],
  );

  // "Add to address book" on an activity row: close the history and open the
  // book's add form on that recipient.
  const [addressBookSaveRequest, setAddressBookSaveRequest] = useState<SaveOffer | null>(null);
  useEffect(
    () =>
      EventBus.on<SaveOffer>("addressBook:saveDestination", (offer) => {
        if (!offer?.destination) return;
        setHistoryRail(null);
        setAddressBookSaveRequest(offer);
        setAddressBookOpen(true);
      }),
    [],
  );
  const clearAddressBookSaveRequest = useCallback(() => setAddressBookSaveRequest(null), []);

  // The amount typed on one side, expressed on the other: sats through the BTC
  // rate, euros and dollars through FX, straight between the two rails' own
  // currencies — the display currency is not a leg of it. Null when a rate is
  // missing, so the field stays blank rather than showing a made-up number.
  // A send's recipient is a rail of the Move card too, counted in what they get.
  const railIsBtc = useCallback(
    (key: string | null | undefined) =>
      key === SEND_RECIPIENT_RAIL ? sendSwap?.fiat === null : isBtcRail(key),
    [sendSwap],
  );
  const railFiatOf = useCallback(
    (key: string | null | undefined): FiatCode =>
      key === SEND_RECIPIENT_RAIL ? (sendSwap?.fiat ?? home) : railFiat(key, home),
    [sendSwap, home],
  );
  const swapCounterValue = useCallback(
    (typed: number, focus: "from" | "to"): number | null => {
      const source = focus === "from" ? swapFrom : swapTo;
      const target = focus === "from" ? swapTo : swapFrom;
      if (!source || !target || !Number.isFinite(typed)) return null;
      if (railIsBtc(source)) {
        return railIsBtc(target)
          ? typed
          : satsToFiatIn(typed, railFiatOf(target), btcQuote, fxRates);
      }
      if (railIsBtc(target)) return fiatToSats(typed, railFiatOf(source));
      return convertFiat(typed, railFiatOf(source), railFiatOf(target), fxRates);
    },
    [swapFrom, swapTo, btcQuote, fxRates, fiatToSats, railIsBtc, railFiatOf],
  );

  // The same number, formatted for the unfocused half.
  // The one way a figure is written on the Move card, whatever produced it: the
  // counter, the quote and the route rows are the same number at different
  // moments, so they cannot each bring their own grouping and rounding.
  const swapRailAmount = useCallback(
    (value: number, railKey: string): string => {
      if (railIsBtc(railKey)) return satsGlyph(value);
      return heldGlyph(value, railFiatOf(railKey));
    },
    [satsGlyph, heldGlyph, railIsBtc, railFiatOf],
  );

  const swapCounterAmount = useCallback(
    (typed: number, focus: "from" | "to"): string | null => {
      const value = swapCounterValue(typed, focus);
      if (value === null) return null;
      const target = focus === "from" ? swapTo : swapFrom;
      return target ? swapRailAmount(value, target) : null;
    },
    [swapCounterValue, swapFrom, swapTo, swapRailAmount],
  );

  // Read from the SNAPSHOT, not the singleton: the deposit address arrives with
  // Wirex's own load, and a Move opened before that answer would otherwise cache
  // "no card destination" and keep it after the address was there all along.
  const cardSwapTargetOf = useCallback(
    (toRailKey: string) => cardSwapTargetFor(swapFrom, toRailKey, wirex.smartAccountAddress, home),
    [swapFrom, wirex.smartAccountAddress, home],
  );

  // A chooser hands over to the Move card the way every other sheet hand-off
  // works: iOS cannot present a sheet in the same tick another is dismissed
  // (#522), and a Move card opened in the chooser's own tap is exactly that —
  // the presentation is swallowed and the tap does nothing.
  // Seeds both ends when the sheet OPENS: a source with fixed exits starts on
  // one of them. A user's pick of a source moves the destination the same way
  // (moveSourcePick); an unreachable destination is refused by the sheet (#1467).
  const setMovePair = useCallback(
    (from: RailKey | null, to: RailKey | null) => {
      // The IBAN is the same Wirex money as the card, and only the card is on
      // the Move sheet.
      const source = from === "iban" ? "visa" : from;
      const target = to === "iban" ? "visa" : to;
      setSwapFrom(source);
      const allowed = moveDestinationsForKey(source, home) as RailKey[] | null;
      setSwapTo(allowed && (!target || !allowed.includes(target)) ? allowed[0] : target);
    },
    [home],
  );

  useEffect(() => cancelMoveHandoff, [cancelMoveHandoff]);

  const openSwap = useCallback(
    (from: RailKey | null) => {
      const isBtc = (k: RailKey) => k === "arkade" || k === "onchain";
      // A home card names its group; the move starts on the rail that spends.
      const source = from === "onchain" ? btcRail : from === "wallet" || !from ? cashRail : from;
      // Named, not "the first row that isn't bitcoin": the euro wallet is the
      // counterparty a bitcoin move defaults to, and row order is the product's
      // to change without moving that default onto the dollar.
      const target = isBtc(source) ? "wallet" : (rails.find((r) => isBtc(r.key))?.key ?? "arkade");
      setSendSwap(null);
      setMoveLock(null);
      setMovePair(source, target);
      setSwapVisible(true);
    },
    [rails, setMovePair, btcRail, cashRail],
  );

  // The Move sheet with one end fixed: the card the user is adding money to
  // (destination) or sending from (source).
  const openLockedMove = useCallback(
    (from: RailKey, to: RailKey, lock: "from" | "to") => {
      cancelMoveHandoff();
      moveHandoffTimerRef.current = setTimeout(() => {
        moveHandoffTimerRef.current = null;
        setSendSwap(null);
        setMoveLock(lock);
        setMovePair(from, to);
        setSwapVisible(true);
      }, MODAL_HANDOFF_DELAY_MS);
    },
    [cancelMoveHandoff, setMovePair],
  );

  const settleWallet = cardSettleWalletRail(home);
  // The two buttons on a card. Send on Cash or Bitcoin is the one send flow:
  // its recipient step first, and the card's own balances preferred to pay.
  const openCardSheet = useCallback(
    (kind: "add" | "send", card: HomeCard) => {
      if (kind === "send" && (card === "wallet" || card === "onchain")) {
        sendStartRef.current =
          card === "wallet"
            ? settleWallet === "dollar"
              ? ["dollar", "wallet"]
              : ["wallet", "dollar"]
            : [btcRail, btcRail === "onchain" ? "arkade" : "onchain"];
        return handOff(() => setRecipientSheetOpen(true));
      }
      setCardSheet({ kind, card });
    },
    [settleWallet, btcRail, handOff],
  );
  const onCardButton = useCallback(
    (kind: "add" | "send") => {
      const card = carouselRailKey as HomeCard | null;
      // Send from the total goes straight to the recipient: the balance that
      // pays is picked on the amount screen.
      if (!card && kind === "send") {
        sendStartRef.current = [];
        return setRecipientSheetOpen(true);
      }
      if (!card) return setCardPickFor(kind);
      openCardSheet(kind, card);
    },
    [carouselRailKey, openCardSheet],
  );

  const addMoneyItems = (card: HomeCard) => [
    {
      key: "balances",
      icon: "transfer-vertical" as const,
      accent: "lilac" as const,
      label: t("screen.HomeScreen.addFromBalances"),
    },
    card === "visa"
      ? {
          key: "bank",
          icon: "bank" as const,
          accent: "lilac" as const,
          label: t("screen.HomeScreen.addByBankTransfer"),
          // Bank details need the IBAN, which can come after the card.
          disabled: !wirexBankReady,
        }
      : {
          key: "receive",
          icon: "qr" as const,
          accent: "lilac" as const,
          label: t("screen.HomeScreen.addReceive"),
        },
    {
      key: "wallet",
      icon: "wallet" as const,
      accent: "lilac" as const,
      label: t("screen.HomeScreen.addFromWallet"),
    },
    ...(card === "onchain"
      ? [
          {
            key: "buy",
            icon: "apple" as const,
            accent: "neutral" as const,
            label: t("screen.HomeScreen.addMoneyPay"),
          },
        ]
      : []),
  ];

  const onAddMoney = (card: HomeCard, key: string) => {
    setCardSheet(null);
    switch (key) {
      case "balances": {
        const to: RailKey =
          card === "onchain" ? "arkade" : card === "wallet" ? settleWallet : "visa";
        const from: RailKey =
          card === "onchain" ? cashRail : card === "wallet" ? btcRail : settleWallet;
        return openLockedMove(from, to, "to");
      }
      case "receive":
        return handOff(() => setReceiveRail(card === "onchain" ? "arkade" : settleWallet));
      case "wallet": {
        // Any token the other wallet holds is swapped into what the balance
        // takes and settles at its own address: the boarding address for
        // Bitcoin, the EVM wallet for Cash, the deposit address for the card.
        const stable = home === "USD" ? "USDC_BASE" : "EURC_BASE";
        const payoutAddress = (
          card === "onchain"
            ? addressSnapshot.currentAddress
            : card === "visa"
              ? wirex.smartAccountAddress
              : evmAddress
        )?.trim();
        if (!payoutAddress) return;
        const settle: PayWalletSettle = card === "onchain" ? "BTC" : stable;
        // Named and written the way the home names and writes that balance.
        const label = t(
          card === "onchain"
            ? "screen.HomeScreen.railBitcoin"
            : card === "visa"
              ? "screen.HomeScreen.railVisa"
              : home === "USD"
                ? "screen.HomeScreen.railDollar"
                : "screen.HomeScreen.railEuro",
        );
        const formatReceive = (amount: string) =>
          card === "onchain"
            ? satsGlyph(toSatsFromBtcAmount(amount))
            : heldGlyph(Number(amount), home);
        // The balance that shows it as incoming: the boarding address is
        // Lightning's, the card takes it in the pocket of its currency.
        const rail: Exclude<RailKey, "iban"> =
          card === "onchain"
            ? "arkade"
            : card === "visa"
              ? home === "USD"
                ? "visaUsd"
                : "visa"
              : settleWallet;
        return handOff(() =>
          setTopUp({ id: Date.now(), settle, payoutAddress, rail, label, formatReceive }),
        );
      }
      case "bank":
        return handOff(openBankDetails);
      case "buy":
        return buyFlow.open();
    }
  };

  // Send on Visa & Banking: Cash and Bitcoin go through the one send flow.
  const onSend = (key: string) => {
    setCardSheet(null);
    if (key === "balances") return openLockedMove("visa", settleWallet, "from");
    if (key === "card") return void cardPayout.start();
    return wirexSend.startSepa();
  };

  // The moves with no exchange in them. The Move sheet prices and runs every
  // pair the swap contract names on both ends; what reaches here is the rest —
  // the wallet filling the card pocket that holds the SAME currency (and the
  // way back out), which is a plain transfer with nothing to quote, plus
  // Bitcoin → card, which settles to the Wirex smart account (a destination the
  // contract has no asset for, so that leg keeps the top-up sheet until it does).
  // Euro wallet → the card's euro pocket: one EURC transfer to the card's own
  // address. Both balances step the moment it is broadcast — they belong to the
  // same person, so nothing here waits for the chain. The service owns that
  // bookkeeping, because the moves have to be parked before it announces the
  // transaction. A failure is RAISED, not logged: the Move sheet is still up and
  // owns the wait, the failure and the retry.
  // Every decimal the token has, not cents: a full balance (the sheet sends the
  // exact figure when the user types the rounded one) goes out whole, and a
  // rounded-up "1.00" for 0.995018 would ask for money that is not there.
  const runEuroToCard = useCallback(async (amountEur: number) => {
    if (!(amountEur > 0)) return;
    await withCardTransferPill(
      () => sendEuroToCard(stableAmountText(amountEur)),
      (r) => r,
    );
  }, []);

  // The same transfer one currency over: USDC into the card's dollar pocket.
  const runDollarToCard = useCallback(async (amountUsd: number) => {
    if (!(amountUsd > 0)) return;
    await withCardTransferPill(
      () => sendDollarToCard(stableAmountText(amountUsd)),
      (r) => r,
    );
  }, []);

  // The same move backwards, in whichever currency the pocket holds.
  // `handleWithdraw` already owns the debit, the wallet's credit event and the
  // rollback, so this only hands it the amount and the asset — and passes its
  // outcome on. A withdrawal whose result is unknown AFTER the execution
  // approval is marked `unresolved`: the funds may have moved, so the sheet must
  // hold that state and refuse another attempt rather than inviting the user to
  // withdraw the same money twice.
  const runCardToWallet = useCallback(
    async (amount: number, asset: WirexWithdrawAsset) => {
      if (!(amount > 0)) return;
      try {
        await withCardTransferPill(
          () => wirexSend.handleWithdraw(stableAmountText(amount), asset),
          null,
          // Completed on the pill and the rows leaving are one moment.
          { completesOnResolve: true, inFlightIdOf: (done) => done?.inFlightId },
        );
      } catch (error) {
        const unresolved = error instanceof WirexWithdrawUnconfirmedError;
        // A dismissed passkey prompt is a deliberate choice, not a failure to
        // report: nothing moved, so it goes back to the caller silently.
        if (!unresolved && isUserCancelledAuth(error)) throw error;
        // The user is being shown this, so support gets it with the chat open —
        // the same handling the card's own withdraw screen gives it. An
        // unresolved withdrawal is the one a person cannot settle alone.
        void reportErrorToSupport({
          error,
          userMessage: unresolved ? "Card withdrawal is unconfirmed" : "Card withdrawal failed",
        }).catch(() => {});
        if (unresolved) throw Object.assign(error, { unresolved: true });
        throw error;
      }
    },
    [wirexSend.handleWithdraw],
  );

  // The amount travels with every hand-off that still needs a screen: a real
  // swap keeps its own, and opens on the figure the Move sheet already stated
  // instead of starting again at zero.
  const confirmSwap = useCallback(
    async (sourceAmount: number): Promise<MoveOutcome> => {
      if (!swapFrom || !swapTo) return "unhandled";

      // Euro wallet ↔ card is the SAME euro on both ends. There is no rate, no
      // route and nothing left to say, so Next performs the move: a second
      // screen asking for an amount that was already given, and a confirmation
      // of a decision already made, is the whole complaint.
      // Returned, not fired and forgotten: the sheet holds the screen until the
      // transfer resolves and shows its own failure state, and it closes itself
      // on success.
      const settleWallet = cardSettleWalletRail(home);
      if (swapFrom === settleWallet && isCardRail(swapTo)) {
        return (home === "USD" ? runDollarToCard : runEuroToCard)(sourceAmount).then(
          () => "transferred" as const,
        );
      }
      // Out of the card, into the wallet holding its currency: the card unwraps
      // its settlement synthetic (WEUR to EURC, WUSD to USDC).
      if (isCardRail(swapFrom) && swapTo === settleWallet) {
        return runCardToWallet(sourceAmount, home === "USD" ? "USDC" : "EURC").then(
          () => "transferred" as const,
        );
      }
      // Bitcoin ↔ Bitcoin is not a swap — the two rails share one asset. Moving
      // arkade → on-chain is the SAME operation as sending arkade to an external
      // Bitcoin address, only the destination is this wallet's own MuSig2
      // address: route it Lightning→Bitcoin (never a collaborative-exit
      // offboard, which some vtxos cannot do instantly). The reverse direction
      // still boards straight to the arkade boarding address.
      if (swapFrom === "arkade" && swapTo === "onchain") {
        const sats = Math.max(0, Math.trunc(sourceAmount));
        const toAddress = addressSnapshot.musig2Address.trim();
        const owner = (evmAddress || "").trim();
        if (!(sats > 0) || !toAddress || !owner) return "unhandled";
        // Route Lightning→Bitcoin (never a collaborative-exit offboard, which
        // some vtxos cannot do instantly). runTransfer closes the sheet snappy
        // and owns failure recovery; this resolves once the order is committed.
        return withCardTransferPill(
          () => sendArkadeToBitcoinViaLightning({ toAddress, sats, owner }),
          null,
          { preparing: true, handedOff: () => true },
        ).then(() => "transferred" as const);
      }
      if (swapFrom === "onchain" && swapTo === "arkade") {
        const sats = Math.max(0, Math.trunc(sourceAmount));
        let toAddress = addressSnapshot.currentAddress.trim();
        if (!toAddress) {
          // The arkade boarding address may not have hydrated yet while the
          // MuSig2 address did. Generate it now instead of silently doing
          // nothing on every Next press.
          const generated = await walletService.generateNewAddress();
          toAddress = (generated || addressSnapshot.currentAddress || "").trim();
        }
        if (!(sats > 0) || !toAddress) return "unhandled";
        return withCardTransferPill(
          () =>
            boardOnchainToArkade({
              toAddress,
              amountSats: sats,
              onchainSpendableSats,
            }),
          null,
          { preparing: true, inFlightIdOf: (sent) => sent.txid },
        ).then(() => "transferred" as const);
      }
      // Every other unpriceable pair — the card out to bitcoin, for one — has no
      // transfer here. Saying so leaves the user on the card they were filling
      // in, instead of closing as if the move had been made.
      return "unhandled";
    },
    [
      swapFrom,
      swapTo,
      runEuroToCard,
      runDollarToCard,
      runCardToWallet,
      addressSnapshot.musig2Address,
      addressSnapshot.currentAddress,
      onchainSpendableSats,
      home,
    ],
  );

  // A home rail as the Move card states it.
  const toMoveRail = (rail: Rail) => {
    const btc = isBtcRail(rail.key);
    const cardTarget = cardSwapTargetOf(rail.key);
    return {
      key: rail.key,
      label: rail.label,
      image: rail.image,
      accent: rail.accent,
      amount: rail.amount,
      ...(rail.available != null ? { available: rail.available } : {}),
      unit: btc ? BTC_GLYPH : CURRENCIES[railFiat(rail.key, home)].fiatSymbol,
      whole: btc,
      ...(RAIL_SWAP_ASSET[rail.key] ? { asset: RAIL_SWAP_ASSET[rail.key] } : {}),
      ...(cardTarget ?? {}),
      // Both bitcoin rails are one asset to SwapKit, so the rail has to
      // say which wallet pays — and, as a destination, which one receives.
      // Without either, the swap silently uses the arkade wallet.
      ...(rail.key === "onchain" || rail.key === "arkade"
        ? { sendSource: rail.key === "onchain" ? ("onchain" as const) : ("arkade" as const) }
        : {}),
      // Every bitcoin rail states where a swap into it settles. Nothing
      // downstream may fall back to "the other one".
      ...(rail.key === "onchain" && addressSnapshot.musig2Address
        ? { settleAddress: addressSnapshot.musig2Address }
        : {}),
      ...(rail.key === "arkade" && addressSnapshot.currentAddress
        ? { settleAddress: addressSnapshot.currentAddress }
        : {}),
    };
  };

  const [logoutConfirmVisible, setLogoutConfirmVisible] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const handleLogout = useCallback(async () => {
    setLogoutBusy(true);
    if ((await requestUserLogout()) === "failed") setLogoutBusy(false);
  }, []);

  return (
    <>
      <Screen>
        {/* grow-SHRINK, not grow: a flexShrink:0 box grows to its CONTENT in a
            browser instead of being capped by the screen, and the Scroll inside
            then never gets a bounded height — nothing scrolls anywhere on the
            PWA. Same defect DsSheetHost pins for full modals; this screen is not
            one, so it has to shrink on its own. */}
        <View chrome="canvas" direction="column" align="stretch" fill="grow-shrink">
          <Header safeAreaTop chrome="canvas">
            <Topbar layout="fluid" surface="transparent">
              <TopbarTitle>
                {/* Eight taps here open the debug hub — the gesture the Nuri
                    logo carried while the tabs existed. */}
                <Pressable onPress={handleGreetingPress}>
                  <Text size="lg" emphasis>
                    {t("screen.HomeScreen.greeting", {
                      name: username ?? t("screen.HomeScreen.greetingFallback"),
                    })}
                  </Text>
                </Pressable>
              </TopbarTitle>
              {/* The scanner, on every card. */}
              <TopbarTrailing>
                <IconButton
                  icon="qr-scan"
                  variant="soft"
                  accessibilityLabel={t("screen.HomeScreen.scanA11yLabel")}
                  onPress={() => {
                    sendStartRef.current = [];
                    setScanFromSend(false);
                    setScanVisible(true);
                  }}
                />
              </TopbarTrailing>
            </Topbar>
          </Header>

          <Scroll safeAreaBottom>
            <View direction="column" align="stretch" gap="lg" paddingY="md">
              {homeCarouselEnabled ? (
                <HomeCardCarousel
                  navigationRevision={carouselNavigationRevision}
                  totalLabel={t("screen.HomeScreen.totalBalance")}
                  totalAmount={total}
                  totalImages={carouselRails.map((rail) => rail.images[0])}
                  items={carouselRails.map((rail) => ({
                    key: rail.key,
                    label: rail.label,
                    images: rail.images,
                    amount: rail.amount,
                    inactiveVisaArtwork: wirexRailsNeedActivation && rail.key === "visa",
                    ...(rail.key !== "visa" || wirexRailsNeedActivation
                      ? {}
                      : {
                          detailsLabel: t("screen.HomeScreen.details"),
                          onDetails: () => setDetailsChoiceVisible(true),
                        }),
                  }))}
                  selectedKey={carouselRailKey}
                  onSelect={(key) => setOpenRail(key as RailKey | null)}
                />
              ) : (
                <BalanceRegion
                  amount={total}
                  onSwap={() => openSwap(null)}
                  swapA11yLabel={t("screen.HomeScreen.swapA11yLabel")}
                />
              )}

              {homeCarouselEnabled ? (
                inactiveWirexRailSelected ? (
                  <View align="stretch" paddingX="lg">
                    <Button size="lg" variant="solid" onPress={() => openRailRow(carouselRailKey)}>
                      <ButtonText>{t("screen.HomeScreen.activateCardBank")}</ButtonText>
                    </Button>
                  </View>
                ) : (
                  <View direction="row" align="center" gap="sm" distribute="even" paddingX="lg">
                    {/* Two direct children, never a fragment: the row's even
                        split counts its children, and a fragment counts as one,
                        which stacked the buttons. Add money always sits right. */}
                    <Button size="lg" variant="soft" onPress={() => onCardButton("send")}>
                      <ButtonText>{t("actions.send")}</ButtonText>
                    </Button>
                    <Button size="lg" variant="solid" onPress={() => onCardButton("add")}>
                      <ButtonText>{t("screen.HomeScreen.addMoney")}</ButtonText>
                    </Button>
                  </View>
                )
              ) : (
                <View direction="column" align="stretch" paddingX="lg">
                  <Button size="lg" variant="solid" onPress={() => onCardButton("add")}>
                    <ButtonText>{t("screen.HomeScreen.addMoney")}</ButtonText>
                  </Button>
                </View>
              )}

              {homeCarouselEnabled && carouselOpenedRail && !inactiveWirexRailSelected ? (
                <AssetActivityList
                  assetLabel={carouselOpenedRail.label}
                  pending={pendingFor(carouselRailKey)}
                  balances={groupBalanceRows}
                  onHistory={() =>
                    setHistoryRail(
                      carouselRailKey === "visa"
                        ? "visa"
                        : carouselRailKey === "onchain"
                          ? btcRail
                          : cashRail,
                    )
                  }
                  extra={pendingSweepExtra ?? cardFoundExtra}
                />
              ) : (
                <List>
                  {overviewGroups.map((group, index) => (
                    <React.Fragment key={group.key}>
                      {index > 0 ? <ListSeparator /> : null}
                      <ListAction
                        accessibilityLabel={`${overviewLabels[group.key]}, ${overviewFigure(group.amountHome, home)}`}
                        onPress={() => selectOverviewRail(group.rail)}
                      >
                        <ListActionLeadingAvatar source={overviewImages[group.key]} />
                        <ListActionText>{overviewLabels[group.key]}</ListActionText>
                        <ListActionTextMuted>
                          {overviewFigure(group.amountHome, home)}
                        </ListActionTextMuted>
                        <ListActionTrailIcon name="chevron-right" />
                      </ListAction>
                    </React.Fragment>
                  ))}
                </List>
              )}
            </View>
          </Scroll>

          {/* Settings floats over the body, bottom-right — the slot support
                  held. Support lives inside Settings now, so its unread badge
                  stays on this button: an unanswered reply is still visible
                  from the home. */}
          <RNView pointerEvents="box-none" style={styles.settingsFloat}>
            <IconButton
              icon="settings"
              variant="soft"
              accessibilityLabel={t("screen.HomeScreen.settingsA11yLabel")}
              onPress={openSettings}
            />
            <NotificationBadge count={supportUnread} />
          </RNView>
        </View>
      </Screen>

      <AssetScreen
        visible={!homeCarouselEnabled && Boolean(assetView)}
        asset={assetView}
        onClose={() => setOpenRail(null)}
        onSwap={() => openSwap(openRail)}
        pending={pendingFor(openRail)}
        balances={groupBalanceRows}
        onReceive={() => receiveFromRail(openRail)}
        onSend={() => onCardButton("send")}
        onHistory={() => setHistoryRail(openRail)}
        extra={pendingSweepExtra ?? cardFoundExtra}
      />

      <SettingsScreen
        visible={settingsOpen}
        onClose={closeSettings}
        username={username}
        verification={verificationRow(wirexActivationInput)}
        onVerify={() => {
          const step = verificationRow(wirexActivationInput).action;
          if (!step) return;
          // The email step and the KYC browser hand-off present over the home;
          // Settings steps aside so they are not buried under it.
          closeSettings();
          setTimeout(() => {
            if (step === "resume") void onboarding.continueVerification();
            else onboarding.start();
          }, MODAL_HANDOFF_DELAY_MS);
        }}
        onOpenAddressBook={() => setAddressBookOpen(true)}
        onOpenEsim={() => setEsimOpen(true)}
        onLogout={() => setLogoutConfirmVisible(true)}
      />

      {/* An eSIM order's invoice opens the SAME Bitcoin send sheet a scanned
          Lightning invoice does, on top of the eSIM page. */}
      <EsimScreen
        visible={esimOpen}
        onClose={() => setEsimOpen(false)}
        onPayInvoice={(invoice, amountSats) => {
          setSend(null);
          setBtcSendPrefill(invoice);
          setBtcSendAmountSats(amountSats > 0 ? String(Math.trunc(amountSats)) : undefined);
          setBtcSendSource("arkade");
        }}
      />

      {/* A saved destination opens the SAME send flow a scanned code does. */}
      <AddressBookScreen
        visible={addressBookOpen}
        onClose={() => {
          setAddressBookOpen(false);
          setAddressBookSaveRequest(null);
        }}
        loadBook={getAddressBook}
        onPay={payFromAddressBook}
        saveRequest={addressBookSaveRequest}
        onSaveRequestHandled={clearAddressBookSaveRequest}
      />

      <ReceiveModal
        visible={Boolean(receiveRail)}
        onClose={() => setReceiveRail(null)}
        // No rail in the title: "Receive Bitcoin Lightning" truncates, and the
        // address row below already names the rail.
        title={t("screen.HomeScreen.receiveTitle")}
        primary={receiveAddress.primary}
        secondary={receiveAddress.secondary}
        isGenerating={addressSnapshot.isGeneratingAddress}
        emptyText={t("screen.HomeScreen.receiveEmpty")}
        // Only the arkade rail derives its address here, so only it can fail
        // here — and without the retry the sheet just says "no address yet".
        errorText={
          receiveRail === "arkade" && addressSnapshot.addressError
            ? t("screen.BitcoinReceiveModal.walletGettingReady")
            : undefined
        }
        onRetry={receiveRail === "arkade" ? retryArkadeAddress : undefined}
        onRequest={
          receiveRail === "arkade"
            ? () => {
                setReceiveRail(null);
                setTimeout(() => setShowLightningInvoiceSheet(true), 0);
              }
            : undefined
        }
      />

      <LightningInvoiceSheet
        visible={showLightningInvoiceSheet}
        onClose={() => setShowLightningInvoiceSheet(false)}
        onCreateInvoice={async (amountSats) => {
          // The server receive API states an expiry only when it has one; the
          // sheet needs a concrete deadline to count down from, so fall back to
          // the corridor's own 10-minute invoice life rather than showing none.
          const created = await createArkadeLightningInvoice({ amountSats });
          return {
            invoice: created.invoice,
            expiresAtMs: created.expiresAtMs ?? Date.now() + (created.expirySeconds ?? 600) * 1000,
          };
        }}
      />

      <MoveSheet
        visible={swapVisible}
        onClose={() => setSwapVisible(false)}
        onReopenOnFailure={() => setSwapVisible(true)}
        rails={
          sendSwap
            ? [
                // The balances that can pay this recipient, and the recipient.
                ...moveRails
                  .filter((rail) =>
                    sendBalanceOptions(sendSwap.recipient).some(
                      (option) => option.key === rail.key,
                    ),
                  )
                  .map(toMoveRail),
                {
                  key: SEND_RECIPIENT_RAIL,
                  label: sendSwap.recipient.person?.name ?? shortAddress(sendSwap.address),
                  image: sendSwap.recipient.person
                    ? contactAvatar({
                        label: sendSwap.recipient.person.name,
                        nuriUsername: sendSwap.recipient.person.nuriUsername,
                      })
                    : sendSwap.fiat === null
                      ? BTC_LOGO
                      : sendSwap.fiat === "USD"
                        ? USD_FLAG
                        : EUR_FLAG,
                  amount: "",
                  unit: sendSwap.fiat === null ? BTC_GLYPH : CURRENCIES[sendSwap.fiat].fiatSymbol,
                  whole: sendSwap.fiat === null,
                  asset: sendSwap.asset,
                  settleAddress: sendSwap.address,
                  settleKind: "external" as const,
                },
              ]
            : moveRails.map(toMoveRail)
        }
        destinationsFor={(key: string) =>
          sendSwap ? [SEND_RECIPIENT_RAIL] : moveDestinationsForKey(key, home)
        }
        locked={moveLock}
        {...(sendSwap?.exactReceive !== undefined ? { exactReceive: sendSwap.exactReceive } : {})}
        fromKey={swapFrom}
        toKey={swapTo}
        // Any source may be picked: the destination stays when the new pair is
        // open, else moves to the source's own default — never an impossible
        // pair. A destination pick is only handed over when it is reachable.
        onPickFrom={(key: string) => {
          // A send: another balance that swaps stays on this card; one that
          // pays the recipient directly opens its own amount screen.
          if (sendSwap) {
            const balance = key as SendBalance;
            if (isSwapRoute(routeFor(balance, sendSwap.recipient.destinations))) {
              setSwapFrom(balance);
              setSend({ recipient: sendSwap.recipient, balance });
            } else {
              switchSendBalance(balance);
            }
            return;
          }
          // Add money: the card stays the destination; only the source changes.
          if (moveLock === "to") {
            if (key !== swapTo) setSwapFrom(key as RailKey);
            return;
          }
          const pair = moveSourcePick(
            (from) => moveDestinationsForKey(from, home),
            { fromKey: swapFrom, toKey: swapTo },
            key,
          );
          setSwapFrom(pair.fromKey as RailKey);
          setSwapTo(pair.toKey as RailKey | null);
        }}
        onPickTo={(key: string) => setSwapTo(key as RailKey)}
        counterAmount={swapCounterAmount}
        railAmount={swapRailAmount}
        counterValue={swapCounterValue}
        onFlip={() => {
          // Keep whichever side the user was typing in pointing at the same
          // half of the card, so flipping re-reads as "the other direction"
          // rather than jumping the cursor. Both ends stay what the user chose;
          // a direction with no route is shown unavailable, never rewritten.
          setSwapFrom(swapTo);
          setSwapTo(swapFrom);
        }}
        onConfirm={confirmSwap}
        onExecuted={({ quote, execution }) => {
          // A move INTO the card has no other owner until Wirex settles it: the
          // order is with the durable tracker, so the card states what was
          // bought now and the order's own settlement confirms or takes it back
          // — this session or after a restart.
          const credit = cardCreditForMove(swapTo, quote, execution, home);
          if (!credit) return;
          // A direct swap runs to its end before it returns, so its outcome is often already
          // known here. Crediting then would stack the figure on a balance that may already hold
          // it; the card is read as it is instead.
          if (takeEarlySettlement("card", credit.orderId) != null) {
            void wirexAccountService.silentRefresh(true);
            return;
          }
          void wirexAccountService
            .applyOptimisticCreditIn(credit.amount, credit.currency)
            .then((handle) => {
              // The outcome may land while the credit is being applied. Then nothing is parked and
              // there is nothing left to anticipate: the credit goes and the card is read as it is.
              const settled = parkOptimisticMove("card", credit.orderId, handle);
              if (settled == null) return;
              wirexAccountService.revertOptimisticBalance(handle);
              void wirexAccountService.silentRefresh(true);
            });
          void wirex.silentRefetch();
        }}
      />

      <SepaRecipientModal
        visible={wirexSend.recipientVisible}
        onClose={wirexSend.closeRecipient}
        onContinue={wirexSend.handleRecipientContinue}
        prefilledIban={wirexSend.prefill?.iban}
        prefilledBic={wirexSend.prefill?.bic}
        prefilledFirstName={wirexSend.prefill?.firstName}
        prefilledLastName={wirexSend.prefill?.lastName}
      />

      <SepaAmountConfirmationModal
        visible={wirexSend.amountVisible}
        onClose={() => wirexSend.setAmountVisible(false)}
        wallet={wirex.wallet ?? ""}
        accountId={wirex.iban?.bankAccountId ?? ""}
        iban={wirexSend.recipient?.iban ?? ""}
        bic={wirexSend.recipient?.bic ?? ""}
        firstName={wirexSend.recipient?.firstName ?? ""}
        lastName={wirexSend.recipient?.lastName ?? ""}
        reference={wirexSend.recipient?.reference}
        onSuccess={() => {
          // The status pill reports the transfer (raised by the sheet).
          wirexSend.setAmountVisible(false);
          void wirex.silentRefetch();
        }}
      />

      {/* Send to a card: a saved payout card, or a new one, then the amount. */}
      <ChoiceSheet
        visible={cardPayout.cards !== null}
        onClose={cardPayout.closePick}
        title={t("screen.CardPayout.pickTitle")}
        subtitle={cardPayout.loadFailed ? t("screen.CardPayout.loadFailed") : undefined}
        items={(cardPayout.cards ?? []).map((c) => ({
          key: c.recipientId,
          icon: "card" as const,
          accent: "neutral" as const,
          label: c.name || t("screen.CardPayout.cardRow", { last4: c.last4 }),
          sublabel: t("screen.CardPayout.cardRow", { last4: c.last4 }),
        }))}
        onSelect={cardPayout.pick}
        footerAction={{
          key: ADD_PAYOUT_CARD_KEY,
          label: t("screen.CardPayout.addCard"),
          icon: "plus",
        }}
      />
      <CardPayoutAddModal
        visible={cardPayout.addVisible}
        onClose={cardPayout.closeAdd}
        onAdded={cardPayout.added}
        prefill={cardPayout.prefill}
      />
      <CardPayoutAmountModal
        visible={cardPayout.card !== null}
        onClose={cardPayout.closeAmount}
        wallet={wirex.wallet ?? ""}
        card={cardPayout.card}
        currency={home === "USD" ? "USD" : "EUR"}
        onSuccess={() => {
          cardPayout.closeAmount();
          void wirex.silentRefetch();
        }}
      />

      {/* Transaction history: each rail opens the list that already owns its
          rows, rather than a second reader of the same data. */}
      {/* Scanning from the home says nothing about which bitcoin rail should
          pay, so it uses BitcoinSendScreen's own default (arkade). The same
          accept-list the Bitcoin tab uses: its confirm path takes an ark or a
          mainnet address, so an invoice would dead-end on "invalid address". */}
      {/* One scanner for the whole app: it reads what the code IS and takes the
          matching route, rather than assuming the user meant bitcoin. Types with
          no destination here are refused inline instead of walking the user into
          a screen that would reject them. */}
      <QrScannerModal
        visible={scanVisible}
        onClose={closeScanner}
        onResult={() => {}}
        onUnknown={async (raw) => {
          // A TanQR merchant code: paid from the arkade balance through the
          // payout rail, the same as picking that merchant by hand.
          const payout = tanQrDestination(raw);
          if (payout) return sendScanned({ destinations: [], person: null, payout });
          // An address or ENS name with its network named, like base:0x...
          const prefix = raw.trim().match(/^([a-z][a-z0-9]{1,11}):/i)?.[1];
          const named = prefix && networkOfPrefix(prefix) ? parseRecipientInput(raw) : null;
          if (named?.kind === "destinations" && named.destinations.length > 0) {
            return sendScanned({ destinations: named.destinations, person: null });
          }
          if (named?.kind === "ens" && named.network) {
            const network = named.network;
            // Resolved inside the scan's session: closing the scanner meanwhile ends it.
            return sendScanned(async () => {
              const address = await resolveEnsName(named.name).catch((): null => null);
              if (!address || !isValidEvmAddress(address)) return "unrecognized";
              return { destinations: [namedEvmDestination(address, network)], person: null };
            });
          }
          return "unrecognized";
        }}
        onParsedResult={async (result) => {
          // What the code IS decides the recipient; which balance pays is the
          // send flow's, the same as for a typed or picked recipient.
          const amountSats =
            "amountSats" in result && result.amountSats && result.amountSats > 0
              ? String(Math.trunc(result.amountSats))
              : undefined;
          switch (result.type) {
            case "bitcoin": {
              // An ark= or lightning= alternative settles instantly; prefer it.
              const ark = result.ark?.trim();
              const lightning = result.lightning?.trim();
              const destinations = ark
                ? [arkDestination(ark)]
                : lightning
                  ? [lightningDestination(lightning)]
                  : result.address
                    ? [bitcoinDestination(result.address)]
                    : [];
              if (destinations.length === 0) return t("screen.HomeScreen.scanNothingToSend");
              return sendScanned({ destinations, person: null, amountSats });
            }
            case "ark":
              return sendScanned({
                destinations: [arkDestination(result.address)],
                person: null,
                amountSats,
              });
            case "lightning-invoice":
              return sendScanned({
                destinations: [lightningDestination(result.invoice)],
                person: null,
                amountSats,
              });
            case "lightning-address":
            case "lnurl":
              return sendScanned({
                destinations: [
                  lightningDestination(result.type === "lnurl" ? result.url : result.address),
                ],
                person: null,
              });
            // CAIP-10 names its chain, and a bitcoin one is a bitcoin payment.
            case "caip10": {
              if (!result.address) return t("screen.HomeScreen.scanNothingToSend");
              if (result.namespace === "bip122") {
                return sendScanned({
                  destinations: [bitcoinDestination(result.address)],
                  person: null,
                });
              }
              if (result.namespace !== "eip155") return t("screen.HomeScreen.scanUnsupported");
              if (!isValidEvmAddress(result.address)) {
                return t("screen.HomeScreen.scanNothingToSend");
              }
              // A network a send reaches (lib/send/evmNetworks), else refused.
              const network = networkOfChainId(Number(result.chainRef));
              if (!network) return t("screen.HomeScreen.scanUnsupported");
              return sendScanned({
                destinations: [namedEvmDestination(result.address, network)],
                person: null,
              });
            }
            case "evm": {
              // An EIP-681 URI can name a chain, a function and an amount. Only
              // a plain send or an ERC-20 transfer of a token this wallet holds,
              // on the chain it holds it on, is something this app can pay.
              // A plain address on another network a send reaches is paid in
              // that network's stable (#1783); a token or native-coin request
              // there is refused rather than paid in another asset.
              const network = result.chainId != null ? networkOfChainId(result.chainId) : null;
              if (network && network !== "base") {
                const plain =
                  !result.functionName &&
                  result.transferRecipient == null &&
                  !(result.value != null && result.value > 0n);
                if (!plain || !isValidEvmAddress(result.address)) {
                  return t("screen.HomeScreen.scanUnsupported");
                }
                return sendScanned({
                  destinations: [namedEvmDestination(result.address, network)],
                  person: null,
                });
              }
              const wrongChain = result.chainId != null && result.chainId !== BASE_CHAIN_ID;
              const isTransfer = result.functionName === "transfer";
              const knownToken =
                isTransfer &&
                [BASE_EURC.address, BASE_USDC.address].some(
                  (token) => token.toLowerCase() === result.address.toLowerCase(),
                );
              if (wrongChain || (isTransfer && !knownToken)) {
                return t("screen.HomeScreen.scanUnsupported");
              }
              const address = isTransfer ? result.transferRecipient : result.address;
              if (!address || !isValidEvmAddress(address)) {
                return t("screen.HomeScreen.scanNothingToSend");
              }
              const usdc =
                isTransfer && result.address.toLowerCase() === BASE_USDC.address.toLowerCase();
              // A transfer URI states the amount in the token's own units, and
              // names the balance that pays it first.
              const amountStable =
                isTransfer && result.tokenAmount != null
                  ? formatUnits(result.tokenAmount, usdc ? BASE_USDC.decimals : BASE_EURC.decimals)
                  : undefined;
              // A token transfer pays only in that token. A link naming Base
              // names the network; one naming none is a plain 0x... (#1783).
              return sendScanned(
                {
                  destinations: [
                    knownToken
                      ? tokenDestination(address, usdc ? "USDC" : "EURC")
                      : result.chainId === BASE_CHAIN_ID
                        ? baseDestination(address)
                        : evmDestination(address),
                  ],
                  person: null,
                  ...(amountStable ? { amountStable } : {}),
                },
                knownToken ? [usdc ? "dollar" : "wallet"] : undefined,
              );
            }
            // A bank code goes to the SEPA recipient step with what it carried.
            case "sepa":
            case "iban": {
              if (!wirexBankReady) return t("screen.HomeScreen.scanBankUnavailable");
              const name = result.type === "sepa" ? (result.name ?? "").trim() : "";
              const parts = name ? name.split(/\s+/) : [];
              closeScanner();
              wirexSend.startSepaTo({
                iban: result.iban,
                bic: result.type === "sepa" ? (result.bic ?? "") : "",
                firstName: parts[0] ?? "",
                lastName: parts.slice(1).join(" "),
              });
              return undefined;
            }
            default:
              // Lightning invoices, LNURL and other chains have no rail here —
              // say so on the scanner rather than failing a screen later.
              return t("screen.HomeScreen.scanUnsupported");
          }
        }}
        // Every type the parser can name: without this list the scanner never
        // calls onParsedResult at all — it hands the raw string to onResult and
        // closes, so a scan did nothing. The switch above decides what each one
        // means, including the ones this app has no rail for.
        acceptTypes={[
          "bitcoin",
          "ark",
          "evm",
          "caip10",
          "sepa",
          "iban",
          "lightning-invoice",
          "lightning-address",
          "lnurl",
          "bolt12-offer",
          "monero",
          "zcash",
        ]}
        title={t("screen.HomeScreen.scanTitle")}
        pasteLabel={t("screen.HomeScreen.scanPasteLabel")}
        // Opened from the recipient step: no code in hand goes back to it.
        onManualEntry={
          scanFromSend
            ? () => {
                closeScanner();
                handOff(() => setRecipientSheetOpen(true));
              }
            : undefined
        }
      />

      <SendRecipientSheet
        visible={recipientSheetOpen}
        onClose={() => setRecipientSheetOpen(false)}
        // The amount screen opens over the recipient step, which then closes
        // underneath it: the home never shows in between.
        onRecipient={(recipient) => {
          if (!routeSend(recipient)) return false;
          setTimeout(() => setRecipientSheetOpen(false), SEND_SCREEN_HANDOVER_MS);
          return true;
        }}
        onScan={() => {
          setRecipientSheetOpen(false);
          setScanFromSend(true);
          handOff(() => setScanVisible(true));
        }}
        onMoveToBalances={() => {
          setRecipientSheetOpen(false);
          const from = sendStartRef.current[0] ?? cashRail;
          sendStartRef.current = [];
          openLockedMove(from, isBitcoinBalance(from) ? "wallet" : "arkade", "from");
        }}
      />

      <LogoutConfirmSheet
        visible={logoutConfirmVisible}
        onClose={() => setLogoutConfirmVisible(false)}
        onConfirm={handleLogout}
        busy={logoutBusy}
      />

      {/* The total has no card: both buttons ask which one first. */}
      <ChoiceSheet
        visible={cardPickFor !== null}
        onClose={() => setCardPickFor(null)}
        title={t(cardPickFor === "send" ? "actions.send" : "screen.HomeScreen.addMoney")}
        items={overviewGroups.map((group) => ({
          key: group.rail,
          image: overviewImages[group.key],
          label: overviewLabels[group.key],
          sublabel: overviewFigure(group.amountHome, home),
        }))}
        onSelect={(key: string) => {
          const kind = cardPickFor;
          setCardPickFor(null);
          if (!kind) return;
          // A Visa & Banking with no ready account starts or resumes activation,
          // as the card itself does.
          if (key === "visa" && wirexRailsNeedActivation) return handOff(() => openRailRow("visa"));
          handOff(() => openCardSheet(kind, key as HomeCard));
        }}
      />

      {/* Add money / Send on a card. */}
      <ChoiceSheet
        visible={cardSheet !== null}
        onClose={() => setCardSheet(null)}
        title={t(cardSheet?.kind === "send" ? "actions.send" : "screen.HomeScreen.addMoney")}
        items={
          cardSheet?.kind === "add"
            ? addMoneyItems(cardSheet.card)
            : [
                {
                  key: "balances",
                  icon: "transfer-vertical" as const,
                  accent: "lilac" as const,
                  label: t("screen.HomeScreen.sendToBalances"),
                },
                {
                  key: "someone",
                  icon: "arrow-up" as const,
                  accent: "lilac" as const,
                  label: t(
                    cardSheet?.card === "visa"
                      ? "screen.HomeScreen.sendToBank"
                      : "screen.HomeScreen.sendToSomeone",
                  ),
                  // A bank transfer needs the IBAN, which can come after the card.
                  disabled: cardSheet?.card === "visa" && !wirexBankReady,
                },
                ...(cardSheet?.card === "visa"
                  ? [
                      {
                        key: "card",
                        icon: "card" as const,
                        accent: "lilac" as const,
                        label: t("screen.CardPayout.sendToCard"),
                      },
                    ]
                  : []),
              ]
        }
        onSelect={(key: string) => {
          if (!cardSheet) return;
          if (cardSheet.kind === "add") onAddMoney(cardSheet.card, key);
          else onSend(key);
        }}
      />

      {topUp ? (
        <WalletTopUp
          key={topUp.id}
          onClose={() => closeTopUp(topUp.id)}
          settle={topUp.settle}
          payoutAddress={topUp.payoutAddress}
          rail={topUp.rail}
          label={topUp.label}
          formatReceive={topUp.formatReceive}
        />
      ) : null}

      <BitcoinSendScreen
        visible={btcSendSource !== null}
        sendSource={btcSendSource ?? undefined}
        presetAddress={btcSendPrefill}
        presetPayout={btcSendPayout}
        presetAmountSats={btcSendAmountSats}
        person={send?.recipient.person ?? null}
        balanceOptions={send ? sendBalanceOptions(send.recipient) : undefined}
        onPickBalance={switchSendBalance}
        onClose={() => {
          setSend(null);
          setBtcSendSource(null);
          setBtcSendPrefill(undefined);
          setBtcSendPayout(undefined);
          setBtcSendAmountSats(undefined);
        }}
        onSendSuccess={() => {
          // The send's own status pill reports it.
          setSend(null);
          setBtcSendSource(null);
          setBtcSendPrefill(undefined);
          setBtcSendPayout(undefined);
          setBtcSendAmountSats(undefined);
        }}
      />

      <BitcoinTransactionsModal
        visible={historyRail === "arkade" || historyRail === "onchain"}
        onClose={() => setHistoryRail(null)}
        rail={historyRail === "onchain" ? "onchain" : "arkade"}
        address={
          historyRail === "onchain" ? addressSnapshot.musig2Address : addressSnapshot.currentAddress
        }
        // Which on-chain addresses' rows belong to this rail. A row is
        // classified against the address it was read for, so the rail states
        // its own membership rather than the list inferring it. History only:
        // `address` above stays the address the rail is paid at.
        historyAddresses={historyRail === "onchain" ? [addressSnapshot.musig2Address] : undefined}
      />

      <WalletTransactionsModal
        visible={historyRail === "wallet" || historyRail === "dollar"}
        onClose={() => setHistoryRail(null)}
        // Euro and dollar are one address holding two tokens, so the token is
        // what separates the two histories.
        token={historyRail === "dollar" ? USDC_SCAN_TOKEN : EURC_SCAN_TOKEN}
        // Same split as the rails: this list is one token's history, so it
        // carries only the pending rows of the token it lists.
        pendingTransfers={inFlightAsWalletTransfers(
          moneyInFlight,
          historyRail === "dollar" ? "dollar" : "wallet",
        )}
        address={evmAddress}
        primaryAddress={evmAddress}
        onSendAgain={sendAgainFromCash}
      />

      {/* The IBAN row is a bank statement: card payments and on-chain deposits
          are other rails' rows and must not appear in it. */}
      <WirexCardTransactionsModal
        visible={historyRail === "iban" || historyRail === "visa"}
        onClose={() => setHistoryRail(null)}
        wallet={wirex.wallet}
        rails={historyRail === "iban" ? IBAN_HISTORY_RAILS : undefined}
        onSendAgain={handleSendAgain}
      />

      <WalletSendStablecoinModal
        visible={walletSend.isSendToWalletVisible}
        onClose={() => {
          setSend(null);
          walletSend.setIsSendToWalletVisible(false);
          walletSend.setSendToWalletRail(null);
          walletSend.setSendToWalletPayout(null);
        }}
        prefilledAddress={walletSend.sendToWalletAddress}
        prefilledAmount={walletSend.sendToWalletAmount}
        presetPayout={walletSend.sendToWalletPayout}
        maxStablecoinAvailable={sendTokenRail === "dollar" ? (usdcBalance ?? 0) : walletEur}
        toCard={walletSend.sendToWalletIsCard}
        person={send?.recipient.person ?? null}
        balanceOptions={send ? sendBalanceOptions(send.recipient) : undefined}
        balance={sendTokenRail}
        onPickBalance={switchSendBalance}
        token={
          sendTokenRail === "dollar"
            ? {
                address: BASE_USDC.address,
                decimals: BASE_USDC.decimals,
                symbol: "USD",
                code: "USD",
              }
            : undefined
        }
        onSuccess={(payload) => {
          const wasCardTopup = walletSend.sendToWalletIsCard;
          const amount = payload?.amount ?? 0;
          walletSend.setIsSendToWalletVisible(false);
          walletSend.setSendToWalletAddress(null);
          walletSend.setSendToWalletAmount(null);
          walletSend.setSendToWalletRail(null);
          walletSend.setSendToWalletPayout(null);
          // The euro has left the wallet as far as the user is concerned: the
          // transfer is broadcast and the sheet is closing, so the balance moves
          // now instead of at the next poll. Parked under its transaction so a
          // reverted one takes the euros back. A dollar send moves USDC, which
          // this store does not hold — nothing to debit there.
          if (amount > 0 && sendTokenRail !== "dollar") {
            rememberOptimisticMove(
              "wallet",
              payload?.txHash,
              walletBalanceStore.applyOptimisticDebit(amount),
            );
          }
          // A send to someone else is reported by its status pill (raised by
          // the sheet); only a card top-up has more to do here.
          if (!wasCardTopup || amount <= 0) return;
          // The other side of the same move. The EURC still has to confirm on
          // Base and Wirex still has to swap it EURC↔WEUR before the card
          // balance really changes; the credit is held across all of that so the
          // user is not shown money leaving one side and arriving minutes later
          // on the other. Parked under its transaction, because an unconfirmed
          // top-up can still be mined reverted — the receipt listener above
          // claims the handle and takes the euros back.
          const handle = wirexAccountService.applyOptimisticCredit(amount);
          rememberOptimisticMove("card", payload?.txHash, handle);
        }}
      />

      <WirexCardDetailsModal
        visible={reveal.visible}
        onClose={reveal.close}
        initialTab={reveal.initialTab}
        lockTab
        loading={reveal.revealing}
        error={reveal.error}
        cardNumber={reveal.details?.cardNumber ?? null}
        holderName={wirex.holderName}
        expiry={reveal.details?.expiry ?? null}
        cvv={reveal.details?.cvv ?? null}
        {...visibleBankDetails(wirex.isAccountBlocked, wirex.iban)}
        wallet={wirex.wallet}
        cardId={detailsSheetCardId(wirex, lifecycle.activeCard?.id)}
        isFrozen={lifecycle.activeCard?.isFrozen ?? wirex.isFrozen}
        isAccountBlocked={wirex.isAccountBlocked}
        freezeBusy={wirex.actionBusy}
        freezeError={wirex.actionError}
        onToggleFreeze={() => wirex.toggleFreeze(lifecycle.activeCard?.id)}
        onAddToWallet={lifecycle.openAppleWallet}
        // Issue and close, each behind its own gate.
        {...lifecycle.detailsProps}
        onRequestReveal={() => {
          if (!reveal.revealing) void lifecycle.revealCard();
        }}
      />

      <ChoiceSheet
        visible={detailsChoiceVisible}
        onClose={() => setDetailsChoiceVisible(false)}
        title={t("screen.HomeScreen.details")}
        items={[
          {
            key: "bank",
            icon: "bank" as const,
            accent: "lilac" as const,
            label: t("screen.HomeScreen.detailsBank"),
          },
          {
            key: "card",
            icon: "card" as const,
            accent: "lilac" as const,
            label: t("screen.HomeScreen.detailsCard"),
          },
        ]}
        onSelect={(key: string) => {
          setDetailsChoiceVisible(false);
          handOff(() => (key === "card" ? openCardDetails() : openBankDetails()));
        }}
      />

      <WirexAppleWalletModal
        visible={lifecycle.appleWallet.visible}
        onClose={lifecycle.appleWallet.close}
        revealing={lifecycle.appleWallet.revealing}
        cardNumber={lifecycle.appleWallet.details?.cardNumber ?? null}
        expiry={lifecycle.appleWallet.details?.expiry ?? null}
        cvv={lifecycle.appleWallet.details?.cvv ?? null}
        onCopyNumber={lifecycle.appleWallet.copyNumber}
        onOpenWallet={lifecycle.appleWallet.openWalletApp}
      />

      <MercuryoBuyBitcoinModal
        visible={buyFlow.visible}
        onClose={buyFlow.close}
        bitcoinAddress={buyFlow.bitcoinAddress}
      />

      {/* The card's other-currency money under the swap minimum: withdrawn to the wallet holding it. */}
      <SweepClaimSheet
        visible={cardFoundVisible && sweepResult == null}
        result={null}
        amountText={heldList(cardOtherHeld, cardOtherFiat)}
        onClaim={async () => {
          const amount = cardOtherHeld;
          // Taken before the withdrawal starts, so the row cannot start a second
          // one while this runs. A definite failure gives it back; an
          // unconfirmed one may have moved the money and keeps it taken.
          setCardFoundClaimed(`${cardOtherFiat}:${amount}`);
          setCardFoundRunning(true);
          try {
            await runCardToWallet(amount, cardOtherFiat === "USD" ? "USDC" : "EURC");
          } catch (error) {
            if (!(error as { unresolved?: boolean } | null)?.unresolved) {
              setCardFoundClaimed(null);
            }
            throw error;
          } finally {
            setCardFoundRunning(false);
          }
        }}
        onClose={() => setCardFoundVisible(false)}
      />

      <SweepClaimSheet
        visible={sweepResult != null}
        result={sweepResult}
        onClose={() => setSweepResult(null)}
        // Closing is not a success signal: the claim only submits transfers, and
        // the sheet keeps itself open when this app refused every balance.
      />

      <WirexEmailEntryModal
        visible={onboarding.emailEntryVisible}
        onClose={onboarding.cancel}
        onSubmit={(email) => void onboarding.submitEmail(email)}
        busy={onboarding.busy}
        failed={onboarding.failed}
      />
    </>
  );
};

// Structural only: the floating settings button over the body.
const styles = StyleSheet.create({
  settingsFloat: {
    position: "absolute",
    zIndex: 2,
    right: 20,
    bottom: 28,
  },
});

export default UnifiedHomeScreen;
