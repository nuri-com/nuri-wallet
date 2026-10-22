// SwapKit v2 client transport (#268 contract, contractVersion 2.0.0).
//
// v2 replaces the v1 route/create/execute/track split with:
//   swap(mode:"quote")   -> priced options[] + structured unavailable[]
//   swap(mode:"commit")  -> orderId + first bound action(s)
//   swap_submit          -> evidence for one action; returns refreshed order view
//   swap_status          -> reconcile one order by orderId
//   swap_list            -> restore orders by owner
//   swap_cancel          -> cancel an UNFUNDED order
//   swap_sweep           -> read-only scan / confirm:true creates ordinary orders
//
// Rules this module enforces (migration plan docs/swapkit-v2-migration-plan.md):
// - The server owns routing, ordering and amounts. The client signs exactly the
//   bound request of each action and submits evidence — nothing is reconstructed
//   client-side.
// - v2 order ids (ord_…) and v1 tx ids are distinct nominal types; neither may
//   cross to the other transport.
// - Unknown action kinds fail closed before anything is signed.
import { SWAPKIT_V2_MCP_URL } from "../../config/endpoints";
import { SWAPKIT_ENABLED } from "../../config/network";
import { LOG_EMOJI, errorWithId, logWithId } from "../../lib/OperationLogUtils";
import { paymentTimed } from "../../lib/paymentTiming";
import {
  type V2RefundMaterial,
  v2AcceptsCommitRefundMaterial,
  v2CommitRefundMaterial,
  warmV2CommitRefundMaterial,
} from "./SwapKitV2CommitRefundMaterial";
import { rememberV2QuoteCommitKey, v2QuoteCommitHint } from "./SwapKitV2QuoteCommitKey";

const SOURCE = "services/swapkit/SwapKitV2Service.ts";

// ── Contract constants ──────────────────────────────────────────────

/** The action-contract version this client was built against. A different
 * major from `swap_capabilities` means the bound requests may not be what this
 * dispatcher validates — fail closed rather than sign an unknown shape. */
export const SWAPKIT_V2_CONTRACT_MAJOR = 2;

/** Minimum contract MINOR within the supported major. 2.2 introduced the
 * wallet-generated `recoveryKey`, the immutable commit bounds
 * (`acceptedDepositAmount`/`minimumSettleAmount`), the Arkade Intents refund
 * kinds and `arkade_intents_fund`'s bound outpoint. A 2.0/2.1 server accepts a
 * commit but then cannot honour those shapes, so a material route would fund
 * and then strand — require ≥2.2 before quoting/committing at all. */
export const SWAPKIT_V2_CONTRACT_MIN_MINOR = 2;

/** Closed set of v2 action kinds this wallet can fulfil. Every entry is a
 * promise that a handler exists in the v2 action dispatcher. */
export const SWAPKIT_V2_ACTION_KINDS = [
  "send_asset",
  "execute_evm_call",
  "sign_typed_data",
  "pay_lightning_invoice",
  "htlc_material",
  "arkade_send",
  "arkade_claim",
  "arkade_intents_fund",
  "arkade_refund_material",
  "arkade_intents_refund",
] as const;

export type SwapKitV2ActionKind = (typeof SWAPKIT_V2_ACTION_KINDS)[number];

const SUPPORTED_KINDS: ReadonlySet<string> = new Set(SWAPKIT_V2_ACTION_KINDS);

/** v2 signer classes. The Expo wallet's EVM signer is a plain EOA. */
export type SwapKitV2SignerClass = Record<
  string,
  "eoa" | "erc4337" | "safe-multisig" | "arkade-vhtlc"
>;

// ── Nominal id types (never interchangeable with v1 txIds) ─────────

/** A v2 engine order id (`ord_…`). Branded so a v1 txId cannot be passed. */
export type SwapKitV2OrderId = string & { readonly __swapKitV2OrderId: unique symbol };

export function asSwapKitV2OrderId(raw: string): SwapKitV2OrderId {
  const value = String(raw || "").trim();
  if (!value.startsWith("ord_")) {
    throw new Error(`Not a SwapKit v2 order id: ${value || "(empty)"}`);
  }
  return value as SwapKitV2OrderId;
}

export function isSwapKitV2OrderId(raw: unknown): raw is SwapKitV2OrderId {
  return typeof raw === "string" && raw.startsWith("ord_");
}

// ── Response types (deployed engine shapes, probed 2026-09-15) ─────

export type SwapKitV2Capabilities = {
  contractVersion: string;
  kinds: string[];
  signerClasses: string[];
  signerClassMinDeadlineSeconds?: Record<string, number>;
  registry?: unknown;
};

export type SwapKitV2QuoteOption = {
  optionId: string;
  from: string;
  to: string;
  depositAmount: string;
  settleAmount: string;
  requiredCapabilities: string[];
  expectedSettlement?: { p50Seconds?: number; p95Seconds?: number };
  limits?: { min?: number | string; max?: number | string } | null;
  /** Immutable id of the stored quote this option belongs to; sent back on
   * commit so the server commits exactly that quote (contract, additive). */
  quoteId?: string;
  [key: string]: unknown;
};

export type SwapKitV2Unavailable = {
  provider?: string;
  route?: string;
  reason?: string;
  [key: string]: unknown;
};

export type SwapKitV2ResolvedRecipients = Record<string, unknown>;

export type SwapKitV2QuoteResponse = {
  mode: "quote";
  options: SwapKitV2QuoteOption[];
  unavailable: SwapKitV2Unavailable[];
  resolvedRecipients?: SwapKitV2ResolvedRecipients;
};

/** One bound action envelope from the server's live action stream. `request`
 * is the exact bound payload for this kind — the wallet signs it verbatim. */
export type SwapKitV2Action = {
  actionId: string;
  kind: string;
  request: Record<string, unknown>;
  state: "ready" | "blocked";
  blockedReason?: string | null;
  retryAfter?: string | number | null;
  deadline?: string;
  supersedes?: string | null;
  idempotencyKey: string;
};

/** The refreshed order view returned by commit, submit and status. */
export type SwapKitV2OrderView = {
  mode: "commit";
  orderId: string;
  status: string;
  rawProviderState?: string | null;
  actions: SwapKitV2Action[];
  failure?: { code?: string; message?: string; [key: string]: unknown } | null;
  resolvedRecipients?: SwapKitV2ResolvedRecipients;
  [key: string]: unknown;
};

export type SwapKitV2ListResponse = {
  owner: string;
  count: number;
  orders: SwapKitV2OrderView[];
};

export type SwapKitV2SweepResponse = {
  found?: number;
  sweepable?: number;
  totalUsd?: number | string;
  items?: Array<Record<string, unknown>>;
  refundable?: Array<Record<string, unknown>>;
  refundableReady?: number;
  /** confirm:true — ordinary v2 orders created for each sweepable balance. */
  orders?: SwapKitV2OrderView[];
  userMessage?: string;
  [key: string]: unknown;
};

// ── Request types ───────────────────────────────────────────────────

export type SwapKitV2SwapArgs = {
  from: string;
  to: string;
  /** Canonical decimal unit of the sided asset (decimal BTC, never sats). */
  amount: string | number;
  side: "deposit" | "settle";
  mode: "quote" | "commit";
  owner: string;
  settleTarget?: string | null;
  refundAddress?: string | null;
  capabilities: readonly string[];
  signerClass?: SwapKitV2SignerClass;
  /** commit only: the exact option chosen from the quote. */
  optionId?: string;
  /** commit only: stable key persisted BEFORE the request goes out, so a crash
   * between request and response retries into the same order (engine
   * v2.commitIdem + deterministic providerCreateKey). */
  idempotencyKey?: string;
  /** commit only: wallet-generated high-entropy recovery capability, stable and
   * re-derivable after a full wipe. The server persists only its SHA-256 hash
   * and indexes orders by that hash so a restored wallet can adopt them.
   * Required on commit; quotes omit it. */
  recoveryKey?: string;
  /** commit only: immutable maximum deposit the user consented to, as an
   * exact-decimal string. The server binds this and never overwrites it with a
   * later execution value. */
  acceptedDepositAmount?: string;
  /** commit only: immutable minimum settlement the user will accept, as an
   * exact-decimal string. */
  minimumSettleAmount?: string;
  [key: string]: unknown;
};

export type SwapKitV2SubmitArgs = {
  orderId: SwapKitV2OrderId;
  actionId: string;
  /** MUST be the action's own idempotencyKey (server rejects a mismatch). */
  idempotencyKey: string;
  /** Same wallet-generated recovery capability sent at commit. Required on
   * every authed call (submit/status/list/cancel) so the server can bind the
   * mutation to the recovery-hash-indexed order. */
  recoveryKey: string;
  txHash?: string;
  preimage?: string;
  signature?: string;
  /** Kind-shaped evidence per the capability registry response schema. */
  result?: Record<string, unknown>;
};

// ── Errors ──────────────────────────────────────────────────────────

/** Typed v2 error: keeps the server's reason machine-readable so callers can
 * distinguish `order_in_flight`, capability, recipient and funding errors
 * without string-matching translated UI text. */
export class SwapKitV2Error extends Error {
  readonly code: string | null;
  readonly httpStatus: number;
  readonly retryable: boolean;
  constructor(
    message: string,
    opts: { code?: string | null; httpStatus?: number; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "SwapKitV2Error";
    this.code = opts.code ?? null;
    this.httpStatus = opts.httpStatus ?? 0;
    this.retryable = opts.retryable === true;
  }
}

const ERROR_CODE_PATTERNS: Array<[RegExp, string]> = [
  // Raised by the engine before any order exists (the accepted quote is gone
  // or was for another request): definitive, nothing was created.
  [/^quote expired\b/i, "quote_expired"],
  [/order_in_flight|already in flight/i, "order_in_flight"],
  [/solver refused|exposure_cap|provider_at_capacity|insufficient_float/i, "provider_refused"],
  [/unmapped_provider_state/i, "unmapped_provider_state"],
  [/missing_capability/i, "missing_capability"],
  [/signer_incompatible/i, "signer_incompatible"],
  [/unknown order/i, "unknown_order"],
  [/invoice|bolt11|lightning address/i, "recipient_invalid"],
  [/settleTarget|refundAddress|recipient/i, "recipient_invalid"],
  [/no executable option|no_route/i, "no_route"],
];

export function classifyErrorCode(message: string): string | null {
  for (const [pattern, code] of ERROR_CODE_PATTERNS) {
    if (pattern.test(message)) return code;
  }
  return null;
}

// ── Transport ───────────────────────────────────────────────────────

type JsonRpcEnvelope = {
  jsonrpc?: string;
  id?: number | string;
  result?: { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
  error?: { code?: number; message?: string; data?: unknown };
};

function parseEnvelope(rawText: string): JsonRpcEnvelope {
  try {
    return JSON.parse(rawText) as JsonRpcEnvelope;
  } catch {
    // SSE framing fallback, same as the v1 transport.
    const dataLines = rawText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .filter((line) => line && line !== "[DONE]");
    for (let i = dataLines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(dataLines[i]) as JsonRpcEnvelope;
      } catch {}
    }
    throw new SwapKitV2Error("SwapKit v2 returned a non-JSON response");
  }
}

async function callSwapKitV2Tool<T>(name: string, args: Record<string, unknown>): Promise<T> {
  // Status polls are left out: they run on their own and would only add noise.
  if (name === "swap_status" || name === "swap_list") return callSwapKitV2ToolOnce<T>(name, args);
  const mode = typeof args.mode === "string" ? `.${args.mode}` : "";
  return paymentTimed(`server ${name}${mode}`, () => callSwapKitV2ToolOnce<T>(name, args), {
    from: typeof args.from === "string" ? args.from : undefined,
    to: typeof args.to === "string" ? args.to : undefined,
    withRefundMaterial: args.refundMaterial ? true : undefined,
  });
}

async function callSwapKitV2ToolOnce<T>(name: string, args: Record<string, unknown>): Promise<T> {
  // Mainnet-only, same hard gate as v1: a testnet build must never open a real
  // mainnet swap.
  if (!SWAPKIT_ENABLED) {
    throw new SwapKitV2Error("swapkit_disabled_on_testnet");
  }
  const started = Date.now();
  const id = Math.floor(Math.random() * 1_000_000_000);
  let status = 0;
  try {
    const response = await fetch(SWAPKIT_V2_MCP_URL, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    status = response.status;
    const rawText = await response.text();
    const envelope = parseEnvelope(rawText);
    if (!response.ok || envelope.error) {
      const message = envelope.error?.message || `SwapKit v2 ${name} failed (http ${status})`;
      throw new SwapKitV2Error(message, {
        code: classifyErrorCode(message),
        httpStatus: status,
        retryable: status >= 500 || status === 429,
      });
    }
    const text = envelope.result?.content?.find((part) => typeof part.text === "string")?.text;
    if (!text) throw new SwapKitV2Error(`SwapKit v2 ${name} returned no text result`);
    if (envelope.result?.isError) {
      const message = text.replace(/^Error:\s*/i, "");
      throw new SwapKitV2Error(message, { code: classifyErrorCode(message), httpStatus: status });
    }
    let payload: T;
    try {
      payload = JSON.parse(text) as T;
    } catch {
      throw new SwapKitV2Error(`SwapKit v2 ${name} returned non-JSON payload`);
    }
    logWithId(
      `${LOG_EMOJI.network} SwapKitV2.api`,
      `${name} status=${status} dur=${Date.now() - started}ms`,
      { tool: name },
      { context: "user", event: "API", action: name, source: `${SOURCE}#callSwapKitV2Tool` },
    );
    return payload;
  } catch (error) {
    errorWithId(
      `${LOG_EMOJI.network} SwapKitV2.api`,
      `${name} failed status=${status || "unknown"} dur=${Date.now() - started}ms`,
      { err: error instanceof Error ? error.message : String(error || "unknown") },
      { context: "user", event: "API_ERR", action: name, source: `${SOURCE}#callSwapKitV2Tool` },
    );
    throw error;
  }
}

// ── Capabilities handshake ──────────────────────────────────────────

let cachedCapabilities: SwapKitV2Capabilities | null = null;

/** Fetch + validate the v2 capability contract, cached per app session.
 * Fails closed when the contract major differs or a kind this wallet relies on
 * is no longer advertised — signing against an unknown contract is how funds
 * strand. */
export async function getSwapKitV2Capabilities(): Promise<SwapKitV2Capabilities> {
  if (cachedCapabilities) return cachedCapabilities;
  const caps = await callSwapKitV2Tool<SwapKitV2Capabilities>("swap_capabilities", {});
  const [major, minor] = String(caps.contractVersion || "")
    .split(".")
    .map((part) => Number(part));
  if (major !== SWAPKIT_V2_CONTRACT_MAJOR) {
    throw new SwapKitV2Error(
      `SwapKit v2 contract version ${caps.contractVersion} does not match client major ${SWAPKIT_V2_CONTRACT_MAJOR}`,
      { code: "contract_mismatch" },
    );
  }
  // A same-major but older-minor server (2.0/2.1) accepts a commit yet cannot
  // honour recoveryKey, the immutable commit bounds, or the Arkade Intents
  // refund kinds — a material route would fund and then strand. Fail closed.
  if (!Number.isFinite(minor) || minor < SWAPKIT_V2_CONTRACT_MIN_MINOR) {
    throw new SwapKitV2Error(
      `SwapKit v2 contract version ${caps.contractVersion} is below the required ${SWAPKIT_V2_CONTRACT_MAJOR}.${SWAPKIT_V2_CONTRACT_MIN_MINOR}`,
      { code: "contract_mismatch" },
    );
  }
  const advertised = new Set(caps.kinds ?? []);
  for (const kind of SWAPKIT_V2_ACTION_KINDS) {
    if (!advertised.has(kind)) {
      throw new SwapKitV2Error(`SwapKit v2 no longer advertises action kind ${kind}`, {
        code: "contract_mismatch",
      });
    }
  }
  cachedCapabilities = caps;
  return caps;
}

/** Test seam: reset the session capability cache. */
export function resetSwapKitV2CapabilitiesCache(): void {
  cachedCapabilities = null;
}

// ── Public operations ───────────────────────────────────────────────

export async function quoteSwapKitV2(
  args: Omit<SwapKitV2SwapArgs, "mode">,
): Promise<SwapKitV2QuoteResponse> {
  // A committable quote (it names a destination) also names the commit to come,
  // so the server prepares that commit's storage while the providers quote
  // (SwapKitV2QuoteCommitKey). A caller that already knows its commit key passes
  // it; otherwise a new one is remembered for the commit of this quote. Only a
  // hint: without the wallet's recovery key it is left out.
  const commitHint = args.settleTarget
    ? await v2QuoteCommitHint(String(args.owner), {
        idempotencyKey: typeof args.idempotencyKey === "string" ? args.idempotencyKey : undefined,
        recoveryKey: typeof args.recoveryKey === "string" ? args.recoveryKey : undefined,
      })
    : null;
  // An Arkade payment's commit carries the wallet's refund key; it is derived
  // while this quote runs and the user reviews it, not after the tap.
  const quoteCapabilities: readonly string[] = Array.isArray(args.capabilities)
    ? args.capabilities
    : [];
  if (
    args.settleTarget &&
    args.from === "BTC_ARKADE" &&
    quoteCapabilities.includes("arkade_refund_material")
  ) {
    warmV2CommitRefundMaterial(String(args.owner));
  }
  await getSwapKitV2Capabilities();
  const response = await callSwapKitV2Tool<SwapKitV2QuoteResponse>("swap", {
    ...args,
    ...(commitHint ?? {}),
    mode: "quote",
  });
  if (commitHint && !args.idempotencyKey) {
    rememberV2QuoteCommitKey(
      (response.options ?? []).map((option) => String(option.quoteId ?? "")),
      commitHint.idempotencyKey,
    );
  }
  return { ...response, options: preferPermitOptions(response.options ?? []) };
}

/**
 * A provider's permit option (`<provider>:permit:<from>-><to>`) runs the same
 * provider quote with an EIP-2612 signature instead of a separate approve()
 * transaction: one on-chain transaction instead of two (LI.FI), or none at all
 * (CoW). When the server offers it, the approve option of the SAME provider and
 * pair (`<provider>:<provider>:<from>-><to>`) is never offered: it is the same
 * swap, slower and paying more gas. Every other option is left untouched, and
 * the approve option stays wherever no permit option exists for it.
 */
export function preferPermitOptions<T extends { optionId: string }>(options: T[]): T[] {
  const permitted = new Set<string>();
  for (const option of options) {
    const match = /^([^:]+):permit:(.+)$/.exec(option.optionId);
    if (match) permitted.add(`${match[1]}:${match[1]}:${match[2]}`);
  }
  if (permitted.size === 0) return options;
  return options.filter((option) => !permitted.has(option.optionId));
}

export async function commitSwapKitV2(
  args: Omit<SwapKitV2SwapArgs, "mode"> & {
    optionId: string;
    /** The accepted option's quoteId, verbatim from the quote. */
    quoteId?: string;
    idempotencyKey: string;
    recoveryKey: string;
    acceptedDepositAmount: string;
    minimumSettleAmount: string;
    /** The wallet's refund material, when the caller already holds it. */
    refundMaterial?: V2RefundMaterial;
  },
): Promise<SwapKitV2OrderView> {
  if (!args.settleTarget)
    throw new SwapKitV2Error("commit requires settleTarget", { code: "recipient_invalid" });
  if (!args.recoveryKey || args.recoveryKey.length < 32)
    throw new SwapKitV2Error("commit requires a wallet-generated recoveryKey (>=32 chars)", {
      code: "recovery_key_invalid",
    });
  if (!args.acceptedDepositAmount || !args.minimumSettleAmount)
    throw new SwapKitV2Error(
      "commit requires acceptedDepositAmount and minimumSettleAmount consent bounds",
      { code: "consent_bounds_missing" },
    );
  const caps = await getSwapKitV2Capabilities();
  // Sent ahead only to a server that takes it (contract 2.5.0); the order then
  // comes back with its funding action instead of asking for the material.
  const { refundMaterial: given, ...commit } = args;
  const refundMaterial = v2AcceptsCommitRefundMaterial(caps.contractVersion)
    ? (given ??
      (await paymentTimed("wallet refund material", () =>
        v2CommitRefundMaterial({
          from: String(args.from),
          owner: String(args.owner ?? ""),
          capabilities: Array.isArray(args.capabilities) ? (args.capabilities as string[]) : [],
          idempotencyKey: args.idempotencyKey,
        }),
      )))
    : null;
  const view = await callSwapKitV2Tool<SwapKitV2OrderView>("swap", {
    ...commit,
    ...(refundMaterial ? { refundMaterial } : {}),
    mode: "commit",
  });
  assertKnownActionKinds(view.actions);
  return view;
}

export async function submitSwapKitV2Evidence(
  args: SwapKitV2SubmitArgs,
): Promise<SwapKitV2OrderView> {
  if (!args.recoveryKey)
    throw new SwapKitV2Error("swap_submit requires the order's recoveryKey", {
      code: "recovery_key_invalid",
    });
  const view = await callSwapKitV2Tool<SwapKitV2OrderView>("swap_submit", args);
  assertKnownActionKinds(view.actions);
  return view;
}

export async function getSwapKitV2Status(
  orderId: SwapKitV2OrderId,
  opts: { recoveryKey: string },
): Promise<SwapKitV2OrderView> {
  const view = await callSwapKitV2Tool<SwapKitV2OrderView>("swap_status", {
    orderId,
    recoveryKey: opts.recoveryKey,
  });
  assertKnownActionKinds(view.actions);
  return view;
}

export async function listSwapKitV2Orders(args: {
  owner: string;
  recoveryKey: string;
  activeOnly?: boolean;
}): Promise<SwapKitV2ListResponse> {
  return callSwapKitV2Tool<SwapKitV2ListResponse>("swap_list", args);
}

/** Cancel an UNFUNDED order (`swap_cancel`). The server checks its evidence
 * ledger and refuses an order that moved funds; an ERC-20 approval is not
 * funding. Returns the order view (EXPIRED on success). */
export async function cancelSwapKitV2Order(
  orderId: SwapKitV2OrderId,
  opts: { recoveryKey: string },
): Promise<SwapKitV2OrderView> {
  return callSwapKitV2Tool<SwapKitV2OrderView>("swap_cancel", {
    orderId,
    recoveryKey: opts.recoveryKey,
  });
}

/** One provider route's published deposit band, from `swap_limits`. Bounds are
 * exact-decimal strings in the FROM asset's canonical unit (decimal BTC, never
 * sats); null = the provider publishes no bound, never "no limit". */
export type SwapKitV2RouteLimits = {
  provider: string;
  route: string;
  side: "deposit" | "settle";
  min: string | null;
  max: string | null;
  reason?: string;
};

export type SwapKitV2LimitsResponse = {
  from: string;
  to: string;
  /** Smallest floor across the pair's routes; null when any route has none. */
  min: string | null;
  /** Largest ceiling across the pair's routes; null when any route has none. */
  max: string | null;
  routes: SwapKitV2RouteLimits[];
};

/** Read-only: the pair's per-route min/max WITHOUT quoting (`swap_limits`).
 * An older server has no such tool and this rejects — callers treat that as
 * "no bound known" and behave exactly as before. */
export async function getSwapKitV2Limits(args: {
  from: string;
  to: string;
}): Promise<SwapKitV2LimitsResponse> {
  return callSwapKitV2Tool<SwapKitV2LimitsResponse>("swap_limits", args);
}

export async function sweepSwapKitV2(args: {
  wallet: string;
  baseCurrency: "EURC_BASE" | "USDC_BASE";
  confirm: boolean;
  minUsd?: number;
  signableChains?: readonly number[];
  capabilities?: readonly string[];
  signerClass?: SwapKitV2SignerClass;
  idempotencyKey?: string;
  /** Required by the server to commit (confirm:true) an order. */
  recoveryKey?: string;
}): Promise<SwapKitV2SweepResponse> {
  if (args.confirm) await getSwapKitV2Capabilities();
  return callSwapKitV2Tool<SwapKitV2SweepResponse>("swap_sweep", args);
}

// ── Status model ────────────────────────────────────────────────────

export const SWAPKIT_V2_TERMINAL_STATUSES = new Set([
  "COMPLETED",
  "FAILED",
  "REFUNDED",
  "EXPIRED",
  "CANCELLED",
]);

export function isSwapKitV2Terminal(view: Pick<SwapKitV2OrderView, "status">): boolean {
  return SWAPKIT_V2_TERMINAL_STATUSES.has(String(view.status || "").toUpperCase());
}

// ── Fail-closed action guards ───────────────────────────────────────

/** Throw before anything is signed when the stream contains a kind this wallet
 * has no handler for. Executing a partial sequence strands funds mid-route. */
export function assertKnownActionKinds(actions: readonly SwapKitV2Action[] | undefined): void {
  for (const action of actions ?? []) {
    if (!SUPPORTED_KINDS.has(String(action.kind))) {
      throw new SwapKitV2Error(
        `SwapKit v2 returned an unsupported action kind: ${action.kind || "unknown"}`,
        { code: "unsupported_action_kind" },
      );
    }
    if (!action.actionId || !action.idempotencyKey) {
      throw new SwapKitV2Error("SwapKit v2 action is missing actionId or idempotencyKey", {
        code: "malformed_action",
      });
    }
  }
}

/** The next action the wallet must fulfil: first live `ready` action, or null
 * when the order is waiting on the server/provider. */
export function nextReadyV2Action(view: SwapKitV2OrderView): SwapKitV2Action | null {
  return view.actions.find((action) => action.state === "ready") ?? null;
}
