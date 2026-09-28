// services/balance/UsdcBalanceStore.ts
//
// Singleton owner of the wallet's Base-mainnet USDC balance — the dollar rail.
// The twin of WalletBalanceStore, which owns the EURC on the same EOA: one
// address, two tokens, two balances, and the token is what separates them.
//
// It lived in the home screen's state before, which meant the figure only moved
// when that screen polled it. Optimistic moves need an owner outside the render
// tree: a send has to be able to debit the rail and hand back a HANDLE, so the
// move can be taken back when the transfer turns out to have failed — and a
// screen's local anchor gives a caller nothing to hold.
//
// SECURITY: never logs the address or the balance.

import { getEthereumAddress } from "../../lib/secureKeyStorage";
import { BASE_USDC } from "../../config/network";
import { getErc20Balance } from "./MultiCurrencyBalanceService";
import { EventBus } from "../events/AppEventBusService";
import { USDC_BASE_TOKEN } from "../swapkit/SwapKitStableAssets";
import { BALANCE_CACHE_KEYS, getCachedBalance, setCachedBalance } from "./BalanceCacheService";
import { createForegroundPoller, type ForegroundPoller } from "../app/ForegroundPoller";
import { getNetworkStatus } from "../app/NetworkStatusService";
import {
  addOptimisticMove,
  anchorTarget,
  decideAnchoredBalance,
  dropOptimisticMove,
  type OptimisticAnchor,
} from "../../lib/balance/optimisticAnchor";

export type UsdcBalanceSnapshot = {
  /** Base-mainnet USDC held by the active EOA, in USD. null = not read yet. */
  balanceUsd: number | null;
  source: "cache" | "live";
  updatedAt: string | null;
};

const POLL_INTERVAL_MS = 30_000;
// A debit is broadcast and confirms on Base within a block or two; a credit has
// to wait for whatever produced it to settle first, so it is held far longer.
const OPTIMISTIC_DEBIT_HOLD_MS = 60_000;
const OPTIMISTIC_CREDIT_HOLD_MS = 180_000;
// Balances are floats, so a settled credit rarely matches its queued amount to
// the last bit. Anything under this is not a promise worth showing.
const CREDIT_EPSILON_USD = 1e-6;

const INITIAL_SNAPSHOT: UsdcBalanceSnapshot = {
  balanceUsd: null,
  source: "cache",
  updatedAt: null,
};

class UsdcBalanceStore {
  private snapshot: UsdcBalanceSnapshot = INITIAL_SNAPSHOT;
  private readonly listeners = new Set<(snapshot: UsdcBalanceSnapshot) => void>();
  private poller: ForegroundPoller | null = null;
  private unsubscribe: Array<() => void> = [];
  private inFlight: Promise<void> | null = null;
  private generation = 0;
  private optimisticAnchor: OptimisticAnchor | null = null;
  // Credits that arrived before this rail had any balance at all, kept BY NAME:
  // a queued credit is exactly as revocable as an applied one, and collapsing
  // them into a single total left a revocation with nothing to find — the
  // unreceived dollars then landed on the rail as soon as a figure showed up.
  // Applied to the first authoritative figure that turns up, so a move completed
  // during startup is not lost, and skipped when that figure has already risen
  // by the credited amount, which would otherwise overstate the balance.
  private queuedCredits: Array<{ moveId: string; amount: number }> = [];
  private queuedCreditSeenBalance: number | null = null;
  private lastSeenBalance: number | null = null;
  // Credits emitted on the bus carry a correlation id so their emitter can take
  // exactly that one back. Kept until the anchor releases it.
  private readonly creditHandlesByMoveId = new Map<string, number>();

  getSnapshot(): UsdcBalanceSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: UsdcBalanceSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setSnapshot(patch: Partial<UsdcBalanceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener(this.snapshot);
  }

  /**
   * Move the displayed balance NOW, before the chain agrees. Returns a handle
   * the caller passes back to revert THIS move, or null.
   */
  applyOptimisticDebit(amount: number): number | null {
    return this.applyOptimisticBalance(amount, "debit");
  }

  /** `moveId` names the credit so its emitter can take exactly it back later. */
  applyOptimisticCredit(amount: number, moveId = ""): number | null {
    return this.applyOptimisticBalance(amount, "credit", moveId);
  }

  private applyOptimisticBalance(
    amount: number,
    direction: "debit" | "credit",
    moveId = "",
  ): number | null {
    const base = this.snapshot.balanceUsd;
    if (base == null) {
      // Nothing to apply it to yet. A credit waits for a figure rather than
      // being dropped; a debit cannot be shown against an unknown balance and
      // the next read is the honest answer.
      if (direction === "credit" && amount > 0) {
        this.queuedCredits.push({ moveId, amount });
        if (this.lastSeenBalance != null) this.queuedCreditSeenBalance = this.lastSeenBalance;
        else void this.seedQueuedCreditBaselineFromCache();
      }
      return null;
    }
    const { anchor, id } = addOptimisticMove(
      this.optimisticAnchor,
      base,
      amount,
      direction,
      Date.now(),
      direction === "debit" ? OPTIMISTIC_DEBIT_HOLD_MS : OPTIMISTIC_CREDIT_HOLD_MS,
    );
    if (id == null || !anchor) return null;
    this.optimisticAnchor = anchor;
    this.setSnapshot({ balanceUsd: anchorTarget(anchor) });
    return id;
  }

  // The pre-settlement figure for a queued credit, when nothing has been
  // published this session: the cache row written by the last read this wallet
  // completed. Without it there is no way to tell a baseline that already
  // contains these dollars from one that does not, and adding blind overstates.
  private async seedQueuedCreditBaselineFromCache(): Promise<void> {
    const generation = this.generation;
    try {
      const [owner, cached] = await Promise.all([
        getEthereumAddress(),
        getCachedBalance(BALANCE_CACHE_KEYS.dollar),
      ]);
      if (generation !== this.generation || this.queuedCreditSeenBalance != null) return;
      if (!owner || !cached?.address) return;
      if (cached.address.toLowerCase() !== owner.toLowerCase()) return;
      if (!Number.isFinite(cached.amount)) return;
      this.queuedCreditSeenBalance = Math.max(0, cached.amount);
    } catch {}
  }

  /**
   * Take back a named credit, whether it was applied or is still waiting for a
   * figure to apply itself to. Returns false when this store never held it.
   */
  revokeCredit(moveId: string): boolean {
    const handle = this.creditHandlesByMoveId.get(moveId);
    if (handle != null) {
      this.creditHandlesByMoveId.delete(moveId);
      this.revertOptimisticBalance(handle);
      return true;
    }
    const remaining = this.queuedCredits.filter((entry) => entry.moveId !== moveId);
    if (remaining.length === this.queuedCredits.length) return false;
    this.queuedCredits = remaining;
    if (this.queuedCredits.length === 0) this.queuedCreditSeenBalance = null;
    return true;
  }

  /** Undo one move; every other outstanding move stays as it was. */
  revertOptimisticBalance(handle: number | null): void {
    const held = this.optimisticAnchor;
    if (!held || handle == null) return;
    const next = dropOptimisticMove(held, handle);
    if (next === held) return;
    this.optimisticAnchor = next;
    const restored = next ? anchorTarget(next) : held.baseline;
    if (this.snapshot.balanceUsd === restored) return;
    this.setSnapshot({ balanceUsd: restored });
  }

  // Whichever authoritative figure arrives FIRST takes the queued credit — the
  // live read or the cache. Under repeated RPC failure the cache is the only
  // baseline there will be.
  private applyQueuedCredit(baseline: number): number {
    const queued = this.queuedCredits;
    const credit = queued.reduce((sum, entry) => sum + entry.amount, 0);
    if (credit <= 0) return baseline;
    const seen = this.queuedCreditSeenBalance;
    this.queuedCredits = [];
    this.queuedCreditSeenBalance = null;
    // No figure to compare against — neither in memory nor in the cache. The
    // arriving baseline is the only authoritative thing there is, and crediting
    // on top of it could double-count a payout it already contains.
    if (seen == null) return baseline;
    // The queue can be PARTLY settled: the baseline has risen since the figure
    // these credits were queued against, but by less than their total. That rise
    // is money that has already landed, so it is consumed off the queue before
    // anything is added — crediting the full queue on top of a baseline that
    // already contains some of it publishes more than the wallet holds.
    let unsettled = Math.max(0, baseline - seen);
    if (unsettled + CREDIT_EPSILON_USD >= credit) return baseline;
    // One move each, keeping every name. Materialising the queue as a single
    // anchored total was how a queued credit lost its id at exactly the moment
    // it became visible — revocable while it waited, unrevocable once applied.
    let anchor = this.optimisticAnchor;
    let published = baseline;
    const now = Date.now();
    for (const entry of queued) {
      // A credit the baseline already covers is nothing left to promise; one it
      // covers in part is promised only for the remainder.
      const outstanding = entry.amount - unsettled;
      unsettled = Math.max(0, unsettled - entry.amount);
      if (outstanding <= CREDIT_EPSILON_USD) continue;
      const { anchor: next, id } = addOptimisticMove(
        anchor,
        published,
        outstanding,
        "credit",
        now,
        OPTIMISTIC_CREDIT_HOLD_MS,
      );
      if (!next || id == null) continue;
      anchor = next;
      published = anchorTarget(next);
      if (entry.moveId) this.creditHandlesByMoveId.set(entry.moveId, id);
    }
    if (!anchor) return baseline;
    this.optimisticAnchor = anchor;
    return published;
  }

  /** Idempotent — a second call while running is a no-op. */
  start(): void {
    if (this.poller) return;
    this.unsubscribe.push(
      EventBus.on("wallet:refresh", () => {
        void this.refresh();
      }),
      EventBus.on("wallet:transferSettled", () => {
        void this.refresh();
      }),
      // Money on its way to this rail from somewhere that owns its own balance —
      // a card withdrawal, a settled swap. A credit that names another rail's
      // asset is not this balance's.
      EventBus.on<{ amount?: number; asset?: string; moveId?: string }>(
        "wallet:optimisticCredit",
        (payload) => {
          if (String(payload?.asset || "").toUpperCase() !== USDC_BASE_TOKEN.asset) return;
          const amount = Number(payload?.amount);
          if (!Number.isFinite(amount) || amount <= 0) return;
          const moveId = payload?.moveId ? String(payload.moveId) : "";
          const handle = this.applyOptimisticCredit(amount, moveId);
          if (moveId && handle != null) this.creditHandlesByMoveId.set(moveId, handle);
        },
      ),
      // The emitter learned the credit was wrong — the money moved in another
      // currency, or not at all. A refresh cannot undo it: the anchor outranks a
      // live read for its whole hold, so the move itself has to be dropped.
      EventBus.on<{ moveId?: string }>("wallet:revokeOptimisticCredit", (payload) => {
        const moveId = payload?.moveId ? String(payload.moveId) : "";
        if (!moveId) return;
        if (this.revokeCredit(moveId)) void this.refresh();
      }),
    );
    void this.hydrateFromCache();
    this.poller = createForegroundPoller({
      intervalMs: POLL_INTERVAL_MS,
      canTick: () => !getNetworkStatus().isWaitingForNetwork,
      tick: () => {
        void this.refresh();
      },
    });
    this.poller.start();
  }

  stop(): void {
    this.poller?.stop();
    this.poller = null;
    for (const off of this.unsubscribe) {
      try {
        off();
      } catch {}
    }
    this.unsubscribe = [];
  }

  /** Sign-out / relogin to a different wallet: the balance is identity-scoped. */
  reset(): void {
    this.generation += 1;
    this.inFlight = null;
    this.optimisticAnchor = null;
    this.queuedCredits = [];
    this.queuedCreditSeenBalance = null;
    this.lastSeenBalance = null;
    this.creditHandlesByMoveId.clear();
    this.snapshot = INITIAL_SNAPSHOT;
    for (const listener of this.listeners) listener(this.snapshot);
  }

  private hasLiveBalance(): boolean {
    return this.snapshot.source === "live";
  }

  /**
   * Seed from the cached figure. Strictly EOA-scoped: the cache row must carry
   * an address and it must be the address this device currently holds, so a
   * previous account's balance can never render on a shared device.
   */
  async hydrateFromCache(): Promise<void> {
    if (this.hasLiveBalance()) return;
    const generation = this.generation;
    try {
      const [address, cached] = await Promise.all([
        getEthereumAddress(),
        getCachedBalance(BALANCE_CACHE_KEYS.dollar),
      ]);
      if (generation !== this.generation || this.hasLiveBalance()) return;
      if (!address || !cached?.address) return;
      if (cached.address.toLowerCase() !== address.toLowerCase()) return;
      if (typeof cached.amount !== "number" || !Number.isFinite(cached.amount)) return;
      const baseline = Math.max(0, cached.amount);
      this.lastSeenBalance = baseline;
      this.setSnapshot({
        balanceUsd: this.applyQueuedCredit(baseline),
        source: "cache",
        updatedAt: cached.updatedAt ?? null,
      });
    } catch {}
  }

  /**
   * Read the live USDC balance. Coalesced: the poll, a `wallet:refresh` and a
   * foreground return otherwise fan out into parallel RPC reads for one figure.
   * A failed read keeps the last known balance rather than blanking it.
   */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const run = this.readBalance().finally(() => {
      if (this.inFlight === run) this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async readBalance(): Promise<void> {
    const generation = this.generation;
    try {
      // The cached public address — never the PRF path, which would put a Face
      // ID prompt on a background poll.
      const address = await getEthereumAddress();
      if (!address || generation !== this.generation) return;
      const balance = await getErc20Balance(
        BASE_USDC.chainId,
        BASE_USDC.address,
        address,
        BASE_USDC.decimals,
      );
      if (generation !== this.generation) return;
      const anchor = this.optimisticAnchor;
      if (anchor && decideAnchoredBalance(anchor, balance, Date.now()) === "hold") {
        // The chain has not caught up yet. The promised figure stands, and the
        // cache keeps the authoritative one so a restart never opens on money
        // that never arrived.
        this.setSnapshot({
          balanceUsd: anchorTarget(anchor),
          source: "live",
          updatedAt: new Date().toISOString(),
        });
        await setCachedBalance(BALANCE_CACHE_KEYS.dollar, balance, "USD", address);
        return;
      }
      this.optimisticAnchor = null;
      this.creditHandlesByMoveId.clear();
      this.lastSeenBalance = balance;
      this.setSnapshot({
        balanceUsd: this.applyQueuedCredit(balance),
        source: "live",
        updatedAt: new Date().toISOString(),
      });
      await setCachedBalance(BALANCE_CACHE_KEYS.dollar, balance, "USD", address);
    } catch {
      // Every fallback RPC is exhausted. Reporting $0 here would blank a wallet
      // that holds funds, so the last known figure stands until a read succeeds.
    }
  }
}

export const usdcBalanceStore = new UsdcBalanceStore();
