import { getCacheValue, setCacheValue } from "../balance/TransactionCacheService";
import type { SwapKitRecoveryConsent, SwapKitRecoveryQuote } from "./SwapKitRecoveryQuote";
import { publishSwapKitRecoverySnapshotToNostr } from "../nostr/NostrBackupService";

export type SwapKitRecoveryMetadata = {
  provider?: "fixedfloat" | "cow" | "lifi" | "satora" | "bitcoinvn" | string;
  keyIndex?: number;
  actionId?: string;
  operation?: string;
  externalId?: string;
  providerExternalId?: string;
  deadline?: string | number;
  status?: string;
  transactionHashes?: string[];
  fixedFloatExchangeSubmittedAt?: number;
  publicState?: Record<string, unknown>;
  // A sweep action may sign only on the chain and for the exact token contract
  // that the server's read-only balance scan returned for this order.
  chainId?: number;
  approvalToken?: string;
  // Ceiling for any approval this order may sign, in the token's own units, from
  // the amount the read-only scan detected. Without it a server-built approval
  // is bounded only by the token identity, so its SIZE is unchecked and the
  // router could be allowed to spend past the swept balance.
  approvalMaxUnits?: string;
  // Where the sweep deposit is sent and how much of it, captured with the
  // funding intent below so the transfer stays reconstructible from durable
  // state alone. `depositTxHash` is written only once the transfer is out.
  depositTo?: string;
  depositAmount?: string;
  depositTxHash?: string;
  // The signed deposit transaction itself, written BEFORE it is broadcast. With it a resume can
  // put exactly this transaction on the network again instead of funding the order a second way.
  depositRawTx?: string;
  // True only after a bounded caller sent this order's deposit itself. Lets the
  // tracker ignore the matching send_asset action without enabling it globally.
  externallyFundedDeposit?: boolean;
  // Recovery moved this order's delivered stable from the EOA to its accepted
  // settle target, and this is that transfer. Written the moment it is out, and
  // the ONLY thing that makes the forward safe to retry: without it a resume
  // sees the pre-inclusion balance unchanged and broadcasts the same amount
  // again, sending twice what was recovered.
  forwardTxHash?: string;
};

/**
 * A sweep row written BEFORE its deposit was broadcast. It records the intent to
 * move funds, not an order that can be carried out: the transfer is external to
 * the tracker, so nothing in the pipeline could execute or retry it. The status
 * flips to PROCESSING once the transfer is out and its hash is recorded.
 *
 * A row left in this state means exactly one thing — it is unknown whether the
 * money left the wallet. That is the whole point of writing it first, and it is
 * why nothing re-broadcasts from it automatically.
 */
export const SWEEP_FUNDING_STATUS = "FUNDING";

export const isUnfundedSweepIntent = (order: SwapKitOrder): boolean =>
  order.recovery?.status === SWEEP_FUNDING_STATUS;

// A durable, in-flight card-topup order. Persisted the moment the Lightning
// invoice is paid so a swap that dies mid-flight (reverted LI.FI leg, killed
// app) can be resumed or its stranded USDC recovered on the next app start.
export type SwapKitOrder = {
  // Separate provenance: never overwrite the original quote or late-result journal.
  recoveryConsent?: SwapKitRecoveryConsent;
  recoveryNextQuote?: SwapKitRecoveryQuote;
  recoveryConsentHistory?: SwapKitRecoveryConsent[];
  kind?: "card_topup" | "discovered";
  // Where the swap settles. The pipeline is shared; only the settle target and
  // user-facing wording differ. Missing on legacy rows → treated as "card".
  destination?: "card" | "wallet";
  txId: string; // SwapKit order id
  settleTarget: string; // where EURC lands (EOA or Wirex AA)
  expectedUsdc: number; // USDC the hub promised to deliver — 0 when unknown
  // Minimum EURC output accepted on the route screen. Missing legacy values
  // are fail-closed for automatic CoW signing and USDC recovery.
  minEurc?: number;
  // The EOA's USDC balance (base units, decimal string) captured BEFORE the
  // invoice was paid. Recovery may only ever touch `balanceNow - usdcBaseline`:
  // the USDC this order actually delivered. A user who already held USDC — a
  // multi-currency balance, say — must never have it swapped by someone else's
  // failed topup. Stored as a string because JSON cannot hold a bigint.
  usdcBaseline: string;
  // Which stable the user accepted. The pipeline was written when EURC was the
  // only answer, and every figure below is still named for it; without this a
  // USDC order resuming after a restart is recovered and booked as euros —
  // the contract the user accepted, silently swapped for another one. Missing
  // on legacy rows, which are all EURC by construction.
  stable?: "EURC_BASE" | "USDC_BASE";
  sats: number;
  // The local Arkade address supplied when an Arkade-funded order was created.
  // A refund action must match it exactly before the wallet signs an output.
  arkadeRefundAddress?: string;
  createdAt: number;
  attempts: number; // signing attempts made against this order
  // Public, non-secret resume coordinates. Private keys, preimages and
  // mnemonics are deliberately not representable in this persisted shape.
  recovery?: SwapKitRecoveryMetadata;
};

// SQLite-backed (survives process death). Mirrored in `memory` so list() reads
// are synchronous after hydrate(). One key holds the whole array.
const STORAGE_KEY = "swapkit:orders:v1";

const memory: SwapKitOrder[] = [];
let hydratePromise: Promise<void> | null = null;
let isHydrated = false;

const isSwapKitOrder = (value: unknown): value is SwapKitOrder => {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.txId === "string" &&
    item.txId.trim().length > 0 &&
    typeof item.settleTarget === "string" &&
    typeof item.expectedUsdc === "number" &&
    Number.isFinite(item.expectedUsdc) &&
    (item.minEurc == null ||
      (typeof item.minEurc === "number" && Number.isFinite(item.minEurc) && item.minEurc > 0)) &&
    // A row without a usable baseline can never bound a recovery, so it is not a
    // valid order — reject it rather than let it reach the tracker uncapped.
    typeof item.usdcBaseline === "string" &&
    /^\d+$/.test(item.usdcBaseline) &&
    typeof item.sats === "number" &&
    Number.isFinite(item.sats) &&
    (item.arkadeRefundAddress == null ||
      (typeof item.arkadeRefundAddress === "string" &&
        item.arkadeRefundAddress.trim().length > 0)) &&
    typeof item.createdAt === "number" &&
    Number.isFinite(item.createdAt) &&
    typeof item.attempts === "number" &&
    Number.isFinite(item.attempts) &&
    (item.kind == null || item.kind === "card_topup" || item.kind === "discovered") &&
    (item.destination == null || item.destination === "card" || item.destination === "wallet") &&
    (item.recovery == null || typeof item.recovery === "object")
  );
};

// Awaited by the mutators so a write is durable before they return (the app may
// be killed right after paying the invoice). Persistence is best-effort —
// `memory` is the source of truth for the running session.
const persist = async () => {
  if (!isHydrated) return;
  try {
    await setCacheValue(STORAGE_KEY, memory);
  } catch {}
  // Off-device recovery copy — deliberately OUTSIDE the try: a failed local
  // write is exactly when the snapshot matters most, so it must still publish.
  void publishSwapKitRecoverySnapshotToNostr(memory).catch(() => {});
};

/**
 * Every row carries its kind. Only owner discovery and the sweep write "discovered" rows, and they
 * always say so; every other row is a top-up the app created itself. A row without a kind (written
 * before the field existed, or by a writer that left it out) is therefore a top-up, and it is read and
 * written as one: the tracker keys the resume of an externally funded deposit on that kind, so a
 * kind-less top-up that already paid its deposit would be refused its next step after a restart.
 * The off-device restore applies the same rule.
 */
function withKind(order: SwapKitOrder): SwapKitOrder {
  return order.kind ? order : { ...order, kind: "card_topup" };
}

function ensureHydrated(): Promise<void> {
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    let parsed: unknown = null;
    try {
      parsed = await getCacheValue<unknown>(STORAGE_KEY);
    } catch {}
    if (Array.isArray(parsed)) {
      const byId = new Map<string, SwapKitOrder>();
      for (const row of parsed) {
        if (isSwapKitOrder(row)) byId.set(row.txId, withKind(row));
      }
      memory.splice(0, memory.length, ...byId.values());
    }
    isHydrated = true;
  })();
  return hydratePromise;
}

// Every mutation runs alone, in call order. A mutation awaits storage between reading `memory` and
// committing to it; without this, one that commits a snapshot taken before another mutation finished
// would silently undo that mutation (an order added or removed meanwhile would vanish from memory,
// from the next write and from the off-device copy). A failed mutation does not block the ones after it.
let mutationTail: Promise<unknown> = Promise.resolve();

function serialized<T>(run: () => Promise<T>): Promise<T> {
  const next = mutationTail.then(run, run);
  mutationTail = next.then(
    (): undefined => undefined,
    (): undefined => undefined,
  );
  return next;
}

export const SwapKitOrderStore = {
  hydrate(): Promise<void> {
    return ensureHydrated();
  },

  add(input: SwapKitOrder): Promise<void> {
    const order = withKind(input);
    return serialized(async () => {
      // Hydrate first: adding before the initial hydrate completes would let the
      // completing splice-replace drop this row (and persist() no-ops while
      // !isHydrated), losing a paid order.
      await ensureHydrated();
      const idx = memory.findIndex((o) => o.txId === order.txId);
      const existing = memory[idx];
      const consent = idx >= 0 ? memory[idx].recoveryConsent : undefined;
      if (idx >= 0) memory.splice(idx, 1);
      memory.unshift(
        consent
          ? {
              ...order,
              recoveryConsent: consent,
              recoveryNextQuote: existing.recoveryNextQuote,
              recoveryConsentHistory: existing.recoveryConsentHistory,
            }
          : order,
      );
      await persist();
      try {
        console.log("[SwapKitOrderStore] add", {
          txId: `${order.txId}…`,
          sats: order.sats,
          expectedUsdc: order.expectedUsdc,
          minEurc: order.minEurc ?? null,
          count: memory.length,
        });
      } catch {}
    });
  },

  remove(txId: string): Promise<void> {
    return serialized(async () => {
      await ensureHydrated();
      const idx = memory.findIndex((o) => o.txId === txId);
      if (idx >= 0) memory.splice(idx, 1);
      await persist();
      try {
        console.log("[SwapKitOrderStore] remove", {
          txId: String(txId || ""),
          count: memory.length,
        });
      } catch {}
    });
  },

  list(): SwapKitOrder[] {
    return memory.slice();
  },

  /**
   * Funds-sensitive write: persist the whole row, then read it back from storage and require the
   * exact row to be there before returning. Unlike add(), a failed local write is NOT swallowed.
   * Used for the order whose signed deposit is about to be broadcast: if this does not return, the
   * caller must not broadcast, because nothing on disk could recognise or re-send that payment.
   * Memory is only updated once the write is proven, so a failed attempt leaves no phantom row.
   * Runs in the store's mutation queue, so no other add/remove can change memory between the
   * snapshot it writes and the one it commits.
   */
  addDurable(input: SwapKitOrder): Promise<void> {
    // Verified exactly as it is stored, kind included.
    const order = withKind(input);
    return serialized(async () => {
      await ensureHydrated();
      const nextMemory = [order, ...memory.filter((row) => row.txId !== order.txId)];
      await setCacheValue(STORAGE_KEY, nextMemory);
      const stored = await getCacheValue<unknown>(STORAGE_KEY);
      const storedRow = Array.isArray(stored)
        ? stored.find(
            (item): item is SwapKitOrder => isSwapKitOrder(item) && item.txId === order.txId,
          )
        : undefined;
      if (!storedRow || JSON.stringify(storedRow) !== JSON.stringify(order)) {
        throw new Error("Order write could not be verified");
      }
      memory.splice(0, memory.length, ...nextMemory);
      // The off-device copy is a second chance, not the guarantee: the verified local row is.
      void publishSwapKitRecoverySnapshotToNostr(memory).catch(() => {});
    });
  },

  /** Strict durability before submission; ordinary best-effort persist is insufficient. */
  checkpointRecovery(txId: string, recoveryConsent: SwapKitRecoveryConsent): Promise<void> {
    return serialized(async () => {
      await ensureHydrated();
      const index = memory.findIndex((row) => row.txId === txId);
      if (index < 0) throw new Error("Recovery order is no longer available.");
      const row = memory[index];
      const old = row.recoveryConsent;
      const replacing = old && old.quote.quoteId !== recoveryConsent.quote.quoteId;
      if (
        replacing &&
        (old.accepted ||
          JSON.stringify(row.recoveryNextQuote) !== JSON.stringify(recoveryConsent.quote))
      ) {
        throw new Error("Recovery checkpoint changed.");
      }
      const nextRow = {
        ...row,
        recoveryConsent,
        ...(replacing
          ? {
              recoveryNextQuote: undefined,
              recoveryConsentHistory: [...(row.recoveryConsentHistory ?? []), old],
            }
          : {}),
      };
      const nextMemory = memory.slice();
      nextMemory[index] = nextRow;
      await setCacheValue(STORAGE_KEY, nextMemory);
      const stored = await getCacheValue<unknown>(STORAGE_KEY);
      const storedRow = Array.isArray(stored)
        ? stored.find((item): item is SwapKitOrder => isSwapKitOrder(item) && item.txId === txId)
        : undefined;
      if (
        !storedRow?.recoveryConsent ||
        JSON.stringify(storedRow.recoveryConsent) !== JSON.stringify(recoveryConsent)
      ) {
        throw new Error("Recovery checkpoint write could not be verified");
      }
      memory.splice(0, memory.length, ...nextMemory);
    });
  },

  /** The server has CAS-stored this unsigned successor. Keep the old signature
   * until explicit Continue, and never expose it as new price authorization. */
  checkpointRecoveryQuote(
    txId: string,
    previous: SwapKitRecoveryConsent,
    quote: SwapKitRecoveryQuote,
    assertCurrent: () => Promise<void>,
  ): Promise<void> {
    return serialized(async () => {
      await ensureHydrated();
      await assertCurrent();
      const row = memory.find((item) => item.txId === txId);
      if (!row || row.recoveryConsent !== previous || previous.accepted)
        throw new Error("Recovery checkpoint changed.");
      const next = { ...row, recoveryNextQuote: quote };
      await setCacheValue(
        STORAGE_KEY,
        memory.map((item) => (item === row ? next : item)),
      );
      await assertCurrent();
      const index = memory.indexOf(row);
      if (index < 0 || row.recoveryConsent !== previous || previous.accepted)
        throw new Error("Recovery checkpoint changed.");
      memory[index] = next;
    });
  },

  // Returns the new attempt count. Used to enforce MAX_SIGNING_ATTEMPTS before
  // escalating a repeatedly-reverting order to USDC recovery.
  bumpAttempts(txId: string): Promise<number> {
    return serialized(async () => {
      await ensureHydrated();
      const order = memory.find((o) => o.txId === txId);
      if (!order) return 0;
      order.attempts += 1;
      await persist();
      return order.attempts;
    });
  },

  // Full wipe for logout/reset. Awaits any in-flight hydrate() first so a late
  // merge cannot repopulate memory and persist the rows back.
  clear(): Promise<void> {
    return serialized(async () => {
      try {
        await hydratePromise;
      } catch {}
      memory.splice(0, memory.length);
      await setCacheValue(STORAGE_KEY, []);
      try {
        console.log("[SwapKitOrderStore] clear");
      } catch {}
    });
  },
};
