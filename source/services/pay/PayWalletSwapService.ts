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
import { exactBaseUnits } from "../../lib/pay/payTarget";

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

/**
 * The SwapKit asset id for the exact token the wallet holds, or null for an
 * unsupported chain. The contract is part of the id (`USDT0_ARBITRUM@0xfd08…`):
 * SwapKit resolves the token by that address, so a renamed ticker or two tokens
 * sharing a symbol still quote the contract the payer picked.
 */
export function payWalletAssetId(
  token: Pick<PayWalletToken, "symbol" | "chainId" | "address">,
): string | null {
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
): Promise<PayWalletQuote | null> {
  const asset = payWalletAssetId(request.token);
  if (!asset) return null;
  const settleSide = sideOf(request) === "settle";
  const amountDecimals = settleSide
    ? PAY_WALLET_SETTLE_DECIMALS[request.settle]
    : request.token.decimals;
  if (exactBaseUnits(request.amount, amountDecimals) === null) return null;
  const response = await deps.quote(quoteArgs(request, asset));
  const usable = (response.options ?? []).filter(
    (option) =>
      option.requiredCapabilities.every((cap) =>
        (CAPABILITIES as readonly string[]).includes(cap),
      ) &&
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
  // Deposit side: most arriving wins. Settle side: least spent wins.
  const best = usable.reduce((a, b) =>
    settleSide
      ? compareDecimals(b.depositAmount, a.depositAmount) < 0
        ? b
        : a
      : compareDecimals(b.settleAmount, a.settleAmount) > 0
        ? b
        : a,
  );
  return { request, asset, option: best };
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

/** The ERC-20 approve selector: the one step safe to prompt again after an
 * interrupted attempt (re-approving the same exact amount changes nothing). */
const APPROVE_SELECTOR = "0x095ea7b3";

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
      return drive(pending, key, provider, deps, onProgress);
    }
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
  const binding = { chainId: request.token.chainId, sourceToken: request.token.address, settle };
  const save = () => deps.store.set(key, record);
  const finish = async (progress: PayWalletProgress) => {
    await deps.store.set(key, null);
    onProgress(progress);
    return progress;
  };

  // Same idempotency key on every attempt: a retry adopts the existing order.
  let view: SwapKitV2OrderView;
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
  if (record.orderId !== orderId) {
    record.orderId = orderId;
    await save();
  }

  for (;;) {
    // Terminal is the v2 client's own definition (COMPLETED, FAILED,
    // REFUNDED, EXPIRED, CANCELLED): every terminal order clears the record.
    if (isSwapKitV2Terminal(view)) {
      const status = String(view.status).toUpperCase();
      return finish(
        status === "COMPLETED"
          ? { state: "settled", orderId }
          : { state: "failed", orderId, reason: status },
      );
    }
    const ready = view.actions.find(
      (action) =>
        action.state === "ready" &&
        (action.deadline == null || Date.parse(action.deadline) > deps.now()),
    );
    if (!ready) {
      onProgress({ state: "waiting", orderStatus: view.status });
      await deps.wait(6_000);
      view = await deps.status(orderId, record.recoveryKey);
      continue;
    }
    let evidence = record.evidence[ready.actionId];
    if (!evidence) {
      const data = String(ready.request?.data || "").toLowerCase();
      const isApprove = ready.kind === "execute_evm_call" && data.startsWith(APPROVE_SELECTOR);
      if (record.started.includes(ready.actionId) && !isApprove) {
        // The wallet was asked to send this step and gave nothing back — no
        // hash, no rejection (the page died mid-prompt). It may be on-chain.
        // Prompting again could pay twice, so stop and keep the record; the
        // order's own status still settles or refunds it.
        onProgress({ state: "failed", orderId, reason: "needs_reconciliation" });
        return { state: "failed", orderId, reason: "needs_reconciliation" };
      }
      onProgress({ state: "signing", kind: ready.kind });
      try {
        evidence = await executePayerAction(ready, provider, request.payer, binding, ceiling, {
          // Marked only here — after the route binding and chain switch passed,
          // immediately before the wallet is asked to send. A refusal earlier
          // leaves no marker.
          onBeforeBroadcast: async () => {
            if (!record.started.includes(ready.actionId)) {
              record.started.push(ready.actionId);
              await save();
            }
          },
        });
      } catch (error) {
        if (isWalletRejection(error)) {
          // The payer said no: nothing was sent. Clear the marker, and give
          // the unfunded order back (an approval is not funding), so the next
          // attempt starts clean instead of reading as "may have been sent".
          record.started = record.started.filter((id) => id !== ready.actionId);
          await save();
          try {
            const cancelled = await deps.cancel(orderId, record.recoveryKey);
            if (cancelled.status === "EXPIRED") await deps.store.set(key, null);
          } catch {
            // Refused (funded) or unreachable: the record stays so a reload
            // finishes this order rather than opening a second one.
          }
          const rejected: PayWalletProgress = { state: "failed", orderId, reason: "rejected" };
          onProgress(rejected);
          return rejected;
        }
        throw error;
      }
      record.evidence[ready.actionId] = evidence;
      await save();
    }
    view = await deps.submit({
      orderId,
      actionId: ready.actionId,
      idempotencyKey: ready.idempotencyKey,
      recoveryKey: record.recoveryKey,
      ...evidence,
    });
  }
}

const hex = (value: bigint | number) => `0x${BigInt(value).toString(16)}`;

async function ensureChain(provider: Eip1193Provider, chainId: number): Promise<void> {
  const current = Number(await provider.request({ method: "eth_chainId" }));
  if (current === chainId) return;
  await provider.request({
    method: "wallet_switchEthereumChain",
    params: [{ chainId: hex(chainId) }],
  });
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
    if (!/^\d+$/.test(value) || BigInt(value) !== 0n) {
      throw new Error("Refusing a call that sends native value from the payer's wallet.");
    }
    assertEvmCallBoundToRoute(call, binding, ceiling, payer);
    await ensureChain(provider, call.chainId);
    await hooks.onBeforeBroadcast?.();
    const txHash = await provider.request({
      method: "eth_sendTransaction",
      params: [
        {
          from: payer,
          to: call.to,
          data: call.data,
          value: "0x0",
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
          types: request.types,
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
