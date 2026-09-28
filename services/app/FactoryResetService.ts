import { SwapKitOrderStore } from "../swapkit/SwapKitOrderStore";
import { MoneyInFlightStore } from "../money/MoneyInFlightStore";
import { SwapKitV2OrderStore } from "../swapkit/SwapKitV2OrderStore";
import { clearV2MoveAccounting } from "../swapkit/SwapKitV2MoveAccounting";
import { clearV2Moves } from "../swapkit/SwapKitV2MoveStatus";
import {
  resumeSwapKitV2TrackingIntake,
  stopAllSwapKitV2Tracking,
} from "../swapkit/SwapKitV2PendingTracker";
import * as Updates from "expo-updates";
import { authStateManager } from "../auth/AuthStateService";
import {
  getEthereumAddress,
  verifyCriticalKeysAbsent,
  wipeAllKeychainData,
} from "../../lib/secureKeyStorage";
import { pendingWithdrawKeyFor } from "../../lib/wirex/pendingWithdrawKey";
import { accountEmailKeyFor } from "../../lib/accountEmail";
import { arkadeServerConfigService } from "../arkade/ArkadeServerConfigService";
import { deleteCacheDatabase } from "../balance/TransactionCacheService";
import { clearAllContexts } from "../bitcoin/SigningContextStore";
import { clearAllArkadeLocalStorage } from "../arkade/ArkadeRecoveryBackupService";
import { PendingPurchasesStore } from "./PendingPurchasesStore";
import { MercuryoOrderStore } from "../mercuryo/MercuryoOrderStore";
import { stopAllMercuryoTracking } from "../mercuryo/MercuryoPendingTracker";
import { WIPE_EXTRA_STORAGE_KEYS } from "./wipeStorageKeys";
import {
  clearPushNotificationStorage,
  unregisterPushDevice,
} from "../notifications/NotificationRegistrationService";

type Options = {
  onClose?: () => void;
};

export const wipeLocalWalletData = async ({ onClose }: Options = {}) => {
  // Canonical "nuke everything" primitive: clear all local wallet/auth/config
  // state with no exceptions. Callers decide when to reload.
  console.log("[FactoryReset] Starting full local reset (auth + keys + config)");

  // The account email is stored under a wallet-scoped Internet Credentials key
  // (@wirex:onboard_email:<wallet>) that the static wipe list can't name. Capture
  // the wallet BEFORE clearing auth/keys so we can delete that dynamic entry too,
  // otherwise the PII survives this "nuke everything" reset.
  let walletForEmailWipe: string | null = null;
  try {
    walletForEmailWipe = await getEthereumAddress();
  } catch {}

  // Stop this PR's background swap loops so none carries into the next
  // session. Immediate, nothing waits.
  stopAllSwapKitV2Tracking();
  const extraKeychainServers = walletForEmailWipe
    ? [
        ...WIPE_EXTRA_STORAGE_KEYS,
        accountEmailKeyFor(walletForEmailWipe),
        // Same class of dynamic entry: a withdrawal marker left behind blocks
        // every future withdrawal, and survived a full reset because no static
        // list could name it.
        pendingWithdrawKeyFor(walletForEmailWipe),
      ]
    : WIPE_EXTRA_STORAGE_KEYS;

  // Clear persisted auth/wallet data plus any transient server overrides.
  // Before any wipe: the server must be told to forget this device while the
  // current subscription is still known. Local clearing alone would leave the
  // previous wallet's subscription pointing at a push token that still works.
  try {
    await unregisterPushDevice();
  } catch (e) {
    console.warn("[FactoryReset] unregisterPushDevice failed:", e);
  }

  await authStateManager.clearAllData();
  try {
    await wipeAllKeychainData(extraKeychainServers);
  } catch {}
  // Before deleteCacheDatabase: SwapKitOrderStore lives in that database, and
  // its clear() writes an empty array — recreating the file if the delete ran
  // first. Clearing here also empties the singleton's in-memory mirror, which
  // the delete alone would leave populated until the reload.
  try {
    await SwapKitOrderStore.clear();
  } catch (e) {
    console.warn("[FactoryReset] SwapKitOrderStore.clear failed:", e);
  }
  // Same reason for the v2 store: it lives in the same database, and its
  // in-memory mirror would otherwise survive an in-process wallet replacement
  // and be resumed under the new wallet.
  try {
    await SwapKitV2OrderStore.clear();
  } catch (e) {
    console.warn("[FactoryReset] SwapKitV2OrderStore.clear failed:", e);
  }
  try {
    clearV2Moves();
    clearV2MoveAccounting();
  } catch {}
  try {
    await deleteCacheDatabase();
  } catch {}
  // AsyncStorage is untouched by wipeAllKeychainData — persisted pending
  // purchases must be cleared explicitly or they survive the reset.
  try {
    await MoneyInFlightStore.clear();
  } catch (e) {
    console.warn("[FactoryReset] MoneyInFlightStore.clear failed:", e);
  }
  try {
    await PendingPurchasesStore.clear();
  } catch (e) {
    console.warn("[FactoryReset] PendingPurchasesStore.clear failed:", e);
  }

  // Same store family: an un-settled Mercuryo order left behind would resume
  // polling under the next wallet and file its purchase against that account.
  try {
    stopAllMercuryoTracking();
    await MercuryoOrderStore.clear();
  } catch (e) {
    console.warn("[FactoryReset] MercuryoOrderStore.clear failed:", e);
  }

  // Same reason: the push subscription, device registration and binding caches
  // live in AsyncStorage. Left behind, the next wallet inherits this device's
  // subscription and keeps receiving the previous wallet's notifications.
  try {
    await clearPushNotificationStorage();
  } catch (e) {
    console.warn("[FactoryReset] clearPushNotificationStorage failed:", e);
  }
  // Arkade SDK state, restore sentinels, and lazy-backfill flags live in
  // AsyncStorage under the nuri:arkade: root and would otherwise survive a
  // reset, leaking prior wallet/receive/restore state into the next session.
  try {
    await clearAllArkadeLocalStorage();
  } catch (e) {
    console.warn("[FactoryReset] clearAllArkadeLocalStorage failed:", e);
  }
  // `@auth:previous_addresses` is not covered by clearAllData. A factory reset
  // ends on a neutral welcome screen where ANY passkey may sign in, so an entry
  // an older install left behind has to go or it carries this account's
  // identity into the next one (#671). Its failure is collected, not swallowed:
  // an identity-bearing survivor is the same class of leak as a residual key.
  let previousAddressesResidual = false;
  try {
    await authStateManager.clearPreviousAddresses();
  } catch (e) {
    console.error("[FactoryReset] clearPreviousAddresses failed:", e);
    previousAddressesResidual = true;
  }

  // Hard gate, and the reason this function can throw at all: wipeAllKeychainData
  // swallows per-key failures and the catch above swallows whole-call failures,
  // so without a read-back a partial wipe would relaunch into a fresh-login
  // screen with the old key material still in the keychain — and the next
  // passkey would inherit it. Nothing below this line runs unless the device is
  // genuinely empty; the caller holds the user in recovery instead.
  const residual = await verifyCriticalKeysAbsent();
  if (previousAddressesResidual) residual.push("previous_addresses");
  if (residual.length > 0) {
    console.error("[FactoryReset] Critical entries still present after wipe", residual);
    throw new Error(
      `Factory reset aborted: critical keychain entries remain (${residual.join(", ")}). Not relaunching.`,
    );
  }
  try {
    clearAllContexts();
  } catch {}
  try {
    arkadeServerConfigService.reset();
  } catch {}

  // The in-process `/@username` replacement commits its new wallet right
  // after this returns and must be able to track its own orders.
  resumeSwapKitV2TrackingIntake();

  try {
    onClose?.();
  } catch {}

  console.log("[FactoryReset] Completed local reset");
};

const scheduleAppReload = () => {
  console.log("[FactoryReset] Scheduling app reload");
  setTimeout(async () => {
    if (typeof window !== "undefined" && window.location) {
      window.location.reload();
      return;
    }
    try {
      if (Updates?.reloadAsync) {
        await Updates.reloadAsync();
        return;
      }
    } catch {}
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DevSettings } = require("react-native");
      if (DevSettings?.reload) DevSettings.reload();
    } catch {}
  }, 300);
};

export const performFactoryReset = async (options: Options = {}) => {
  await wipeLocalWalletData(options);
  scheduleAppReload();
};
