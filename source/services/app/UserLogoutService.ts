// The user-triggered teardown boundary — the ONLY place the production UI may
// destroy local identity from, whether that is a logout (home → Account → Log
// out / switch passkey) or a `/@username` link replacing the wallet in place.
//
// It IS a factory reset, not a session toggle: keys, auth, caches, orders, push
// registration and every local store go, and the app relaunches on the welcome
// screen with nothing pointing at the old account. A softer teardown would keep
// device state that the next passkey then inherits.
//
// Two things live here rather than in the sheet:
//   - Exactly-once. The reset wipes keychain entries and then reloads the app on
//     a timer; a second concurrent run would race that reload. The button's own
//     disabled state is not a guarantee (the sheet can be remounted), so the
//     guard is module-level.
//   - Honest failure. A throw does NOT mean "nothing happened" — auth state is
//     cleared and the keychain wipe was attempted by then, so the device is half
//     torn down with old key material possibly still in place. It is a blocking
//     state whose only way out is a retry that succeeds.
import { performFactoryReset, wipeLocalWalletData } from "./FactoryResetService";

export type UserLogoutResult =
  // Wipe completed; the app reload is already scheduled. The caller keeps its
  // busy state until the process goes down.
  | "started"
  // A teardown was already running — the caller must not start another.
  | "in-flight"
  // The teardown aborted PART-WAY: auth state is cleared and the keychain wipe
  // was attempted, but something identity-bearing survived, so the app was not
  // relaunched. The local identity is neither intact nor gone. The caller must
  // hold the user in a blocking recovery state — retry allowed, returning to
  // the app is not — until a retry reaches "started".
  | "blocked";

let inFlight = false;
// Latched by the first aborted teardown and never cleared: nothing in this
// process may treat the app as a normal signed-in session afterwards, however
// many times the user retries.
let teardownAborted = false;

export const requestUserLogout = async (): Promise<UserLogoutResult> => {
  if (inFlight) return "in-flight";
  inFlight = true;

  try {
    await performFactoryReset();
    // Deliberately NOT clearing `inFlight`: the wipe succeeded and a reload is
    // pending, so any further attempt in this process would run against
    // half-torn-down state.
    return "started";
  } catch (e) {
    console.error("[UserLogout] Factory reset aborted part-way; identity is not intact:", e);
    teardownAborted = true;
    // The guard reopens ONLY so a retry can run — a retry is the single way out
    // of the blocked state. It does not mean the app is usable again.
    inFlight = false;
    return "blocked";
  }
};

export type WalletReplacementResult =
  // The local wallet is gone and nothing else owns the teardown: the caller may
  // commit the incoming wallet.
  | "replaced"
  // A teardown was already running — the caller must not start another, and must
  // not commit anything on top of it.
  | "in-flight"
  // Same half-torn-down device as the logout "blocked" above: either this wipe
  // aborted, or an earlier teardown already latched the process. The caller must
  // NOT commit the incoming wallet and must hold the user in the blocking
  // recovery state.
  | "blocked";

/**
 * The teardown in front of a `/@username` passkey switch: same destructive wipe
 * as a logout, minus the relaunch, because the caller commits the incoming
 * wallet in this same process.
 *
 * It shares this module's guards on purpose. Exactly-once keeps a second wipe
 * from landing on the wallet the caller just committed, and an abort here leaves
 * the identical half-torn-down device a failed logout leaves — so it latches the
 * same flag every surface reads, not a private one that only this flow knows.
 *
 * Unlike the logout it also REFUSES once that flag is latched. A logout retry is
 * the way out of a half-torn device; committing a fresh wallet on top of one is
 * not, and the refusal has to live here: a queued or duplicate passkey payload
 * reaches this boundary whatever the UI is currently showing.
 */
export const requestWalletReplacement = async (): Promise<WalletReplacementResult> => {
  if (teardownAborted) return "blocked";
  if (inFlight) return "in-flight";
  inFlight = true;

  try {
    await wipeLocalWalletData();
    // Cleared, unlike the logout above: no reload is pending here, and the wipe
    // ran to completion, so the next targeted link may legitimately wipe again.
    inFlight = false;
    return "replaced";
  } catch (e) {
    console.error("[UserLogout] Wallet replacement aborted part-way; identity is not intact:", e);
    teardownAborted = true;
    inFlight = false;
    return "blocked";
  }
};

/**
 * True once a teardown has aborted part-way in this process. The UI reads this
 * to keep its recovery state up across re-renders and remounts: a sheet that
 * simply held the failure in component state would let the user back into the
 * app by remounting it.
 */
export const hasAbortedTeardown = (): boolean => teardownAborted;

// Test seam only — both flags are process-wide by design.
export const __resetUserLogoutGuardForTests = (): void => {
  inFlight = false;
  teardownAborted = false;
};
