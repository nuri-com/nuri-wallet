import { LOG_EMOJI, newOp } from "../../lib/OperationLogUtils";
import { maskAddress } from "../../lib/mask";
import { getEthereumAddress } from "../../lib/secureKeyStorage";
import { getErc20Balance } from "../balance/MultiCurrencyBalanceService";
import {
  getBaseMainnetErc20Balance,
  getBaseTransactionOutcome,
  signAndBroadcastBaseMainnetTx,
  signCowOrderOnBase,
} from "../base/BaseTokenTransferService";
import {
  SwapKitDirectSwapStore,
  listAbandonedSwapOrders,
  noteAbandonedSwapOrder,
  type DirectSwapRecord,
} from "./SwapKitDirectSwapStore";
import { EventBus } from "../events/AppEventBusService";

/**
 * A direct EVM swap reached a terminal state: `{ txId, destination, ok }`.
 * Listeners are the balances a swap can settle ON — they hold optimistic
 * figures that only this outcome can confirm or take back.
 */
export const DIRECT_SWAP_SETTLED_EVENT = "swap:directSettled";

export type DirectSwapSettled = {
  txId: string;
  destination?: "card";
  /** Terminal COMPLETED. False is a terminal failure, never "not yet". */
  ok: boolean;
};

import { signAndBroadcastSwapKitEvmTx } from "./SwapKitEvmSigner";
import {
  baseStableToken,
  swapKitStableToken,
  type BaseStableAssetId,
  type SwapKitStableToken,
} from "./SwapKitStableAssets";
import {
  BASE_MAINNET_CHAIN_ID,
  assertSupportedSwapActions,
  claimSwapLoop,
  executeSwapKitSwap,
  extractSwapKitOrderId,
  fetchCuratedRoutes,
  isExecutableRoute,
  isTerminal,
  releaseSwapLoop,
  routeSwapKitSwap,
  runSwapKitBroadcastStatusLoop,
  runSwapKitSwapLoop,
  type SwapKitCreateResponse,
  type SwapKitRouteOption,
} from "./SwapKitService";

/**
 * The SINGLE implementation of a stablecoin↔stablecoin swap the wallet signs
 * itself: one `sign_and_broadcast_evm_tx` funded straight from the EOA, no
 * deposit address and therefore no custody gap. Both live directions run
 * through it, parameterised only by the token pair:
 *
 *   USDC → EURC   SwapKitUsdcRecoveryService (stranded-topup recovery)
 *   EURC → USDC   SwapKitStableSwapService
 *
 * Every safety property lives here, so neither direction can drift from the
 * other: an explicit positive amount clamped to the live balance, a mandatory
 * floor on the receive side, an approval ceiling derived from the live quote,
 * one loop per order id app-wide, and a durable row that carries the settlement
 * poll key across a restart.
 *
 * It runs in TWO steps so route discovery remains read-only and only the route
 * the user accepts is passed to `swap_execute`:
 *
 *   quoteDirectEvmSwap    prices the route (read-only api). Creates nothing,
 *                         signs nothing, writes nothing.
 *   executeDirectEvmSwap  takes the accepted quote and does the rest: create,
 *                         sign, broadcast, track.
 *
 * The floor therefore always comes from a price the caller has already seen, so
 * a create whose price misses it is a genuine surprise — it ends the run rather
 * than minting another order to be measured against the same rejected floor.
 */

/** One side of the pair, from the shared registry. */
export type DirectSwapToken = SwapKitStableToken;

/** The receive side. Its contract is never touched locally, so none is needed. */
export type DirectSwapTarget = {
  asset: string;
  symbol: string;
};

// Used only by the one-shot compatibility helper to prefer LI.FI. Interactive
// execution is pinned by the accepted curated routeId and supports both LI.FI
// broadcast actions and CoW typed-data actions.
const PROVIDER = "lifi";
const WALLET_CAPABILITIES = ["sign_and_broadcast_evm_tx", "sign_typed_data"];

// A stale quote reverts in simulation, so a SIGNING failure requotes. Bounded
// because a route that is structurally broken (rather than merely stale) would
// otherwise mint orders forever.
//
// Only a signing failure ever gets here. A create whose price the accepted floor
// rejects fails immediately: the floor comes from a quote the user already saw,
// so minting a second order to measure against that same rejected floor cannot
// succeed — it can only leave another unsigned order behind.

/**
 * How long an accepted quote may be acted on. The server prices these routes
 * with an effectively zero slippage tolerance, so a quote the user accepted
 * minutes ago says nothing about the current price — and acting on it would put
 * the create-time floor check on data the user never saw. Past this, the caller
 * must quote again.
 */
export const DIRECT_QUOTE_TTL_MS = 2 * 60 * 1000;

// See SwapKitCardTopupService: router approvals sit marginally above the swap
// amount; the cap keeps the same 1% headroom used everywhere else.
// The server builds LI.FI approvals at depositAmount * 1.02 (its
// providers/lifi.mjs); a client ceiling below that refuses every rebuilt action
// forever — "Sweep approval exceeds the detected balance" — with nothing the
// user can do about it. Match the server exactly.
const APPROVAL_TOLERANCE = 1.02;

// A durable row with no broadcast hash is a pre-signing intent: it is unknown
// whether anything was signed. Nothing can re-drive it — the swap is a single
// atomic transaction, so the funds are either untouched or already converted —
// so after this long it is dropped rather than kept forever.
const INTENT_TTL_MS = 60 * 60 * 1000;

/**
 * The live balance of one side of the pair. Base keeps its dedicated transport
 * (Alchemy, which the Base service needs elsewhere); every other chain reads
 * through the shared per-chain RPC with the same failover.
 */
export async function readDirectSwapBalance(
  source: DirectSwapToken,
  address: string,
): Promise<number> {
  if (source.chainId === BASE_MAINNET_CHAIN_ID) {
    const units = await getBaseMainnetErc20Balance(source.token, address as `0x${string}`);
    return Number(units) / 10 ** source.decimals;
  }
  return getErc20Balance(source.chainId, source.token, address, source.decimals);
}

/**
 * A direct swap reached a terminal state. Announced rather than acted on: the
 * balances that owe a correction (the card today) live behind their own
 * services, and this file must not learn any of them. Fired from BOTH the
 * foreground run and the resume path, so an order that settled while the app
 * was closed reconciles exactly like one that settled in front of the user.
 */
function announceSettled(txId: string, destination: "card" | undefined, ok: boolean): void {
  try {
    EventBus.emit(DIRECT_SWAP_SETTLED_EVENT, { txId, destination, ok });
  } catch {}
}

/** Storage is best effort — a failed write must never fail a swap. */
async function dropRecord(txId: string): Promise<void> {
  try {
    await SwapKitDirectSwapStore.remove(txId);
  } catch {}
}

function extractFundAmount(swap: SwapKitCreateResponse, requested: number, symbol: string): number {
  const raw = swap.fund?.amount ?? swap.route?.totalDeposit;
  const amount = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`SwapKit did not return a ${symbol} funding amount.`);
  }
  // The server must never ask for more than we offered — that would reach past
  // the caller's blast-radius cap into the user's other funds.
  if (amount > requested) {
    throw new Error("SwapKit funding amount exceeds the requested swap amount.");
  }
  return amount;
}

/**
 * Structured progress for callers that want to show what the swap is doing (the
 * debug view renders all of it). Emitted in order; a run may stop at any step,
 * and the step it stopped on is the one that failed.
 */
export type DirectSwapProgress =
  | { step: "balance"; symbol: string; balance: number; askedFor: number; requested: number }
  | {
      // The priced route, from the route api. Nothing exists on the server yet:
      // this step has no order id because quoting mints no order.
      step: "quote";
      provider: string | null;
      path: string[];
      send: number;
      sendSymbol: string;
      receive: number;
      receiveSymbol: string;
    }
  | {
      step: "route";
      provider: string | null;
      path: string[];
      deposit: number;
      depositSymbol: string;
      receive: number | null;
      receiveSymbol: string;
      txId: string;
    }
  | { step: "action"; type: string; to: string; chainId: number | null; hasApproval: boolean }
  | { step: "signed"; hash: string; gas: string }
  | { step: "requote"; attempt: number; of: number }
  | { step: "status"; status: string; terminal: boolean };

/**
 * One line per progress step, for callers that render the run. Prints full
 * hashes and addresses, unlike this service's op logs, which mask them — only
 * the debug view consumes this.
 */
export function formatDirectSwapProgress(p: DirectSwapProgress): string {
  switch (p.step) {
    case "balance":
      return `balance ${p.balance} ${p.symbol} · asked ${p.askedFor} · swapping ${p.requested}`;
    case "quote": {
      const path = p.path.length > 0 ? p.path.join(" → ") : "direct";
      return `quote ${p.provider ?? "auto"} · ${path} · ${p.send} ${p.sendSymbol} → ${p.receive} ${p.receiveSymbol} (nothing created)`;
    }
    case "route": {
      const path = p.path.length > 0 ? p.path.join(" → ") : "direct";
      const receive = p.receive === null ? "?" : String(p.receive);
      return `route ${p.provider ?? "auto"} · ${path} · ${p.deposit} ${p.depositSymbol} → ${receive} ${p.receiveSymbol} · ${p.txId}`;
    }
    case "action":
      return `action ${p.type} · chain ${p.chainId ?? "?"} · to ${p.to} · approval ${p.hasApproval ? "yes" : "no"}`;
    case "signed":
      return `gas estimated ${p.gas} · broadcast ${p.hash}`;
    case "requote":
      return `quote stale (reverted in simulation) · requoting ${p.attempt}/${p.of}`;
    case "status":
      return `status ${p.status || "?"}${p.terminal ? " (terminal)" : ""}`;
  }
}

export type DirectEvmSwapParams = {
  source: DirectSwapToken;
  target: DirectSwapTarget;
  /** Where the receive side lands. */
  settleTarget: string;
  /**
   * Mandatory, positive: the exact deposit-side amount to swap. There is
   * deliberately no "swap whatever is there" mode — the user holds funds of
   * their own, and an automatic run must never touch them. The only clamp
   * applied here is against the live balance, so a caller working from a stale
   * figure cannot ask for more than exists.
   */
  amount: number;
  /**
   * The floor the price must clear on the receive side. Mandatory and positive
   * UNLESS `minReceiveRatio` is given: a caller that has no trustworthy price of
   * its own must not invent one — an outside estimate that sits above what the
   * router actually offers rejects every price it is compared against.
   */
  minReceive?: number;
  /**
   * Derive the floor from the ROUTE quote instead: `quote × ratio`. This still
   * protects against the create coming back materially worse, without
   * pretending to know the price up front, and it is measured before any order
   * exists.
   */
  minReceiveRatio?: number;
  /** Below this there is nothing worth swapping; a normal, non-error outcome. */
  dust?: number;
  /** Operation-log identity of the calling direction. */
  op: { scope: string; action: string };
  onProgress?: (progress: DirectSwapProgress) => void;
};

export type DirectEvmSwapResult = {
  /** SwapKit order id, or null when the run found nothing to swap. */
  txId: string | null;
  /** Deposit-side amount actually swapped, in the source token. */
  swappedAmount: number;
  /**
   * The receive-side amount the accepted quote stated, in the target token.
   * The quote, not the fill — the exact fill is only knowable from the mined
   * transfer — so treat it as an upper bound, never as a credited balance.
   */
  quotedReceive: number | null;
};

/**
 * A price the user can be shown and can accept. NOTHING exists on the server
 * for it: it comes from the read-only route api, so no order is minted, no
 * durable row is written and no signature is possible from it alone.
 *
 * It is also the whole input to `executeDirectEvmSwap` — hand back the object
 * that was accepted and the execution is bound to exactly that pair, amount,
 * destination and price.
 */
export type DirectEvmQuote = {
  source: DirectSwapToken;
  target: DirectSwapTarget;
  /** Where the receive side lands. */
  settleTarget: string;
  /** Deposit-side amount the price is for, already clamped to the live balance. */
  sendAmount: number;
  /** What the route says this deposit buys. A price, never a promise. */
  receiveAmount: number;
  /** receive / send, for display. */
  rate: number;
  provider: string | null;
  path: string[];
  /**
   * The route api's own id. Execution sends this exact id back to swap_execute;
   * the accepted floor is independently re-checked before anything is signed.
   */
  routeId: string | null;
  /** Whether this exact provider route is proven and executable by this wallet. */
  executable: boolean;
  /** Provider-estimated completion time, when stated by the route. */
  etaSeconds?: number;
  quotedAt: number;
  expiresAt: number;
};

export type QuoteDirectEvmSwapParams = {
  source: DirectSwapToken;
  target: DirectSwapTarget;
  /** Where the receive side lands. */
  settleTarget: string;
  /** Mandatory, positive. Clamped to the live balance before pricing. */
  amount: number;
  /** Below this there is nothing worth swapping; a normal, non-error outcome. */
  dust?: number;
  onProgress?: (progress: DirectSwapProgress) => void;
};

/**
 * The priced route for this pair, read-only.
 *
 * `swap_options` is the surface the Bitcoin path quotes from and is preferred:
 * it names the provider, the hop path and the route id. It is a CURATED
 * surface, though, and does not cover every pair — so a pair it does not price
 * falls back to `swap_route`, which prices anything the server can route and is
 * what the unattended USDC→EURC conversion has always used.
 *
 * Neither call creates an order. `swap_execute` is called only by
 * `executeDirectEvmSwap` after route selection.
 */
type PricedDirectRoute = {
  receive: number;
  provider: string | null;
  path: string[];
  routeId: string | null;
  executable: boolean;
  quoteDeadline?: string | null;
  etaSeconds?: number;
};

const directEtaSeconds = (option: SwapKitRouteOption): number | undefined => {
  const seconds = (option.legs ?? []).reduce((sum, leg) => {
    const value = Number(leg.etaSeconds);
    return Number.isFinite(value) && value > 0 ? sum + value : sum;
  }, 0);
  return seconds > 0 ? seconds : undefined;
};

async function readRouteQuotes(
  source: DirectSwapToken,
  target: DirectSwapTarget,
  amount: number,
  eoa: string,
  label: string,
): Promise<PricedDirectRoute[]> {
  const options = await fetchCuratedRoutes({
    from: source.asset,
    to: target.asset,
    amount,
    side: "deposit",
    fromAddress: eoa,
    walletCapabilities: WALLET_CAPABILITIES,
  }).catch((): SwapKitRouteOption[] => []);
  const priced = options.filter((option) => Number(option.totalSettle) > 0);
  if (priced.length > 0) {
    return priced.map((option) => {
      const etaSeconds = directEtaSeconds(option);
      return {
        receive: Number(option.totalSettle),
        provider: option.providers?.[0] ?? null,
        path: (option.path ?? []).map(String),
        routeId: option.routeId || null,
        executable: isExecutableRoute(option),
        quoteDeadline: option.quoteDeadline,
        ...(etaSeconds != null ? { etaSeconds } : {}),
      };
    });
  }

  const route = await routeSwapKitSwap({
    from: source.asset,
    to: target.asset,
    amount,
    side: "deposit",
  });
  const candidates = (route.quotes ?? [route.bestExecutable, route.best]).filter(Boolean);
  const seen = new Set<string>();
  const fallback: PricedDirectRoute[] = candidates.flatMap((quote): PricedDirectRoute[] => {
    const provider = typeof quote?.provider === "string" ? quote.provider.toLowerCase() : "";
    const receive = Number(quote?.settleAmount);
    if (!provider || seen.has(provider) || !Number.isFinite(receive) || receive <= 0) return [];
    seen.add(provider);
    return [
      {
        receive,
        provider,
        path: [],
        routeId: null,
        executable: false,
      } satisfies PricedDirectRoute,
    ];
  });
  if (fallback.length === 0) throw new Error(`No ${label} route is available right now.`);
  return fallback;
}

/**
 * Price a direct EVM swap WITHOUT creating anything.
 *
 * Returns null when there is nothing worth swapping (below dust) — a normal
 * outcome, not an error. Everything else throws: an amount that is not positive,
 * a wallet with no address, a pair the server will not price.
 */
export async function quoteDirectEvmSwaps(
  params: QuoteDirectEvmSwapParams,
): Promise<DirectEvmQuote[]> {
  const { source, target } = params;
  const label = `${source.symbol}→${target.symbol}`;
  const emit = (progress: DirectSwapProgress) => {
    try {
      params.onProgress?.(progress);
    } catch {}
  };
  const eoa = await getEthereumAddress();
  if (!eoa) throw new Error("Ethereum wallet address not available.");
  if (!Number.isFinite(params.amount) || params.amount <= 0) {
    throw new Error(`${label} swap requires a positive amount.`);
  }

  const balance = await readDirectSwapBalance(source, eoa);
  const requested = Math.min(balance, params.amount);
  emit({ step: "balance", symbol: source.symbol, balance, askedFor: params.amount, requested });

  const dust = params.dust ?? 1 / 10 ** source.decimals;
  if (requested < dust) return [];

  const routes = await readRouteQuotes(source, target, requested, eoa, label);
  const quotedAt = Date.now();
  return routes.map((route) => {
    emit({
      step: "quote",
      provider: route.provider,
      path: route.path,
      send: requested,
      sendSymbol: source.symbol,
      receive: route.receive,
      receiveSymbol: target.symbol,
    });
    const routeDeadline = route.quoteDeadline ? Date.parse(route.quoteDeadline) : Number.NaN;
    return {
      source,
      target,
      settleTarget: params.settleTarget,
      sendAmount: requested,
      receiveAmount: route.receive,
      rate: route.receive / requested,
      provider: route.provider,
      path: route.path,
      routeId: route.routeId,
      executable: route.executable,
      ...(route.etaSeconds != null ? { etaSeconds: route.etaSeconds } : {}),
      quotedAt,
      expiresAt: Number.isFinite(routeDeadline)
        ? Math.min(routeDeadline, quotedAt + DIRECT_QUOTE_TTL_MS)
        : quotedAt + DIRECT_QUOTE_TTL_MS,
    };
  });
}

export type ExecuteDirectEvmSwapParams = {
  /** The quote the user accepted, unchanged. */
  quote: DirectEvmQuote;
  /**
   * The floor the accepted price must clear on the receive side. Mandatory and
   * positive: the server prices these routes with an effectively zero slippage
   * tolerance and exposes no slippage parameter, so this is the only bound on
   * what comes back. Derive it from `quote.receiveAmount`, never from an outside
   * estimate — a floor above what the route offers rejects every create.
   */
  minReceive: number;
  /** Operation-log identity of the calling direction. */
  op: { scope: string; action: string };
  /**
   * Where the receive side lands, when it is one of the app's own balances
   * rather than the user's EOA. Carried into the durable row so the settlement
   * — this run's or a later resume's — can tell that balance what happened.
   */
  destination?: "card";
  onProgress?: (progress: DirectSwapProgress) => void;
};

/**
 * Create, sign, broadcast and track the accepted quote. This is the ONLY
 * function here that calls `swap_execute`, and therefore the only one that can
 * leave an order behind or move money.
 */
export async function executeDirectEvmSwap(
  params: ExecuteDirectEvmSwapParams,
): Promise<DirectEvmSwapResult> {
  const { quote } = params;
  const { source, target } = quote;
  const label = `${source.symbol}→${target.symbol}`;
  const emit = (progress: DirectSwapProgress) => {
    try {
      params.onProgress?.(progress);
    } catch {}
  };
  const op = newOp(params.op.scope, params.op.action, LOG_EMOJI.bitcoin);
  let claimedOrderId: string | null = null;
  // Set after a broadcast or off-chain order signature: after that boundary a
  // replacement route could execute twice even when tracking is unavailable.
  let walletActionCommitted = false;
  let orderId = "";
  try {
    const eoa = await getEthereumAddress();
    if (!eoa) {
      op.error("account missing", "Ethereum wallet address not available.");
      op.end("ERR");
      throw new Error("Ethereum wallet address not available.");
    }

    if (!Number.isFinite(quote.sendAmount) || quote.sendAmount <= 0) {
      op.error("invalid swap amount", { asset: source.asset });
      op.end("ERR");
      throw new Error(`${label} swap requires a positive amount.`);
    }
    if (!Number.isFinite(params.minReceive) || params.minReceive <= 0) {
      op.error("missing minimum output", { asset: target.asset });
      op.end("ERR");
      throw new Error(`${label} swap requires the accepted minimum output.`);
    }
    if (Date.now() > quote.expiresAt) {
      // Acting on it would check the create price against a number the user saw
      // for a market that has since moved on.
      op.error("quote expired", { pair: label });
      op.end("ERR");
      throw new Error(`The ${label} quote has expired. Check the price again.`);
    }

    // Re-clamp to the live balance: the quote may be a minute old and the
    // balance is the one thing that can have fallen since. A smaller deposit
    // buys proportionally less, so the accepted floor scales with it rather than
    // rejecting a swap the user still wants.
    const balance = await readDirectSwapBalance(source, eoa);
    const requested = Math.min(balance, quote.sendAmount);
    if (!Number.isFinite(requested) || requested < 1 / 10 ** source.decimals) {
      // The balance is gone (spent elsewhere, or unreadable). Creating an order
      // for it would only mint one that can never be funded.
      op.error("nothing left to swap", { asset: source.asset, balance });
      op.end("ERR");
      throw new Error(`There is no longer enough ${source.symbol} for this swap.`);
    }
    const floor = params.minReceive * (requested / quote.sendAmount);
    op.log("swap amount", {
      eoa: maskAddress(eoa),
      asset: source.asset,
      balance,
      askedFor: quote.sendAmount,
      requested,
    });

    // The server builds these quotes with an effectively zero slippage tolerance:
    // the LI.FI calldata's minAmountOut sits a fraction of a percent under the
    // quoted rate, and neither swap_route nor swap_create exposes a slippage
    // parameter. So a pool tick between create and estimateGas puts the swap
    // underwater and it reverts in simulation. Re-signing those bytes can never
    // succeed — the quote is stale. Only that case retries, and each retry mints
    // a FRESH order. Nothing has moved when it does: estimateGas fails closed,
    // so the cost of a stale quote is an unsigned order, which is recorded as
    // abandoned so nothing polls it for the rest of the install's life.
    let fundAmount = 0;
    let quotedReceive: number | null = null;
    let final: Awaited<ReturnType<typeof runSwapKitSwapLoop>> | null = null;

    const attempt = 1;
    if (!quote.routeId) throw new Error(`The selected ${label} route is missing its route id.`);
    if (!quote.executable) throw new Error(`The selected ${label} route is not executable.`);
    const swap = await executeSwapKitSwap({
      from: source.asset,
      to: target.asset,
      amount: requested,
      side: "deposit",
      settleTarget: quote.settleTarget,
      fromAddress: eoa,
      routeId: quote.routeId,
      walletCapabilities: WALLET_CAPABILITIES,
      simulate: false,
    });

    // Route sanity BEFORE anything is signed: the server must agree our EOA
    // signs, and every planned action must be a type we can execute.
    const assistSigner = swap.assist?.signer;
    if (assistSigner && assistSigner.toLowerCase() !== eoa.toLowerCase()) {
      throw new Error(`SwapKit assist signer ${maskAddress(assistSigner)} is not this wallet.`);
    }
    if (Array.isArray(swap.actions)) assertSupportedSwapActions(swap.actions);

    const id = extractSwapKitOrderId(swap);
    if (!id) {
      // Without an order id nothing can track this swap to terminal. Fail closed
      // before signing; same rule as the EURC→BTC deposit path.
      throw new Error(`SwapKit returned no txId for the ${label} swap.`);
    }
    orderId = id;
    // One loop per order, app-wide: a concurrent resume discovering this fresh
    // order must never run a second signer against it.
    if (!claimSwapLoop(orderId)) {
      throw new Error(`Another loop is already tracking the ${label} swap order.`);
    }
    claimedOrderId = orderId;
    fundAmount = extractFundAmount(swap, requested, source.symbol);
    op.log("Direct swap (signed from the EOA, no deposit address)", {
      from: maskAddress(eoa),
      settleTarget: maskAddress(quote.settleTarget),
      pair: label,
      attempt,
      txId: `${orderId}`,
      routeId: quote.routeId,
    });
    const receive = Number(swap.receive?.amount ?? swap.route?.totalSettle);
    if (!Number.isFinite(receive) || receive < floor) {
      throw new Error(`${label} quote is below the accepted minimum output.`);
    }
    quotedReceive = receive;
    emit({
      step: "route",
      provider: typeof swap.provider === "string" ? swap.provider : quote.provider,
      path: Array.isArray(swap.route?.path) ? swap.route.path.map(String) : quote.path,
      deposit: fundAmount,
      depositSymbol: source.symbol,
      receive,
      receiveSymbol: target.symbol,
      txId: orderId,
    });
    const targetStable = baseStableToken(target.asset as BaseStableAssetId);
    const maxApprovalUnits = BigInt(
      Math.ceil(fundAmount * APPROVAL_TOLERANCE * 10 ** source.decimals),
    );
    const record = {
      txId: orderId,
      provider: quote.provider ?? "swapkit",
      routeId: quote.routeId,
      tracking: "swap_track" as const,
      fromAsset: source.asset,
      toAsset: target.asset,
      settleTarget: quote.settleTarget,
      owner: eoa,
      amount: fundAmount,
      minReceive: floor,
      chainId: source.chainId,
      createdAt: Date.now(),
      ...(params.destination ? { destination: params.destination } : {}),
    };
    await SwapKitDirectSwapStore.addDurable(record);

    let liveBroadcastStartedAt: number | undefined;
    let liveBroadcastHash: `0x${string}` | undefined;
    let liveRevertedHashes: string[] = [];
    final = await runSwapKitSwapLoop(orderId, {
      allowedActionChains: [source.chainId],
      allowedApprovalTokens: [source.token],
      onUpdate: (status) => {
        emit({
          step: "status",
          status: String(status.status || "").trim(),
          terminal: status.terminal === true,
        });
      },
      signAction: async (parsed) => {
        // A broadcast that CONFIRMED as reverted moved nothing — the input token
        // is still in the EOA and the server has reopened the leg. Un-pin it
        // here too, or this loop keeps handing back the dead hash and the retry
        // only happens after an app restart (order sk_38670dfb re-reported one
        // reverted hash 23 times). The action passed in is already REBUILT;
        // stale quote-time calldata is never replayed.
        if (liveBroadcastHash) {
          const cleared = await clearRevertedBroadcast({
            ...record,
            broadcastHash: liveBroadcastHash,
            broadcastStartedAt: liveBroadcastStartedAt,
            revertedHashes: liveRevertedHashes,
          });
          if (!cleared) {
            const error = new Error("Direct swap reverted onchain repeatedly; not signing again.");
            Object.assign(error, { postPayment: true });
            throw error;
          }
          if (cleared.broadcastHash == null) {
            liveBroadcastHash = undefined;
            liveBroadcastStartedAt = undefined;
            liveRevertedHashes = cleared.revertedHashes ?? [];
          }
        }
        if (liveBroadcastHash) return { hash: liveBroadcastHash };
        if (liveBroadcastStartedAt) {
          const error = new Error(
            "Direct swap broadcast already started; refusing to sign the same order again.",
          );
          Object.assign(error, { postPayment: true });
          throw error;
        }
        emit({
          step: "action",
          type: "sign_and_broadcast_evm_tx",
          to: parsed.to,
          chainId: parsed.chainId,
          hasApproval: Boolean(parsed.approval),
        });
        const persistBroadcastStart = async () => {
          // Persist before sendTransaction: an app exit after submission but
          // before the hash callback must not make this order signable again.
          const startedAt = Date.now();
          await SwapKitDirectSwapStore.addDurable({
            ...record,
            ...(liveRevertedHashes.length ? { revertedHashes: liveRevertedHashes } : {}),
            broadcastStartedAt: startedAt,
          });
          liveBroadcastStartedAt = startedAt;
          walletActionCommitted = true;
        };
        const persistBroadcast = async (hash: `0x${string}`) => {
          liveBroadcastHash = hash;
          walletActionCommitted = true;
          await SwapKitDirectSwapStore.addDurable({
            ...record,
            ...(liveRevertedHashes.length ? { revertedHashes: liveRevertedHashes } : {}),
            broadcastStartedAt: liveBroadcastStartedAt,
            broadcastHash: hash,
          });
        };
        const signed =
          source.chainId === BASE_MAINNET_CHAIN_ID
            ? await signAndBroadcastBaseMainnetTx({
                ...parsed,
                maxApprovalUnits,
                onBeforeBroadcast: persistBroadcastStart,
                onBroadcast: persistBroadcast,
              })
            : await signAndBroadcastSwapKitEvmTx(parsed, {
                maxApprovalUnits,
                onBeforeBroadcast: persistBroadcastStart,
                onBroadcast: persistBroadcast,
              });
        emit({ step: "signed", hash: signed.hash, gas: "gas" in signed ? String(signed.gas) : "" });
        return signed;
      },
      signTypedData: async (parsed) => {
        const signed = await signCowOrderOnBase(parsed, {
          sellToken: source.token,
          buyToken: targetStable.token,
          receiver: quote.settleTarget as `0x${string}`,
          maxSellAmount: maxApprovalUnits,
          minBuyAmount: BigInt(Math.floor(floor * 10 ** targetStable.decimals)),
        });
        walletActionCommitted = true;
        return signed;
      },
    });
    if (!final) throw new Error(`${label} swap did not start.`);

    // Only a terminal COMPLETED is success. runSwapKitBroadcastStatusLoop
    // returns the LAST status when its poll budget runs out, so a swap still
    // settling comes back non-terminal — and callers act on success by dropping
    // durable state. Reporting an unfinished swap as done would delete the only
    // row that can still drive or retry it, so the row is KEPT here and the next
    // resume polls it again.
    const status = String(final.status || "").toUpperCase();
    if (!isTerminal(final)) {
      op.error("swap not settled", { status: final.status });
      op.end("ERR");
      // The transaction is BROADCAST — this is a slow settlement, not a failure.
      // The outer catch marks it post-payment, along with every other way this
      // can fail after the broadcast.
      throw new Error(
        `${label} swap has not settled yet (status ${status || "UNKNOWN"}); the order stays open.`,
      );
    }
    // Terminal either way: there is nothing left to resume, so the durable row
    // goes before the failure is raised — a dead order must never linger and be
    // re-polled forever by a later hydrate.
    await dropRecord(orderId);
    announceSettled(orderId, params.destination, status === "COMPLETED");
    if (status !== "COMPLETED") {
      op.error("swap failed", { status: final.status });
      op.end("ERR");
      throw new Error(final.explanation || `${label} swap failed.`);
    }

    op.log("Swapped", { txId: orderId, pair: label, swappedAmount: fundAmount });
    op.end("Swapped");
    return { txId: orderId, swappedAmount: fundAmount, quotedReceive };
  } catch (e) {
    op.error("swap failed", e instanceof Error ? e.message : String(e));
    op.end("ERR");
    // Once the transaction is BROADCAST the money has moved, whatever went wrong
    // afterwards — a status service that answered non-terminally, or one that
    // stopped answering at all and made the poll loop throw. Callers read this
    // flag to decide whether a retry is safe, and a retry here would sign a
    // second order against a durable row that is still resumable.
    if (walletActionCommitted && e instanceof Error) {
      (e as Error & { postPayment?: boolean }).postPayment = true;
    } else if (orderId && claimedOrderId === orderId) {
      // No wallet action was committed, so this order is safe to retire. Leaving
      // it resumable while the UI also permits a retry could later sign both the
      // abandoned order and the replacement.
      try {
        await SwapKitDirectSwapStore.retireUnsignedDurable(orderId);
        await noteAbandonedSwapOrder(orderId);
      } catch {
        // Cleanup could not prove the old order non-signable. Suppress UI retry;
        // otherwise a replacement and this still-live order could both execute.
        if (e instanceof Error) {
          (e as Error & { postPayment?: boolean }).postPayment = true;
        }
      }
    }
    throw e;
  } finally {
    if (claimedOrderId) releaseSwapLoop(claimedOrderId);
  }
}

/**
 * Quote and execute in one call, for the callers that genuinely have no step in
 * between: the unattended USDC→EURC conversion and the debug recovery tool,
 * which both act on an amount and a floor that were decided elsewhere.
 *
 * A screen must NOT use this. The whole point of the split is that a human sees
 * `quoteDirectEvmSwap`'s price and accepts it before `executeDirectEvmSwap`
 * creates anything.
 *
 * It is still strictly safer than the single call it replaces: the route is
 * priced first, so a floor the route cannot meet is refused before `swap_execute`
 * creates anything at all.
 */
export async function runDirectEvmSwap(params: DirectEvmSwapParams): Promise<DirectEvmSwapResult> {
  const { source, target } = params;
  const label = `${source.symbol}→${target.symbol}`;
  const hasRatio =
    typeof params.minReceiveRatio === "number" &&
    Number.isFinite(params.minReceiveRatio) &&
    params.minReceiveRatio > 0 &&
    params.minReceiveRatio <= 1;
  if (
    !hasRatio &&
    (!Number.isFinite(params.minReceive ?? Number.NaN) || (params.minReceive ?? 0) <= 0)
  ) {
    throw new Error(`${label} swap requires the accepted minimum output.`);
  }

  const quotes = await quoteDirectEvmSwaps({
    source,
    target,
    settleTarget: params.settleTarget,
    amount: params.amount,
    ...(params.dust != null ? { dust: params.dust } : {}),
    ...(params.onProgress ? { onProgress: params.onProgress } : {}),
  });
  const quote =
    quotes.find(
      (candidate) => candidate.provider?.toLowerCase() === PROVIDER && candidate.executable,
    ) ??
    quotes.find((candidate) => candidate.executable) ??
    null;
  if (!quote) {
    // Empty means the clamped balance was below dust. Priced-but-unexecutable
    // means funds remain and recovery is unavailable; never report that as a
    // successful zero conversion because the caller may retire the funded row.
    if (quotes.length > 0) throw new Error("No executable SwapKit route is currently available.");
    return { txId: null, swappedAmount: 0, quotedReceive: null };
  }

  // With a ratio the floor comes from what this route really offered, never from
  // a guess made outside. With an explicit floor, the route price is checked
  // against it HERE — before any order exists — so an unmeetable floor costs
  // nothing. `swap_options`/`swap_route` price the best route available, so a
  // floor they cannot meet is one the pinned direct provider cannot meet either.
  const floor = hasRatio
    ? quote.receiveAmount * (params.minReceiveRatio ?? 1)
    : (params.minReceive ?? 0);
  if (quote.receiveAmount < floor) {
    throw new Error(`${label} quote is below the accepted minimum output.`);
  }

  return executeDirectEvmSwap({
    quote,
    minReceive: floor,
    op: params.op,
    ...(params.onProgress ? { onProgress: params.onProgress } : {}),
  });
}

/**
 * How many confirmed onchain reverts one order may retry through. A same-chain
 * revert costs only gas (nothing moved), but a route that reverts repeatedly is
 * failing for a reason retrying cannot fix, so the row is retired rather than
 * burning the user's gas forever.
 */
const RESIGN_LIMIT = 3;

/**
 * Did this broadcast hash CONFIRM as reverted onchain? Only a confirmed revert
 * answers true — `getBaseTransactionOutcome` reports an unfindable hash as
 * "pending", and a pending tx must never be treated as re-signable or the
 * wallet would sign a second transaction for a swap that is about to land.
 */
async function isConfirmedRevert(hash: string, chainId: number): Promise<boolean> {
  if (chainId !== BASE_MAINNET_CHAIN_ID) return false;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return false;
  return (await getBaseTransactionOutcome(hash as `0x${string}`)) === "reverted";
}

/**
 * Clear a confirmed-reverted broadcast so the order can sign a rebuilt action,
 * journalling the dead hash first. Returns the row to keep working with, or
 * null when the order has now reverted RESIGN_LIMIT times and was retired.
 *
 * A same-chain swap is ONE atomic transaction, so a revert moved nothing and
 * the input token is still in the EOA — the server reopens the leg for exactly
 * this reason (tracker.mjs reopenSafeSameChainSigningLeg). Shared by the active
 * run and the resume loop so a revert is handled the same way in both.
 */
async function clearRevertedBroadcast(row: DirectSwapRecord): Promise<DirectSwapRecord | null> {
  if (!row.broadcastHash) return row;
  if (!(await isConfirmedRevert(row.broadcastHash, row.chainId))) return row;
  const revertedHashes = [...(row.revertedHashes || []), row.broadcastHash];
  if (revertedHashes.length >= RESIGN_LIMIT) {
    // Retire it ABANDONED-first: a bare drop leaves the server order sitting in
    // AWAITING_SIGNATURE, and owner discovery re-adopts it as a useless
    // discovered row until the intent TTL expires.
    await noteAbandonedSwapOrder(row.txId);
    await dropRecord(row.txId);
    return null;
  }
  const { broadcastHash: _dead, broadcastStartedAt: _started, ...rest } = row;
  const cleared = { ...rest, revertedHashes };
  await SwapKitDirectSwapStore.addDurable(cleared);
  return cleared;
}

/**
 * Resume direct swaps under their persisted route identity, owner and accepted
 * bounds. A genuinely unsigned row may sign once; broadcast-started, abandoned,
 * wrong-owner, and already-broadcast rows never install another signer.
 */
export async function resumeDirectEvmSwaps(): Promise<void> {
  await SwapKitDirectSwapStore.hydrate();
  const abandoned = await listAbandonedSwapOrders();
  const currentEoa = (await getEthereumAddress())?.toLowerCase();
  for (let row of SwapKitDirectSwapStore.list()) {
    if (row.tracking === "swap_track") {
      if (row.abandonedAt || abandoned.has(row.txId)) {
        await dropRecord(row.txId);
        continue;
      }
      if (!currentEoa || !row.owner || row.owner.toLowerCase() !== currentEoa) {
        // Route bounds belong to another (or unknown) account. Never install a
        // signer under the current login; soft logout also clears this store.
        await dropRecord(row.txId);
        continue;
      }
      if (!claimSwapLoop(row.txId)) continue;
      try {
        // A CONFIRMED reverted broadcast moved nothing, so the row goes back to
        // signable rather than resuming against a dead hash. Shared with the
        // active run in executeDirectEvmSwap.
        const live = await clearRevertedBroadcast(row);
        if (!live) {
          releaseSwapLoop(row.txId);
          continue;
        }
        row = live;
        const source = swapKitStableToken(row.fromAsset);
        const target = baseStableToken(row.toAsset as BaseStableAssetId);
        if (row.chainId !== source.chainId) {
          throw new Error("Direct swap source chain is inconsistent.");
        }
        const settleTarget = String(row.settleTarget || "").trim();
        if (!settleTarget) throw new Error("Direct swap settle target is missing.");
        const maxApprovalUnits = BigInt(
          Math.ceil(row.amount * APPROVAL_TOLERANCE * 10 ** source.decimals),
        );
        let liveBroadcastStartedAt = row.broadcastStartedAt;
        let liveBroadcastHash = row.broadcastHash as `0x${string}` | undefined;
        const signingCallbacks =
          liveBroadcastHash || liveBroadcastStartedAt
            ? {}
            : {
                signAction: async (parsed: Parameters<typeof signAndBroadcastSwapKitEvmTx>[0]) => {
                  if (liveBroadcastHash) return { hash: liveBroadcastHash };
                  if (liveBroadcastStartedAt) {
                    const error = new Error(
                      "Direct swap broadcast already started; refusing to sign the same order again.",
                    );
                    Object.assign(error, { postPayment: true });
                    throw error;
                  }
                  const onBeforeBroadcast = async () => {
                    const startedAt = Date.now();
                    await SwapKitDirectSwapStore.addDurable({
                      ...row,
                      broadcastStartedAt: startedAt,
                    });
                    liveBroadcastStartedAt = startedAt;
                  };
                  const onBroadcast = async (hash: `0x${string}`) => {
                    liveBroadcastHash = hash;
                    await SwapKitDirectSwapStore.addDurable({
                      ...row,
                      broadcastStartedAt: liveBroadcastStartedAt,
                      broadcastHash: hash,
                    });
                  };
                  return row.chainId === BASE_MAINNET_CHAIN_ID
                    ? signAndBroadcastBaseMainnetTx({
                        ...parsed,
                        maxApprovalUnits,
                        onBeforeBroadcast,
                        onBroadcast,
                      })
                    : signAndBroadcastSwapKitEvmTx(parsed, {
                        maxApprovalUnits,
                        onBeforeBroadcast,
                        onBroadcast,
                      });
                },
                signTypedData: (parsed: Parameters<typeof signCowOrderOnBase>[0]) =>
                  signCowOrderOnBase(parsed, {
                    sellToken: source.token,
                    buyToken: target.token,
                    receiver: settleTarget as `0x${string}`,
                    maxSellAmount: maxApprovalUnits,
                    minBuyAmount: BigInt(Math.floor(row.minReceive * 10 ** target.decimals)),
                  }),
              };
        const final = await runSwapKitSwapLoop(row.txId, {
          ...(row.broadcastHash ? { depositTxHash: row.broadcastHash } : {}),
          allowedActionChains: [row.chainId],
          allowedApprovalTokens: [source.token],
          ...signingCallbacks,
        });
        if (isTerminal(final)) {
          await dropRecord(row.txId);
          announceSettled(
            row.txId,
            row.destination,
            String(final.status || "").toUpperCase() === "COMPLETED",
          );
        }
      } catch {
        // Transient action/status outage: preserve accepted bounds for retry.
      } finally {
        releaseSwapLoop(row.txId);
      }
      continue;
    }
    if (!row.broadcastHash) {
      // Pre-signing intent: nothing here can drive it (the swap is one atomic
      // transaction, so the funds are either untouched or already converted).
      if (Date.now() - row.createdAt > INTENT_TTL_MS) {
        await dropRecord(row.txId);
      }
      continue;
    }
    // One loop per order id, app-wide.
    if (!claimSwapLoop(row.txId)) continue;
    try {
      const final = await runSwapKitBroadcastStatusLoop(row.provider, row.broadcastHash);
      if (isTerminal(final)) {
        await dropRecord(row.txId);
        // The same announcement a foreground run makes. A swap that settled
        // while the app was closed is exactly the case where the destination
        // still shows a figure nobody has reconciled.
        announceSettled(
          row.txId,
          row.destination,
          String(final.status || "").toUpperCase() === "COMPLETED",
        );
      }
    } catch {
      // Transient status outage: the row survives for the next resume.
    } finally {
      releaseSwapLoop(row.txId);
    }
  }
}
