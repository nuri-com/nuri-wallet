// biome-ignore lint/correctness/noUnusedImports: React needed for JSX fragments
import React, { useState, useEffect, useCallback, useRef } from "react";
import { View, StyleSheet, Platform, Linking, AppState } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, initialWindowMetrics } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import {
  useFonts,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from "@expo-google-fonts/inter";
import { View as DsView } from "@ds";
import UnifiedHomeScreen from "./screens/home/UnifiedHomeScreen";
import { openHomeRail } from "./screens/home/rails";
import Wirex3dsApprovalHost from "./screens/wirex/Wirex3dsApprovalHost";
import PaymentReceivedModal from "./screens/bitcoin/components/PaymentReceivedModal";
import { useArkadeReceiveUnlockMonitor } from "./screens/bitcoin/hooks/useArkadeReceiveUnlock";
import { ARKADE_OPEN_UNLOCK_WALLET_EVENT } from "./services/arkade/ArkadeReceiveUnlockService";
import { useNetworkStatus } from "./lib/useNetworkStatus";
import { resumeSwapKitV2Orders } from "./services/swapkit/SwapKitV2PendingTracker";
import { runLegacyArkadeRefunds } from "./services/swapkit/SwapKitLegacyArkadeRefundRunner";
import { discardUnsignedV2CommitIntents } from "./services/swapkit/SwapKitV2OrderStore";
import { observeAppViewportHeight } from "./lib/web/appViewportHeight";
import { revealFocusedField } from "./lib/web/focusedFieldReveal";
import { hydrateAndResumeMercuryoOrders } from "./services/mercuryo/MercuryoPendingTracker";
import {
  DEBUG_UI_ENABLED,
  DebugArkadeModal,
  DebugBankTxDumpModal,
  DebugDsReviewModal,
  DebugEoaKeyExportModal,
  DebugModal,
  DebugNotificationsModal,
  DebugSatoraRefundModal,
  DebugWirexSignUpModal,
  DebugWirexWithdrawModal,
} from "./lib/debug/debugComponents";
import BiometricLockModal from "./components/BiometricLockModal";
import WebAuthnPrfOverlay from "./components/WebAuthnPrfOverlay";
import DsOverlayRoot from "./components/DsOverlayRoot";
import PasskeyLoginScreen from "./components/PasskeyLoginScreen";
import SupportDumpModal from "./components/SupportDumpModal";
import {
  getBitcoinAddress,
  getEthereumAddress,
  storeBitcoinAddress,
  storeEthereumAddress,
  hasStoredKey,
  hasCompletedWalletBootstrap,
  unlockWalletKeys,
  getAuthData,
  deleteAuthData,
  storeAuthData,
  setAppLocked,
  abortAppLock,
  addWalletUnlockedListener,
} from "./lib/secureKeyStorage";
import { USERNAME_CLAIM_REQUIRED_KEY } from "./lib/auth/usernameClaimSentinel";
import {
  parsePasskeyUsernamePath,
  shouldWipeForPasskeySwitch,
} from "./lib/auth/passkeyUsernameLink";
import { parsePayLinkPath } from "./lib/pay/payLinkPath";
import PayLinkScreen from "./screens/pay/PayLinkScreen";
import { PayWalletProvider } from "./lib/pay/payWallet";
import { zeroize } from "./lib/crypto";
import { authStateManager } from "./services/auth/AuthStateService";
import { getWalletPasskeyAssertion } from "./services/auth/PasskeyNativeModuleService";
import {
  bootstrapWalletFromPrf,
  persistBootstrappedKeys,
} from "./services/auth/PasskeyPrfWalletBootstrapService";
import { initializeNetworkLogging } from "./services/logging/NetworkLogger";
import { startNetworkMonitor, stopNetworkMonitor } from "./services/app/NetworkStatusService";
import {
  addListeners,
  addTokenChangeListener,
  getInitialNotification,
  startNotifications,
  stopNotifications,
} from "./services/notifications/NotificationService";
import {
  bindSubscriptionWithWirex,
  syncPushRegistration,
} from "./services/notifications/NotificationRegistrationService";
import { createNotificationRouter } from "./services/notifications/notificationRouting";
import { EventBus, resetMainScreensUi } from "./services/events/AppEventBusService";
import SupportModals from "./components/SupportModals";
import DesktopGate from "./components/DesktopGate";
import LandscapeGate from "./components/LandscapeGate";
import { IOS_MODAL_TRANSITION_DELAY_MS } from "./lib/timing";
import { installAlertSuppression } from "./services/app/AlertSuppressionService";
import { startBalanceDrivers, stopBalanceDrivers } from "./services/app/BalanceDriversService";
import { walletBalanceStore } from "./services/balance/WalletBalanceStore";
import { usdcBalanceStore } from "./services/balance/UsdcBalanceStore";
import {
  requestSupportUnreadSync,
  startSupportUnreadSync,
  stopSupportUnreadSync,
} from "./services/nostr/NostrUnreadSync";
import { homeCurrencyService } from "./lib/currency/HomeCurrencyService";
import { useAppLocale } from "./lib/i18n/useAppLocale";
import { initializeLanguagePreference } from "./services/app/LanguagePreferenceService";
import {
  bootstrapBitcoinOnLogin,
  hydrateBitcoinOnUnlock,
} from "./services/bitcoin/BitcoinBootstrapService";
import { arkadeRecoveryStatusForCredId } from "./services/arkade/ArkadeCredIdAccountService";
import { arkadeBootstrapClaimRegister, arkadeInfo } from "./services/arkade/ArkadeApiService";
import { ArkadeRemoteIdentity } from "./services/arkade/ArkadeRemoteIdentity";
import { getOrCreateArkadeIdentity } from "./services/arkade/internal/identity";
import {
  restoreArkadeRecoveryBackup,
  isArkadeRecoveryBackupNotFoundError,
  primeRecoveryBackupKeyFromPrf,
  runLazyCredPubkeyBackfill,
  hasLocalArkadeStorage,
  hasArkadeRestoreSentinel,
  setArkadeRestoreSentinel,
  hasArkadeRestoreFailedMarker,
  setArkadeRestoreFailedMarker,
} from "./services/arkade/ArkadeRecoveryBackupService";
import {
  cacheArkadeLnurlRegistration,
  claimArkadeLnurlUsername,
  getArkadeLnurlStatusPersisted,
  getArkadeLnurlStatusSnapshot,
} from "./services/arkade/ArkadeLnurlService";
import { WIREX_READ_SESSION_MINTED_EVENT, wirexService } from "./services/wirex/WirexService";
import { wirexAccountService } from "./services/wirex/WirexAccountService";
import {
  initWirexProvisioningRepair,
  resetWirexProvisioningRepair,
} from "./services/wirex/WirexProvisioningRepairService";
import UsernameOnboardingScreen from "./screens/onboarding/UsernameOnboardingScreen";
import V1WalletMigrationScreen from "./screens/migration/V1WalletMigrationScreen";
import { t } from "./lib/i18n";
import { checkMustUpdateForVersion, getBundleAppVersion } from "./services/app/AppUpdateService";
import { performFactoryReset } from "./services/app/FactoryResetService";
import {
  hasAbortedTeardown,
  requestUserLogout,
  requestWalletReplacement,
} from "./services/app/UserLogoutService";
import LogoutConfirmSheet from "./components/LogoutConfirmSheet";
import {
  SOFT_LOGOUT_RELAUNCH_SENTINEL_KEY,
  WIREX_FORCED_RELOGIN_DONE_KEY,
  performSoftLogoutForRelogin,
} from "./services/app/SoftLogoutService";
import PleaseUpdateAppModal from "./components/PleaseUpdateAppModal";
import { logWithId, LOG_EMOJI } from "./lib/OperationLogUtils";
import { IOS_APP_STORE_URL } from "./config/constants";
import { SWAPKIT_ENABLED } from "./config/network";
import {
  deriveNostrKeypairFromBitcoinKey,
  getOrCreateNostrKeypair,
  type NostrKeypair,
} from "./lib/nostr/nostr";
import { SUPPORT_PUBKEY } from "./lib/nostr/unread";
import { setPendingCardDetail } from "./lib/cardDetailIntent";
import {
  FACTORY_RESET_SCREEN,
  NURI_INTERNAL_LINK_PATTERN,
  SHOW_CARD_NUMBER_SCREEN,
  SHOW_IBAN_SCREEN,
  V1_WALLET_MIGRATION_SCREEN,
} from "./lib/internalLinks";
import { getArkadeWalletSummary } from "./services/arkade/ArkadeWalletService";
import {
  getV1WalletMigrationOldCredentialId,
  preserveV1WalletMigrationOldCredentialId,
} from "./services/app/V1WalletMigrationService";

// Suppress all native alerts globally; log instead.
installAlertSuppression();

const BIOMETRIC_SETUP_MESSAGE = () => t("screen.App.biometricSetupMessage");
const LOCK_SCREEN_SETUP_MESSAGE = () => t("screen.App.lockScreenSetupMessage");
const PASSCODE_AUTH_UNSUPPORTED_MESSAGE = () => t("screen.App.passcodeAuthUnsupportedMessage");
// Returning to the foreground re-locks only if the app was backgrounded for at
// least this long. A quick hop out (e.g. copying an address) returns within the
// grace window and skips the Face ID prompt; longer absences re-lock.
const BIOMETRIC_LOCK_GRACE_MS = 60_000;
let didRunMustUpdateCheck = false;

function initialPasskeyUsername(): string | null {
  if (Platform.OS !== "web" || typeof window === "undefined") return null;
  return parsePasskeyUsernamePath(window.location.pathname);
}

// `/pay/@username` is a link handed to strangers, so it is read once at mount
// and never cleared from the address bar: unlike a passkey claim there is
// nothing session-bound about it, and a reload must land on the same page.
function initialPayLinkUsername(): string | null {
  if (Platform.OS !== "web" || typeof window === "undefined") return null;
  return parsePayLinkPath(window.location.pathname);
}

// Drop the `/@username` link from the address bar. Clearing only the React state
// would leave the browser pointing at a claim that is finished or superseded, so
// the next refresh or PWA reopen would re-enter the targeted flow — for a name
// the user may no longer be claiming.
function clearPasskeyUsernameLocation(): void {
  if (typeof window === "undefined") return;
  window.history?.replaceState?.(null, "", "/");
}

// The faces the DS is drawn in. Shared, because both roots below need them
// loaded before anything renders and neither may wait on the other's state.
const APP_FONTS = {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  SharpGroteskBold: require("./assets/SharpGroteskBold25.ttf"),
  HarrietDisplayThin: require("./assets/Harriet-v2-Display-Thin.ttf"),
};

function redactDeepLinkForLog(url: string): Record<string, unknown> {
  if (url.startsWith("bitcoin:") || url.startsWith("btc:")) {
    const [, queryString] = url.replace(/^(bitcoin:|btc:)/, "").split("?");
    const params = new URLSearchParams(queryString || "");
    return {
      type: "bitcoin",
      hasAmount: params.has("amount"),
      hasLabel: params.has("label"),
      hasMessage: params.has("message"),
    };
  }
  if (url.startsWith("lightning:")) {
    const invoice = url.replace("lightning:", "");
    return {
      type: "lightning",
      invoiceLength: invoice.length,
    };
  }
  if (NURI_INTERNAL_LINK_PATTERN.test(url)) {
    const path = url.replace(NURI_INTERNAL_LINK_PATTERN, "");
    const [screenPath, queryString] = path.split("?");
    const segments = screenPath.split("/").filter(Boolean);
    return {
      type: "app",
      screen: segments[0] ?? "",
      action: segments[1] ?? "",
      hasQuery: Boolean(queryString),
    };
  }
  return { type: "unknown" };
}

// The app root, and the one decision taken before a wallet exists.
//
// `/pay/@username` is a public page a stranger opens, so it may not merely
// replace what WalletApp renders — WalletApp must never mount. Its init effect
// reads secureKeyStorage, unlocks keys, starts the signed-in services and, on a
// browser that holds a pre-Wirex wallet, reaches performSoftLogoutForRelogin(),
// which deletes local wallet state. Opening someone else's payment link must
// cost a visitor nothing, so the split sits above the component owning those
// effects rather than inside its render.
export default function App() {
  const [payLinkUsername] = useState(initialPayLinkUsername);
  // The app's own frame on the web, installed HERE rather than in `WalletApp`:
  // `#root` is one element shared by every route, so the height the browser is
  // actually showing has to be written for the payment-link page too (a page for
  // strangers on the same locked document, and one that fits a keypad and a
  // footer into it). `#root` takes its height from this custom property
  // (lib/web/appViewportHeight): Safari's toolbar moves the live layout viewport,
  // and a screen sized for the wrong one hides its bottom rows under the browser
  // chrome with no gesture able to reach them (#1372). No-op on native.
  useEffect(
    () =>
      observeAppViewportHeight(typeof window === "undefined" ? undefined : window, () => {
        revealFocusedField(document, (element) => getComputedStyle(element as Element).overflowY);
      }),
    [],
  );
  return payLinkUsername ? <PayLinkApp username={payLinkUsername} /> : <WalletApp />;
}

// The pay page's own root: fonts and the DS shell, nothing else. No auth, no
// key storage, no balance drivers, no currency service — a page for strangers
// touches none of them.
function PayLinkApp({ username }: { username: string }) {
  const [fontsLoaded] = useFonts(APP_FONTS);
  if (!fontsLoaded) return null;
  return (
    <GestureHandlerRootView style={styles.gestureRoot}>
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        <DsOverlayRoot>
          <DsView chrome="canvas" direction="column" align="stretch" fill="grow-shrink">
            <StatusBar style="dark" translucent backgroundColor="transparent" />
            <DsView fill="grow-shrink">
              {/* The wallet picker (RainbowKit + wagmi) exists on the pay
                  page only; the signed-in wallet never mounts it. */}
              <PayWalletProvider>
                <PayLinkScreen username={username} />
              </PayWalletProvider>
            </DsView>
          </DsView>
        </DsOverlayRoot>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function WalletApp() {
  const [showWelcome, setShowWelcome] = useState(false);
  const [welcomeFooterMessage, setWelcomeFooterMessage] = useState<string | null>(null);
  const [welcomeResetSignal, setWelcomeResetSignal] = useState(0);
  const [welcomeAutoOpenRestoreSignal, setWelcomeAutoOpenRestoreSignal] = useState(0);
  const [targetedPasskeyUsername, setTargetedPasskeyUsername] = useState(initialPasskeyUsername);
  // The handle a `/@username` sign-in resolved, kept past the link that carried
  // it. The credential the ceremony returned had to match the one the server
  // named for this handle, and the committed credential is checked against it
  // again below, so it identifies the signed-in account — which makes it the
  // only name the home screen can greet on its very first frame. Everything
  // else has to wait for the LNURL status fetch that the login bootstrap runs.
  const [signedInHandle, setSignedInHandle] = useState<string | null>(null);
  // A teardown aborted part-way (see UserLogoutService): the device is neither
  // signed in nor wiped. Nothing may present itself as a usable session until a
  // retry completes, so this owns the app root, not the flow that triggered it.
  const [teardownBlocked, setTeardownBlocked] = useState(hasAbortedTeardown);
  const [teardownRetryBusy, setTeardownRetryBusy] = useState(false);
  // The factory-reset deep link arrives unauthenticated — anything that can open
  // a URL can send it — so it only asks. The wipe waits for the confirmation the
  // sheet collects.
  const [factoryResetConfirmVisible, setFactoryResetConfirmVisible] = useState(false);
  const [currencyReady, setCurrencyReady] = useState(false);
  const appLocale = useAppLocale();
  const [isSignedInWithPRF, setIsSignedInWithPRF] = useState(false);
  // Username-claim gate: when truthy, the user has bootstrapped successfully but
  // hasn't claimed a Lightning handle yet. The home does not mount until the
  // claim succeeds; UsernameOnboardingScreen is shown instead.
  const [usernameClaimRequired, setUsernameClaimRequired] = useState(false);
  const [usernameClaimError, setUsernameClaimError] = useState<string | null>(null);
  const [usernameClaimBusy, setUsernameClaimBusy] = useState(false);
  const [bitcoinAddress, setBitcoinAddress] = useState<string>("");
  const [ethereumAddress, setEthereumAddress] = useState<string>("");
  // The headless drivers are the single source for every balance: they run on
  // app foreground, with or without a screen mounted, so a figure stays fresh
  // whatever the user has open.
  const [updateModalVisible, setUpdateModalVisible] = useState(false);
  const [updateModalVersion, setUpdateModalVersion] = useState<string | null>(null);
  const [debugHubVisible, setDebugHubVisible] = useState(false);
  const [showNostrChat, setShowNostrChat] = useState(false);
  const [supportAutoMessage, setSupportAutoMessage] = useState<string | undefined>(undefined);
  const [supportPrefillMessage, setSupportPrefillMessage] = useState<string | undefined>(undefined);
  const [v1MigrationSupportPrompt, setV1MigrationSupportPrompt] = useState<
    "pending" | "show" | null
  >(null);
  const [v1MigrationOldCredentialId, setV1MigrationOldCredentialId] = useState<string | null>(null);
  // Nostr identity for the blocked-restore support chat, derived in memory from
  // the un-persisted Bitcoin key. Undefined on every normal path, where the
  // chat reads its identity from secure storage.
  const [supportKeypairOverride, setSupportKeypairOverride] = useState<NostrKeypair | undefined>(
    undefined,
  );
  const [showDsReviewModal, setShowDsReviewModal] = useState(false);
  // Which debug screen the hub asked for, by its action name. The hub used to
  // announce these to the tab screens that hosted them, and those screens are
  // gone — the announcement reached nobody and the entries did nothing. They
  // belong to whoever owns the hub, which is here.
  const [debugScreen, setDebugScreen] = useState<string | null>(null);
  const [showNotificationsModal, setShowNotificationsModal] = useState(false);
  const [showV1WalletMigrationScreen, setShowV1WalletMigrationScreen] = useState(false);
  const [v1WalletMigrationIdentity, setV1WalletMigrationIdentity] = useState<{
    bitcoinBoardingAddress: string;
    eoaAddress: string;
    nostrNpub: string;
    username: string;
    oldCredentialId?: string;
  } | null>(null);
  const debugOpenTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [biometricLockVisible, setBiometricLockVisible] = useState(false);
  // When opened via the factory-reset deep link, the lock must not auto-unlock
  // (which would dismiss it before the user can reach Delete wallet).
  const [supportDumpVisible, setSupportDumpVisible] = useState(false);
  const [isAppActive, setIsAppActive] = useState(() => AppState.currentState === "active");
  const isDesktopWeb = useIsDesktopWeb();
  // Portrait-only on mobile web: touch device (not desktop) held in landscape.
  const isMobileLandscape = useIsWebLandscape() && !isDesktopWeb;
  const [showArkadeUnlockWallet, setShowArkadeUnlockWallet] = useState(false);
  const [suppressArkadeUnlockAutoOpen, setSuppressArkadeUnlockAutoOpen] = useState(false);
  const appStateRef = useRef(AppState.currentState);
  // Timestamp (ms) of the last time the app went to the background, used to
  // apply the BIOMETRIC_LOCK_GRACE_MS grace window on return.
  const backgroundedAtRef = useRef(0);
  // credId awaiting the one-shot lazy credPubkey backfill. Set at cold-launch
  // init, consumed AFTER unlock so its passkey PRF assertion can't race the
  // biometric lock prompt. See runLazyCredPubkeyBackfill.
  const pendingCredPubkeyBackfillRef = useRef<string | null>(null);

  const closeBiometricLockAfterWalletUnlock = useCallback(() => {
    setAppLocked(false);
    setBiometricLockVisible(false);
    // Launch check for a Wirex account that is entitled to a card or an IBAN but
    // never got one (#1090), plus the listener for KYC turning Approved later in
    // this same session. Hung off the unlock rather than sign-in because its
    // reads need a Wirex read session, and minting one signs with the on-device
    // EOA: from the now-warm key cache that is silent, before the unlock it would
    // raise Face ID for a background check. Once per launch, and it self-limits
    // to accounts that are actually missing something.
    initWirexProvisioningRepair();
  }, []);

  useEffect(
    () => addWalletUnlockedListener(closeBiometricLockAfterWalletUnlock),
    [closeBiometricLockAfterWalletUnlock],
  );

  const [fontsLoaded] = useFonts(APP_FONTS);

  const isMissingBiometricSetupError = useCallback((error: string) => {
    const lower = String(error || "").toLowerCase();
    return (
      lower.includes("no biometrics enrolled on device") ||
      lower.includes("biometric authentication not available")
    );
  }, []);
  const isMissingLockScreenError = useCallback((error: string) => {
    const lower = String(error || "").toLowerCase();
    return lower.includes("no device lock screen configured");
  }, []);
  const isPasscodeAuthUnsupportedError = useCallback((error: string) => {
    const lower = String(error || "").toLowerCase();
    return lower.includes("device passcode authentication unavailable");
  }, []);

  useEffect(() => {
    const off = EventBus.on("supportDump:open", (payload?: Record<string, unknown>) => {
      try {
        console.log("[SupportDump] Open requested", {
          source: typeof payload?.source === "string" ? payload.source : null,
        });
      } catch {}
      setSupportDumpVisible(true);
    });
    return off;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cachedEth, cachedBtc] = await Promise.all([
          getEthereumAddress(),
          getBitcoinAddress(),
        ]);
        if (cancelled) return;
        if (cachedEth) setEthereumAddress(cachedEth);
        if (cachedBtc) setBitcoinAddress(cachedBtc);
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const off = EventBus.on(
      "app:updateRequired",
      (payload?: { mustUpdate?: boolean; version?: string }) => {
        try {
          if (payload?.mustUpdate === true) {
            setUpdateModalVersion(typeof payload?.version === "string" ? payload.version : null);
            setUpdateModalVisible(true);
            return;
          }

          if (payload?.mustUpdate === false) {
            setUpdateModalVisible(false);
            setUpdateModalVersion(null);
          }
        } catch {}
      },
    );
    return off;
  }, []);

  useEffect(() => {
    if (didRunMustUpdateCheck) return;
    didRunMustUpdateCheck = true;

    // Send the JS-bundle version (moves with OTA), not the native Info.plist
    // version — that stays fixed across OTA and can't distinguish an updated
    // client from one still on the old bundle.
    const version = getBundleAppVersion();

    void (async () => {
      const mustUpdate = await checkMustUpdateForVersion(version);
      if (mustUpdate) {
        EventBus.emit("app:updateRequired", {
          mustUpdate: true,
          version,
          source: "AppStart",
        });
      }
    })();
  }, []);

  useEffect(() => {
    const handleAppState = (nextState: typeof AppState.currentState) => {
      const prevState = appStateRef.current;
      setIsAppActive(nextState === "active");
      if (nextState === "active") {
        if (prevState === "background" && isSignedInWithPRF) {
          // Grace window: a short hop out (copying an address, etc.) returns
          // within BIOMETRIC_LOCK_GRACE_MS and stays unlocked; longer absences
          // re-lock. backgroundedAtRef is 0 only if we never recorded a
          // background timestamp, which conservatively re-locks.
          const awayFor = backgroundedAtRef.current
            ? Date.now() - backgroundedAtRef.current
            : Number.POSITIVE_INFINITY;
          if (awayFor >= BIOMETRIC_LOCK_GRACE_MS) {
            showBiometricLock();
          }
        }
        startSupportUnreadSync();
      } else {
        if (nextState === "background") backgroundedAtRef.current = Date.now();
        stopSupportUnreadSync();
      }
      appStateRef.current = nextState;
    };
    handleAppState(AppState.currentState);
    const sub = AppState.addEventListener("change", handleAppState);
    return () => {
      sub.remove();
      stopSupportUnreadSync();
    };
  }, [isSignedInWithPRF]);

  // Receive-unlock detection lives here, not on the home: a Lightning payment
  // can land while the user is deep in a rail's detail screen or a sheet, and
  // the claim screen has to reach them there. Paused while the lock is up.
  const isWaitingForNetwork = useNetworkStatus();
  const { unlockState, runUnlock } = useArkadeReceiveUnlockMonitor({
    enabled: isSignedInWithPRF && !biometricLockVisible,
    isAppActive,
    isWaitingForNetwork,
  });

  useEffect(() => {
    if (unlockState.actionableCount <= 0) {
      setShowArkadeUnlockWallet(false);
      setSuppressArkadeUnlockAutoOpen(false);
      return;
    }
    if (unlockState.status !== "running" && !suppressArkadeUnlockAutoOpen) {
      setShowArkadeUnlockWallet(true);
    }
  }, [unlockState.actionableCount, unlockState.status, suppressArkadeUnlockAutoOpen]);

  const closeArkadeUnlockWallet = useCallback(() => {
    setSuppressArkadeUnlockAutoOpen(true);
    setShowArkadeUnlockWallet(false);
  }, []);

  // Reopening on demand is the second way in. A dismissed modal suppresses the
  // auto-open until the work is gone, and a boarding sweep only ever runs from
  // this modal — so without a way back the sats wait for the next payment.
  useEffect(() => {
    return EventBus.on(ARKADE_OPEN_UNLOCK_WALLET_EVENT, () => {
      setSuppressArkadeUnlockAutoOpen(false);
      setShowArkadeUnlockWallet(true);
    });
  }, []);

  // A card-topup swap that died mid-flight (app killed, tx reverted, SwapKit
  // outage) is persisted, not lost. Resuming on sign-in and on every foreground
  // is what finishes it — or, once its order is provably dead, recovers the USDC
  // the hub already delivered. Idempotent: in-flight orders are deduped.
  useEffect(() => {
    if (!isSignedInWithPRF || !isAppActive || biometricLockVisible || teardownBlocked) return;
    // v2 orders resume on every signed-in foreground. A commit intent from an
    // earlier launch never got its reply, so nothing was signed for it: it is
    // dropped (the user asks again), then the tracker drives every real order.
    void discardUnsignedV2CommitIntents()
      .catch(() => {})
      .finally(() => void resumeSwapKitV2Orders());
    // Sats still locked in a pre-v2 Satora Arkade swap come back here: the
    // due refund is signed with the swap key and paid to this wallet.
    if (SWAPKIT_ENABLED) void runLegacyArkadeRefunds();
  }, [isSignedInWithPRF, isAppActive, biometricLockVisible, teardownBlocked]);

  // Mercuryo checkout runs in the OS browser, so a purchase is only observable
  // through the provider's status endpoint. Resuming on every foreground is what
  // lets a purchase survive the sheet closing or the app being killed mid-checkout.
  useEffect(() => {
    if (!isSignedInWithPRF || !isAppActive) return;
    void hydrateAndResumeMercuryoOrders();
  }, [isSignedInWithPRF, isAppActive]);

  // One read at launch seeds the support badge; every later refresh rides the
  // foreground sync started in the AppState handler above.
  useEffect(() => {
    requestSupportUnreadSync();
  }, []);

  const handleOpenDebugHub = useCallback(() => {
    if (!DEBUG_UI_ENABLED) return;
    setDebugHubVisible(true);
  }, []);

  const handleCloseDebugHub = useCallback(() => {
    setDebugHubVisible(false);
  }, []);

  // Support chat + debug hub are opened app-wide via EventBus so the header
  // (mounted on every tab at once) needs no per-screen wiring. App owns the
  // single support modal and reacts to the logo→debug-hub gesture.
  const handleCloseNostrChat = useCallback(() => {
    setShowNostrChat(false);
    setSupportAutoMessage(undefined);
    setSupportPrefillMessage(undefined);
    setV1MigrationSupportPrompt(null);
    setSupportKeypairOverride((previous) => {
      if (previous) zeroize(previous.sk);
      return undefined;
    });
  }, []);

  useEffect(() => {
    const offOpen = EventBus.on("support:openNostrChat", () => setShowNostrChat(true));
    const offIncoming = EventBus.on("support:incomingMessage", () => setShowNostrChat(true));
    const offReport = EventBus.on("support:report", (payload?: { message?: string }) => {
      const message = typeof payload?.message === "string" ? payload.message : undefined;
      setSupportAutoMessage(message);
      // Let a dismissing sheet settle before presenting the chat (iOS).
      setTimeout(() => setShowNostrChat(true), IOS_MODAL_TRANSITION_DELAY_MS);
    });
    const offDebug = EventBus.on("debug:openHub", () => handleOpenDebugHub());
    return () => {
      offOpen();
      offIncoming();
      offReport();
      offDebug();
    };
  }, [handleOpenDebugHub]);

  const scheduleDebugOpen = useCallback((fn: () => void, delayMs: number) => {
    if (!DEBUG_UI_ENABLED) return;
    const timer = setTimeout(() => {
      debugOpenTimersRef.current = debugOpenTimersRef.current.filter((entry) => entry !== timer);
      fn();
    }, delayMs);
    debugOpenTimersRef.current.push(timer);
  }, []);

  useEffect(() => {
    return () => {
      for (const timer of debugOpenTimersRef.current) clearTimeout(timer);
      debugOpenTimersRef.current = [];
    };
  }, []);

  const openV1WalletMigrationScreen = useCallback(async () => {
    handleCloseNostrChat();
    let nostrKeypair: NostrKeypair | null = null;
    try {
      const [walletSummary, storedEoaAddress, lnurlStatus, persistedOldCredentialId] =
        await Promise.all([
          getArkadeWalletSummary({ forceFresh: true }),
          ethereumAddress ? Promise.resolve(ethereumAddress) : getEthereumAddress(),
          getArkadeLnurlStatusPersisted(),
          getV1WalletMigrationOldCredentialId(),
        ]);
      const bitcoinBoardingAddress = walletSummary.boardingAddress.trim();
      const username = lnurlStatus?.username?.trim() ?? "";
      if (!bitcoinBoardingAddress || !storedEoaAddress || !username) {
        throw new Error("Wallet migration identity is unavailable");
      }
      const oldCredentialId = v1MigrationOldCredentialId ?? persistedOldCredentialId;
      nostrKeypair = await getOrCreateNostrKeypair();
      setV1WalletMigrationIdentity({
        bitcoinBoardingAddress,
        eoaAddress: storedEoaAddress,
        nostrNpub: nostrKeypair.npub,
        username,
        ...(oldCredentialId ? { oldCredentialId } : {}),
      });
      setShowV1WalletMigrationScreen(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[App] Unable to open v1-wallet-migration-screen:", message);
    } finally {
      if (nostrKeypair) zeroize(nostrKeypair.sk);
    }
  }, [ethereumAddress, handleCloseNostrChat, v1MigrationOldCredentialId]);

  useEffect(
    () =>
      EventBus.on("nav:openV1WalletMigrationScreen", () => {
        void openV1WalletMigrationScreen();
      }),
    [openV1WalletMigrationScreen],
  );

  const closeDebugScreen = useCallback(() => setDebugScreen(null), []);
  // The two Wirex tools work against the account's smart wallet, which the
  // service already holds — asking for it costs nothing and needs no prompt.
  const debugWalletAddress = DEBUG_UI_ENABLED
    ? (wirexAccountService.getSnapshot().wallet ?? "")
    : "";

  const handleRunDebugAction = useCallback(
    (target: "app" | "wallet" | "card" | "bitcoin", action: string) => {
      if (!DEBUG_UI_ENABLED) return;
      setDebugHubVisible(false);
      if (target === "app" && action === "dsReview") {
        const openDelay = Platform.OS === "ios" ? 250 : 30;
        scheduleDebugOpen(() => setShowDsReviewModal(true), openDelay);
        return;
      }
      if (target === "app" && action === "notifications") {
        const openDelay = Platform.OS === "ios" ? 250 : 30;
        scheduleDebugOpen(() => setShowNotificationsModal(true), openDelay);
        return;
      }
      if (target === "app" && action === "webView") {
        const openDelay = Platform.OS === "ios" ? 250 : 30;
        scheduleDebugOpen(() => void openV1WalletMigrationScreen(), openDelay);
        return;
      }
      if (action === "factoryReset") {
        const resetDelay = Platform.OS === "ios" ? 180 : 30;
        scheduleDebugOpen(() => {
          void (async () => {
            try {
              resetMainScreensUi();
            } catch {}
            try {
              await performFactoryReset();
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              console.warn("[App] Factory reset failed:", msg);
            }
          })();
        }, resetDelay);
        return;
      }

      // Everything else is a screen of its own, named by its action.
      const actionDelay = Platform.OS === "ios" ? 250 : 30;
      scheduleDebugOpen(() => setDebugScreen(action), actionDelay);
    },
    [openV1WalletMigrationScreen, scheduleDebugOpen],
  );

  // Every balance and every poll used to exist only while its tab screen was
  // mounted. The drivers run them instead, gated on the app being in the
  // foreground — but still only while signed in and unlocked, because these are
  // authenticated reads and nothing may run behind the biometric lock.
  useEffect(() => {
    if (!isSignedInWithPRF || biometricLockVisible) return;
    startBalanceDrivers();
    // The on-chain rail exists for the user only once its MuSig2 address is
    // published, and the other caller of this fires on the LOCK-SCREEN
    // transition alone — a start with no lock to dismiss left the address
    // empty, so the on-chain bitcoin row was simply absent. Idempotent, and
    // public keys only (no biometric prompt).
    void hydrateBitcoinOnUnlock();
    return stopBalanceDrivers;
  }, [isSignedInWithPRF, biometricLockVisible]);

  useEffect(() => {
    // Auto-open Welcome (sign-in) WebView on launch if not signed in
    (async () => {
      try {
        // The stored language and display currency apply before the first
        // frame, so nothing renders in the device language and then flips.
        await Promise.all([homeCurrencyService.initialize(), initializeLanguagePreference()]);
        setCurrencyReady(true);
        await authStateManager.initialize();
        const authSnapshot = authStateManager.getState();
        const storedUsername = authSnapshot.walletUsername?.trim().toLowerCase() || "";
        if (storedUsername) {
          setSignedInHandle(storedUsername);
        } else {
          // One-time migration for installs created before username became part
          // of authenticated state. The old LNURL snapshot may still carry the
          // verified handle; preserve it before Home is allowed to mount.
          const legacyStatus = await getArkadeLnurlStatusPersisted().catch((): null => null);
          const legacyUsername = legacyStatus?.registered
            ? legacyStatus.username?.trim().toLowerCase() || ""
            : "";
          if (legacyUsername) {
            await authStateManager.setWalletUsername(legacyUsername);
            setSignedInHandle(legacyUsername);
          } else {
            const keys = authSnapshot.walletPublicKeys;
            const credId = keys?.walletPasskeyCredIdB64u?.trim() || "";
            const clientPk33 = keys?.userExternal?.trim() || "";
            if (credId && clientPk33) {
              // Authoritative no-prompt recovery for clients whose old receive
              // cache is already gone. The server returns a public username only
              // when BOTH credential and signer key match the registered owner.
              const ownerInfo = await arkadeInfo({
                credIdB64u: credId,
                credPubkeyB64u: keys?.walletPasskeyCredPubkeyB64u,
                clientSignerPubkeyHex: clientPk33,
              }).catch((): null => null);
              const ownerUsername = ownerInfo?.username?.trim().toLowerCase() || "";
              if (ownerUsername) {
                await authStateManager.setWalletUsername(ownerUsername);
                setSignedInHandle(ownerUsername);
              }
            }
          }
        }
        console.log("[App.init] Auth snapshot after initialize", {
          userId: authSnapshot.userId,
          isSignedIn: authSnapshot.isSignedIn,
          hasPasskey: authSnapshot.hasPasskey,
        });
        // A stored wallet key proves first-time bootstrap already completed.
        const hasEthKey = await hasStoredKey("ethereum");
        const hasBtcKey = await hasStoredKey("bitcoin");
        console.log("[App.init] Stored keys:", { hasEthKey, hasBtcKey });
        if (hasEthKey) {
          // One-time forced re-onboarding for the Wirex cutover. hasEthKey proves a
          // completed bootstrap; a pre-Wirex account has one but never stamped the
          // marker (that stamp is added at onboarding below, handleStatelessPayload),
          // so it is signed out exactly once to create a fresh arkade + Wirex account
          // (migrating old funds happens on the website, not in-app). Any account
          // onboarded under this build carries the marker, so this never re-fires for
          // it. Fresh installs never reach here (no eth key).
          const wirexForcedReloginDone = await getAuthData(WIREX_FORCED_RELOGIN_DONE_KEY);
          if (wirexForcedReloginDone !== "1") {
            console.log("[App.init] Wirex cutover: forcing one-time re-onboarding logout");
            // No marker written here: the wipe removes the eth key, so this gate
            // cannot re-fire, and the subsequent re-onboarding stamps the marker
            // (handleStatelessPayload) exactly like any new user.
            await performSoftLogoutForRelogin();
            return;
          }
          // Marker is set, so this account onboarded under this build and MUST
          // carry the combined unlock entry (written last in persistBootstrappedKeys).
          // If it's absent, setup was interrupted between the per-key write and the
          // combined commit (process killed) — the eth key alone can't unlock the
          // wallet (unlockWalletKeys has no per-key fallback). Redo onboarding
          // cleanly instead of signing into an unusable wallet.
          // A missing combined entry used to wipe the keychain here and drop the
          // user on the welcome screen — on a cold start, with no interaction,
          // and with no hint, so the account looked gone. "Not found right now"
          // is not proof the wallet is unusable, and even if it were, deleting
          // the remaining key material is not this check's call to make. The
          // launch continues; an entry that really is missing surfaces as a
          // failed unlock on the lock screen, which retries instead of deleting.
          if (!(await hasCompletedWalletBootstrap())) {
            console.warn(
              "[App.init] Combined unlock entry not found — continuing to the lock screen",
            );
          }
          console.log("[App.init] Ethereum key present; skipping auto SIWE on launch");
          // Migration: pre-#481 devices reached this point via the old flow
          // (eth key persisted before Arkade restore was even a concept). Now that
          // the combined unlock entry is confirmed above, hasEthKey implies a
          // complete bootstrap, so for these upgrade users we stamp the sentinel once
          // here. Without this, the next passkey sign-in would treat their
          // valid local state as partial-restore residue and re-run restore.
          const migrationCredId = authSnapshot.walletPublicKeys?.walletPasskeyCredIdB64u;
          if (
            migrationCredId &&
            (await hasLocalArkadeStorage()) &&
            !(await hasArkadeRestoreSentinel(migrationCredId)) &&
            // A prior non-404 restore failure may have left partial v4 residue.
            // Promoting that to "complete" here would stamp the sentinel and
            // suppress the retry; skip stamping until a restore actually succeeds.
            !(await hasArkadeRestoreFailedMarker(migrationCredId))
          ) {
            await setArkadeRestoreSentinel(migrationCredId);
            console.log("[App.init] Migrated pre-#481 device: arkade sentinel set");
          }
          // Honour the pending-username gate across cold restarts. A new
          // passkey can be created + keys persisted + app killed before the
          // user finishes the LNURL claim; without this check the cold-launch
          // path would sign them in past the mandatory gate. Cleared by
          // handleUsernameClaimSubmit on success.
          const pendingUsernameClaim = await getAuthData(USERNAME_CLAIM_REQUIRED_KEY);
          if (pendingUsernameClaim === "1") {
            console.log(
              "[App.init] username_claim_required sentinel present — gating on UsernameOnboardingScreen",
            );
            setShowWelcome(false);
            setTargetedPasskeyUsername(null);
            // The gate wins over the link, so the link must not survive it: the
            // user finishes in the picker and may pick a different name than the
            // interrupted `/@…` one.
            clearPasskeyUsernameLocation();
            setUsernameClaimError(null);
            setUsernameClaimRequired(true);
            return;
          }
          setIsSignedInWithPRF(true);
          showBiometricLock();
          // Native is already behind the lock above. A browser is not, so its
          // broken wallet used to render as a signed-in app with every balance
          // at zero and no way to say so — the read is the only thing that knows.
          if (Platform.OS === "web") {
            void unlockWalletKeys().catch(() => showBiometricLock({ repair: true }));
          }
          setShowWelcome(false);
          // Lazy one-shot credPubkey backfill for legacy users who migrated to a second
          // device before #478 shipped. credPubkey is required for PASSKEY_PUBKEY_POLICY=hard.
          const credIdLocal = authSnapshot.walletPublicKeys?.walletPasskeyCredIdB64u;
          const credPubLocal = authSnapshot.walletPublicKeys?.walletPasskeyCredPubkeyB64u;
          if (credIdLocal && !credPubLocal) {
            // Defer the one-shot lazy credPubkey backfill until after unlock:
            // its decrypt step triggers a passkey PRF assertion (Face ID) that
            // must not race the biometric lock prompt shown above. Consumed in
            // the post-unlock effect (biometricLockVisible true→false).
            pendingCredPubkeyBackfillRef.current = credIdLocal;
          }
          // NOTE: cold-launch does NOT force the username picker. Users who
          // have never claimed a handle must be able to sign into their
          // existing wallet without claim friction. Username claim only
          // runs through handleStatelessPayload (welcome → passkey flow).
        } else {
          console.log("🏁 App.init Not signed-in; auto-opening Welcome modal");
          setShowWelcome(true);
        }
      } catch (_e) {
        // If auth state fails to load, default to opening sign-in
        console.log("🏁 App.init Auth state failed to load; opening Welcome modal");
        setShowWelcome(true);
      }
    })();

    // Handle deep links
    const handleDeepLink = (url: string | null) => {
      if (!url) return;

      console.log("[App:handleDeepLink] Deep link received:", redactDeepLinkForLog(url));

      // Handle Bitcoin payment URIs (BIP-21)
      if (url.startsWith("bitcoin:") || url.startsWith("btc:")) {
        // Parse Bitcoin address and parameters
        const [address, queryString] = url.replace(/^(bitcoin:|btc:)/, "").split("?");
        const params = new URLSearchParams(queryString || "");

        console.log("[App:handleDeepLink] Bitcoin payment request:", {
          addressLength: address.length,
          hasAmount: params.has("amount"),
          hasLabel: params.has("label"),
          hasMessage: params.has("message"),
        });

        // Open the bitcoin rail. The amount/label the URI carries is not yet
        // handed to the send flow.
        openHomeRail("arkade");
        return;
      }

      // Handle Lightning invoices
      if (url.startsWith("lightning:")) {
        const invoice = url.replace("lightning:", "");
        console.log("[App:handleDeepLink] Lightning invoice:", {
          invoiceLength: invoice.length,
        });

        // Open the bitcoin rail. The invoice itself is not yet handed to the
        // send flow.
        openHomeRail("arkade");
        return;
      }

      // Handle Nuri app navigation across prod/preview/dev installs
      if (NURI_INTERNAL_LINK_PATTERN.test(url)) {
        const path = url.replace(NURI_INTERNAL_LINK_PATTERN, "");
        const [screenPath] = path.split("?");
        const segments = screenPath.split("/").filter(Boolean);
        const screen = segments[0] ?? "";

        switch (screen) {
          case "bitcoin":
            openHomeRail("arkade");
            break;
          case "card":
            openHomeRail("visa");
            break;
          case SHOW_IBAN_SCREEN:
          case SHOW_CARD_NUMBER_SCREEN: {
            const wantsBank = screen === SHOW_IBAN_SCREEN;
            resetMainScreensUi();
            setShowNostrChat(false);
            openHomeRail(wantsBank ? "iban" : "visa");
            // Queue the target instead of a one-shot emit: the home may be
            // unmounted (cold start) or its card/bank data not loaded yet, and
            // EventBus does not buffer. The home drains this once it is mounted
            // and the matching data is ready. Also nudge it in case it is already
            // mounted and ready (so no state change re-runs its drain effect).
            setPendingCardDetail(wantsBank ? "bank" : "card");
            EventBus.emit("card:drainPendingDetail");
            break;
          }
          case "wallet":
          case "keys":
            openHomeRail("wallet");
            break;
          case V1_WALLET_MIGRATION_SCREEN:
            EventBus.emit("nav:openV1WalletMigrationScreen");
            break;
          case FACTORY_RESET_SCREEN:
            // Opens the logout confirmation; confirming wipes the wallet and
            // reloads to the welcome screen. The link cannot do the wiping
            // itself: `nuri://` is an unauthenticated custom scheme, so any app,
            // page or support message that can open a URL could otherwise
            // destroy this device's key material without the user agreeing to
            // it. The sheet is the only thing that reaches requestUserLogout.
            setShowNostrChat(false);
            resetMainScreensUi();
            setFactoryResetConfirmVisible(true);
            break;
          default:
            console.log("[App:handleDeepLink] Unknown deep link screen:", screen);
        }
      }
    };

    // Check if app was opened with a deep link
    Linking.getInitialURL().then(handleDeepLink);

    // Listen for deep links while app is open
    const subscription = Linking.addEventListener("url", (event) => {
      handleDeepLink(event.url);
    });
    const offInternalLink = EventBus.on<string>("app:openInternalLink", (url) => {
      handleDeepLink(url ?? null);
    });

    return () => {
      subscription.remove();
      offInternalLink();
    };
  }, []);

  const showBiometricLock = useCallback((opts?: { repair?: boolean }) => {
    // A browser has no authenticator, so there is nothing for a periodic gate to
    // ask for and it never engages one. A REPAIR is the other thing this screen
    // does: keys a read cannot find are rebuilt from the passkey, and that works
    // in a browser — so a wallet that is broken there gets the screen, and only
    // then.
    if (Platform.OS === "web" && !opts?.repair) return;
    // Engage the key gate before any signed-in background work runs: while
    // locked, getPrivateKey parks instead of raising its own Face ID. Released
    // on unlock (onClose) so SIWE/signing resume against the cache the unlock
    // read seeds.
    setAppLocked(true);
    // Hide every app-level overlay so the biometric lock cannot end up
    // stacked behind another modal or browser handoff screen.
    setDebugHubVisible(false);
    setSupportDumpVisible(false);
    setUpdateModalVisible(false);
    setShowWelcome(false);
    try {
      resetMainScreensUi();
    } catch {}
    // The lock renders as a single <Layer> (same-window, not a native modal), so
    // it paints in this same tick — no cover/deferral needed.
    setBiometricLockVisible(true);
  }, []);

  const prevBiometricLockVisibleRef = useRef(biometricLockVisible);
  useEffect(() => {
    const prev = prevBiometricLockVisibleRef.current;
    prevBiometricLockVisibleRef.current = biometricLockVisible;
    // After the lock screen is dismissed, re-evaluate overlays that were
    // suppressed while it was visible (e.g. forced-update prompt).
    if (prev && !biometricLockVisible && isSignedInWithPRF) {
      void hydrateBitcoinOnUnlock();
      if (updateModalVersion) {
        setUpdateModalVisible(true);
      }
      // Run the deferred one-shot lazy credPubkey backfill now that the app is
      // unlocked, so its passkey PRF assertion can't collide with the lock
      // prompt. Cleared first so it fires at most once per launch.
      const pendingBackfillCredId = pendingCredPubkeyBackfillRef.current;
      if (pendingBackfillCredId) {
        pendingCredPubkeyBackfillRef.current = null;
        void runLazyCredPubkeyBackfill(pendingBackfillCredId);
      }
    }
  }, [biometricLockVisible, isSignedInWithPRF, updateModalVersion]);

  // Initialize global network logging once (inside component, not at module scope)
  useEffect(() => {
    initializeNetworkLogging();
    logWithId(`${LOG_EMOJI.app} App.init`, "network logging initialized", undefined, {
      scope: "App",
      action: "init",
      result: "ok",
      source: "App.tsx#useEffect",
      context: "background",
    });
  }, []);

  useEffect(() => {
    void startNetworkMonitor();
    return () => {
      stopNetworkMonitor();
    };
  }, []);

  // Foreground presentation + the Android channel must be in place before any
  // notification can arrive. Asks for no permission and acquires no token — both
  // stay explicit, so nothing prompts the user until a feature needs it.
  useEffect(() => {
    void startNotifications();
    return () => {
      stopNotifications();
    };
  }, []);

  // Wires both notification paths — an arrival refreshes, a tap also navigates.
  // See createNotificationRouter for why the two differ.
  useEffect(() => {
    const router = createNotificationRouter({
      // The server still names one of the three product areas; each is a rail
      // on the home now.
      navigateToTarget: (target) =>
        openHomeRail(target === "bitcoin" ? "arkade" : target === "card" ? "visa" : "wallet"),
    });

    // A tap that cold-started the app predates this listener — hence the
    // separate initial-notification read.
    void (async () => {
      const initial = await getInitialNotification();
      if (initial) router.onTapped(initial);
    })();

    return addListeners(router);
  }, []);

  // Reports the device to the notification server once the wallet exists. Never
  // prompts: it only acts on a permission the user already granted, so sign-in
  // stays free of permission dialogs. The opt-in lives at the receive flow.
  useEffect(() => {
    if (!isSignedInWithPRF) return;
    void syncPushRegistration();
    // APNs/FCM can rotate the token mid-session. Without this the server would
    // keep pushing to the dead one until the next sign-in.
    const offTokenChange = addTokenChangeListener(() => {
      void syncPushRegistration();
    });
    // The wirex binding can only authenticate with a cached Wirex read session,
    // and that cache is per-process: at sign-in there is never one, so the bind
    // above is always a no-op. The card flows mint one later — bind then.
    const offSessionMinted = EventBus.on(WIREX_READ_SESSION_MINTED_EVENT, () => {
      void bindSubscriptionWithWirex();
    });
    // The provisioning repair (#1090) hangs off the wallet unlock on native, but
    // the browser has no biometric lock/unlock cycle and secureKeyStorage.web
    // implements that listener as a no-op — so web needs its own entry point, and
    // being signed in is the point at which key material is available there. The
    // repair itself is latched once per launch, so the two call sites cannot both
    // run it.
    if (Platform.OS === "web") initWirexProvisioningRepair();
    return () => {
      offTokenChange();
      offSessionMinted();
    };
  }, [isSignedInWithPRF]);

  // Any error path that shows the welcome screen must also tear down the
  // signed-in state and any in-flight gates. Otherwise a previously-mounted
  // home / username picker bleeds through the welcome overlay (e.g.
  // cold-launch hasEthKey=true → signedIn=true → error → username picker
  // visible on top of welcome).
  const resetToWelcome = useCallback((resetSignalBump = true) => {
    // Abort (not unlock) the key gate: reject parked key reads so background
    // SIWE/signing can't resume and prompt during sign-out.
    abortAppLock();
    // Drop the cached Wirex read session so a same-process relogin to a
    // different wallet re-mints instead of reusing the old wallet's token.
    wirexService.clearReadSession();
    // Same reason for the account snapshot: clear the cross-wallet cache and
    // unwire the one-shot bootstrap so the card tab reloads for the new wallet
    // instead of showing the previous wallet's card/balance/IBAN.
    wirexAccountService.reset();
    // Same reason: the headless wallet balances are EOA-scoped state that must
    // not survive into a different identity's session. Both tokens on that
    // address, so both stores.
    walletBalanceStore.reset();
    usdcBalanceStore.reset();
    // The once-per-launch provisioning check is latched per account, so release
    // it too — a relogin to a different wallet must get its own check.
    resetWirexProvisioningRepair();
    setIsSignedInWithPRF(false);
    // Scoped to the session that resolved it: a relogin as a different account
    // must not be greeted with the previous one's handle.
    setSignedInHandle(null);
    setBiometricLockVisible(false);
    setUsernameClaimRequired(false);
    setUsernameClaimError(null);
    setUsernameClaimBusy(false);
    setShowWelcome(true);
    if (resetSignalBump) setWelcomeResetSignal((n) => n + 1);
  }, []);

  // `auth:relogin` asks for a full return to the welcome/login screen so the
  // user re-auths with their passkey (the credId hint is preserved in
  // walletPublicKeys). It also auto-triggers the existing-passkey flow, so they
  // land directly in the Continue modal (if a hint exists) or the iOS picker —
  // no extra tap on "Restore Wallet" required.
  useEffect(() => {
    const off = EventBus.on("auth:relogin", () => {
      try {
        logWithId(`${LOG_EMOJI.app} App.relogin`, "relogin requested", {}, { context: "system" });
        resetToWelcome();
        setWelcomeAutoOpenRestoreSignal((n) => n + 1);
      } catch {}
    });
    return off;
  }, [resetToWelcome]);

  // After SoftLogoutService.performSoftLogoutForRelogin reloads the app, the
  // sentinel signals we should auto-open PasskeyLoginScreen's "Continue with
  // @<name>" modal (the credId/credPubkey/nameBase hint was preserved across
  // the wipe). One-shot: read + delete + bump signal.
  useEffect(() => {
    void (async () => {
      try {
        const sentinel = await getAuthData(SOFT_LOGOUT_RELAUNCH_SENTINEL_KEY);
        if (sentinel) {
          try {
            await deleteAuthData(SOFT_LOGOUT_RELAUNCH_SENTINEL_KEY);
          } catch {}
          setWelcomeAutoOpenRestoreSignal((n) => n + 1);
        }
      } catch (e) {
        console.warn("[App] soft-logout sentinel consume failed:", e);
      }
    })();
  }, []);

  const handleError = useCallback(
    (error: string) => {
      console.log(`[App:handleError] Error received: ${error}`);

      if (isMissingLockScreenError(error)) {
        console.log(
          "[App:handleError] No device lock screen during bootstrap - keeping welcome open",
        );
        setWelcomeFooterMessage(LOCK_SCREEN_SETUP_MESSAGE());
        setShowWelcome(true);
        setWelcomeResetSignal((n) => n + 1);
        return;
      }

      if (isPasscodeAuthUnsupportedError(error)) {
        console.log(
          "[App:handleError] Passcode auth unsupported on this device - keeping welcome open",
        );
        setWelcomeFooterMessage(PASSCODE_AUTH_UNSUPPORTED_MESSAGE());
        setShowWelcome(true);
        setWelcomeResetSignal((n) => n + 1);
        return;
      }

      if (isMissingBiometricSetupError(error)) {
        console.log("[App:handleError] Missing biometrics during bootstrap - keeping welcome open");
        setWelcomeFooterMessage(BIOMETRIC_SETUP_MESSAGE());
        resetToWelcome();
        return;
      }

      // Don't close the WebView for user cancellations - let them try again
      const lowerError = error.toLowerCase();
      setWelcomeFooterMessage(null);
      if (lowerError.includes("passkey_native")) {
        console.log("[App:handleError] Passkey native error - keeping welcome open");
        resetToWelcome();
        return;
      }

      if (
        lowerError.includes("cancel") ||
        lowerError.includes("abort") ||
        lowerError.includes("notallowederror") ||
        lowerError.includes("prf not supported") ||
        lowerError.includes("webauthn:not_supported") ||
        lowerError.includes("webauthn_not_supported") ||
        lowerError.includes("user denied") ||
        lowerError.includes("user declined")
      ) {
        console.log("[App:handleError] User cancellation - keeping WebView open");
        resetToWelcome();
        return;
      }

      console.log("[App:handleError] Bootstrap error - keeping welcome open for retry");
      resetToWelcome();
    },
    [
      isMissingBiometricSetupError,
      isMissingLockScreenError,
      isPasscodeAuthUnsupportedError,
      resetToWelcome,
    ],
  );

  const handleWelcomeAttemptStart = useCallback(() => {
    setWelcomeFooterMessage(null);
  }, []);

  const handleStatelessPayload = useCallback(
    async (payload: {
      prf: Uint8Array;
      isNew: boolean;
      credIdB64u?: string;
      credPubkeyB64u?: string;
    }) => {
      setWelcomeFooterMessage(null);

      const hasCredId = !!payload.credIdB64u;
      const credIdLen = payload.credIdB64u?.length ?? 0;
      const hasCredPub = !!payload.credPubkeyB64u;
      const credPubLen = payload.credPubkeyB64u?.length ?? 0;

      console.log("[App:handleStatelessPayload] wallet passkey metadata", {
        isNew: payload.isNew,
        hasCredId,
        credIdLen,
        hasCredPub,
        credPubLen,
      });

      // For initial wallet creation we require both cred_id and cred_pubkey.
      if (payload.isNew && (!hasCredId || credIdLen === 0 || !hasCredPub || credPubLen === 0)) {
        zeroize(payload.prf);
        handleError(
          "Failed to capture wallet passkey credential. Please use “Create New Wallet Passkey” on a device that supports passkeys.",
        );
        return;
      }

      try {
        console.log(
          "[App:handleStatelessPayload] Starting PRF bootstrap via bootstrapWalletFromPrf",
          {
            isNew: payload.isNew,
            hasCredId,
            hasCredPub,
          },
        );
        const prfForBootstrap = new Uint8Array(payload.prf);
        const bootstrapResult = await bootstrapWalletFromPrf(prfForBootstrap);
        try {
          console.log(
            "[App:handleStatelessPayload] Completed PRF bootstrap via bootstrapWalletFromPrf",
            {
              bitcoinAddressPreview: bootstrapResult?.bitcoinAddress
                ? `${bootstrapResult.bitcoinAddress.slice(0, 8)}...${bootstrapResult.bitcoinAddress.slice(-6)}`
                : null,
              ethereumAddressPreview: bootstrapResult?.ethereumAddress
                ? `${bootstrapResult.ethereumAddress.slice(0, 8)}...${bootstrapResult.ethereumAddress.slice(-6)}`
                : null,
            },
          );
          // Restore is only for accounts registered with the arkade signer.
          // An unregistered credId is a pre-cutover passkey: signing it back in
          // would resurrect the account the Wirex cutover forced the user out
          // of. GET /arkade/info is a pure read (server: getRecoveryStatus →
          // getByCred), unauthenticated, so this costs no extra passkey prompt.
          // Runs before persistBootstrappedKeys — bailing leaves the keychain
          // untouched. Fails closed: a throw lands in the catch below, which
          // returns to the welcome screen.
          if (payload.isNew === false) {
            console.log("[App:handleStatelessPayload] restore gate: querying arkade recovery", {
              credIdLen: payload.credIdB64u?.length ?? 0,
              clientPkLen: bootstrapResult.bitcoinPublicKey.length,
            });
            let recoveryStatus: Awaited<ReturnType<typeof arkadeRecoveryStatusForCredId>>;
            try {
              recoveryStatus = await arkadeRecoveryStatusForCredId({
                credIdB64u: payload.credIdB64u ?? "",
                credPubkeyB64u: payload.credPubkeyB64u,
                clientSignerPubkeyHex: bootstrapResult.bitcoinPublicKey,
              });
            } catch (gateErr) {
              const msg = gateErr instanceof Error ? gateErr.message : String(gateErr);
              console.error("[App:handleStatelessPayload] restore gate: query failed", msg);
              throw gateErr;
            }
            console.log("[App:handleStatelessPayload] restore gate: result", {
              hasRecoveryBlock: recoveryStatus !== null,
              registered: recoveryStatus?.registered ?? null,
              passkeyPubkeyPresent: recoveryStatus?.passkey_pubkey_present ?? null,
            });
            if (!recoveryStatus?.registered || !recoveryStatus.passkey_pubkey_present) {
              console.log(
                "[App:handleStatelessPayload] Restore blocked: credential is not registered or has no passkey pubkey",
              );
              // Open support as the wallet's own Nostr identity, derived here
              // from the in-memory Bitcoin key (never persisted). Same npub the
              // old account used, so an existing support thread continues.
              setSupportKeypairOverride(
                deriveNostrKeypairFromBitcoinKey(bootstrapResult.bitcoinPrivateKey),
              );
              const oldCredentialId = payload.credIdB64u?.trim() ?? "";
              if (oldCredentialId) {
                setV1MigrationOldCredentialId(oldCredentialId);
                try {
                  await preserveV1WalletMigrationOldCredentialId(oldCredentialId);
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  console.warn("[App] Unable to persist legacy credential ID:", message);
                }
              }
              setSupportAutoMessage(t("screen.PasskeyLoginScreen.restoreBlockedSupportMessage"));
              resetToWelcome();
              // Let the passkey sheet finish dismissing before presenting (iOS).
              setTimeout(() => setShowNostrChat(true), IOS_MODAL_TRANSITION_DELAY_MS);
              return;
            }
          }

          try {
            await storeEthereumAddress(bootstrapResult.ethereumAddress);
          } catch {}
          setEthereumAddress(bootstrapResult.ethereumAddress);

          // Stamp the Wirex-cutover marker the moment this build persists an eth
          // key. This is the invariant that makes the one-time forced
          // re-onboarding gate (App.init) correct: every account onboarded under
          // this build carries the marker, so the gate fires ONLY for genuine
          // pre-Wirex installs (eth key from an old build, never stamped).
          try {
            await storeAuthData(WIREX_FORCED_RELOGIN_DONE_KEY, "1");
          } catch {}

          // Persist the wallet passkey credential so arkade can identify the
          // wallet (ArkadeRemoteIdentity / ArkadeRecoveryBackupService read
          // walletPublicKeys.walletPasskeyCredIdB64u) and isSignedIn derives.
          // Must run BEFORE the arkade restore block below, which reads it.
          // Formerly a side effect of the removed MuSig2 markWalletCreated.
          if (payload.credIdB64u) {
            try {
              await authStateManager.upsertWalletPasskeyMetadata(
                payload.credIdB64u,
                payload.credPubkeyB64u,
                bootstrapResult.bitcoinPublicKey,
              );
            } catch (err) {
              // Non-fatal here, but arkade init on the next launch depends on this
              // metadata — surface the failure instead of swallowing it silently.
              console.error(
                "[App:handleStatelessPayload] Failed to persist wallet passkey metadata",
                err,
              );
            }
          }

          try {
            await storeBitcoinAddress(bootstrapResult.bitcoinAddress);
          } catch {}
          setBitcoinAddress(bootstrapResult.bitcoinAddress);
          // Tracks a genuine (non-404) restore failure so we do NOT seal the
          // restore sentinel below. The sentinel's absence is the signal to
          // re-attempt restore on the next sign-in; sealing it after a failed
          // restore would suppress that retry and strand partial/empty state.
          let arkadeRestoreFailed = false;
          let arkadeRestoreRetryAfterKeyPersist = false;
          const isPrePersistBitcoinKeyMissing = (error: unknown): boolean => {
            const msg = error instanceof Error ? error.message : String(error);
            return msg.includes("No bitcoin key found in secure storage");
          };
          const backfillRestoredCredPubkey = async (restoredCredPubkey: string): Promise<void> => {
            const haveCredPubLocally = Boolean(
              payload.credPubkeyB64u && payload.credPubkeyB64u.length > 0,
            );
            if (!haveCredPubLocally && restoredCredPubkey.length > 0 && payload.credIdB64u) {
              try {
                await authStateManager.upsertWalletPasskeyMetadata(
                  payload.credIdB64u,
                  restoredCredPubkey,
                );
                console.log(
                  "[App:handleStatelessPayload] Backfilled walletPasskeyCredPubkeyB64u from restore",
                );
              } catch (backfillErr) {
                const msg =
                  backfillErr instanceof Error ? backfillErr.message : String(backfillErr);
                console.warn(
                  "[App:handleStatelessPayload] credPubkey backfill upsert failed:",
                  msg,
                );
              }
            }
          };
          if (
            payload.isNew === false &&
            (!payload.credIdB64u || !(await hasArkadeRestoreSentinel(payload.credIdB64u)))
          ) {
            // Multi-device login on a device without a complete-state sentinel:
            // pull the encrypted backup from the recovery server to seed
            // local state. The sentinel — set only after a successful
            // multiSet — distinguishes "truly empty / fresh device" and
            // "partial-restore residue from a prior crashed attempt" (both
            // need a restore) from "fully bootstrapped, trust local cache"
            // (skip). Cold-launch migration above promotes pre-#481 devices.
            const identity = new ArkadeRemoteIdentity();
            if (payload.credIdB64u) {
              const prfForRestoreKey = new Uint8Array(payload.prf);
              try {
                primeRecoveryBackupKeyFromPrf(prfForRestoreKey, payload.credIdB64u);
              } finally {
                zeroize(prfForRestoreKey);
              }
            }
            try {
              const { summary: restoreSummary, passkeyCredPubkeyB64u: restoredCredPubkey } =
                await restoreArkadeRecoveryBackup(identity, payload.credIdB64u);
              console.log("[App:handleStatelessPayload] Arkade recovery backup restored", {
                items: restoreSummary.storageItemCount,
                hardModeComplete: restoreSummary.hardModeComplete,
                credPubkeyInBackup: restoredCredPubkey.length > 0,
              });
              await backfillRestoredCredPubkey(restoredCredPubkey);
            } catch (restoreErr) {
              if (isArkadeRecoveryBackupNotFoundError(restoreErr)) {
                console.log(
                  "[App:handleStatelessPayload] No arkade recovery backup found, proceeding as fresh install",
                );
              } else {
                const msg = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
                // A failed Arkade recovery restore must NEVER block sign-in.
                // Log and continue — the user signs in with local state (Arkade
                // if it later populates from the operator, legacy otherwise).
                // (Previously this called handleError + return, which hard-
                // failed login.)
                // Mark it failed so the restore sentinel is NOT set below; the
                // next sign-in then retries restore over the residue. Persist a
                // per-credId failure marker too, so the cold-launch pre-#481
                // migration path can't later stamp the sentinel over this
                // residue and suppress the retry.
                arkadeRestoreFailed = true;
                if (payload.credIdB64u) {
                  await setArkadeRestoreFailedMarker(payload.credIdB64u);
                }
                if (isPrePersistBitcoinKeyMissing(restoreErr)) {
                  arkadeRestoreRetryAfterKeyPersist = true;
                  logWithId(
                    `${LOG_EMOJI.bitcoin} App.arkadeRestore`,
                    "restore deferred until bitcoin key is persisted",
                    { reason: msg },
                    {
                      context: "background",
                      event: "RETRY",
                      action: "restore",
                      source: "App.tsx#handleStatelessPayload",
                    },
                  );
                } else {
                  console.error(
                    "[App:handleStatelessPayload] Arkade recovery restore failed (non-blocking):",
                    msg,
                  );
                }
              }
            }
          }
          // For brand-new passkeys, persist the username-required sentinel
          // BEFORE the keys. The cold-launch path (`hasStoredKey("ethereum")`
          // above) signs the user in without re-checking LNURL, so if the
          // app is killed between key persistence and a successful claim,
          // the gate would otherwise be lost permanently. Order: sentinel
          // first → keys second → if isNew & lnurl already registered, clear
          // sentinel and sign in (multi-device restore brought it back).
          const willRequireUsernameClaim =
            payload.isNew === true && getArkadeLnurlStatusSnapshot()?.registered !== true;
          if (willRequireUsernameClaim) {
            await storeAuthData(USERNAME_CLAIM_REQUIRED_KEY, "1");
          }
          // Commit keys after the initial bootstrap/restore decision. If restore
          // only failed because the Bitcoin key was not in secure storage yet,
          // retry immediately after this commit point.
          // hasStoredKey("ethereum") is the cold-launch signal that this device
          // is fully bootstrapped — if anything above fails or returns early,
          // we leave secure storage untouched so the next attempt starts clean.
          await persistBootstrappedKeys(
            bootstrapResult.bitcoinPrivateKey,
            bootstrapResult.ethereumPrivateKey,
          );
          if (arkadeRestoreRetryAfterKeyPersist) {
            try {
              const { summary: restoreSummary, passkeyCredPubkeyB64u: restoredCredPubkey } =
                await restoreArkadeRecoveryBackup(new ArkadeRemoteIdentity(), payload.credIdB64u);
              arkadeRestoreFailed = false;
              console.log(
                "[App:handleStatelessPayload] Arkade recovery backup restored after key persist",
                {
                  items: restoreSummary.storageItemCount,
                  hardModeComplete: restoreSummary.hardModeComplete,
                  credPubkeyInBackup: restoredCredPubkey.length > 0,
                },
              );
              await backfillRestoredCredPubkey(restoredCredPubkey);
            } catch (restoreErr) {
              if (isArkadeRecoveryBackupNotFoundError(restoreErr)) {
                arkadeRestoreFailed = false;
                console.log(
                  "[App:handleStatelessPayload] No arkade recovery backup found after key persist, proceeding as fresh install",
                );
              } else {
                arkadeRestoreFailed = true;
                if (payload.credIdB64u) {
                  await setArkadeRestoreFailedMarker(payload.credIdB64u);
                }
                const msg = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
                console.error(
                  "[App:handleStatelessPayload] Arkade recovery restore retry failed (non-blocking):",
                  msg,
                );
              }
            }
          }
          // Mark local Arkade state as complete. For new wallets and 404
          // restores this records "state is what it should be (empty), the
          // SDK will populate from the operator on first wallet op." For
          // successful restores the sentinel was already set inside
          // restoreArkadeRecoveryBackup; this is idempotent.
          // Skip when a genuine (non-404) restore failed: leaving the sentinel
          // absent is what triggers the retry on the next sign-in.
          if (payload.credIdB64u && !arkadeRestoreFailed) {
            await setArkadeRestoreSentinel(payload.credIdB64u);
          }
          // #706: warm the wallet now ONLY for paths that sign in immediately
          // (existing logins, and new users whose handle is already registered).
          // For the username-gate path we deliberately skip it here and run a
          // single bootstrap AFTER the handle is claimed (handleUsernameClaimSubmit),
          // so the LNURL hydrate runs against the real claimed handle instead of an
          // empty pre-claim status that could resolve last and clobber it.
          if (!willRequireUsernameClaim) {
            void bootstrapBitcoinOnLogin().catch((e) => {
              console.error("[App:handleStatelessPayload] bootstrapBitcoinOnLogin failed:", e);
            });
          }
          setShowWelcome(false);
          // Only force the username picker for BRAND-NEW users (Create Wallet
          // flow). Existing-passkey logins — legacy users included — sign in
          // straight to the wallet; they can claim a Lightning handle later
          // (via a future settings UI) if they want one. The
          // earlier behaviour (gate on snapshot.registered) blocked every
          // legacy login because legacy snapshots are always unregistered.
          if (payload.isNew === true) {
            // Reuse the snapshot captured in `willRequireUsernameClaim` above:
            // for the immediate-sign-in path the bootstrapBitcoinOnLogin()
            // dispatched just above synchronously resets the LNURL cache before
            // its first await, so re-reading getArkadeLnurlStatusSnapshot() here
            // would see null and force an already-registered user into the
            // username-claim flow.
            if (!willRequireUsernameClaim) {
              setIsSignedInWithPRF(true);
            } else {
              console.log(
                "[App:handleStatelessPayload] new user — gating on UsernameOnboardingScreen",
              );
              setUsernameClaimError(null);
              setUsernameClaimRequired(true);
            }
          } else {
            setIsSignedInWithPRF(true);
          }
          return;
        } finally {
          if (bootstrapResult) {
            zeroize(bootstrapResult.bitcoinPrivateKey);
            zeroize(bootstrapResult.ethereumPrivateKey);
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[App:handleStatelessPayload] Stateless wallet bootstrap failed:", msg);
        handleError(msg || "Failed to bootstrap stateless wallet.");
        return;
      } finally {
        // Wipe the ORIGINAL PRF buffer on every path. It is the same Uint8Array
        // held in PasskeyLoginScreen's prfRef, which outlives this call (the
        // component stays mounted after sign-in), so leaving it un-zeroized keeps
        // wallet-derivation secrets resident. All consumers above take their own
        // copy (bootstrapWalletFromPrf, primeRecoveryBackupKeyFromPrf) and zero
        // those; the original is no longer needed once this handler returns.
        zeroize(payload.prf);
      }
    },
    [handleError, resetToWelcome],
  );

  const claimTargetedUsername = useCallback(
    async (
      username: string,
      bootstrapAssertion?: {
        token: string;
        clientDataB64u: string;
        authDataB64u: string;
        sigB64u: string;
      },
    ) => {
      if (bootstrapAssertion) {
        const identity = await getOrCreateArkadeIdentity();
        const [publicContext, evmAddress, btcAddress] = await Promise.all([
          identity.getSigningPublicContext(),
          getEthereumAddress(),
          getBitcoinAddress(),
        ]);
        const registration = await arkadeBootstrapClaimRegister(bootstrapAssertion, {
          username,
          client_signer_pubkey: publicContext.clientPk33,
          ...(evmAddress ? { evm_address: evmAddress } : {}),
          ...(btcAddress ? { btc_address: btcAddress } : {}),
        });
        cacheArkadeLnurlRegistration(registration);
      } else {
        const identity = await getOrCreateArkadeIdentity();
        const prepared = await identity.prepareLnurlRegisterPasskey();
        if (!prepared) throw new Error("username_claim_passkey_prepare_failed");
        const assertion = await getWalletPasskeyAssertion(prepared);
        if (assertion.credIdB64u !== prepared.credIdB64u) {
          throw new Error("username_claim_passkey_mismatch");
        }
        if (
          !identity.cacheLnurlRegisterAssertion({
            clientDataB64u: assertion.clientDataB64u,
            authDataB64u: assertion.authDataB64u,
            sigB64u: assertion.sigB64u,
          })
        ) {
          throw new Error("username_claim_passkey_cache_failed");
        }
        await claimArkadeLnurlUsername(username);
      }
      await deleteAuthData(USERNAME_CLAIM_REQUIRED_KEY);
      setUsernameClaimRequired(false);
      await authStateManager.setWalletUsername(username);
      setSignedInHandle(username);
      void bootstrapBitcoinOnLogin().catch((error) => {
        console.error("[App:claimTargetedUsername] bootstrapBitcoinOnLogin failed:", error);
      });
      setIsSignedInWithPRF(true);
    },
    [],
  );

  // Both of the sheet's confirmations — the first one the factory-reset link
  // asks for, and the retry out of the blocked state — run the full canonical
  // logout: wipe plus relaunch, rather than the in-place replacement whose
  // caller no longer has a wallet to commit.
  const handleTeardownConfirm = useCallback(async () => {
    setTeardownRetryBusy(true);
    const result = await requestUserLogout();
    // "started" has the relaunch scheduled and "in-flight" means another
    // teardown owns it; in both cases the app goes down, so staying busy is the
    // honest state. Only an abort re-arms the button — and seals the sheet into
    // the recovery state, which no cancel may leave.
    if (result === "blocked") {
      setTeardownRetryBusy(false);
      setTeardownBlocked(true);
    }
  }, []);

  // Cancel: no teardown ran, so the session is untouched and the sheet simply
  // closes. Mid-wipe or after an aborted one there is nothing intact to hand
  // back, and the sheet renders sealed anyway.
  const closeTeardownConfirm = useCallback(() => {
    if (teardownBlocked || teardownRetryBusy) return;
    setFactoryResetConfirmVisible(false);
  }, [teardownBlocked, teardownRetryBusy]);

  const handlePasskeyPayload = useCallback(
    async (payload: {
      prf: Uint8Array;
      isNew: boolean;
      credIdB64u?: string;
      credPubkeyB64u?: string;
      claimUsername?: string;
      claimAuth?: {
        token: string;
        clientDataB64u: string;
        authDataB64u: string;
        sigB64u: string;
      };
    }) => {
      const claimUsername = payload.claimUsername?.trim().toLowerCase() || "";
      const requestedUsername = targetedPasskeyUsername || claimUsername;
      if (!requestedUsername) {
        await handleStatelessPayload(payload);
        return;
      }

      const targetCredentialId = payload.credIdB64u?.trim() || "";
      const isTargetedClaim = claimUsername.length > 0;
      if (
        !targetCredentialId ||
        (isTargetedClaim &&
          (claimUsername !== requestedUsername || !payload.isNew || payload.prf.length === 0))
      ) {
        zeroize(payload.prf);
        handleError("Target passkey credential is incomplete.");
        return;
      }

      let switchedWallet = false;
      try {
        await authStateManager.initialize();
        const currentCredentialId =
          authStateManager.getState().walletPublicKeys?.walletPasskeyCredIdB64u;
        const hasWallet = Boolean(
          (await getEthereumAddress()) || (await hasCompletedWalletBootstrap()),
        );
        switchedWallet = shouldWipeForPasskeySwitch(
          currentCredentialId,
          targetCredentialId,
          hasWallet,
        );
        if (switchedWallet) {
          resetToWelcome(false);
          // Same destructive teardown as a logout, so it goes through the same
          // boundary: an abort here leaves a half-torn identity that must latch
          // the blocking recovery state instead of handing the flow back as a
          // retryable error, and nothing may commit the incoming wallet on top.
          const replacement = await requestWalletReplacement();
          if (replacement !== "replaced") {
            zeroize(payload.prf);
            if (replacement === "blocked") setTeardownBlocked(true);
            return;
          }
        }
      } catch (error) {
        zeroize(payload.prf);
        handleError(error instanceof Error ? error.message : String(error));
        return;
      }

      await handleStatelessPayload(payload);
      const committedCredentialId =
        authStateManager.getState().walletPublicKeys?.walletPasskeyCredIdB64u?.trim() || "";
      if (committedCredentialId !== targetCredentialId || !(await hasCompletedWalletBootstrap())) {
        return;
      }

      if (isTargetedClaim) {
        try {
          await claimTargetedUsername(claimUsername, payload.claimAuth);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[App:claimTargetedUsername] claim failed: ${message}`);
          setUsernameClaimError(`${t("screen.UsernameOnboarding.errorGeneric")}\n${message}`);
          // Wallet creation succeeded, but the username claim did not. Reveal
          // the existing picker rather than registering any unchecked name.
          setTargetedPasskeyUsername(null);
          return;
        }
      }

      clearPasskeyUsernameLocation();
      if (typeof window !== "undefined") {
        if (switchedWallet) {
          window.location.reload();
          return;
        }
      }
      await authStateManager.setWalletUsername(requestedUsername);
      setSignedInHandle(requestedUsername);
      setTargetedPasskeyUsername(null);
    },
    [
      claimTargetedUsername,
      handleError,
      handleStatelessPayload,
      resetToWelcome,
      targetedPasskeyUsername,
    ],
  );

  const handleUsernameClaimSubmit = useCallback(async (name: string) => {
    setUsernameClaimBusy(true);
    setUsernameClaimError(null);
    try {
      console.log(`[App:handleUsernameClaimSubmit] claiming username=${name}`);
      await claimArkadeLnurlUsername(name);
      console.log(`[App:handleUsernameClaimSubmit] claim ok username=${name}`);
      await authStateManager.setWalletUsername(name);
      setSignedInHandle(name);
      // Clear the username gate as soon as the REMOTE claim succeeds. The Wirex
      // account is NOT created here: it is created when the user enters their
      // email on the "Open Free Account" screen (that email is the account key),
      // so there is nothing to pin or pre-warm at claim time.
      await deleteAuthData(USERNAME_CLAIM_REQUIRED_KEY);
      setUsernameClaimRequired(false);
      // The picker can be reached from an interrupted `/@…` claim, and the name
      // just claimed need not be the one in that link. Leaving it in the address
      // bar would re-enter the targeted flow on the next refresh or PWA reopen.
      clearPasskeyUsernameLocation();
      // #706: this is the single post-login warm for the username-gate path. The
      // new-user/login flow (handleStatelessPayload) deliberately skips
      // bootstrapBitcoinOnLogin() when gating on the username picker, so this is
      // the ONLY hydrate for this path — and it runs now that the handle is
      // claimed and resolvable. Without it the BTC screen would spin until the
      // user opens Receive ("fake login"). Reusing the real-login bootstrap
      // (#668) rather than a bespoke hydrate means there is no empty pre-claim
      // status in flight that could resolve last and clobber the claimed handle.
      void bootstrapBitcoinOnLogin().catch((e) => {
        console.error("[App:handleUsernameClaimSubmit] bootstrapBitcoinOnLogin failed:", e);
      });
      setIsSignedInWithPRF(true);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[App:handleUsernameClaimSubmit] claim failed: ${msg}`);
      // Conflicts (HTTP 400 / 409 with "username already claimed" / "credential
      // already linked to a different username") surface as a friendly error so
      // the picker re-prompts; passkey + arkade keys are untouched and the user
      // stays gated until they pick another name.
      setUsernameClaimError(
        msg
          ? `${t("screen.UsernameOnboarding.errorGeneric")}\n${msg}`
          : t("screen.UsernameOnboarding.errorGeneric"),
      );
    } finally {
      setUsernameClaimBusy(false);
    }
  }, []);

  useEffect(() => {
    if (v1MigrationSupportPrompt !== "pending" || !isSignedInWithPRF) return;
    const timer = setTimeout(() => {
      setV1MigrationSupportPrompt("show");
      setShowNostrChat(true);
    }, IOS_MODAL_TRANSITION_DELAY_MS);
    return () => clearTimeout(timer);
  }, [isSignedInWithPRF, v1MigrationSupportPrompt]);

  // The figures the debug wealth-home preview renders. The home reads the same
  // snapshot itself, so nothing here feeds a production surface.

  if (!fontsLoaded || !currencyReady) {
    return null; // Show nothing while loading fonts / currency
  }

  return (
    <GestureHandlerRootView style={styles.gestureRoot}>
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        <DsOverlayRoot>
          {/* App-root floor: DS canvas. Only visible in gaps where no surface is
          mounted (cold launch, between screens) — every fullscreen surface,
          legacy included, paints its own background on top. */}
          <DsView chrome="canvas" direction="column" align="stretch" fill="grow-shrink">
            <StatusBar style="dark" translucent backgroundColor="transparent" />

            {/* One screen. Everything the three tabs used to own is reachable
              from here; the balances come from the headless drivers, so nothing
              has to stay mounted for a figure to stay fresh. */}
            <View style={styles.content}>
              {isSignedInWithPRF && !targetedPasskeyUsername ? (
                // Keyed by language: every string is read at render, so a
                // language picked in Settings re-renders the whole home in it.
                <UnifiedHomeScreen key={appLocale} signedInHandle={signedInHandle} />
              ) : null}
            </View>

            {/* Mounted exactly once, app-wide: a pending 3DS challenge blocks a
              real card payment, so it must not depend on which screen is open. */}
            {isSignedInWithPRF && !targetedPasskeyUsername ? <Wirex3dsApprovalHost /> : null}

            <PasskeyLoginScreen
              visible={showWelcome || Boolean(targetedPasskeyUsername)}
              targetedUsername={targetedPasskeyUsername}
              onPayloadReady={handlePasskeyPayload}
              onError={handleError}
              footerMessage={welcomeFooterMessage}
              resetSignal={welcomeResetSignal}
              autoOpenRestoreSignal={welcomeAutoOpenRestoreSignal}
              onAttemptStart={handleWelcomeAttemptStart}
            />

            {/* Username picker overlays the welcome flow (post-bootstrap, pre-sign-in).
            Restricted to !isSignedInWithPRF so cold-launch legacy users are never
            forced into the picker — they can use the legacy wallet unimpeded. */}
            {usernameClaimRequired && !isSignedInWithPRF && !targetedPasskeyUsername ? (
              <UsernameOnboardingScreen
                onSubmit={handleUsernameClaimSubmit}
                busy={usernameClaimBusy}
                externalError={usernameClaimError}
              />
            ) : null}
          </DsView>

          {/* Mounted at the app root, above every flow: the factory-reset link
            can arrive over any screen, and once a teardown has aborted there is
            no screen underneath that may be handed back either. */}
          <LogoutConfirmSheet
            visible={teardownBlocked || factoryResetConfirmVisible}
            blocked={teardownBlocked}
            busy={teardownRetryBusy}
            onClose={closeTeardownConfirm}
            onConfirm={() => void handleTeardownConfirm()}
          />

          <SupportModals
            showNostrChat={showNostrChat}
            onCloseNostrChat={handleCloseNostrChat}
            autoSendMessage={supportAutoMessage}
            prefillMessage={supportPrefillMessage}
            keypairOverride={supportKeypairOverride}
            showV1MigrationLink={v1MigrationSupportPrompt === "show"}
            onCreatePasskey={(result) => {
              handleCloseNostrChat();
              setV1MigrationSupportPrompt("pending");
              // A chat-created passkey is always brand-new → the username gate is
              // certain. Show it immediately instead of flashing the Welcome
              // screen while the async bootstrap below runs; the error path
              // (resetToWelcome) clears the gate again.
              setShowWelcome(false);
              setUsernameClaimError(null);
              setUsernameClaimRequired(true);
              void handleStatelessPayload({
                prf: result.prf,
                isNew: true,
                credIdB64u: result.credIdB64u,
                credPubkeyB64u: result.credPubkeyB64u,
              });
            }}
          />

          {DEBUG_UI_ENABLED && DebugModal ? (
            <DebugModal
              visible={debugHubVisible}
              onClose={handleCloseDebugHub}
              onRunAction={handleRunDebugAction}
            />
          ) : null}
          {DEBUG_UI_ENABLED && DebugDsReviewModal ? (
            <DebugDsReviewModal
              visible={showDsReviewModal}
              onClose={() => setShowDsReviewModal(false)}
            />
          ) : null}

          {DEBUG_UI_ENABLED && DebugNotificationsModal ? (
            <DebugNotificationsModal
              visible={showNotificationsModal}
              onClose={() => setShowNotificationsModal(false)}
            />
          ) : null}

          {DEBUG_UI_ENABLED && DebugArkadeModal ? (
            <DebugArkadeModal
              visible={debugScreen === "debugArkadeModal"}
              onClose={closeDebugScreen}
            />
          ) : null}

          {DEBUG_UI_ENABLED && DebugEoaKeyExportModal ? (
            <DebugEoaKeyExportModal
              visible={debugScreen === "eoaKeyExport"}
              onClose={closeDebugScreen}
            />
          ) : null}

          {DEBUG_UI_ENABLED && DebugSatoraRefundModal ? (
            <DebugSatoraRefundModal
              visible={debugScreen === "satoraCollabRefund"}
              onClose={closeDebugScreen}
            />
          ) : null}

          {DEBUG_UI_ENABLED && DebugWirexWithdrawModal ? (
            <DebugWirexWithdrawModal
              visible={debugScreen === "wirexWithdrawDebug"}
              onClose={closeDebugScreen}
            />
          ) : null}

          {DEBUG_UI_ENABLED && DebugWirexSignUpModal ? (
            <DebugWirexSignUpModal
              visible={debugScreen === "wirexFullDebug"}
              onClose={closeDebugScreen}
              walletAddress={debugWalletAddress}
            />
          ) : null}

          {DEBUG_UI_ENABLED && DebugBankTxDumpModal ? (
            <DebugBankTxDumpModal
              visible={debugScreen === "dumpBankTransactions"}
              onClose={closeDebugScreen}
              walletAddress={debugWalletAddress}
            />
          ) : null}

          {v1WalletMigrationIdentity ? (
            <V1WalletMigrationScreen
              visible={showV1WalletMigrationScreen}
              onClose={() => setShowV1WalletMigrationScreen(false)}
              bitcoinBoardingAddress={v1WalletMigrationIdentity.bitcoinBoardingAddress}
              eoaAddress={v1WalletMigrationIdentity.eoaAddress}
              nostrNpub={v1WalletMigrationIdentity.nostrNpub}
              username={v1WalletMigrationIdentity.username}
              oldCredentialId={v1WalletMigrationIdentity.oldCredentialId}
            />
          ) : null}

          <SupportDumpModal
            visible={supportDumpVisible}
            onClose={() => setSupportDumpVisible(false)}
            supportPubkey={SUPPORT_PUBKEY}
            appSnapshot={{
              ethereumAddress,
              bitcoinAddress,
            }}
          />

          <PleaseUpdateAppModal
            visible={updateModalVisible}
            storeUrl={IOS_APP_STORE_URL}
            description={
              updateModalVersion
                ? t("modal.PleaseUpdateAppModal.updateRequiredDescription", {
                    version: updateModalVersion,
                  })
                : undefined
            }
          />

          {/* Claim screen for an incoming Arkade Lightning payment. Rendered at
          app root so it presents over whatever the user has open. */}
          <PaymentReceivedModal
            visible={showArkadeUnlockWallet && isSignedInWithPRF && !biometricLockVisible}
            state={unlockState}
            onUnlock={runUnlock}
            onClose={closeArkadeUnlockWallet}
          />

          {/* Global passkey ceremony host: satisfies the WebAuthn user-activation
          requirement for WebAuthnPrfService by presenting an in-WebView confirm
          button. Inert until a "webauthn:prfRequest" is emitted. */}
          <WebAuthnPrfOverlay />

          {/* BiometricLockModal registers its overlay layer when it becomes
          visible, stacking above anything open at that moment. Screen-level
          modals are dismissed via resetMainScreensUi() before it is shown. */}
          <BiometricLockModal visible={biometricLockVisible} />

          {/* Desktop browsers get a "scan to open on your phone" block over the
          whole app — Nuri is a mobile wallet. Touch devices are never gated.
          A touch device held in landscape gets a "rotate to portrait" block
          instead (iOS ignores the manifest's portrait lock). */}
          {isDesktopWeb ? <DesktopGate /> : isMobileLandscape ? <LandscapeGate /> : null}
        </DsOverlayRoot>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

// True on desktop browsers (fine pointer + hover), so Nuri — a mobile wallet —
// can show a "scan to open on your phone" gate there instead of the phone-width
// app. Touch devices (phones, tablets) are never gated. Web-only.
function useIsDesktopWeb() {
  const query = "(hover: hover) and (pointer: fine)";
  const [isDesktop, setIsDesktop] = useState(
    () =>
      Platform.OS === "web" &&
      typeof window !== "undefined" &&
      Boolean(window.matchMedia?.(query).matches),
  );
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(query);
    const onChange = () => setIsDesktop(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return isDesktop;
}

// True when the DEVICE is held in landscape, for the rotate-to-portrait gate.
// Deliberately not a window width/height comparison: Android Chrome shrinks the
// layout viewport when the soft keyboard opens, so a portrait phone measures
// wider than tall and the gate would cover the screen the moment a field is
// focused. `screen.orientation` (and `screen.width/height`) ignore the keyboard.
// Web-only.
function readWebLandscape(): boolean {
  if (Platform.OS !== "web" || typeof window === "undefined") return false;
  const screen = window.screen;
  const type = screen?.orientation?.type;
  if (typeof type === "string") return type.startsWith("landscape");
  // Safari < 16.4 has no screen.orientation — the screen's own dimensions are
  // the next keyboard-independent signal, and only then the window's.
  if (screen?.width && screen?.height) return screen.width > screen.height;
  return window.innerWidth > window.innerHeight;
}

function useIsWebLandscape() {
  const [isLandscape, setIsLandscape] = useState(readWebLandscape);
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const onChange = () => setIsLandscape(readWebLandscape());
    // `change` covers modern browsers; `orientationchange`/`resize` are the
    // fallbacks (and catch the rotation that screen.width/height reflect).
    window.screen?.orientation?.addEventListener?.("change", onChange);
    window.addEventListener("orientationchange", onChange);
    window.addEventListener("resize", onChange);
    return () => {
      window.screen?.orientation?.removeEventListener?.("change", onChange);
      window.removeEventListener("orientationchange", onChange);
      window.removeEventListener("resize", onChange);
    };
  }, []);
  return isLandscape;
}

const styles = StyleSheet.create({
  gestureRoot: {
    flex: 1,
  },
  content: {
    flex: 1,
  },
});
