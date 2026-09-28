// services/bitcoin/BitcoinBalanceStore.ts
//
// Singleton owner of the Bitcoin balance STATE + refresh LOGIC for BOTH wallet
// modes (legacy MuSig2 + arkade). The store is PASSIVE/DRIVEN: it does NOT
// self-start a poll loop, does NOT register its own event/AppState listeners,
// and does NOT resolve/guess the wallet mode. Its driver calls `refresh(reason)`
// and forwards event payloads through the apply* methods. Exposes a stable
// snapshot via subscribe/getSnapshot for `useSyncExternalStore`.
//
// Two drivers can be alive at once — the headless BitcoinBalanceDriver and a
// mounted Bitcoin screen — so the poll loop has a single-owner guard and every
// refresh is coalesced; see `claimPollOwnership` and `refresh`.

import { walletService } from "./WalletService";
import { blockchainService } from "./BlockchainService";
import {
  getBitcoinBalance,
  balanceFromArkadeSummary,
  EMPTY_BITCOIN_BALANCE,
  type BitcoinBalance,
} from "./BitcoinBalanceService";
import { logWithId, LOG_EMOJI } from "../../lib/OperationLogUtils";
import {
  BALANCE_CACHE_KEYS,
  getCachedBalance,
  setCachedBalance,
} from "../balance/BalanceCacheService";
import { getEthereumAddress } from "../../lib/secureKeyStorage";
import { cachedBitcoinBalance } from "./cachedBalance";
import { PendingPurchasesStore, isMercuryoPending } from "../app/PendingPurchasesStore";
import {
  isMatchSafeForRow,
  matchPendingIncomingCandidate,
} from "../../lib/bitcoin/pendingTxMatcher";
import { getArkadeWalletSummarySnapshot } from "../arkade/ArkadeWalletService";
import { shortAddress } from "../../lib/formatting";
import { BITCOIN_PENDING_TX_CHECK_COOLDOWN_MS } from "../../config/constants";
import type { ArkadeWalletSummary } from "../arkade/types/wallet";
import { group, logger } from "../../lib/log";
import {
  decideAnchoredBalance,
  type OutgoingBalanceAnchor,
} from "../../lib/bitcoin/outgoingBalanceAnchor";

// Balance is an EVENT only when it changes; unchanged polls are trace-tier.
const balanceLog = logger("services/bitcoin/BitcoinBalanceStore.ts");

export type BitcoinBalanceSnapshot = {
  /** Legacy onchain confirmed balance (sats). */
  balance: number;
  bitcoinBalanceSource: "live" | "cache";
  unconfirmedSats: number;
  mempoolNetSatsFromTxs: number;
  pendingIncomingTxid: string | null;
  /** Recompute trigger for purchase-derived pending rows. */
  pendingPurchasesVersion: number;
  /** Full mode-aware balance (arkade byChannel/detail live here). */
  bitcoinBalance: BitcoinBalance;
};

export type BitcoinBalanceRefreshReason = "event" | "poll" | "receive" | "manual" | "arkadeUpdate";

export type ArkadeReceiveUpdatePayload = {
  walletSummary?: ArkadeWalletSummary;
  settledSats?: string | number;
};

// A collaborative exit's change only counts once it settles, which is a round
// away — minutes, not seconds. The anchor has to outlast that, or the balance
// drops to what is left of the settled sats (often zero) in the meantime.
const OUTGOING_ARKADE_BALANCE_HOLD_TTL_MS = 30 * 60 * 1000;
// An Arkade/Lightning send settles in seconds: the corridor returns the
// preconfirmed change with the send itself. Anchoring it for the exit TTL
// keeps the pre-send figure on screen long after the sats left whenever the
// change is dust and the settleable read lands under the promise — every read
// below `expected` is "hold", so the user keeps seeing money that is gone.
export const OUTGOING_ARKADE_SEND_HOLD_TTL_MS = 5 * 60 * 1000;

function parseArkadeSats(value: string | number | undefined): number {
  const sats = Number(value ?? 0);
  return Number.isFinite(sats) && sats > 0 ? Math.trunc(sats) : 0;
}

function bitcoinBalanceTotalSats(balance: BitcoinBalance | null | undefined): number {
  const total = Number(balance?.total ?? 0);
  return Number.isFinite(total) && total > 0 ? Math.trunc(total) : 0;
}

// Restate an Arkade balance at a different headline figure, leaving the
// per-source detail untouched. Only the arkade channel moves; the boarding and
// onchain numbers describe funds this send does not touch.
function withBitcoinBalanceTotal(
  balance: BitcoinBalance | null | undefined,
  total: number,
): BitcoinBalance {
  const next = Math.max(0, Math.trunc(total));
  const base = balance ?? EMPTY_BITCOIN_BALANCE;
  return {
    ...base,
    total: next,
    byChannel: { ...base.byChannel, arkade: next },
  };
}

function bitcoinBalanceFromArkadeUpdate(
  payload: ArkadeReceiveUpdatePayload,
): BitcoinBalance | null {
  if (payload.walletSummary) {
    return balanceFromArkadeSummary(payload.walletSummary);
  }
  const hasDirectBalance = payload.settledSats != null;
  if (!hasDirectBalance) return null;
  const arkade = parseArkadeSats(payload.settledSats);
  if (arkade <= 0) return null;
  return {
    total: arkade,
    byChannel: { onchain: 0, arkade, lightning: 0 },
    detail: {
      onchain: { confirmed: 0, unconfirmed: 0, txCount: 0 },
      arkade: { boardingConfirmed: 0, boardingUnconfirmed: 0 },
    },
  };
}

class BitcoinBalanceStore {
  private snapshot: BitcoinBalanceSnapshot = {
    balance: 0,
    bitcoinBalanceSource: "cache",
    unconfirmedSats: 0,
    mempoolNetSatsFromTxs: 0,
    pendingIncomingTxid: null,
    pendingPurchasesVersion: 0,
    bitcoinBalance: EMPTY_BITCOIN_BALANCE,
  };
  private listeners = new Set<(snapshot: BitcoinBalanceSnapshot) => void>();

  // Bumped on every reset() so in-flight refreshes started under a prior
  // identity discard their results instead of leaking into the new session.
  private sessionGeneration = 0;

  private pendingTxCheck: { at: number; address: string | null; inFlight: boolean } = {
    at: 0,
    address: null,
    inFlight: false,
  };
  private arkadeOutgoingBalanceHoldUntilMs = 0;
  // Used only to restore the pre-send amount when a send fails before a fresh
  // settled-balance read arrives.
  private arkadeOutgoingAnchor: OutgoingBalanceAnchor | null = null;
  private arkadeOutgoingBalanceHoldReason = "";

  private lastAddressForMempool = "";

  // Whoever drives the poll loop. Claimed by the headless driver; a Bitcoin
  // screen that is still mounted keeps its own interval and would otherwise
  // double the read rate against the same wallet. Poll ticks from anyone but the
  // owner are dropped. With nothing claimed every caller polls as before.
  private pollOwner: symbol | null = null;

  // One refresh per freshness class at a time, keyed on forceFresh. The driver's
  // poll, a screen's own tick and an inbound event land in the same beat, and
  // without this they fan out into parallel round trips for one number.
  private refreshInFlight = new Map<boolean, Promise<void>>();

  // ---- Public subscription surface ----

  getSnapshot(): BitcoinBalanceSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: BitcoinBalanceSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setSnapshot(patch: Partial<BitcoinBalanceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener(this.snapshot));
  }

  /**
   * Reset the snapshot to its initial empty value and clear the per-address
   * refresh caches, then notify subscribers. Used on in-app passkey re-login
   * (same JS process) so stale balance/pending state never carries across users.
   *
   * The PERSISTED figure is left alone. It carries the wallet it belongs to, and
   * hydration refuses a row from any other one, so it cannot leak across
   * identities — while deleting it meant every launch that signs in with a
   * passkey (which is every launch) threw away the only figure the app could
   * show before the network answered. The bitcoin balance came up as zero and
   * joined the total seconds later.
   */
  reset(): void {
    this.sessionGeneration += 1;
    this.pendingTxCheck = { at: 0, address: null, inFlight: false };
    this.arkadeOutgoingBalanceHoldUntilMs = 0;
    this.arkadeOutgoingBalanceHoldReason = "";
    this.clearArkadeOutgoingExpectedTotal();
    this.lastAddressForMempool = "";
    this.setSnapshot({
      balance: 0,
      bitcoinBalanceSource: "cache",
      unconfirmedSats: 0,
      mempoolNetSatsFromTxs: 0,
      pendingIncomingTxid: null,
      pendingPurchasesVersion: 0,
      bitcoinBalance: EMPTY_BITCOIN_BALANCE,
    });
  }

  bumpPendingPurchasesVersion(): void {
    this.setSnapshot({ pendingPurchasesVersion: this.snapshot.pendingPurchasesVersion + 1 });
  }

  /**
   * Take the poll loop. Returns false when someone else already holds it, which
   * is the caller's signal not to start an interval of its own.
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
   * On-demand entry point. Arkade is the only wallet path. `owner` identifies
   * the poll-loop owner and only matters for `reason === "poll"`.
   */
  async refresh(reason: BitcoinBalanceRefreshReason, owner?: symbol): Promise<void> {
    if (reason === "poll" && this.pollOwner !== null && owner !== this.pollOwner) return;
    const forceFresh = reason !== "poll";
    const pending = this.refreshInFlight.get(forceFresh);
    if (pending) return pending;
    const run = (async () => {
      await this.refreshArkade(forceFresh);
      void this.runArkadePendingCleanup(reason);
    })().finally(() => {
      if (this.refreshInFlight.get(forceFresh) === run) this.refreshInFlight.delete(forceFresh);
    });
    this.refreshInFlight.set(forceFresh, run);
    return run;
  }

  /**
   * Benign local cache read. Caller-triggered (driver calls it once on mount) —
   * never boot-triggered.
   */
  async hydrateFromCache(): Promise<void> {
    try {
      // Both rows are identity-scoped, exactly like the wallet's own cache: a
      // row without a wallet, or one written by another, is not this session's
      // balance. `cachedBitcoinBalance` owns that decision and the split.
      const [owner, total, onchain] = await Promise.all([
        getEthereumAddress().catch((): string | null => null),
        getCachedBalance(BALANCE_CACHE_KEYS.bitcoin),
        getCachedBalance(BALANCE_CACHE_KEYS.bitcoinOnchain),
      ]);
      const restored = cachedBitcoinBalance({ owner, arkade: total, onchain });
      if (restored) {
        logWithId(
          `${LOG_EMOJI.bitcoin} Bitcoin.balanceTrace`,
          "cache hydration",
          {
            result: "hit",
            amount: restored.total,
            onchain: restored.byChannel.onchain,
            address: total?.address || onchain?.address || "none",
            updatedAt: total?.updatedAt || onchain?.updatedAt || "none",
          },
          {
            context: "background",
            event: "CACHE_HIT",
            action: "balance",
            source: "services/bitcoin/BitcoinBalanceStore.ts#cacheHydration",
          },
        );
        this.setSnapshot({
          bitcoinBalanceSource: "cache",
          balance: restored.total,
          bitcoinBalance: restored,
        });
      } else {
        const currentTotal = Math.max(
          this.snapshot.balance,
          bitcoinBalanceTotalSats(this.snapshot.bitcoinBalance),
        );
        logWithId(
          `${LOG_EMOJI.bitcoin} Bitcoin.balanceTrace`,
          "cache hydration",
          { result: "miss", amount: 0, retainedTotal: currentTotal },
          {
            context: "background",
            event: "CACHE_MISS",
            action: "balance",
            source: "services/bitcoin/BitcoinBalanceStore.ts#cacheHydration",
          },
        );
      }
    } catch (error) {
      logWithId(
        `${LOG_EMOJI.bitcoin} Bitcoin.balanceTrace`,
        "cache hydration failed",
        { err: error instanceof Error ? error.message : String(error || "unknown") },
        {
          context: "background",
          event: "API_ERR",
          action: "balance",
          source: "services/bitcoin/BitcoinBalanceStore.ts#cacheHydration",
        },
      );
    }
  }

  /**
   * Apply an `arkade:receiveUpdated` payload directly when it carries balance
   * data. Returns true if it set the balance (caller is done), false if the
   * caller should force-refresh the arkade summary instead.
   */
  applyArkadeReceiveUpdate(payload?: ArkadeReceiveUpdatePayload): boolean {
    const next = payload ? bitcoinBalanceFromArkadeUpdate(payload) : null;
    if (next != null) {
      this.applyArkadeBalance(next, "receive_update");
      return true;
    }
    return false;
  }

  /** Apply a `bitcoin:mempoolNet` payload (legacy mempool-derived pending). */
  // biome-ignore lint/suspicious/noExplicitAny: EventBus payload shape
  applyMempoolNet(payload?: any): void {
    try {
      const payloadAddr = String(payload?.address || "")
        .trim()
        .toLowerCase();
      if (!payloadAddr) return;
      const address = walletService.getAddressSnapshot();
      const currentAddr = String(address.currentAddress || "")
        .trim()
        .toLowerCase();
      if (currentAddr && payloadAddr !== currentAddr) return;
      const next = Number(payload?.mempoolNetSats ?? 0);
      if (!Number.isFinite(next)) return;
      const nextTxid = String(payload?.pendingIncomingTxid || "").trim();
      const nextMempoolNet = Math.trunc(next);
      logWithId(
        `${LOG_EMOJI.bitcoin} Bitcoin.balanceTrace`,
        "mempool net event",
        {
          payload: shortAddress(payloadAddr) || "none",
          current: shortAddress(currentAddr) || "none",
          mempoolNet: nextMempoolNet,
          pendingIncomingTxid: nextTxid
            ? `${nextTxid.slice(0, 8)}...${nextTxid.slice(-8)}`
            : "none",
        },
        {
          context: "poll",
          event: "STATE",
          action: "balance",
          source: "services/bitcoin/BitcoinBalanceStore.ts#mempoolNetEvent",
        },
      );
      this.setSnapshot({
        mempoolNetSatsFromTxs: nextMempoolNet,
        pendingIncomingTxid: nextTxid || null,
      });
    } catch {}
  }

  /** Reset mempool-derived state when the receive address changes. */
  resetMempoolForAddress(addressKey: string): void {
    const key = String(addressKey || "")
      .trim()
      .toLowerCase();
    if (key === this.lastAddressForMempool) return;
    this.lastAddressForMempool = key;
    this.setSnapshot({ mempoolNetSatsFromTxs: 0, pendingIncomingTxid: null });
  }

  // ---- Arkade ----

  /**
   * Deduct an outgoing amount while its submission is in flight. A fresh live
   * read always wins because Arkade change may still be preconfirmed.
   */
  holdArkadeOutgoingBalance(
    reason: string,
    sentSats?: number,
    ttlMs = OUTGOING_ARKADE_BALANCE_HOLD_TTL_MS,
  ): void {
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.trunc(ttlMs) : 0;
    if (ttl <= 0) return;
    this.arkadeOutgoingBalanceHoldUntilMs = Date.now() + ttl;
    this.arkadeOutgoingBalanceHoldReason = String(reason || "outgoing_send");
    const sent = Number.isFinite(Number(sentSats)) ? Math.trunc(Number(sentSats)) : 0;
    const currentTotal = bitcoinBalanceTotalSats(this.snapshot.bitcoinBalance);
    if (sent > 0 && currentTotal > 0) {
      // Re-arming the SAME send, not a second one. A fee-bearing rail learns
      // the real figure only after it executes, and the caller re-arms with it;
      // subtracting that from the already-deducted snapshot would debit the
      // send twice — a 10 000 quote funding 10 030 briefly read as 20 030 gone.
      // The anchor's own baseline is the pre-send truth, so the deduction is
      // always measured from there.
      const existing = this.arkadeOutgoingAnchor;
      const baseline =
        existing && Date.now() <= existing.expiresAt ? existing.preSendTotal : currentTotal;
      const expected = Math.max(0, baseline - sent);
      this.arkadeOutgoingAnchor = {
        expected,
        preSendTotal: baseline,
        expiresAt: Date.now() + ttl,
      };
      this.setSnapshot({
        bitcoinBalance: withBitcoinBalanceTotal(this.snapshot.bitcoinBalance, expected),
      });
    } else {
      this.clearArkadeOutgoingExpectedTotal();
    }
    logWithId(
      `${LOG_EMOJI.bitcoin} Bitcoin.balanceTrace`,
      "arkade outgoing balance hold armed",
      {
        reason: this.arkadeOutgoingBalanceHoldReason,
        ttlMs: ttl,
        currentTotal: bitcoinBalanceTotalSats(this.snapshot.bitcoinBalance),
      },
      {
        context: "user",
        event: "STATE",
        action: "balance",
        source: "services/bitcoin/BitcoinBalanceStore.ts#holdArkadeOutgoingBalance",
      },
    );
  }

  /**
   * The send failed: give the deducted sats back and stop anchoring reads.
   */
  revertArkadeOutgoingBalance(reason: string): void {
    const restore = this.arkadeOutgoingAnchor?.preSendTotal ?? 0;
    this.clearArkadeOutgoingExpectedTotal();
    if (restore > 0) {
      this.setSnapshot({
        bitcoinBalance: withBitcoinBalanceTotal(this.snapshot.bitcoinBalance, restore),
      });
    }
    this.clearArkadeOutgoingBalanceHold(reason);
  }

  private clearArkadeOutgoingExpectedTotal(): void {
    this.arkadeOutgoingAnchor = null;
  }

  clearArkadeOutgoingBalanceHold(reason: string): void {
    if (this.arkadeOutgoingBalanceHoldUntilMs <= 0) return;
    const remainingMs = Math.max(0, this.arkadeOutgoingBalanceHoldUntilMs - Date.now());
    const holdReason = this.arkadeOutgoingBalanceHoldReason || "unknown";
    this.arkadeOutgoingBalanceHoldUntilMs = 0;
    this.arkadeOutgoingBalanceHoldReason = "";
    // The anchor deliberately survives this: the caller clears the hold when the
    // send SUCCEEDS, which is exactly when the change has not landed yet. Only a
    // read that reaches the expected figure, the anchor's TTL, or an outright
    // revert releases it.
    logWithId(
      `${LOG_EMOJI.bitcoin} Bitcoin.balanceTrace`,
      "arkade outgoing balance hold cleared",
      {
        reason: String(reason || "unknown"),
        holdReason,
        remainingMs,
      },
      {
        context: "user",
        event: "STATE",
        action: "balance",
        source: "services/bitcoin/BitcoinBalanceStore.ts#clearArkadeOutgoingBalanceHold",
      },
    );
  }

  /**
   * `readOnchain` says whether `next` carries a real onchain figure. A receive
   * or settlement event describes the ARKADE rail and reports zero for the
   * other one — persisting that would erase a good onchain balance until the
   * next full read, which is the figure the next launch would open with.
   */
  // A read of zero that follows a positive one, waiting for its confirmation.
  // Reset by any non-zero read, so it only ever spans one poll.
  private pendingArkadeZeroRead = false;

  private applyArkadeBalance(next: BitcoinBalance, source: string, readOnchain = false): void {
    const previousTotal = bitcoinBalanceTotalSats(this.snapshot.bitcoinBalance);
    const total = bitcoinBalanceTotalSats(next);
    // A send spends the whole VTXO and gets the remainder back as a new one, so
    // in between Arkade reports LESS than what is left — a partial send read as
    // zero, and the balance emptied in front of the user. While the outgoing
    // anchor stands, a read short of what should remain is that gap and the
    // promised figure holds; a read that has caught up settles it, and the
    // anchor's TTL bounds the wait either way.
    // Emptying the wallet is a real event; emptying it for one poll is not.
    // A send briefly leaves the indexer with the spent VTXO gone and the change
    // not yet visible, and that instant reads as zero — on screen the balance
    // fell to nothing and came back, twice, during one payment. A zero after a
    // positive read therefore has to be confirmed by a second one before it is
    // shown; the anchor below cannot cover this, because the flap also happens
    // outside any send.
    if (total === 0 && previousTotal > 0) {
      if (!this.pendingArkadeZeroRead) {
        this.pendingArkadeZeroRead = true;
        balanceLog.trace(
          `ignoring a first zero read over ${group(previousTotal)} sats (${source})`,
        );
        return;
      }
    } else {
      this.pendingArkadeZeroRead = false;
    }

    const anchor = this.arkadeOutgoingAnchor;
    // While a send is anchored, the promised figure is the truth on screen and
    // only a read consistent with it may replace it. The sats left when the
    // sheet closed; every read above `expected` is the indexer still describing
    // the wallet before that, and a zero is the instant where the spent VTXO is
    // gone and the change is not visible yet. Both used to be applied, which is
    // why one payment walked the balance through the old figure, nothing, and
    // the old figure again before landing.
    //
    // What DOES settle it is a read at or below `expected`: the real figure is
    // `expected` minus whatever fee the rail charged, so it arrives just under
    // the promise and retires the anchor. A deliberate sweep anchors at zero
    // and its zero read settles it the same way.
    // One rule, and it lives in the helper: the store used to carry a second
    // opinion about the same read, which is how a positive mid-send undershoot
    // cleared the anchor here while the helper said to hold it.
    if (anchor && decideAnchoredBalance(anchor, total, Date.now()) === "hold") {
      this.setSnapshot({
        bitcoinBalance: withBitcoinBalanceTotal(next, anchor.expected),
        bitcoinBalanceSource: "live",
      });
      balanceLog.trace(
        `holding ${group(anchor.expected)} sats over a ${group(total)} sats read (${source})`,
      );
      return;
    }
    this.clearArkadeOutgoingExpectedTotal();
    this.setSnapshot({ bitcoinBalance: next, bitcoinBalanceSource: "live" });
    // A successful zero is authoritative too: pending funds must not survive
    // in the cache as spendable after restart.
    // Written WITH the wallet it belongs to: the row outlives the session, and
    // the next identity must be able to tell that it is not theirs.
    void (async () => {
      try {
        const owner = await getEthereumAddress();
        await setCachedBalance(BALANCE_CACHE_KEYS.bitcoin, total, "BTC", owner ?? undefined);
        // The onchain rail is a row of its own, and only a read that actually
        // asked the chain may write it.
        if (readOnchain) {
          await setCachedBalance(
            BALANCE_CACHE_KEYS.bitcoinOnchain,
            Math.max(0, Math.trunc(next.byChannel.onchain)),
            "BTC",
            owner ?? undefined,
          );
        }
      } catch {}
    })();
    if (total !== previousTotal) {
      balanceLog.event(`Balance ${group(previousTotal)} → ${group(total)} sats (${source})`);
    } else {
      balanceLog.trace(`balance unchanged ${group(total)} sats (${source})`);
    }
  }

  private async refreshArkade(forceFresh: boolean): Promise<void> {
    try {
      const generation = this.sessionGeneration;
      const read = await getBitcoinBalance({ mode: "arkade", forceFresh });
      if (generation !== this.sessionGeneration) return;
      // An on-chain read that failed carries zeros, not a balance. Publishing
      // them would empty the on-chain rail every time mempool.space is
      // unreachable, so the last figure that WAS read stands instead.
      const previous = this.snapshot.bitcoinBalance;
      const next: BitcoinBalance =
        read.onchainRead === "failed"
          ? {
              ...read,
              byChannel: { ...read.byChannel, onchain: previous.byChannel.onchain },
              detail: { ...read.detail, onchain: previous.detail.onchain },
            }
          : read;
      this.applyArkadeBalance(
        next,
        forceFresh ? "force_refresh" : "poll",
        read.onchainRead === "ok",
      );
    } catch (error) {
      const previousTotal = bitcoinBalanceTotalSats(this.snapshot.bitcoinBalance);
      logWithId(
        `${LOG_EMOJI.bitcoin} Bitcoin.balanceTrace`,
        "arkade refresh failed; retaining optimistic balance",
        {
          forceFresh: forceFresh ? 1 : 0,
          previousTotal,
          retained: previousTotal > 0 ? 1 : 0,
          err: error instanceof Error ? error.message : String(error || "unknown"),
        },
        {
          context: "background",
          event: previousTotal > 0 ? "CACHE_HIT" : "API_ERR",
          action: "balance",
          source: "services/bitcoin/BitcoinBalanceStore.ts#refreshArkade",
        },
      );
    }
  }

  // Arkade equivalent of refreshLegacy's pending-purchase cleanup. Bought funds
  // land on the BOARDING address, but runPendingTxCheck's only legacy caller
  // scans the MuSig2 address — so in arkade the Mercuryo "processing" placeholder
  // was never eligible for removal. Reuse the SAME scan + matcher, just pointed
  // at the boarding address. Boarding comes from the warm summary snapshot
  // (no fresh fetch, no passkey prompt); with no boarding yet we retry next tick.
  // (#688)
  private async runArkadePendingCleanup(reason: BitcoinBalanceRefreshReason): Promise<void> {
    try {
      let pendingCount = 0;
      try {
        pendingCount = PendingPurchasesStore.list().length;
      } catch {}
      // Stay silent on the hot refresh path: only act/log when a placeholder
      // actually exists to clear (the 99% case is nothing pending).
      if (pendingCount === 0) return;
      // A bought purchase settles to the MuSig2 on-chain address; the boarding
      // address is only where older, arkade-destined ones landed. Both are
      // scanned so a placeholder from either era can clear.
      const boarding = (getArkadeWalletSummarySnapshot()?.boardingAddress || "").trim();
      const snapshot = walletService.getAddressSnapshot();
      const addresses = Array.from(
        new Set([snapshot.musig2Address.trim(), boarding].filter(Boolean)),
      );
      console.log("[BitcoinScreen][mercuryo] cleanup", {
        reason,
        addresses: addresses.length,
        pendingCount,
      });
      if (addresses.length === 0) return;
      // Scope the arkade reuse: Mercuryo rows ONLY (no 1Click linking — that branch
      // would otherwise mark an unrelated NearIntent swap complete off a boarding tx),
      // and require a CONFIRMED on-chain tx so the row survives the mempool/boarding
      // window instead of vanishing while the headline (available) balance is still
      // catching up. (#688 review)
      // ponytail: "confirmed boarding" is the visibility floor, not the sweep-to-available
      // ceiling — a row can still clear a beat before the swept VTXO lands. Tighten to
      // available-balance gating only if premature clears are actually observed.
      for (const address of addresses) {
        await this.runPendingTxCheck(address, reason, {
          requireConfirmed: true,
        });
      }
    } catch (e: unknown) {
      try {
        console.log(
          "[BitcoinScreen][mercuryo][arkade] cleanup error",
          e instanceof Error ? e.message : String(e),
        );
      } catch {}
    }
  }

  private async runPendingTxCheck(
    addr: string,
    source: BitcoinBalanceRefreshReason,
    opts?: { requireConfirmed?: boolean },
  ): Promise<void> {
    const requireConfirmed = opts?.requireConfirmed === true;
    const generation = this.sessionGeneration;
    try {
      await PendingPurchasesStore.cleanup();
      const pendingPaid = PendingPurchasesStore.list().filter(isMercuryoPending);

      if (pendingPaid.length === 0) return;
      if (this.pendingTxCheck.address !== addr) {
        this.pendingTxCheck = {
          at: 0,
          address: addr,
          inFlight: false,
        };
      }
      if (this.pendingTxCheck.inFlight) return;
      const now = Date.now();
      const isPoll = source === "poll";
      if (isPoll && now - this.pendingTxCheck.at < BITCOIN_PENDING_TX_CHECK_COOLDOWN_MS) {
        const suffix = addr ? String(addr).slice(-6) : "unknown";
        console.log("[BitcoinScreen][pending] tx scan skipped (cooldown)", {
          source,
          addressSuffix: suffix,
        });
        return;
      }
      this.pendingTxCheck.inFlight = true;
      this.pendingTxCheck.at = now;
      const suffix = addr ? String(addr).slice(-6) : "unknown";
      console.log("[BitcoinScreen][pending] tx scan started", {
        pendingPurchases: pendingPaid.length,
        source,
        addressSuffix: suffix,
      });
      const timeoutMs = 8000;
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
      const txs = await Promise.race([blockchainService.fetchAddressTransactions(addr), timeout]);
      if (!Array.isArray(txs)) {
        console.log("[BitcoinScreen][pending] tx scan timed out", {
          timeoutMs,
          source,
          addressSuffix: suffix,
        });
        return;
      }
      // biome-ignore lint/suspicious/noExplicitAny: esplora tx shape is untyped
      const receivedForAddress = (t: any) => {
        // biome-ignore lint/suspicious/noExplicitAny: esplora vin shape
        const ins = (t?.vin || []).reduce((sum: number, vin: any) => {
          const a = vin?.prevout?.scriptpubkey_address;
          const v = vin?.prevout?.value || 0;
          return sum + (a === addr ? v : 0);
        }, 0);
        // biome-ignore lint/suspicious/noExplicitAny: esplora vout shape
        const outs = (t?.vout || []).reduce((sum: number, vout: any) => {
          const a = vout?.scriptpubkey_address;
          const v = vout?.value || 0;
          return sum + (a === addr ? v : 0);
        }, 0);
        return outs - ins;
      };
      const incomingCandidatesFull = txs
        // biome-ignore lint/suspicious/noExplicitAny: esplora tx shape
        .map((t: any) => {
          const txid = String(t?.txid || "").trim();
          if (!txid) return null;
          const net = receivedForAddress(t);
          if (!Number.isFinite(net) || net <= 0) return null;
          // biome-ignore lint/suspicious/noExplicitAny: esplora status shape
          const blockTimeRaw = (t as any)?.status?.block_time;
          const blockTime =
            typeof blockTimeRaw === "number" && Number.isFinite(blockTimeRaw)
              ? Number(blockTimeRaw)
              : null;
          return {
            txid,
            amountSats: net,
            confirmed: !!t?.status?.confirmed,
            blockTime,
          };
        })
        .filter(Boolean)
        .slice(0, 12) as Array<{
        txid: string;
        amountSats: number;
        confirmed: boolean;
        blockTime: number | null;
      }>;
      const incomingCandidates = incomingCandidatesFull.slice(0, 8).map((c) => ({
        txid: `${c.txid.slice(0, 12)}...`,
        amountSats: c.amountSats,
        confirmed: c.confirmed,
      }));
      try {
        console.log("[BitcoinScreen][pending] tx scan candidates", {
          txCount: txs.length,
          incoming: incomingCandidates,
        });
      } catch {}
      if (pendingPaid.length > 0) {
        for (const p of pendingPaid) {
          const expectedRaw = Number(p?.amountSats ?? 0);
          const expected =
            Number.isFinite(expectedRaw) && expectedRaw > 0 ? Math.floor(expectedRaw) : 0;
          // biome-ignore lint/suspicious/noExplicitAny: pending purchase shape
          const createdAtRaw = Number((p as any)?.createdAt ?? 0);
          const hasCreatedAt = Number.isFinite(createdAtRaw) && createdAtRaw > 0;
          // requireConfirmed (arkade boarding): match only confirmed candidates so a
          // mempool tx can't be the chosen match and stall removal while a confirmed
          // one exists in the same set. (#688 review)
          const candidatesForMatch = requireConfirmed
            ? incomingCandidatesFull.filter((c) => c.confirmed)
            : incomingCandidatesFull;
          const match = matchPendingIncomingCandidate({
            expectedSats: expected,
            createdAtMs: hasCreatedAt ? createdAtRaw : null,
            candidates: candidatesForMatch,
          });
          const willRemove = isMatchSafeForRow({ expectedSats: expected, match });
          if (!willRemove) {
            try {
              console.log("[BitcoinScreen][mercuryo] refresh awaiting onchain", {
                mtid: `${String(p.id || "").slice(0, 12)}...`,
                expectedSats: expected > 0 ? expected : null,
                reason: match?.txid ? "amount-mismatch" : "no-match",
                candidates: incomingCandidates,
              });
            } catch {}
          }
          if (willRemove && match?.txid) {
            console.log("[BitcoinScreen][mercuryo] onchain tx detected; removing placeholder", {
              mtid: `${String(p.id || "").slice(0, 12)}...`,
              amountSats: expected > 0 ? expected : match.amountSats,
              txid: `${String(match.txid).slice(0, 12)}...`,
              confirmed: match.confirmed,
            });
            await PendingPurchasesStore.remove(p.id);
            if (generation !== this.sessionGeneration) return;
            this.bumpPendingPurchasesVersion();
          }
        }
      }
    } catch (e: unknown) {
      try {
        const msg = e instanceof Error ? e.message : String(e);
        console.log("[BitcoinScreen][pending] tx scan failed", msg);
      } catch {}
    } finally {
      this.pendingTxCheck.inFlight = false;
    }
  }
}

export const bitcoinBalanceStore = new BitcoinBalanceStore();
