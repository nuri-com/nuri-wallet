// services/balance/WalletBalanceStore.ts
//
// Singleton owner of the wallet's Base-mainnet EURC balance: the read, its
// EOA-scoped cache, and the poll that keeps it current. The read used to run
// only from the wallet tab's account-data hook, gated on that tab being active,
// so the figure existed only while the tab did. It is owned here instead, gated
// on the app being in the foreground, and exposed via subscribe/getSnapshot for
// `useSyncExternalStore`.
//
// SECURITY: never logs the address or the balance.

import { getEthereumAddress } from "../../lib/secureKeyStorage";
import { truncateBalanceToCents } from "../../lib/amounts";
import { WALLET_POLL_INTERVAL_MS } from "../../config/constants";
import { EventBus } from "../events/AppEventBusService";
import { autoDripBaseGasOnce } from "../base/BaseTokenTransferService";
import { getBaseWalletEurcBalance } from "./MultiCurrencyBalanceService";
import { EURC_BASE_TOKEN } from "../swapkit/SwapKitStableAssets";
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

export type WalletBalanceSnapshot = {
  /** Base-mainnet Circle EURC held by the active EOA, in EUR. null = not read yet. */
  balanceEur: number | null;
  currency: "EUR";
  source: "cache" | "live";
  updatedAt: string | null;
};

// A debit is broadcast and confirms on Base within a block or two; a credit has
// to wait for the card side to settle AND the transfer to confirm, so it is
// held far longer.
const OPTIMISTIC_DEBIT_HOLD_MS = 60_000;
const OPTIMISTIC_CREDIT_HOLD_MS = 180_000;

const INITIAL_SNAPSHOT: WalletBalanceSnapshot = {
  balanceEur: null,
  currency: "EUR",
  source: "cache",
  updatedAt: null,
};

class WalletBalanceStore {
  private snapshot: WalletBalanceSnapshot = INITIAL_SNAPSHOT;
  private readonly listeners = new Set<(snapshot: WalletBalanceSnapshot) => void>();
  private poller: ForegroundPoller | null = null;
  private unsubscribe: Array<() => void> = [];
  private inFlight: Promise<void> | null = null;
  // Bumped by reset() so a read started under the previous identity cannot
  // publish or cache its result into the new session.
  private generation = 0;
  // Moves the user has been shown that the chain has not caught up with yet.
  private optimisticAnchor: OptimisticAnchor | null = null;
  // Credits that arrived on the bus, by the correlation id their emitter gave
  // them. A refresh cannot undo one — the anchor outranks a live read for its
  // whole hold — so the emitter has to be able to name the move it wants back.
  private readonly creditHandlesByMoveId = new Map<string, number>();

  getSnapshot(): WalletBalanceSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: WalletBalanceSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setSnapshot(patch: Partial<WalletBalanceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener(this.snapshot);
  }

  /**
   * Move the displayed balance NOW, before the chain agrees. A transfer the user
   * saw no error on is treated as done: the sheet closes and both balances move
   * immediately, rather than showing the money gone from one side and absent
   * from the other for the whole settlement.
   *
   * Returns a handle the caller passes back to revert THIS move, or null.
   */
  applyOptimisticDebit(amount: number): number | null {
    return this.applyOptimisticBalance(amount, "debit");
  }

  applyOptimisticCredit(amount: number): number | null {
    return this.applyOptimisticBalance(amount, "credit");
  }

  private applyOptimisticBalance(amount: number, direction: "debit" | "credit"): number | null {
    const base = this.snapshot.balanceEur;
    if (base == null) return null;
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
    this.setSnapshot({ balanceEur: anchorTarget(anchor) });
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
    const restored = next ? anchorTarget(next) : held.baseline;
    if (this.snapshot.balanceEur === restored) return;
    this.setSnapshot({ balanceEur: restored });
  }

  /**
   * Keeps a read from undoing an optimistic move while the chain is still
   * behind. Which reads count as settlement — and, crucially, which do not — is
   * decided in decideAnchoredBalance.
   */
  private withOptimisticBalance(live: number): number {
    const anchor = this.optimisticAnchor;
    if (!anchor) return live;
    if (decideAnchoredBalance(anchor, live, Date.now()) === "accept") {
      this.optimisticAnchor = null;
      return live;
    }
    return anchorTarget(anchor);
  }

  /** Idempotent — a second call while running is a no-op. */
  start(): void {
    if (this.poller) return;
    this.unsubscribe.push(
      EventBus.on("wallet:refresh", () => {
        void this.refresh();
      }),
      // The card side authorised a withdrawal: the euros are on their way here
      // long before they land, so the wallet shows them now. The two balances
      // live in separate services, so the credit travels as an event.
      EventBus.on<{ amount?: number; asset?: string; moveId?: string }>(
        "wallet:optimisticCredit",
        (payload) => {
          const amount = Number(payload?.amount);
          // A credit that names another rail's asset is not this balance's: the
          // dollar wallet is a separate store, and showing its incoming money on
          // the euro row is a balance the user cannot spend.
          const asset = String(payload?.asset || "").toUpperCase();
          if (asset && asset !== EURC_BASE_TOKEN.asset) return;
          if (!Number.isFinite(amount) || amount <= 0) return;
          const handle = this.applyOptimisticCredit(amount);
          const moveId = payload?.moveId ? String(payload.moveId) : "";
          if (moveId && handle != null) this.creditHandlesByMoveId.set(moveId, handle);
        },
      ),
      // The emitter learned the credit was wrong — the money moved in another
      // currency, or not at all.
      EventBus.on<{ moveId?: string }>("wallet:revokeOptimisticCredit", (payload) => {
        const moveId = payload?.moveId ? String(payload.moveId) : "";
        if (!moveId) return;
        const handle = this.creditHandlesByMoveId.get(moveId);
        if (handle == null) return;
        this.creditHandlesByMoveId.delete(moveId);
        this.revertOptimisticBalance(handle);
        void this.refresh();
      }),
    );
    void this.hydrateFromCache();
    this.poller = createForegroundPoller({
      intervalMs: WALLET_POLL_INTERVAL_MS,
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
        getCachedBalance(BALANCE_CACHE_KEYS.wallet),
      ]);
      if (generation !== this.generation || this.hasLiveBalance()) return;
      if (!address || !cached?.address) return;
      if (cached.address.toLowerCase() !== address.toLowerCase()) return;
      if (typeof cached.amount !== "number" || !Number.isFinite(cached.amount)) return;
      this.setSnapshot({
        balanceEur: this.withOptimisticBalance(truncateBalanceToCents(Math.max(0, cached.amount))),
        source: "cache",
        updatedAt: cached.updatedAt ?? null,
      });
    } catch {}
  }

  /**
   * Read the live EURC balance. Coalesced: the poll, a `wallet:refresh` and a
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
      const eur = await getBaseWalletEurcBalance(address);
      if (generation !== this.generation) return;
      // Tokens on the EOA but maybe no ETH: start a background faucet drip so
      // gas is already there before the user ever taps send. One-shot per
      // session; the send path re-checks and waits if needed.
      if (eur > 0) autoDripBaseGasOnce(address);
      this.setSnapshot({
        // The cache below keeps the ledger figure; only what is SHOWN is held.
        balanceEur: this.withOptimisticBalance(truncateBalanceToCents(eur)),
        source: "live",
        updatedAt: new Date().toISOString(),
      });
      await setCachedBalance(BALANCE_CACHE_KEYS.wallet, eur, "EUR", address);
    } catch {
      // Every fallback RPC is exhausted. Reporting €0 here would blank a wallet
      // that holds funds, so the last known figure stands until a read succeeds.
    }
  }
}

export const walletBalanceStore = new WalletBalanceStore();
