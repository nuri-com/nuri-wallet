import { SwapKitOrderStore } from "../swapkit/SwapKitOrderStore";
import { MoneyInFlightStore } from "../money/MoneyInFlightStore";
import { SwapKitV2OrderStore } from "../swapkit/SwapKitV2OrderStore";
import {
  clearV2ArkadeReservations,
  clearV2MoveAccounting,
} from "../swapkit/SwapKitV2MoveAccounting";
import { clearV2Moves } from "../swapkit/SwapKitV2MoveStatus";
import { stopAllSwapKitV2Tracking } from "../swapkit/SwapKitV2PendingTracker";
import * as Updates from "expo-updates";
import { authStateManager } from "../auth/AuthStateService";
import {
  getEthereumAddress,
  storeAuthData,
  verifyCriticalKeysAbsent,
  wipeAllKeychainData,
} from "../../lib/secureKeyStorage";
import { pendingWithdrawKeyFor } from "../../lib/wirex/pendingWithdrawKey";
import { accountEmailKeyFor } from "../../lib/accountEmail";
import { arkadeServerConfigService } from "../arkade/ArkadeServerConfigService";
import { deleteCacheKeys } from "../balance/TransactionCacheService";
import { clearAllContexts } from "../bitcoin/SigningContextStore";
import { PendingPurchasesStore } from "./PendingPurchasesStore";
import { MercuryoOrderStore } from "../mercuryo/MercuryoOrderStore";
import { stopAllMercuryoTracking } from "../mercuryo/MercuryoPendingTracker";
import { WIPE_EXTRA_STORAGE_KEYS } from "./wipeStorageKeys";
import {
  clearPushNotificationStorage,
  unregisterPushDevice,
} from "../notifications/NotificationRegistrationService";

// Set just before Updates.reloadAsync(). App.tsx reads this on next launch and
// bumps welcomeAutoOpenRestoreSignal so PasskeyLoginScreen auto-opens the
// "Continue with @<name>" modal using the preserved credId hint.
export const SOFT_LOGOUT_RELAUNCH_SENTINEL_KEY = "@auth:soft_logout_relaunch";

// Persistent marker — stamped by App.tsx (handleStatelessPayload) whenever this
// build persists an eth key, i.e. on every successful onboarding/sign-in. The
// one-time Wirex-cutover gate (App.init) force-logs-out any install that has an
// eth key but lacks this marker — i.e. only genuine pre-Wirex accounts, never an
// account onboarded under this build. Cleared by factory reset.
export const WIREX_FORCED_RELOGIN_DONE_KEY = "@auth:wirex_forced_relogin_done_v1";

// SQLite cache keys that are NOT keyed by address — preserving them across a
// logout would leak old wallet data into the new login (old preferred address,
// old IBAN, old NEAR swaps, etc.). Address-keyed entries (btc:{addr},
// monerium:{a}|{b}, card:{safe}, safe:{eoa}, IBAN-by-address, NEAR-by-deposit,
// price-by-ts, tx-status by txid) survive — naturally orphaned by the new
// wallet's different addresses, so tx history shown after relogin is for the
// new addresses only and old rows sit unreachable. `migration:pending:v1` is
// wiped here as legacy cleanup (the migration stack has been removed).
const LEAKY_FIXED_CACHE_KEYS = [
  "monerium:preferred-address",
  "gnosis:iban:details",
  "gnosis:user:profile",
  "gnosis:safe:address",
  "bitcoin:pending-sends:v1",
  "migration:pending:v1",
];

/**
 * "Soft logout that actually works" — wipes auth, 3rd-party sessions, in-memory
 * state, private keys, balance caches, leaky SQLite rows, then reloads the app
 * so singleton services die. The caller passes an explicit `preserveHint` for
 * the credId (and optionally credPubkey + nameBase) to re-stash AFTER the
 * wipe; omitting it yields a clean welcome screen with no Continue modal
 * default. Address-keyed tx history survives by design.
 */
export const performSoftLogoutForRelogin = async (opts?: {
  preserveHint?: {
    credIdB64u: string;
    credPubkeyB64u?: string;
    walletPasskeyNameBase?: string;
  };
  // Durable post-wipe cleanup the caller needs finalized BEFORE the app
  // reloads (e.g. committing wallet_mode, clearing signer context / pending
  // migration). Awaited here so reload never races a fixed timer against
  // unbounded storage writes.
  afterWipe?: () => Promise<void>;
}): Promise<void> => {
  console.log("[SoftLogout] Starting soft logout for relogin", {
    preserveHint: !!opts?.preserveHint?.credIdB64u,
  });

  // The account email lives under a wallet-scoped Internet Credentials key
  // (@wirex:onboard_email:<wallet>) the static wipe list can't name. Capture the
  // wallet before clearing auth/keys so we can delete that dynamic entry too.
  let walletForEmailWipe: string | null = null;
  try {
    walletForEmailWipe = await getEthereumAddress();
  } catch {}

  // This PR's swap loops run in the background; stop them so none carries
  // into the next session. Immediate, nothing waits.
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

  try {
    // Before any wipe: the server must be told to forget this device while the
    // current subscription is still known. Local clearing alone would leave the
    // previous wallet's subscription pointing at a push token that still works.
    try {
      await unregisterPushDevice();
    } catch (e) {
      console.warn("[SoftLogout] unregisterPushDevice failed:", e);
    }

    await authStateManager.clearAllData();
  } catch (e) {
    console.warn("[SoftLogout] clearAllData failed:", e);
  }

  try {
    await wipeAllKeychainData(extraKeychainServers);
  } catch (e) {
    console.warn("[SoftLogout] wipeAllKeychainData failed:", e);
    // continue — we still run the verification gate below before relaunch
  }

  // `@auth:previous_addresses` is not covered by clearAllData. Leaving an entry
  // an older install wrote is only sound when the SAME user comes back — which
  // is exactly what a preserveHint states. Without a hint this wipe ends on a
  // neutral welcome screen where any passkey may sign in, so the list has to go
  // or it carries the previous account's identity into the next one (#671).
  //
  // Its failure is collected, not swallowed: it feeds the gate below, because
  // an identity-bearing survivor is the same class of leak as a residual key.
  let previousAddressesResidual = false;
  if (!opts?.preserveHint?.credIdB64u) {
    try {
      await authStateManager.clearPreviousAddresses();
    } catch (e) {
      console.error("[SoftLogout] clearPreviousAddresses failed:", e);
      previousAddressesResidual = true;
    }
  }

  // Hard security gate: refuse to relaunch unless the outgoing ETH/BTC/auth
  // keys are actually gone. wipeAllKeychainData uses Promise.allSettled and
  // swallows per-key failures, and the catch above swallows whole-call
  // failures, so without this check a partial wipe would silently take the
  // user into a fresh-login UX with the old key material still in keychain.
  // Their removal is the invariant that justifies advancing AuthState to the
  // new credId.
  const residual = await verifyCriticalKeysAbsent();
  if (previousAddressesResidual) residual.push("previous_addresses");
  if (residual.length > 0) {
    console.error("[SoftLogout] Critical keychain entries still present after wipe", residual);
    throw new Error(
      `Soft logout aborted: critical keychain entries remain (${residual.join(", ")}). Not relaunching.`,
    );
  }

  try {
    await deleteCacheKeys(LEAKY_FIXED_CACHE_KEYS);
  } catch (e) {
    console.warn("[SoftLogout] deleteCacheKeys failed:", e);
  }

  // AsyncStorage is untouched by wipeAllKeychainData — persisted pending
  // purchases must be cleared explicitly or they rehydrate after relogin.
  try {
    await MoneyInFlightStore.clear();
  } catch (e) {
    console.warn("[SoftLogout] MoneyInFlightStore.clear failed:", e);
  }
  try {
    await PendingPurchasesStore.clear();
  } catch (e) {
    console.warn("[SoftLogout] PendingPurchasesStore.clear failed:", e);
  }

  // Same store family: an un-settled Mercuryo order left behind would resume
  // polling under the next wallet and file its purchase against that account.
  try {
    stopAllMercuryoTracking();
    await MercuryoOrderStore.clear();
  } catch (e) {
    console.warn("[SoftLogout] MercuryoOrderStore.clear failed:", e);
  }

  // Same reason: the push subscription, device registration and binding caches
  // live in AsyncStorage. Left behind, the next wallet inherits this device's
  // subscription and keeps receiving the previous wallet's notifications.
  try {
    await clearPushNotificationStorage();
  } catch (e) {
    console.warn("[SoftLogout] clearPushNotificationStorage failed:", e);
  }

  // In-flight swap orders are keyed to the previous account's settle target;
  // resuming them after a relogin would swap into a wallet that is no longer
  // signed in. Both the v1 and the v2 order stores must be cleared.
  try {
    await SwapKitOrderStore.clear();
  } catch (e) {
    console.warn("[SoftLogout] SwapKitOrderStore.clear failed:", e);
  }
  try {
    await SwapKitV2OrderStore.clear();
  } catch (e) {
    console.warn("[SoftLogout] SwapKitV2OrderStore.clear failed:", e);
  }
  // The status pill speaks for the previous account's moves; clearing the
  // orders without it would leave a pill pointing at a detail sheet that can
  // no longer resolve its order.
  try {
    clearV2Moves();
    clearV2MoveAccounting();
  } catch {}
  // The Arkade sats those orders reserved belong to the same account. The
  // ledger is persisted AND loaded in memory; left behind, the next wallet
  // restores it as its own hold and loses that much spendable balance.
  try {
    await clearV2ArkadeReservations();
  } catch (e) {
    console.warn("[SoftLogout] clearV2ArkadeReservations failed:", e);
  }

  try {
    clearAllContexts();
  } catch {}

  try {
    arkadeServerConfigService.reset();
  } catch {}

  // Re-stash the hint AFTER all wipes so it survives. The caller decides what
  // (if anything) to preserve — passing no preserveHint yields a clean welcome
  // screen with no Continue modal default, which is what the stale-legacy
  // banner needs to avoid silently defaulting back to the legacy credId.
  if (opts?.preserveHint?.credIdB64u) {
    try {
      await authStateManager.setLoginHintAfterWipe(opts.preserveHint);
    } catch (e) {
      console.warn("[SoftLogout] setLoginHintAfterWipe failed:", e);
    }
  }

  try {
    await storeAuthData(SOFT_LOGOUT_RELAUNCH_SENTINEL_KEY, "1");
  } catch (e) {
    console.warn("[SoftLogout] sentinel write failed:", e);
  }

  if (opts?.afterWipe) {
    try {
      await opts.afterWipe();
    } catch (e) {
      console.warn("[SoftLogout] afterWipe cleanup failed:", e);
    }
  }

  console.log("[SoftLogout] Wipe complete; scheduling app reload");
  setTimeout(async () => {
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
