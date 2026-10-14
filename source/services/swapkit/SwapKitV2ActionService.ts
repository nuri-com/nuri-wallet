// SwapKit v2 action dispatcher (#268 amendment c): ONE switch on `kind`.
//
// The server owns routing, ordering and amounts; every envelope carries the
// exact bound request the wallet must fulfil. This module:
//   1. validates each bound request fail-closed (money-critical guards mirror
//      the proven v1 guardians in SwapKitService/SwapKitEvmSigner);
//   2. executes it through an injected wallet executor (executors are injected
//      by callers to avoid import cycles, exactly like v1's handleHtlcAction /
//      handleArkadeAction seams);
//   3. journals the evidence per actionId so a replay can never sign, pay or
//      broadcast twice — the journaled result is re-submitted verbatim;
//   4. submits evidence via swap_submit and hands back the refreshed view.
//
// Adding a corridor adds ZERO code here. This switch grows only for a
// genuinely new signing primitive (= contract version bump server-side).
import { LOG_EMOJI, errorWithId, logWithId } from "../../lib/OperationLogUtils";
import { getCacheValue, setCacheValue } from "../balance/TransactionCacheService";
import { noteV2MovePaid } from "./SwapKitV2MoveStatus";
import {
  type SwapKitV2Action,
  type SwapKitV2OrderId,
  type SwapKitV2OrderView,
  SwapKitV2Error,
  getSwapKitV2Status,
  isSwapKitV2Terminal,
  submitSwapKitV2Evidence,
} from "./SwapKitV2Service";

const SOURCE = "services/swapkit/SwapKitV2ActionService.ts";

// ── Evidence shapes (capability registry response schemas) ──────────

export type SwapKitV2Evidence = {
  txHash?: string;
  preimage?: string;
  signature?: string;
  result?: Record<string, unknown>;
};

// ── Wallet executor seam ────────────────────────────────────────────
//
// One executor per action kind. Callers construct the set from the wallet
// primitives they own; a kind without an executor fails closed BEFORE
// anything is signed (assertExecutableActions), never mid-route.

export type SwapKitV2Executors = {
  /** Move the bound asset/amount to the bound destination; return the
   * origin-rail transfer id. Only sweep-style flows provide this — normal
   * order flows must fail closed on send_asset (the wallet never sends funds
   * to a server-named address without a flow-owned funder). */
  send_asset?: (
    request: Record<string, unknown>,
    ctx: SwapKitV2ActionContext,
  ) => Promise<{ txHash: string }>;
  /** Sign + broadcast the exact bound calldata; return the inclusion hash. */
  execute_evm_call?: (
    request: Record<string, unknown>,
    ctx: SwapKitV2ActionContext,
  ) => Promise<{ txHash: string }>;
  /** Produce a signature the verifying party accepts for exactly this payload. */
  sign_typed_data?: (
    request: Record<string, unknown>,
    ctx: SwapKitV2ActionContext,
  ) => Promise<{ signature: string }>;
  /** Pay the bound BOLT11 invoice; return the payment hash (+preimage when known). */
  pay_lightning_invoice?: (
    request: Record<string, unknown>,
    ctx: SwapKitV2ActionContext,
  ) => Promise<{ paymentHash: string; preimage?: string }>;
  /** Derive order-scoped HTLC material; PUBLIC data only. `walletKeyRef` is a
   * wallet-minted opaque reference the server stores and echoes verbatim —
   * the wallet alone can resolve it (contract v2.1.0). */
  htlc_material?: (
    request: Record<string, unknown>,
    ctx: SwapKitV2ActionContext,
  ) => Promise<{
    paymentHash: string;
    claimPublicKey: string;
    refundPublicKey: string;
    walletKeyRef: string;
  }>;
  /** Send sats to the bound ark1…/VHTLC address; return the Arkade txid. */
  arkade_send?: (
    request: Record<string, unknown>,
    ctx: SwapKitV2ActionContext,
  ) => Promise<{ arkTxid: string }>;
  /** Fund the bound Arkade Intents covenant lockup and return the EXACT created
   * VTXO outpoint — the server verifies {txid, vout} against the indexer, so a
   * generic arkade_send (txid-only) cannot fulfil this kind. */
  arkade_intents_fund?: (
    request: Record<string, unknown>,
    ctx: SwapKitV2ActionContext,
  ) => Promise<{ arkTxid: string; outpoint: { txid: string; vout: number } }>;
  /** Claim the bound VHTLC to the wallet's own address; return the Arkade txid. */
  arkade_claim?: (
    request: Record<string, unknown>,
    ctx: SwapKitV2ActionContext,
  ) => Promise<{ arkTxid: string }>;
  /** Provide Arkade Intents refund PUBLIC material: the x-only sender pubkey +
   * a wallet-minted opaque `walletKeyRef` the server stores and echoes verbatim.
   * No money moves; the wallet resolves the ref locally at refund time. */
  arkade_refund_material?: (
    request: Record<string, unknown>,
    ctx: SwapKitV2ActionContext,
  ) => Promise<{ senderPublicKey: string; walletKeyRef: string }>;
  /** Refund a funded Arkade Intents lockup after its bound timelock using
   * wallet-owned material; return the Arkade txid. Blocked (fail-closed) until
   * the bound refundLocktime matures. */
  arkade_intents_refund?: (
    request: Record<string, unknown>,
    ctx: SwapKitV2ActionContext,
  ) => Promise<{ arkTxid: string }>;
};

export type SwapKitV2ActionContext = {
  orderId: SwapKitV2OrderId;
  actionId: string;
  previouslyStarted?: boolean;
  /**
   * Record that this action has reached its IRREVERSIBLE boundary — the moment
   * just before value is broadcast or sent. Executors call it there so a crash
   * after it is treated as "may have moved money", while a refusal BEFORE it
   * (validation, a bounds check, the user dismissing the passkey prompt) leaves
   * no marker and the action stays cleanly retryable.
   *
   * Marking unconditionally before the executor ran meant a cancelled auth
   * prompt stranded the action permanently as possibly-sent. Safe to call more
   * than once; the runner also marks defensively if an executor throws an error
   * it cannot prove happened pre-broadcast.
   */
  markStarted?: () => Promise<void>;
  /**
   * Throws when the server's deadline for this action has passed. An executor
   * that waits on the user (passkey, approval) calls it right before value
   * moves: past the deadline the server no longer stands behind the action,
   * e.g. a Lightning lockup the solver can no longer pay (swapkit #385).
   */
  assertBeforeDeadline?: () => void;
};

// Set only on the deadline refusal, which executors raise before value moves:
// a dispatcher whose STARTED marker an inner hook already wrote may clear it.
const SENT_NOTHING = Symbol.for("nuri.swapkitV2.deadlineSentNothing");

function v2ActionDeadlineError(actionId: string): SwapKitV2Error {
  const error = new SwapKitV2Error(
    `v2 action ${actionId} passed its deadline before anything was sent; request it again`,
    { code: "action_deadline_passed", retryable: false },
  );
  (error as unknown as Record<PropertyKey, unknown>)[SENT_NOTHING] = true;
  return error;
}

// ── Money-critical request validation (fail closed, then execute) ──

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function assertEvmAddress(value: unknown, field: string): string {
  const raw = asString(value);
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new SwapKitV2Error(`v2 action has an invalid ${field}: ${raw || "(empty)"}`);
  }
  return raw;
}

/** execute_evm_call: chain must be allow-listed, `to`/`data` well-formed and
 * the native value zero — stablecoin legs never send ETH; a non-zero value can
 * only drain gas funds (same rule as v1 parseSwapActionTx). Calldata may carry
 * the `$htlcPreimageHex` redaction; the executor resolves it via keyRef. */
export function validateExecuteEvmCall(
  request: Record<string, unknown>,
  allowedChains: readonly number[],
): void {
  const chainId = Number(request.chainId);
  if (!allowedChains.includes(chainId)) {
    throw new SwapKitV2Error(
      `v2 execute_evm_call targets chain ${request.chainId ?? "unknown"}; allowed here: ${allowedChains.join(", ")}.`,
    );
  }
  assertEvmAddress(request.to, "to");
  const data = asString(request.data);
  if (!/^0x(?:[0-9a-fA-F]|\$htlcPreimageHex)*$/.test(data) || data.length < 4) {
    throw new SwapKitV2Error("v2 execute_evm_call has invalid calldata.");
  }
  const value = request.value == null ? "0" : String(request.value);
  if (!/^\d+$/.test(value) || BigInt(value) !== 0n) {
    throw new SwapKitV2Error("v2 execute_evm_call carries a non-zero native value.");
  }
  if (request.needsPreimage === true) assertKeyRef(request.keyRef);
}

function assertKeyRef(raw: unknown): void {
  const keyRef = (raw ?? {}) as {
    provider?: unknown;
    walletKeyRef?: unknown;
    preimageHash?: unknown;
  };
  // Contract v2.1.0: the binding is the wallet-minted OPAQUE walletKeyRef, not a
  // server-derived ordinal. The deprecated numeric keyIndex is intentionally not
  // accepted — the wallet resolves material only through refs it minted itself.
  if (
    !asString(keyRef.provider) ||
    !asString(keyRef.walletKeyRef) ||
    !/^0x[0-9a-fA-F]{64}$/.test(asString(keyRef.preimageHash))
  ) {
    throw new SwapKitV2Error("v2 preimage-bearing action has no valid keyRef binding.");
  }
}

/** pay_lightning_invoice: the bound invoice + exact sats. The RFQ spread IS
 * the complete cost — never recompute a fee ceiling client-side. */
export function validatePayLightningInvoice(request: Record<string, unknown>): void {
  if (!/^ln/i.test(asString(request.invoice))) {
    throw new SwapKitV2Error("v2 pay_lightning_invoice is missing a BOLT11 invoice.");
  }
  const sats = Number(request.amountSats);
  if (!Number.isSafeInteger(sats) || sats < 1) {
    throw new SwapKitV2Error("v2 pay_lightning_invoice has an invalid amountSats.");
  }
}

/** arkade_send: bound ark address + exact integer sats. */
export function validateArkadeSend(request: Record<string, unknown>): void {
  const to = asString(request.to);
  if (!to.startsWith("ark1")) {
    throw new SwapKitV2Error("v2 arkade_send destination is not an ark1 address.");
  }
  const sats = Number(request.amountSats);
  if (!Number.isSafeInteger(sats) || sats < 1) {
    throw new SwapKitV2Error("v2 arkade_send has an invalid amountSats.");
  }
}

/** arkade_intents_fund: bound ark1 covenant lockup + exact integer sats. The
 * executor resolves and returns the EXACT created outpoint, which the server
 * verifies against the indexer. */
export function validateArkadeIntentsFund(request: Record<string, unknown>): void {
  const to = asString(request.to);
  if (!to.startsWith("ark1")) {
    throw new SwapKitV2Error("v2 arkade_intents_fund lockup is not an ark1 address.");
  }
  const sats = Number(request.amountSats);
  if (!Number.isSafeInteger(sats) || sats < 1) {
    throw new SwapKitV2Error("v2 arkade_intents_fund has an invalid amountSats.");
  }
}

/** arkade_claim (provider-descriptor form): the complete VHTLC descriptor must
 * be present, and the preimage must be either server-supplied or locally
 * materializable via keyRef — a claim without either can never build a witness. */
export function validateArkadeClaim(request: Record<string, unknown>): void {
  if (request.outpoint != null || request.claimScript != null) {
    // Outpoint/claimScript form: the server hands an opaque tapleaf script and
    // an outpoint with no VHTLC descriptor. This wallet cannot verify the
    // money-critical bindings (hashLock = RIPEMD160(SHA256(our preimage)),
    // receiver = our swap key) from an opaque script, so it must NOT sign it.
    // None of this wallet's advertised corridors require this form (BTC_ARKADE→
    // stable uses arkade_intents_fund/refund; EVM→Arkade uses the descriptor
    // claim below), so refuse it fail-closed HERE — consistently with the
    // executor — rather than accept it and strand at execution.
    throw new SwapKitV2Error(
      "v2 arkade_claim outpoint/claimScript form is not supported by this wallet; expected the VHTLC descriptor form.",
    );
  }
  const vhtlc = request.vhtlc as Record<string, unknown> | undefined;
  if (!vhtlc || !asString(vhtlc.address).startsWith("ark1")) {
    throw new SwapKitV2Error("v2 arkade_claim is missing its bound VHTLC descriptor.");
  }
  if (!asString(request.destinationAddress)) {
    throw new SwapKitV2Error("v2 arkade_claim is missing its destination address.");
  }
  const hasServerPreimage = /^0x[0-9a-fA-F]{64}$/.test(asString(request.preimage));
  if (!hasServerPreimage && request.needsPreimage !== true) {
    throw new SwapKitV2Error(
      "v2 arkade_claim has neither a server preimage nor a keyRef preimage binding.",
    );
  }
  if (request.needsPreimage === true) assertKeyRef(request.keyRef);
}

/** arkade_refund_material: order-scoped material exchange. A missing scope
 * would let two orders derive interchangeable refund keys — refuse it. Pure
 * public-material response, no money movement, no keyRef binding. */
export function validateArkadeRefundMaterial(request: Record<string, unknown>): void {
  if (!asString(request.scope)) {
    throw new SwapKitV2Error("v2 arkade_refund_material is missing its order scope.");
  }
}

/** arkade_intents_refund: every field that binds the refund to the funded
 * lockup must be present and well-formed BEFORE the executor rebuilds the
 * covenant — a malformed binding must never reach the signer. The wallet-owned
 * ref is opaque (the wallet alone resolves it); the covenant parameters are
 * re-verified against the funded record inside the executor. */
export function validateArkadeIntentsRefund(request: Record<string, unknown>): void {
  if (!asString(request.rfqId)) {
    throw new SwapKitV2Error("v2 arkade_intents_refund is missing its rfqId.");
  }
  if (!asString(request.lockupAddress).startsWith("ark1")) {
    throw new SwapKitV2Error("v2 arkade_intents_refund lockupAddress is not an ark1 address.");
  }
  if (!asString(request.destinationAddress).startsWith("ark1")) {
    throw new SwapKitV2Error("v2 arkade_intents_refund destinationAddress is not an ark1 address.");
  }
  if (!asString(request.walletKeyRef)) {
    throw new SwapKitV2Error("v2 arkade_intents_refund is missing its walletKeyRef.");
  }
  const outpoint = (request.fundingOutpoint ?? {}) as { txid?: unknown; vout?: unknown };
  if (!/^[0-9a-f]{64}$/.test(asString(outpoint.txid))) {
    throw new SwapKitV2Error("v2 arkade_intents_refund fundingOutpoint.txid is malformed.");
  }
  const vout = Number(outpoint.vout);
  if (!Number.isSafeInteger(vout) || vout < 0) {
    throw new SwapKitV2Error("v2 arkade_intents_refund fundingOutpoint.vout is invalid.");
  }
  const amountSats = Number(request.amountSats);
  if (!Number.isSafeInteger(amountSats) || amountSats < 1) {
    throw new SwapKitV2Error("v2 arkade_intents_refund has an invalid amountSats.");
  }
  const refundLocktime = Number(request.refundLocktime);
  if (!Number.isSafeInteger(refundLocktime) || refundLocktime < 1) {
    throw new SwapKitV2Error("v2 arkade_intents_refund has an invalid refundLocktime.");
  }
  if (!request.lockupParams || typeof request.lockupParams !== "object") {
    throw new SwapKitV2Error("v2 arkade_intents_refund is missing its lockupParams.");
  }
}

/** htlc_material: order-scoped derivation only — a missing scope would let two
 * orders derive interchangeable keys. */
export function validateHtlcMaterial(request: Record<string, unknown>): void {
  const role = asString(request.role);
  if (role !== "sender" && role !== "receiver") {
    throw new SwapKitV2Error(`v2 htlc_material has an invalid role: ${role || "(empty)"}`);
  }
  if (!asString(request.scope)) {
    throw new SwapKitV2Error("v2 htlc_material is missing its order scope.");
  }
  if (role === "sender" && !/^[0-9a-fA-F]{64}$/.test(asString(request.paymentHash))) {
    throw new SwapKitV2Error("v2 htlc_material sender role is missing its bound paymentHash.");
  }
}

/** sign_typed_data: complete EIP-712 payload. Domain policy (which contracts
 * we sign for) lives in the executor, which owns the chain/domain context. */
export function validateSignTypedData(request: Record<string, unknown>): void {
  if (
    !request.domain ||
    typeof request.domain !== "object" ||
    !request.types ||
    typeof request.types !== "object" ||
    !asString(request.primaryType) ||
    !request.message ||
    typeof request.message !== "object"
  ) {
    throw new SwapKitV2Error("v2 sign_typed_data payload is incomplete.");
  }
  if (request.needsPreimage === true) assertKeyRef(request.keyRef);
}

/** send_asset: canonical asset, decimal amount, non-empty destination. The
 * flow-level policy (may this flow fund a server-named address at all?) is
 * enforced by executor presence, not here. */
export function validateSendAsset(request: Record<string, unknown>): void {
  if (!asString(request.asset)) throw new SwapKitV2Error("v2 send_asset is missing its asset.");
  const amount = asString(request.amount);
  if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) {
    throw new SwapKitV2Error("v2 send_asset has an invalid amount.");
  }
  if (!asString(request.to)) throw new SwapKitV2Error("v2 send_asset is missing its destination.");
}

// ── Evidence journal (replay safety) ────────────────────────────────
//
// Same chained-write pattern as the v1 HTLC/Arkade journals, with TWO durable
// records per action, keyed by orderId+actionId so an actionId reused across
// orders can never replay another order's evidence:
//   - a STARTED intent, written BEFORE the irreversible side effect; on resume
//     an action that started but has no evidence is treated as possibly-executed
//     and its executor must reconcile (idempotency key) rather than blindly redo.
//   - the completed EVIDENCE, written before swap_submit; a retry re-submits it
//     verbatim and never re-signs or re-broadcasts.

const JOURNAL_KEY = "swapkit:v2-evidence:v2";
const STARTED_KEY = "swapkit:v2-started:v1";

/** The ERC20 `approve(address,uint256)` selector. An approve is the one action
 * a stale-start reconciliation may safely re-run: the EVM signer reads the live
 * allowance first, so re-execution is a no-op when the earlier attempt landed
 * and the real approval when it did not — never a double-spend. */
const ERC20_APPROVE_SELECTOR = "0x095ea7b3";

/** True only for an `execute_evm_call` whose calldata is an ERC20 approve with
 * zero native value — the sole re-runnable-idempotent action. Everything a
 * wallet can BROADCAST value through (sends, lightning pay, non-approve EVM
 * calls) returns false and stays fail-closed on a stale start. */
function isReRunnableApprove(action: SwapKitV2Action): boolean {
  if (action.kind !== "execute_evm_call") return false;
  const request = (action.request ?? {}) as Record<string, unknown>;
  const data = String(request.data ?? "").toLowerCase();
  const value = String(request.value ?? "0");
  return data.startsWith(ERC20_APPROVE_SELECTOR) && (value === "0" || value === "0x0");
}

/**
 * An action that, once STARTED, can be safely RE-ENTERED to report the spend it
 * already made rather than making a new one.
 *
 * `arkade_intents_fund` resolves the created VTXO outpoint from the indexer when
 * `reconcileOnly` is set (which the executor derives from `previouslyStarted`),
 * so re-entering it funds nothing. Without this the blanket refusal stranded the
 * very orders the reconciling path exists to rescue: a lockup funded on disk and
 * a server that was never told.
 */
function isReconcilableFunding(action: SwapKitV2Action): boolean {
  return action.kind === "arkade_intents_fund";
}

/** Composite key: an actionId is only unique WITHIN an order. */
function journalKey(orderId: string, actionId: string): string {
  return `${orderId}\u0000${actionId}`;
}

async function loadMap<T>(key: string): Promise<Record<string, T>> {
  try {
    const parsed = await getCacheValue<unknown>(key);
    return parsed && typeof parsed === "object" ? { ...(parsed as Record<string, T>) } : {};
  } catch {
    return {};
  }
}

let journalChain: Promise<void> = Promise.resolve();
async function journalEvidence(
  orderId: string,
  actionId: string,
  evidence: SwapKitV2Evidence,
): Promise<void> {
  const write = journalChain.then(async () => {
    const current = await loadMap<SwapKitV2Evidence>(JOURNAL_KEY);
    current[journalKey(orderId, actionId)] = evidence;
    await setCacheValue(JOURNAL_KEY, current);
  });
  journalChain = write.catch(() => {});
  await write;
}

/** Persist a STARTED marker before the irreversible side effect, so a crash
 * between execution and the evidence write is detectable on resume. */
async function markActionStarted(orderId: string, actionId: string): Promise<void> {
  const write = journalChain.then(async () => {
    const current = await loadMap<number>(STARTED_KEY);
    current[journalKey(orderId, actionId)] = Date.now();
    await setCacheValue(STARTED_KEY, current);
  });
  journalChain = write.catch(() => {});
  await write;
}

/** Drop a stale STARTED marker for an action the server still reports `ready`.
 * Only the dispatcher calls this, and only after confirming the live action is
 * `ready` — i.e. the prior attempt produced NO server-accepted evidence, so it
 * provably never landed and re-running is not a repeat. */
async function clearActionStarted(orderId: string, actionId: string): Promise<void> {
  const write = journalChain.then(async () => {
    const current = await loadMap<number>(STARTED_KEY);
    delete current[journalKey(orderId, actionId)];
    await setCacheValue(STARTED_KEY, current);
  });
  journalChain = write.catch(() => {});
  await write;
}

export async function getJournaledV2Evidence(
  orderId: string,
  actionId: string,
): Promise<SwapKitV2Evidence | null> {
  const journal = await loadMap<SwapKitV2Evidence>(JOURNAL_KEY);
  return journal[journalKey(orderId, actionId)] ?? null;
}

/** True when an action was started (side effect may have fired) but its evidence
 * was never journaled — a crash window the executor must reconcile, not redo. */
export async function wasV2ActionStartedWithoutEvidence(
  orderId: string,
  actionId: string,
): Promise<boolean> {
  const started = await loadMap<number>(STARTED_KEY);
  if (!(journalKey(orderId, actionId) in started)) return false;
  const evidence = await getJournaledV2Evidence(orderId, actionId);
  return evidence == null;
}

// ── The dispatcher ──────────────────────────────────────────────────

export const BASE_CHAIN_ID = 8453;

export type SwapKitV2DispatchOptions = {
  executors: SwapKitV2Executors;
  /** Chains execute_evm_call may target. Default Base-only; sweep flows widen
   * this to the source chain of the detected balance (v1 rule). */
  allowedEvmChains?: readonly number[];
  /** The order's wallet-generated recovery capability (contract 2.2.0). Required
   * on every authed call (submit/status); the tracker derives it once per order
   * from the wallet owner and passes it down. */
  recoveryKey: string;
};

/** Every ready action's kind must have an executor BEFORE the first one runs —
 * executing a partial sequence strands funds mid-route (v1 guardian rule). */
export function assertExecutableActions(
  actions: readonly SwapKitV2Action[],
  executors: SwapKitV2Executors,
): void {
  for (const action of actions) {
    if (!executors[action.kind as keyof SwapKitV2Executors]) {
      throw new SwapKitV2Error(
        `SwapKit v2 route needs an action this flow cannot execute: ${action.kind}`,
        { code: "unsupported_action_kind" },
      );
    }
  }
}

/**
 * Validate, execute (or replay), journal and submit ONE bound action.
 * Returns the refreshed order view from swap_submit.
 */
export async function executeAndSubmitV2Action(
  orderId: SwapKitV2OrderId,
  action: SwapKitV2Action,
  options: SwapKitV2DispatchOptions,
): Promise<SwapKitV2OrderView> {
  const actionId = String(action.actionId || "").trim();
  if (!actionId) throw new SwapKitV2Error("v2 action is missing actionId");
  if (action.state !== "ready") {
    throw new SwapKitV2Error(`v2 action ${actionId} is not ready (state ${action.state})`);
  }
  const ctx: SwapKitV2ActionContext = {
    orderId,
    actionId,
    previouslyStarted: await wasV2ActionStartedWithoutEvidence(orderId, actionId),
  };
  const request = action.request ?? {};

  // Replay: a journaled action re-submits its durable evidence verbatim and
  // never executes again (swap_submit is idempotent by the action's key).
  const journaled = await getJournaledV2Evidence(orderId, actionId);
  if (journaled) {
    logWithId(
      `${LOG_EMOJI.bitcoin} SwapKitV2.action`,
      `replaying journaled evidence for ${actionId} (${action.kind})`,
      { orderId, actionId },
      { source: `${SOURCE}#executeAndSubmitV2Action`, event: "FLOW", action: "replay" },
    );
    return submitSwapKitV2Evidence({
      orderId,
      recoveryKey: options.recoveryKey,
      actionId,
      idempotencyKey: action.idempotencyKey,
      ...journaled,
    });
  }

  if (ctx.previouslyStarted) {
    // A STARTED marker with no journaled evidence means a prior attempt began
    // but never wrote server-accepted evidence. Two cases hide behind that, and
    // only ONE is safe to re-run:
    //
    //   • An action that can BROADCAST value (any wallet send: arkade_*,
    //     pay_lightning_invoice, or a non-approve EVM call) may have hit the
    //     wire and crashed before journaling — the server still shows `ready`
    //     even though funds moved. Re-running would double-send. Fail closed,
    //     exactly as before: surface a reconciliation status, never redo it.
    //
    //   • An ERC20 approve (execute_evm_call, `approve(spender,amount)`) is
    //     idempotent by construction: the EVM signer reads the LIVE allowance
    //     first and skips the tx when it already covers the amount, so a
    //     re-run is a no-op if the earlier one landed and the real thing if it
    //     did not. This is the leg a stable→stable swap deadlocks on when the
    //     user steps away mid-approve; re-running it is what lets the swap
    //     simply continue on return. Clear the stale marker and fall through.
    if (isReRunnableApprove(action)) {
      await clearActionStarted(orderId, actionId);
      ctx.previouslyStarted = false;
      logWithId(
        `${LOG_EMOJI.bitcoin} SwapKitV2.action`,
        `reconciled stale approve for ${actionId}: server still ready, re-executing`,
        { orderId, actionId },
        { source: `${SOURCE}#executeAndSubmitV2Action`, event: "FLOW", action: "reconcile" },
      );
    } else if (isReconcilableFunding(action)) {
      // arkade_intents_fund re-entered with previouslyStarted REPORTS the spend
      // the earlier attempt already made (reconcileOnly) — it resolves the real
      // outpoint from the indexer and never funds again. Refusing it outright
      // left exactly the orders this path exists to rescue stuck forever, with
      // a funded lockup the server was never told about. `previouslyStarted`
      // stays true so the executor takes the reconciling branch, not the
      // funding one.
      logWithId(
        `${LOG_EMOJI.bitcoin} SwapKitV2.action`,
        `reconciling started funding for ${actionId}: reporting the existing spend`,
        { orderId, actionId },
        { source: `${SOURCE}#executeAndSubmitV2Action`, event: "FLOW", action: "reconcile" },
      );
    } else {
      throw new SwapKitV2Error(
        `v2 action ${actionId} started without durable evidence; refusing to repeat an irreversible action`,
        { code: "action_reconciliation_required", retryable: false },
      );
    }
  }

  // The STARTED marker moves to the executor's own irreversible boundary (see
  // ctx.markStarted). Marking it here — before the executor had done anything —
  // meant a refusal that provably moved nothing (a failed bounds check, a
  // dismissed passkey prompt) still stranded the action as possibly-sent, and
  // the branch above then refused to ever re-run it.
  //
  // The marker is idempotent and owned by the executor: every value-moving
  // executor calls it at its own broadcast boundary.
  let markedStarted = false;
  const markStarted = async () => {
    if (markedStarted) return;
    markedStarted = true;
    await markActionStarted(orderId, actionId);
    noteV2MovePaid(orderId);
  };
  ctx.markStarted = markStarted;
  const deadlineMs = action.deadline == null ? Number.NaN : Date.parse(String(action.deadline));
  ctx.assertBeforeDeadline = () => {
    if (deadlineMs <= Date.now()) throw v2ActionDeadlineError(actionId);
  };

  let evidence: Awaited<ReturnType<typeof executeV2Action>>;
  try {
    // A fresh action past its deadline is never started; an already started
    // one still reconciles, so funds that moved are always reported.
    if (!ctx.previouslyStarted) ctx.assertBeforeDeadline();
    evidence = await executeV2Action(action, request, ctx, options);
  } catch (error) {
    // AFTER the boundary: the marker is on disk; a retry reaches the
    // STARTED-without-evidence branch above and fails closed. Rethrow as is.
    if (markedStarted) {
      if ((error as Record<PropertyKey, unknown> | null)?.[SENT_NOTHING] !== true) throw error;
      // A deadline refusal after the marker (an executor hook wrote it) still
      // sent nothing: drop the marker so the action is not stranded.
      await clearActionStarted(orderId, actionId);
    }
    // BEFORE the boundary (bounds rejection, failed simulation, dismissed
    // passkey prompt): nothing moved, so NO marker — the action stays
    // re-runnable. It still stops the loop rather than retrying on its own,
    // which would re-prompt a user who just said no; the tracker surfaces it
    // and an explicit Continue runs the action again cleanly.
    //
    // The runner previously marked STARTED here for every error lacking a
    // `sentNothing` flag no production path set, stranding each such refusal
    // as a permanent `action_reconciliation_required`.
    // The ORIGINAL error is rethrown (callers still classify it, e.g. a user
    // cancel), tagged so the loop treats it as terminal.
    if (error && typeof error === "object") {
      (error as Record<PropertyKey, unknown>)[REFUSED_BEFORE_BROADCAST] = true;
    }
    throw error;
  }

  // PERSIST-BEFORE-SUBMIT: the evidence is durable before the network call, so
  // a crash mid-submit retries into the replay path above.
  await journalEvidence(orderId, actionId, evidence);

  logWithId(
    `${LOG_EMOJI.bitcoin} SwapKitV2.action`,
    `executed ${action.kind} for ${actionId}`,
    { orderId, actionId },
    { source: `${SOURCE}#executeAndSubmitV2Action`, event: "FLOW", action: action.kind },
  );

  return submitSwapKitV2Evidence({
    orderId,
    recoveryKey: options.recoveryKey,
    actionId,
    idempotencyKey: action.idempotencyKey,
    ...evidence,
  });
}

async function executeV2Action(
  action: SwapKitV2Action,
  request: Record<string, unknown>,
  ctx: SwapKitV2ActionContext,
  options: SwapKitV2DispatchOptions,
): Promise<SwapKitV2Evidence> {
  const { executors } = options;
  const missing = () =>
    new SwapKitV2Error(`SwapKit v2 returned an action this flow cannot execute: ${action.kind}`, {
      code: "unsupported_action_kind",
    });
  switch (action.kind) {
    case "send_asset": {
      if (!executors.send_asset) throw missing();
      validateSendAsset(request);
      const { txHash } = await executors.send_asset(request, ctx);
      return { txHash, result: { actionId: ctx.actionId, txHash } };
    }
    case "execute_evm_call": {
      if (!executors.execute_evm_call) throw missing();
      validateExecuteEvmCall(request, options.allowedEvmChains ?? [BASE_CHAIN_ID]);
      const { txHash } = await executors.execute_evm_call(request, ctx);
      return { txHash, result: { actionId: ctx.actionId, txHash } };
    }
    case "sign_typed_data": {
      if (!executors.sign_typed_data) throw missing();
      validateSignTypedData(request);
      const { signature } = await executors.sign_typed_data(request, ctx);
      return { signature, result: { actionId: ctx.actionId, signature } };
    }
    case "pay_lightning_invoice": {
      if (!executors.pay_lightning_invoice) throw missing();
      validatePayLightningInvoice(request);
      const { paymentHash, preimage } = await executors.pay_lightning_invoice(request, ctx);
      return {
        ...(preimage ? { preimage } : {}),
        result: { actionId: ctx.actionId, paymentHash, ...(preimage ? { preimage } : {}) },
      };
    }
    case "htlc_material": {
      if (!executors.htlc_material) throw missing();
      validateHtlcMaterial(request);
      const material = await executors.htlc_material(request, ctx);
      // PUBLIC material only — the preimage/keys never leave the wallet.
      return { result: { actionId: ctx.actionId, ...material } };
    }
    case "arkade_send": {
      if (!executors.arkade_send) throw missing();
      validateArkadeSend(request);
      const { arkTxid } = await executors.arkade_send(request, ctx);
      return { txHash: arkTxid, result: { actionId: ctx.actionId, arkTxid } };
    }
    case "arkade_intents_fund": {
      if (!executors.arkade_intents_fund) throw missing();
      validateArkadeIntentsFund(request);
      const { arkTxid, outpoint } = await executors.arkade_intents_fund(request, ctx);
      // The exact created outpoint rides the evidence result — the server
      // verifies {txid, vout} against the indexer before arming the refund.
      return { txHash: arkTxid, result: { actionId: ctx.actionId, arkTxid, outpoint } };
    }
    case "arkade_claim": {
      if (!executors.arkade_claim) throw missing();
      validateArkadeClaim(request);
      const { arkTxid } = await executors.arkade_claim(request, ctx);
      return { txHash: arkTxid, result: { actionId: ctx.actionId, arkTxid } };
    }
    case "arkade_refund_material": {
      if (!executors.arkade_refund_material) throw missing();
      validateArkadeRefundMaterial(request);
      const material = await executors.arkade_refund_material(request, ctx);
      // PUBLIC material only — the sender private key never leaves the wallet.
      return { result: { actionId: ctx.actionId, ...material } };
    }
    case "arkade_intents_refund": {
      if (!executors.arkade_intents_refund) throw missing();
      validateArkadeIntentsRefund(request);
      const { arkTxid } = await executors.arkade_intents_refund(request, ctx);
      return { txHash: arkTxid, result: { actionId: ctx.actionId, arkTxid } };
    }
    default:
      // A kind we do not recognise is a genuinely new signing primitive.
      throw new SwapKitV2Error(`SwapKit v2 returned an unknown action kind: ${action.kind}`, {
        code: "unsupported_action_kind",
      });
  }
}

// ── The order loop (reference-client shape) ─────────────────────────

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new SwapKitV2LoopAbortedError());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new SwapKitV2LoopAbortedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** The loop was stopped on purpose (soft logout). Not a failure: callers must
 * neither surface it to the user nor write any state for the order. */
export class SwapKitV2LoopAbortedError extends Error {
  constructor() {
    super("v2 order loop aborted");
    this.name = "SwapKitV2LoopAbortedError";
  }
}

export type SwapKitV2LoopOptions = SwapKitV2DispatchOptions & {
  /** Aborts the loop between steps and during waits (soft logout). An abort
   * never interrupts an executor mid-send: it is checked only at step
   * boundaries, so a started broadcast finishes and journals its evidence. */
  signal?: AbortSignal;
  intervalMs?: number;
  /** TEST SEAM ONLY — bound the number of iterations so a unit test terminates.
   * Production never sets it: a committed order runs until the SERVER says it
   * is terminal, and an order the app gave up on is money nobody is watching. */
  maxPolls?: number;
  onUpdate?: (view: SwapKitV2OrderView) => void;
};

/** Backoff for transient failures: the poll interval, widening per consecutive
 * failure and capped, so a long outage keeps costing about one request a minute
 * instead of abandoning the order. Derived from `intervalMs` so a caller (and a
 * test) that polls fast also retries fast. */
const MAX_RETRY_BACKOFF_MS = 60_000;

function retryBackoffMs(intervalMs: number, consecutiveErrors: number): number {
  return Math.min(intervalMs * Math.max(1, consecutiveErrors), MAX_RETRY_BACKOFF_MS);
}

/**
 * Failures that repeating cannot resolve, so the loop must stop and let the
 * tracker publish an actionable status instead of spinning unattended:
 *   - the wallet cannot execute this action kind, or the server does not know
 *     the order (contract violations);
 *   - the action already started without durable evidence — repeating it is
 *     precisely what the reconciliation guard exists to prevent, so retrying
 *     can only produce this same error forever;
 *   - the server rejected the request 4xx (a malformed bound request, an
 *     invalid recipient, a refused capability) — the same bytes will be
 *     rejected identically on every repeat.
 *
 * Deliberately NOT terminal: a 429/5xx, and an error carried inside a 200
 * envelope — the server maps transient provider states into those, and
 * abandoning a funded order over one is the failure mode this loop exists to
 * avoid. A submit that keeps failing transiently also keeps retrying: its
 * evidence is already journaled, so the retry replays rather than re-executing.
 */
/** Tag on an executor error thrown BEFORE its broadcast boundary: nothing
 * moved and no STARTED marker exists, so the action stays re-runnable, but the
 * loop stops instead of auto-retrying (and re-prompting a user who said no). */
const REFUSED_BEFORE_BROADCAST = Symbol.for("nuri.swapkitV2.refusedBeforeBroadcast");

export function isRefusedBeforeBroadcast(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as Record<PropertyKey, unknown>)[REFUSED_BEFORE_BROADCAST] === true
  );
}

function isTerminalLoopFailure(error: unknown): boolean {
  if (isRefusedBeforeBroadcast(error)) return true;
  if (!(error instanceof SwapKitV2Error)) return false;
  if (
    error.code === "unsupported_action_kind" ||
    error.code === "unknown_order" ||
    error.code === "action_reconciliation_required"
  ) {
    return true;
  }
  return error.httpStatus >= 400 && error.httpStatus < 500 && error.httpStatus !== 429;
}

/**
 * Drive one committed v2 order to terminal: drain every ready action through
 * the dispatcher, otherwise poll swap_status.
 *
 * There is no attempt budget for WAITING. The user accepted a quote and left;
 * nothing else is watching this order, so a transient provider/network failure
 * backs off and retries indefinitely rather than silently stranding a funded
 * move.
 *
 * EXECUTING an action is the opposite case: a failure that waiting cannot fix —
 * a rejected signature, a malformed bound request, an action that started
 * without durable evidence — would otherwise re-run the same step forever,
 * hold the order's loop claim, and leave the pill stuck on "Executing…" with no
 * way for the user to intervene. Those fail closed so the tracker can publish
 * them as an actionable status the user can act on.
 */
export async function runSwapKitV2OrderLoop(
  initialView: SwapKitV2OrderView,
  orderId: SwapKitV2OrderId,
  options: SwapKitV2LoopOptions,
): Promise<SwapKitV2OrderView> {
  const intervalMs = options.intervalMs ?? 12_000;
  const maxPolls = options.maxPolls ?? Number.POSITIVE_INFINITY;
  let view = initialView;
  let consecutiveErrors = 0;
  const throwIfAborted = () => {
    if (options.signal?.aborted) throw new SwapKitV2LoopAbortedError();
  };
  for (let i = 0; i < maxPolls; i++) {
    throwIfAborted();
    try {
      options.onUpdate?.(view);
    } catch {}
    if (isSwapKitV2Terminal(view)) return view;
    const ready = view.actions.filter((action) => action.state === "ready");
    // A ready call past the deadline the server bound it to is not signed: the
    // server stops standing behind it then (e.g. LI.FI calldata holds ~60 s) and
    // the next status poll brings its replacement.
    const stale = ready.some(
      (action) => action.deadline != null && Date.parse(action.deadline) <= Date.now(),
    );
    try {
      if (ready.length && !stale) {
        // Guardian: every ready action must be executable BEFORE the first
        // one runs — never start a sequence this flow cannot finish.
        assertExecutableActions(ready, options.executors);
        throwIfAborted();
        view = await executeAndSubmitV2Action(orderId, ready[0], options);
      } else {
        // A stale call is refreshed at once, not after the idle interval.
        if (!stale) await wait(intervalMs, options.signal);
        throwIfAborted();
        view = await getSwapKitV2Status(orderId, { recoveryKey: options.recoveryKey });
      }
      consecutiveErrors = 0;
    } catch (error) {
      if (error instanceof SwapKitV2LoopAbortedError || options.signal?.aborted) {
        throw error instanceof SwapKitV2LoopAbortedError ? error : new SwapKitV2LoopAbortedError();
      }
      if (isTerminalLoopFailure(error)) {
        throw error; // fail closed — waiting cannot fix this
      }
      consecutiveErrors += 1;
      errorWithId(
        `${LOG_EMOJI.bitcoin} SwapKitV2.loop`,
        `step failed (attempt ${consecutiveErrors}, retrying) id=${orderId}`,
        { err: error instanceof Error ? error.message : String(error) },
        { source: `${SOURCE}#runSwapKitV2OrderLoop`, event: "API_ERR", action: "loop" },
      );
      await wait(retryBackoffMs(intervalMs, consecutiveErrors), options.signal);
    }
  }
  return view;
}
