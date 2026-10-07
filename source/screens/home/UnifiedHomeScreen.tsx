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
//
// The overlay outlet renders layers as a SIBLING of DsOverlayRoot's
// NuriSafeAreaProvider, so DS `safeArea*` sees inset 0 inside a Layer. Seeding a
// provider here from the native insets is what makes `<Header safeAreaTop>` work;
// `<Screen>` supplies the FixedRegionLayoutProvider it reads them through.
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Platform, StyleSheet, View as RNView } from "react-native";
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
import { getAccountEmail } from "../../lib/accountEmail";
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
import { BASE_CHAIN_ID, BASE_EURC, BASE_USDC } from "../../config/network";

// Every rail is drawn with the mark the money is actually known by, not a
// generic icon — the two fiat flags from the design system's eur.svg / usa.svg,
// and each network's own logo for the rest. All eight are 512px RGBA circles
// bleeding to the edge, so one row cannot sit differently from the next. PNG
// because the DS avatar takes an image source, and RN's Image cannot render SVG.
const EUR_FLAG = require("../../assets/flags/eur.png");
const USD_FLAG = require("../../assets/flags/usa.png");
const BTC_LOGO = require("../../assets/rails/btc.png");
const LIGHTNING_LOGO = require("../../assets/rails/lightning.png");
const VISA_LOGO = require("../../assets/rails/visa.png");
// The card's two faces have a logo each — the same Visa mark over the currency's
// own flag. The plain mark stays on the board row, where the card is one thing.
const VISA_EUR_LOGO = require("../../assets/rails/visa-eur.png");
const VISA_USD_LOGO = require("../../assets/rails/visa-usd.png");
const SEPA_LOGO = require("../../assets/rails/sepa.png");
import { ENS_PARENT_DOMAIN } from "../../config/constants";
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
import WalletSendChoiceModal from "../wallet/modals/WalletSendChoiceModal";
import WalletSendStablecoinModal from "../wallet/modals/WalletSendStablecoinModal";
import QrScannerModal from "../../components/QrScannerModal";
import { useWirexCardLifecycle } from "../wirex/hooks/useWirexCardLifecycle";
import { useWirexSendFlow } from "../wirex/hooks/useWirexSendFlow";
import WirexAppleWalletModal from "../wirex/modals/WirexAppleWalletModal";
import type { WirexBankCounterparty } from "../../lib/wirex/cardTransactions";
import WirexSendChoiceModal from "../wirex/modals/WirexSendChoiceModal";
import SepaRecipientModal from "../wirex/modals/SepaRecipientModal";
import SepaAmountConfirmationModal from "../wirex/modals/SepaAmountConfirmationModal";
import WirexCardTransactionsModal from "../wirex/WirexCardTransactionsModal";
import BitcoinSendScreen from "../bitcoin/modals/BitcoinSendScreen";
import BitcoinTransactionsModal from "../bitcoin/modals/BitcoinTransactionsModal";
import WalletTransactionsModal from "../wallet/modals/WalletTransactionsModal";
import {
  isAwaitingReplacementCard,
  isWirexBankReady,
  isWirexCardReady,
} from "../../lib/wirex/cardState";
import { useWirexOnboarding } from "../wirex/hooks/useWirexOnboarding";
import WirexEmailEntryModal from "../wirex/modals/WirexEmailEntryModal";
import WirexCardDetailsModal from "../wirex/WirexCardDetailsModal";
import { detailsSheetCardId } from "../../lib/wirex/cardState";
import MoveSheet, { type MoveOutcome } from "./MoveSheet";
import { CARD_USD_RAIL, cardCreditForMove, cardSwapTargetFor } from "./moveBookkeeping";
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
import AddMoneyChoiceModal, { type AddMoneyChoiceKey } from "./AddMoneyChoiceModal";
import {
  clearPendingHomeRail,
  HOME_OPEN_RAIL_EVENT,
  type RailKey,
  takePendingHomeRail,
} from "./rails";
import { homeCarouselEligibleKey, sortByHomeValueDescending, ungroupedCount } from "./homeCarousel";
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
import { homeOverviewGroups, orderHomeRails, overviewFigure } from "./homeOverview";
import { useCardDetailDeepLink } from "./hooks/useCardDetailDeepLink";
import { useWirexCardReadyPoll } from "./hooks/useWirexCardReadyPoll";
import { useBitcoinBuyFlow } from "../bitcoin/hooks/useBitcoinBuyFlow";
import MercuryoBuyBitcoinModal from "../bitcoin/modals/MercuryoBuyBitcoinModal";
import SweepClaimSheet from "../swapkit/SweepClaimSheet";
import { checkSwapKitSweep } from "../../services/swapkit/SwapKitV2SweepService";
import type { SwapKitV2SweepResult } from "../../services/swapkit/SwapKitV2SweepService";
import { wirexAccountService } from "../../services/wirex/WirexAccountService";
import {
  WirexWithdrawUnconfirmedError,
  type WirexWithdrawAsset,
} from "../../services/wirex/WirexService";
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
const isUsdRail = (key: string | null | undefined) => key === "dollar" || key === CARD_USD_RAIL;
// The Wirex account, whichever face or pocket names it.
const isCardRail = (key: string | null | undefined) =>
  key === "iban" || key === "visa" || key === CARD_USD_RAIL;
const isBtcRail = (key: string | null | undefined) => key === "arkade" || key === "onchain";

// Where a source may send — the card's pockets only reach the wallet holding
// the same currency (see movePairs). The IBAN is not a Move-sheet rail: it is
// the same Wirex euro money the card's euro pocket already states.
const moveDestinationsFor = (fromKey: RailKey | null): RailKey[] | null =>
  moveDestinationsForKey(fromKey) as RailKey[] | null;

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
  const [accountEmail, setAccountEmail] = useState<string | null>(null);
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
  // A payment request's own amount, when the code carried one. Dropping it sent
  // the user to an empty keypad to guess what they owe.
  const [btcSendAmountSats, setBtcSendAmountSats] = useState<string | undefined>(undefined);
  const [scanVisible, setScanVisible] = useState(false);
  // A scanned recipient that more than one rail can pay. Null whenever the code
  // determines its own rail — then nothing is asked.
  // Which stable a scanned recipient is being paid in. A rail opened from a row
  // says it itself; a scan has to be asked when both balances exist.

  const [scanChoice, setScanChoice] = useState<
    | { kind: "bitcoin"; address: string }
    | { kind: "evm"; address: string; amount: string | null }
    | null
  >(null);
  const [swapVisible, setSwapVisible] = useState(false);
  const [swapFrom, setSwapFrom] = useState<RailKey | null>(null);
  const [swapTo, setSwapTo] = useState<RailKey | null>(null);
  const [onchainToArkadeAvailableSats, setOnchainToArkadeAvailableSats] = useState<number | null>(
    null,
  );
  // Which bitcoin wallet pays for a top-up. Named explicitly because the
  // service treats "unspecified" as arkade.
  // Which currency a bitcoin top-up settles into. The card holds both, and the
  // destination rail the move named is the only thing that says which.
  // Sats the Move sheet already collected. Null when the top-up was opened on
  // its own (Add money), where the keypad is where the amount comes from.
  const [addMoneyVisible, setAddMoneyVisible] = useState(false);
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

  useEffect(() => {
    if (!settingsOpen || !evmAddress) return;
    let cancelled = false;
    void getAccountEmail(evmAddress).then((email) => {
      if (!cancelled) setAccountEmail(email);
    });
    return () => {
      cancelled = true;
    };
  }, [settingsOpen, evmAddress]);

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
  const closeScanner = useCallback(() => {
    setScanVisible(false);
    walletSend.setShowWalletScan(false);
  }, [walletSend.setShowWalletScan]);

  // One EVM recipient, two balances that can pay it. Ask only when BOTH hold
  // something; otherwise name the one that does — defaulting to euro left a
  // dollar-only wallet in a euro send sheet with nothing to spend.
  const openEvmSend = useCallback(
    (address: string, amount: string | null): string | undefined => {
      const hasUsd = (usdcBalance ?? 0) > 0;
      if (walletEur > 0 && hasUsd) {
        setScanChoice({ kind: "evm", address, amount });
        return undefined;
      }
      // A rejected recipient is said on the scanner, and nothing opens.
      return walletSend.handleWalletScanResult(
        address,
        amount,
        hasUsd && walletEur <= 0 ? "dollar" : "wallet",
      )
        ? undefined
        : t("screen.HomeScreen.scanNothingToSend");
    },
    [usdcBalance, walletEur, walletSend.handleWalletScanResult],
  );

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
          : key === "iban"
            ? ["visa"]
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
          rows.push({
            key: row.key,
            label: t(`screen.HomeScreen.${row.label}`),
            amount: `${sign} ${figure}`,
            converted,
          });
        }
      }
      // The arkade rail's unspendable sats, as the board draws them: one
      // spinner row above the history entry.
      if (key === "arkade" && pendingVtxoSats > 0) {
        rows.push({
          key: "pending-vtxo-balance",
          label: t("screen.BitcoinTransactionsModal.pendingBalanceLabel"),
          amount: satsStr(pendingVtxoSats),
          converted: homeStr(satsToHome(pendingVtxoSats)),
        });
      }
      return rows;
    },
    [moneyInFlight, pendingVtxoSats, satsStr, heldStr, homeStr, satsToHome, fiatToSats],
  );

  // The transfer sheet is reached from a rail row or from a scan. A scan that
  // opened the sheet decided for itself, and that decision lives and dies with
  // the sheet; otherwise the open row names the currency.
  const sendTokenRail =
    walletSend.sendToWalletRail ??
    (openRail === "dollar" || openRail === "wallet" ? openRail : "wallet");

  // The card settles in whatever currency was loaded onto it — dollars stay
  // dollars until they are spent — while the region above states one total in
  // the display currency. These rows say which money is actually on the card,
  // each in its own currency with its display-currency equivalent.
  const cardBalanceRows: WealthBalanceRow[] = useMemo(() => {
    // Both Wirex faces state the same account, so both itemise it the same way.
    const byFiat = isCardRail(openRail) && cardActive ? wirex.balancesByFiat : null;
    if (!byFiat) return [];
    // Both currencies stay visible at zero; their display values decide order.
    const usd = byFiat.USD ?? 0;
    const eur = byFiat.EUR ?? 0;
    return sortByHomeValueDescending([
      {
        key: "EUR",
        label: t("screen.HomeScreen.railEuro"),
        image: EUR_FLAG,
        figure: heldList(eur, "EUR"),
        homeValue: toHome(eur, "EUR"),
      },
      {
        key: "USD",
        label: t("screen.HomeScreen.railDollar"),
        image: USD_FLAG,
        figure: heldList(usd, "USD"),
        homeValue: toHome(usd, "USD"),
      },
    ]).map(({ homeValue: _homeValue, ...row }) => row);
  }, [openRail, cardActive, wirex.balancesByFiat, heldList, toHome]);

  // The Move sheet names the card by CURRENCY, not by face. A top-up sends
  // euros or dollars — different tokens to the same address — and only the
  // destination says which, so the card appears here as its two pockets. The
  // home keeps ONE card row (its screen itemises the currencies); this list is
  // the Move sheet's alone.
  const moveRails: Rail[] = useMemo(() => {
    // Null until a /wallet read establishes it. The total on its own says
    // NOTHING about the split — a cold start restores one figure and no
    // breakdown — so neither pocket may be stated from it. Calling it all euros
    // would offer a euro withdrawal against dollars the euro pocket does not
    // hold, and put the dollar pocket at zero where it cannot be reached at all.
    const byFiat = cardActive ? wirex.balancesByFiat : null;
    const eur = byFiat?.EUR ?? null;
    const usd = byFiat?.USD ?? null;
    const eurSats = eur === null ? null : fiatToSats(eur, "EUR");
    const usdSats = usd === null ? null : fiatToSats(usd, "USD");
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
      // The IBAN spends the same Wirex euros the card's euro pocket states;
      // listing both on the Move sheet showed one balance as two.
      if (rail.key === "iban") return [];
      const euroFace: Rail = {
        ...rail,
        label: rail.key === "visa" ? t("screen.HomeScreen.railVisaEuro") : rail.label,
        ...(rail.key === "visa" ? { image: VISA_EUR_LOGO } : {}),
        available: eur,
        amount: eur === null ? UNKNOWN_FIGURE : heldStr(eur, "EUR"),
        converted: satsOrUnknown(eurSats),
        listFigure: eur === null ? UNKNOWN_FIGURE : heldList(eur, "EUR"),
        homeValue: eur === null ? null : toHome(eur, "EUR"),
        glyph:
          eur === null
            ? { amount: UNKNOWN_FIGURE, converted: UNKNOWN_FIGURE }
            : { amount: heldGlyph(eur, "EUR"), converted: satsOrUnknown(eurSats, true) },
      };
      // The IBAN is a euro account; only the card has a dollar side.
      if (rail.key !== "visa") return [euroFace];
      return [
        euroFace,
        {
          ...rail,
          key: CARD_USD_RAIL,
          label: t("screen.HomeScreen.railVisaDollar"),
          image: VISA_USD_LOGO,
          available: usd,
          amount: usd === null ? UNKNOWN_FIGURE : heldStr(usd, "USD"),
          converted: satsOrUnknown(usdSats),
          listFigure: usd === null ? UNKNOWN_FIGURE : heldList(usd, "USD"),
          homeValue: usd === null ? null : toHome(usd, "USD"),
          glyph:
            usd === null
              ? { amount: UNKNOWN_FIGURE, converted: UNKNOWN_FIGURE }
              : { amount: heldGlyph(usd, "USD"), converted: satsOrUnknown(usdSats, true) },
        },
      ];
    });
  }, [
    rails,
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
    toHome,
    satsToHome,
    fiatToSats,
    satsOrUnknown,
  ]);

  const carouselRails = useMemo(() => orderHomeRails(homeRails), [homeRails]);
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
  const carouselOpenedRail = railOf(carouselRailKey);
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
  const pendingSweepExtra =
    openRail === "arkade" && unlockState.boardingSweepReadyCount > 0 ? (
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
      setOpenRail(key);
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
          setAddMoneyVisible(false);
          setBtcSendSource(null);
          setBtcSendPrefill(undefined);
          setSweepResult(null);
          setScanChoice(null);
          // A link parked for a home that never opened it must not fire after the
          // takeover that just asked everything to close.
          clearPendingHomeRail();
          wirexSend.setChoiceVisible(false);
          wirexSend.closeRecipient();
          wirexSend.setAmountVisible(false);
          // The wallet's own sheets hold a recipient and an amount, and the
          // onboarding holds the account email — it was
          // still on screen after the takeover that asked everything to close.
          walletSend.closeAll();
          onboarding.cancel();
        } catch {}
      }),
    [
      lifecycle.closeAll,
      cancelMoveHandoff,
      wirexSend.setChoiceVisible,
      wirexSend.closeRecipient,
      wirexSend.setAmountVisible,
      walletSend.closeAll,
      onboarding.cancel,
    ],
  );

  // Euro keeps the full choice (card · bitcoin · someone else). Dollar has no
  // card or swap leg, so it goes straight to the recipient scanner. Bitcoin and
  // the Wirex faces stay on their own rail.
  const sendFromRail = useCallback(
    (key: RailKey | null) => {
      if (key === "wallet" || key === "dollar") return walletSend.handleSendPress();
      // Both Wirex faces spend the same balance, so they share one send flow.
      if (key === "iban" || key === "visa") return wirexSend.start();
      // Straight to the recipient screen with the rail pinned as the source —
      // the row IS the source, so there is no source picker in between.
      if (key === "arkade" || key === "onchain") setBtcSendSource(key);
    },
    [walletSend.handleSendPress, wirexSend.start],
  );

  // Receive on a Wirex row opens the production sheet pinned to that face —
  // the IBAN row shows bank details, the VISA row the card. No tab switcher:
  // it would contradict the row that was tapped.
  const retryArkadeAddress = useCallback(() => {
    void walletService.generateNewAddress();
  }, []);

  const receiveFromRail = useCallback(
    (key: RailKey | null) => {
      if (key === "iban") return reveal.open("bank");
      if (key === "visa") {
        const cardId = wirex.card?.id ?? null;
        if (!cardId || wirex.isFrozen === true) return reveal.open("card");
        return void reveal.reveal({ id: cardId });
      }
      setReceiveRail(key);
    },
    [reveal.open, reveal.reveal, wirex.card?.id, wirex.isFrozen],
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

  // Paying a saved contact: close Address book and Settings, then hand the
  // destination to the flow a scan of it would open. Nothing new is sent here.
  const payFromAddressBook = useCallback(
    (route: Exclude<SendRoute, { kind: "unsupported" }>): string | undefined => {
      // Same gate as a scanned IBAN: without a ready Wirex bank account the
      // transfer would reach its confirmation with no account to debit.
      if (route.kind === "sepa" && !wirexBankReady) {
        return t("screen.HomeScreen.scanBankUnavailable");
      }
      // Checked before anything closes: a refused handoff keeps the contact open.
      if (route.kind === "evm" && !isValidEvmAddress(route.address)) {
        return t("screen.AddressBook.invalidAddress");
      }
      setAddressBookOpen(false);
      closeSettings();
      setTimeout(() => {
        switch (route.kind) {
          case "bitcoin": {
            setBtcSendPrefill(route.target);
            setBtcSendAmountSats(undefined);
            if (route.rail === "auto") {
              if (onchainActive && onchainSats > 0 && arkadeSats > 0) {
                setScanChoice({ kind: "bitcoin", address: route.target });
                return;
              }
              setBtcSendSource(onchainActive && onchainSats > 0 ? "onchain" : "arkade");
              return;
            }
            setBtcSendSource(route.rail);
            return;
          }
          case "evm":
            // A general EVM address pays like a scanned 0x: euro or dollar,
            // asking only when both hold money.
            if (route.asset === null) {
              openEvmSend(route.address, null);
              return;
            }
            walletSend.handleWalletScanResult(
              route.address,
              null,
              route.asset === "USDC" ? "dollar" : "wallet",
            );
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
        }
      }, MODAL_HANDOFF_DELAY_MS);
      return undefined;
    },
    [
      arkadeSats,
      onchainActive,
      onchainSats,
      walletSend.handleWalletScanResult,
      wirexBankReady,
      wirexSend.startSepaTo,
      openEvmSend,
    ],
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

  // "Add money" is one CTA over the four ways money reaches this app: the two
  // addresses the user already owns, a bank transfer, and a purchase. Each
  // lands on a different rail, so each hands off to that rail's own surface.
  const handleAddMoneySelect = useCallback(
    (choice: AddMoneyChoiceKey) => {
      setAddMoneyVisible(false);
      switch (choice) {
        // The two addresses the user already owns: euro arrives on the EVM
        // wallet, bitcoin on the onchain one.
        case "euro":
          setReceiveRail("wallet");
          return;
        case "bitcoin":
          setReceiveRail("onchain");
          return;
        // A transfer needs a bank account to land in. With one, this is the
        // account's own details; without, it is the signup that creates it —
        // and a verification already under way is resumed rather than restarted
        // (a restart asks for an email Wirex has and drops the Sumsub session).
        case "iban":
          // iOS cannot present a sheet in the same tick another is dismissed
          // (#522): this one is opening as the choice sheet closes.
          setTimeout(() => {
            if (wirexRailsNeedActivation) {
              if (wirexPendingVerification) void onboarding.continueVerification();
              else onboarding.start();
              return;
            }
            reveal.open("bank");
          }, MODAL_HANDOFF_DELAY_MS);
          return;
        // The purchase. It settles to the onchain bitcoin address, and the
        // order outlives its sheet.
        case "pay":
          buyFlow.open();
          return;
      }
    },
    [
      buyFlow.open,
      wirexRailsNeedActivation,
      wirexPendingVerification,
      onboarding.start,
      onboarding.continueVerification,
      reveal.open,
    ],
  );

  // The amount typed on one side, expressed on the other: sats through the BTC
  // rate, euros and dollars through FX, straight between the two rails' own
  // currencies — the display currency is not a leg of it. Null when a rate is
  // missing, so the field stays blank rather than showing a made-up number.
  const swapCounterValue = useCallback(
    (typed: number, focus: "from" | "to"): number | null => {
      const source = focus === "from" ? swapFrom : swapTo;
      const target = focus === "from" ? swapTo : swapFrom;
      if (!source || !target || !Number.isFinite(typed)) return null;
      const fiatOf = (rail: RailKey): FiatCode => (isUsdRail(rail) ? "USD" : "EUR");
      if (isBtcRail(source)) {
        return isBtcRail(target) ? typed : satsToFiatIn(typed, fiatOf(target), btcQuote, fxRates);
      }
      if (isBtcRail(target)) return fiatToSats(typed, fiatOf(source));
      return convertFiat(typed, fiatOf(source), fiatOf(target), fxRates);
    },
    [swapFrom, swapTo, btcQuote, fxRates, fiatToSats],
  );

  // The same number, formatted for the unfocused half.
  // The one way a figure is written on the Move card, whatever produced it: the
  // counter, the quote and the route rows are the same number at different
  // moments, so they cannot each bring their own grouping and rounding.
  const swapRailAmount = useCallback(
    (value: number, railKey: string): string => {
      if (isBtcRail(railKey)) return satsGlyph(value);
      return heldGlyph(value, isUsdRail(railKey) ? "USD" : "EUR");
    },
    [satsGlyph, heldGlyph],
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
    (toRailKey: string) => cardSwapTargetFor(swapFrom, toRailKey, wirex.smartAccountAddress),
    [swapFrom, wirex.smartAccountAddress],
  );

  // A chooser hands over to the Move card the way every other sheet hand-off
  // works: iOS cannot present a sheet in the same tick another is dismissed
  // (#522), and a Move card opened in the chooser's own tap is exactly that —
  // the presentation is swallowed and the tap does nothing.
  // Seeds both ends when the sheet OPENS: a source with fixed exits starts on
  // one of them. A user's pick of a source moves the destination the same way
  // (moveSourcePick); an unreachable destination is refused by the sheet (#1467).
  const setMovePair = useCallback((from: RailKey | null, to: RailKey | null) => {
    // The IBAN is the same Wirex euro money as the card's euro pocket, and only
    // that pocket is on the Move sheet.
    const source = from === "iban" ? "visa" : from;
    const target = to === "iban" ? "visa" : to;
    setSwapFrom(source);
    const allowed = moveDestinationsFor(source);
    setSwapTo(allowed && (!target || !allowed.includes(target)) ? allowed[0] : target);
  }, []);

  const openMove = useCallback(
    (from: RailKey, to: RailKey) => {
      cancelMoveHandoff();
      moveHandoffTimerRef.current = setTimeout(() => {
        moveHandoffTimerRef.current = null;
        setMovePair(from, to);
        setSwapVisible(true);
      }, MODAL_HANDOFF_DELAY_MS);
    },
    [cancelMoveHandoff, setMovePair],
  );
  useEffect(() => cancelMoveHandoff, [cancelMoveHandoff]);

  const openSwap = useCallback(
    (from: RailKey | null) => {
      const isBtc = (k: RailKey) => k === "arkade" || k === "onchain";
      const source = from ?? "wallet";
      // Named, not "the first row that isn't bitcoin": the euro wallet is the
      // counterparty a bitcoin move defaults to, and row order is the product's
      // to change without moving that default onto the dollar.
      const target = isBtc(source) ? "wallet" : (rails.find((r) => isBtc(r.key))?.key ?? "arkade");
      setMovePair(source, target);
      setSwapVisible(true);
    },
    [rails, setMovePair],
  );

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
      if (swapFrom === "wallet" && isCardRail(swapTo) && swapTo !== CARD_USD_RAIL) {
        return runEuroToCard(sourceAmount).then(() => "transferred" as const);
      }
      // The same move one currency over: dollars into the card's dollar pocket.
      if (swapFrom === "dollar" && swapTo === CARD_USD_RAIL) {
        return runDollarToCard(sourceAmount).then(() => "transferred" as const);
      }
      // Out of the card, into the wallet holding the same currency. Each pocket
      // unwraps its own synthetic — WEUR → EURC, WUSD → USDC — so the pair is
      // named on both ends and never crosses.
      if (isCardRail(swapFrom) && swapFrom !== CARD_USD_RAIL && swapTo === "wallet") {
        return runCardToWallet(sourceAmount, "EURC").then(() => "transferred" as const);
      }
      if (swapFrom === CARD_USD_RAIL && swapTo === "dollar") {
        return runCardToWallet(sourceAmount, "USDC").then(() => "transferred" as const);
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
    ],
  );

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
              {/* Scan on Total; close any selected rail back to Total. */}
              <TopbarTrailing>
                <IconButton
                  icon={carouselRailKey === null ? "qr-scan" : "cross"}
                  variant="soft"
                  accessibilityLabel={t(
                    carouselRailKey === null
                      ? "screen.HomeScreen.scanA11yLabel"
                      : "screen.HomeScreen.backToTotalA11yLabel",
                  )}
                  onPress={() =>
                    carouselRailKey === null ? setScanVisible(true) : selectOverviewRail(null)
                  }
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
                  totalImages={[homeFlag, BTC_LOGO]}
                  items={carouselRails.map((rail) => ({
                    key: rail.key,
                    label: rail.label,
                    image: rail.image,
                    amount: rail.glyph.amount,
                    converted: rail.glyph.converted,
                    inactiveVisaArtwork: wirexRailsNeedActivation && rail.key === "visa",
                    ...(wirexRailsNeedActivation && (rail.key === "visa" || rail.key === "iban")
                      ? {}
                      : {
                          detailsLabel: t("screen.HomeScreen.detailsA11yLabel", {
                            asset: rail.label,
                          }),
                          onDetails: () => receiveFromRail(rail.key),
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
                    <Button size="lg" variant="soft" onPress={() => openSwap(carouselRailKey)}>
                      <ButtonText>{t("actions.move")}</ButtonText>
                    </Button>
                    {carouselOpenedRail ? (
                      <Button
                        size="lg"
                        variant="solid"
                        accent={carouselOpenedRail.accent}
                        onPress={() => sendFromRail(carouselRailKey)}
                      >
                        <ButtonText>{t("actions.send")}</ButtonText>
                      </Button>
                    ) : (
                      <Button size="lg" variant="solid" onPress={() => setAddMoneyVisible(true)}>
                        <ButtonText>{t("screen.HomeScreen.addMoney")}</ButtonText>
                      </Button>
                    )}
                  </View>
                )
              ) : (
                <View direction="column" align="stretch" paddingX="lg">
                  <Button size="lg" variant="solid" onPress={() => setAddMoneyVisible(true)}>
                    <ButtonText>{t("screen.HomeScreen.addMoney")}</ButtonText>
                  </Button>
                </View>
              )}

              {homeCarouselEnabled && carouselOpenedRail && !inactiveWirexRailSelected ? (
                <AssetActivityList
                  assetLabel={carouselOpenedRail.label}
                  pending={pendingFor(carouselRailKey)}
                  balances={cardBalanceRows}
                  onHistory={() => setHistoryRail(carouselRailKey)}
                  extra={pendingSweepExtra}
                  detail={{
                    icon:
                      carouselRailKey === "visa"
                        ? "card"
                        : carouselRailKey === "iban"
                          ? "bank"
                          : "qr",
                    label:
                      carouselRailKey === "visa"
                        ? t("screen.AssetScreen.cardDetails")
                        : carouselRailKey === "iban"
                          ? t("screen.AssetScreen.bankDetails")
                          : t("screen.AssetScreen.address"),
                    subtitle: carouselOpenedRail.label,
                    onPress: () => receiveFromRail(carouselRailKey),
                  }}
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
        balances={cardBalanceRows}
        onReceive={() => receiveFromRail(openRail)}
        onSend={() => sendFromRail(openRail)}
        onHistory={() => setHistoryRail(openRail)}
        extra={pendingSweepExtra}
      />

      <SettingsScreen
        visible={settingsOpen}
        onClose={closeSettings}
        username={username}
        email={accountEmail}
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
        rails={moveRails.map((rail) => {
          const btc = isBtcRail(rail.key);
          const cardTarget = cardSwapTargetOf(rail.key);
          return {
            key: rail.key,
            label: rail.label,
            image: rail.image,
            accent: rail.accent,
            amount: rail.amount,
            ...(rail.available != null ? { available: rail.available } : {}),
            unit: btc
              ? BTC_GLYPH
              : isUsdRail(rail.key)
                ? CURRENCIES.USD.fiatSymbol
                : CURRENCIES.EUR.fiatSymbol,
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
        })}
        destinationsFor={(key: string) => moveDestinationsFor(key as RailKey)}
        fromKey={swapFrom}
        toKey={swapTo}
        // Any source may be picked: the destination stays when the new pair is
        // open, else moves to the source's own default — never an impossible
        // pair. A destination pick is only handed over when it is reachable.
        onPickFrom={(key: string) => {
          const pair = moveSourcePick(
            moveDestinationsForKey,
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
          const credit = cardCreditForMove(swapTo, quote, execution);
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

      <WirexSendChoiceModal
        visible={wirexSend.choiceVisible}
        onClose={() => wirexSend.setChoiceVisible(false)}
        onSelect={(choice) => {
          // Withdrawing to the wallet is a move between the user's own two
          // balances, so it is stated on the Move card like every other one.
          if (choice === "withdraw") {
            wirexSend.setChoiceVisible(false);
            openMove("visa", "wallet");
            return;
          }
          wirexSend.handleSelect(choice);
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
        visible={scanVisible || walletSend.showWalletScan}
        onClose={closeScanner}
        onResult={() => {}}
        onParsedResult={(result) => {
          switch (result.type) {
            // A BIP-21 code may carry an ark address alongside the on-chain one;
            // prefer it so the arkade rail settles instantly.
            case "bitcoin": {
              // A BIP-21 code states what is owed; carry it into the keypad.
              setBtcSendAmountSats(
                result.amountSats && result.amountSats > 0
                  ? String(Math.trunc(result.amountSats))
                  : undefined,
              );
              // An ark address in a BIP-21 code settles instantly and only the
              // arkade rail can pay it — no choice to make.
              const ark = result.ark?.trim();
              if (ark) {
                closeScanner();
                setBtcSendPrefill(ark);
                setBtcSendSource("arkade");
                return undefined;
              }
              // A unified code's `lightning=` fallback settles over the arkade
              // rail, which only the arkade balance can pay — same reasoning as
              // the ark branch above.
              const lightning = result.lightning?.trim();
              if (lightning) {
                closeScanner();
                setBtcSendPrefill(lightning);
                setBtcSendSource("arkade");
                return undefined;
              }
              if (!result.address) return t("screen.HomeScreen.scanNothingToSend");
              closeScanner();
              // A mainnet address can be paid from either bitcoin rail when both
              // hold funds; ask only then.
              if (onchainActive && onchainSats > 0 && arkadeSats > 0) {
                setScanChoice({ kind: "bitcoin", address: result.address });
                return undefined;
              }
              setBtcSendPrefill(result.address);
              setBtcSendSource(onchainActive && onchainSats > 0 ? "onchain" : "arkade");
              return undefined;
            }
            case "ark":
              closeScanner();
              setBtcSendPrefill(result.address);
              setBtcSendAmountSats(
                result.amountSats && result.amountSats > 0
                  ? String(Math.trunc(result.amountSats))
                  : undefined,
              );
              setBtcSendSource("arkade");
              return undefined;
            // Lightning targets are paid over the arkade rail's send corridor,
            // so they carry no rail choice: the invoice states its own amount
            // and an address/LNURL asks for one on the keypad.
            case "lightning-invoice": {
              closeScanner();
              setBtcSendPrefill(result.invoice);
              setBtcSendAmountSats(
                result.amountSats && result.amountSats > 0
                  ? String(Math.trunc(result.amountSats))
                  : undefined,
              );
              setBtcSendSource("arkade");
              return undefined;
            }
            case "lightning-address":
            case "lnurl": {
              closeScanner();
              setBtcSendPrefill(result.type === "lnurl" ? result.url : result.address);
              setBtcSendAmountSats(undefined);
              setBtcSendSource("arkade");
              return undefined;
            }
            // CAIP-10 names its chain, and a bitcoin one is a bitcoin payment —
            // handing it to the EVM sheet only got the address rejected there.
            case "caip10": {
              if (result.namespace === "bip122") {
                closeScanner();
                setBtcSendPrefill(result.address);
                setBtcSendAmountSats(undefined);
                setBtcSendSource(onchainActive && onchainSats > 0 ? "onchain" : "arkade");
                return undefined;
              }
              if (!result.address) return t("screen.HomeScreen.scanNothingToSend");
              // No closeScanner() before the recipient is checked: a rejected one
              // is said on the scanner, and the modal closes itself on success.
              return openEvmSend(result.address, null);
            }
            // An EVM address is a euro/dollar recipient: the wallet's transfer
            // sheet owns that send, including its ERC-20 handling.
            case "evm": {
              // An EIP-681 URI can name a chain, a function and an amount. Only
              // a plain send or an ERC-20 transfer of a token this wallet holds,
              // on the chain it holds it on, is something this app can pay.
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
              if (!address) return t("screen.HomeScreen.scanNothingToSend");
              // A transfer URI states the amount in the token's own units.
              const decimals =
                isTransfer && result.address.toLowerCase() === BASE_USDC.address.toLowerCase()
                  ? BASE_USDC.decimals
                  : BASE_EURC.decimals;
              const amount =
                isTransfer && result.tokenAmount != null
                  ? formatUnits(result.tokenAmount, decimals)
                  : null;
              // A token URI also names WHICH balance pays.
              if (knownToken) {
                return walletSend.handleWalletScanResult(
                  address,
                  amount,
                  result.address.toLowerCase() === BASE_USDC.address.toLowerCase()
                    ? "dollar"
                    : "wallet",
                )
                  ? undefined
                  : t("screen.HomeScreen.scanNothingToSend");
              }
              return openEvmSend(address, amount);
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
        // Opened from a euro/dollar screen's Send: no code in hand means the
        // transfer sheet's own recipient step, the same as before this scanner
        // was shared. The home has no single sheet to fall back to.
        onManualEntry={
          walletSend.showWalletScan
            ? () => {
                walletSend.setShowWalletScan(false);
                walletSend.setSendToWalletRail(null);
                walletSend.setSendToWalletAddress(null);
                walletSend.setIsSendToWalletVisible(true);
              }
            : undefined
        }
      />

      <LogoutConfirmSheet
        visible={logoutConfirmVisible}
        onClose={() => setLogoutConfirmVisible(false)}
        onConfirm={handleLogout}
        busy={logoutBusy}
      />

      {/* Only ever shown when the scan genuinely left a choice open. */}
      <ChoiceSheet
        visible={scanChoice !== null}
        onClose={() => setScanChoice(null)}
        title={t("screen.HomeScreen.scanChoiceTitle")}
        items={
          scanChoice?.kind === "bitcoin"
            ? [
                {
                  key: "arkade",
                  icon: "lightning" as const,
                  accent: "lilac" as const,
                  label: t("screen.HomeScreen.railBitcoinLightning"),
                  sublabel: satsStr(arkadeSats),
                },
                {
                  key: "onchain",
                  icon: "bitcoin" as const,
                  accent: "orange" as const,
                  label: t("screen.HomeScreen.railBitcoin"),
                  sublabel: satsStr(onchainSats),
                },
              ]
            : [
                {
                  key: "wallet",
                  accent: "lilac" as const,
                  icon: "euro-wallet" as const,
                  label: t("screen.HomeScreen.railEuro"),
                  sublabel: heldStr(walletEur, "EUR"),
                },
                {
                  key: "dollar",
                  accent: "neutral" as const,
                  icon: "wallet" as const,
                  label: t("screen.HomeScreen.railDollar"),
                  sublabel: heldStr(usdcBalance ?? 0, "USD"),
                },
              ]
        }
        onSelect={(key: string) => {
          const choice = scanChoice;
          setScanChoice(null);
          if (!choice) return;
          if (choice.kind === "bitcoin") {
            setBtcSendPrefill(choice.address);
            setBtcSendSource(key === "onchain" ? "onchain" : "arkade");
            return;
          }
          walletSend.handleWalletScanResult(
            choice.address,
            choice.amount,
            key === "dollar" ? "dollar" : "wallet",
          );
        }}
      />

      <BitcoinSendScreen
        visible={btcSendSource !== null}
        sendSource={btcSendSource ?? undefined}
        presetAddress={btcSendPrefill}
        presetAmountSats={btcSendAmountSats}
        onClose={() => {
          setBtcSendSource(null);
          setBtcSendPrefill(undefined);
          setBtcSendAmountSats(undefined);
        }}
        onSendSuccess={() => {
          // The send's own status pill reports it.
          setBtcSendSource(null);
          setBtcSendPrefill(undefined);
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

      <WalletSendChoiceModal
        visible={walletSend.isWalletSendChoiceVisible}
        onClose={() => walletSend.setIsWalletSendChoiceVisible(false)}
        onSelect={(choice) => {
          // The three options are unchanged. Two of them move money between the
          // user's OWN rails, and a move is stated on the Move card — the same
          // card the home's Move button opens, arriving with both ends already
          // chosen. Only a recipient outside the app needs a screen of its own,
          // because only that one has something more to collect than an amount.
          if (choice === "card" || choice === "bitcoin") {
            walletSend.setIsWalletSendChoiceVisible(false);
            // The card pocket that matches the money being sent: dollars fill
            // the dollar side, which is a transfer, not an exchange. Either end
            // is still changeable on the Move card.
            openMove(
              sendTokenRail,
              choice === "bitcoin" ? "arkade" : sendTokenRail === "dollar" ? CARD_USD_RAIL : "visa",
            );
            return;
          }
          walletSend.handleWalletSendChoiceSelect(choice);
        }}
      />

      <WalletSendStablecoinModal
        visible={walletSend.isSendToWalletVisible}
        onClose={() => {
          walletSend.setIsSendToWalletVisible(false);
          walletSend.setSendToWalletRail(null);
        }}
        prefilledAddress={walletSend.sendToWalletAddress}
        prefilledAmount={walletSend.sendToWalletAmount}
        maxStablecoinAvailable={sendTokenRail === "dollar" ? (usdcBalance ?? 0) : walletEur}
        toCard={walletSend.sendToWalletIsCard}
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
        iban={wirex.iban?.iban ?? null}
        bic={wirex.iban?.bic ?? null}
        wallet={wirex.wallet}
        cardId={detailsSheetCardId(wirex, lifecycle.activeCard?.id)}
        isFrozen={lifecycle.activeCard?.isFrozen ?? wirex.isFrozen}
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

      <AddMoneyChoiceModal
        visible={addMoneyVisible}
        onClose={() => setAddMoneyVisible(false)}
        onSelect={handleAddMoneySelect}
      />

      <MercuryoBuyBitcoinModal
        visible={buyFlow.visible}
        onClose={buyFlow.close}
        bitcoinAddress={buyFlow.bitcoinAddress}
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
