import {
  abandonInFlightWalletUnlock,
  clearPrivateKeyMemoryCache,
  isBiometricPromptDismissal,
  unlockWalletKeys,
} from "../../lib/secureKeyStorage";
import { logWithId } from "../../lib/OperationLogUtils";
import { errDescription } from "../../lib/errorMessage";
import { reportErrorToSupport } from "../../lib/support/reportErrorToSupport";
import { recoverWalletKeysFromPasskey } from "./WalletKeyRecoveryService";
import type { WalletKeyRecoveryOutcome } from "./WalletKeyRecoveryService";

/**
 * The lock screen's unlock orchestration, kept out of the component so it can
 * be tested and so the two ways in — the automatic attempt on presentation and
 * the user's tap — cannot fight each other.
 *
 * The failure this exists to prevent: the screen used to set a busy flag, await
 * a native protected read with no deadline, and disable its only button while
 * that promise was outstanding. An Android provider that returned no UI and
 * never settled therefore consumed the manual retry permanently — a tap on
 * "Access wallet" did nothing, showed nothing, and no further ceremony could
 * start, because `unlockWalletKeys` also hands a pending read to every later
 * caller. Every attempt here is finite, at most one runs at a time, a timed-out
 * attempt releases the shared read so the next tap really re-asks the provider,
 * and a late completion from an abandoned attempt can no longer describe the
 * screen.
 */
export type WalletAccessSource = "auto" | "button";

/** Sanitized, log-safe description of where an attempt ended. */
export type WalletAccessPhase =
  | "combined_read"
  | "passkey_recovery"
  | "timeout"
  | "cancel"
  | "provider_error";

export type WalletAccessResult =
  /** Keys are in the session cache and the unlock signal has fired. */
  | { status: "unlocked" }
  /** The user dismissed the prompt, or the sensor locked out. Nothing broke. */
  | { status: "cancelled" }
  /** No outcome inside the deadline — provider showed no UI or never returned. */
  | { status: "timeout" }
  /** The stored entry cannot be read; rebuilding it needs a deliberate tap. */
  | { status: "recovery_required" }
  /** The ceremony produced a different wallet. Nothing was written. */
  | { status: "wrong_wallet" }
  /** Recovery itself was unavailable or failed. Support has been notified. */
  | { status: "failed" }
  /** A ceremony was already running; this request did nothing. */
  | { status: "in_flight" };

/**
 * A presented system prompt is normally answered well inside this window, so
 * the deadline is not a race against the user — it is the bound on a provider
 * that never presented anything at all.
 */
export const WALLET_ACCESS_TIMEOUT_MS = 30_000;

export type WalletAccessDeps = {
  unlockWalletKeys: () => Promise<unknown>;
  recoverWalletKeysFromPasskey: () => Promise<WalletKeyRecoveryOutcome>;
  isBiometricPromptDismissal: (error: unknown) => boolean;
  abandonInFlightWalletUnlock: () => void;
  clearPrivateKeyMemoryCache: () => void;
  reportErrorToSupport: (opts: { error: unknown; userMessage?: string }) => Promise<unknown>;
  log: (message: string, data?: Record<string, unknown>) => void;
  timeoutMs: number;
};

const defaultDeps: WalletAccessDeps = {
  unlockWalletKeys,
  recoverWalletKeysFromPasskey,
  isBiometricPromptDismissal,
  abandonInFlightWalletUnlock,
  clearPrivateKeyMemoryCache,
  reportErrorToSupport,
  log: (message, data) => logWithId("🔐 WalletAccess", message, data),
  timeoutMs: WALLET_ACCESS_TIMEOUT_MS,
};

// Class and bounded code only, from the one helper that decides what a caught
// value may say in a log. The phase says where it broke; that is what a report
// needs. See `errDescription`.
const describeError = errDescription;

const TIMED_OUT = Symbol("timed-out");

/**
 * Resolve with the promise's outcome, or with TIMED_OUT once the deadline
 * passes. The losing promise is not cancellable — native ceremonies have no
 * abort — so it is silenced rather than left to surface as an unhandled
 * rejection long after this attempt stopped speaking for the screen.
 */
async function raceDeadline<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A second handler on the same promise: the race below still sees the
  // rejection while it is live, and a rejection arriving after the deadline
  // has one taker instead of surfacing as an unhandled rejection.
  void promise.catch(() => {});
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class WalletAccessController {
  private readonly deps: WalletAccessDeps;
  private inFlight = false;
  // Set when an automatic attempt found the combined entry unreadable and asked
  // for a tap. That verdict does not expire between the two: repeating the read
  // on the tap would raise a device-auth prompt that is already known to fail,
  // and then the passkey ceremony behind it — two prompts from one tap, which is
  // the duplicate this screen must not produce. The error is kept with it
  // because it is what a support report is about.
  private recoveryRequired: { reason: unknown } | null = null;

  constructor(deps: Partial<WalletAccessDeps> = {}) {
    this.deps = { ...defaultDeps, ...deps };
  }

  isBusy(): boolean {
    return this.inFlight;
  }

  /**
   * Run one wallet-access ceremony. Never throws: every path the screen has to
   * react to is a status, because the screen's job after any of them is the
   * same — say what happened and stay tappable.
   */
  async requestAccess(source: WalletAccessSource): Promise<WalletAccessResult> {
    if (this.inFlight) {
      this.deps.log("access request ignored, ceremony already running", { source });
      return { status: "in_flight" };
    }
    this.inFlight = true;
    this.deps.log("wallet access requested", { source });
    this.deps.clearPrivateKeyMemoryCache();
    try {
      return await this.runAttempt(source);
    } finally {
      this.inFlight = false;
    }
  }

  private async runAttempt(source: WalletAccessSource): Promise<WalletAccessResult> {
    // A tap that follows a `recovery_required` verdict goes straight to the
    // passkey: the read it would otherwise repeat is already known to fail.
    const deferred = source === "button" ? this.recoveryRequired : null;
    let readError: unknown = deferred?.reason;

    if (!deferred) {
      // The combined entry is the wallet-access gate: one read seeds the
      // Bitcoin, EVM and Nostr session cache and emits the unlock signal.
      // Separate protected reads are forbidden because they can produce several
      // prompts.
      let read: unknown = null;
      try {
        read = await raceDeadline(this.deps.unlockWalletKeys(), this.deps.timeoutMs);
      } catch (error: unknown) {
        readError = error;
      }
      if (read === TIMED_OUT) return this.onTimeout("combined_read");
      if (read) {
        this.recoveryRequired = null;
        this.deps.log("wallet access succeeded", { source, phase: "combined_read" });
        return { status: "unlocked" };
      }

      // A failed read is not evidence that the keys are gone, and nothing below
      // deletes anything: a cancelled prompt or a sensor lockout leaves the
      // entry intact, so the retry button is the whole correct response.
      if (this.deps.isBiometricPromptDismissal(readError)) {
        this.deps.log("wallet access dismissed", { source, phase: "cancel" });
        return { status: "cancelled" };
      }
      this.deps.log("combined read failed", {
        source,
        phase: "provider_error",
        ...describeError(readError),
      });

      // Every other error means this read cannot succeed however often it is
      // repeated, so the entry has to be rebuilt from the passkey. That ceremony
      // is started only from a real tap: Android gates provider UI on user
      // activation, and an automatic second ceremony is exactly the duplicate
      // startup prompt this screen must not produce.
      if (source === "auto") {
        this.recoveryRequired = { reason: readError };
        return { status: "recovery_required" };
      }
    }

    let recovery: WalletKeyRecoveryOutcome | typeof TIMED_OUT;
    try {
      recovery = await raceDeadline(this.deps.recoverWalletKeysFromPasskey(), this.deps.timeoutMs);
    } catch (error: unknown) {
      this.deps.log("passkey recovery threw", {
        source,
        phase: "passkey_recovery",
        ...describeError(error),
      });
      recovery = "unavailable";
    }
    if (recovery === TIMED_OUT) return this.onTimeout("passkey_recovery");
    // "recovered" already opened the session and emitted the unlock signal,
    // which dismisses this screen.
    if (recovery === "recovered") {
      this.recoveryRequired = null;
      this.deps.log("wallet access succeeded", { source, phase: "passkey_recovery" });
      return { status: "unlocked" };
    }
    this.deps.log("passkey recovery did not restore access", {
      source,
      phase: "passkey_recovery",
      outcome: recovery,
    });
    // The wrong passkey, no passkey, or a failed ceremony is the end of what
    // the app can do alone, so hand the user to support with the diagnostics
    // attached instead of leaving them on a button that can only fail again.
    void this.deps
      .reportErrorToSupport({
        error: readError,
        userMessage:
          recovery === "wrong_wallet"
            ? "Wallet unlock failed — the passkey belongs to a different wallet"
            : "Wallet unlock failed — passkey recovery unavailable",
      })
      .catch(() => {});
    return recovery === "wrong_wallet" ? { status: "wrong_wallet" } : { status: "failed" };
  }

  private onTimeout(phase: WalletAccessPhase): WalletAccessResult {
    // The read is still parked inside the shared in-flight slot, where it would
    // be handed to the retry instead of a fresh ceremony. Drop it so the next
    // tap actually re-asks the provider.
    this.deps.abandonInFlightWalletUnlock();
    this.deps.log("wallet access timed out", { phase: "timeout", startedIn: phase });
    return { status: "timeout" };
  }
}

/** The lock screen is a singleton surface, so one controller serves it. */
export const walletAccessController = new WalletAccessController();
