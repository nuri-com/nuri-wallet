/**
 * Paying a pay link from the payer's own browser wallet, in any token.
 *
 * The payer picks a token their wallet holds; SwapKit v2 quotes it into the
 * link's currency (EURC or USDC on Base, or on-chain bitcoin), paid to the
 * recipient's matching address. The payer's wallet signs the route itself — there
 * is no deposit address, which is what makes routes like LI.FI (wNXM → EURC)
 * payable from this page at all. Hardware wallets (Trezor, Ledger) work through
 * any browser wallet that fronts them (MetaMask, Rabby, Frame).
 *
 * The page never trusts the server's calldata blindly: every EVM call and
 * typed-data order goes through the same route binding the signed-in wallet
 * uses (`SwapKitV2EvmRouteBinding`) — approvals only to a route provider and at
 * most the accepted deposit, router calls only paying the recipient, in the
 * accepted token, on Base — or, for bitcoin, only bridging to Bitcoin. Anything
 * else is refused before the wallet prompts.
 *
 * Everything that touches the wallet or the network is injected, so the flow
 * is tested without either.
 */

import {
  assertEvmCallBoundToRoute,
  assertTypedDataBoundToRoute,
  settleBindingForOrder,
} from "../swapkit/SwapKitV2EvmRouteBinding";
import type { SwapKitV2SettleBinding } from "../swapkit/SwapKitV2EvmRouteBinding";
import type { BaseStableAssetId } from "../swapkit/SwapKitStableAssets";
import { isSwapKitV2Terminal } from "../swapkit/SwapKitV2Service";
import type {
  SwapKitV2Action,
  SwapKitV2OrderView,
  SwapKitV2QuoteOption,
  SwapKitV2QuoteResponse,
} from "../swapkit/SwapKitV2Service";
import { encodeFunctionData, parseAbi } from "viem";
import { exactBaseUnits } from "../../lib/pay/payTarget";
import { LOG_EMOJI, errorWithId, logWithId, warnWithId } from "../../lib/OperationLogUtils";

const SOURCE = "services/pay/PayWalletSwapService.ts";
const LOG_ID = `${LOG_EMOJI.wallet} PayWallet`;

/** One diagnostic line per step of a wallet payment. Never a signature or key. */
export function payWalletLog(
  level: "info" | "warn" | "error",
  action: string,
  message: string,
): void {
  const write = level === "error" ? errorWithId : level === "warn" ? warnWithId : logWithId;
  // Only the message reaches the console and the support dump (140 chars), so
  // every line carries its facts there, short.
  write(LOG_ID, `PayWallet ${action} ${message}`, undefined, {
    context: "user",
    event: level === "info" ? "FLOW" : "STATE",
    action,
    source: `${SOURCE}#${action}`,
  });
}

/** Short id for log lines: `ord_31f8…35b3`. */
export const shortId = (value: string | null | undefined): string =>
  !value ? "none" : value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;

/** An error as a log fragment: wallet code, name and message, nothing else. */
export function describeError(error: unknown): string {
  if (!error || typeof error !== "object") return `err=${String(error)}`;
  const { code, name, message } = error as { code?: unknown; name?: unknown; message?: unknown };
  return `code=${String(code ?? "none")} ${String(name ?? "Error")}: ${String(message ?? "")}`;
}

/** Seconds until an action's deadline (negative = passed), or "none". */
function secondsLeft(deadline: string | null | undefined, now: number): string {
  if (deadline == null) return "none";
  const at = Date.parse(deadline);
  return Number.isFinite(at) ? `${Math.round((at - now) / 1000)}s` : "unparsable";
}

/** The order's actions as one log fragment: kind:state:deadline-left each. */
function describeActions(view: SwapKitV2OrderView, now: number): string {
  if (!view.actions?.length) return "actions=[]";
  return `actions=[${view.actions
    .map(
      (a) =>
        `${a.kind}:${a.state}:${secondsLeft(a.deadline, now)}${a.blockedReason ? `:${a.blockedReason}` : ""}`,
    )
    .join(",")}]`;
}

/** EIP-1193, the one interface every browser wallet speaks. */
export type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

/** The payer-side token, as the registry resolved it. */
export type PayWalletToken = {
  chainId: number;
  address: `0x${string}`;
  decimals: number;
  symbol: string;
};

/**
 * SwapKit's `SYMBOL_CHAIN` suffix for each chain a payer can pay from: the
 * chains this app already supports (the ones it has an RPC for), no others.
 */
const CHAIN_SUFFIX: Readonly<Record<number, string>> = {
  1: "ETH",
  8453: "BASE",
  42161: "ARBITRUM",
  10: "OPTIMISM",
  137: "POLYGON",
  100: "GNOSIS",
};

export const PAY_WALLET_CHAIN_IDS = Object.keys(CHAIN_SUFFIX).map(Number);

/** How LI.FI and the wallet name a chain's native coin: no contract. */
export const PAY_WALLET_NATIVE = "0x0000000000000000000000000000000000000000" as const;

/**
 * Each chain's own coin: the symbol LI.FI lists it under and SwapKit's id
 * for it.
 */
export const PAY_WALLET_NATIVE_COIN: Readonly<Record<number, { symbol: string; asset: string }>> = {
  1: { symbol: "ETH", asset: "ETH_ETHEREUM" },
  8453: { symbol: "ETH", asset: "ETH_BASE" },
  42161: { symbol: "ETH", asset: "ETH_ARBITRUM" },
  10: { symbol: "ETH", asset: "ETH_OPTIMISM" },
  137: { symbol: "POL", asset: "POL_POLYGON" },
  100: { symbol: "XDAI", asset: "XDAI_GNOSIS" },
};

/** Whether the token is the chain's native coin. */
export function isPayWalletNative(token: Pick<PayWalletToken, "address">): boolean {
  return String(token.address || "").toLowerCase() === PAY_WALLET_NATIVE;
}

/**
 * The SwapKit asset id for the exact token the wallet holds, or null for an
 * unsupported chain. The contract is part of the id (`USDT0_ARBITRUM@0xfd08…`):
 * SwapKit resolves the token by that address, so a renamed ticker or two tokens
 * sharing a symbol still quote the contract the payer picked.
 */
export function payWalletAssetId(
  token: Pick<PayWalletToken, "symbol" | "chainId" | "address">,
): string | null {
  if (isPayWalletNative(token)) return PAY_WALLET_NATIVE_COIN[token.chainId]?.asset ?? null;
  const suffix = CHAIN_SUFFIX[token.chainId];
  const address = String(token.address || "").toLowerCase();
  if (!suffix || !/^0x[0-9a-f]{40}$/.test(address)) return null;
  // Only a label once the address names the token.
  const label =
    String(token.symbol || "")
      .toUpperCase()
      .replace(/[^A-Z0-9.]/g, "")
      .slice(0, 20) || "TOKEN";
  return `${label}_${suffix}@${address}`;
}

export type PayWalletDeps = {
  quote: (args: Record<string, unknown>) => Promise<SwapKitV2QuoteResponse>;
  commit: (
    args: Record<string, unknown> & {
      optionId: string;
      idempotencyKey: string;
      recoveryKey: string;
      acceptedDepositAmount: string;
      minimumSettleAmount: string;
    },
  ) => Promise<SwapKitV2OrderView>;
  submit: (args: {
    orderId: string;
    actionId: string;
    idempotencyKey: string;
    recoveryKey: string;
    txHash?: string;
    signature?: string;
  }) => Promise<SwapKitV2OrderView>;
  status: (orderId: string, recoveryKey: string) => Promise<SwapKitV2OrderView>;
  /** A transaction's outcome on `chainId`, or null while it is not mined (or unreadable). */
  receipt: (chainId: number, txHash: `0x${string}`) => Promise<"success" | "reverted" | null>;
  /** swap_cancel: gives back an UNFUNDED order; the server refuses a funded one. */
  cancel: (orderId: string, recoveryKey: string) => Promise<SwapKitV2OrderView>;
  randomId: () => string;
  wait: (ms: number) => Promise<void>;
  now: () => number;
  /** Durable per-browser storage for the in-flight payment (PayWalletRecord). */
  store: {
    get: (key: string) => Promise<unknown>;
    set: (key: string, value: unknown) => Promise<void>;
  };
};

/** What the recipient receives: a Base stable, or on-chain bitcoin. */
export type PayWalletSettle = BaseStableAssetId | "BTC";

export type PayWalletQuoteRequest = {
  token: PayWalletToken;
  /**
   * `side: "deposit"` (default): what the payer spends, in the token.
   * `side: "settle"`: what the recipient must receive, in the link's currency
   * (a link with a fixed amount) — the quote then states what the payer spends.
   */
  amount: string;
  side?: "deposit" | "settle";
  payer: `0x${string}`;
  settle: PayWalletSettle;
  /** The recipient's EVM address for a stable, their bitcoin address for BTC. */
  recipient: string;
};

/** Decimal places of what the recipient receives. */
export const PAY_WALLET_SETTLE_DECIMALS: Record<PayWalletSettle, number> = {
  EURC_BASE: 6,
  USDC_BASE: 6,
  BTC: 8,
};

const sideOf = (request: PayWalletQuoteRequest) => request.side ?? "deposit";

export type PayWalletQuote = {
  request: PayWalletQuoteRequest;
  asset: string;
  option: SwapKitV2QuoteOption;
};

const CAPABILITIES = ["execute_evm_call", "sign_typed_data"] as const;

function quoteArgs(request: PayWalletQuoteRequest, asset: string): Record<string, unknown> {
  return {
    from: asset,
    to: request.settle,
    amount: request.amount,
    side: sideOf(request),
    owner: request.payer,
    settleTarget: request.recipient,
    refundAddress: request.payer,
    capabilities: [...CAPABILITIES],
    signerClass: { evm: "eoa" },
  };
}

/**
 * The route to offer, or null when nothing can carry this token. Only options
 * the page can execute are considered (a wallet call or a typed-data order —
 * never a deposit the page would have to send by hand), and the one paying the
 * recipient the most wins: the payer is choosing what arrives, not a provider.
 */
export async function quotePayWalletSwap(
  request: PayWalletQuoteRequest,
  deps: Pick<PayWalletDeps, "quote">,
): Promise<(PayWalletQuote & { options: SwapKitV2QuoteOption[] }) | null> {
  const asset = payWalletAssetId(request.token);
  if (!asset) return null;
  // The chain's own coin is 18 decimals: any other figure would mis-size the
  // spend the wallet is later allowed to send.
  if (isPayWalletNative(request.token) && request.token.decimals !== 18) return null;
  const settleSide = sideOf(request) === "settle";
  const amountDecimals = settleSide
    ? PAY_WALLET_SETTLE_DECIMALS[request.settle]
    : request.token.decimals;
  if (exactBaseUnits(request.amount, amountDecimals) === null) return null;
  // The wallet already holds what the balance holds: a plain transfer, no swap.
  if (directReceiver(request)) {
    const option: SwapKitV2QuoteOption = {
      optionId: DIRECT_OPTION_ID,
      from: asset,
      to: request.settle,
      depositAmount: request.amount,
      settleAmount: request.amount,
      requiredCapabilities: ["execute_evm_call"],
    };
    return { request, asset, option, options: [option] };
  }
  const response = await deps.quote(quoteArgs(request, asset));
  const native = isPayWalletNative(request.token);
  const usable = (response.options ?? []).filter(
    (option) =>
      option.requiredCapabilities.every((cap) =>
        (CAPABILITIES as readonly string[]).includes(cap),
      ) &&
      // A native coin is bound only on a LI.FI call (the coin sent as the
      // call's value). Other native routes (CoW EthFlow) would be refused at
      // signing, so they are never offered.
      (!native || option.optionId.startsWith("lifi:")) &&
      // A malformed or zero payout is never offered: the payer would be asked
      // to spend their token with that figure committed as the minimum.
      isPositiveDecimal(option.settleAmount) &&
      isPositiveDecimal(option.depositAmount) &&
      // A payout the link's currency cannot state exactly is never offered:
      // it would be committed as the minimum the recipient must receive.
      exactBaseUnits(option.settleAmount, PAY_WALLET_SETTLE_DECIMALS[request.settle]) !== null &&
      // A spend the token cannot state exactly is not payable.
      exactBaseUnits(option.depositAmount, request.token.decimals) !== null &&
      // A fixed-amount link: the recipient gets at least what it asks for.
      (!settleSide || compareDecimals(option.settleAmount, request.amount) >= 0),
  );
  if (usable.length === 0) return null;
  // Exact decimal comparison: a float turns a long figure into Infinity.
  // Deposit side: most arriving first. Settle side: least spent first. The
  // first is offered; the rest are the alternatives the payer may pick.
  const options = [...usable].sort((a, b) =>
    settleSide
      ? compareDecimals(a.depositAmount, b.depositAmount)
      : compareDecimals(b.settleAmount, a.settleAmount),
  );
  return { request, asset, option: options[0] as SwapKitV2QuoteOption, options };
}

/** The one "route" for a token that already is the balance's asset. */
const DIRECT_OPTION_ID = "direct:transfer";

/** Whether this route is a plain token transfer, not a swap. */
export function isPayWalletDirect(option: Pick<SwapKitV2QuoteOption, "optionId">): boolean {
  return option.optionId === DIRECT_OPTION_ID;
}

/**
 * The recipient, when the payer's token is exactly the asset the balance
 * holds (same chain, same contract): then it is sent as is. Null otherwise.
 */
function directReceiver(
  request: Pick<PayWalletQuoteRequest, "token" | "settle" | "recipient">,
): `0x${string}` | null {
  const settle = settleBindingForOrder({ to: request.settle, settleTarget: request.recipient });
  return settle?.kind === "evm" &&
    settle.chainId === request.token.chainId &&
    settle.token.toLowerCase() === request.token.address.toLowerCase()
    ? settle.receiver
    : null;
}

const ERC20_TRANSFER = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

/**
 * A same-asset top-up: one ERC-20 transfer from the payer's wallet to the
 * balance's address, then its receipt. No SwapKit order exists, so the record
 * alone carries it across a reload: the hash once the wallet returns it, the
 * started marker before it is asked.
 */
async function driveDirect(
  record: PayWalletRecord,
  key: string,
  provider: Eip1193Provider,
  deps: PayWalletDeps,
  onProgress: (progress: PayWalletProgress) => void,
  receiver: `0x${string}`,
  units: bigint,
): Promise<PayWalletProgress> {
  const { request } = record.accepted;
  const save = () => deps.store.set(key, record);
  const end = async (progress: PayWalletProgress) => {
    await deps.store.set(key, null);
    onProgress(progress);
    return progress;
  };
  let evidence = record.evidence[DIRECT_OPTION_ID];
  if (!evidence || !("txHash" in evidence)) {
    if (record.started.includes(DIRECT_OPTION_ID)) {
      // Asked before and no hash kept: it may be on-chain. Never asked again,
      // and the record stays, so no retry, reset or new quote can pay twice.
      payWalletLog("warn", "direct", "transfer asked before, no hash kept");
      const unresolved: PayWalletProgress = {
        state: "failed",
        orderId: null,
        reason: "needs_reconciliation",
      };
      onProgress(unresolved);
      return unresolved;
    }
    onProgress({ state: "signing", kind: "execute_evm_call" });
    try {
      await ensureChain(provider, request.token.chainId);
    } catch (error) {
      // Nothing was asked to send yet: the payer starts over freely.
      payWalletLog("warn", "direct", `chain switch failed ${describeError(error)}`);
      return end({
        state: "failed",
        orderId: null,
        reason: isWalletRejection(error) ? "rejected" : "error",
      });
    }
    record.started.push(DIRECT_OPTION_ID);
    await save();
    const askedAt = deps.now();
    payWalletLog(
      "info",
      "direct",
      `asking wallet transfer ${request.amount} ${request.token.symbol}`,
    );
    let txHash: unknown;
    try {
      txHash = await provider.request({
        method: "eth_sendTransaction",
        params: [
          {
            from: request.payer,
            to: request.token.address,
            data: encodeFunctionData({ abi: ERC20_TRANSFER, args: [receiver, units] }),
            value: "0x0",
          },
        ],
      });
    } catch (error) {
      payWalletLog(
        "warn",
        "direct",
        `wallet threw ${deps.now() - askedAt}ms ${describeError(error)}`,
      );
      // Refused: nothing was sent. Anything else may have been sent; the
      // record stays so the next visit says so instead of paying twice.
      if (isWalletRejection(error))
        return end({ state: "failed", orderId: null, reason: "rejected" });
      throw error;
    }
    if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      throw new Error("The wallet returned no transaction hash.");
    }
    evidence = { txHash };
    record.evidence[DIRECT_OPTION_ID] = evidence;
    await save();
    onProgress({ state: "paid" });
    payWalletLog("info", "direct", `wallet answered ${deps.now() - askedAt}ms tx=${txHash}`);
  }
  const hash = evidence.txHash as `0x${string}`;
  onProgress({ state: "waiting", orderStatus: "CONFIRMING" });
  // Read until it is mined, however long that (or an RPC outage) takes: the
  // record keeps the hash, and only the receipt ends the wait.
  for (let attempt = 0; ; attempt++) {
    const outcome = await deps.receipt(request.token.chainId, hash);
    if (outcome) {
      payWalletLog(outcome === "success" ? "info" : "warn", "direct", `tx ${outcome}`);
      return end(
        outcome === "success"
          ? { state: "settled", orderId: hash }
          : { state: "failed", orderId: null, reason: "reverted" },
      );
    }
    await deps.wait(attempt < 40 ? 3_000 : 15_000);
  }
}

/** Whether a token holding covers what a route spends, exactly in the token's units. */
export function payWalletRouteFits(
  option: Pick<SwapKitV2QuoteOption, "depositAmount">,
  holding: { decimals: number; units: bigint },
): boolean {
  const spend = exactBaseUnits(option.depositAmount, holding.decimals);
  return spend !== null && spend <= holding.units;
}

/** Compare two plain non-negative decimals exactly, as text (-1, 0, 1). */
export function compareDecimals(a: string, b: string): number {
  const [aw = "", af = ""] = a.split(".");
  const [bw = "", bf = ""] = b.split(".");
  const wa = aw.replace(/^0+(?=\d)/, "");
  const wb = bw.replace(/^0+(?=\d)/, "");
  if (wa.length !== wb.length) return wa.length > wb.length ? 1 : -1;
  if (wa !== wb) return wa > wb ? 1 : -1;
  const width = Math.max(af.length, bf.length);
  const fa = af.padEnd(width, "0");
  const fb = bf.padEnd(width, "0");
  return fa === fb ? 0 : fa > fb ? 1 : -1;
}

/** A plain decimal cut (not rounded) to `places` for display, exactly, as text. */
export function displayDecimal(value: string, places = 2): string {
  const [whole = "0", fraction = ""] = value.split(".");
  const cut = fraction.slice(0, places).padEnd(places, "0");
  const grouped = (whole.replace(/^0+(?=\d)/, "") || "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return places > 0 ? `${grouped}.${cut}` : grouped;
}

/**
 * Whether an unfinished payment is the one THIS link asks for, so it may be
 * resumed without the payer asking. Records are keyed by recipient + currency
 * only: a fixed-amount link must not silently drive an older payment made on
 * the plain link or for another figure (nor the other way round). A mismatch
 * is still shown as pending — it is only never executed on its own.
 */
export function matchesPayLinkIntent(pending: PayWalletQuote, fixedAmount: string | null): boolean {
  const side = pending.request.side ?? "deposit";
  if (!fixedAmount) return side === "deposit";
  return side === "settle" && compareDecimals(pending.request.amount, fixedAmount) === 0;
}

/**
 * An authorized figure written out in full: every significant decimal kept,
 * only trailing zeros dropped, the whole part grouped. Used wherever the payer
 * reads what is spent or received, so what they see is what executes.
 */
export function exactDecimal(value: string): string {
  const [whole = "0", fraction = ""] = String(value).split(".");
  const grouped = (whole.replace(/^0+(?=\d)/, "") || "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const kept = fraction.replace(/0+$/, "");
  return kept ? `${grouped}.${kept}` : grouped;
}

/** A strictly positive plain decimal ("39641.85"), nothing else. */
export function isPositiveDecimal(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value)) return false;
  return /[1-9]/.test(value);
}

export type PayWalletProgress =
  | { state: "signing"; kind: string }
  /** The wallet has paid its part (anything but an approval): the rest runs
   * without it. */
  | { state: "paid" }
  | { state: "waiting"; orderStatus: string }
  | { state: "settled"; orderId: string }
  | { state: "failed"; orderId: string | null; reason: string };

/**
 * Everything needed to finish a wallet payment after the page reloads, written
 * BEFORE the order is committed. The commit reuses the stored idempotency key,
 * so a retry adopts the same order instead of creating a second one; the
 * journal holds each action's evidence the moment the wallet returns it, so a
 * signed-but-unsubmitted step is re-submitted, never signed again.
 */
export type PayWalletRecord = {
  accepted: PayWalletQuote;
  recoveryKey: string;
  idempotencyKey: string;
  orderId: string | null;
  /** actionId -> evidence, written before swap_submit. */
  evidence: Record<string, { txHash: string } | { signature: string }>;
  /** actionIds past their broadcast boundary: the wallet was asked to send
   * or sign AFTER every local check passed, and no evidence came back. */
  started: string[];
  /** actionIds that pay (a call that is not an approval, marked before the
   * wallet may send it; an order signature that is not a permit, marked
   * before it is submitted): once one exists, the payment may run without the
   * app, whatever the wallet or the server answered. */
  funding?: string[];
};

/**
 * One record per pay link — recipient and settlement currency. A pending
 * payment to one recipient is never resumed, shown or signed on another
 * recipient's page.
 */
export function payWalletRecordKey(recipient: string, settle: PayWalletSettle): string {
  return `pay:wallet:v2:${String(recipient).toLowerCase()}:${settle}`;
}

const recordKeyFor = (accepted: PayWalletQuote) =>
  payWalletRecordKey(accepted.request.recipient, accepted.request.settle);

/** The ERC-20 approve selector: re-approving the same exact amount changes nothing. */
const APPROVE_SELECTOR = "0x095ea7b3";

/**
 * Whether a step may be put to the wallet again after an attempt that left no
 * answer. A signature is never broadcast by the wallet (only the server can use
 * it, and the permit nonce or order id lets at most one count), and an approval
 * of the same exact amount changes nothing. Any other call may already be
 * on-chain, so asking again could pay twice.
 */
function safeToAskAgain(action: SwapKitV2Action): boolean {
  return action.kind === "sign_typed_data" || isApproval(action);
}

/** A typed-data approval (EIP-2612 or Permit2): authorises, pays nothing. */
function isPermit(action: SwapKitV2Action): boolean {
  return /^permit/i.test(String(action.request?.primaryType ?? ""));
}

function isApproval(action: SwapKitV2Action): boolean {
  const data = String(action.request?.data || "").toLowerCase();
  return action.kind === "execute_evm_call" && data.startsWith(APPROVE_SELECTOR);
}

/** The engine's definitive pre-order refusal of an accepted quote. */
export function isQuoteExpired(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code === "quote_expired" || /^(error:\s*)?quote expired\b/i.test(String(message ?? ""));
}

/** EIP-1193 user rejection (4001) — the wallet refused, nothing was sent. */
export function isWalletRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code === 4001 || /user (rejected|denied)|rejected by user/i.test(String(message ?? ""));
}

/**
 * Commit the accepted quote and drive the order to terminal from the payer's
 * wallet. Every ready action is bound to the accepted route before the wallet
 * sees it.
 */
export async function payWithWallet(
  accepted: PayWalletQuote,
  provider: Eip1193Provider,
  deps: PayWalletDeps,
  onProgress: (progress: PayWalletProgress) => void = () => {},
): Promise<PayWalletProgress> {
  const { request, option } = accepted;
  const ceiling = exactBaseUnits(option.depositAmount, request.token.decimals);
  // Deposit side: the quote may not spend more than the payer asked to pay.
  // Settle side (fixed-amount link): it must deliver at least the link's
  // amount; what it spends is the quoted deposit, bounded as the ceiling.
  const settleSide = sideOf(request) === "settle";
  const bounded = settleSide
    ? exactBaseUnits(request.amount, PAY_WALLET_SETTLE_DECIMALS[request.settle]) !== null &&
      isPositiveDecimal(option.settleAmount) &&
      compareDecimals(option.settleAmount, request.amount) >= 0
    : (() => {
        const requested = exactBaseUnits(request.amount, request.token.decimals);
        return requested !== null && ceiling !== null && ceiling <= requested;
      })();
  if (
    ceiling === null ||
    !bounded ||
    !isPositiveDecimal(option.settleAmount) ||
    // Committed as the recipient's minimum: it must be exact in their currency.
    exactBaseUnits(option.settleAmount, PAY_WALLET_SETTLE_DECIMALS[request.settle]) === null
  ) {
    const failed: PayWalletProgress = {
      state: "failed",
      orderId: null,
      reason: "quote_deposit_mismatch",
    };
    onProgress(failed);
    return failed;
  }
  const key = recordKeyFor(accepted);
  const pending = (await deps.store.get(key)) as PayWalletRecord | null;
  if (pending?.accepted) {
    // One payment at a time per link. The pending order runs only when the
    // payer accepted exactly that payment; a different token, amount or quote
    // is refused untouched — the pending one is resumed explicitly instead.
    if (isSamePayWallet(pending.accepted, accepted)) {
      payWalletLog("info", "pay", `same pending payment ${shortId(pending.orderId)}`);
      return drive(pending, key, provider, deps, onProgress);
    }
    payWalletLog("warn", "pay", `refused, another payment pending ${shortId(pending.orderId)}`);
    const refused: PayWalletProgress = {
      state: "failed",
      orderId: pending.orderId,
      reason: "pending_payment_differs",
    };
    onProgress(refused);
    return refused;
  }
  const record: PayWalletRecord = {
    accepted,
    recoveryKey: `${deps.randomId()}${deps.randomId()}`.replace(/-/g, ""),
    idempotencyKey: deps.randomId(),
    orderId: null,
    evidence: {},
    started: [],
  };
  await deps.store.set(key, record);
  payWalletLog(
    "info",
    "pay",
    `new ${option.depositAmount} ${request.token.symbol}@${request.token.chainId} -> ${option.settleAmount} ${request.settle} via ${option.optionId.split(":").slice(0, 2).join(":")}`,
  );
  return drive(record, key, provider, deps, onProgress);
}

/**
 * Finish a payment a previous page load started FOR THIS LINK, or null when
 * there is none. The stored record must name the same recipient and currency
 * as the page showing it.
 */
export async function resumePayWithWallet(
  link: { recipient: string; settle: PayWalletSettle },
  connectedAccount: string,
  provider: Eip1193Provider,
  deps: PayWalletDeps,
  onProgress: (progress: PayWalletProgress) => void = () => {},
): Promise<PayWalletProgress | null> {
  const key = payWalletRecordKey(link.recipient, link.settle);
  const record = (await deps.store.get(key)) as PayWalletRecord | null;
  if (!record?.accepted || !record.recoveryKey || !record.idempotencyKey) return null;
  if (
    String(record.accepted.request.recipient).toLowerCase() !== link.recipient.toLowerCase() ||
    record.accepted.request.settle !== link.settle
  ) {
    return null;
  }
  // The order is bound to the account that accepted it. Another connected
  // account never drives it; the record stays for the original payer.
  if (!isPayWalletPayer(record.accepted, connectedAccount)) return null;
  payWalletLog(
    "info",
    "resume",
    `${shortId(record.orderId)} evidence=${Object.keys(record.evidence).length} asked=${record.started.length}`,
  );
  return drive(record, key, provider, deps, onProgress);
}

/** Whether `account` is the payer that accepted this pending payment. */
export function isPayWalletPayer(pending: PayWalletQuote, account: string | null): boolean {
  return !!account && String(pending.request.payer).toLowerCase() === account.toLowerCase();
}

/** The quote of the payment this browser has not finished on this link, or null. */
export async function pendingPayWallet(
  link: { recipient: string; settle: PayWalletSettle },
  deps: Pick<PayWalletDeps, "store">,
): Promise<PayWalletQuote | null> {
  const record = (await deps.store.get(
    payWalletRecordKey(link.recipient, link.settle),
  )) as PayWalletRecord | null;
  return record?.accepted ?? null;
}

/**
 * Whether a newly accepted quote is the SAME payment as the pending one: same
 * payer, token, amount and the exact quote. Anything else is a different
 * payment and must never execute the pending order in its place.
 */
export function isSamePayWallet(a: PayWalletQuote, b: PayWalletQuote): boolean {
  const lower = (value: string) => String(value).toLowerCase();
  return (
    lower(a.request.payer) === lower(b.request.payer) &&
    lower(a.request.recipient) === lower(b.request.recipient) &&
    a.request.settle === b.request.settle &&
    a.request.token.chainId === b.request.token.chainId &&
    lower(a.request.token.address) === lower(b.request.token.address) &&
    a.request.amount === b.request.amount &&
    sideOf(a.request) === sideOf(b.request) &&
    a.option.optionId === b.option.optionId &&
    (a.option.quoteId ?? null) === (b.option.quoteId ?? null) &&
    a.option.depositAmount === b.option.depositAmount &&
    a.option.settleAmount === b.option.settleAmount
  );
}

async function drive(
  record: PayWalletRecord,
  key: string,
  provider: Eip1193Provider,
  deps: PayWalletDeps,
  onProgress: (progress: PayWalletProgress) => void,
): Promise<PayWalletProgress> {
  const { request, option, asset } = record.accepted;
  const ceiling = exactBaseUnits(option.depositAmount, request.token.decimals) as bigint;
  // The same settle binding the signed-in wallet uses: a Base stable binds the
  // token and receiver, bitcoin binds the payout to the Bitcoin chain.
  const settle: SwapKitV2SettleBinding | null = settleBindingForOrder({
    to: request.settle,
    settleTarget: request.recipient,
  });
  if (!settle) {
    await deps.store.set(key, null);
    const refused: PayWalletProgress = { state: "failed", orderId: null, reason: "error" };
    onProgress(refused);
    return refused;
  }
  if (isPayWalletDirect(option)) {
    const receiver = directReceiver(request);
    if (!receiver) {
      await deps.store.set(key, null);
      const refused: PayWalletProgress = { state: "failed", orderId: null, reason: "error" };
      onProgress(refused);
      return refused;
    }
    return driveDirect(record, key, provider, deps, onProgress, receiver, ceiling);
  }
  const binding = { chainId: request.token.chainId, sourceToken: request.token.address, settle };
  const save = () => deps.store.set(key, record);
  const finish = async (progress: PayWalletProgress) => {
    await deps.store.set(key, null);
    onProgress(progress);
    return progress;
  };

  // Same idempotency key on every attempt: a retry adopts the existing order.
  let view: SwapKitV2OrderView;
  const commitStarted = deps.now();
  try {
    view = await deps.commit({
      ...quoteArgs(request, asset),
      optionId: option.optionId,
      ...(option.quoteId ? { quoteId: option.quoteId } : {}),
      idempotencyKey: record.idempotencyKey,
      recoveryKey: record.recoveryKey,
      acceptedDepositAmount: option.depositAmount,
      minimumSettleAmount: option.settleAmount,
    });
  } catch (error) {
    payWalletLog(
      "error",
      "commit",
      `failed ${deps.now() - commitStarted}ms ${describeError(error)}`,
    );
    // The server refused the accepted quote itself (expired / not this
    // request) before creating anything. Only then is the record dropped, so
    // the payer can get a fresh quote; a record that already names an order,
    // or any other failure (transport, 5xx, ambiguous), is kept for resume.
    if (isQuoteExpired(error) && record.orderId === null) {
      await deps.store.set(key, null);
      const expired: PayWalletProgress = {
        state: "failed",
        orderId: null,
        reason: "quote_expired",
      };
      onProgress(expired);
      return expired;
    }
    throw error;
  }
  const orderId = view.orderId;
  payWalletLog(
    "info",
    "commit",
    `${record.orderId === orderId ? "adopted" : "created"} ${shortId(orderId)} ${view.status} ${describeActions(view, deps.now())}`,
  );
  if (record.orderId !== orderId) {
    record.orderId = orderId;
    await save();
  }

  /**
   * Nothing left the wallet for this order: hand the unfunded order back and
   * drop the record, so the next attempt quotes afresh. The server refuses a
   * funded order; then the record stays and a later visit finishes it.
   */
  const giveBack = async (actionId: string, reason: string): Promise<PayWalletProgress> => {
    // This step provably sent nothing: neither of its markers may outlive it.
    // Every other step's markers stay as they are.
    record.started = record.started.filter((id) => id !== actionId);
    if (record.funding) record.funding = record.funding.filter((id) => id !== actionId);
    await save();
    try {
      const cancelled = await deps.cancel(orderId, record.recoveryKey);
      payWalletLog("info", "cancel", `${shortId(orderId)} -> ${cancelled.status}`);
      // The server cancels only an unfunded order: once it is over, nothing
      // is left to resume.
      if (isSwapKitV2Terminal(cancelled)) await deps.store.set(key, null);
    } catch (error) {
      payWalletLog("warn", "cancel", `refused ${shortId(orderId)} ${describeError(error)}`);
    }
    const failed: PayWalletProgress = { state: "failed", orderId, reason };
    onProgress(failed);
    return failed;
  };

  // Every action this drive has seen, by id, for judging what a step was.
  const seen = new Map<string, SwapKitV2Action>();
  let lastWait = "";
  let lapsedCancelTried = false;
  for (;;) {
    for (const action of view.actions ?? []) seen.set(action.actionId, action);
    // Terminal is the v2 client's own definition (COMPLETED, FAILED,
    // REFUNDED, EXPIRED, CANCELLED): every terminal order clears the record.
    if (isSwapKitV2Terminal(view)) {
      const status = String(view.status).toUpperCase();
      payWalletLog(
        status === "COMPLETED" ? "info" : "warn",
        "terminal",
        `${shortId(orderId)} ${status} raw=${view.rawProviderState ?? "none"} failure=${view.failure?.code ?? view.failure?.message ?? "none"}`,
      );
      // Expired or cancelled with nothing ever signed for it: only the
      // price lapsed, the payer gets a new one.
      // A step asked with no answer kept counts as possibly sent unless it is
      // one that sends nothing (a signature, an approval) as last seen.
      const lapsedUnsigned =
        (status === "EXPIRED" || status === "CANCELLED") &&
        Object.keys(record.evidence).length === 0 &&
        record.started.every((id) => {
          const action = seen.get(id);
          return !!action && safeToAskAgain(action);
        });
      return finish(
        status === "COMPLETED"
          ? { state: "settled", orderId }
          : { state: "failed", orderId, reason: lapsedUnsigned ? "quote_expired" : status },
      );
    }
    const ready = view.actions.find(
      (action) =>
        action.state === "ready" &&
        (action.deadline == null || Date.parse(action.deadline) > deps.now()),
    );
    if (!ready) {
      // The step to sign ran past its deadline with nothing sent for it: the
      // order can never finish. Give it back once instead of waiting for the
      // server to expire it, so the payer gets a new price straight away.
      const lapsed = view.actions.find(
        (action) =>
          action.state === "ready" &&
          action.deadline != null &&
          Date.parse(action.deadline) <= deps.now() &&
          !record.evidence[action.actionId] &&
          (safeToAskAgain(action) || !record.started.includes(action.actionId)),
      );
      if (lapsed && !lapsedCancelTried) {
        lapsedCancelTried = true;
        try {
          const cancelled = await deps.cancel(orderId, record.recoveryKey);
          payWalletLog(
            "info",
            "cancel",
            `lapsed ${lapsed.kind} ${shortId(orderId)} -> ${cancelled.status}`,
          );
          if (isSwapKitV2Terminal(cancelled)) {
            return finish({ state: "failed", orderId, reason: "quote_expired" });
          }
        } catch (error) {
          payWalletLog(
            "warn",
            "cancel",
            `lapsed refused ${shortId(orderId)} ${describeError(error)}`,
          );
        }
      }
      // Logged when what the order shows changes, not on every 6 s poll.
      const waitLine = `${view.status} raw=${view.rawProviderState ?? "none"} ${describeActions(view, deps.now())}`;
      const shape = waitLine.replace(/:-?\d+s/g, "");
      if (shape !== lastWait) {
        lastWait = shape;
        const expired = view.actions.some(
          (action) =>
            action.state === "ready" &&
            action.deadline != null &&
            Date.parse(action.deadline) <= deps.now(),
        );
        payWalletLog(
          expired ? "warn" : "info",
          "wait",
          `${expired ? "action past deadline " : ""}${waitLine}`,
        );
      }
      onProgress({ state: "waiting", orderStatus: view.status });
      await deps.wait(6_000);
      view = await deps.status(orderId, record.recoveryKey);
      continue;
    }
    let evidence = record.evidence[ready.actionId];
    if (!evidence) {
      if (record.started.includes(ready.actionId) && !safeToAskAgain(ready)) {
        // The wallet was asked to send this call and gave nothing back — no
        // hash, no rejection (the page died mid-prompt). It may be on-chain.
        // Prompting again could pay twice, so stop and keep the record; the
        // order's own status still settles or refunds it.
        payWalletLog("warn", "reconcile", `${ready.kind} was asked before, no answer kept`);
        onProgress({ state: "failed", orderId, reason: "needs_reconciliation" });
        return { state: "failed", orderId, reason: "needs_reconciliation" };
      }
      onProgress({ state: "signing", kind: ready.kind });
      const askedAt = deps.now();
      payWalletLog(
        "info",
        "sign",
        `asking wallet ${ready.kind} ${shortId(ready.actionId)} deadline=${secondsLeft(ready.deadline, askedAt)} again=${record.started.includes(ready.actionId)}`,
      );
      // Whether the wallet was asked at all: a refusal before that (the route
      // binding, the chain switch) sent nothing, whatever the step.
      let asked = false;
      try {
        evidence = await executePayerAction(ready, provider, request.payer, binding, ceiling, {
          // Marked only here — after the route binding and chain switch passed,
          // immediately before the wallet is asked to send. A refusal earlier
          // leaves no marker.
          onBeforeBroadcast: async () => {
            asked = true;
            if (!record.started.includes(ready.actionId)) {
              record.started.push(ready.actionId);
            }
            // A paying call is marked before the wallet may send it; an
            // approval never is.
            if (
              ready.kind === "execute_evm_call" &&
              !isApproval(ready) &&
              !record.funding?.includes(ready.actionId)
            ) {
              record.funding = [...(record.funding ?? []), ready.actionId];
            }
            await save();
          },
        });
      } catch (error) {
        payWalletLog(
          isWalletRejection(error) ? "warn" : "error",
          "sign",
          `wallet threw ${deps.now() - askedAt}ms deadline=${secondsLeft(ready.deadline, deps.now())} ${describeError(error)}`,
        );
        // Nothing was sent when the payer said no, when the wallet was never
        // asked, or on a signature (the wallet never broadcasts one). Then the
        // unfunded order goes back (an approval is not funding), so the next
        // attempt starts clean. Any other error on a call may have sent it:
        // its markers stay.
        if (isWalletRejection(error)) return giveBack(ready.actionId, "rejected");
        if (!asked || ready.kind === "sign_typed_data") return giveBack(ready.actionId, "error");
        throw error;
      }
      payWalletLog(
        "info",
        "sign",
        `wallet answered ${deps.now() - askedAt}ms ${"txHash" in evidence ? `tx=${evidence.txHash}` : "signature"} deadline=${secondsLeft(ready.deadline, deps.now())}`,
      );
      record.evidence[ready.actionId] = evidence;
      await save();
      // A sent call that is not an approval is the payment itself: it left.
      if ("txHash" in evidence && !isApproval(ready)) onProgress({ state: "paid" });
    } else {
      // A kept answer is submitted again: said so before the reply can be lost.
      onProgress({ state: "waiting", orderStatus: "SUBMITTING" });
    }
    // Whatever pays is marked before the server holds it, kept answer or new:
    // once submitted, the order may run whatever the reply said.
    const funds = "txHash" in evidence ? !isApproval(ready) : !isPermit(ready);
    if (funds && !record.funding?.includes(ready.actionId)) {
      record.funding = [...(record.funding ?? []), ready.actionId];
      await save();
    }
    const submitStarted = deps.now();
    try {
      view = await deps.submit({
        orderId,
        actionId: ready.actionId,
        idempotencyKey: ready.idempotencyKey,
        recoveryKey: record.recoveryKey,
        ...evidence,
      });
    } catch (error) {
      payWalletLog(
        "error",
        "submit",
        `failed ${deps.now() - submitStarted}ms ${describeError(error)}`,
      );
      throw error;
    }
    payWalletLog(
      "info",
      "submit",
      `${shortId(ready.actionId)} -> ${view.status} ${describeActions(view, deps.now())}`,
    );
    // A signed order (CoW) is the payment once the server holds it: the
    // provider fills it alone. A permit only authorises the call still to come.
    if ("signature" in evidence && !isPermit(ready)) onProgress({ state: "paid" });
  }
}

const hex = (value: bigint | number) => `0x${BigInt(value).toString(16)}`;

async function ensureChain(provider: Eip1193Provider, chainId: number): Promise<void> {
  const current = Number(await provider.request({ method: "eth_chainId" }));
  if (current === chainId) return;
  payWalletLog("info", "chain", `switching wallet ${current} -> ${chainId}`);
  await provider.request({
    method: "wallet_switchEthereumChain",
    params: [{ chainId: hex(chainId) }],
  });
}

/** EIP-712 domain fields in their canonical order, with their types. */
const DOMAIN_FIELDS = [
  ["name", "string"],
  ["version", "string"],
  ["chainId", "uint256"],
  ["verifyingContract", "address"],
  ["salt", "bytes32"],
] as const;

/**
 * The typed data's types with the `EIP712Domain` entry the v4 spec asks for.
 * The server leaves it out (local signers derive it from the domain); some
 * wallets, Trust Wallet among them, refuse to sign without it. Derived from
 * the fields the domain carries, so the signed hash is unchanged.
 */
export function withDomainType(
  types: unknown,
  domain: Record<string, unknown>,
): Record<string, unknown> {
  const given = (types ?? {}) as Record<string, unknown>;
  if (given.EIP712Domain) return given;
  return {
    EIP712Domain: DOMAIN_FIELDS.filter(([name]) => domain[name] !== undefined).map(
      ([name, type]) => ({ name, type }),
    ),
    ...given,
  };
}

/**
 * One bound action, through the payer's wallet. Refuses anything this page
 * does not know how to bind — an unsigned send to an address the server named
 * is not something a pay page should ever do on a stranger's behalf.
 */
export async function executePayerAction(
  action: SwapKitV2Action,
  provider: Eip1193Provider,
  payer: `0x${string}`,
  binding: { chainId: number; sourceToken: `0x${string}`; settle: SwapKitV2SettleBinding },
  ceiling: bigint,
  hooks: { onBeforeBroadcast?: () => Promise<void> } = {},
): Promise<{ txHash: string } | { signature: string }> {
  const request = action.request ?? {};
  if (action.kind === "execute_evm_call") {
    const call = {
      chainId: Number(request.chainId),
      to: String(request.to || ""),
      data: String(request.data || ""),
    };
    const value = request.value == null ? "0" : String(request.value);
    if (!/^\d+$/.test(value)) throw new Error("Refusing a call with an unreadable value.");
    // Native value only when the chain's coin is what the payer accepted to
    // spend, and exactly what the decoded call spends of it (itself at most the
    // accepted deposit): any more would be a second payment the route never
    // named.
    const native = isPayWalletNative({ address: binding.sourceToken });
    const refuseValue = () => {
      throw new Error("Refusing a call that sends native value from the payer's wallet.");
    };
    if (BigInt(value) !== 0n && (!native || BigInt(value) > ceiling)) refuseValue();
    const spent = assertEvmCallBoundToRoute(call, binding, ceiling, payer);
    // A native source funds the call by its value alone: zero or missing
    // value on a call that spends the coin is refused like an excess.
    if (native ? BigInt(value) !== spent : BigInt(value) !== 0n) refuseValue();
    await ensureChain(provider, call.chainId);
    await hooks.onBeforeBroadcast?.();
    const txHash = await provider.request({
      method: "eth_sendTransaction",
      params: [
        {
          from: payer,
          to: call.to,
          data: call.data,
          value: hex(BigInt(value)),
          ...(request.gasHint ? { gas: hex(BigInt(String(request.gasHint))) } : {}),
        },
      ],
    });
    if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      throw new Error("The wallet returned no transaction hash.");
    }
    return { txHash };
  }
  if (action.kind === "sign_typed_data") {
    assertTypedDataBoundToRoute(request, {
      chainId: binding.chainId,
      sourceToken: binding.sourceToken,
      ceiling,
      settle: binding.settle,
      wallet: payer,
    });
    const domain = (request.domain ?? {}) as Record<string, unknown>;
    await ensureChain(provider, Number(domain.chainId));
    await hooks.onBeforeBroadcast?.();
    const signature = await provider.request({
      method: "eth_signTypedData_v4",
      params: [
        payer,
        JSON.stringify({
          domain: request.domain,
          types: withDomainType(request.types, domain),
          primaryType: request.primaryType,
          message: request.message,
        }),
      ],
    });
    if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
      throw new Error("The wallet returned no signature.");
    }
    return { signature };
  }
  throw new Error(`This payment needs a step the page cannot sign: ${action.kind}`);
}
