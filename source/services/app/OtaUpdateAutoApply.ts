// Applying a downloaded OTA bundle without waiting for a cold start.
//
// expo-updates downloads a new bundle on the launch-time check and applies it on
// the NEXT launch, so a user who never fully closes the app stays on the old
// build indefinitely — support sees it as "I updated and nothing changed".
// OtaUpdateService already checks again in the foreground and knows whether a
// bundle is sitting there; this module is what APPLIES it: as soon as the app is
// in the foreground with nothing at risk, it reloads into the new version and
// the user never has to kill the app.
//
// Three rules about when that may happen, all because reloadAsync() is a full
// restart and everything in memory goes with it:
//   - never mid-action: an open sheet or cover means the user is inside a send,
//     a swap or a top-up, and a restart there restarts into a half-finished flow;
//   - never during the wallet-access ceremony — the passkey or biometric prompt
//     is exactly the dialog a restart must not land inside;
//   - no timer and nothing to agree to: the attempt is tied to the foreground
//     (entering it, and the app already being up), never to a cadence, and the
//     user is not asked to confirm what the app can decide for itself.
// When it is not safe, the bundle simply stays downloaded; the next foreground
// is the next attempt.
//
// Every real module this needs is injected (see OtaUpdateAutoApplyBridge): the
// ones that own the wallet and the update both reach React Native sources
// vitest cannot transform, and keeping them out of here is what lets the rules
// below be proven without a device.

/** The state of the app at the moment a bundle is ready to be applied. */
export type OtaAutoApplyGates = {
  /** A restart is the user's restart: never pull the app out from under it. */
  appForeground: boolean;
  /** A sheet or cover is up — the user is mid-flow. */
  openSurface: boolean;
  /** A passkey/biometric ceremony is running. */
  walletAccessBusy: boolean;
};

export function isSafeToApplyUpdate(gates: OtaAutoApplyGates): boolean {
  return gates.appForeground && !gates.openSurface && !gates.walletAccessBusy;
}

export type OtaAutoApplyDeps = {
  isAppForeground: () => boolean;
  hasOpenSurface: () => boolean;
  isWalletAccessBusy: () => boolean;
  isUpdatePending: () => boolean;
  fetchPendingUpdate: () => Promise<boolean>;
  applyPendingUpdate: () => Promise<void>;
  /** Fires when the app comes back to the foreground. Returns the unsubscribe. */
  onAppForegroundEnter: (listener: () => void) => () => void;
  /** Fires when a downloaded bundle becomes pending. Returns the unsubscribe. */
  onUpdatePending: (listener: () => void) => () => void;
  /** Fires whenever the number of open sheets/covers changes. Returns the unsubscribe. */
  onOpenSurfacesChange: (listener: (open: number) => void) => () => void;
  log: (message: string, data?: Record<string, unknown>) => void;
};

/**
 * Watch for a downloaded bundle and apply it the first moment the app is idle.
 *
 * Returns the unsubscribe. Call once, from the app root: the first attempt runs
 * immediately (the app is up and the launch-time check may already have
 * downloaded something). Every later foreground, every download that completes
 * while the app is up, and every close of the last open surface while a bundle
 * waits is another attempt.
 */
export function startOtaUpdateAutoApply(deps: OtaAutoApplyDeps): () => void {
  let stopped = false;
  // One reload at a time: a second apply while the first is in flight would ask
  // expo-updates to restart a process that is already going down.
  let applying = false;

  const evaluate = async (): Promise<void> => {
    if (stopped || applying) return;

    let ready = deps.isUpdatePending();
    if (!ready) ready = await deps.fetchPendingUpdate();
    if (!ready || stopped || applying) return;

    const gates: OtaAutoApplyGates = {
      appForeground: deps.isAppForeground(),
      openSurface: deps.hasOpenSurface(),
      walletAccessBusy: deps.isWalletAccessBusy(),
    };
    if (!isSafeToApplyUpdate(gates)) {
      // Worth a line in the support log: this is the state where a user keeps
      // running a build that was already replaced.
      deps.log("update ready, waiting for an idle moment", gates);
      return;
    }

    applying = true;
    try {
      await deps.applyPendingUpdate();
    } catch (error) {
      // An apply that failed is not fatal and must not be retried in a loop:
      // the bundle stays downloaded and the next foreground tries again.
      applying = false;
      deps.log("applying update failed", {
        err: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // Three moments can make an apply possible, and each is an attempt: the app
  // comes to the foreground; a bundle finishes downloading while the app is up;
  // and the surface that deferred an earlier attempt closes. The last two only
  // retry what the gates already allow: nothing here loosens them.
  const unsubscribeForeground = deps.onAppForegroundEnter(() => {
    void evaluate();
  });
  const unsubscribePending = deps.onUpdatePending(() => {
    void evaluate();
  });
  const unsubscribeSurfaces = deps.onOpenSurfacesChange((open) => {
    if (open === 0 && deps.isUpdatePending()) void evaluate();
  });
  void evaluate();

  return () => {
    stopped = true;
    unsubscribeForeground();
    unsubscribePending();
    unsubscribeSurfaces();
  };
}
