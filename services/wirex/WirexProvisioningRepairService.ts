// services/wirex/WirexProvisioningRepairService.ts
// Self-healing for accounts that are entitled to a Wirex product but never got
// it (#1090). Onboarding provisions the card and the SEPA account exactly once,
// during signup; a user whose KYC was still pending at that moment — or whose
// country only became SEPA-eligible later — has nothing re-run for them, and no
// server-side hook fires when the capability finally flips to Active. So the app
// checks on launch and re-runs provisioning itself.
//
// The re-trigger is a status read WITH the account email: that is the only call
// that re-runs the server's onboarding/provisioning path. Without the email the
// same call is a read-only sync and issues nothing.
//
// SECURITY: never logs the email, IBAN, card data or the wallet address.
import { getEthereumAddress } from "../../lib/secureKeyStorage";
import { LOG_EMOJI, logWithId, warnWithId } from "../../lib/OperationLogUtils";
import {
  decideProvisioningRepair,
  type ProvisioningRepairDecision,
} from "../../lib/wirex/provisioningRepair";
import { isProvisioningAttemptSettling } from "../../lib/wirex/provisioningAttemptMarker";
import { EventBus } from "../events/AppEventBusService";
import {
  wirexAccountService,
  WIREX_VERIFICATION_APPROVED_EVENT,
  type WirexCardSnapshot,
} from "./WirexAccountService";
import { wirexService } from "./WirexService";

// Wirex provisions asynchronously: create_virtual_card returns 200 with the card
// id while the card list is still empty, so the products appear a few seconds
// after the re-trigger returns. Polled with the read-only status call, never by
// firing the re-trigger again — a second re-trigger inside that gap mints a
// SECOND card.
const POST_TRIGGER_POLL_INTERVAL_MS = 3000;
const POST_TRIGGER_POLL_MAX_ATTEMPTS = 5;

export type WirexProvisioningRepairStatus =
  | "already_ran"
  | "aborted"
  | "no_wallet"
  | "no_account"
  | "not_due"
  | "cooling_down"
  | "no_email"
  | "failed"
  | "triggered";

export interface WirexProvisioningRepairOutcome {
  status: WirexProvisioningRepairStatus;
  cardDue: boolean;
  ibanDue: boolean;
}

// Once per launch. Latched before the first await so two callers (or a re-render
// that re-fires the trigger) can never both reach the re-trigger. A launch whose
// check failed retries on the next launch — the condition it repairs is days
// old, so nothing is gained by retrying within the same session.
let ranThisLaunch = false;
let runInFlight: Promise<WirexProvisioningRepairOutcome> | null = null;
// Bumped by reset() on sign-out. A run cannot be cancelled mid-await, so every
// stage re-checks this before acting: the account it was started for is gone,
// and the singleton Wirex service and account snapshot now belong to whoever
// signed in next. Without it a run started by account A could re-trigger
// provisioning against B's session, or refresh A's data into B's snapshot.
let generation = 0;

const log = (message: string, data: Record<string, unknown>, level: "info" | "warn" = "info") => {
  const logger = level === "warn" ? warnWithId : logWithId;
  logger(`${LOG_EMOJI.card} WirexProvisioningRepair`, message, data, {
    context: "system",
    event: "STATE",
    scope: "WirexProvisioningRepair",
    action: "repair",
    source: "services/wirex/WirexProvisioningRepairService.ts#runWirexProvisioningRepair",
  });
};

const outcome = (
  status: WirexProvisioningRepairStatus,
  decision?: ProvisioningRepairDecision,
): WirexProvisioningRepairOutcome => ({
  status,
  cardDue: decision?.cardDue ?? false,
  ibanDue: decision?.ibanDue ?? false,
});

const isRepaired = (
  snapshot: WirexCardSnapshot | null,
  decision: ProvisioningRepairDecision,
): boolean => {
  if (!snapshot) return false;
  if (decision.cardDue && !snapshot.card?.id) return false;
  if (decision.ibanDue && !snapshot.iban?.iban) return false;
  return true;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Re-provision whatever the account is entitled to and does not have.
 *
 * Call once per launch, and on native only AFTER the wallet keys are unlocked:
 * every read here is read-session gated, and minting that session signs with the
 * on-device EOA — from a warm key cache that is silent, from a cold one it would
 * raise Face ID for a background check the user never asked for.
 */
export async function runWirexProvisioningRepair(): Promise<WirexProvisioningRepairOutcome> {
  if (runInFlight) return runInFlight;
  if (ranThisLaunch) return outcome("already_ran");
  ranThisLaunch = true;
  const myGeneration = generation;
  // True once the account this run belongs to is gone (sign-out / relogin). Its
  // reads and — above all — its re-trigger would then land on someone else's
  // session, so every stage stops here rather than "finishing" the work.
  const abandoned = (): boolean => generation !== myGeneration;

  const run = (async (): Promise<WirexProvisioningRepairOutcome> => {
    let wallet: string | null = null;
    try {
      wallet = await getEthereumAddress();
    } catch {
      wallet = null;
    }
    if (abandoned()) return outcome("aborted");
    if (!wallet) return outcome("no_wallet");
    const account = wallet;

    let decision: ProvisioningRepairDecision;
    let email: string | null;
    let country: string | null;
    try {
      // The authoritative per-rail state. /status's own summary.capabilities is
      // empty until late in the flow, so it cannot answer "is this rail Active"
      // for exactly the accounts this repair exists for. The same response
      // carries the account's email and residence country.
      const user = await wirexService.getUser(account);
      if (abandoned()) return outcome("aborted");
      // What the account actually holds, through the service that already owns
      // the closed-card and bank-account selection rules. `false` keeps the 60s
      // status cache — a read seconds old answers this just as well.
      wirexAccountService.ensureStarted();
      const snapshot = await wirexAccountService.silentRefresh(false);
      if (abandoned()) return outcome("aborted");
      if (!snapshot) return outcome("no_account");

      decision = decideProvisioningRepair({
        capabilities: user.capabilities,
        // The route reports the card rail in a dedicated field too, and the live
        // response can carry it there while the list is still empty.
        visaVirtualCard: user.visaVirtualCard,
        hasUsableCard: Boolean(snapshot.card?.id),
        hasIban: Boolean(snapshot.iban?.iban),
        allCardsClosed: snapshot.allCardsClosed,
      });
      email = user.email;
      country = user.country;
    } catch (e) {
      log(
        `repair check failed: ${e instanceof Error ? e.message : "unknown"}`,
        { result: "error" },
        "warn",
      );
      return outcome("failed");
    }

    if (!decision.due) {
      log("nothing to repair", { card_due: false, iban_due: false });
      return outcome("not_due", decision);
    }

    // A recent provisioning attempt explains the very state that just read as
    // "due": the products have not landed yet. Firing again here is what mints a
    // second card, so read instead and let the next launch decide. Covers
    // onboarding's attempt as well as this repair's own — both are recorded by
    // WirexService, so a launch during signup's issuance is caught too.
    const settling = await isProvisioningAttemptSettling(account);
    if (abandoned()) return outcome("aborted");
    if (settling) {
      log("re-trigger suppressed: an attempt is still settling", {
        card_due: decision.cardDue,
        iban_due: decision.ibanDue,
      });
      await pollForProvisioning(decision, abandoned);
      return outcome("cooling_down", decision);
    }

    // A device that did not run signup has no pinned email (the Keychain is per
    // bundle id), which is why the user read is the primary source.
    let emailSource = email ? "user_route" : "none";
    if (!email) {
      email = await wirexService.getOnboardEmail(account).catch((): null => null);
      if (abandoned()) return outcome("aborted");
      if (email) emailSource = "pinned";
    }
    if (!email) {
      // Without it the status call is read-only and would provision nothing —
      // firing it anyway would just look like a repair that silently did nothing.
      log(
        "cannot repair: no account email",
        { card_due: decision.cardDue, iban_due: decision.ibanDue, email_source: emailSource },
        "warn",
      );
      return outcome("no_email", decision);
    }

    log("re-triggering provisioning", {
      card_due: decision.cardDue,
      iban_due: decision.ibanDue,
      email_source: emailSource,
      has_country: Boolean(country),
    });

    try {
      // THE re-trigger, exactly once — and recorded on the durable marker by
      // getStatus itself, before the request goes out. `country` decides which
      // rails the server provisions, so it is passed through from the account's
      // own residence address and omitted when unknown — never defaulted, which
      // would provision against the wrong country. `abortIf` covers the session
      // retry inside the request: a sign-out mid-flight must not let this email
      // be resent under the next account's freshly minted session.
      await wirexService.getStatus({
        wallet: account,
        email,
        ...(country ? { country } : {}),
        abortIf: abandoned,
      });
    } catch (e) {
      // Refusing to send because the account went away is the guard working, not
      // a failure — and the next account's own launch check is what runs next.
      if (abandoned()) return outcome("aborted", decision);
      log(
        `re-trigger failed: ${e instanceof Error ? e.message : "unknown"}`,
        { result: "error", card_due: decision.cardDue, iban_due: decision.ibanDue },
        "warn",
      );
      return outcome("failed", decision);
    }
    if (abandoned()) return outcome("aborted");

    await pollForProvisioning(decision, abandoned);
    return outcome("triggered", decision);
  })().finally(() => {
    if (runInFlight === run) runInFlight = null;
  });

  runInFlight = run;
  return run;
}

/**
 * Wirex has accepted the request but the products land asynchronously; read
 * (never re-trigger) until they show up so the screens pick them up without a
 * manual pull. Giving up is not a failure — the next status read the app makes
 * will carry them.
 */
async function pollForProvisioning(
  decision: ProvisioningRepairDecision,
  abandoned: () => boolean,
): Promise<void> {
  for (let attempt = 1; attempt <= POST_TRIGGER_POLL_MAX_ATTEMPTS; attempt += 1) {
    await sleep(POST_TRIGGER_POLL_INTERVAL_MS);
    // Sign-out during the poll: refreshing now would pull the previous account's
    // card and IBAN into the snapshot the next user is already looking at.
    if (abandoned()) return;
    const snapshot = await wirexAccountService
      .silentRefresh(true)
      .catch((): WirexCardSnapshot | null => null);
    if (abandoned()) return;
    if (isRepaired(snapshot, decision)) {
      log("provisioning landed", {
        attempt,
        card_due: decision.cardDue,
        iban_due: decision.ibanDue,
      });
      return;
    }
  }
  log("provisioning still pending", {
    attempts: POST_TRIGGER_POLL_MAX_ATTEMPTS,
    card_due: decision.cardDue,
    iban_due: decision.ibanDue,
  });
}

/**
 * Wire up the repair for this launch: the launch check itself, plus the KYC
 * transition that is the OTHER moment a card and an IBAN become due — approval
 * lands with the app already open, provisioning was skipped during signup, and
 * nothing server-side re-runs it. The launch latch is released for that one
 * event, so the check runs again with the account's new state; the durable
 * attempt marker still decides whether anything may be provisioned.
 *
 * Idempotent — the listener is registered once per process.
 */
export function initWirexProvisioningRepair(): void {
  if (!approvalUnsub) {
    approvalUnsub = EventBus.on(WIREX_VERIFICATION_APPROVED_EVENT, () => {
      ranThisLaunch = false;
      void runWirexProvisioningRepair();
    });
  }
  void runWirexProvisioningRepair();
}

let approvalUnsub: (() => void) | null = null;

/**
 * Sign-out / relogin to a different wallet: the latch belongs to the account
 * that was signed in, so the next one gets its own launch check. Bumping the
 * generation also strands any run still in flight — it cannot be cancelled
 * mid-await, so it stops at its next stage instead of acting on the new session.
 */
export function resetWirexProvisioningRepair(): void {
  generation += 1;
  ranThisLaunch = false;
  runInFlight = null;
}
