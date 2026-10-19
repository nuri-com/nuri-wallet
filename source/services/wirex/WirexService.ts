// services/wirex/WirexService.ts
//
// Wirex Phase-1 onboarding service. Drives the nuri-wirex-mcp REST API
// (`wirexConfig.restBaseUrl`) end-to-end and injects the app's existing
// on-device biometric EOA signer for the passkey-bridge approvals. Screens
// only call these methods — all REST, polling, and signing logic lives here.
//
// The backend owns ALL account-abstraction (bundler/paymaster/RPC). This
// service never talks to a bundler; it only does REST + inject-signer.

import { privateKeyToAccount } from "viem/accounts";

import type { ActivityItem } from "../../components/ActivitySheet";
import { ACCOUNT_EMAIL_KEY as WIREX_EMAIL_KEY } from "../../lib/accountEmail";
import { bytesToHex, zeroize } from "../../lib/crypto";
import { errorWithId, LOG_EMOJI, logWithId } from "../../lib/OperationLogUtils";
import { pendingWithdrawKeyFor } from "../../lib/wirex/pendingWithdrawKey";
import { WIREX_WITHDRAW_UNCONFIRMED_ERROR_NAME } from "../../lib/wirex/withdrawRollback";
import {
  isPendingWithdrawMarkerExpired,
  parsePendingWithdrawMarker,
  stampUndatedMarker,
} from "../../lib/wirex/pendingWithdrawMarker";
import { shortAddress } from "../../lib/wirex/debugHelpers";
import { readAccountIdentity } from "../../lib/wirex/provisioningRepair";
import { markProvisioningAttempt } from "../../lib/wirex/provisioningAttemptMarker";
import type {
  WirexActivityItem,
  WirexCardTransactionsResponse,
} from "../../lib/wirex/cardTransactions";
import {
  mapWirexBankActivity,
  mapWirexCardTransactions,
  type WirexBankCounterparty,
} from "../../lib/wirex/cardTransactions";
import { fetchWirexDeposits } from "../../lib/wirex/wirexDeposits";
import { homeCurrencyService } from "../../lib/currency/HomeCurrencyService";
import { mergeWirexActivity } from "../../lib/wirex/mergeWirexActivity";
import { fxRateService } from "../pricing/FxRateService";
import {
  deleteAuthData,
  getAuthData,
  getEthereumAddress,
  getPrivateKey,
  storeAuthData,
} from "../../lib/secureKeyStorage";
import { submitSignedApproval } from "../../lib/wirex/bridgeCallback";
import {
  assertWirexVirtualCardNames,
  isWirexCardLast4,
  buildWirex3dsResponseMessage,
  buildWirexCardActionMessage,
  buildWirexIssueVirtualCardMessage,
  buildWirexCardTransferMessage,
  buildWirexSepaTransferMessage,
} from "../../lib/wirex/cardActionMessage";
import { verifyRegisterCallData } from "../../lib/wirex/registerVerification";
import { isAccountBlocked, type WirexBankEligibility } from "../../lib/wirex/accountBlocked";
import { authStateManager } from "../auth/AuthStateService";
import { EventBus } from "../events/AppEventBusService";
import { classifyLinklessOnboardResult } from "./WirexOnboardingOutcome";
import { wirexConfig } from "./wirexConfig";

// The signer contract that `submitSignedApproval` injects into. Mirrors the
// (unexported) `SignFn` in lib/wirex/bridgeCallback.ts.
type SignFn = (payload: {
  message: string | Uint8Array;
}) => Promise<{ address: string; signature: string; publicKey?: string }>;

// ── REST envelope ──────────────────────────────────────────────────────
// Every REST response is wrapped: { ok, data, error }.
interface RestEnvelope<T> {
  ok: boolean;
  data: T | null;
  error: string | null;
}

// ── Tool output shapes we consume (from nuri-wirex-mcp mcp-tools.mjs) ──
interface OnboardStartData {
  session_id: string;
  approval_url: string;
  result_url?: string;
  email?: string;
  country?: string;
}

interface WirexBankAccount {
  id: string | null;
  type: string | null;
  status: string | null;
  iban: string | null;
  bic: string | null;
}

export interface WirexCard {
  id: string | null;
  status: string | null;
  last4: string | null;
}

// ── Signed card mutation response (freeze / unfreeze / set-limit / close) ──
// The envelope can be ok:true while the inner payload carries the Wirex-side
// outcome, so `ok`/`error` here are the per-action result, not the transport's.
interface CardActionData {
  ok?: boolean | null;
  card_id?: string | null;
  action?: string | null;
  result?: unknown;
  error?: unknown;
}

// ── Issue virtual card shape (POST /card/virtual) ─────────────────────
// `card` is the freshly issued card in the same shape /status lists it under
// `cards[]`; the server may omit it, so only `card_id` is relied on.
// `reconciled: true` means the previous attempt's response was lost and the
// server returned the card that already existed — nothing new was created.
interface CardIssueVirtualData {
  card_id?: string | null;
  card?: WirexCard | null;
  reconciled?: boolean | null;
}

// Per-rail capability from the onboarding summary (e.g. VisaVirtualCard,
// SepaAccount) with its Wirex-defined status. Surfaced so a stuck "Applied"
// (cards=0/banks=0) can be diagnosed straight off the prod /status response —
// the exact per-item fields are Wirex-defined, so this stays permissive. Rail
// metadata only, no PII.
interface WirexCapability {
  type?: string | null;
  status?: string | null;
  [key: string]: unknown;
}

// Account-number fields masked when the raw /status payload is logged for
// diagnostics — never log a full IBAN/BIC/PAN (security invariant). Everything
// else in the response is field metadata safe to surface.
const RAW_STATUS_LOG_REDACT_KEYS = new Set([
  // Sumsub links embed the live session/applicant token — a pending user's
  // buffered logs travel into support dumps, so never let one through. The
  // native SDK token (kycSdkToken and its aliases) is the same live secret.
  "kyc_url",
  "kycSdkToken",
  "kyc_sdk_token",
  "sdkToken",
  "iban",
  "bic",
  "last4",
  "pan",
  "card_number",
  "card_number_last_4",
]);

// Union of every field the poll endpoints can return. All optional because a
// single response only carries the subset for its branch (pending / register /
// done).
interface OnboardResultData {
  ok?: boolean;
  status?: string;
  // Done branch (onboardingDone):
  wallet?: string;
  credential_id?: string | null;
  kyc_url?: string | null;
  kycSdkToken?: string | null; // Sumsub in-app SDK token; non-null while KYC pending
  verification_status?: string | null;
  bank_accounts?: WirexBankAccount[];
  cards?: WirexCard[];
  capabilities?: WirexCapability[] | null;
  // Register branch:
  register_approval_url?: string;
  register_session_id?: string;
  // v0.8.0 passkey co-signer fields. register_call_data is verified locally
  // before the register hash is signed (lib/wirex/registerVerification.ts).
  register_call_data?: string;
  passkey_signer_included?: boolean;
  passkey_signer_skip_reason?: string | null;
}

interface StatusData {
  ok?: boolean;
  status?: string;
  verification_status?: string | null;
  kyc_url?: string | null;
  bank_accounts?: WirexBankAccount[];
  cards?: WirexCard[];
  capabilities?: WirexCapability[] | null;
  // The Wirex profile's user_status ("" | "Active" | "Deleted" | "Blocked" | …)
  // and the per-rail bank eligibility. Both carry the block signal that
  // verification_status (historic KYC) and bank_accounts[].status (stays
  // "Active" on a blocklist offboard) do not.
  user_status?: string | null;
  bank_eligibility?: WirexBankEligibility[] | null;
}

// ── Wallet endpoint shape (GET /wallet?wallet=<eoa>) ──────────────────
interface WalletData {
  wallet_address?: string | null;
  balances?: Array<{
    token_symbol?: string | null;
    token_address?: string | null;
    balance?: string | null;
  }>;
}

// ── Card withdrawal shapes (two bridge approvals, a stable to the owner EOA) ──
//
// The card settles in two currencies and either can come back out: EURC (from
// the WEUR the euro pocket holds) or USDC (from WUSD). Those are the ONLY two —
// USDT and DAI are not synthetics and have no unwrap path, so a balance in them
// cannot be withdrawn through this route at all.
export type WirexWithdrawAsset = "EURC" | "USDC";

interface WithdrawalStartData {
  session_id?: string;
  approval_url?: string;
  // Echoed by the server from v0.33.0 on. A server that does not echo it does
  // not understand `asset` either, and would quietly withdraw euros — which is
  // why a non-default asset refuses to go on without this.
  asset?: string;
  source_token?: string;
  destination_token?: string;
}

interface WithdrawalResultData {
  ok?: boolean;
  status?: string;
  amount?: string;
  session_id?: string;
  approval_url?: string;
  first_tx_hash?: string;
  final_tx_hash?: string;
  asset?: string;
  source_token?: string;
  destination_token?: string;
  /** A currency swap's own outcome, once its payment is mined. */
  fx?: { status?: string; to?: string; trade_id?: string; error?: string };
}

// ── Card details reveal shapes (from nuri-wirex-mcp) ──────────────────
interface CardDetailsStartData {
  session_id: string;
  approval_url: string;
}

interface CardDetailsResultData {
  status?: string;
  card_id?: string;
  // Observed live shape: details = { card_number, expiry_date }; cvv = { cvv }.
  // Kept permissive for the string/bare-string variants the backend may return.
  details?: Record<string, unknown> | string | null;
  cvv?: Record<string, unknown> | string | null;
}

// ── User read (from nuri-wirex-mcp) ───────────────────────────────────
// Wirex serves the account's profile and per-rail capabilities from the
// eligibility route; nothing here is about ordering plastic.
interface WirexUserData {
  // Authoritative per-rail capabilities from Wirex BaaS getUserV2 — populated
  // even while /status's onboarding summary.capabilities is still empty.
  visa_plastic_card?: WirexCapability | null;
  visa_virtual_card?: WirexCapability | null;
  capabilities?: WirexCapability[] | null;
  // The KYC'd identity. This route proxies Wirex's GET /api/v2/user, and it is
  // the ONLY response that carries the account holder's name — /status has no
  // profile at all. Wirex models the name as first + last with no middle-name
  // field, so what is stored here IS the full name on the card and the IBAN.
  // Read-session gated and needing no signature, it is also the one place a
  // device that did not run signup can learn the account's email and residence
  // country (the Keychain-pinned email is per bundle id and does not survive a
  // reinstall).
  user?: {
    profile?: {
      first_name?: string | null;
      last_name?: string | null;
      email?: string | null;
    } | null;
    residence_address?: { country?: string | null } | null;
  } | null;
}

// ── In-app 3DS challenge shapes (from nuri-wirex-mcp) ─────────────────
interface ThreeDsPendingData {
  challenges?: Array<{
    card_id?: string | null;
    transaction_id?: string | null;
    merchant_name?: string | null;
    amount?: string | null;
    currency?: string | null;
    card_last_4?: string | null;
  }>;
}

// ── Public return shapes ───────────────────────────────────────────────
export interface WirexOnboardResult {
  outcome: "kyc_url" | "approved_without_link";
  kycUrl: string | null;
  kycSdkToken: string | null; // native Sumsub SDK token when KYC is pending; null → use kycUrl webview
  wallet: string | null;
  credentialId: string | null;
  sumsubClientId: string | null;
}

export interface WirexStatusResult {
  verificationStatus: string;
  kycUrl: string | null;
  bankAccounts: unknown[];
  cards: unknown[];
  capabilities: WirexCapability[];
  // The Wirex profile's user_status ("" | "Active" | "Deleted" | "Blocked" | …)
  // and the per-rail bank eligibility, passed through verbatim for the block
  // derivation.
  userStatus: string | null;
  bankEligibility: WirexBankEligibility[];
  // Derived: the account is blocked — no IBAN row, no "issue card" CTA.
  isAccountBlocked: boolean;
}

export interface WirexTokenBalance {
  tokenSymbol: string | null;
  tokenAddress: string | null;
  balance: string | null; // decimal string from Wirex unified balance
}

export interface WirexWalletResult {
  walletAddress: string | null;
  balances: WirexTokenBalance[];
}

export interface WirexWithdrawalResult {
  ok: true;
  amount: string;
  /** What actually left the card. Credit the pocket off this, never off intent. */
  asset: WirexWithdrawAsset;
  firstTxHash: string;
  finalTxHash: string;
  /** Set for a currency swap: whether Wirex ran it after the money left. */
  fx?: WirexCardSwapOutcome;
}

/**
 * How a card currency swap ended once its payment left the card. "failed": the
 * money reached Wirex's swap address but the swap did not run. "unknown": Wirex
 * may have run it (its reply was lost). Neither is retried; both need support,
 * the money is not lost.
 */
export interface WirexCardSwapOutcome {
  status: "done" | "failed" | "unknown";
  to: "EUR" | "USD";
  tradeId: string | null;
  error: string | null;
}

function toSwapOutcome(fx: WithdrawalResultData["fx"]): WirexCardSwapOutcome | undefined {
  if (!fx) return undefined;
  return {
    status: fx.status === "done" || fx.status === "failed" ? fx.status : "unknown",
    to: String(fx.to || "").toUpperCase() === "USD" ? "USD" : "EUR",
    tradeId: typeof fx.trade_id === "string" ? fx.trade_id : null,
    error: typeof fx.error === "string" ? fx.error : null,
  };
}

/**
 * Thrown when a withdrawal's outcome can't be confirmed AFTER the execution
 * approval was submitted. At that point funds may already be moving server-side,
 * so this is an ambiguous, NON-retryable state — the caller must surface a
 * pending/unconfirmed state and must NOT offer a plain retry (which would start a
 * second withdrawal). Distinct from pre-approval failures, which are safe to retry.
 */
export class WirexWithdrawUnconfirmedError extends Error {
  constructor() {
    super("wirex_withdraw_unconfirmed");
    this.name = WIREX_WITHDRAW_UNCONFIRMED_ERROR_NAME;
  }
}

/** Another card withdrawal or swap is running: nothing was started. */
export class WirexWithdrawBusyError extends Error {
  constructor() {
    super("wirex_withdraw_busy");
    this.name = "WirexWithdrawBusyError";
  }
}

export interface WirexCardDetailsResult {
  cardId: string;
  cardNumber: string | null;
  expiry: string | null;
  cvv: string | null;
}

// ── User read ─────────────────────────────────────────────────────────
// What Wirex's user route carries: the KYC'd identity and the per-rail
// capabilities. Read for the account holder's name (nothing else in the API
// carries it) and for onboarding diagnostics.
export interface WirexUser {
  visaVirtualCard: WirexCapability | null;
  capabilities: WirexCapability[];
  /** "First Last" from the KYC'd profile; null when the route omits it. */
  holderName: string | null;
  // Null when absent — the caller must never substitute a default country (it
  // decides which rails get provisioned) or a default email (it identifies the
  // account).
  email: string | null;
  country: string | null;
  raw: unknown;
}

export interface WirexSepaEstimate {
  ok: boolean;
  estimationId: string | null;
  raw: unknown;
}
export interface WirexSepaTransferResult {
  ok: boolean;
  transferId: string | null;
  raw: unknown;
}
// A saved push-to-card destination. The card token stays on the server; the
// app picks a card by recipientId.
export interface WirexPayoutCard {
  recipientId: string;
  name: string;
  last4: string;
  currencies: string[];
}
// The server's quote for a push to card. Its values are what the user signs.
export interface WirexCardTransferQuote {
  estimationId: string;
  amount: number;
  currency: string;
  card: WirexPayoutCard;
  /** What leaves the debit token, fee included. */
  debitAmount: number | null;
  feeAmount: number | null;
}
// IBAN lookup result (POST /iban/lookup): validation + derived BIC/bank so the
// app can autofill the BIC and confirm the bank before signing the transfer.
export interface WirexIbanLookup {
  valid: boolean;
  iban: string | null; // server-normalized (uppercase, no spaces) — sign THIS, not raw input
  bic: string | null;
  bankName: string | null;
  needsManualBic: boolean;
  messages: string[];
}

// ── In-app 3DS challenge public shape ─────────────────────────────────
export interface Wirex3dsChallenge {
  cardId: string | null;
  transactionId: string;
  merchantName: string | null;
  amount: string | null; // decimal string, passed through from Wirex verbatim
  currency: string | null; // ISO-4217
  cardLast4: string | null;
}

// ── Card management shapes (GET /card/status, /card/limits) ───────────
// `limit` passes the raw Wirex limit object through (daily_limit / daily_usage /
// monthly_limit / currency; -1 = no limit).
export interface WirexCardLimit {
  daily_limit?: number;
  daily_usage?: number;
  monthly_limit?: number;
  currency?: string;
}

export interface WirexCardStatus {
  cardId: string;
  status: string | null; // Wirex card status, e.g. "Active" | "Blocked"
  isFrozen: boolean; // Blocked == frozen
  limit: WirexCardLimit | null;
}

export interface WirexIssuedCard {
  cardId: string;
  card: WirexCard | null; // present only when the server echoes the new card
  reconciled: boolean; // true = the card already existed (lost response), not newly created
}

// Map the raw reveal payload to the parsed card fields. `details` is an object
// { card_number, expiry_date } (or a bare PAN string); `cvv` arrives nested as
// { cvv } (or occasionally a bare string). SECURITY: values are never logged.
function parseWirexCardDetails(
  data: CardDetailsResultData,
): Omit<WirexCardDetailsResult, "cardId"> {
  const { details, cvv } = data;
  const readString = (source: unknown, keys: string[]): string | null => {
    if (source && typeof source === "object") {
      const record = source as Record<string, unknown>;
      for (const key of keys) {
        const value = record[key];
        if (typeof value === "string" && value.length > 0) return value;
      }
    }
    return null;
  };
  const cardNumber =
    typeof details === "string" ? details : readString(details, ["card_number", "pan", "number"]);
  const expiry = readString(details, ["expiry_date", "expiry", "exp"]);
  const cvvValue = typeof cvv === "string" ? cvv : readString(cvv, ["cvv", "code"]);
  return { cardNumber, expiry, cvv: cvvValue };
}

// ── Bounded polling ────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 40;
// The withdrawal result flips the moment the server's read-back finishes —
// currently somewhere around 6-8s (nuri-wirex-mcp#38). A flat 3s poll can sit on
// an already-ready result for up to 3s of that, so this one ramps instead: tight
// at the start where the flip is expected, widening to the shared interval once
// the wait is genuinely long. Deadline-bounded so the total budget is unchanged.
// A marker older than this can no longer be resolved: the server-side approval
// session is gone with the process that held it.
const PENDING_WITHDRAW_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const WITHDRAW_POLL_START_INTERVAL_MS = 500;
const WITHDRAW_POLL_TIMEOUT_MS = POLL_INTERVAL_MS * POLL_MAX_ATTEMPTS;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const LOG_TAG = "[WirexService]";

// ── Read session (server-side IDOR gate on GET reads) ──────────────────
// The backend gates every read route behind a wallet-signed bearer token: only
// the wallet whose key signed the token can be read (the client `?wallet=` arg
// is ignored server-side). The token is `<exp>.<sig>` where `sig` is an EIP-191
// personal_sign over `Nuri Wirex read session until <exp>`. One signature is
// reused across all reads for the whole TTL — never sign per call.
const WIREX_READ_SESSION_TTL_SEC = 3600;
// Re-mint this many seconds before `exp` so an in-flight request never races the
// server's `exp*1000 > Date.now()` check.
const WIREX_READ_SESSION_SKEW_SEC = 60;
// Server error codes that mean the attached token was rejected → re-mint + retry.
const WIREX_SESSION_ERROR_CODES = ["session_missing_or_expired", "invalid_session_signature"];
// Emitted whenever a read session is freshly minted. App.tsx retries the push
// binding on it — see bindNotificationSubscription.
export const WIREX_READ_SESSION_MINTED_EVENT = "wirex:readSessionMinted";
// Thrown instead of sending (or re-sending) a request whose caller has declared
// itself abandoned — see the `abortIf` option on the authorized GET helper.
export const WIREX_REQUEST_ABANDONED_ERROR = "wirex_request_abandoned";
// Thrown by a `cachedSessionOnly` read when no valid read session is cached:
// minting one signs with the biometric EOA, which a background read must not do.
export const WIREX_NO_READ_SESSION_ERROR = "wirex_no_read_session";
// Thrown instead of making a provisioning request that could not be recorded
// durably — see guardProvisioningAttempt.
export const WIREX_PROVISIONING_GUARD_ERROR = "wirex_provisioning_guard_unavailable";

// The Wirex account is keyed by wallet+email server-side. The email is entered
// by the user on the open-free-account screen and pinned per-wallet; it must be
// pinned before onboarding runs, and there is no fallback identity (a wallet
// with no pinned email simply hasn't started onboarding yet).

/** Paging for the activity reads. Omitted = the server's default page size. */
export type WirexActivityPageOptions = {
  /** Server caps this at 100. */
  pageSize?: number;
  /** Read with the cached read session only; never mint (no biometric prompt). */
  cachedSessionOnly?: boolean;
};

class WirexService {
  private emailInFlight = new Map<string, Promise<string>>();

  // Cached read-session token, reused across all reads until ~SKEW before exp.
  // Keyed by the signer wallet so a same-process relogin to a different EOA can
  // never reuse the previous wallet's token (the server authorizes by recovered
  // signer, so a stale token would leak the old wallet's reads).
  private readSession: { token: string; exp: number; wallet: string } | null = null;
  // Dedupes concurrent mints (getActivityFeed fires several reads in parallel)
  // so a cold cache triggers exactly one biometric signature, not one per read.
  private readSessionInFlight: Promise<string> | null = null;

  private get restBaseUrl(): string {
    return wirexConfig.restBaseUrl;
  }

  // ── Read session minter ──────────────────────────────────────────────
  // Signs (once per TTL) the exact string the server recovers the wallet from,
  // and caches the resulting `<exp>.<sig>` bearer token. The cache is validated
  // against the CURRENT on-device EOA (cheap, no biometric) so a wallet switch
  // forces a re-mint. SECURITY: the token and signature are never logged;
  // buildSigner already zeroizes the private key.
  private async getReadSessionToken(): Promise<string> {
    const cached = await this.peekReadSessionToken();
    if (cached) return cached;
    if (this.readSessionInFlight) return this.readSessionInFlight;
    const run = (async () => {
      const exp = Math.floor(Date.now() / 1000) + WIREX_READ_SESSION_TTL_SEC;
      const message = `Nuri Wirex read session until ${exp}`;
      const { address, signature } = await this.buildSigner()({ message });
      const token = `${exp}.${signature}`;
      this.readSession = { token, exp, wallet: address.toLowerCase() };
      // Critical signing-flow log (AGENTS.md): no token/signature/key, address
      // truncated. Signals when the biometric key was touched to mint a session.
      logWithId(
        `${LOG_EMOJI.auth} WirexService.readSession`,
        "minted read session (signed with on-device EOA)",
        { wallet: shortAddress(address), ttl_sec: WIREX_READ_SESSION_TTL_SEC },
        {
          source: "services/wirex/WirexService.ts#getReadSessionToken",
          scope: "Wirex",
          event: "SECURITY",
          context: "system",
        },
      );
      // A read session is the only thing the push binding can authenticate with,
      // and this cache is per-process — so at sign-in there is never one and the
      // bind attempted there is a no-op. Announcing the mint is what gives it a
      // second chance, without WirexService depending on the notification module.
      EventBus.emit(WIREX_READ_SESSION_MINTED_EVENT);
      return token;
    })().finally(() => {
      if (this.readSessionInFlight === run) this.readSessionInFlight = null;
    });
    this.readSessionInFlight = run;
    return run;
  }

  // The cached read-session token, or null when none is valid for the current
  // EOA. Never mints: callers that are not a user-initiated read must not be
  // able to raise a biometric prompt. Validating against the CURRENT on-device
  // EOA is cheap (the address read is cached, no PRF).
  private async peekReadSessionToken(): Promise<string | null> {
    if (!this.readSession) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    if (this.readSession.exp - WIREX_READ_SESSION_SKEW_SEC <= nowSec) return null;
    const currentEoa = ((await getEthereumAddress()) || "").toLowerCase();
    return this.readSession?.wallet === currentEoa ? this.readSession.token : null;
  }

  // Drop the cached read session. Called on sign-out (App.resetToWelcome) so a
  // same-process relogin re-mints under the new wallet instead of reusing a
  // token that authorizes the previous wallet's reads.
  clearReadSession(): void {
    this.readSession = null;
    this.readSessionInFlight = null;
  }

  // ── Push binding (wirex namespace) ───────────────────────────────────
  // Vouches that this account owns the given notification subscription, so card
  // spend, SEPA movements, card-limit and 3DS events reach this device. The
  // wallet is NOT sent: the server derives it from the read-session signature,
  // exactly as arkade derives its credId from a passkey assertion — so the app
  // cannot bind someone else's account and there is nothing to look up first.
  //
  // Uses the CACHED session only. Minting one signs with the biometric EOA, and
  // a background bind must never raise Face ID; with none cached this is a
  // no-op, retried when the card screens mint one (WIREX_READ_SESSION_MINTED_EVENT).
  //
  // 200 = bound, or already was (the server inserts on conflict do nothing), so
  // re-sending on every launch is free and is preferred over tracking it
  // locally: the server may have cascaded the binding away after a token change.
  // 401/502/503 all mean "not now" — leave it unbound and retry, never surface.
  //
  // SECURITY: `subscriptionId` is a bearer secret (anyone holding it can attach
  // a device) — never log it.
  async bindNotificationSubscription(subscriptionId: string): Promise<boolean> {
    const token = await this.peekReadSessionToken();
    if (!token) return false;
    const path = wirexConfig.routes.notificationsBind;
    try {
      const response = await fetch(`${this.restBaseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ subscription_id: subscriptionId }),
      });
      // The session the peek handed out was rejected — drop it so the next real
      // read re-mints instead of replaying a token the server will refuse again.
      if (response.status === 401) this.readSession = null;
      console.log(`${LOG_TAG} bindNotificationSubscription: HTTP ${response.status}`);
      return response.status === 200;
    } catch {
      console.warn(`${LOG_TAG} bindNotificationSubscription: unreachable`);
      return false;
    }
  }

  // The gated routes report failures as a nested object
  // (`error: { ok:false, error:"session_missing_or_expired …" }`) rather than a
  // bare string. Flatten to the innermost human-readable string so both session
  // matching and error logging avoid `[object Object]`.
  private getErrorString(error: unknown): string {
    if (typeof error === "string") return error;
    if (error && typeof error === "object") {
      const inner = (error as { error?: unknown }).error;
      if (typeof inner === "string") return inner;
      try {
        return JSON.stringify(error);
      } catch (e) {
        console.warn(`${LOG_TAG} failed to stringify error object`, e);
      }
    }
    return "unknown_error";
  }

  private isSessionError(error: unknown): boolean {
    const text = this.getErrorString(error);
    return WIREX_SESSION_ERROR_CODES.some((code) => text.includes(code));
  }

  // ── REST plumbing ────────────────────────────────────────────────────
  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.restBaseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return this.unwrap<T>(response, `POST ${path}`);
  }

  // `authorized` routes are server-gated reads: they carry the wallet-signed
  // bearer token, and on a session-rejection error the token is dropped, re-minted
  // once, and the request retried once (covers a token that expired mid-flight).
  private async get<T>(
    path: string,
    query: Record<string, string>,
    // `abortIf` is re-checked around the retry: re-minting signs with whatever
    // EOA is on the device NOW, so a request whose account signed out mid-flight
    // would otherwise be resent — URL, email and all — under the next account's
    // freshly minted session.
    // `cachedSessionOnly` reads with the cached session and never mints one, so
    // the read can never raise a biometric prompt (the retry included).
    opts: { authorized?: boolean; abortIf?: () => boolean; cachedSessionOnly?: boolean } = {},
  ): Promise<T> {
    const params = new URLSearchParams(query).toString();
    const url = params ? `${this.restBaseUrl}${path}?${params}` : `${this.restBaseUrl}${path}`;
    const label = `GET ${path}`;
    if (!opts.authorized) {
      return this.unwrap<T>(await fetch(url, { method: "GET" }), label);
    }
    // Minting a token awaits a signature, and an account switch can land inside
    // that await — so abandonment is re-checked HERE, after the token resolves
    // and immediately before the request goes out. Checking only before the mint
    // would let this URL (with the previous account's email) be sent under the
    // next account's freshly minted session.
    const send = async (): Promise<RestEnvelope<T>> => {
      if (opts.abortIf?.()) throw new Error(WIREX_REQUEST_ABANDONED_ERROR);
      const token = opts.cachedSessionOnly
        ? await this.peekReadSessionToken()
        : await this.getReadSessionToken();
      if (!token) throw new Error(WIREX_NO_READ_SESSION_ERROR);
      if (opts.abortIf?.()) throw new Error(WIREX_REQUEST_ABANDONED_ERROR);
      return this.parseEnvelope<T>(
        await fetch(url, { method: "GET", headers: { authorization: `Bearer ${token}` } }),
        label,
      );
    };
    const first = await send();
    if (this.isSessionError(first.error)) {
      this.readSession = null;
      return this.finalizeEnvelope(await send(), label);
    }
    return this.finalizeEnvelope(first, label);
  }

  // A read-session gated write: same token and the same re-mint-once retry as
  // the gated GET. A session rejection happens before the server does anything,
  // so the retry cannot repeat the write.
  private async postAuthorized<T>(path: string, body: unknown): Promise<T> {
    const label = `POST ${path}`;
    const send = async (): Promise<RestEnvelope<T>> => {
      const token = await this.getReadSessionToken();
      if (!token) throw new Error(WIREX_NO_READ_SESSION_ERROR);
      return this.parseEnvelope<T>(
        await fetch(`${this.restBaseUrl}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        }),
        label,
      );
    };
    const first = await send();
    if (this.isSessionError(first.error)) {
      this.readSession = null;
      return this.finalizeEnvelope(await send(), label);
    }
    return this.finalizeEnvelope(first, label);
  }

  private async parseEnvelope<T>(response: Response, label: string): Promise<RestEnvelope<T>> {
    try {
      return (await response.json()) as RestEnvelope<T>;
    } catch {
      throw new Error(`${LOG_TAG} ${label} returned non-JSON (http ${response.status})`);
    }
  }

  private finalizeEnvelope<T>(envelope: RestEnvelope<T>, label: string): T {
    if (!envelope.ok) {
      throw new Error(`${LOG_TAG} ${label} failed: ${this.getErrorString(envelope.error)}`);
    }
    if (envelope.data === null || envelope.data === undefined) {
      throw new Error(`${LOG_TAG} ${label} returned no data`);
    }
    return envelope.data;
  }

  private async unwrap<T>(response: Response, label: string): Promise<T> {
    return this.finalizeEnvelope(await this.parseEnvelope<T>(response, label), label);
  }

  // ── Signer (biometric EOA keychain), injected into the bridge ────────
  // Reuses the app's on-device held Ethereum key for EVM message signing.
  // Biometric is only for signing; the private key is zeroized immediately after.
  private buildSigner(): SignFn {
    return async ({ message }) => {
      const pk = await getPrivateKey("ethereum");
      try {
        const account = privateKeyToAccount(`0x${bytesToHex(pk)}`);
        // EIP-191 either way: a string is signed as its UTF-8 text, bytes as-is.
        const signature = await account.signMessage({
          message: typeof message === "string" ? message : { raw: message },
        });
        void this.checkSignerMatchesBootstrapAddress(account.address);
        return { address: account.address, signature };
      } finally {
        zeroize(pk);
      }
    };
  }

  // One-time sanity check (PR #777 review): the keychain key actually signing
  // must resolve to the same EOA as the passkey-PRF bootstrap address cached at
  // signup — otherwise app and PWA resolve to different Wirex identities.
  // Piggybacks on a signature the user already requested, so it never adds its
  // own biometric or passkey prompt. Log-only; never surfaces in the UI.
  private signerAddressChecked = false;
  private async checkSignerMatchesBootstrapAddress(signerAddress: string): Promise<void> {
    if (this.signerAddressChecked) return;
    this.signerAddressChecked = true;
    try {
      const bootstrapAddress = await getEthereumAddress();
      if (bootstrapAddress && bootstrapAddress.toLowerCase() !== signerAddress.toLowerCase()) {
        console.warn(`${LOG_TAG} signer EOA differs from bootstrap PRF address`, {
          signer: shortAddress(signerAddress),
          bootstrap: shortAddress(bootstrapAddress),
        });
      }
    } catch {}
  }

  // ── Wallet passkey metadata (credential id + SPKI pubkey, both b64u) ──
  // Captured at passkey creation by the WebAuthn PRF bridge and persisted in
  // walletPublicKeys. Sent with the ONBOARD approval so the backend can add
  // the passkey as a smart-account signer next to the EOA (it needs both: the
  // WebAuthn signer encoding hashes the credential id). Best-effort — missing
  // values (restored device pre-backfill) degrade to EOA-only registration.
  private async readWalletPasskey(): Promise<{ credIdB64u?: string; pubkeyB64u?: string }> {
    try {
      await authStateManager.initialize();
      const keys = authStateManager.getState().walletPublicKeys;
      const credId = (keys?.walletPasskeyCredIdB64u || "").trim();
      const pubkey = (keys?.walletPasskeyCredPubkeyB64u || "").trim();
      if (!credId || !pubkey) return {};
      return { credIdB64u: credId, pubkeyB64u: pubkey };
    } catch {
      return {};
    }
  }

  // ── Email pinning ─────────────────────────────────────────────────────
  // The pin is keyed BY WALLET: a device can hold successive accounts (reset +
  // new username), and a global pin would leak the previous account's email
  // into the new wallet's onboarding — registering the new smart account under
  // an already-taken email wedges registration forever.
  private emailKeyFor(wallet: string): string {
    return `${WIREX_EMAIL_KEY}:${wallet.toLowerCase()}`;
  }

  // Basic email-shape check. The server is the authority on validity; this only
  // stops obviously-malformed input from being pinned as the account key.
  private normalizeAccountEmail(email: string): string {
    const normalized = String(email || "")
      .trim()
      .toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw new Error("wirex_invalid_account_email");
    }
    return normalized;
  }

  private emailFingerprint(email: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < email.length; i += 1) {
      hash ^= email.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 8);
  }

  private logEmailEvent(
    event: string,
    email: string | null,
    extra?: Record<string, unknown>,
  ): void {
    console.log(`${LOG_TAG} email ${event}`, {
      email_kind: email ? "username" : "missing",
      email_hash: email ? this.emailFingerprint(email) : null,
      ...extra,
    });
  }

  // Returns the only Wirex email this wallet may use. If the username email was
  // not pinned yet, fail closed instead of inventing a second account identity.
  async getOnboardEmail(wallet: string): Promise<string> {
    const key = this.emailKeyFor(wallet);
    const pending = this.emailInFlight.get(key);
    if (pending) return pending;
    try {
      const pinned = (await getAuthData(key))?.trim();
      if (pinned) {
        this.logEmailEvent("resolved", pinned, { source: "pinned" });
        return pinned;
      }
    } catch {}
    this.logEmailEvent("missing", null, { source: "pinned" });
    throw new Error("wirex_username_email_not_pinned");
  }

  private async withEmailLock(wallet: string, work: () => Promise<string>): Promise<string> {
    const key = this.emailKeyFor(wallet);
    const pending = this.emailInFlight.get(key);
    if (pending) return pending;
    const run = work().finally(() => {
      if (this.emailInFlight.get(key) === run) {
        this.emailInFlight.delete(key);
      }
    });
    this.emailInFlight.set(key, run);
    return run;
  }

  // Validate the account email (user-entered on the open-free-account screen)
  // and check it against this wallet's pin. Nothing is written here: the pin is
  // only stored once /onboard/start has accepted the address
  // (persistAccountEmail), so an attempt that never created an account leaves
  // the user free to retry or fix a typo. Once a pin exists an account exists
  // under it, and any other address fails closed — a half-finished onboarding
  // can't fork the account identity.
  async pinAccountEmail(email: string): Promise<string> {
    const wallet = await getEthereumAddress();
    if (!wallet) throw new Error("wirex_no_wallet_for_email_pin");
    const normalized = this.normalizeAccountEmail(email);
    return this.withEmailLock(wallet, async () => {
      const existing = (await getAuthData(this.emailKeyFor(wallet)))?.trim();
      if (existing && existing !== normalized) {
        this.logEmailEvent("mismatch", existing, {
          source: "pin",
          requested_hash: this.emailFingerprint(normalized),
        });
        throw new Error("wirex_account_email_mismatch");
      }
      this.logEmailEvent(existing ? "pin_reused" : "pin_accepted", normalized, {
        source: "user_entry",
      });
      return normalized;
    });
  }

  // Pin the account email once /onboard/start has accepted it: the account now
  // exists server-side under this address, so it becomes the only email this
  // wallet may use. Idempotent — the returning-passkey flow re-runs onboarding
  // with the already-pinned address.
  private async persistAccountEmail(email: string): Promise<void> {
    const wallet = await getEthereumAddress();
    if (!wallet) throw new Error("wirex_no_wallet_for_email_pin");
    const key = this.emailKeyFor(wallet);
    // Normalize at the write rather than trusting the caller: what lands here
    // becomes the value every later pin is compared against, so storing an
    // unnormalized address would reject the user's own email from then on.
    const normalized = this.normalizeAccountEmail(email);
    await this.withEmailLock(wallet, async () => {
      const existing = (await getAuthData(key))?.trim();
      if (existing && existing !== normalized) {
        this.logEmailEvent("mismatch", existing, {
          source: "onboard_start",
          requested_hash: this.emailFingerprint(normalized),
        });
        throw new Error("wirex_account_email_mismatch");
      }
      if (!existing) {
        await storeAuthData(key, normalized);
        this.logEmailEvent("pinned", normalized, { source: "onboard_start" });
      }
      return normalized;
    });
  }

  // ── Public flow: onboarding ──────────────────────────────────────────
  // Deduped: a second onboard() for the same email while one is in flight
  // (pre-warm still running when the user taps "open free account") joins the
  // running promise instead of racing a second registration UserOp.
  async onboard(params: {
    username: string;
    email: string;
    country?: string;
  }): Promise<WirexOnboardResult> {
    if (this.onboardInFlight && this.onboardInFlight.email === params.email) {
      console.log(`${LOG_TAG} onboard: joining in-flight run`);
      return this.onboardInFlight.promise;
    }
    const promise = this.runOnboard(params).finally(() => {
      if (this.onboardInFlight?.promise === promise) {
        this.onboardInFlight = null;
      }
    });
    this.onboardInFlight = { email: params.email, promise };
    return promise;
  }

  private onboardInFlight: { email: string; promise: Promise<WirexOnboardResult> } | null = null;

  /**
   * Record the provisioning attempt about to be made, or refuse to make it.
   *
   * The marker is the only thing standing between Wirex's asynchronous issuance
   * and a duplicate card: without a durable record, a kill-and-relaunch inside
   * that window sees an account that still has no card and asks for another one.
   * So a marker that cannot be written fails the request instead of provisioning
   * unguarded — the caller retries, and nothing has been issued twice.
   */
  private async guardProvisioningAttempt(wallet: string | null): Promise<void> {
    if (await markProvisioningAttempt(wallet)) return;
    throw new Error(WIREX_PROVISIONING_GUARD_ERROR);
  }

  private async runOnboard(params: {
    username: string;
    email: string;
    country?: string;
  }): Promise<WirexOnboardResult> {
    const { username, email, country } = params;
    console.log(`${LOG_TAG} onboard: starting`, { email_hash: this.emailFingerprint(email) });

    // 1) Begin onboarding → approval_url to sign. The server binds the passkey
    //    to the bare Nuri username (server ≥ v0.9.0 requires it) and stores
    //    `email` as the account's contact address for the card + IBAN. The two
    //    are independent: `username` is the handle claimed at signup, `email`
    //    is entered on the open-free-account screen.
    //
    //    Sending the existing credential_id marks this as a returning-passkey
    //    flow (server v0.22.0): no fresh passkey creation, no Arkade
    //    re-registration — just continue Wirex onboarding under this credential.
    const passkey = await this.readWalletPasskey();
    // This is the FIRST provisioning attempt for the account (create_user → bank
    // → card), recorded on the same durable marker the repair reads, so a launch
    // that lands while onboarding's card is still being issued does not ask for
    // a second one (see provisioningAttemptMarker).
    await this.guardProvisioningAttempt(await getEthereumAddress().catch((): null => null));
    const start = await this.post<OnboardStartData>(wirexConfig.routes.onboardStart, {
      email,
      username,
      ...(country ? { country } : {}),
      ...(passkey.credIdB64u ? { credential_id: passkey.credIdB64u } : {}),
    });

    // The server has accepted the address as this account's contact email, so
    // pin it now — from here on it is the only email this wallet may use.
    await this.persistAccountEmail(email);

    // 2) Sign + submit the approval on-device, carrying the wallet passkey so
    //    the server installs it as a weighted co-signer next to the EOA.
    // Never log the raw session_id — it is a bearer that authorizes pre-auth
    // onboard/result polling and DebugLogBuffer captures console output into
    // support dumps. Presence is enough for diagnostics.
    console.log(`${LOG_TAG} onboard: start ok`, {
      session_id_present: Boolean(start.session_id),
      passkey_metadata_present: Boolean(passkey.credIdB64u),
    });
    await submitSignedApproval({
      approvalUrl: start.approval_url,
      sign: this.buildSigner(),
      credentialIdB64u: passkey.credIdB64u,
      credentialPubkeyB64u: passkey.pubkeyB64u,
    });
    console.log(`${LOG_TAG} onboard: approval envelope submitted`);

    // 3) Poll onboard/result until it's no longer pending.
    const result = await this.pollOnboardResult(start.session_id);
    console.log(`${LOG_TAG} onboard: result`, {
      status: result.status ?? null,
      has_kyc_url: Boolean(result.kyc_url),
      needs_registration: Boolean(result.register_approval_url),
      credential_id_present: Boolean(result.credential_id),
      // v0.8.0 co-signer telemetry — expected true when the app sent the
      // wallet passkey metadata; skip_reason explains any server-side skip:
      passkey_signer_included: result.passkey_signer_included ?? null,
      passkey_signer_skip_reason: result.passkey_signer_skip_reason ?? null,
      register_call_data_len: result.register_call_data?.length ?? 0,
    });

    // Done in one tap (already registered onchain).
    if (result.kyc_url) {
      return this.toOnboardResult(result);
    }

    // Needs a second signature: the onchain AA registration.
    if (result.register_approval_url && result.register_session_id) {
      // Presence only — register_session_id is a bearer for register/result
      // polling (see the session_id note above).
      console.log(`${LOG_TAG} onboard: registration required`, {
        register_session_id_present: Boolean(result.register_session_id),
      });

      // 4) SECURITY GATE: the register batch can grant signing power (root
      //    validator changes, weighted signer install). Rebuild the expected
      //    callData locally and refuse to sign anything that doesn't match.
      //    Fail closed — a batch we cannot verify does not get signed.
      const eoaAddress = await getEthereumAddress();
      if (!eoaAddress) {
        throw new Error(`${LOG_TAG} onboard: no EOA address for register verification`);
      }
      const verification = await verifyRegisterCallData({
        eoaAddress,
        expectedCallData: result.register_call_data ?? "",
        passkeyIncluded: result.passkey_signer_included === true,
        passkeyCredIdB64u: passkey.credIdB64u,
        passkeyPubkeyB64u: passkey.pubkeyB64u,
      });
      console.log(`${LOG_TAG} onboard: register callData verification`, {
        ok: verification.ok,
        variant: verification.matchedVariant ?? null,
        reason: verification.reason ?? null,
      });
      if (!verification.ok) {
        throw new Error(
          `${LOG_TAG} onboard: register callData verification failed (${verification.reason}) — refusing to sign`,
        );
      }

      // 5) Sign the register approval (userOpHash, hash-mode). The
      //    credential id targets the same passkey used to onboard.
      await submitSignedApproval({
        approvalUrl: result.register_approval_url,
        sign: this.buildSigner(),
        credentialIdB64u: result.credential_id ?? undefined,
      });
      console.log(`${LOG_TAG} onboard: register envelope submitted`);

      // 6) Poll register/result until the KYC link appears.
      const registered = await this.pollRegisterResult(result.register_session_id);
      console.log(`${LOG_TAG} onboard: registration done`, {
        has_kyc_url: Boolean(registered.kyc_url),
        verification_status: registered.verification_status ?? null,
      });
      return this.toOnboardResult(registered);
    }

    if (
      classifyLinklessOnboardResult({
        status: result.status,
        kycUrl: result.kyc_url,
        registerApprovalUrl: result.register_approval_url,
        registerSessionId: result.register_session_id,
      }) === "approved_without_link"
    ) {
      return {
        outcome: "approved_without_link",
        kycUrl: null,
        kycSdkToken: null,
        wallet: result.wallet ?? null,
        credentialId: result.credential_id ?? null,
        sumsubClientId: null,
      };
    }

    throw new Error(
      `${LOG_TAG} onboard: result had neither kyc_url nor register link (status=${result.status ?? "unknown"})`,
    );
  }

  private async pollOnboardResult(sessionId: string): Promise<OnboardResultData> {
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      const data = await this.get<OnboardResultData>(wirexConfig.routes.onboardResult, {
        session_id: sessionId,
      });
      if (data.status !== "pending") {
        return data;
      }
      if (attempt % 5 === 0) {
        console.log(`${LOG_TAG} onboard/result: still pending`, { attempt });
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`${LOG_TAG} onboard/result still pending after ${POLL_MAX_ATTEMPTS} attempts`);
  }

  private async pollRegisterResult(sessionId: string): Promise<OnboardResultData> {
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      const data = await this.post<OnboardResultData>(wirexConfig.routes.registerResult, {
        session_id: sessionId,
      });
      if (data.kyc_url) {
        return data;
      }
      if (attempt % 5 === 0) {
        console.log(`${LOG_TAG} register/result: not ready`, {
          attempt,
          status: data.status ?? null,
        });
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(
      `${LOG_TAG} register/result produced no kyc_url after ${POLL_MAX_ATTEMPTS} attempts`,
    );
  }

  private toOnboardResult(data: OnboardResultData): WirexOnboardResult {
    const kycUrl = data.kyc_url ?? null;
    if (!kycUrl) {
      throw new Error(`${LOG_TAG} onboarding done but no kyc_url present`);
    }
    return {
      outcome: "kyc_url",
      kycUrl,
      kycSdkToken: data.kycSdkToken ?? null,
      wallet: data.wallet ?? null,
      credentialId: data.credential_id ?? null,
      sumsubClientId: parseSumsubClientId(kycUrl),
    };
  }

  // ── Public: status (verification / IBAN / cards) ─────────────────────
  // `email` is ONBOARDING-ONLY and optional. The read session identifies the
  // account — the server derives the user from whoever signed it and ignores
  // `wallet` outright. Passing `email` re-runs the onboarding/provisioning
  // sync (create_user → bank → card, ~90s), which is the only thing it does
  // here: send it while onboarding is still in flight, omit it to read a
  // registered account. A device that never onboarded has no pinned email and
  // must still be able to read the account.
  async getStatus(params: {
    wallet: string;
    email?: string;
    country?: string;
    // Long-running background callers (the provisioning repair) declare here
    // that their account is gone; the request is then never sent or retried.
    abortIf?: () => boolean;
  }): Promise<WirexStatusResult> {
    const { wallet, email, country, abortIf } = params;
    // With `email` this call PROVISIONS, so it is recorded like any other
    // provisioning attempt — before the request, because one whose response is
    // lost may still have issued a card. The launch repair reads this to know
    // that products may still be landing (see provisioningAttemptMarker).
    // Fail closed: without a durable record, a kill-and-relaunch inside Wirex's
    // async issuance window would ask for a second card. Not provisioning is the
    // recoverable half of that trade — the next launch tries again.
    if (email) await this.guardProvisioningAttempt(wallet);
    const data = await this.get<StatusData>(
      wirexConfig.routes.status,
      {
        wallet,
        ...(email ? { email } : {}),
        ...(country ? { country } : {}),
      },
      { authorized: true, abortIf },
    );
    const bankEligibility = Array.isArray(data.bank_eligibility) ? data.bank_eligibility : [];
    const result: WirexStatusResult = {
      verificationStatus: data.verification_status ?? data.status ?? "unknown",
      kycUrl: data.kyc_url ?? null,
      bankAccounts: Array.isArray(data.bank_accounts) ? data.bank_accounts : [],
      cards: Array.isArray(data.cards) ? data.cards : [],
      capabilities: Array.isArray(data.capabilities) ? data.capabilities : [],
      userStatus: data.user_status ?? null,
      bankEligibility,
      isAccountBlocked: isAccountBlocked({
        userStatus: data.user_status ?? null,
        bankEligibility,
      }),
    };

    // When no card has been issued yet, gather the diagnostic detail: /status's
    // own summary.capabilities is empty until late in the flow, so read the
    // authoritative per-rail state from getUserV2 (GET /card/physical/eligibility)
    // and the raw /status payload. Best-effort — never let this block a status
    // read. Once a card exists this whole block is skipped (no log spam).
    let userCapsLine = "";
    let verboseDump = "";
    let reasonsLine = "";
    if (result.cards.length === 0) {
      // getUserV2 capability objects carry a status plus a reason/status_reason
      // (per the backend skill doc) — the "why" behind a NotFulfilled rail.
      const capReason = (c: WirexCapability): unknown =>
        c.reason ?? c.status_reason ?? c.statusReason;
      const capDesc = (c: WirexCapability | null): string => {
        if (!c) return "absent";
        const reason = capReason(c);
        return reason ? `${c.status ?? "?"}(${String(reason)})` : `${c.status ?? "?"}`;
      };
      try {
        const user = await this.getUser(wallet);
        userCapsLine = ` vvc=${capDesc(user.visaVirtualCard)}`;
        verboseDump = `userCaps=${JSON.stringify(user.capabilities)} `;
        // Distinct status_reason strings across all rails — logged on their own
        // short line so the full reason text is never truncated (watch this for
        // Wirex changing the reason, e.g. after a support restart).
        const reasons = new Set<string>();
        for (const c of user.capabilities) {
          const r = capReason(c);
          if (r) reasons.add(String(r));
        }
        reasonsLine = reasons.size ? [...reasons].join(" | ") : "(none)";
      } catch (e) {
        const msg = e instanceof Error ? e.message : "unknown";
        userCapsLine = ` userCaps=err:${msg}`;
      }
      // Raw /status payload with account numbers masked — verifies the parse
      // (no field-shadowing of verification_status / capabilities).
      const rawJson = JSON.stringify(data, (key, value) =>
        RAW_STATUS_LOG_REDACT_KEYS.has(key) && value ? "[redacted]" : value,
      );
      verboseDump += `raw=${rawJson}`;
    }

    const logMeta = {
      // NOT ctx=poll — that class is muted at the default log level, and we
      // want this visible so KYC progress can be watched live.
      context: "system" as const,
      event: "STATE" as const,
      scope: "WirexService",
      action: "getStatus",
      source: "services/wirex/WirexService.ts#getStatus",
    };

    // Primary line — kept short so the console renderer never truncates the
    // status + per-rail summary.
    logWithId(
      `${LOG_EMOJI.card} WirexService.getStatus`,
      `kyc status: ${result.verificationStatus} (kyc_url=${result.kycUrl ? "present" : "none"}, cards=${result.cards.length}, banks=${result.bankAccounts.length}, caps=${JSON.stringify(result.capabilities)}${userCapsLine})`,
      undefined,
      logMeta,
    );

    // Distinct capability status_reasons on their own line — short, never
    // truncated, so the full "why" text is always readable.
    if (reasonsLine) {
      logWithId(
        `${LOG_EMOJI.card} WirexService.getStatus reasons`,
        `status_reasons: ${reasonsLine}`,
        undefined,
        logMeta,
      );
    }

    // Verbose dump on its own line (may itself truncate — secondary).
    if (verboseDump) {
      logWithId(`${LOG_EMOJI.card} WirexService.getStatus raw`, verboseDump, undefined, logMeta);
    }
    return result;
  }

  // ── Public: wallet (smart-account address + unified token balances) ──
  // GET /wallet (read-session gated — the signer of the bearer token IS the
  // wallet read; the `?wallet=` arg is ignored server-side). `wallet_address`
  // is the authoritative smart-account/deposit address. SECURITY: never log the
  // returned address or balance values.
  async getWallet(wallet: string): Promise<WirexWalletResult> {
    const data = await this.get<WalletData>(
      wirexConfig.routes.wallet,
      { wallet },
      { authorized: true },
    );
    return {
      walletAddress: data.wallet_address ?? null,
      balances: Array.isArray(data.balances)
        ? data.balances.map((b) => ({
            tokenSymbol: b.token_symbol ?? null,
            tokenAddress: b.token_address ?? null,
            balance: b.balance ?? null,
          }))
        : [],
    };
  }

  // ── Public: WEUR withdrawal to the authenticated owner's Base EOA ──
  // Wirex requires two UserOps: request the delayed withdrawal, then execute
  // it after valid_after. Both approvals stay behind this single app action.
  // There is deliberately no recipient argument: the server derives the EURC
  // destination from this same on-device EOA.
  // `onTrace` (debug tooling) receives every step with the full raw payloads;
  // production callers omit it and behavior is unchanged.

  /**
   * Resolve a prior withdrawal whose outcome was unknown after its execution
   * approval. Durable (keychain), so it survives sheet close/reopen and process
   * restart. Resumes the persisted execution session:
   *  - completed        → returns the result (the prior withdrawal went through)
   *  - definitive fail  → clears the lock, returns null (safe to start a new one)
   *  - still ambiguous  → throws WirexWithdrawUnconfirmedError (stays locked)
   * Returns null when there is no pending record.
   */
  private async reconcilePendingWithdrawal(
    wallet: string,
    trace: (label: string, data?: unknown) => void,
  ): Promise<WirexWithdrawalResult | null> {
    const key = pendingWithdrawKeyFor(wallet);
    const raw = (await getAuthData(key))?.trim();
    if (!raw) return null;
    const marker = parsePendingWithdrawMarker(raw);
    if (!marker) {
      await deleteAuthData(key);
      return null;
    }
    // The approval sessions live in the server's memory, so a deploy or restart
    // makes this one unresolvable forever — and an unresolvable marker used to
    // lock withdrawals permanently, with a factory reset the only way out. Past
    // the window the question is settled by other means: the withdrawal either
    // landed on the owner's own wallet or it never executed, and both are
    // visible in the balance. Blocking beyond it protects nothing.
    const now = Date.now();
    if (isPendingWithdrawMarkerExpired(marker, now, PENDING_WITHDRAW_MAX_AGE_MS)) {
      logWithId(
        `${LOG_EMOJI.auth} WirexService.reconcilePendingWithdrawal`,
        "pending withdrawal marker expired — clearing the lock",
        { age_ms: now - marker.at },
        {
          context: "background",
          event: "STATE",
          scope: "Wirex",
          flow: "withdrawToWallet",
          source: "services/wirex/WirexService.ts#reconcilePendingWithdrawal",
        },
      );
      await deleteAuthData(key);
      return null;
    }
    // A marker written before the `at` field existed cannot age out on its own.
    // Date it now rather than clearing it: it may guard a withdrawal that
    // crossed the point of no return moments ago, and it will expire normally
    // from here.
    const stamped = stampUndatedMarker(marker, now);
    if (stamped) {
      await storeAuthData(key, JSON.stringify(stamped));
      logWithId(
        `${LOG_EMOJI.auth} WirexService.reconcilePendingWithdrawal`,
        "undated pending withdrawal marker dated — lock kept",
        { at: stamped.at },
        {
          context: "background",
          event: "STATE",
          scope: "Wirex",
          flow: "withdrawToWallet",
          source: "services/wirex/WirexService.ts#reconcilePendingWithdrawal",
        },
      );
    }
    trace("reconcile pending withdrawal (resume execution session)");
    try {
      const result = await this.pollWithdrawalResult(
        marker.sessionId,
        "completed",
        trace,
        marker.kind === "fx" ? wirexConfig.routes.fxResult : wirexConfig.routes.withdrawResult,
      );
      if (!result.amount || !result.first_tx_hash || !result.final_tx_hash) {
        throw new Error("wirex_withdraw_result_invalid");
      }
      await deleteAuthData(key);
      return {
        ok: true,
        amount: result.amount,
        asset: String(result.asset || "").toUpperCase() === "USDC" ? "USDC" : "EURC",
        firstTxHash: result.first_tx_hash,
        finalTxHash: result.final_tx_hash,
        ...(marker.kind === "fx" ? { fx: toSwapOutcome(result.fx) } : {}),
      };
    } catch (error) {
      // A server-confirmed non-success (completed with ok:false) means the prior
      // withdrawal did NOT execute — safe to clear and let a fresh one start.
      if (error instanceof Error && error.message.startsWith("wirex_withdraw_failed")) {
        await deleteAuthData(key);
        return null;
      }
      // Timeout, network blip, unexpected status: the outcome is still unknown,
      // so the lock stays. It is released by age, never by a failed poll — a
      // transient error is not evidence the earlier withdrawal is done.
      throw new WirexWithdrawUnconfirmedError();
    }
  }

  /** Withdrawals and swaps running or queued in THIS process, before and after their marker. */
  private activeWithdrawals = 0;
  /**
   * One card money movement at a time. A withdrawal and a swap share the
   * card, its approvals and the durable outcome marker, so two in flight
   * could overwrite each other's marker and lose the at-most-once guard. The
   * turn is taken synchronously on the call, before any await, and held
   * through reconciliation and execution.
   */
  private withdrawalTurn: Promise<void> = Promise.resolve();

  private takeWithdrawalTurn<T>(run: () => Promise<T>): Promise<T> {
    const previous = this.withdrawalTurn;
    let release: () => void = () => {};
    this.withdrawalTurn = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.activeWithdrawals += 1;
    return (async () => {
      try {
        await previous;
        return await run();
      } finally {
        this.activeWithdrawals -= 1;
        release();
      }
    })();
  }

  /** Resolves once no withdrawal or swap is running or queued. */
  async whenWithdrawalsIdle(): Promise<void> {
    while (this.activeWithdrawals > 0) await this.withdrawalTurn;
  }

  /**
   * True while a card withdrawal may still be moving money: one running now,
   * or one whose outcome is unknown after its point of no return (the durable
   * marker). A pending row for a withdrawal lives exactly this long.
   */
  async hasUnresolvedWithdrawal(): Promise<boolean> {
    if (this.activeWithdrawals > 0) return true;
    const wallet = await getEthereumAddress();
    if (!wallet) return false;
    const raw = (await getAuthData(pendingWithdrawKeyFor(wallet)))?.trim();
    return !!raw;
  }

  /**
   * Whether a SEPA transfer has left the pending state on the bank feed.
   * Matched by Wirex's transfer id, and — when the feed names the transfer
   * differently — by the first outbound bank row placed after it.
   * Null when the feed cannot be read: no answer is not a verdict.
   */
  async isSepaTransferSettled(
    transferId: string,
    placedAt: string,
    amount?: number | null,
  ): Promise<boolean | null> {
    const status = await this.sepaTransferStatus(transferId, placedAt, amount);
    if (status === null) return null;
    if (status === "unlisted") return false;
    return status !== "Pending";
  }

  /**
   * The bank feed's status of a SEPA transfer: its row's own status, or
   * "unlisted" when the feed does not list it (yet). Null when the feed cannot
   * be read, or two rows could be it.
   */
  async sepaTransferStatus(
    transferId: string,
    placedAt: string,
    amount?: number | null,
  ): Promise<"Pending" | "Completed" | "Failed" | "unlisted" | null> {
    const wallet = await getEthereumAddress();
    if (!wallet) return null;
    let rows: WirexActivityItem[];
    try {
      rows = await this.getBankTransactions(wallet, 1);
    } catch {
      return null;
    }
    // Its own row, by transfer id. Failing that, the ONE outbound row placed
    // with it for the same amount; two such rows are ambiguous and no answer.
    let match = rows.find((row) => row.id === transferId) ?? null;
    if (!match && Number.isFinite(amount) && (amount ?? 0) > 0) {
      const placed = Date.parse(placedAt);
      const candidates = rows.filter((row) => {
        const at = Date.parse(row.created_at);
        const paid = Math.abs(Number(row.source_amount?.amount));
        return (
          row.direction === "Outbound" &&
          Number.isFinite(at) &&
          Math.abs(at - placed) <= 5 * 60_000 &&
          Number.isFinite(paid) &&
          Math.abs(paid - (amount ?? 0)) < 0.005
        );
      });
      if (candidates.length > 1) return null;
      match = candidates[0] ?? null;
    }
    if (!match) return "unlisted";
    return match.status;
  }

  async withdrawToWallet(
    amount: string,
    opts?: {
      onTrace?: (line: string) => void;
      /**
       * Fires once the execution approval is submitted — the user's part is
       * done and the funds are authorised and moving. Everything after this is
       * the server settling, which takes ~10s more. Callers use it to close
       * their sheet and debit optimistically instead of holding the user on a
       * spinner for a result that is already decided.
       */
      onSubmitted?: () => void;
      /**
       * Fires once the REQUEST approval is accepted — the first of the two
       * silent approvals, a few seconds in, where the whole flow runs ~20s.
       * Callers move their balances optimistically here. Nothing is final yet:
       * a failure before the execution approval's point of no return rejects
       * with an ordinary error, and one after it with
       * WirexWithdrawUnconfirmedError.
       */
      onRequestApproved?: () => void;
      /**
       * Which currency leaves the card. Defaults to EURC — the behaviour every
       * caller had before the card held dollars, and the one a server that
       * predates the parameter performs regardless.
       */
      asset?: WirexWithdrawAsset;
    },
  ): Promise<WirexWithdrawalResult> {
    // The user asked for it: it waits for a running swap, then reconciles.
    return this.takeWithdrawalTurn(() => this.runWithdrawToWallet(amount, opts));
  }

  /**
   * Swap card money into the other currency (Wirex FX). `amount` of the other
   * currency leaves the card through the same two silent approvals as a
   * withdrawal, to Wirex's swap address (the server takes it from Wirex, never
   * from here), and `to` lands back on the card. One lock with withdrawals:
   * one at a time, and an unconfirmed outcome holds it. A swap is automatic
   * and sized from a balance reading, so it never queues behind another
   * movement with a reading that may be stale: it is refused at once with
   * WirexWithdrawBusyError, and the caller asks again once
   * whenWithdrawalsIdle resolves.
   */
  async swapCardCurrency(
    to: "EUR" | "USD",
    amount: string,
    opts?: { onTrace?: (line: string) => void },
  ): Promise<WirexWithdrawalResult> {
    if (this.activeWithdrawals > 0) throw new WirexWithdrawBusyError();
    return this.takeWithdrawalTurn(() => this.runWithdrawToWallet(amount, opts, to));
  }

  private async runWithdrawToWallet(
    amount: string,
    opts?: Parameters<WirexService["withdrawToWallet"]>[1],
    swapTo?: "EUR" | "USD",
  ): Promise<WirexWithdrawalResult> {
    const trace = (label: string, data?: unknown) => {
      if (!opts?.onTrace) return;
      try {
        opts.onTrace(data === undefined ? label : `${label} ${JSON.stringify(data)}`);
      } catch {}
    };
    const traced = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
      trace(`▶ ${label}`);
      const startedAt = Date.now();
      try {
        const out = await run();
        trace(`✓ ${label} (${Date.now() - startedAt}ms)`, out);
        return out;
      } catch (error) {
        const err = error as Error;
        trace(`✗ ${label} (${Date.now() - startedAt}ms)`, {
          name: err?.name,
          message: err?.message,
          stack: err?.stack?.split("\n").slice(0, 6),
        });
        throw error;
      }
    };
    // A swap pays with the other currency's coin.
    const asset: WirexWithdrawAsset = swapTo
      ? swapTo === "USD"
        ? "EURC"
        : "USDC"
      : (opts?.asset ?? "EURC");
    const resultRoute = swapTo ? wirexConfig.routes.fxResult : wirexConfig.routes.withdrawResult;
    const normalizedAmount = amount.trim();
    // Wirex prices a swap to the cent.
    if (swapTo && !/^\d+(?:\.\d{1,2})?$/.test(normalizedAmount)) {
      throw new Error("wirex_withdraw_invalid_amount");
    }
    // Up to 6 decimals: the base tokens (EURC/USDC) carry 6, and the server
    // (wirex_withdraw_start → prepareWithdrawalRequest) parses the figure with
    // each token's own decimals, so a full card balance such as 0.995018 goes
    // out whole. More than 6 would be rounded by that parse — refused here.
    if (!/^\d+(?:\.\d{1,6})?$/.test(normalizedAmount) || Number(normalizedAmount) <= 0) {
      throw new Error("wirex_withdraw_invalid_amount");
    }

    const wallet = await getEthereumAddress();
    if (!wallet) throw new Error("wirex_withdraw_wallet_unavailable");
    trace("withdraw begin", { wallet, amount: normalizedAmount, base: this.restBaseUrl });

    const logMeta = {
      context: "user" as const,
      scope: "Wirex",
      flow: "withdrawToWallet",
      source: "services/wirex/WirexService.ts#withdrawToWallet",
    };

    // Frozen-blocker gate: a prior withdrawal left unreconciled (outcome unknown
    // after its execution approval) must be resolved BEFORE a new one can start —
    // durable across close/reopen and restart. Reconcile resumes the persisted
    // session; if it completed, return that (no second withdrawal); if still
    // unknown, this throws unconfirmed and never reaches withdrawStart.
    const reconciled = await this.reconcilePendingWithdrawal(wallet, trace);
    // The earlier operation was the same kind: its outcome is this one's answer.
    // A settled operation of the other kind only freed the lock.
    if (reconciled && Boolean(reconciled.fx) === Boolean(swapTo)) return reconciled;

    const start = swapTo
      ? await traced(`POST ${wirexConfig.routes.fxStart}`, () =>
          this.postAuthorized<WithdrawalStartData>(wirexConfig.routes.fxStart, {
            to: swapTo,
            amount: normalizedAmount,
          }),
        )
      : await traced(`POST ${wirexConfig.routes.withdrawStart}`, () =>
          this.post<WithdrawalStartData>(wirexConfig.routes.withdrawStart, {
            wallet,
            amount: normalizedAmount,
            asset,
          }),
        );
    if (!start.approval_url || !start.session_id) {
      throw new Error("wirex_withdraw_start_invalid");
    }
    // Nothing has been signed yet, so this is the last free moment to refuse.
    // A server too old to know the parameter answers a dollar withdrawal by
    // preparing a euro one and saying nothing; taking its silence for agreement
    // would move the wrong money.
    if ((swapTo || asset !== "EURC") && String(start.asset || "").toUpperCase() !== asset) {
      throw new Error("wirex_withdraw_asset_not_supported");
    }

    await traced("submit request approval (EOA sign + callback POST)", () =>
      submitSignedApproval({
        approvalUrl: start.approval_url,
        sign: this.buildSigner(),
      }),
    );
    logWithId(
      `${LOG_EMOJI.auth} WirexService.withdrawToWallet`,
      "withdrawal request approved",
      undefined,
      { ...logMeta, event: "SECURITY" },
    );
    try {
      opts?.onRequestApproved?.();
    } catch {}

    const execution = await traced("poll result → approval_required", () =>
      this.pollWithdrawalResult(start.session_id, "approval_required", trace, resultRoute),
    );
    if (!execution.approval_url || !execution.session_id) {
      throw new Error("wirex_withdraw_execute_approval_invalid");
    }

    // The point of no return is the execution approval's callback POST — it can
    // reach the server even if its response is lost. submitSignedApproval parses
    // and SIGNS locally first, so persist the durable record via
    // onBeforeCallbackPost (fired right before that POST): a lost/timed-out
    // response still leaves a marker to reconcile, but a signing/biometric
    // failure BEFORE the POST writes nothing and never locks the wallet. Keychain,
    // WHEN_UNLOCKED (no biometric prompt); the session is never logged.
    let crossedPointOfNoReturn = false;
    try {
      await traced("submit execution approval (EOA sign + callback POST)", () =>
        submitSignedApproval({
          approvalUrl: execution.approval_url,
          sign: this.buildSigner(),
          onBeforeCallbackPost: async () => {
            await storeAuthData(
              pendingWithdrawKeyFor(wallet),
              JSON.stringify({
                sessionId: execution.session_id,
                at: Date.now(),
                ...(swapTo ? { kind: "fx" } : {}),
              }),
            );
            crossedPointOfNoReturn = true;
          },
        }),
      );
    } catch (error) {
      if (crossedPointOfNoReturn) {
        // The POST may have crossed the point of no return — unconfirmed; the
        // durable record (already written) is owned by reconcile.
        trace("execution approval submit failed after the point of no return", {
          message: error instanceof Error ? error.message : String(error),
        });
        throw new WirexWithdrawUnconfirmedError();
      }
      // Failed before the callback POST (parse / local sign / biometric cancel):
      // nothing moved and no record was written — a plain retryable failure.
      throw error;
    }
    logWithId(
      `${LOG_EMOJI.auth} WirexService.withdrawToWallet`,
      "withdrawal execution approved",
      undefined,
      { ...logMeta, event: "SECURITY" },
    );
    try {
      opts?.onSubmitted?.();
    } catch {}

    // Point of no return already crossed above. Any failure to CONFIRM the outcome
    // from here is ambiguous and must NOT surface as a safely-retryable failure —
    // a retry would authorize a second withdrawal. Convert every post-approval
    // failure (poll error, budget exhaustion, or an invalid result) into the
    // dedicated unconfirmed error so the UI can hold a non-retryable pending state.
    let result: WithdrawalResultData;
    try {
      result = await traced("poll result → completed", () =>
        this.pollWithdrawalResult(execution.session_id, "completed", trace, resultRoute),
      );
      if (!result.amount || !result.first_tx_hash || !result.final_tx_hash) {
        throw new Error("wirex_withdraw_result_invalid");
      }
    } catch (error) {
      trace("withdrawal unconfirmed after execution approval", {
        message: error instanceof Error ? error.message : String(error),
      });
      throw new WirexWithdrawUnconfirmedError();
    }

    // Confirmed complete → drop the durable pending record.
    await deleteAuthData(pendingWithdrawKeyFor(wallet));
    return {
      ok: true,
      amount: result.amount,
      // What the server says moved. Only a server that named USDC withdrew
      // dollars; anything else — including silence — was euros.
      asset: String(result.asset || "").toUpperCase() === "USDC" ? "USDC" : "EURC",
      firstTxHash: result.first_tx_hash,
      finalTxHash: result.final_tx_hash,
      ...(swapTo ? { fx: toSwapOutcome(result.fx) } : {}),
    };
  }

  private async pollWithdrawalResult(
    sessionId: string,
    target: "approval_required" | "completed",
    trace?: (label: string, data?: unknown) => void,
    route: string = wirexConfig.routes.withdrawResult,
  ): Promise<WithdrawalResultData> {
    const deadline = Date.now() + WITHDRAW_POLL_TIMEOUT_MS;
    let interval = WITHDRAW_POLL_START_INTERVAL_MS;
    for (let attempt = 0; Date.now() < deadline; attempt++) {
      let data: WithdrawalResultData;
      try {
        data = await this.get<WithdrawalResultData>(route, {
          session_id: sessionId,
        });
      } catch (error) {
        // The reason the request itself failed — a dead session, a 4xx, a parse
        // error — is what tells the difference between "not ready yet" and
        // "this can never succeed", and it used to be swallowed by the caller.
        errorWithId(
          `${LOG_EMOJI.auth} WirexService.pollWithdrawalResult`,
          `poll #${attempt + 1} target=${target} request failed`,
          { reason: error instanceof Error ? error.message : String(error) },
          {
            context: "background",
            event: "API_ERR",
            scope: "Wirex",
            flow: "withdrawToWallet",
            source: "services/wirex/WirexService.ts#pollWithdrawalResult",
          },
        );
        throw error;
      }
      trace?.(`poll#${attempt} ${route} target=${target}`, data);
      if (target === "approval_required" && data.status === "approval_required") return data;
      if (target === "completed" && data.status === "completed") {
        if (data.ok !== true) {
          throw new Error("wirex_withdraw_failed:completed");
        }
        return data;
      }

      const stillWaiting =
        data.status === "pending" ||
        data.status === "waiting" ||
        (target === "completed" && data.status === "approval_required");
      if (!stillWaiting) {
        throw new Error(`wirex_withdraw_unexpected_status:${data.status ?? "unknown"}`);
      }
      await sleep(interval);
      interval = Math.min(POLL_INTERVAL_MS, Math.round(interval * 1.5));
    }
    throw new Error("wirex_withdraw_timeout");
  }

  // ── Public: issue an additional virtual card ─────────────────────────
  // POST /card/virtual for an account that already onboarded. The app signs
  // locally (EIP-191 over the exact string the server rebuilds and recovers the
  // signer from, ±5 min, single-use) — the read session does NOT authorize this
  // write. `card_name` / `name_on_card` are optional; blank ones are omitted from
  // the body and signed as the empty string, leaving the server's defaults. Both
  // are validated locally first (no ";"/newline, 1–50 / 2–26 chars) so a name the
  // server would 400 on never reaches the passkey prompt.
  //
  // `wallet` is taken from the signer, never from a caller: it must be the owner
  // EOA that produced `signature` (mismatch → `signature_does_not_match_wallet`),
  // and the server forwards that same address to Wirex as X-User-Wallet — the
  // smart-account address would be the wrong identity there.
  //
  // NEVER retry this call: the server rejects a replayed signature
  // (`signature_replayed`), so a retry needs a FRESH signature, and a fresh
  // signature on a request that actually succeeded issues a SECOND card. On any
  // error, read getStatus() and look at `cards[]` instead — a card that made it
  // through is already there. `reconciled: true` is the server telling us the
  // response of an earlier attempt was lost and this card already existed.
  //
  // Documented rejections: `visa_virtual_card_capability_not_active`,
  // `phone_number_missing`, `wirex_card_snapshot_failed`, `signature_replayed`.
  // The new card appears in `cards[]` only after a fresh getStatus() read.
  async issueVirtualCard(
    params: { cardName?: string; nameOnCard?: string } = {},
  ): Promise<WirexIssuedCard> {
    const cardName = params.cardName?.trim() || undefined;
    const nameOnCard = params.nameOnCard?.trim() || undefined;
    // Validate before signing: a rejected name must never cost a passkey tap.
    assertWirexVirtualCardNames({ cardName, nameOnCard });
    const ts = Math.floor(Date.now() / 1000);
    const message = buildWirexIssueVirtualCardMessage({ cardName, nameOnCard, ts });
    const { address, signature } = await this.buildSigner()({ message });
    const path = wirexConfig.routes.cardIssueVirtual;
    const data = await this.post<CardIssueVirtualData>(path, {
      wallet: address,
      ts,
      signature,
      ...(cardName ? { card_name: cardName } : {}),
      ...(nameOnCard ? { name_on_card: nameOnCard } : {}),
    });
    const cardId = typeof data.card_id === "string" && data.card_id ? data.card_id : null;
    if (!cardId) {
      throw new Error(`${LOG_TAG} POST ${path} returned no card_id`);
    }
    const reconciled = data.reconciled === true;
    logWithId(
      `${LOG_EMOJI.card} WirexService.issueVirtualCard`,
      reconciled
        ? "virtual card already existed (server reconciled a lost response)"
        : "issued an additional virtual card",
      { card_id: cardId, reconciled },
      {
        source: "services/wirex/WirexService.ts#issueVirtualCard",
        scope: "WirexService",
        event: "STATE",
        context: "system",
      },
    );
    return { cardId, card: data.card ?? null, reconciled };
  }

  // ── Public: card management (status / freeze / unfreeze / limit) ─────
  // Reads are light (Wirex-direct, no onboarding re-sync) but read-session gated.
  // Mutations sign the
  // exact action string the server rebuilds and verifies (recovered signer must
  // equal `wallet`), valid ±5 minutes — see lib/wirex/cardActionMessage.ts.
  async getCardStatus(wallet: string, cardId: string): Promise<WirexCardStatus> {
    const data = await this.get<{ card_id: string; card: Record<string, unknown> | null }>(
      wirexConfig.routes.cardStatus,
      { wallet, card_id: cardId },
      { authorized: true },
    );
    const card = data.card ?? {};
    const status = typeof card.status === "string" ? card.status : null;
    return {
      cardId,
      status,
      isFrozen: status === "Blocked",
      limit: (card.limit as WirexCardLimit | undefined) ?? null,
    };
  }

  async getCardLimits(wallet: string, cardId: string): Promise<WirexCardLimit | null> {
    const data = await this.get<{ card_id: string; limit: WirexCardLimit | null }>(
      wirexConfig.routes.cardLimits,
      { wallet, card_id: cardId },
      { authorized: true },
    );
    return data.limit ?? null;
  }

  // GET /card/transactions?page=<n> (read-session gated). Returns the
  // Wirex activity feed filtered to card transactions, verbatim.
  async getCardTransactions(
    wallet: string,
    page = 1,
    opts: WirexActivityPageOptions = {},
  ): Promise<WirexActivityItem[]> {
    return this.getActivityPage(wirexConfig.routes.cardTransactions, wallet, page, opts);
  }

  // GET /bank/transactions?page=<n> (read-session gated). Same activity-feed
  // shape as /card/transactions, filtered to bank rails (Sepa/AchPush/…).
  async getBankTransactions(
    wallet: string,
    page = 1,
    opts: WirexActivityPageOptions = {},
  ): Promise<WirexActivityItem[]> {
    return this.getActivityPage(wirexConfig.routes.bankTransactions, wallet, page, opts);
  }

  private async getActivityPage(
    route: string,
    wallet: string,
    page: number,
    opts: WirexActivityPageOptions,
  ): Promise<WirexActivityItem[]> {
    const query: Record<string, string> = { wallet, page: String(page) };
    if (opts.pageSize) query.page_size = String(opts.pageSize);
    const data = await this.get<WirexCardTransactionsResponse>(route, query, {
      authorized: true,
      cachedSessionOnly: opts.cachedSessionOnly,
    });
    return Array.isArray(data?.transactions) ? data.transactions : [];
  }

  // ── Public: merged activity feed (card + bank + onchain deposits) ─────
  // Orchestrates the three rails into a single sorted `ActivityItem`
  // list for `components/ActivitySheet`. Each sub-feed is isolated: a failure
  // in one rail degrades to an empty list for that rail, never blanks the feed.
  // SECURITY: never log the resolved AA address.
  // `onBankCounterpartyPress` wires bank-rail rows (known counterparty IBAN)
  // to the caller's send-again flow.
  /**
   * The account's activity, merged from up to three rails. `rails` narrows it:
   * the IBAN row asks for "bank" alone, because a SEPA statement must not carry
   * card payments or on-chain deposits. Omitted = all three, as before.
   */
  async getActivityFeed(
    wallet: string,
    onBankCounterpartyPress?: (counterparty: WirexBankCounterparty) => void,
    rails?: Array<"card" | "bank" | "deposits">,
  ): Promise<ActivityItem[]> {
    const wants = (rail: "card" | "bank" | "deposits") => !rails || rails.includes(rail);
    // The AA/smart-account address is the deposit target for the onchain scan —
    // skipped entirely when deposits are not wanted, so a bank-only feed costs
    // one request instead of three.
    let aaAddress = "";
    if (wants("deposits")) {
      try {
        aaAddress = (await this.getWallet(wallet)).walletAddress ?? "";
      } catch (e) {
        console.log(`${LOG_TAG} getActivityFeed: wallet resolve failed`, {
          message: e instanceof Error ? e.message : "unknown",
        });
      }
    }

    // FX rates power the secondary "≈ <display currency>" line on rows paid in
    // another currency. Fetched once and shared across all three rails;
    // unavailable rates simply drop the line.
    const rates = await fxRateService.getRates().catch((): undefined => undefined);
    const home = homeCurrencyService.getHomeCurrency();

    const [card, bank, deposits] = await Promise.all([
      !wants("card")
        ? Promise.resolve([] as ActivityItem[])
        : this.getCardTransactions(wallet)
            .then((items) => mapWirexCardTransactions(items, rates, home))
            .catch((e) => {
              console.log(`${LOG_TAG} getActivityFeed: card feed failed`, {
                message: e instanceof Error ? e.message : "unknown",
              });
              return [] as ActivityItem[];
            }),
      !wants("bank")
        ? Promise.resolve([] as ActivityItem[])
        : this.getBankTransactions(wallet)
            .then((items) => mapWirexBankActivity(items, rates, onBankCounterpartyPress, home))
            .catch((e) => {
              console.log(`${LOG_TAG} getActivityFeed: bank feed failed`, {
                message: e instanceof Error ? e.message : "unknown",
              });
              return [] as ActivityItem[];
            }),
      aaAddress && wants("deposits")
        ? fetchWirexDeposits(aaAddress, rates, home).catch(() => [] as ActivityItem[])
        : Promise.resolve([] as ActivityItem[]),
    ]);

    return mergeWirexActivity(card, bank, deposits);
  }

  // ── Public: SEPA (EUR payout) estimate + transfer ────────────────────
  // SEPA settles from a single unified-balance token (Wirex FX-converts if it
  // isn't EUR-pegged). `estimation_id`'s exact field name is undocumented, so
  // parse it defensively. SECURITY: never log IBANs, amounts, or addresses.
  // Validate an IBAN and derive its BIC/bank via the server (POST /iban/lookup).
  // Read-only, unsigned — the app calls it (e.g. on IBAN blur) to autofill the
  // BIC and show the bank name before the signed transfer. `valid:false` returns
  // messages to display; `needs_manual_bic` means the IBAN is fine but the BIC
  // must be entered by hand. Sign with the returned normalized `iban`.
  async ibanLookup(iban: string): Promise<WirexIbanLookup> {
    const data = await this.post<{
      valid?: boolean;
      iban?: string | null;
      bic?: string | null;
      bank?: { name?: string | null } | null;
      needs_manual_bic?: boolean;
      messages?: string[];
    }>(wirexConfig.routes.ibanLookup, { iban });
    return {
      valid: data?.valid === true,
      iban: data?.iban ?? null,
      bic: data?.bic ?? null,
      bankName: data?.bank?.name ?? null,
      needsManualBic: data?.needs_manual_bic === true,
      messages: Array.isArray(data?.messages) ? data.messages : [],
    };
  }

  async sepaEstimate(params: {
    wallet: string;
    accountId: string;
    amount: string;
    iban: string;
    bic: string;
    recipientName: string;
    tokenAddress?: string;
    reference?: string;
  }): Promise<WirexSepaEstimate> {
    const body: Record<string, unknown> = {
      wallet: params.wallet,
      account_id: params.accountId,
      amount: params.amount,
      iban: params.iban,
      bic: params.bic,
      recipient_name: params.recipientName,
    };
    if (params.tokenAddress) body.token_address = params.tokenAddress;
    if (params.reference) body.reference = params.reference;
    const data = await this.post<{ ok?: boolean; estimation?: Record<string, unknown> | null }>(
      wirexConfig.routes.sepaEstimate,
      body,
    );
    const est = (data?.estimation ?? null) as Record<string, unknown> | null;
    const rawId = est ? (est.estimation_id ?? est.id) : null;
    const estimationId = rawId != null && String(rawId).trim() ? String(rawId) : null;
    return { ok: data?.ok !== false, estimationId, raw: est };
  }

  // Money-out MUST carry the owner's signature — the live server rejects an
  // unsigned transfer. Sign the exact terms (amount + destination IBAN + ts) with
  // the on-device passkey EOA; the server rebuilds the string, recovers the signer
  // and requires signer == wallet (±5 min, single-use) — same gate as freeze/
  // unfreeze. IBAN is normalised and `amount` canonicalised to a number so both
  // sides hash the identical string. `wallet` comes from the signer (not the
  // caller), so the signature always matches the address we send.
  async sepaTransfer(params: {
    wallet: string;
    accountId: string;
    tokenAddress: string;
    iban: string;
    amount: string;
    bic: string;
    recipientName: string;
    reference?: string;
    estimationId: string;
  }): Promise<WirexSepaTransferResult> {
    const iban = params.iban.replace(/\s+/g, "").toUpperCase();
    const amount = Number(params.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`${LOG_TAG} sepaTransfer: invalid amount`);
    }
    const ts = Math.floor(Date.now() / 1000);
    const message = buildWirexSepaTransferMessage({ amount, iban, ts });
    const { address, signature } = await this.buildSigner()({ message });
    const body: Record<string, unknown> = {
      wallet: address,
      account_id: params.accountId,
      token_address: params.tokenAddress,
      iban,
      bic: params.bic,
      amount,
      recipient_name: params.recipientName,
      estimation_id: params.estimationId,
      ts,
      signature,
    };
    if (params.reference) body.reference = params.reference;
    const data = await this.post<{ ok?: boolean; transfer_id?: string | null; result?: unknown }>(
      wirexConfig.routes.sepaTransfer,
      body,
    );
    return {
      ok: data?.ok !== false,
      transferId: data?.transfer_id ?? null,
      raw: data?.result ?? null,
    };
  }

  // ── Push to card ────────────────────────────────────────────────────
  // Saved payout cards and quotes are read-session gated; the transfer itself is
  // money-out and carries the owner's signature over the server's quote.
  async listPayoutCards(): Promise<WirexPayoutCard[]> {
    const data = await this.get<{ cards?: unknown }>(
      wirexConfig.routes.payoutCards,
      {},
      { authorized: true },
    );
    return Array.isArray(data.cards) ? data.cards.flatMap(toPayoutCard) : [];
  }

  // The card number goes to the server once, which hands it to Wirex's PCI
  // tokenizer and keeps only the token. SECURITY: never log it.
  async addPayoutCard(params: {
    cardNumber: string;
    cardholderName: string;
  }): Promise<WirexPayoutCard> {
    const data = await this.postAuthorized<{ card?: unknown }>(wirexConfig.routes.payoutCards, {
      card_number: params.cardNumber.replace(/\s+/g, ""),
      cardholder_name: params.cardholderName.trim(),
    });
    const card = toPayoutCard(data.card)[0];
    if (!card) throw new Error(`${LOG_TAG} addPayoutCard: no card returned`);
    return card;
  }

  async cardTransferEstimate(params: {
    recipientId: string;
    amount: string;
    currency: "EUR" | "USD";
    tokenAddress: string;
  }): Promise<WirexCardTransferQuote> {
    const data = await this.postAuthorized<{
      estimation_id?: unknown;
      amount?: unknown;
      currency?: unknown;
      card?: unknown;
      debit?: { amount?: unknown } | null;
      fee_amount?: unknown;
    }>(wirexConfig.routes.cardTransferEstimate, {
      recipient_id: params.recipientId,
      amount: Number(params.amount),
      currency: params.currency,
      token_address: params.tokenAddress,
    });
    const card = toPayoutCard(data.card)[0];
    const amount = Number(data.amount);
    if (typeof data.estimation_id !== "string" || !card || !(amount > 0)) {
      throw new Error(`${LOG_TAG} cardTransferEstimate: incomplete quote`);
    }
    const debit = Number(data.debit?.amount);
    const fee = Number(data.fee_amount);
    return {
      estimationId: data.estimation_id,
      amount,
      currency: String(data.currency),
      card,
      debitAmount: Number.isFinite(debit) && debit > 0 ? debit : null,
      feeAmount: data.fee_amount != null && Number.isFinite(fee) ? fee : null,
    };
  }

  // Signs the quote exactly as the server stored it; the server rebuilds the
  // same string from that quote and executes it once.
  async cardTransfer(quote: WirexCardTransferQuote): Promise<WirexSepaTransferResult> {
    const ts = Math.floor(Date.now() / 1000);
    const message = buildWirexCardTransferMessage({
      amount: quote.amount,
      currency: quote.currency,
      last4: quote.card.last4,
      estimationId: quote.estimationId,
      ts,
    });
    const { address, signature } = await this.buildSigner()({ message });
    const data = await this.post<{ ok?: boolean; transfer_id?: string | null }>(
      wirexConfig.routes.cardTransfer,
      { wallet: address, estimation_id: quote.estimationId, ts, signature },
    );
    return { ok: data?.ok !== false, transferId: data?.transfer_id ?? null, raw: data };
  }

  private async signedCardAction(
    action: "freeze" | "unfreeze" | "set-limit" | "close",
    cardId: string,
    extra: { limit?: number; last4?: string } = {},
  ): Promise<CardActionData> {
    const { limit, last4 } = extra;
    const ts = Math.floor(Date.now() / 1000);
    const message = buildWirexCardActionMessage({ action, cardId, ts, limit, last4 });
    const { address, signature } = await this.buildSigner()({ message });
    const path =
      action === "freeze"
        ? wirexConfig.routes.cardFreeze
        : action === "unfreeze"
          ? wirexConfig.routes.cardUnfreeze
          : action === "close"
            ? wirexConfig.routes.cardClose
            : wirexConfig.routes.cardSetLimit;
    return this.post<CardActionData>(path, {
      wallet: address,
      card_id: cardId,
      ts,
      signature,
      ...(action === "set-limit" ? { limit } : {}),
      // Sent for close only, and it MUST be the same value that went into the
      // signed string — the server verifies both.
      ...(action === "close" ? { last4 } : {}),
    });
  }

  async freezeCard(cardId: string): Promise<void> {
    await this.signedCardAction("freeze", cardId);
  }

  async unfreezeCard(cardId: string): Promise<void> {
    await this.signedCardAction("unfreeze", cardId);
  }

  // PERMANENTLY close a card. Wirex cannot reopen a closed card and offers no
  // reissue route, so a replacement is issueVirtualCard() FIRST — confirmed in a
  // fresh getStatus() — and only then closeCard(). Never close first: whether
  // Wirex issues a second card is unproven, and a failed issue would leave the
  // user with no card at all. Freeze/unfreeze is the reversible option and the
  // right default for "card lost"; a caller MUST take an explicit user
  // confirmation before this runs, because the signature prompt itself is the
  // point of no return.
  //
  // `last4` is the value the USER was shown (from /status cards[]): it is signed
  // and re-checked server-side against Wirex, so a card_id/last4 pair that don't
  // belong together is rejected (card_last4_mismatch) rather than closing some
  // other card. The server checks the format first (`last4_must_be_4_digits`), so
  // anything but four digits fails here — before the signature prompt.
  // The envelope can be ok:true while the inner payload reports the Wirex-side
  // failure, so the inner `ok` is checked here.
  async closeCard(cardId: string, last4: string): Promise<void> {
    const digits = last4?.trim() ?? "";
    if (!isWirexCardLast4(digits)) {
      throw new Error(`${LOG_TAG} closeCard requires the 4 digits shown to the user`);
    }
    const data = await this.signedCardAction("close", cardId, { last4: digits });
    if (data?.ok === false) {
      throw new Error(
        `${LOG_TAG} POST ${wirexConfig.routes.cardClose} failed: ${this.getErrorString(data.error)}`,
      );
    }
    logWithId(
      `${LOG_EMOJI.card} WirexService.closeCard`,
      "card permanently closed",
      { card_id: cardId },
      {
        source: "services/wirex/WirexService.ts#closeCard",
        scope: "WirexService",
        event: "STATE",
        context: "system",
      },
    );
  }

  async setCardLimit(cardId: string, limit: number): Promise<void> {
    await this.signedCardAction("set-limit", cardId, { limit });
  }

  // ── Public: in-app 3DS challenge (pending list + signed respond) ─────
  // GET /3ds/pending (read-session gated, same posture as the other card
  // reads). Entries without a transaction_id are dropped — it's the respond
  // key, so an entry without it is unactionable.
  async list3dsPending(wallet: string): Promise<Wirex3dsChallenge[]> {
    const data = await this.get<ThreeDsPendingData>(
      wirexConfig.routes.threeDsPending,
      { wallet },
      { authorized: true },
    );
    const challenges = Array.isArray(data.challenges) ? data.challenges : [];
    const result: Wirex3dsChallenge[] = [];
    for (const c of challenges) {
      if (typeof c.transaction_id !== "string" || c.transaction_id.length === 0) continue;
      result.push({
        cardId: c.card_id ?? null,
        transactionId: c.transaction_id,
        merchantName: c.merchant_name ?? null,
        amount: c.amount ?? null,
        currency: c.currency ?? null,
        cardLast4: c.card_last_4 ?? null,
      });
    }
    return result;
  }

  // Deliberate-tap consent contract: the user's approve/decline tap signs the
  // exact string the server rebuilds and verifies (recovered signer == wallet,
  // ±5-min window, one-time replay), then the server forwards the decision to
  // Wirex approve/decline. `wallet` comes from the signer (not the caller), so
  // the signature always matches the address we send. NOTE: not this.post() —
  // the contract's success response is `200 { "ok": true }` with no data
  // payload, and unwrap() throws on missing data. SECURITY: never log the
  // signature, the private key, or the full wallet address.
  async respond3ds(params: { transactionId: string; approve: boolean }): Promise<void> {
    const { transactionId, approve } = params;
    const ts = Math.floor(Date.now() / 1000);
    const message = buildWirex3dsResponseMessage({ approve, transactionId, ts });
    const { address, signature } = await this.buildSigner()({ message });
    console.log(`${LOG_TAG} respond3ds: submitting`, { approve, transaction_id: transactionId });
    const label = `POST ${wirexConfig.routes.threeDsRespond}`;
    const response = await fetch(`${this.restBaseUrl}${wirexConfig.routes.threeDsRespond}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        wallet: address,
        transaction_id: transactionId,
        approve,
        ts,
        signature,
      }),
    });
    const envelope = await this.parseEnvelope<unknown>(response, label);
    if (envelope.ok !== true) {
      throw new Error(`${LOG_TAG} ${label} failed: ${this.getErrorString(envelope.error)}`);
    }
  }

  // ── Public: reveal full card details (PAN/CVV) ───────────────────────
  // Mirrors the onboard→sign→poll pattern: start a bridge session, sign the
  // approval on-device, then poll until the backend returns the decrypted
  // card payload, parsed into { cardNumber, expiry, cvv }. SECURITY: the parsed
  // values are never logged. Live backend shape: details = { card_number,
  // expiry_date }; cvv = { cvv } (occasionally a bare string) — handled below.
  async revealCardDetails(params: {
    wallet: string;
    cardId: string;
    credentialId?: string | null;
  }): Promise<WirexCardDetailsResult> {
    const { wallet, cardId, credentialId } = params;
    console.log(`${LOG_TAG} revealCardDetails: starting`, { cardId });

    // 1) Begin the reveal → approval_url to sign.
    const start = await this.post<CardDetailsStartData>(wirexConfig.routes.cardDetailsStart, {
      wallet,
      card_id: cardId,
      ...(credentialId ? { credential_id: credentialId } : {}),
    });

    // 2) Sign + submit the approval on-device.
    await submitSignedApproval({
      approvalUrl: start.approval_url,
      sign: this.buildSigner(),
      credentialIdB64u: credentialId ?? undefined,
    });

    // 3) Poll card/details/result until the payload is ready.
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      const data = await this.get<CardDetailsResultData>(wirexConfig.routes.cardDetailsResult, {
        session_id: start.session_id,
      });
      // Only an actual payload counts as success. A terminal status without
      // payload means Wirex rejected the reveal — throw so the caller shows
      // its retry state instead of an empty details modal.
      if (data.details != null || data.cvv != null) {
        return { cardId, ...parseWirexCardDetails(data) };
      }
      if (data.status != null && data.status !== "pending" && data.status !== "waiting") {
        throw new Error(`${LOG_TAG} card/details/result terminal status "${data.status}"`);
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(
      `${LOG_TAG} card/details/result still pending after ${POLL_MAX_ATTEMPTS} attempts`,
    );
  }

  // ── Public: the account's user record (read-session gated) ──
  async getUser(wallet: string): Promise<WirexUser> {
    const data = await this.get<WirexUserData>(
      wirexConfig.routes.physicalEligibility,
      { wallet },
      { authorized: true },
    );
    const profile = data.user?.profile;
    const holderName =
      [profile?.first_name, profile?.last_name]
        .map((part) => (typeof part === "string" ? part.trim() : ""))
        .filter(Boolean)
        .join(" ") || null;
    const identity = readAccountIdentity(data);
    return {
      visaVirtualCard: data.visa_virtual_card ?? null,
      capabilities: Array.isArray(data.capabilities) ? data.capabilities : [],
      holderName,
      email: identity.email,
      country: identity.country,
      raw: data,
    };
  }
}

// Sumsub KYC URLs carry the Sumsub client id as a query param. The exact param
// name isn't guaranteed by the API doc, so try the common candidates and return
// null if none are present — the KYC UI can also derive it.
// TODO(verify): confirm the actual Sumsub query param name once a live kyc_url
// is available; adjust the candidate list if needed.
function parseSumsubClientId(kycUrl: string): string | null {
  try {
    const params = new URL(kycUrl).searchParams;
    return params.get("clientId") ?? params.get("client_id") ?? params.get("levelName") ?? null;
  } catch {
    return null;
  }
}

export const wirexService = new WirexService();

function toPayoutCard(raw: unknown): WirexPayoutCard[] {
  const c = raw as {
    recipient_id?: unknown;
    name?: unknown;
    last4?: unknown;
    currencies?: unknown;
  } | null;
  if (!c || typeof c.recipient_id !== "string" || typeof c.last4 !== "string") return [];
  return [
    {
      recipientId: c.recipient_id,
      name: typeof c.name === "string" ? c.name : "",
      last4: c.last4,
      currencies: Array.isArray(c.currencies)
        ? c.currencies.filter((x): x is string => typeof x === "string")
        : [],
    },
  ];
}
