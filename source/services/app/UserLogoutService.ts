// The user-triggered teardown boundary: the ONLY place the production UI may
// destroy local identity from, whether that is a logout (Settings → Log out,
// support → switch passkey) or a `/@username` link replacing the wallet in place.
//
// It IS a factory reset, not a session toggle: keys, auth, caches, orders, push
// registration and every local store go, and the app relaunches on the welcome
// screen. A wipe that could not be verified is finished on the next launch,
// before anything can open the old wallet (FactoryResetService).
//
// Exactly-once lives here rather than in a button: the reset reloads the app on
// a timer, and a second concurrent run would race that reload.
import { performFactoryReset, wipeLocalWalletData } from "./FactoryResetService";

export type UserLogoutResult =
  // The wipe ran and the app reload is scheduled. The caller keeps its busy
  // state until the process goes down.
  | "started"
  // A teardown was already running; the caller must not start another.
  | "in-flight"
  // Nothing was relaunched: the wipe could not be verified nor recorded for the
  // next launch to finish. The user is still signed in and can press again.
  | "failed";

let inFlight = false;

export const requestUserLogout = async (): Promise<UserLogoutResult> => {
  if (inFlight) return "in-flight";
  inFlight = true;
  try {
    await performFactoryReset();
  } catch (e) {
    console.error("[UserLogout] Logout did not complete:", e);
    inFlight = false;
    return "failed";
  }
  // Not cleared: the reload is pending, so nothing else may run in this process.
  return "started";
};

export type WalletReplacementResult =
  // The local wallet is gone: the caller may commit the incoming wallet.
  | "replaced"
  // A teardown was already running; the caller must not commit anything on top.
  | "in-flight"
  // The wipe did not complete, so the incoming wallet must not be committed on
  // top of the old one. The device logs out instead (full reset and relaunch).
  | "failed";

/**
 * The teardown in front of a `/@username` passkey switch: same wipe as a
 * logout, minus the relaunch, because the caller commits the incoming wallet in
 * this same process. Shares the exactly-once guard so a second wipe cannot land
 * on the wallet the caller just committed.
 */
export const requestWalletReplacement = async (): Promise<WalletReplacementResult> => {
  if (inFlight) return "in-flight";
  inFlight = true;
  try {
    await wipeLocalWalletData();
    inFlight = false;
    return "replaced";
  } catch (e) {
    console.error("[UserLogout] Wallet replacement wipe failed; logging out instead:", e);
    await performFactoryReset().catch(() => {});
    return "failed";
  }
};

// Test seam only: the guard is process-wide by design.
export const __resetUserLogoutGuardForTests = (): void => {
  inFlight = false;
};
