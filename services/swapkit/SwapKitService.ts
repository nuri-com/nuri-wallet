import { SWAPKIT_MCP_URL } from "../../config/endpoints";
import { BASE_EURC, BASE_USDC, SWAPKIT_ENABLED } from "../../config/network";
import { LOG_EMOJI, errorWithId, logWithId } from "../../lib/OperationLogUtils";
import { t } from "../../lib/i18n";
import { isVhtlcNotDueYetError } from "./vhtlcRefundTiming";
import type { SwapKitRecoveryQuote, SwapKitRecoveryAcceptance } from "./SwapKitRecoveryQuote";

type JsonRpcError = {
  code?: number;
  message?: string;
  data?: unknown;
};

type SwapKitContentPart = {
  type?: string;
  text?: string;
};

type SwapKitMcpEnvelope = {
  jsonrpc?: string;
  id?: number | string;
  result?: {
    isError?: boolean;
    content?: SwapKitContentPart[];
  };
  error?: JsonRpcError;
};

export type SwapKitFundInstruction = {
  method?: string;
  payInvoice?: string;
  invoice?: string;
  bolt11?: string;
  paymentRequest?: string;
  sendToAddress?: string;
  address?: string;
  amount?: number | string;
  /** Exact integer sats to fund, where the route states one. `amount` is the
   * same value in the asset's own unit and rounds — never fund that. */
  amountSats?: number | string;
  /** The provider's own deposit transaction, when the rail hands one over instead of a bare address
   * (LI.FI's BTC-source rail). Its outputs ARE the deposit — the solver matches the transaction — so
   * the wallet signs it as given rather than composing a payment to `sendToAddress`. */
  psbt?: string;
  /** What the deposit PSBT costs the wallet that signs it (inputs minus value returned to it). The
   * wallet checks the PSBT's own arithmetic against this, because the co-signer binds only the funding
   * output: an extra output or an inflated fee would otherwise be signed unnoticed. */
  psbtDebitSats?: number;
  asset?: string;
  deadline?: number | string | null;
  qr?: string;
  [key: string]: unknown;
};

export type SwapKitRouteLimit = {
  amountSide?: "deposit" | "settle";
  asset?: string;
  unit?: string;
  min?: number | string;
  max?: number | string;
  source?: string;
  rate?: number | string;
  [key: string]: unknown;
};

export type SwapKitRouteQuote = {
  provider?: string;
  from?: string;
  to?: string;
  depositAmount?: number | string;
  settleAmount?: number | string;
  rate?: number | string;
  execution?: string;
  executable?: boolean;
  limits?: SwapKitRouteLimit;
  [key: string]: unknown;
};

export type SwapKitRouteResponse = {
  best?: SwapKitRouteQuote | null;
  bestExecutable?: SwapKitRouteQuote | null;
  quotes?: SwapKitRouteQuote[];
  unavailable?: Array<{
    provider?: string;
    reason?: string;
    limits?: SwapKitRouteLimit;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

export type SwapKitRouteOption = {
  routeId: string;
  path: string[];
  providers: string[];
  hops: number;
  totalDeposit: number;
  totalSettle: number;
  effectiveRate: number;
  executable: boolean;
  // Only routes with funded Mainnet proof are promoted server-side;
  // `executable:true` alone is NOT a production-safety claim.
  productionReady?: boolean;
  releaseStatus?: string;
  execution?: string;
  requiredCapabilities?: string[];
  requiredGas?: Array<{
    chain?: string;
    chainId?: number;
    asset?: string;
    minWei?: string;
    beforeFunding?: boolean;
  }>;
  quoteDeadline?: string | null;
  unavailableReason?: string;
  recovery?: unknown;
  /** Live pair bounds, sourced from the provider on the same quote call. A
   * fiat-denominated floor moves with the rate, so this is the number to gate
   * on — a constant goes stale in the direction that strands the user. */
  limits?: SwapKitRouteLimit;
  legLimits?: SwapKitRouteLimit[];
  legs?: Array<{
    etaSeconds?: number | string;
    [key: string]: unknown;
  }>;
};

export type SwapKitRequiredGas = NonNullable<SwapKitRouteOption["requiredGas"]>[number];

export type SwapKitOptionsResponse = {
  from: SwapKitBaseAsset;
  to: SwapKitBaseAsset;
  side: "deposit" | "settle";
  amount: number;
  bestProduction: SwapKitRouteOption | null;
  bestRate: SwapKitRouteOption | null;
  bestQuotedRate: SwapKitRouteOption | null;
  shortest: SwapKitRouteOption | null;
  options: SwapKitRouteOption[];
  unavailable: Array<{ routeId?: string; reason?: string }>;
};

export type SwapKitActionApproval = {
  token?: string;
  spender?: string;
  amount?: string;
  [key: string]: unknown;
};

export type SwapKitActionTx = {
  to?: string;
  data?: string;
  value?: string;
  gasLimit?: string;
  gasPrice?: string;
  chainId?: number;
  from?: string;
  [key: string]: unknown;
};

export type SwapKitTypedData = {
  domain?: {
    name?: string;
    version?: string;
    chainId?: number | string;
    verifyingContract?: string;
    [key: string]: unknown;
  };
  types?: Record<string, Array<{ name: string; type: string }>>;
  primaryType?: string;
  message?: Record<string, unknown>;
};

// One typed step of a wallet-assisted route. The server prepares payloads;
// only the wallet's signature or payment moves funds. Create-time actions are
// a PREVIEW — the signable action arrives freshly rebuilt via swap_track.
export type SwapKitAction = {
  type?: string;
  // pay_lightning_invoice
  invoice?: string;
  amountBtc?: number | string;
  deadline?: number | string;
  // sign_and_broadcast_evm_tx
  chainId?: number;
  tx?: SwapKitActionTx;
  approval?: SwapKitActionApproval;
  // sign_typed_data
  actionId?: string;
  typedData?: SwapKitTypedData;
  expiresAt?: string;
  rebuiltAt?: string;
  provider?: string;
  operation?: string;
  externalId?: string;
  request?: Record<string, unknown>;
  note?: string;
  after?: { leg?: number; status?: string; [key: string]: unknown };
  [key: string]: unknown;
};

// Wallet-assisted route metadata; assert signer matches the app's EOA before
// funding, otherwise the final leg can never be signed.
export type SwapKitAssistInfo = {
  mode?: string;
  hub?: string;
  signer?: string;
  to?: string;
  recipient?: string;
  hubAmount?: number | string;
  providerDeposit?: string;
  requiredHubAmount?: number | string;
  [key: string]: unknown;
};

export type SwapKitAlternativeRoute = {
  path?: string[];
  providers?: Array<string | null | undefined>;
  totalDeposit?: number | string;
  totalSettle?: number | string;
  effectiveRate?: number | string;
  execution?: string;
  [key: string]: unknown;
};

export type SwapKitCreateResponse = {
  ok?: boolean;
  provider?: string;
  txId?: string;
  id?: string;
  orderId?: string;
  status?: string;
  createsOrder?: boolean;
  assisted?: boolean;
  mode?: string;
  assist?: SwapKitAssistInfo;
  actions?: SwapKitAction[];
  fund?: SwapKitFundInstruction;
  receive?: {
    asset?: string;
    amount?: number | string;
    to?: string;
    [key: string]: unknown;
  };
  track?: {
    txId?: string;
    url?: string;
    [key: string]: unknown;
  };
  simulated?: boolean;
  quote?: unknown;
  path?: string[];
  route?: {
    path?: string[];
    providers?: Array<string | null | undefined>;
    totalDeposit?: number | string;
    totalSettle?: number | string;
    effectiveRate?: number | string;
    execution?: string;
    requiredCapabilities?: string[];
    requiredGas?: SwapKitRequiredGas[];
    limits?: SwapKitRouteLimit;
    legLimits?: unknown[];
    // Server ≥0.6.1 carries per-leg amounts here instead of top-level
    // legs[].receive.
    legs?: Array<{
      provider?: string;
      from?: string;
      to?: string;
      depositAmount?: number | string;
      settleAmount?: number | string;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  };
  alternatives?: SwapKitAlternativeRoute[];
  legs?: Array<{
    leg?: string;
    via?: string;
    fund?: SwapKitFundInstruction;
    receive?: {
      asset?: string;
      amount?: number | string;
      to?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

export type SwapKitTrackResponse = {
  txId?: string;
  id?: string;
  status?: string;
  provider?: string;
  // Route endpoints (asset ids like "EURC_BASE" / "BTC_ARKADE") — the pending
  // row uses `to` to label Arkade-bound swaps.
  from?: string;
  to?: string;
  // Deferred-funding routes (Satora): the payable instruction appears
  // here once the wallet's derive_material submit created the provider order.
  fund?: SwapKitFundInstruction;
  // stop polling when true; failures then carry a plain-language `explanation`
  terminal?: boolean;
  explanation?: string;
  // v0.6.26: one honest answer to "where is the user's money right now?"
  funds?: { location?: string; userMessage?: string; [key: string]: unknown };
  // v0.6.26: a track refresh failed server-side; status is the last stored one
  trackError?: string;
  // v0.6.24+: a wallet-action rebuild failed server-side, surfaced non-fatally
  walletActionError?: string | null;
  assist?: SwapKitAssistInfo;
  // present ONLY when it is time to sign — freshly rebuilt, correctly sized
  actions?: SwapKitAction[];
  // Quoted receive amount in the to-asset (BTC for Arkade/LN routes) — the
  // activity row renders it as "≈₿ <sats>".
  settleAmount?: number | string;
  legs?: Array<{
    leg?: string;
    provider?: string;
    externalId?: string | null;
    status?: string;
    terminal?: boolean;
    depositAmount?: number | string;
    settleAmount?: number | string;
    txids?: string[];
    settlementConfirmation?: SwapKitBtcPayoutConfirmation;
    error?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

export type SwapKitBtcPayoutConfirmation = {
  txid?: string;
  confirmed?: boolean;
  feerateSatPerVb?: number;
  etaMinutes?: number;
  checkedAt?: string;
  message?: string;
};

export type SwapKitCreateArgs = {
  from: string;
  to: string;
  settleTarget: string;
  sats?: number;
  amount?: number;
  side?: "deposit" | "settle";
  refundAddress?: string;
  // EOA that signs wallet-assisted actions; server infers it from settleTarget
  // when omitted, which breaks when settleTarget is a smart account.
  fromAddress?: string;
  simulate?: boolean;
  includeQr?: boolean;
  walletCapabilities?: string[];
  provider?: string;
  routeId?: string;
  /** Corridor routes only: the trader's own x-only key, bound into the lockup
   * covenant as its `sender`. Cannot be defaulted server-side — the refund
   * leaves are the only thing standing between a dark solver and lost funds,
   * and they are signed by this key. */
  senderPublicKey?: string;
};

export type SwapKitRouteArgs = {
  from: string;
  to: string;
  amount?: number;
  sats?: number;
  side?: "deposit" | "settle";
  only?: string;
  liveOnly?: boolean;
  recipient?: string;
  refundAddress?: string;
};

export type SwapKitTrackArgs = {
  txId: string;
  refresh?: boolean;
  depositTxHash?: string;
  settleTarget?: string;
  actionId?: string;
  signature?: string;
};

export type SwapKitListArgs = {
  fromAddress: string;
  includeTerminal?: boolean;
  since?: number;
  limit?: number;
};

export type SwapKitOrderSummary = {
  txId: string;
  status?: string;
  terminal?: boolean;
  from?: string;
  to?: string;
  depositAmount?: number | string;
  settleAmount?: number | string;
  settleTarget?: string;
  fromAddress?: string;
  path?: string[];
  route?: { routeId?: string; providers?: string[]; [key: string]: unknown };
  assist?: SwapKitAssistInfo;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
};

export type SwapKitListResponse = {
  fromAddress: string;
  includeTerminal: boolean;
  since: number | null;
  limit: number;
  transactions: SwapKitOrderSummary[];
};

export type SwapKitBaseAsset = "BTC_LN" | "BTC_ARKADE" | "EURC_BASE" | "USDC_BASE" | "ETH_BASE";

export type SwapKitOptionsArgs = {
  // Curated ids OR any SYMBOL_CHAIN the server derives on demand (SOL_SOLANA…).
  from: SwapKitBaseAsset | (string & {});
  to: SwapKitBaseAsset | (string & {});
  amount?: number;
  sats?: number;
  side?: "deposit" | "settle";
  fromAddress?: string;
  walletCapabilities?: string[];
};

const SOURCE = "services/swapkit/SwapKitService.ts";
const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED", "REFUNDED", "EXPIRED"]);

function firstTextContent(envelope: SwapKitMcpEnvelope): string {
  const text = envelope.result?.content?.find((part) => typeof part.text === "string")?.text;
  if (!text) throw new Error("SwapKit returned no text result");
  return text;
}

function parseTextPayload<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return { text } as T;
  }
}

function parseMcpEnvelope(rawText: string): SwapKitMcpEnvelope {
  try {
    return JSON.parse(rawText) as SwapKitMcpEnvelope;
  } catch {
    const dataLines = rawText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .filter((line) => line && line !== "[DONE]");
    for (let i = dataLines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(dataLines[i]) as SwapKitMcpEnvelope;
      } catch {}
    }
    throw new Error("SwapKit returned non-JSON response");
  }
}

async function callSwapKitTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
  // SwapKit routes (BTC-Lightning ↔ EURC) only exist on mainnet. Hard-disable
  // every swapkit call on testnet so a testnet build can never open a real
  // mainnet swap. UI entry points are hidden too (SWAPKIT_ENABLED).
  if (!SWAPKIT_ENABLED) {
    throw new Error("swapkit_disabled_on_testnet");
  }
  const started = Date.now();
  const id = Math.floor(Math.random() * 1_000_000_000);
  let status = 0;
  try {
    const response = await fetch(SWAPKIT_MCP_URL, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name,
          arguments: args,
        },
      }),
    });
    status = response.status;
    const rawText = await response.text();
    try {
      const envelope = parseMcpEnvelope(rawText);
      if (!response.ok || envelope.error) {
        throw new Error(envelope.error?.message || `SwapKit ${name} failed (http ${status})`);
      }
      if (envelope.result?.isError) {
        throw new Error(firstTextContent(envelope));
      }
      const payload = parseTextPayload<T>(firstTextContent(envelope));
      if (
        payload &&
        typeof payload === "object" &&
        String((payload as { status?: unknown }).status || "").toUpperCase() ===
          "TEMPORARILY_UNAVAILABLE"
      ) {
        const retryAfterMs = Number((payload as { retryAfterMs?: unknown }).retryAfterMs);
        const error = new Error(
          String(
            (payload as { message?: unknown }).message ||
              "SwapKit is temporarily unavailable. Keep the same transaction and retry.",
          ),
        ) as Error & { retryable?: boolean; retryAfterMs?: number };
        error.retryable = true;
        if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) error.retryAfterMs = retryAfterMs;
        throw error;
      }
      logWithId(
        `${LOG_EMOJI.network} SwapKit.api`,
        `${name} status=${status} dur=${Date.now() - started}ms`,
        { tool: name },
        {
          context: "user",
          event: "API",
          action: name,
          source: `${SOURCE}#callSwapKitTool`,
        },
      );
      return payload;
    } catch (error) {
      if ((error as { retryable?: boolean })?.retryable === true) throw error;
      throw new Error(
        error instanceof Error
          ? `${error.message} (http ${status})`
          : `SwapKit ${name} failed (http ${status})`,
      );
    }
  } catch (error) {
    errorWithId(
      `${LOG_EMOJI.network} SwapKit.api`,
      `${name} failed status=${status || "unknown"} dur=${Date.now() - started}ms`,
      { err: error instanceof Error ? error.message : String(error || "unknown") },
      {
        context: "user",
        event: "API_ERR",
        action: name,
        source: `${SOURCE}#callSwapKitTool`,
      },
    );
    throw error;
  }
}

export async function executeSwapKitSwap(args: SwapKitCreateArgs): Promise<SwapKitCreateResponse> {
  return callSwapKitTool<SwapKitCreateResponse>("swap_execute", args);
}

export function quoteSwapKitRecovery(txId: string) {
  return callSwapKitTool<SwapKitRecoveryQuote>("swap_recovery_quote", { txId });
}

export function acceptSwapKitRecovery(args: { txId: string; quoteId: string; signature: string }) {
  return callSwapKitTool<SwapKitRecoveryAcceptance>("swap_recovery_accept", args);
}

export async function routeSwapKitSwap(args: SwapKitRouteArgs): Promise<SwapKitRouteResponse> {
  return callSwapKitTool<SwapKitRouteResponse>("swap_route", args);
}

export async function getSwapKitOptions(args: SwapKitOptionsArgs): Promise<SwapKitOptionsResponse> {
  return callSwapKitTool<SwapKitOptionsResponse>("swap_options", args);
}

/** A route the app may actually execute: Mainnet-proven AND currently live. */
export function isExecutableRoute(route: SwapKitRouteOption): boolean {
  return route.executable === true && route.productionReady === true;
}

/**
 * ALL curated routes for the pair — including the not yet Mainnet-proven ones,
 * so the UI can show the full picture (greyed out). Executable routes come
 * first, best rate on top; non-executable ones sink to the bottom. The UI
 * renders this order and defaults to the first entry, so first executable =
 * best price. Execution stays gated on isExecutableRoute.
 */
export async function fetchCuratedRoutes(args: SwapKitOptionsArgs): Promise<SwapKitRouteOption[]> {
  const options = await getSwapKitOptions({
    walletCapabilities: SWAPKIT_WALLET_CAPABILITIES,
    ...args,
  });
  // effectiveRate = settle/deposit, so "higher is better" holds in both
  // swap directions.
  return (options.options ?? [])
    .slice()
    .sort(
      (a, b) =>
        Number(isExecutableRoute(b)) - Number(isExecutableRoute(a)) ||
        (b.effectiveRate || 0) - (a.effectiveRate || 0),
    );
}

export function getSwapKitRouteLimits(
  route: SwapKitRouteResponse | null | undefined,
): SwapKitRouteLimit | null {
  return (
    route?.bestExecutable?.limits ??
    route?.best?.limits ??
    route?.quotes?.find((quote) => quote.limits)?.limits ??
    route?.unavailable?.find((item) => item.limits)?.limits ??
    null
  );
}

export function getRequiredGasWei(
  route: { requiredGas?: SwapKitRequiredGas[] } | null | undefined,
  chainId: number,
): bigint | null {
  const item = route?.requiredGas?.find(
    (required) => required.chainId === chainId && required.beforeFunding === true,
  );
  if (!item?.minWei || !/^\d+$/.test(item.minWei)) return null;
  const value = BigInt(item.minWei);
  return value > 0n ? value : null;
}

export async function trackSwapKitSwap(
  txId: string,
  args: Omit<SwapKitTrackArgs, "txId"> = {},
): Promise<SwapKitTrackResponse> {
  return callSwapKitTool<SwapKitTrackResponse>("swap_track", { txId, ...args });
}

/**
 * swap_status — poll ONE order directly by provider + external id.
 *
 * The completion channel of the LI.FI signing rail. The action the server hands
 * back carries `then: { poll: "swap_status", provider, id: "<txHash you
 * broadcast>" }`, so once the wallet broadcasts, the TX HASH is the id.
 * swap_track keys on the MCP's own txId and is never told the broadcast
 * happened on this rail — it reports AWAITING_SIGNATURE indefinitely, which
 * looks exactly like a wallet that advertised the capability and never signed.
 */
export async function getSwapKitStatus(
  provider: string,
  id: string,
): Promise<SwapKitTrackResponse> {
  const res = await callSwapKitTool<SwapKitTrackResponse & { track?: { terminal?: boolean } }>(
    "swap_status",
    { provider, id },
  );
  // The server puts the flag on `track`; lift it so isTerminal() reads it.
  return res.track?.terminal === true ? { ...res, terminal: true } : res;
}

/**
 * Poll swap_status to terminal after the wallet broadcast an EVM action. Same
 * cadence and give-up budget as runSwapKitSwapLoop, but keyed by the broadcast
 * tx hash instead of the order id.
 */
export async function runSwapKitBroadcastStatusLoop(
  provider: string,
  txHash: string,
  options: {
    intervalMs?: number;
    maxPolls?: number;
    onUpdate?: (status: SwapKitTrackResponse) => void;
  } = {},
): Promise<SwapKitTrackResponse> {
  const intervalMs = options.intervalMs ?? 12_000;
  const maxPolls = options.maxPolls ?? 150;
  let latest: SwapKitTrackResponse | null = null;
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 5;
  for (let i = 0; i < maxPolls; i++) {
    try {
      latest = await getSwapKitStatus(provider, txHash);
      consecutiveErrors = 0;
    } catch (e) {
      // The tx is already onchain — a status outage must not abandon it.
      consecutiveErrors += 1;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) throw e;
      await wait(intervalMs);
      continue;
    }
    try {
      options.onUpdate?.(latest);
    } catch {}
    logWithId(
      `${LOG_EMOJI.bitcoin} SwapKit.status`,
      `poll #${i + 1} hash=${txHash} provider=${provider} status=${latest.status || "?"} terminal=${latest.terminal ?? false}`,
      { txId: txHash, status: latest.status, terminal: latest.terminal },
      { source: `${SOURCE}#runSwapKitBroadcastStatusLoop`, event: "FLOW", action: "status" },
    );
    if (isTerminal(latest)) return latest;
    await wait(intervalMs);
  }
  return latest ?? { txId: txHash, status: "UNKNOWN" };
}

export async function listSwapKitSwaps(args: SwapKitListArgs): Promise<SwapKitListResponse> {
  return callSwapKitTool<SwapKitListResponse>("swap_list", args);
}

// swap_sweep (server v0.6.42): scan the SAME EOA across the big EVM chains for
// anything that is not the user's Base currency and convert it back. Payout +
// refund are pinned to the same EOA server-side; gas is sponsored.
export type SwapKitSweepItem = {
  asset?: string;
  chain?: string;
  chainId?: number;
  /** Exact ERC-20 contract returned by the server's read-only balance scan. */
  address?: string;
  amount?: number | string;
  usd?: number | string;
  symbol?: string;
  /** confirm:true only — a normal tracked swap per balance. */
  convert?: { txId?: string; [key: string]: unknown };
  [key: string]: unknown;
};

/** One refundable stuck HTLC lock the server's chain scan found (swap_sweep `refundable[]`). */
export type SwapKitRefundableLock = {
  /** SwapCreated `preimageHash` — the refundTo argument (server >= 0.6.127). */
  preimageHash?: string;
  /** SwapCreated swap key (keccak of all six lock fields) — the deposits/swaps mapping key. */
  key?: string;
  chainId?: number;
  chain?: string;
  coordinatorAddress?: string;
  htlcAddress?: string;
  token?: string;
  tokenSymbol?: string;
  claimAddress?: string;
  amount?: number | string;
  amountRaw?: string;
  timelock?: number;
  refundable?: boolean;
  secondsUntilRefundable?: number;
  [key: string]: unknown;
};

export type SwapKitSweepResponse = {
  found?: number;
  sweepable?: number;
  totalUsd?: number | string;
  items?: SwapKitSweepItem[];
  /** Chain-sourced refundable HTLC locks (may be present even when items is empty). */
  refundable?: SwapKitRefundableLock[];
  refundableReady?: number;
  userMessage?: string;
  [key: string]: unknown;
};

export async function sweepSwapKit(args: {
  wallet: string;
  baseCurrency: "EURC_BASE" | "USDC_BASE";
  confirm: boolean;
  minUsd?: number;
  // Chains this wallet can actually sign on. The server lists balances on other
  // chains but does not arm them, so the app is never handed an action it cannot
  // sign — omitting this is what produces a read-only scan that reports a
  // sweepable balance and then arms nothing on confirm.
  signableChains?: readonly number[];
}): Promise<SwapKitSweepResponse> {
  return callSwapKitTool<SwapKitSweepResponse>("swap_sweep", args);
}

export type SwapKitPlanPath = {
  hops?: number;
  path?: string[];
  legs?: Array<{
    from?: string;
    to?: string;
    provider?: string;
    depositAmount?: number | string;
    settleAmount?: number | string;
    [key: string]: unknown;
  }>;
  executable?: boolean;
  [key: string]: unknown;
};

export type SwapKitPlanResponse = {
  best?: SwapKitPlanPath | null;
  bestExecutable?: SwapKitPlanPath | null;
  options?: SwapKitPlanPath[];
  [key: string]: unknown;
};

export type SwapKitWalletSubmitArgs = {
  txId: string;
  actionId: string;
  provider: string;
  externalId?: string;
  status?: string;
  /** Public broadcast hash, when the action produced one. */
  txHash?: string;
  /** derive_material only: keyIndex/publicKey/userId/preimageHash/evmAddress. */
  material?: Record<string, unknown>;
  /** Later v2 actions: exactly {signature} | {authorization} | {txHash}. */
  result?: Record<string, unknown>;
};

/** Submit one completed htlc_signing_v2 wallet action. Public data only. */
export async function submitSwapKitWalletAction(
  args: SwapKitWalletSubmitArgs,
): Promise<Record<string, unknown>> {
  return callSwapKitTool<Record<string, unknown>>("swap_wallet_submit", args);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export { claimSwapLoop, releaseSwapLoop } from "./SwapKitLoopRegistry";

type PollOptions = {
  intervalMs?: number;
  maxPolls?: number;
  onUpdate?: (status: SwapKitTrackResponse) => void;
  // When set (directions with no signable leg, e.g. EURC→BTC), the deposit hash
  // is re-reported on every poll until terminal, so a transient failure of the
  // initial one-shot report can't leave SwapKit without the deposit hash.
  depositTxHash?: string | null;
  signTypedData?: SwapTypedDataSigner;
  // htlc_signing_v2 (Satora): validates, executes and submits the action
  // itself (idempotent per actionId). Injected by callers to avoid an import
  // cycle with SwapKitHtlcActionService.
  handleHtlcAction?: (action: SwapKitAction, context: { txId: string }) => Promise<void>;
  // arkade_vhtlc_v1: sends/claims/refunds a VHTLC on the Arkade wallet and
  // submits the arkade txid. Injected like handleHtlcAction to avoid an import
  // cycle with SwapKitArkadeActionService.
  handleArkadeAction?: (action: SwapKitAction, context: { txId: string }) => Promise<void>;
  // arkade_intents_v1: pushes the refund of a Lightning-send lockup and submits
  // the arkade txid. Injected like handleArkadeAction, same import-cycle reason.
  handleArkadeIntentsAction?: (action: SwapKitAction, context: { txId: string }) => Promise<void>;
  // Set ONLY by a caller that funds a `send_asset` deposit itself, out of band
  // (swap_sweep's claim → fundSweepConvert). Makes that action non-fatal so the
  // loop keeps polling while the funder works. Every other flow leaves it unset
  // and a send_asset stays a hard failure — the loop must never send funds to a
  // server-named address, and must not spin waiting for a funder that is absent.
  externallyFundedDeposit?: boolean;
  // Chains parseSwapActionTx may accept for this loop. Omitted = Base-only;
  // the sweep/discovered runner widens it to Arbitrum for source-chain converts.
  allowedActionChains?: readonly number[];
  // Exact token contracts an EVM action may approve in this loop. Sweep
  // callers bind this to the detected balance; omitted Base flows fall back
  // to the two canonical wallet stablecoins below.
  allowedApprovalTokens?: readonly string[];
};

/**
 * A revert that means "the precondition is not visible onchain YET", not "this
 * action is broken": the server offers an action before the provider's payout,
 * the lockup confirmation or the CoW settlement has landed, so simulation
 * fails. These self-heal on the next rebuilt action and must NOT consume the
 * sign-failure budget — otherwise a paid swap gets abandoned for being early.
 * Anything else (a genuinely unexecutable leg) still counts.
 */
// 0x28c6a0cc is Satora's `SwapNotActive(bytes32,uint8)`: the Arbitrum HTLC
// exists but is not in a claimable state yet, which is what an `authorize_claim`
// offered before the provider's lock has settled simulates as. Live on
// sk_4cb679be… — the claim reverted with it, the budget ran out after three
// tries and the loop abandoned a swap whose sats were already locked.
const NOT_READY_REVERTS =
  /TRANSFER_FROM_FAILED|ExpiredTransaction|SwapNotFound|0x5ec69df0|0x931997cf|0x28c6a0cc|insufficient balance|exceeds the balance|FORFEIT_CLOSURE_LOCKED|refund locktime not reached/i;

export function isNotReadyRevert(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return NOT_READY_REVERTS.test(message);
}

/**
 * The id an order is polled by. `swap_execute` states it top-level on some
 * rails and only under `track` on others, so every caller that intends to
 * follow an order has to read all four — a missed nested id looks exactly like
 * an order that cannot be tracked at all.
 */
export function extractSwapKitOrderId(swap: SwapKitCreateResponse): string | null {
  const txId = swap.txId || swap.track?.txId || swap.id || swap.orderId;
  return typeof txId === "string" && txId.trim() ? txId.trim() : null;
}

export function getPendingBtcPayoutConfirmation(
  tx: SwapKitTrackResponse | null | undefined,
): SwapKitBtcPayoutConfirmation | null {
  for (const leg of tx?.legs ?? []) {
    const confirmation = leg.settlementConfirmation;
    if (confirmation?.confirmed === false) return confirmation;
  }
  return null;
}

export function isTerminal(tx: SwapKitTrackResponse): boolean {
  // Provider SUCCESS means it broadcast the BTC payout, not that the wallet can
  // spend it. Keep polling and keep the pending row visible until SwapKit sees
  // the first L1 confirmation (#247).
  if (getPendingBtcPayoutConfirmation(tx)) return false;
  return tx.terminal === true || TERMINAL_STATUSES.has(String(tx.status || "").toUpperCase());
}

// Providers whose leg runs on the Bitcoin side (VHTLC/Lightning) — the slow,
// "swapping through the Bitcoin network" part of a route.
const BTC_LEG_PROVIDERS = new Set(["satora", "arkade", "fixedfloat", "bitcoinvn"]);

/**
 * T5/T6 (swapkit#88): one honest, human sentence for "what is my swap doing
 * RIGHT NOW", derived from the live track response — active leg + provider
 * kind, with a "Step n of m" prefix on multi-leg routes. Falls back to the
 * server's funds.userMessage, then to the generic exchanging line. Returns
 * null for terminal states (the caller shows success/failure instead).
 */
export function describeSwapKitPhase(status: SwapKitTrackResponse): string | null {
  if (isTerminal(status)) return null;
  const state = String(status.status || "").toUpperCase();
  if (state === "AWAITING_FUNDING") return t("swap.phase.funding");
  const legs = status.legs ?? [];
  const activeIndex = legs.findIndex((leg) => leg.terminal !== true);
  const active = activeIndex >= 0 ? legs[activeIndex] : undefined;
  const prefix =
    legs.length > 1 && activeIndex >= 0
      ? `${t("swap.phase.step", { n: activeIndex + 1, m: legs.length })} · `
      : "";
  if (active) {
    const provider = String(active.provider || "").toLowerCase();
    const phase = BTC_LEG_PROVIDERS.has(provider)
      ? activeIndex === legs.length - 1
        ? t("swap.phase.delivering")
        : t("swap.phase.bridging")
      : t("swap.phase.trading");
    return `${prefix}${phase}`;
  }
  const fallback = status.funds?.userMessage;
  return fallback ? String(fallback) : t("swap.status.exchanging");
}

export type SwapActionSigner = (parsed: ParsedSwapActionTx) => Promise<{ hash: string }>;
export type SwapTypedDataSigner = (
  parsed: ParsedSwapTypedDataAction,
  status: SwapKitTrackResponse,
) => Promise<{ signature: `0x${string}` }>;
// A reverting signable leg is retried against a rebuilt action, not abandoned.
// Lower than the track-error budget: a stale quote clears within a poll or two,
// whereas a leg that reverts three times running is not going to start working.
const MAX_CONSECUTIVE_SIGN_FAILURES = 3;
// ~25 waits with exponential backoff (12s -> 90s cap) ≈ 25+ minutes of
// patience before a stuck precondition is treated as a dead route.
const MAX_NOT_READY_WAITS = 25;
// A CLTV that block time has not reached yet is a different animal: it is not
// a stuck precondition but a clock we are waiting on, and it ends by itself at
// a known height. Block time trails the wall clock by an hour or two, so the
// 25-wait budget abandoned refunds that were merely early (62k sats stranded,
// 19.07.2026). ~200 waits at the 90s cap ≈ 5 hours — generous, still bounded.
const MAX_CLOCK_WAITS = 200;

// How much patience this particular "not ready" deserves.
export const notReadyBudget = (error: unknown): number =>
  isVhtlcNotDueYetError(error) ? MAX_CLOCK_WAITS : MAX_NOT_READY_WAITS;

const notReadyBackoffMs = (intervalMs: number, notReadyWaits: number) =>
  Math.min(intervalMs * 2 ** Math.min(notReadyWaits, 3), 90_000);

// Mutable per-run state shared between the poll loop and its action path.
type SwapLoopState = {
  // the one broadcast this run is allowed (see runSwapKitSwapLoop's contract)
  broadcastHash: string | null;
  // a signed CoW order rides along on the next swap_track poll
  typedSubmission: { actionId: string; signature: `0x${string}` } | null;
  signFailures: number;
  // "Not ready yet" waits are tracked separately from real signing failures:
  // a swap may legitimately wait many minutes for a provider payout or a CoW
  // settlement, but must not wait forever.
  notReadyWaits: number;
};

// What the action path decided the loop should do next.
type SwapActionOutcome =
  | { kind: "none"; latest?: SwapKitTrackResponse } // nothing signed — regular interval wait
  | { kind: "repoll" } // action handled (or backed off in here) — poll again now
  | { kind: "terminal"; result: SwapKitTrackResponse };

/**
 * The optional per-poll action path of runSwapKitSwapLoop: dispatches the
 * server's freshly rebuilt actions[0] (htlc/arkade handlers, CoW typed data,
 * EVM sign-and-broadcast) and re-reports the deposit hash after a broadcast.
 * Mutates `state`; backoff waits happen in here so the loop itself stays pure
 * track/backoff/terminal logic.
 */
async function runSwapActionPath(
  latest: SwapKitTrackResponse,
  txId: string,
  intervalMs: number,
  options: PollOptions & { signAction?: SwapActionSigner },
  state: SwapLoopState,
): Promise<SwapActionOutcome> {
  const action = latest.actions?.[0];
  if (action && String(action.type) === "htlc_signing_v2" && options.handleHtlcAction) {
    // Validation, execution, journaling and swap_wallet_submit all live in
    // the handler; a repeated actionId replays its journaled public result,
    // so retrying here can never sign or broadcast twice.
    try {
      await options.handleHtlcAction(action, { txId });
      state.signFailures = 0;
      state.notReadyWaits = 0;
      return { kind: "repoll" }; // re-poll immediately for the next pending action
    } catch (e) {
      if (isNotReadyRevert(e)) {
        // Not a failure: the action's precondition is not onchain yet. Back
        // off (capped) and keep waiting instead of abandoning a live swap.
        state.notReadyWaits += 1;
        if (state.notReadyWaits >= notReadyBudget(e)) throw e;
        logWithId(
          `${LOG_EMOJI.bitcoin} SwapKit.track`,
          `action not ready yet (${state.notReadyWaits}/${notReadyBudget(e)}) — waiting`,
          { txId: txId },
          { source: `${SOURCE}#runSwapKitSwapLoop`, event: "FLOW", action: "wait" },
        );
        await wait(notReadyBackoffMs(intervalMs, state.notReadyWaits));
        return { kind: "repoll" };
      }
      state.signFailures += 1;
      if (state.signFailures >= MAX_CONSECUTIVE_SIGN_FAILURES) throw e;
      await wait(intervalMs);
      return { kind: "repoll" };
    }
  }
  if (action && String(action.type) === "arkade_intents_v1" && options.handleArkadeIntentsAction) {
    // The corridor's only wallet action: return a funded lockup whose solver
    // went dark. Same idempotent-per-actionId contract as the handlers above.
    try {
      await options.handleArkadeIntentsAction(action, { txId });
      state.signFailures = 0;
      state.notReadyWaits = 0;
      return { kind: "repoll" };
    } catch (e) {
      if (isNotReadyRevert(e)) {
        state.notReadyWaits += 1;
        if (state.notReadyWaits >= notReadyBudget(e)) throw e;
        await wait(notReadyBackoffMs(intervalMs, state.notReadyWaits));
        return { kind: "repoll" };
      }
      state.signFailures += 1;
      if (state.signFailures >= MAX_CONSECUTIVE_SIGN_FAILURES) throw e;
      await wait(intervalMs);
      return { kind: "repoll" };
    }
  }
  if (action && String(action.type) === "arkade_vhtlc_v1" && options.handleArkadeAction) {
    // Send/claim/refund a VHTLC on the Arkade wallet, then submit the arkade
    // txid. Same idempotent-per-actionId contract as the htlc handler, so a
    // reappearing action replays its journaled result instead of double-sending.
    try {
      await options.handleArkadeAction(action, { txId });
      state.signFailures = 0;
      state.notReadyWaits = 0;
      return { kind: "repoll" };
    } catch (e) {
      if (isNotReadyRevert(e)) {
        state.notReadyWaits += 1;
        if (state.notReadyWaits >= notReadyBudget(e)) throw e;
        await wait(notReadyBackoffMs(intervalMs, state.notReadyWaits));
        return { kind: "repoll" };
      }
      state.signFailures += 1;
      if (state.signFailures >= MAX_CONSECUTIVE_SIGN_FAILURES) throw e;
      await wait(intervalMs);
      return { kind: "repoll" };
    }
  }
  if (action && (options.signAction || options.signTypedData)) {
    if (String(action.type) === "sign_typed_data") {
      if (!options.signTypedData) {
        throw new Error("SwapKit returned a typed-data action this wallet cannot sign.");
      }
      const parsed = parseSwapTypedDataAction(action);
      try {
        state.typedSubmission = {
          actionId: parsed.actionId,
          ...(await options.signTypedData(parsed, latest)),
        };
        state.signFailures = 0;
        return { kind: "repoll" };
      } catch (e) {
        if (isNotReadyRevert(e)) {
          state.notReadyWaits += 1;
          if (state.notReadyWaits >= notReadyBudget(e)) throw e;
          await wait(notReadyBackoffMs(intervalMs, state.notReadyWaits));
          return { kind: "repoll" };
        }
        state.signFailures += 1;
        if (state.signFailures >= MAX_CONSECUTIVE_SIGN_FAILURES) throw e;
        await wait(intervalMs);
        return { kind: "repoll" };
      }
    }
    if (state.broadcastHash) {
      try {
        const reported = await trackSwapKitSwap(txId, { depositTxHash: state.broadcastHash });
        try {
          options.onUpdate?.(reported);
        } catch {}
        if (isTerminal(reported)) return { kind: "terminal", result: reported };
        return { kind: "none", latest: reported };
      } catch {}
      return { kind: "none" };
    }
    // Deposit-style convert (swap_sweep ONLY): the deposit is funded OUT OF BAND
    // by SwapKitSweepService.fundSweepConvert, under that function's own
    // fail-closed checks — allow-listed token, amount capped at the detected
    // balance, EVM-validated address. `send_asset` deliberately stays out of
    // SWAPKIT_WALLET_CAPABILITIES so this loop can never send to a server-named
    // address itself; it must simply not kill an order another path is funding.
    //
    // Gated on the caller opting in: this function is shared with the normal
    // persisted-order and pending-tracker flows, which have no out-of-band
    // funder. There, a send_asset must still fail closed rather than poll to
    // exhaustion while nothing funds it.
    if (String(action.type) === "send_asset") {
      if (!options.externallyFundedDeposit) {
        throw new Error(`SwapKit returned an unsupported live action: ${action.type}`);
      }
      return { kind: "none", latest };
    }
    try {
      if (String(action.type) !== "sign_and_broadcast_evm_tx") {
        throw new Error(`SwapKit returned an unsupported live action: ${action.type}`);
      }
      // This guardian pins the tx to the allowed chains and validates its calldata.
      // A rejection here means the offered action is stale or unsafe for the local
      // sweep binding. Nothing has been broadcast, so keep the visible loop alive
      // and let the next poll fetch a rebuilt action instead of closing the sheet.
      const parsed = parseSwapActionTx(
        action,
        options.allowedActionChains,
        options.allowedApprovalTokens,
      );
      if (!options.signAction) {
        throw new Error("SwapKit returned an EVM action this wallet cannot sign.");
      }
      const { hash } = await options.signAction(parsed);
      state.broadcastHash = hash;
      state.signFailures = 0;
      try {
        await trackSwapKitSwap(txId, { depositTxHash: hash });
      } catch {}
      return { kind: "repoll" }; // re-poll immediately after reporting
    } catch (e) {
      // A signing failure is usually a STALE QUOTE, not a broken route: the
      // server builds these legs with an effectively zero slippage tolerance,
      // so a pool tick between rebuild and estimateGas reverts the tx in
      // simulation. estimateGas fails closed, so nothing was broadcast and
      // nothing moved — the next poll gets a freshly rebuilt action that can
      // succeed. Aborting here would strand a swap whose deposit (a paid
      // Lightning invoice, say) has already left the user's wallet. Give up
      // only after several CONSECUTIVE failures, which means the leg is
      // genuinely unexecutable rather than merely stale.
      const msg = e instanceof Error ? e.message : String(e);
      if (isNotReadyRevert(e)) {
        state.notReadyWaits += 1;
        if (state.notReadyWaits >= notReadyBudget(e)) throw e;
        logWithId(
          `${LOG_EMOJI.bitcoin} SwapKit.track`,
          `tx not ready yet (${state.notReadyWaits}/${notReadyBudget(e)}) — waiting`,
          { txId: txId, err: msg.slice(0, 200) },
          { source: `${SOURCE}#runSwapKitSwapLoop`, event: "FLOW", action: "wait" },
        );
        await wait(notReadyBackoffMs(intervalMs, state.notReadyWaits));
        return { kind: "repoll" };
      }
      state.signFailures += 1;
      // Full cause in the log (never shown to the user). A failing attempt
      // is usually a stale zero-slippage quote that self-heals on the
      // rebuilt action — so it logs as a plain line; only the FINAL
      // failure is a real error.
      const logFn = state.signFailures >= MAX_CONSECUTIVE_SIGN_FAILURES ? errorWithId : logWithId;
      logFn(
        `${LOG_EMOJI.bitcoin} SwapKit.track`,
        `sign attempt ${state.signFailures}/${MAX_CONSECUTIVE_SIGN_FAILURES} failed (retrying with rebuilt action)`,
        { txId: txId, err: msg.slice(0, 500) },
        { source: `${SOURCE}#runSwapKitSwapLoop`, event: "API_ERR", action: "sign" },
      );
      if (state.signFailures >= MAX_CONSECUTIVE_SIGN_FAILURES) throw e;
      return { kind: "none" };
    }
  }
  return { kind: "none" };
}

/**
 * The one loop for all swaps (server briefing 2026-07-04): poll swap_track
 * every ~12s until `terminal`. When the server returns `actions[]` — freshly
 * rebuilt and correctly sized, NEVER the create-time preview — execute it via
 * `signAction` and report the broadcast hash back with `depositTxHash`.
 *
 * Broadcasts at most once per run: if the action reappears after a successful
 * broadcast, only the depositTxHash report is retried — a lost report is the
 * sole reason the server would still show the action. A signing attempt that
 * FAILS broadcasts nothing, so it does not count as that one broadcast; the loop
 * keeps polling for a rebuilt action until MAX_CONSECUTIVE_SIGN_FAILURES.
 */
export async function runSwapKitSwapLoop(
  txId: string,
  options: PollOptions & { signAction?: SwapActionSigner } = {},
): Promise<SwapKitTrackResponse> {
  const intervalMs = options.intervalMs ?? 12_000;
  const maxPolls = options.maxPolls ?? 150;
  const state: SwapLoopState = {
    broadcastHash: null,
    typedSubmission: null,
    signFailures: 0,
    notReadyWaits: 0,
  };
  let latest: SwapKitTrackResponse | null = null;
  // Once funds have moved this loop is the only path that reports the deposit
  // hash, signs the next leg, and detects terminal. A single transient
  // swap_track error must NOT abandon a paid/broadcast swap — back off and keep
  // polling, giving up only after several CONSECUTIVE failures (a real outage).
  let consecutiveTrackErrors = 0;
  const MAX_CONSECUTIVE_TRACK_ERRORS = 5;
  for (let i = 0; i < maxPolls; i++) {
    try {
      latest = await trackSwapKitSwap(
        txId,
        state.typedSubmission ??
          (options.depositTxHash ? { depositTxHash: options.depositTxHash } : {}),
      );
      if (state.typedSubmission) state.typedSubmission = null;
      consecutiveTrackErrors = 0;
    } catch (e) {
      // KV can lag a few seconds right after create — retry, don't fail the UI.
      const msg = e instanceof Error ? e.message : String(e);
      if (/unknown transaction/i.test(msg)) {
        if (i < 5) {
          await wait(3_000);
          continue;
        }
        // Past the KV grace window the server has genuinely never heard of
        // this txId — terminal, not an outage, so callers stop resurrecting
        // a row that can never progress.
        return { txId, status: "UNKNOWN", terminal: true, explanation: msg };
      }
      // Transient network/API blip mid-swap: keep the poller alive rather than
      // throwing out and stranding the pending row until an app restart.
      consecutiveTrackErrors += 1;
      if (consecutiveTrackErrors >= MAX_CONSECUTIVE_TRACK_ERRORS) throw e;
      await wait(intervalMs);
      continue;
    }
    try {
      options.onUpdate?.(latest);
    } catch {}
    logWithId(
      `${LOG_EMOJI.bitcoin} SwapKit.track`,
      // id= first: several orders poll concurrently (three at once is normal),
      // and without it two of them at the same poll number are indistinguishable
      // in the log. That cost a wrong P0 in #894 — a "double broadcast" that was
      // really two different orders. Full txId, never shortened.
      `poll #${i + 1} id=${txId} status=${latest.status || "?"} terminal=${latest.terminal ?? false} actions=${latest.actions?.length ?? 0}${latest.explanation ? ` explanation=${latest.explanation}` : ""}`,
      {
        txId: txId,
        status: latest.status,
        terminal: latest.terminal,
        actionCount: latest.actions?.length ?? 0,
      },
      { source: `${SOURCE}#runSwapKitSwapLoop`, event: "FLOW", action: "track" },
    );
    if (isTerminal(latest)) return latest;
    const outcome = await runSwapActionPath(latest, txId, intervalMs, options, state);
    if (outcome.kind === "terminal") return outcome.result;
    if (outcome.kind === "repoll") continue;
    if (outcome.latest) latest = outcome.latest;
    await wait(intervalMs);
  }
  return latest ?? { txId, status: "UNKNOWN" };
}

/**
 * Status-only loop for post-lockup / server-executed (v2) routes: polls
 * swap_track to terminal and nothing else. Reuses runSwapKitSwapLoop, which
 * without signers or action handlers ignores actions[] entirely — this entry
 * point just guarantees none can be passed, so it can never sign or submit.
 */
export function runSwapKitStatusLoop(
  txId: string,
  opts: {
    intervalMs?: number;
    maxPolls?: number;
    onUpdate?: (status: SwapKitTrackResponse) => void;
  } = {},
): Promise<SwapKitTrackResponse> {
  return runSwapKitSwapLoop(txId, {
    intervalMs: opts.intervalMs,
    maxPolls: opts.maxPolls,
    onUpdate: opts.onUpdate,
  });
}

/**
 * v2 marker (swapkit#88 contract): a route/create/track object is
 * server-executed ONLY when it carries `executionMode: "server"` — absent or
 * unknown values mean today's wallet-driven behavior.
 */
export function isServerExecutedRoute(source: unknown): boolean {
  if (!source || typeof source !== "object") return false;
  const obj = source as { executionMode?: unknown; route?: { executionMode?: unknown } | null };
  return obj.executionMode === "server" || obj.route?.executionMode === "server";
}

// Match SwapKit's bounded input tolerance. The exact wallet action remains the
// final amount authorization; anything above 5% is still rejected before funds move.
export const SWAPKIT_INPUT_DRIFT_MULTIPLIER = 1.05;

// Every action type this wallet can actually EXECUTE. The pre-funding guardian
// below answers "can we finish this route?" out of exactly this set, so an
// entry here is a promise that a handler exists and runs.
// htlc_signing_v2 (Satora): the full adapter is wired — key derivation,
// the four generic actions, idempotent journal and swap_wallet_submit. Live
// server 0.6.3+ accepts and gates on it.
const EXECUTABLE_ACTION_TYPES = [
  "pay_lightning_invoice",
  "sign_and_broadcast_evm_tx",
  "sign_typed_data",
  "htlc_signing_v2",
  // arkade_vhtlc_v1 (server 0.6.17+, hashLock160 shipped 2026-07-15): the BTC
  // leg is a VHTLC on the Arkade wallet — send/claim/refund in
  // SwapKitArkadeActionService. Lightning stays advertised as the fallback rail.
  "arkade_vhtlc_v1",
  // arkade_intents_v1: the Arkade Intents Lightning send corridor. The wallet
  // funds the lockup the route quotes, and signs exactly one thing — the
  // refund of a lockup the solver went dark on, once its timelock matured
  // (SwapKitArkadeIntentsActionService). Distinct from arkade_vhtlc_v1: this
  // corridor never asks for a claim.
  "arkade_intents_v1",
];

// Things this wallet can DO that no action type names. They are advertised so
// the server can withhold routes we could not finish, and they must stay out
// of the executable set: an action carrying one of these as its `type` names
// no handler, and letting it past the guardian turns a fail-closed refusal
// into a route that strands funds when it dies mid-way.
const CAPABILITY_ONLY_FLAGS = [
  // arkade_vhtlc_v2: this wallet can rebuild the STRICT vHTLC script
  // (VHTLC.ScriptV2), which Satora's Arkade corridor locks to since
  // 2026-08-21. The action stays arkade_vhtlc_v1; only the script inside its
  // descriptor differs, and SwapKitArkadeVhtlcService picks it by
  // `vhtlc.scriptVersion`. Declaring it is what makes those routes executable
  // for this app: a build that cannot build the strict script must never be
  // offered a lockup it could fund but not refund.
  "arkade_vhtlc_v2",
];

/** Declared to the server as walletCapabilities: what we execute, plus what we can do. */
export const SWAPKIT_WALLET_CAPABILITIES = [...EXECUTABLE_ACTION_TYPES, ...CAPABILITY_ONLY_FLAGS];

const SUPPORTED_ACTION_TYPES = new Set(EXECUTABLE_ACTION_TYPES);

/**
 * Guardian check: verify every action of a wallet-assisted route is a type
 * this wallet can execute BEFORE running the first one. Executing a partial
 * sequence strands funds mid-route.
 */
export function assertSupportedSwapActions(actions: SwapKitAction[]): void {
  for (const action of actions) {
    const type = String(action?.type || "");
    if (!SUPPORTED_ACTION_TYPES.has(type)) {
      throw new Error(`SwapKit route needs an unsupported wallet action: ${type || "unknown"}`);
    }
  }
}

function hexOrDecToBigInt(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  const str = String(value ?? "").trim();
  if (!str) throw new Error(`SwapKit action tx is missing ${field}`);
  try {
    return BigInt(str);
  } catch {
    throw new Error(`SwapKit action tx has an invalid ${field}: ${str}`);
  }
}

export type ParsedSwapActionTx = {
  // Chain the guard validated the action against — the signer dispatch keys
  // off this, never off the raw action.
  chainId: number;
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  gasLimit?: bigint;
  approval?: { token: `0x${string}`; spender: `0x${string}`; amount: bigint };
  // Signer the server bound the action to; the broadcaster must refuse to
  // sign it from any other account.
  from?: `0x${string}`;
};

export const BASE_MAINNET_CHAIN_ID = 8453;
const DEFAULT_APPROVAL_TOKENS: Record<number, readonly string[]> = {
  [BASE_MAINNET_CHAIN_ID]: [BASE_USDC.address.toLowerCase(), BASE_EURC.address.toLowerCase()],
};
const COW_SETTLEMENT = "0x9008d19f58aabd9ed0d60971565aa8510560ab41";

export type ParsedSwapTypedDataAction = {
  actionId: string;
  chainId: 8453;
  typedData: Required<Pick<SwapKitTypedData, "domain" | "types" | "primaryType" | "message">>;
  approval?: { token: `0x${string}`; spender: `0x${string}`; amount: bigint };
  expiresAt?: string;
};

function parseActionApproval(
  raw: SwapKitActionApproval | undefined,
): ParsedSwapActionTx["approval"] {
  if (!raw) return undefined;
  const token = String(raw.token || "");
  const spender = String(raw.spender || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(token) || !/^0x[0-9a-fA-F]{40}$/.test(spender)) {
    throw new Error("SwapKit action approval has an invalid token or spender.");
  }
  return {
    token: token as `0x${string}`,
    spender: spender as `0x${string}`,
    amount: hexOrDecToBigInt(raw.amount, "approval amount"),
  };
}

/** Fail-closed guardian for CoW's Base-mainnet EIP-712 order. */
export function parseSwapTypedDataAction(action: SwapKitAction): ParsedSwapTypedDataAction {
  const actionId = String(action.actionId || "").trim();
  if (!actionId) throw new Error("SwapKit typed-data action is missing actionId.");
  const typedData = action.typedData;
  const domain = typedData?.domain;
  const chainId = Number(action.chainId ?? domain?.chainId);
  if (
    chainId !== BASE_MAINNET_CHAIN_ID ||
    Number(domain?.chainId) !== BASE_MAINNET_CHAIN_ID ||
    String(domain?.name) !== "Gnosis Protocol" ||
    String(domain?.version) !== "v2" ||
    String(domain?.verifyingContract || "").toLowerCase() !== COW_SETTLEMENT
  ) {
    throw new Error("SwapKit typed-data action is not a CoW order on Base mainnet.");
  }
  if (typedData?.primaryType !== "Order" || !typedData.types?.Order || !typedData.message) {
    throw new Error("SwapKit typed-data action has an invalid CoW Order payload.");
  }
  for (const field of ["sellToken", "buyToken", "receiver"] as const) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(typedData.message[field] || ""))) {
      throw new Error(`SwapKit CoW order has an invalid ${field}.`);
    }
  }
  for (const field of ["sellAmount", "buyAmount"] as const) {
    if (hexOrDecToBigInt(typedData.message[field], field) <= 0n) {
      throw new Error(`SwapKit CoW order has a non-positive ${field}.`);
    }
  }
  const expiresAt = action.expiresAt;
  if (expiresAt && Date.now() >= new Date(expiresAt).getTime()) {
    throw new Error("SwapKit typed-data action expired before signing.");
  }
  return {
    actionId,
    chainId: BASE_MAINNET_CHAIN_ID,
    typedData: {
      domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
    },
    approval: parseActionApproval(action.approval),
    expiresAt,
  };
}

/** Validate + convert a sign_and_broadcast_evm_tx action into broadcastable fields. */
export function parseSwapActionTx(
  action: SwapKitAction,
  // Guardian default stays Base-only — a missing or foreign chainId must
  // never reach the wallet key. Only the sweep/discovered runner widens this
  // to Arbitrum (its converts execute on the source chain).
  allowedChains: readonly number[] = [BASE_MAINNET_CHAIN_ID],
  allowedApprovalTokens?: readonly string[],
): ParsedSwapActionTx {
  const tx = action.tx;
  const chainId = Number(action.chainId ?? tx?.chainId);
  if (!allowedChains.includes(chainId)) {
    throw new Error(
      `SwapKit action targets chain ${action.chainId ?? tx?.chainId ?? "unknown"}; allowed here: ${allowedChains.join(", ")}.`,
    );
  }
  const to = String(tx?.to || "");
  const data = String(tx?.data || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error("SwapKit action tx has an invalid `to`.");
  if (!/^0x[0-9a-fA-F]*$/.test(data) || data.length < 4) {
    throw new Error("SwapKit action tx has invalid calldata.");
  }
  const value = tx?.value == null ? 0n : hexOrDecToBigInt(tx.value, "value");
  // Stablecoin legs never send ETH; a non-zero value can only drain gas funds.
  if (value !== 0n) throw new Error("SwapKit action tx carries a non-zero value.");
  const from = tx?.from == null ? undefined : String(tx.from);
  if (from != null && !/^0x[0-9a-fA-F]{40}$/.test(from)) {
    throw new Error("SwapKit action tx has an invalid `from`.");
  }
  const gasLimit = tx?.gasLimit == null ? undefined : hexOrDecToBigInt(tx.gasLimit, "gasLimit");
  const approval = parseActionApproval(action.approval);
  if (approval) {
    // The spender must be the called contract, and the token must be bound by
    // the local flow: canonical wallet assets for normal Base actions, or the
    // exact contract persisted from the read-only sweep balance scan.
    if (approval.spender.toLowerCase() !== to.toLowerCase()) {
      throw new Error("SwapKit approval spender is not the transaction target.");
    }
    const allowedTokens = (allowedApprovalTokens ?? DEFAULT_APPROVAL_TOKENS[chainId] ?? []).map(
      (token) => token.toLowerCase(),
    );
    if (!allowedTokens.includes(approval.token.toLowerCase())) {
      throw new Error("SwapKit approval token is not bound to the swept asset.");
    }
  }
  return {
    chainId,
    to: to as `0x${string}`,
    data: data as `0x${string}`,
    value,
    gasLimit,
    approval,
    from: from as `0x${string}` | undefined,
  };
}

/**
 * Post-mining integrity check used by the Base signer: the transaction the
 * chain reports for our hash must equal what the wallet signed.
 */
export function assertMinedTxMatchesSigned(
  signed: { to: `0x${string}`; data: `0x${string}`; value: bigint; from: `0x${string}` },
  mined: {
    to?: string | null;
    input?: string;
    value?: bigint;
    from?: string;
    chainId?: number;
  },
): void {
  const mismatch =
    String(mined.to || "").toLowerCase() !== signed.to.toLowerCase() ||
    String(mined.from || "").toLowerCase() !== signed.from.toLowerCase() ||
    String(mined.input || "").toLowerCase() !== signed.data.toLowerCase() ||
    (mined.value ?? -1n) !== signed.value ||
    (mined.chainId != null && Number(mined.chainId) !== BASE_MAINNET_CHAIN_ID);
  if (mismatch) {
    throw new Error("Mined transaction does not match the signed payload.");
  }
}
