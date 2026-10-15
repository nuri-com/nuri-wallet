// services/wirex/WirexAccountService.ts
// App-lifetime singleton that owns the Wirex account state: real Wirex status
// (verification / IBAN / card) plus the smart-account address + unified token
// balance (summed to EUR) from the backend /wallet endpoint. Single source of
// truth for the Wirex account — screens subscribe via useWirexCard (and the
// wallet screen later). Pure data + orchestration — no UI. All API and signing
// logic lives in services/wirex/WirexService.ts.
// SECURITY: never logs the wallet address, balance value, IBAN, or card details.
// The cold-start snapshot below is persisted to the Keychain (never plain
// storage) and holds no card secrets — the PAN/CVV/PIN reveal is request-only.
import {
  deleteAuthData,
  getAuthData,
  getEthereumAddress,
  storeAuthData,
} from "../../lib/secureKeyStorage";
import { wirexService } from "./WirexService";
import { fxRateService } from "../pricing/FxRateService";
import {
  BALANCE_CACHE_KEYS,
  clearCachedBalance,
  getCachedBalance,
  setCachedBalance,
} from "../balance/BalanceCacheService";
import { CARD_BALANCE_POLL_INTERVAL_MS } from "../../config/constants";
import { createForegroundPoller, type ForegroundPoller } from "../app/ForegroundPoller";
import type { FiatCode } from "../../lib/tokens";
import { EventBus } from "../events/AppEventBusService";
import { errorWithId, LOG_EMOJI, logWithId } from "../../lib/OperationLogUtils";
import { clearOptimisticMoves } from "../../lib/balance/pendingOptimisticMoves";
import { isWirexCardLast4 } from "../../lib/wirex/cardActionMessage";
import { isAwaitingReplacementCard } from "../../lib/wirex/cardState";
import {
  addOptimisticMove,
  anchorTarget,
  decideAnchoredBalance,
  dropOptimisticMove,
  type OptimisticAnchor,
} from "../../lib/balance/optimisticAnchor";

type WirexStatus = Awaited<ReturnType<typeof wirexService.getStatus>>;

// GET /status re-runs the full onboarding sync server-side (up to 90s) — far too
// heavy for every tab mount. Module-level cache; bypassed only by explicit refetch.
// ponytail: in-memory TTL cache; a lightweight MCP status read replaces it later.
let statusCache: { wallet: string; at: number; value: WirexStatus } | null = null;
const STATUS_TTL_MS = 60_000;
type SnapshotCacheEntry = { wallet: string; at: number; value: WirexCardSnapshot };
let snapshotCache: SnapshotCacheEntry | null = null;
// `getStatus` throwing is indistinguishable from "this wallet has no account"
// (see load()), so the failure path falls back to the not-onboarded cohort and
// leans on preserveVisibleSnapshot to keep an existing user's account on screen.
// That only works while snapshotCache holds something — and it is module state,
// so it dies with the JS runtime. On a cold start (app killed / evicted / OTA
// applied) the very first status read has nothing behind it, and one slow or
// failed call drops an onboarded user onto the "Start verification" CTA.
// Persisting the last displayable snapshot gives that first read a floor to fall
// back to. Read ONLY to seed the cache before the first load — never in place of
// a live read — and bounded by a max age so a closed account cannot linger.
// Emitted when a status read observes KYC flipping to Approved with the app
// already open. The provisioning repair listens for it (#1090).
export const WIREX_VERIFICATION_APPROVED_EVENT = "wirex:verificationApproved";
export const WIREX_SNAPSHOT_CACHE_KEY = "@cache:wirexSnapshot";
const SNAPSHOT_PERSIST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Last known per-token raw balance (decimal string), per wallet. A null balance
// from /wallet is a failed per-token read, not a 0 — one bad read must never
// corrupt the EUR total, so the sum falls back to this and a silent retry runs.
let tokenBalanceCache: { wallet: string; byToken: Record<string, string> } | null = null;
const BANK_DETAILS_POLL_INTERVAL_MS = 3000;
const BANK_DETAILS_POLL_MAX_ATTEMPTS = 40;
const BALANCE_RETRY_INTERVAL_MS = 15_000;
const BALANCE_RETRY_MAX_ATTEMPTS = 5;
// How long an optimistic balance outranks a live read.
// Debit (withdraw): the Wirex ledger keeps serving the pre-withdrawal figure for
// a few seconds, so without a hold the screen snaps back up right after showing
// the new number.
// Credit (wallet → card): longer, because more has to happen — the EURC transfer
// confirms on Base, then Wirex swaps EURC↔WEUR, and only then does the balance
// move. Past this window an unlanded top-up is no longer worth claiming, and the
// true figure is the honest one to show.
const OPTIMISTIC_DEBIT_HOLD_MS = 60_000;
const OPTIMISTIC_CREDIT_HOLD_MS = 180_000;

// The tokens the /wallet unified balance returns → their fiat currency, used to
// convert each to EUR. Unknown symbols are skipped.
//
// The account holds its two synthetics and NOTHING else: the euro pocket is
// WEUR, the dollar pocket is WUSD. `balances[]` enumerates the whole
// TokensRegistry, so EURC, USDC, USDT and DAI appear in it and are always zero —
// a deposit is wrapped on arrival (EURC→WEUR, USDC→WUSD, both at 1.0), so the
// base token never sits in the account, and USDT and DAI have no synthetic to be
// wrapped into at all. Confirmed against every registered mainnet account: no
// account has ever held a nonzero balance of any of the four.
// Counting only these two also makes the displayed figure exactly what the
// withdrawal route pays out, since both unwrap (WEUR→EURC, WUSD→USDC).
// The base tokens still matter where a deposit is CONSTRUCTED — that is what
// the user sends in — just never here.
const WIREX_TOKEN_FIAT: Record<string, FiatCode> = {
  WEUR: "EUR",
  WUSD: "USD",
};

// Minimal shapes we read out of the (untyped) status arrays. The service
// declares these interfaces internally but does not export them.
type WirexCardShape = {
  id: string | null;
  status: string | null;
  last4: string | null;
  type?: string | null;
  virtual?: boolean | null;
  isVirtual?: boolean | null;
};

// A permanently closed card keeps its entry in /status cards[] — confirmed on a
// live mainnet account after a close: `{ id, status: "Closed", last4 }`. It can
// no longer be revealed, frozen or spent, so it is dropped everywhere: out of
// the carousel and out of the primary-card pick.
function isClosedWirexCard(card: WirexCardShape): boolean {
  return (card.status ?? "").trim().toLowerCase() === "closed";
}

type WirexBankAccountShape = {
  account_type?: string | null;
  type: string | null;
  status: string | null;
  currency?: string | null;
  iban: string | null;
  bic: string | null;
  id: string | null;
};

type BankAccountSummary = {
  type: string | null;
  status: string | null;
  currency: string | null;
  iban_present: boolean;
  bic_present: boolean;
  id_present: boolean;
};

// One entry per usable card, in carousel order. Derived here so the screen never
// re-derives Wirex's frozen semantics. `card` above is always cards[0]'s
// source card — the primary — while these carry the per-card state the carousel
// and its actions need for whichever card the user swiped to.
export interface WirexSnapshotCard {
  id: string;
  last4: string | null;
  isFrozen: boolean;
}

export interface WirexCardSnapshot {
  loading: boolean;
  error: string | null;
  isApproved: boolean;
  // KYC verification failed for good. The user can never register or use a
  // card, but MUST still be able to withdraw whatever the account holds.
  isRejected: boolean;
  verificationStatus: string;
  card: WirexCardShape | null;
  cards: WirexSnapshotCard[]; // every usable card; [] before the first read
  iban: {
    iban: string | null;
    bic: string | null;
    status: string | null;
    bankAccountId: string | null;
  } | null;
  balanceEur: number | null; // unified balance: every /wallet token converted to EUR and summed; null = unknown/not-yet-readable (NOT zero). A real 0 stays 0.
  // The same tokens before they were summed: how much the account holds in EACH
  // settlement currency, in that currency's own units (USD stays USD). The card
  // spends dollars as dollars, so the detail screen states them as dollars
  // rather than only their euro worth. null until a /wallet read establishes the
  // split (the cached cold-start figure is a total and carries none); {} for an
  // account that holds nothing.
  balancesByFiat: Partial<Record<FiatCode, number>> | null;
  smartAccountAddress: string | null;
  wallet: string | null; // the owner EOA — key for the wallet-keyed card reads
  isFrozen: boolean | null; // Wirex card status "Blocked" == frozen; null = no card / unknown
  // "First Last" from the KYC'd Wirex profile — the name printed on the card and
  // held on the IBAN. null until the profile read lands (it is a SEPARATE route:
  // /status carries no profile at all). Wirex stores no middle name, so this IS
  // the full legal name a checkout should be given.
  holderName: string | null;
  // /status listed cards and every one of them is Closed. This is the account
  // deliberately having no usable card — not the incomplete response an empty
  // card list can also be, which is why the two cannot share a shape.
  allCardsClosed: boolean;
  // Derived from user_status / bank_eligibility: the account was blocked by the
  // partner bank. When true, the IBAN row and the issue-card CTA must not render
  // (a blocked account still reads bank_accounts[].status "Active" and
  // verification "Approved", so neither of those is the signal).
  isAccountBlocked: boolean;
}

const INITIAL_STATE: WirexCardSnapshot = {
  loading: true,
  error: null,
  isApproved: false,
  isRejected: false,
  verificationStatus: "unknown",
  card: null,
  cards: [],
  iban: null,
  balanceEur: null,
  balancesByFiat: null,
  smartAccountAddress: null,
  wallet: null,
  isFrozen: null,
  allCardsClosed: false,
  holderName: null,
  isAccountBlocked: false,
};

function hasCompleteApprovedSnapshot(snapshot: WirexCardSnapshot): boolean {
  return (
    snapshot.isApproved &&
    Boolean(snapshot.card?.id) &&
    snapshot.balanceEur !== null &&
    Boolean(snapshot.smartAccountAddress)
  );
}

function hasDisplayableSnapshot(snapshot: WirexCardSnapshot): boolean {
  if (hasCompleteApprovedSnapshot(snapshot)) return true;
  // Approved with every card closed is a complete account too — it just has no
  // card until the user issues a replacement. Without this the state was neither
  // persisted nor kept on screen, so a cold start re-showed the closed card from
  // the older snapshot and a failed status read dropped the user onto the
  // registration CTA.
  if (isAwaitingReplacementCard(snapshot)) return true;
  return (
    !snapshot.isApproved &&
    !snapshot.card?.id &&
    snapshot.verificationStatus !== "unknown" &&
    snapshot.error === null
  );
}

function preserveVisibleSnapshot(
  previous: WirexCardSnapshot,
  replacement: WirexCardSnapshot,
): WirexCardSnapshot {
  if (!hasDisplayableSnapshot(previous)) return replacement;
  return { ...previous, loading: false, error: replacement.error };
}

// Every Keychain write and delete for the snapshot runs on this one chain, so
// they can only ever settle in the order they were issued. Without it a write
// started before a sign-out could land after the teardown delete and put the
// previous account's IBAN, card and balance back on disk. `snapshotEpoch` drops
// writes that were still queued when a teardown overtook them — those describe
// a wallet that no longer owns this session.
let snapshotKeychainQueue: Promise<unknown> = Promise.resolve();
let snapshotEpoch = 0;

// Best-effort — a failed write only costs the cold-start floor, never the load.
function persistSnapshot(entry: SnapshotCacheEntry): void {
  const epoch = snapshotEpoch;
  const payload = JSON.stringify(entry);
  snapshotKeychainQueue = snapshotKeychainQueue
    .then(() =>
      epoch === snapshotEpoch
        ? storeAuthData(WIREX_SNAPSHOT_CACHE_KEY, payload)
        : Promise.resolve(),
    )
    .catch(() => {});
}

/**
 * Drop the persisted snapshot. `invalidatePending` marks every write still
 * queued as belonging to a finished session — pass it whenever the deletion is
 * a teardown (sign-out, wallet change) rather than the routine discard of a
 * snapshot that aged out.
 */
function clearPersistedSnapshot({ invalidatePending = false } = {}): void {
  if (invalidatePending) snapshotEpoch += 1;
  snapshotKeychainQueue = snapshotKeychainQueue
    .then(() => deleteAuthData(WIREX_SNAPSHOT_CACHE_KEY))
    .catch(() => {});
}

// Test-only: await the Keychain queue so a case can assert the settled state.
export function __flushWirexSnapshotWritesForTests(): Promise<unknown> {
  return snapshotKeychainQueue;
}

// Returns the persisted snapshot only when it belongs to `wallet`, is young
// enough, and is still displayable — anything else is dropped, so a reinstall or
// a second account can never inherit the previous one's card/IBAN.
async function readPersistedSnapshot(wallet: string): Promise<SnapshotCacheEntry | null> {
  try {
    const raw = await getAuthData(WIREX_SNAPSHOT_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SnapshotCacheEntry>;
    if (parsed.wallet !== wallet || typeof parsed.at !== "number") return null;
    if (Date.now() - parsed.at > SNAPSHOT_PERSIST_MAX_AGE_MS) {
      clearPersistedSnapshot();
      return null;
    }
    // Spread over INITIAL_STATE so a snapshot written by an older app version is
    // still structurally complete; loading is a runtime flag, never restored.
    const value: WirexCardSnapshot = {
      ...INITIAL_STATE,
      ...(parsed.value ?? {}),
      loading: false,
    };
    if (!hasDisplayableSnapshot(value)) return null;
    return { wallet, at: parsed.at, value };
  } catch {
    return null;
  }
}

// True when the merge below would KEEP `previous` rather than take `next`: the
// live response is approved but incomplete, so the older complete snapshot wins.
function retainsPriorSnapshot(previous: WirexCardSnapshot, next: WirexCardSnapshot): boolean {
  // Every card closed is a statement, not a gap. Treating it as incomplete kept
  // the card the user just closed in the carousel and in the persisted cache,
  // and no later poll could ever dislodge it — the payload never regains a
  // usable card.
  if (next.allCardsClosed) return false;
  return (
    hasCompleteApprovedSnapshot(previous) && next.isApproved && !hasCompleteApprovedSnapshot(next)
  );
}

// True when the merge carries the previous IBAN forward because the live
// response is approved but arrived without bank details.
function carriesPriorBankDetails(previous: WirexCardSnapshot, next: WirexCardSnapshot): boolean {
  const sameWallet = previous.wallet !== null && previous.wallet === next.wallet;
  return (
    sameWallet &&
    next.isApproved &&
    Boolean(previous.iban?.iban || previous.iban?.bic) &&
    !(next.iban?.iban || next.iban?.bic)
  );
}

/**
 * Does the merged result contain ANY detail the live response did not supply?
 * The cache uses this to decide whether it is storing genuinely fresh data or
 * re-storing what it already held. Re-stamping the latter would renew stale
 * card/IBAN/balance on every poll and the max-age expiry could never fire.
 */
function mergeReusesCachedDetails(previous: WirexCardSnapshot, next: WirexCardSnapshot): boolean {
  return retainsPriorSnapshot(previous, next) || carriesPriorBankDetails(previous, next);
}

// The KYC'd name never changes for a wallet, so it is read once and kept for the
// process. It lives on a DIFFERENT route than /status (the physical-eligibility
// proxy of Wirex GET /api/v2/user), which is why it is not simply part of load().
let holderNameCache: { wallet: string; name: string | null } | null = null;

// Identifies the service's own balance poll loop against the ownership guard.
const HEADLESS_POLL_OWNER = Symbol("WirexAccountService.balancePoll");

function mergePreservedSnapshot(
  previous: WirexCardSnapshot,
  replacement: WirexCardSnapshot,
): WirexCardSnapshot {
  let next = replacement;
  if (carriesPriorBankDetails(previous, replacement)) {
    next = { ...replacement, iban: previous.iban };
  }

  if (retainsPriorSnapshot(previous, next)) {
    // The cached display data may win; the block flag is safety state and
    // always comes from the fresh read.
    return {
      ...previous,
      loading: false,
      error: next.error,
      isAccountBlocked: next.isAccountBlocked,
    };
  }

  // The name arrives on its own route, so a live /status read that predates it
  // must not blank a name the previous snapshot already had.
  if (!next.holderName && previous.holderName) {
    next = { ...next, holderName: previous.holderName };
  }

  return next;
}

function normalizeText(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

function hasNonEmptyText(value: string | null | undefined): boolean {
  return normalizeText(value).length > 0;
}

function bankAccountScore(account: WirexBankAccountShape): number {
  let score = 0;
  const type = normalizeText(account.type ?? account.account_type);
  const status = normalizeText(account.status);
  const currency = normalizeText(account.currency);

  if (hasNonEmptyText(account.iban)) score += 1000;
  if (type === "sepa") score += 100;
  if (currency === "eur") score += 50;
  if (status === "active") score += 20;
  else if (status === "pending") score += 10;
  if (hasNonEmptyText(account.bic)) score += 5;
  if (hasNonEmptyText(account.id)) score += 1;

  return score;
}

function summarizeBankAccount(account: WirexBankAccountShape): BankAccountSummary {
  return {
    type: account.type ?? account.account_type ?? null,
    status: account.status ?? null,
    currency: account.currency ?? null,
    iban_present: hasNonEmptyText(account.iban),
    bic_present: hasNonEmptyText(account.bic),
    id_present: hasNonEmptyText(account.id),
  };
}

function selectBankAccount(accounts: WirexBankAccountShape[]): {
  account: WirexBankAccountShape | null;
  selectedIndex: number | null;
  summary: BankAccountSummary[];
} {
  const summary = accounts.map(summarizeBankAccount);
  let selectedIndex: number | null = null;
  let selectedScore = Number.NEGATIVE_INFINITY;

  accounts.forEach((account, index) => {
    const score = bankAccountScore(account);
    if (score > selectedScore) {
      selectedScore = score;
      selectedIndex = index;
    }
  });

  return {
    account: selectedIndex === null ? null : (accounts[selectedIndex] ?? null),
    selectedIndex,
    summary,
  };
}

class WirexAccountService {
  private snapshot: WirexCardSnapshot = snapshotCache?.value ?? INITIAL_STATE;
  private actionBusyState = false;
  private actionErrorState = false;
  private issueUnresolvedState = false;
  // True while a non-silent load (mount / pull-to-refresh) is confirming status
  // against the server. The cached snapshot renders instantly, but it may predate
  // an approval; the screen holds the pending state disabled until this clears so
  // a stale "Applied" cache can't flash a tappable "Continue Verification" that a
  // fresh "Approved" then yanks away. Background polls are silent → never set it.
  private revalidatingState = false;
  private walletRef: string | null = null;
  private bankDetailsPollAttempt = 0;
  private bankDetailsPollTimer: ReturnType<typeof setTimeout> | null = null;
  private balanceRetryAttempt = 0;
  private balanceRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private loadInFlight: Promise<WirexCardSnapshot | null> | null = null;
  // Every optimistic move still waiting for the ledger, oldest first. A list
  // rather than a single hold: a card→wallet debit and a wallet→card credit can
  // overlap, and collapsing them into one hold made a stale read satisfy the
  // newer move and release the older one, snapping the balance back.
  // `baseline` is what was on screen when the move was made, so each move is
  // released only once the live figure has actually absorbed it.
  private optimisticAnchor: OptimisticAnchor | null = null;
  // The same moves in the currency they were actually made in, keyed by the
  // anchor's handle. The anchor holds ONE euro total, which is all the headline
  // figure needs; the per-currency rows need to know that it was dollars that
  // arrived, or they sit at the old figure until the ledger catches up minutes
  // later. Signed: a debit is negative.
  private optimisticFiatMoves = new Map<number, { currency: FiatCode; amount: number }>();
  // The last per-currency split a /wallet read produced, before any optimistic
  // move was laid over it. The published snapshot carries the projection, so
  // without this base the deltas would compound on every emit.
  private liveBalancesByFiat: Partial<Record<FiatCode, number>> | null = null;
  private stateGeneration = 0;
  private started = false;
  private eventUnsubs: Array<() => void> = [];
  private balancePoller: ForegroundPoller | null = null;
  // Whoever drives the balance poll. A card screen that is still mounted runs an
  // interval of its own against this same singleton; ticks from anyone but the
  // owner are dropped so the read rate stays at one per interval.
  private pollOwner: symbol | null = null;
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  getSnapshot(): WirexCardSnapshot {
    return this.snapshot;
  }

  get actionBusy(): boolean {
    return this.actionBusyState;
  }

  get actionError(): boolean {
    return this.actionErrorState;
  }

  // An issuance failed and no read could establish whether a card was created.
  // Issuing again is exactly what must not happen while that is unknown, because
  // replay protection is per signature and a retry would sign a fresh request.
  // Cleared by the next completed load — by then the snapshot IS the answer.
  get issueUnresolved(): boolean {
    return this.issueUnresolvedState;
  }

  get revalidating(): boolean {
    return this.revalidatingState;
  }

  hasAccount(): boolean {
    return hasCompleteApprovedSnapshot(this.snapshot);
  }

  depositAddress(): string | null {
    return this.snapshot.smartAccountAddress;
  }

  /**
   * Move the displayed balance NOW, before the ledger agrees. A transfer the user
   * saw no error on is treated as done: the sheet closes and the number moves
   * immediately, rather than making them watch it catch up. Held so a stale read
   * cannot undo it, and released as soon as a live read has actually caught up.
   */
  /** Returns a handle the caller passes back to revert THIS move, or null. */
  applyOptimisticDebit(amount: number): number | null {
    return this.applyOptimisticBalance(amount, "debit", "EUR", amount);
  }

  applyOptimisticCredit(amount: number): number | null {
    return this.applyOptimisticBalance(amount, "credit", "EUR", amount);
  }

  /**
   * The same credit, stated in the currency that actually arrived. The card's
   * headline figure is one euro total, so dollars landing on it have to be
   * converted before they can join it — and waiting for a rate is this service's
   * job, not every caller's. The per-currency row still moves by the dollars
   * themselves. Null when no rate can be had: an unconvertible figure is worse
   * than the next balance read, which is only seconds away.
   */
  async applyOptimisticCreditIn(amount: number, currency: FiatCode): Promise<number | null> {
    return this.applyOptimisticIn(amount, currency, "credit");
  }

  /** The same, for money leaving the card in a currency other than the total's. */
  async applyOptimisticDebitIn(amount: number, currency: FiatCode): Promise<number | null> {
    return this.applyOptimisticIn(amount, currency, "debit");
  }

  private async applyOptimisticIn(
    amount: number,
    currency: FiatCode,
    direction: "debit" | "credit",
  ): Promise<number | null> {
    if (currency === "EUR") return this.applyOptimisticBalance(amount, direction, "EUR", amount);
    try {
      const rates = await fxRateService.getRates();
      const eur = fxRateService.convert(amount, currency, "EUR", rates);
      return this.applyOptimisticBalance(eur, direction, currency, amount);
    } catch {
      return null;
    }
  }

  // The per-currency split with every outstanding optimistic move laid over it.
  // Always computed from the last LIVE read, never from the published figure, so
  // repeated emits cannot compound the same move.
  private projectBalancesByFiat(): Partial<Record<FiatCode, number>> | null {
    const base = this.liveBalancesByFiat;
    if (!base) return null;
    if (this.optimisticFiatMoves.size === 0) return base;
    const projected: Partial<Record<FiatCode, number>> = { ...base };
    for (const move of this.optimisticFiatMoves.values()) {
      // Never negative: a debit larger than the pocket means the split is behind
      // the move, and a minus sign on a balance row is worse than a zero.
      projected[move.currency] = Math.max(0, (projected[move.currency] ?? 0) + move.amount);
    }
    return projected;
  }

  private applyOptimisticBalance(
    amountEur: number,
    direction: "debit" | "credit",
    currency: FiatCode,
    amountInCurrency: number,
  ): number | null {
    const base = this.snapshot.balanceEur;
    if (base == null) return null;
    const { anchor, id } = addOptimisticMove(
      this.optimisticAnchor,
      base,
      amountEur,
      direction,
      Date.now(),
      direction === "debit" ? OPTIMISTIC_DEBIT_HOLD_MS : OPTIMISTIC_CREDIT_HOLD_MS,
    );
    if (id == null || !anchor) return null;
    this.optimisticAnchor = anchor;
    this.optimisticFiatMoves.set(id, {
      currency,
      amount: direction === "debit" ? -amountInCurrency : amountInCurrency,
    });
    this.snapshot = {
      ...this.snapshot,
      balanceEur: anchorTarget(anchor),
      balancesByFiat: this.projectBalancesByFiat() ?? this.snapshot.balancesByFiat,
    };
    this.emit();
    return id;
  }

  /**
   * Undo one move — the only reason is that THAT transfer actually failed, and
   * the failure is reported by the call that made it. Overlapping transfers do
   * not fail in the order they were started, so the handle is what identifies
   * the move; every other outstanding move stays as it was.
   */
  revertOptimisticBalance(handle: number | null): void {
    const held = this.optimisticAnchor;
    if (!held || handle == null) return;
    const next = dropOptimisticMove(held, handle);
    if (next === held) return;
    this.optimisticAnchor = next;
    this.optimisticFiatMoves.delete(handle);
    const restored = next ? anchorTarget(next) : held.baseline;
    this.snapshot = {
      ...this.snapshot,
      balanceEur: restored,
      balancesByFiat: this.projectBalancesByFiat() ?? this.snapshot.balancesByFiat,
    };
    this.emit();
  }

  refresh(force = true): Promise<WirexCardSnapshot | null> {
    return this.runLoad(force, undefined);
  }

  silentRefresh(force = true): Promise<WirexCardSnapshot | null> {
    return this.runLoad(force, { silent: true });
  }

  /**
   * Take the balance poll loop. Returns false when someone else already holds
   * it — the caller's signal not to start an interval of its own.
   */
  claimPollOwnership(owner: symbol): boolean {
    if (this.pollOwner !== null && this.pollOwner !== owner) return false;
    this.pollOwner = owner;
    return true;
  }

  releasePollOwnership(owner: symbol): void {
    if (this.pollOwner === owner) this.pollOwner = null;
  }

  /**
   * One balance poll tick. Reuses the 60s status cache instead of forcing the
   * documented ~90s /status path, so a repeating caller stays cheap; the
   * /wallet balance read is never cached, so the figure is still live.
   */
  pollBalance(owner?: symbol): Promise<WirexCardSnapshot | null> {
    if (this.pollOwner !== null && owner !== this.pollOwner) return Promise.resolve(null);
    return this.silentRefresh(false);
  }

  /**
   * Foreground balance poll. It lived in the card screen's `isActive &&
   * isAppActive` effect, so the balance only moved while that tab was on screen;
   * the gate is now the app being in the foreground and any caller can start it.
   * Idempotent — one loop per process.
   */
  startBalancePolling(): void {
    this.ensureStarted();
    if (this.balancePoller) return;
    this.claimPollOwnership(HEADLESS_POLL_OWNER);
    this.balancePoller = createForegroundPoller({
      intervalMs: CARD_BALANCE_POLL_INTERVAL_MS,
      tick: () => {
        void this.pollBalance(HEADLESS_POLL_OWNER).catch((): WirexCardSnapshot | null => null);
      },
    });
    this.balancePoller.start();
  }

  stopBalancePolling(): void {
    this.balancePoller?.stop();
    this.balancePoller = null;
    // Released, not held: with no headless loop running, a mounted card screen
    // has to be able to keep the balance moving again.
    this.releasePollOwnership(HEADLESS_POLL_OWNER);
  }

  /**
   * ONE in-flight load, whatever the caller. `getStatus` is documented at up to
   * 90s while the card tab polls every 10s, so without this several full
   * status+wallet round trips overlap and a slow earlier response can finish last
   * and overwrite newer card state.
   *
   * Silent and non-silent share the same chain deliberately: the two differ only
   * in whether the screen shows a revalidating state, which is applied here
   * before joining. A foreground refresh arriving over a running silent poll
   * therefore still flips the screen's flag immediately, but reuses the request
   * already in flight instead of racing it.
   */
  private runLoad(
    force: boolean,
    options?: { silent?: boolean },
  ): Promise<WirexCardSnapshot | null> {
    const visible = options?.silent !== true;
    // Pinned so the teardown below belongs to THIS session. A reset during a
    // pending visible load, followed by a relogin that starts its own, would
    // otherwise let the old promise clear the NEW load's revalidating state and
    // expose the registration CTA while that account is still being fetched.
    const generation = this.stateGeneration;
    if (visible) this.beginVisibleRevalidate();
    const started =
      this.loadInFlight ??
      (() => {
        const run = this.load(force, options).finally(() => {
          if (this.loadInFlight === run) this.loadInFlight = null;
        });
        this.loadInFlight = run;
        return run;
      })();
    // A silent load's no-wallet and getStatus-failure paths skip every visible
    // state update by design. When a foreground request joined one, the flag it
    // set here would then never be cleared and the screen would sit in loading
    // or hold its CTA disabled until some later poll happened to succeed.
    return visible
      ? started.finally(() => {
          if (generation === this.stateGeneration) this.endVisibleRevalidate();
        })
      : started;
  }

  /**
   * Keeps a live read from undoing an optimistic move while the ledger is still
   * behind. A debit holds while the read is still HIGHER than expected, a credit
   * while it is still LOWER — either way the hold releases the moment the live
   * figure has caught up, or when it expires.
   */
  private withOptimisticBalance(next: WirexCardSnapshot): WirexCardSnapshot {
    // The base every projection is built from, refreshed by every read that got
    // one — including the reads that settle the anchor below.
    if (next.balancesByFiat) this.liveBalancesByFiat = next.balancesByFiat;
    const anchor = this.optimisticAnchor;
    if (!anchor) {
      this.optimisticFiatMoves.clear();
      return next;
    }
    const live = next.balanceEur;
    if (live == null) {
      this.optimisticAnchor = null;
      this.optimisticFiatMoves.clear();
      return next;
    }
    // Which reads count as settlement — and, crucially, which do not — is
    // decided in decideAnchoredBalance.
    if (decideAnchoredBalance(anchor, live, Date.now()) === "accept") {
      this.optimisticAnchor = null;
      this.optimisticFiatMoves.clear();
      return next;
    }
    return {
      ...next,
      balanceEur: anchorTarget(anchor),
      balancesByFiat: this.projectBalancesByFiat() ?? next.balancesByFiat,
    };
  }

  private endVisibleRevalidate(): void {
    if (!this.revalidatingState && !this.snapshot.loading) return;
    this.revalidatingState = false;
    if (this.snapshot.loading) this.snapshot = { ...this.snapshot, loading: false };
    this.emit();
  }

  /**
   * The visible half of a non-silent load: keep a displayable snapshot on screen
   * while revalidating, otherwise show loading. Separated from load() so a
   * foreground refresh can apply it and then join a silent request already in
   * flight — the flag is cleared by whichever load actually settles.
   */
  private beginVisibleRevalidate(): void {
    const prev = this.snapshot;
    this.snapshot = hasDisplayableSnapshot(prev)
      ? { ...prev, loading: false, error: null }
      : { ...prev, loading: true, error: null };
    this.revalidatingState = true;
    this.emit();
  }

  // Idempotent bootstrap: kick the initial (non-silent) load once and wire the
  // card:refresh / card:refreshBalance EventBus listeners ONCE. No-op afterwards.
  ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    const refresh = () => {
      void this.runLoad(true, { silent: true });
    };
    this.eventUnsubs.push(EventBus.on("card:refresh", refresh));
    this.eventUnsubs.push(EventBus.on("card:refreshBalance", refresh));
    // Seed the in-memory cache from disk BEFORE the first load, otherwise the
    // load's own failure path has nothing to preserve and shows the CTA. The
    // address read is the cached one (no biometric prompt). A live snapshot that
    // arrived while this was in flight always wins.
    // reset() bumps this. Both awaits below can straddle a sign-out or a relogin
    // to a different wallet, and reset() puts the caches back to their initial
    // state — which is exactly the condition this bootstrap tests. Without the
    // check it would then publish the PREVIOUS wallet's balance, IBAN and card
    // into the new session until the live read replaced them.
    const generation = this.stateGeneration;
    void (async () => {
      let wallet: string | null = null;
      try {
        wallet = await getEthereumAddress();
      } catch {
        wallet = null;
      }
      if (generation !== this.stateGeneration) return;
      const restored = wallet ? await readPersistedSnapshot(wallet) : null;
      if (generation !== this.stateGeneration) return;
      if (restored && !snapshotCache && !hasDisplayableSnapshot(this.snapshot)) {
        snapshotCache = restored;
        this.snapshot = restored.value;
        this.emit();
      }
      await this.hydrateCachedBalance(generation);
      await this.runLoad(false, undefined);
    })();
  }

  /**
   * Seed the balance from the shared balance cache when the restored snapshot
   * carried none. Whoever renders the card figure would otherwise show a zero on
   * every cold launch until the first status read lands. Never overwrites a
   * balance that is already known.
   */
  private async hydrateCachedBalance(generation: number): Promise<void> {
    if (this.snapshot.balanceEur !== null) return;
    try {
      const cached = await getCachedBalance(BALANCE_CACHE_KEYS.card);
      if (generation !== this.stateGeneration || this.snapshot.balanceEur !== null) return;
      const amount = cached?.amount;
      if (typeof amount !== "number" || !Number.isFinite(amount)) return;
      this.snapshot = { ...this.snapshot, balanceEur: amount };
      this.emit();
    } catch {}
  }

  // Full teardown for sign-out / same-process relogin to a different wallet.
  // Clears the cross-wallet snapshot cache and this instance's snapshot, cancels
  // the bank-details poll, and unwires the EventBus listeners so the next
  // useWirexCard mount re-bootstraps via ensureStarted() and reloads for the new
  // wallet instead of rendering the previous wallet's card/balance/IBAN.
  reset(): void {
    this.stopBalancePolling();
    for (const off of this.eventUnsubs) {
      try {
        off();
      } catch {}
    }
    this.eventUnsubs = [];
    if (this.bankDetailsPollTimer) {
      clearTimeout(this.bankDetailsPollTimer);
      this.bankDetailsPollTimer = null;
    }
    this.bankDetailsPollAttempt = 0;
    // A load still running belongs to the previous wallet; drop the handle so
    // the next mount starts a fresh one instead of joining it, and invalidate any
    // bootstrap still awaiting the Keychain so it cannot publish that wallet's
    // snapshot into the new session.
    this.loadInFlight = null;
    this.optimisticAnchor = null;
    this.optimisticFiatMoves.clear();
    this.liveBalancesByFiat = null;
    // Credits parked against an unsettled top-up belong to the wallet that made
    // them; a new identity must not inherit them.
    clearOptimisticMoves();
    this.stateGeneration += 1;
    snapshotCache = null;
    clearPersistedSnapshot({ invalidatePending: true });
    // The shared balance cache is not keyed by wallet, so leaving it would let
    // hydrateCachedBalance seed the next identity with this one's figure.
    void clearCachedBalance(BALANCE_CACHE_KEYS.card);
    this.snapshot = INITIAL_STATE;
    this.walletRef = null;
    this.actionBusyState = false;
    this.actionErrorState = false;
    this.issueUnresolvedState = false;
    this.revalidatingState = false;
    this.started = false;
    this.emit();
  }

  private async load(
    force = false,
    options?: { silent?: boolean },
  ): Promise<WirexCardSnapshot | null> {
    // The non-silent visible state is applied by runLoad before this runs, so a
    // foreground request can show it and still join an in-flight silent load.
    const silent = options?.silent === true;
    // Every write below happens after an await, and reset() (sign-out, or a
    // same-process relogin to a different wallet) can land in any of those gaps.
    // The wallet captured here would then be the PREVIOUS one, so publishing its
    // status, balance, IBAN and card — or writing them into the shared caches —
    // would leak the old account into the new session. Re-checked before every
    // state or cache write.
    const generation = this.stateGeneration;
    const stale = () => generation !== this.stateGeneration;

    let wallet: string | null = null;
    try {
      wallet = await getEthereumAddress();
    } catch {
      wallet = null;
    }
    if (stale()) return null;
    if (!wallet) {
      const nextState = { ...INITIAL_STATE, loading: false, error: "no_wallet" };
      snapshotCache = null;
      // No wallet answers any more — the same teardown as reset(), so a write
      // still queued from the wallet that just went away must not land.
      clearPersistedSnapshot({ invalidatePending: true });
      if (!silent) {
        this.snapshot = nextState;
        this.revalidatingState = false;
        this.emit();
        this.evaluateBankDetailsPoll();
      }
      return silent ? null : nextState;
    }

    this.walletRef = wallet;

    // The read session identifies the account, so the cohort is decided entirely
    // server-side: `getStatus` resolves the user from whoever signed the session
    // and needs no email. The stored email is onboarding-only (it forces the
    // server's ~90s provisioning re-sync) and lives solely on the device that
    // onboarded, so reading it here would give a reinstall / second device /
    // other app variant a different cohort than the device that signed up — the
    // Keychain is per bundle id. Omitting it keeps one uniform account view and,
    // as a side effect, drops the re-sync off every tab mount and pull (#852).
    const cachedStatus =
      !force &&
      statusCache &&
      statusCache.wallet === wallet &&
      Date.now() - statusCache.at < STATUS_TTL_MS
        ? statusCache.value
        : null;
    let status: WirexStatus;
    try {
      status = cachedStatus ?? (await wirexService.getStatus({ wallet }));
    } catch {
      // The email-less read is a pure wallet-keyed BaaS lookup and throws both
      // for a wallet that has no account yet and for a transient failure — the
      // two are indistinguishable from the client, so fall back to the
      // not-onboarded cohort and let the CTA drive. An existing user is not
      // shown that CTA on a blip: preserveVisibleSnapshot keeps their already-
      // displayed account and only clears loading, and the next poll heals it.
      const nextState = { ...INITIAL_STATE, loading: false };
      if (stale()) return null;
      if (!silent) {
        this.snapshot = preserveVisibleSnapshot(this.snapshot, nextState);
        this.revalidatingState = false;
        this.emit();
        this.evaluateBankDetailsPoll();
      }
      return silent ? null : nextState;
    }
    if (stale()) return null;
    if (!cachedStatus) statusCache = { wallet, at: Date.now(), value: status };

    const verification = (status.verificationStatus || "").trim().toLowerCase();
    const isApproved = verification === "approved";
    const isRejected = verification === "rejected";
    // KYC just came back approved WHILE the app was open. Provisioning ran (and
    // was skipped) during signup, and nothing server-side re-runs it on approval
    // — so this transition is the other moment, besides launch, where a card and
    // an IBAN may now be due. Announced rather than called so the account service
    // keeps no dependency on the repair that listens for it. Only a transition
    // counts: "unknown" is the first read of the launch, which the launch check
    // already covers.
    const wasApproved = this.snapshot.isApproved;
    const previousVerification = (this.snapshot.verificationStatus || "").trim().toLowerCase();
    if (isApproved && !wasApproved && previousVerification !== "unknown") {
      EventBus.emit(WIREX_VERIFICATION_APPROVED_EVENT);
    }
    // Only an approved account has a KYC'd profile to read. Fire-and-forget: the
    // name is not worth delaying the snapshot for, and it patches itself in.
    if (isApproved && holderNameCache?.wallet !== wallet) void this.loadHolderName(wallet);
    const allCards = (status.cards as WirexCardShape[] | undefined) ?? [];
    // Closed cards stay in the payload forever; nothing downstream may see them.
    const cards = allCards.filter((c) => !isClosedWirexCard(c));
    const card = cards[0] ?? null;
    // Cards were listed and all of them are closed — the account has no usable
    // card on purpose. An empty `allCards` says nothing of the kind.
    const allCardsClosed = allCards.length > 0 && cards.length === 0;
    // Wirex's own order. A card without an id can neither be revealed nor
    // frozen, so it is dropped rather than rendered as a dead face.
    const carouselCards: WirexSnapshotCard[] = cards
      .filter((c) => hasNonEmptyText(c.id))
      .map((c) => ({
        id: c.id as string,
        last4: c.last4,
        isFrozen: c.status === "Blocked",
      }));
    const bankAccounts = (status.bankAccounts as WirexBankAccountShape[] | undefined) ?? [];
    const selectedBankAccount = selectBankAccount(bankAccounts);
    const iban = selectedBankAccount.account;
    logWithId(
      `${LOG_EMOJI.card} WirexAccountService.bankAccounts`,
      "bank account summary",
      {
        bank_accounts_count: bankAccounts.length,
        selected_index: selectedBankAccount.selectedIndex,
        selected_has_iban: hasNonEmptyText(iban?.iban),
        selected_type: iban?.type ?? iban?.account_type ?? null,
        selected_status: iban?.status ?? null,
        bank_accounts_summary: selectedBankAccount.summary,
      },
      {
        source: "services/wirex/WirexAccountService.ts#load",
        scope: "WirexAccountService",
        action: "bankAccounts",
        event: "STATE",
        context: "background",
      },
    );
    // A rejected account usually has no card — but it can still hold funds, and
    // withdrawal is the one thing that must always work. Load its smart account
    // and balance too, otherwise the Withdraw button has nothing to move.
    // An account whose every card is closed has no card either, and skipping the
    // read there left balance and address null — the exact two fields the
    // replacement-card state needs — so the last close dead-ended on a disabled
    // "Verification in progress" with no way to issue a new card.
    const shouldLoadWallet = Boolean(card?.id) || isRejected || allCardsClosed;
    const [walletR, ratesR] = shouldLoadWallet
      ? await Promise.allSettled([wirexService.getWallet(wallet), fxRateService.getRates()])
      : [null, null];
    const walletInfo =
      walletR?.status === "fulfilled" ? walletR.value : { walletAddress: null, balances: [] };
    const walletLoaded = walletR?.status === "fulfilled";
    const rates = ratesR?.status === "fulfilled" ? ratesR.value : null;
    const smartAccountAddress = walletInfo.walletAddress;

    // Unified balance: sum every /wallet token converted to EUR. Unknown symbols
    // and unparseable amounts are skipped; null (not 0) when nothing is readable
    // or FX is unavailable — a real 0 stays 0.
    // TODO(wirex): confirm the balance field is a decimal string on live data (adjust if minor-units).
    let balanceEur: number | null = null;
    let balancesByFiat: Partial<Record<FiatCode, number>> | null = null;
    let usedStaleTokenBalance = false;
    const lastKnownTokens = tokenBalanceCache?.wallet === wallet ? tokenBalanceCache.byToken : null;
    if (walletLoaded && walletInfo.balances.length === 0) {
      balanceEur = 0;
      balancesByFiat = {};
    } else if (rates) {
      let sum = 0;
      let counted = false;
      const byFiat: Partial<Record<FiatCode, number>> = {};
      for (const b of walletInfo.balances) {
        const fiat = b.tokenSymbol ? WIREX_TOKEN_FIAT[b.tokenSymbol] : undefined;
        if (!fiat || !b.tokenSymbol) continue;
        // null = failed per-token read, not a 0: stay on the last known value
        // for that token (0 when never seen) so one bad read never corrupts
        // the total, and silently retry below.
        const raw = b.balance ?? lastKnownTokens?.[b.tokenSymbol] ?? "0";
        if (b.balance == null) usedStaleTokenBalance = true;
        const amt = Number(raw);
        if (!Number.isFinite(amt)) continue;
        // Every token pegged to the same fiat is one holding in that currency —
        // WUSD and USDC are both dollars on the card.
        byFiat[fiat] = (byFiat[fiat] ?? 0) + amt;
        sum += fxRateService.convert(amt, fiat, "EUR", rates);
        counted = true;
      }
      balanceEur = counted ? sum : null;
      balancesByFiat = counted ? byFiat : null;
    }
    // WHICH currencies the account holds decides whether the card board draws
    // its per-currency rows. Symbols and codes only — never an amount.
    logWithId(
      `${LOG_EMOJI.card} WirexAccountService.walletTokens`,
      "wallet token composition",
      {
        tokens: walletInfo.balances.map((b) => b.tokenSymbol ?? "?"),
        fiats: balancesByFiat ? Object.keys(balancesByFiat) : null,
      },
      {
        source: "services/wirex/WirexAccountService.ts#load",
        scope: "WirexAccountService",
        action: "walletTokens",
        event: "STATE",
        context: "background",
      },
    );
    if (walletLoaded) {
      // Remember every cleanly-read token for the fallback above. Skipped
      // (null) tokens keep their previous entry.
      const byToken: Record<string, string> = usedStaleTokenBalance ? { ...lastKnownTokens } : {};
      for (const b of walletInfo.balances) {
        if (b.tokenSymbol && b.balance != null) byToken[b.tokenSymbol] = b.balance;
      }
      if (stale()) return null;
      tokenBalanceCache = { wallet, byToken };
    }
    // A degraded balance read — a null token, a failed /wallet call, or an
    // unreadable total (e.g. FX rates down) for a user who should have one —
    // heals itself with a capped silent retry (status stays within its TTL
    // cache, so no heavy onboarding re-sync).
    if (usedStaleTokenBalance || (shouldLoadWallet && (!walletLoaded || balanceEur === null))) {
      this.scheduleBalanceRetry();
    } else {
      this.clearBalanceRetry();
    }

    const nextState: WirexCardSnapshot = {
      loading: false,
      error: null,
      isApproved,
      isRejected,
      verificationStatus: status.verificationStatus,
      card,
      cards: carouselCards,
      iban: iban
        ? { iban: iban.iban, bic: iban.bic, status: iban.status, bankAccountId: iban.id ?? null }
        : null,
      balanceEur,
      balancesByFiat,
      smartAccountAddress: smartAccountAddress ?? null,
      wallet,
      isFrozen: card ? card.status === "Blocked" : null,
      allCardsClosed,
      // From the cache; the fetch below fills it in and patches the snapshot.
      holderName: holderNameCache?.wallet === wallet ? holderNameCache.name : null,
      isAccountBlocked: status.isAccountBlocked,
    };
    // Last gate before anything is published or persisted: a reset that landed
    // during /status or /wallet means this whole result belongs to the previous
    // wallet.
    if (stale()) return null;
    const mergedForCache =
      snapshotCache?.wallet === wallet
        ? mergePreservedSnapshot(snapshotCache.value, nextState)
        : nextState;
    if (hasDisplayableSnapshot(mergedForCache)) {
      // Keep the ORIGINAL age when the merge kept the prior snapshot: the live
      // response added nothing, so re-stamping it with now would renew stale
      // card/IBAN/balance data on every poll and the seven-day expiry could
      // never fire — a closed account would survive every cold start forever.
      const reusedCached =
        snapshotCache?.wallet === wallet &&
        mergeReusesCachedDetails(snapshotCache.value, nextState);
      const at = reusedCached && snapshotCache ? snapshotCache.at : Date.now();
      snapshotCache = { wallet, at, value: mergedForCache };
      persistSnapshot(snapshotCache);
    }
    // A completed read settles the question an unresolved issuance left open:
    // the card list below either holds the new card or it does not, and either
    // way the user can act on what they see. Only a read that actually reached
    // the server settles it though — a load served from the 60s status cache can
    // predate the issuance entirely, so clearing on that would re-arm the CTA
    // with no server observation at all and the next tap would sign a second
    // request and cost the user a second card. The cache ages out, so the flag
    // still clears on its own once a fresh read gets through.
    if (!cachedStatus) this.issueUnresolvedState = false;
    this.snapshot = this.withOptimisticBalance(
      mergePreservedSnapshot(this.snapshot, mergedForCache),
    );
    // Persist the unified Wirex balance to the shared balance cache so App can
    // seed the tab-bar balance instantly on cold launch. Only write a known
    // value — null means unknown/not-yet-readable, so we keep the last cached
    // figure.
    if (mergedForCache.balanceEur !== null) {
      void setCachedBalance(BALANCE_CACHE_KEYS.card, mergedForCache.balanceEur, "EUR");
    }
    this.revalidatingState = false;
    this.emit();
    this.evaluateBankDetailsPoll();
    return mergedForCache;
  }

  // Freeze/unfreeze: one biometric signature over the exact action string, then
  // a LIGHT re-read of the card state (GET /card/status — no onboarding sync).
  // `cardId` selects which card to toggle (the carousel's current one); omitted
  // it falls back to the primary card, which is what a single-card account has.
  toggleFreeze(cardId?: string): void {
    const targetId = cardId ?? this.snapshot.card?.id;
    const wallet = this.walletRef;
    if (!targetId || !wallet || this.actionBusyState) return;
    const target = this.snapshot.cards.find((c) => c.id === targetId);
    const frozen = target ? target.isFrozen : this.snapshot.isFrozen === true;
    this.actionBusyState = true;
    this.actionErrorState = false;
    this.emit();
    void (async () => {
      try {
        await (frozen ? wirexService.unfreezeCard(targetId) : wirexService.freezeCard(targetId));
        const cardStatus = await wirexService.getCardStatus(wallet, targetId);
        this.snapshot = {
          ...this.snapshot,
          cards: this.snapshot.cards.map((c) =>
            c.id === targetId ? { ...c, isFrozen: cardStatus.isFrozen } : c,
          ),
          // The top-level flag describes the PRIMARY card only — leave it alone
          // when a different card was toggled, or the screen would show the
          // primary as frozen because a secondary one is.
          isFrozen:
            targetId === this.snapshot.card?.id ? cardStatus.isFrozen : this.snapshot.isFrozen,
        };
        this.emit();
      } catch {
        this.actionErrorState = true;
        this.emit();
      } finally {
        this.actionBusyState = false;
        this.emit();
      }
    })();
  }

  // These actions only return a boolean to the UI (which shows a generic retry
  // line), so without this the server's reason — the one thing that says WHY —
  // was swallowed and every failure looked identical. Message only: the codes are
  // rail/validation names (e.g. last4_must_be_4_digits, card_last4_mismatch,
  // visa_virtual_card_capability_not_active), never card data.
  private logCardActionFailure(action: string, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    errorWithId(
      `${LOG_EMOJI.error} WirexAccountService.${action}`,
      // In the MESSAGE, not just the extras: the console renderer prints the
      // message only, so a reason parked in `extra` never reaches the log the
      // user is actually reading.
      `card action failed: ${action} — ${reason.slice(0, 300)}`,
      { reason },
      {
        source: `services/wirex/WirexAccountService.ts#${action}`,
        scope: "WirexAccountService",
        action,
        result: "error",
        event: "STATE",
        context: "system",
      },
    );
  }

  // Drop a stuck action error. `actionError` is service-lifetime state, so
  // without this a failed action still reads as failed the next time a screen
  // that renders it is opened.
  clearActionError(): void {
    if (!this.actionErrorState) return;
    this.actionErrorState = false;
    this.emit();
  }

  /**
   * A status read that is guaranteed to have STARTED after this call. runLoad
   * joins whatever is already in flight, which is right for polling and wrong
   * for reconciling a card action: a read that began before the request cannot
   * observe what the request changed, so joining it would report "nothing
   * happened" for an issuance that in fact succeeded.
   *
   * Drains the in-flight read first — runLoad only issues a new request when
   * none is pending — with a bound, because a poll can start inside that gap.
   * Returns false when no read of our own could be completed, so the caller can
   * tell "no card appeared" from "could not find out".
   */
  private async readStatusAfresh(): Promise<boolean> {
    for (let attempt = 0; attempt < 3 && this.loadInFlight; attempt += 1) {
      await this.loadInFlight.catch(() => {});
    }
    if (this.loadInFlight) return false;
    // The returned snapshot is the proof: a silent load whose /status read failed
    // — or whose result belonged to a session that has since been torn down —
    // resolves null instead of throwing, and that is not an answer either.
    const fresh = await this.runLoad(true, { silent: true }).catch(
      (): WirexCardSnapshot | null => null,
    );
    return fresh !== null;
  }

  // Issue an ADDITIONAL virtual card, then force a status re-read so the new card
  // is in `cards` (the 60s status cache would otherwise hide it). Resolves true on
  // success. Shares actionBusy with freeze — one card action at a time — but NOT
  // actionError: that flag drives the freeze alert's message, and a failure here
  // must not surface as "couldn't update the card" next to freeze. The caller owns
  // showing (or swallowing) this failure.
  async issueVirtualCard(): Promise<boolean> {
    if (this.actionBusyState) return false;
    this.actionBusyState = true;
    this.emit();
    const cardsBefore = this.snapshot.cards.length;
    try {
      await wirexService.issueVirtualCard();
      // Afresh for the same reason the failure path is: a read already running
      // when the request went out cannot contain the card it created. Joining it
      // would close the sheet over a carousel that still lacks the new card, and
      // the next tap in there would sign a second issuance.
      await this.readStatusAfresh();
      // Still not visible: the issue landed, but nothing here can show it, so
      // issuing again stays closed until a later load proves what exists.
      this.issueUnresolvedState = this.snapshot.cards.length <= cardsBefore;
      return true;
    } catch (e) {
      this.logCardActionFailure("issueVirtualCard", e);
      // The request can fail AFTER Wirex created the card — a lost response, a
      // timeout on the way back. Reporting that as a plain failure re-arms the
      // CTA, and because replay protection is per signature the next tap signs a
      // fresh request and issues a SECOND card. So read the status afresh: if a
      // card appeared, the issue itself worked and only the answer went missing.
      const reconciled = await this.readStatusAfresh();
      if (this.snapshot.cards.length > cardsBefore) {
        logWithId(
          `${LOG_EMOJI.card} WirexAccountService.issueVirtualCard`,
          "issue reported a failure but the card exists — treating as success",
          { cards_before: cardsBefore, cards_after: this.snapshot.cards.length },
          {
            source: "services/wirex/WirexAccountService.ts#issueVirtualCard",
            scope: "WirexAccountService",
            action: "issueVirtualCard",
            event: "STATE",
            context: "system",
          },
        );
        return true;
      }
      // No read of our own got through, so "no new card" is not something we
      // know — it is something we failed to find out. Block a retry until a
      // later load settles it; signing a fresh request on a guess is the one
      // outcome that costs the user a second card.
      this.issueUnresolvedState = !reconciled;
      return false;
    } finally {
      this.actionBusyState = false;
      this.emit();
    }
  }

  // PERMANENTLY close a card, then force a status re-read so it drops out of
  // `cards` and the carousel stops showing it. Irreversible — the caller must
  // have taken an explicit confirmation before this runs. Like issueVirtualCard,
  // a failure is the caller's to report, not actionError's.
  // `last4` must be the digits shown for THIS card — the server verifies them
  // against Wirex, so they come from the same snapshot entry as the id.
  async closeCard(cardId: string, last4: string): Promise<boolean> {
    if (!cardId || !isWirexCardLast4(last4) || this.actionBusyState) return false;
    this.actionBusyState = true;
    this.emit();
    try {
      await wirexService.closeCard(cardId, last4);
      // Afresh: a read that started before the close still carries the card, and
      // reporting success over it leaves reveal, freeze and close wired to a card
      // Wirex no longer honours.
      await this.readStatusAfresh();
      return true;
    } catch (e) {
      this.logCardActionFailure("closeCard", e);
      // Same lost-response case as issueVirtualCard, mirrored: the close can
      // land and the answer not come back. Read afresh — a joined read predates
      // the request — and if the card is gone the close succeeded. Reporting a
      // failure would send the user to confirm an irreversible action that
      // already happened.
      const reconciled = await this.readStatusAfresh();
      if (reconciled && !this.snapshot.cards.some((c) => c.id === cardId)) return true;
      return false;
    } finally {
      this.actionBusyState = false;
      this.emit();
    }
  }

  // One-shot silent reload after a degraded balance read, capped so a token
  // the server persistently reports as null can't poll forever. The attempt
  // counter resets on the first clean read (clearBalanceRetry).
  private scheduleBalanceRetry(): void {
    if (this.balanceRetryTimer !== null) return;
    if (this.balanceRetryAttempt >= BALANCE_RETRY_MAX_ATTEMPTS) return;
    this.balanceRetryTimer = setTimeout(() => {
      this.balanceRetryTimer = null;
      this.balanceRetryAttempt += 1;
      void this.runLoad(false, { silent: true });
    }, BALANCE_RETRY_INTERVAL_MS);
  }

  private clearBalanceRetry(): void {
    if (this.balanceRetryTimer !== null) {
      clearTimeout(this.balanceRetryTimer);
      this.balanceRetryTimer = null;
    }
    this.balanceRetryAttempt = 0;
  }

  // Bank-details re-poll: after each load, if approved with a card but no IBAN
  // yet, schedule a silent refresh (capped at MAX attempts). Reset when the
  // condition no longer holds. Mirrors the former reactive effect's semantics.
  // Reads the KYC'd name once per wallet and patches it into the live snapshot.
  // Failures are NOT cached: the name is optional detail, so a blip just leaves
  // it null and the next load retries. The in-flight flag keeps polls from
  // stacking requests on that route in the meantime.
  private holderNameInFlight = false;

  private async loadHolderName(wallet: string): Promise<void> {
    if (this.holderNameInFlight) return;
    this.holderNameInFlight = true;
    try {
      const eligibility = await wirexService.getUser(wallet);
      holderNameCache = { wallet, name: eligibility.holderName };
      if (this.snapshot.wallet === wallet && this.snapshot.holderName !== eligibility.holderName) {
        this.snapshot = { ...this.snapshot, holderName: eligibility.holderName };
        this.emit();
      }
    } catch {
      // Never log the profile payload or the failure detail (PII).
    } finally {
      this.holderNameInFlight = false;
    }
  }

  private evaluateBankDetailsPoll(): void {
    const s = this.snapshot;
    const shouldPollBankDetails = s.isApproved && Boolean(s.card?.id) && !s.iban?.iban;

    if (this.bankDetailsPollTimer !== null) {
      clearTimeout(this.bankDetailsPollTimer);
      this.bankDetailsPollTimer = null;
    }

    if (!shouldPollBankDetails) {
      this.bankDetailsPollAttempt = 0;
      return;
    }

    if (this.bankDetailsPollAttempt >= BANK_DETAILS_POLL_MAX_ATTEMPTS) return;

    this.bankDetailsPollTimer = setTimeout(() => {
      this.bankDetailsPollTimer = null;
      this.bankDetailsPollAttempt += 1;
      void this.runLoad(true, { silent: true });
    }, BANK_DETAILS_POLL_INTERVAL_MS);
  }
}

export const wirexAccountService = new WirexAccountService();
