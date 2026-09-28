import { getCacheValue, setCacheValue } from "../balance/TransactionCacheService";
import { EventBus } from "../events/AppEventBusService";

// Durable store for SwapKit V2 orders (ord_…). Deliberately SEPARATE from the
// v1 SwapKitOrderStore: v1 rows and v2 rows never share a storage key, a type,
// or an id space (migration plan: never send a v1 ID to v2 or vice versa).
export type SwapKitV2StoredOrder = {
  /** v2 engine order id (ord_…). */
  orderId: string;
  /** Wallet owner (EOA) the order was committed with — swap_list key. */
  owner: string;
  from: string;
  to: string;
  /** Canonical decimal amount as committed (sided by `side`). */
  amount: string;
  side: "deposit" | "settle";
  settleTarget: string;
  refundAddress?: string | null;
  /** The deposit the user accepted at quote time — the resume-time cap for
   * any funding/signing bound. A row without it fails closed for signing. */
  acceptedDeposit?: string;
  /** Immutable commit consent bounds (contract 2.2.0), exact-decimal strings.
   * Persisted so a lost-response resume re-commits with the SAME bounds (the
   * commit is idempotent; differing bounds would be rejected). */
  acceptedDepositAmount?: string;
  minimumSettleAmount?: string;
  /** The accepted option id (`provider:route`), for display before the server's view. */
  optionId?: string;
  /** The exact recoveryKey the order was COMMITTED with (contract 2.2.0). The
   * server indexes the order by this key's hash, so every later authed call
   * (status/submit/list/cancel) MUST reuse this exact value — never re-derive
   * from live wallet identity, which can flip (EOA↔credId) mid-session and
   * orphan the order. Persisted at commit; the tracker prefers it. */
  recoveryKey?: string;
  /** Commit idempotency key — persisted BEFORE the commit request so a crash
   * between request and response retries into the same order. */
  idempotencyKey: string;
  /** Last canonical status seen (server-owned; display + resume filter). */
  status: string;
  /** What product flow created this order (display/wording only). */
  flow:
    | "stable_to_btc"
    | "btc_to_stable"
    | "direct_evm"
    | "arkade_lightning"
    | "arkade_to_btc"
    | "sweep"
    | "other";
  /** Settlement destination when the order optimistically credits a Wirex card
   * (settleTarget = the card AA, signer stays the EOA). Drives the terminal
   * DIRECT_SWAP_SETTLED_EVENT that confirms/reverts the optimistic card credit.
   * Absent/"wallet" for ordinary wallet-settled orders. */
  destination?: "card" | "wallet";
  /** Serializable inputs needed to REBUILD this order's flow-specific executor
   * set after a restart. Standard-executor flows (direct_evm, stable_to_btc)
   * leave it undefined; btc_to_stable and sweep persist their bounded funder /
   * chain-allowlist / approval-ceiling inputs here so a resume does not fall
   * back to the default set and strand a funded order (P1: resume rebuild). */
  executorSpec?: SwapKitV2ExecutorSpec;
  /** The move's leg amounts as committed (source unit / destination unit,
   * sats for a Bitcoin leg). Persisted so the Bitcoin-rail pending row, which
   * has no store of its own, comes back after the app restarts. */
  moveAmounts?: { sendAmount?: number; receiveAmount?: number };
  createdAt: number;
  updatedAt: number;
};

/** Flow-tagged, JSON-safe inputs for rebuilding executors on resume. Amounts
 * are exact strings/numbers; bigint ceilings are re-derived from them. */
export type SwapKitV2ExecutorSpec =
  | {
      flow: "standard_evm";
      chainId: number;
      tokenDecimals: number;
      acceptedDeposit: string;
      /** The source token contract every call is bound to. Orders persisted
       * before it existed carry none; resume re-derives it from `from`. */
      sourceToken?: `0x${string}`;
    }
  | {
      flow: "btc_to_stable";
      rail: string;
      /** exact bound sats for the on-chain BTC send_asset funder */
      sats?: number | null;
      /** hub-USDC leg size, if the accepted option carried one (approval cap) */
      expectedUsdc?: number | null;
      sendSource?: "arkade" | "onchain" | null;
    }
  | {
      flow: "sweep";
      chainId: number;
      tokenAddress: string;
      tokenDecimals: number;
      tokenSymbol: string;
      /** detected balance in the token's decimal unit (approval ceiling source) */
      detectedAmount: string;
    };

const STORAGE_KEY = "swapkit:v2-orders:v1";

const memory: SwapKitV2StoredOrder[] = [];
let hydratePromise: Promise<void> | null = null;
let isHydrated = false;

const isStoredOrder = (value: unknown): value is SwapKitV2StoredOrder => {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.orderId === "string" &&
    item.orderId.startsWith("ord_") &&
    typeof item.owner === "string" &&
    typeof item.idempotencyKey === "string" &&
    typeof item.status === "string" &&
    typeof item.createdAt === "number"
  );
};

async function persist(): Promise<void> {
  await setCacheValue(STORAGE_KEY, memory);
}

const TERMINAL = new Set(["COMPLETED", "FAILED", "REFUNDED", "EXPIRED", "CANCELLED"]);

export const SwapKitV2OrderStore = {
  async hydrate(): Promise<void> {
    if (isHydrated) return;
    if (!hydratePromise) {
      hydratePromise = (async () => {
        try {
          const parsed = await getCacheValue<unknown>(STORAGE_KEY);
          if (Array.isArray(parsed)) {
            memory.length = 0;
            for (const item of parsed) if (isStoredOrder(item)) memory.push(item);
          }
        } catch {}
        isHydrated = true;
      })();
    }
    await hydratePromise;
  },

  /** Synchronous after hydrate(). */
  list(): readonly SwapKitV2StoredOrder[] {
    return memory;
  },

  listOpen(): SwapKitV2StoredOrder[] {
    return memory.filter((order) => !TERMINAL.has(order.status.toUpperCase()));
  },

  get(orderId: string): SwapKitV2StoredOrder | null {
    return memory.find((order) => order.orderId === orderId) ?? null;
  },

  async upsert(order: SwapKitV2StoredOrder): Promise<void> {
    await this.hydrate();
    const index = memory.findIndex((row) => row.orderId === order.orderId);
    const next = { ...order, updatedAt: Date.now() };
    if (index >= 0) memory[index] = next;
    else memory.push(next);
    await persist();
  },

  async setStatus(orderId: string, status: string): Promise<void> {
    await this.hydrate();
    const row = memory.find((order) => order.orderId === orderId);
    if (!row) return;
    row.status = status;
    row.updatedAt = Date.now();
    await persist();
  },

  async remove(orderId: string): Promise<void> {
    await this.hydrate();
    const index = memory.findIndex((order) => order.orderId === orderId);
    if (index >= 0) {
      memory.splice(index, 1);
      await persist();
    }
  },

  /** Wipe every stored v2 order. Called on soft logout: in-flight orders are
   * bound to the previous account and must never resume under a new wallet. */
  async clear(): Promise<void> {
    memory.length = 0;
    await persist();
  },

  /** Test seam. */
  _resetForTests(): void {
    memory.length = 0;
    sessionIntentKeys.clear();
    hydratePromise = null;
    isHydrated = false;
  },
};

/** Intents written by THIS process. Each one is either awaiting its commit
 * reply, resolved into the order's real row, or abandoned by its own caller —
 * so only rows from an earlier launch can be orphans. */
const sessionIntentKeys = new Set<string>();

/** Pre-commit persistence: write the pending commit intent BEFORE the network
 * request. The reply turns it into the order's durable row (flow + bounded
 * executorSpec) before any action is signed. */
export async function persistV2CommitIntent(args: {
  idempotencyKey: string;
  owner: string;
  from: string;
  to: string;
  amount: string;
  side: "deposit" | "settle";
  settleTarget: string;
  refundAddress?: string | null;
  acceptedDeposit?: string;
  acceptedDepositAmount?: string;
  minimumSettleAmount?: string;
  /** The accepted option (`provider:route`), so the status sheet can name the
   * route before the server's first view arrives. */
  optionId?: string;
  flow: SwapKitV2StoredOrder["flow"];
  destination?: "card" | "wallet";
  recoveryKey?: string;
  executorSpec?: SwapKitV2ExecutorSpec;
  moveAmounts?: { sendAmount?: number; receiveAmount?: number };
}): Promise<void> {
  // The order id is unknown until the commit response; store the intent under
  // a synthetic id derived from the idempotency key, replaced on response.
  sessionIntentKeys.add(args.idempotencyKey);
  await SwapKitV2OrderStore.upsert({
    orderId: `ord_pending:${args.idempotencyKey}` as string,
    owner: args.owner,
    from: args.from,
    to: args.to,
    amount: args.amount,
    side: args.side,
    settleTarget: args.settleTarget,
    refundAddress: args.refundAddress ?? null,
    acceptedDeposit: args.acceptedDeposit,
    acceptedDepositAmount: args.acceptedDepositAmount,
    minimumSettleAmount: args.minimumSettleAmount,
    ...(args.optionId ? { optionId: args.optionId } : {}),
    recoveryKey: args.recoveryKey,
    idempotencyKey: args.idempotencyKey,
    status: "COMMITTING",
    flow: args.flow,
    destination: args.destination,
    executorSpec: args.executorSpec,
    ...(args.moveAmounts ? { moveAmounts: args.moveAmounts } : {}),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

/** Replace the pending-intent row with the real order id from the commit
 * response (or adopt it directly when no intent row exists). */
export async function resolveV2CommitIntent(
  idempotencyKey: string,
  orderId: string,
  status: string,
): Promise<void> {
  await SwapKitV2OrderStore.hydrate();
  const pending = SwapKitV2OrderStore.list().find(
    (row) => row.idempotencyKey === idempotencyKey && row.orderId.startsWith("ord_pending:"),
  );
  if (pending) {
    // Persist the replacement in ONE atomic step: write the real-id row FIRST
    // (carrying the full flow/executorSpec), then drop the synthetic pending
    // row. If the app dies between the two, the real order still carries its
    // bounded executor spec — never a window where only a spec-less row exists
    // and rediscovery would adopt the order as flow `other`.
    await SwapKitV2OrderStore.upsert({ ...pending, orderId, status });
    await SwapKitV2OrderStore.remove(pending.orderId);
  }
}

/** Commit intents that never received their reply (status COMMITTING). */
export function listUnresolvedV2CommitIntents(): SwapKitV2StoredOrder[] {
  return SwapKitV2OrderStore.list().filter(
    (row) => row.orderId.startsWith("ord_pending:") && row.status === "COMMITTING",
  );
}

/** The commit failed or its reply was lost: nothing was signed for it, so the
 * intent is dropped and the user asks again. Never replayed. */
export async function abandonV2CommitIntent(idempotencyKey: string): Promise<void> {
  await SwapKitV2OrderStore.remove(`ord_pending:${idempotencyKey}`);
}

/**
 * Drop commit intents left by an earlier launch (killed mid-commit, or kept as
 * "ambiguous" by an older build).
 *
 * Such an intent has, by construction, nothing signed behind it: nothing leaves
 * the wallet until the app signs, and the app signs only the actions of a
 * commit reply — which, had it arrived, would have replaced this row. So there
 * is nothing to reconcile. Re-sending its old idempotency key only re-quotes a
 * stale price (and fails its bounds) or adopts an unfunded order the user
 * already walked away from; the server retires that order on the next commit
 * for the corridor, or lets it expire. The user asks again from the move sheet.
 */
export async function discardUnsignedV2CommitIntents(): Promise<void> {
  await SwapKitV2OrderStore.hydrate();
  for (const intent of listUnresolvedV2CommitIntents()) {
    if (sessionIntentKeys.has(intent.idempotencyKey)) continue;
    await SwapKitV2OrderStore.remove(intent.orderId);
    // Its optimistic pending row (commitAndTrackV2Order's provisional id) was
    // persisted too, and the pending-transfer store keeps swap rows forever —
    // so a commit killed mid-flight left a pending swap nothing would clear.
    try {
      EventBus.emit("wallet:clearPendingTransfer", {
        txHash: null,
        orderId: `pending:${intent.idempotencyKey}`,
      });
    } catch {}
    console.log(
      `[SwapKitV2Commit] dropped unsigned ${intent.flow} commit intent ${intent.idempotencyKey}`,
    );
  }
}
