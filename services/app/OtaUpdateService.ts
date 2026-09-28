// Getting a published OTA onto a running device.
//
// expo-updates checks and downloads ON_LOAD and then applies the new bundle on
// the NEXT launch (app.config.ts `checkAutomatically` / `fallbackToCacheTimeout`
// — both deliberate: a wallet must not block its own launch on a network call).
// The consequence is that a user who never fully closes the app never gets the
// update: the bundle sits downloaded and waits for a cold start that does not
// come. Support sees this as "I updated and nothing changed", or worse, as the
// forced-update screen looping because its only action opens the App Store,
// where there is nothing newer to install.
//
// So the JS side does the two things the config cannot express: check again
// when the app is brought back to the foreground, and apply what is already
// downloaded as soon as nothing is at risk (services/app/OtaUpdateAutoApply.ts —
// a restart is silently wrong in the middle of a send, a swap or a passkey
// prompt, and unnecessary at any other moment).

import * as Updates from "expo-updates";
import { LOG_EMOJI, logWithId } from "../../lib/OperationLogUtils";

const SOURCE = "services/app/OtaUpdateService.ts";

export function logOtaUpdate(message: string, data?: Record<string, unknown>): void {
  try {
    logWithId(`${LOG_EMOJI.app} OtaUpdate`, message, data, {
      context: "background",
      event: "STATE",
      source: SOURCE,
    });
  } catch {}
}

// expo-updates exposes `isUpdatePending` only through its React hook, and this
// has to be readable from plain code as well. The native state machine emits it
// on every transition, so mirror it here: the listener catches the download the
// automatic launch-time check performs, and fetchPendingUpdate() sets it for the
// ones we ask for ourselves.
//
// Seeded from the state machine's current context, not from false: a launch-time
// download can finish before this module loads, and its transition event is then
// already gone. Starting at false read that bundle as "nothing pending" until
// some later foreground happened to ask again.
let updatePending = readLatestPending();

// Told the moment a bundle becomes pending, so the auto-apply can act on a
// download that finishes while the app is already up instead of waiting for the
// next foreground.
const pendingListeners = new Set<() => void>();

function readLatestPending(): boolean {
  try {
    return Updates.isEnabled === true && Updates.latestContext?.isUpdatePending === true;
  } catch {
    return false;
  }
}

function notifyPending(): void {
  for (const listener of pendingListeners) {
    try {
      listener();
    } catch {}
  }
}

if (Updates.isEnabled === true) {
  try {
    Updates.addUpdatesStateChangeListener((event) => {
      const wasPending = updatePending;
      updatePending = event.context.isUpdatePending === true;
      if (updatePending && !wasPending) notifyPending();
    });
  } catch {}
}

/** Fires when a downloaded bundle becomes pending. Returns the unsubscribe. */
export function onUpdatePending(listener: () => void): () => void {
  pendingListeners.add(listener);
  return () => {
    pendingListeners.delete(listener);
  };
}

/** True when a downloaded bundle is waiting for a reload to take effect. */
export function isUpdatePending(): boolean {
  return Updates.isEnabled === true && updatePending;
}

/**
 * Ask the server whether a newer bundle exists and download it. Returns true
 * once one is ready to be applied — including when a previous check already
 * downloaded it, so callers can treat this as "is there something to apply?".
 *
 * Safe to call often: it is a no-op in dev (`isEnabled` false) and the checks
 * are cheap compared to the download, which only runs when there is one.
 */
export async function fetchPendingUpdate(): Promise<boolean> {
  if (Updates.isEnabled !== true) return false;
  if (isUpdatePending()) return true;
  try {
    const check = await Updates.checkForUpdateAsync();
    if (!check.isAvailable) return false;
    logOtaUpdate("update available — downloading");
    const fetched = await Updates.fetchUpdateAsync();
    if (!fetched.isNew) return false;
    updatePending = true;
    logOtaUpdate("update downloaded — waiting for reload");
    return true;
  } catch (error) {
    // Offline, server unreachable, rollout not for this runtime version: none
    // of it is actionable, and none of it should surface to the user.
    logOtaUpdate("update check failed", {
      err: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Apply the downloaded bundle. Restarts the app; nothing after this runs. */
export async function applyPendingUpdate(): Promise<void> {
  logOtaUpdate("applying update — reloading");
  await Updates.reloadAsync();
}
