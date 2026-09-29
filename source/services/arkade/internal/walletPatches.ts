// Debug-trace patches applied to the SDK Wallet during bootstrap:
//   - PrefetchedExpoArkProvider: skip the first getInfo() roundtrip.
//   - installArkadeBatchDebugPatch: wrap createBatchHandler with batch/tree-signing traces.
//   - installArkadeProviderTracePatch: wrap registerIntent / confirmRegistration / getEventStream with traces.
//   - installArkadeCheckpointOrderPatch: reorder submitTx response checkpoints to the submitted order.
//   - forceIntegerArkadeFeeRate: round non-integer fee rates from the onchain provider.
//   - summarizeArkadeError: structured error formatter used in trace lines.
import {
  ArkError,
  CSVMultisigTapscript,
  Transaction,
  maybeArkError,
  validateVtxoTxGraph,
} from "@arkade-os/sdk";
import { ExpoArkProvider } from "@arkade-os/sdk/adapters/expo";
// SDK 0.5 renamed `ArkInfo` to `ArkInfo`; same shape.
import type { ArkInfo } from "@arkade-os/sdk";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { base64 } from "@scure/base";
import { bytesToHex } from "../../../lib/bytes";
import { sha256 } from "../../../lib/crypto";
import { errMsg } from "../../../lib/errorMessage";
import { emitTrace, logArkadeWalletErrorTrace, logArkadeWalletSignTrace } from "./logging";
import {
  compactArkadeLogValue,
  stringifyArkadeErrorData,
  truncateForLog,
  withTimeout,
} from "./utils";

const ARKADE_BATCH_PATCH_FLAG = "__arkadeBatchDebugPatchInstalled";
const ARKADE_BATCH_STREAM_READY_SOFT_GATE_MS = 2_000;
const ARKADE_PROVIDER_TRACE_PATCH_FLAG = "__arkadeProviderTracePatchInstalled";
const ARKADE_CHECKPOINT_ORDER_PATCH_FLAG = "__arkadeCheckpointOrderPatchInstalled";

// Minimal extension interfaces for the SDK reach-ins below. The SDK does not
// expose `forfeitPubkey`, `createBatchHandler`, or `arkProvider` on its public
// Wallet surface but our debug patches must mutate them by name.
export interface PatchableArkadeWallet {
  forfeitPubkey?: Uint8Array;
  arkProvider?: PatchableArkProvider;
  onchainProvider?: PatchableOnchainProvider;
  createBatchHandler?: (
    intentId: string,
    inputs: unknown,
    expectedRecipients: unknown,
    session?: PatchableSignerSession,
  ) => PatchableBatchHandler;
  [ARKADE_BATCH_PATCH_FLAG]?: boolean;
}

interface PatchableBatchHandler {
  onTreeSigningStarted?: (event: BatchEvent, vtxoTree: unknown) => Promise<{ skip: boolean }>;
  onBatchStarted?: (event: BatchEvent) => Promise<{ skip: boolean }>;
  onTreeNonces?: (event: BatchTreeNonceEvent) => Promise<{ fullySigned: boolean }>;
}

interface BatchEvent {
  id?: string;
  intentIdHashes?: string[];
  batchExpiry?: number | bigint;
  cosignersPublicKeys?: string[];
  unsignedCommitmentTx?: string;
  reason?: string;
}

interface BatchTreeNonceEvent {
  id?: string;
  txid?: string;
  nonces?: { size?: number; keys?: () => Iterable<unknown> };
}

interface PatchableSignerSession {
  getPublicKey(): Promise<Uint8Array>;
  getNonces(): Promise<Map<string, unknown>>;
  init(vtxoTree: unknown, sweepTapTreeRoot: Uint8Array, sharedAmount: bigint): Promise<void>;
}

export interface PatchableArkProvider {
  registerIntent?: (intent: ArkProviderIntent) => Promise<string>;
  confirmRegistration?: (intentId: string) => Promise<unknown>;
  getEventStream?: (signal: AbortSignal, topics: string[]) => AsyncIterableIterator<unknown>;
  submitTreeNonces?: (
    batchId: string,
    pubkey: string,
    nonces: Map<string, unknown>,
  ) => Promise<unknown>;
  submitTx?: (signedArkTx: string, checkpointTxs: string[]) => Promise<ArkProviderSubmitTxResponse>;
  [ARKADE_PROVIDER_TRACE_PATCH_FLAG]?: boolean;
  [ARKADE_CHECKPOINT_ORDER_PATCH_FLAG]?: boolean;
}

interface ArkProviderSubmitTxResponse {
  arkTxid?: string;
  finalArkTx?: string;
  signedCheckpointTxs?: string[];
}

interface ArkProviderIntent {
  message?: {
    type?: string;
    cosigners_public_keys?: string[];
    onchain_output_indexes?: number[];
    valid_at?: number;
    expire_at?: number;
  };
  proof?: unknown;
}

export interface PatchableOnchainProvider {
  getFeeRate?: () => Promise<number>;
  __nuriIntegerFeeRatePatchInstalled?: boolean;
}

export class PrefetchedExpoArkProvider extends ExpoArkProvider {
  private prefetchedInfo: ArkInfo | null;

  constructor(serverUrl: string, prefetchedInfo: ArkInfo | null) {
    super(serverUrl);
    this.prefetchedInfo = prefetchedInfo;
  }

  async getInfo(): Promise<ArkInfo> {
    if (this.prefetchedInfo) {
      const out = this.prefetchedInfo;
      this.prefetchedInfo = null;
      return out;
    }
    return super.getInfo();
  }
}

export function summarizeArkadeError(
  error: unknown,
  max = 220,
): { detail: string; source: "server" | "local" } {
  const err = (
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {}
  ) as Record<string, unknown> & {
    message?: unknown;
    code?: unknown;
    reason?: unknown;
    context?: { reason?: unknown };
    response?: { status?: unknown; statusText?: unknown; statusCode?: unknown; data?: unknown };
    status?: unknown;
    statusText?: unknown;
    data?: unknown;
    body?: unknown;
    responseBody?: unknown;
    originalError?: { message?: unknown };
    cause?: { message?: unknown };
  };
  const arkError =
    error instanceof ArkError ? error : error instanceof Error ? maybeArkError(error) : undefined;
  const message = compactArkadeLogValue(String(err?.message || error || "unknown"));
  const code = compactArkadeLogValue(String(err?.code || ""));
  const reason = compactArkadeLogValue(String(err?.reason || err?.context?.reason || ""));
  const statusRaw = err?.response?.status ?? err?.status ?? err?.response?.statusCode;
  const status = Number(statusRaw);
  const statusText = compactArkadeLogValue(
    String(err?.response?.statusText || err?.statusText || ""),
  );
  const body = stringifyArkadeErrorData(
    err?.response?.data ?? err?.data ?? err?.body ?? err?.responseBody,
    max,
  );
  const metadata = stringifyArkadeErrorData(arkError?.metadata, max);
  const original = compactArkadeLogValue(
    String(err?.originalError?.message || err?.cause?.message || ""),
  );
  const parts: string[] = [];
  const seen = new Set<string>();
  const push = (value: string) => {
    const normalized = compactArkadeLogValue(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    parts.push(normalized);
  };

  push(message);
  if (arkError?.name) push(`name=${arkError.name}`);
  if (typeof arkError?.code === "number") push(`arkCode=${arkError.code}`);
  if (Number.isFinite(status) && status > 0) push(`status=${Math.trunc(status)}`);
  if (statusText) push(`statusText=${statusText}`);
  if (code) push(`code=${code}`);
  if (reason) push(`reason=${reason}`);
  if (metadata) push(`meta=${metadata}`);
  if (body && body !== message) push(`body=${body}`);
  if (original && original !== message) push(`orig=${original}`);
  const serverInvolved =
    Boolean(arkError) || (Number.isFinite(status) && status > 0) || body.length > 0;

  return {
    detail: truncateForLog(parts.join(" | ") || "unknown", max),
    source: serverInvolved ? "server" : "local",
  };
}

export function isLikelyTransientNetworkError(error: unknown): boolean {
  const msg = errMsg(error, "").toLowerCase();
  if (!msg) return false;
  return (
    msg.includes("fetch failed") ||
    msg.includes("timeout") ||
    msg.includes("aborted") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("enotfound")
  );
}

export function arkadeErrorText(error: unknown, max = 220): string {
  return truncateForLog(errMsg(error, "unknown"), max).replace(/\s+/g, "_");
}

export function forceIntegerArkadeFeeRate(
  onchainProvider: PatchableOnchainProvider | undefined | null,
  label: string,
): void {
  if (!onchainProvider || onchainProvider.__nuriIntegerFeeRatePatchInstalled) return;
  if (typeof onchainProvider.getFeeRate !== "function") return;
  const originalGetFeeRate = onchainProvider.getFeeRate.bind(onchainProvider);
  onchainProvider.getFeeRate = async () => {
    const rawFeeRate = await originalGetFeeRate();
    const safeFeeRate = Math.max(1, Math.ceil(Number(rawFeeRate || 1)));
    if (safeFeeRate !== rawFeeRate) {
      logArkadeWalletSignTrace("arkade_fee_rate_rounded", {
        label,
        raw: rawFeeRate,
        safe: safeFeeRate,
        expected_next: "sdk_fee_bigint_safe",
      });
    }
    return safeFeeRate;
  };
  onchainProvider.__nuriIntegerFeeRatePatchInstalled = true;
}

export function installArkadeBatchDebugPatch(wallet: PatchableArkadeWallet): void {
  if (!wallet || wallet[ARKADE_BATCH_PATCH_FLAG]) return;
  if (typeof wallet.createBatchHandler !== "function") return;

  const originalCreateBatchHandler = wallet.createBatchHandler.bind(wallet);
  wallet.createBatchHandler = (
    intentIdArg: string,
    inputsArg: unknown,
    expectedRecipientsArg: unknown,
    session?: PatchableSignerSession,
  ) => {
    const handler = originalCreateBatchHandler(
      intentIdArg,
      inputsArg,
      expectedRecipientsArg,
      session,
    );
    const intentId = String(intentIdArg || "").trim();
    if (!handler || typeof handler.onTreeSigningStarted !== "function") {
      return handler;
    }

    emitTrace({
      atMs: Date.now(),
      op: "batch_handler_patch",
      status: session ? "session_ready" : "session_missing",
      detail: `intent=${intentId ? `${intentId.slice(0, 12)}...` : "n/a"}`,
    });

    let sweepTapTreeRoot: Uint8Array | null = null;
    const originalOnBatchStarted =
      typeof handler.onBatchStarted === "function" ? handler.onBatchStarted.bind(handler) : null;
    const originalOnTreeSigningStarted = handler.onTreeSigningStarted.bind(handler);

    handler.onBatchStarted = async (event: BatchEvent) => {
      const hashes = Array.isArray(event?.intentIdHashes)
        ? event.intentIdHashes.map((h) => String(h || "").toLowerCase()).filter(Boolean)
        : [];
      const expectedHash =
        intentId.length > 0
          ? bytesToHex(sha256(new TextEncoder().encode(intentId))).toLowerCase()
          : "";
      const matched = expectedHash ? hashes.includes(expectedHash) : false;
      const sample = hashes
        .slice(0, 3)
        .map((h) => `${h.slice(0, 10)}...`)
        .join(",");
      emitTrace({
        atMs: Date.now(),
        op: "batch_started_handler",
        status: "enter",
        detail: `batch=${String(event?.id || "n/a")} intent=${intentId ? `${intentId.slice(0, 12)}...` : "n/a"} hashes=${hashes.length} matched=${matched ? 1 : 0} expected=${expectedHash ? `${expectedHash.slice(0, 10)}...` : "n/a"} sample=${sample || "n/a"}`,
      });

      const out = originalOnBatchStarted ? await originalOnBatchStarted(event) : { skip: false };
      emitTrace({
        atMs: Date.now(),
        op: "batch_started_handler",
        status: "result",
        detail: `batch=${String(event?.id || "n/a")} skip=${out?.skip ? 1 : 0}`,
      });
      try {
        const expiry = BigInt(event?.batchExpiry ?? 0);
        const forfeitPubkey = wallet?.forfeitPubkey;
        if (forfeitPubkey instanceof Uint8Array && forfeitPubkey.length > 0) {
          const sweepTapscript = CSVMultisigTapscript.encode({
            timelock: {
              value: expiry,
              type: expiry >= 512n ? "seconds" : "blocks",
            },
            pubkeys: [forfeitPubkey],
          }).script;
          sweepTapTreeRoot = tapLeafHash(sweepTapscript);
        }
      } catch {}
      return out;
    };

    const originalOnTreeNonces =
      typeof handler.onTreeNonces === "function" ? handler.onTreeNonces.bind(handler) : null;

    handler.onTreeSigningStarted = async (event: BatchEvent, vtxoTree: unknown) => {
      emitTrace({
        atMs: Date.now(),
        op: "tree_signing_handler",
        status: "enter",
        detail: `batch=${String(event?.id || "n/a")} cosigners=${Array.isArray(event?.cosignersPublicKeys) ? event.cosignersPublicKeys.length : 0}`,
      });
      const out = await originalOnTreeSigningStarted(event, vtxoTree);
      emitTrace({
        atMs: Date.now(),
        op: "tree_signing_handler",
        status: "result",
        detail: `batch=${String(event?.id || "n/a")} skip=${out?.skip ? 1 : 0}`,
      });
      if (!out?.skip || !session) {
        return out;
      }

      try {
        const signerPubkey = bytesToHex(await session.getPublicKey()).toLowerCase();
        const signerXonly = signerPubkey.length === 66 ? signerPubkey.slice(2) : signerPubkey;
        const cosigners = Array.isArray(event?.cosignersPublicKeys)
          ? event.cosignersPublicKeys.map((k) => String(k || "").toLowerCase())
          : [];
        const cosignersXonly = cosigners.map((k) => (k.length >= 66 ? k.slice(2) : k));
        const looksLikeOurCosigner = cosignersXonly.includes(signerXonly);

        emitTrace({
          atMs: Date.now(),
          op: "tree_signing_skip",
          status: "observed",
          detail: `batch=${String(event?.id || "n/a")} ours=${signerPubkey.slice(0, 12)}... match=${looksLikeOurCosigner ? 1 : 0}`,
        });

        if (!looksLikeOurCosigner) {
          return out;
        }
        if (!sweepTapTreeRoot || sweepTapTreeRoot.length !== 32) {
          emitTrace({
            atMs: Date.now(),
            op: "tree_signing_skip",
            status: "blocked",
            detail: "missing sweep taproot root",
          });
          return out;
        }

        const commitmentTx = Transaction.fromPSBT(
          base64.decode(String(event?.unsignedCommitmentTx || "")),
        );
        validateVtxoTxGraph(
          vtxoTree as Parameters<typeof validateVtxoTxGraph>[0],
          commitmentTx,
          sweepTapTreeRoot,
        );
        const sharedOutput = commitmentTx.getOutput(0);
        if (!sharedOutput?.amount) {
          throw new Error("shared output missing");
        }

        await session.init(
          vtxoTree as Parameters<PatchableSignerSession["init"]>[0],
          sweepTapTreeRoot,
          sharedOutput.amount,
        );
        const pubkey = bytesToHex(await session.getPublicKey()).toLowerCase();
        const nonces = await session.getNonces();
        if (wallet.arkProvider?.submitTreeNonces) {
          await wallet.arkProvider.submitTreeNonces(String(event?.id || ""), pubkey, nonces);
        }

        emitTrace({
          atMs: Date.now(),
          op: "tree_signing_skip",
          status: "patched",
          detail: `batch=${String(event?.id || "n/a")} nonceCount=${nonces.size}`,
        });
        return { skip: false };
      } catch (error: unknown) {
        emitTrace({
          atMs: Date.now(),
          op: "tree_signing_skip",
          status: "patch_failed",
          detail: truncateForLog(errMsg(error, "unknown"), 180),
        });
        return out;
      }
    };

    handler.onTreeNonces = async (event: BatchTreeNonceEvent) => {
      const nonceCount =
        event?.nonces && typeof event.nonces.size === "number" ? event.nonces.size : "n/a";
      const nonceKeys =
        event?.nonces && typeof event.nonces.keys === "function"
          ? Array.from(event.nonces.keys())
              .map((k) => String(k || ""))
              .filter(Boolean)
          : [];
      const keySample = nonceKeys
        .slice(0, 4)
        .map((k) => `${k.slice(0, 12)}...(${k.length})`)
        .join(",");
      emitTrace({
        atMs: Date.now(),
        op: "tree_nonces_handler",
        status: "enter",
        detail: `batch=${String(event?.id || "n/a")} txid=${String(event?.txid || "").slice(0, 12)}... nonces=${nonceCount} keys=${keySample || "n/a"}`,
      });
      if (!originalOnTreeNonces) {
        return { fullySigned: true };
      }
      const out = await originalOnTreeNonces(event);
      emitTrace({
        atMs: Date.now(),
        op: "tree_nonces_handler",
        status: "result",
        detail: `batch=${String(event?.id || "n/a")} txid=${String(event?.txid || "").slice(0, 12)}... fullySigned=${out?.fullySigned ? 1 : 0}`,
      });
      return out;
    };

    return handler;
  };

  wallet[ARKADE_BATCH_PATCH_FLAG] = true;
}

interface ArkProviderStreamEvent {
  type?: string;
  id?: string;
  intentIdHashes?: string[];
  reason?: string;
}

/**
 * The SDK's batch-sign finalize path (active since our Identity implements
 * signMultiple, #768) pairs the client-signed checkpoints with the submitTx
 * response BY ARRAY INDEX — combineTapscriptSigs never checks txids. When the
 * server returns the checkpoints in a different order than submitted, the
 * client signature for checkpoint A is merged into checkpoint B and finalizeTx
 * fails with INVALID_SIGNATURE, leaving the send half-finalized and the input
 * vtxos stranded (seen on device 2026-07-05: 2-input Lightning swap; the
 * signed msg32 values matched the server-stored checkpoint sighashes exactly,
 * so ordering was the only possible mismatch). Single-checkpoint sends cannot
 * be affected, which is why they kept working.
 *
 * Fix: reorder the response checkpoints to the submitted order by txid so the
 * SDK's index pairing is always correct. Reordering is a no-op when the order
 * already matches; on any parse/match anomaly we return the server response
 * untouched (fail-open to the SDK's existing behavior, never worse).
 */
export function installArkadeCheckpointOrderPatch(wallet: PatchableArkadeWallet): void {
  const provider = wallet?.arkProvider;
  if (!provider || provider[ARKADE_CHECKPOINT_ORDER_PATCH_FLAG]) return;
  const originalSubmitTx =
    typeof provider.submitTx === "function" ? provider.submitTx.bind(provider) : null;
  if (!originalSubmitTx) return;

  const checkpointTxid = (psbtB64: string): string =>
    Transaction.fromPSBT(base64.decode(psbtB64)).id;

  provider.submitTx = async (signedArkTx: string, checkpointTxs: string[]) => {
    const response = await originalSubmitTx(signedArkTx, checkpointTxs);
    try {
      const returned = response?.signedCheckpointTxs;
      if (!Array.isArray(returned) || returned.length < 2) return response;
      if (!Array.isArray(checkpointTxs) || checkpointTxs.length !== returned.length) {
        return response;
      }
      const byTxid = new Map(returned.map((psbt) => [checkpointTxid(psbt), psbt]));
      const reordered = checkpointTxs.map((psbt) => byTxid.get(checkpointTxid(psbt)));
      if (byTxid.size !== returned.length || reordered.some((psbt) => !psbt)) {
        logArkadeWalletSignTrace("checkpoint_order_patch_txid_mismatch", {
          submitted: checkpointTxs.length,
          returned: returned.length,
          matched: reordered.filter(Boolean).length,
          expected_next: "keep_server_order_finalize_may_fail",
        });
        return response;
      }
      const changed = reordered.some((psbt, index) => psbt !== returned[index]);
      if (changed) {
        logArkadeWalletSignTrace("checkpoint_order_patch_reordered", {
          checkpoints: returned.length,
          expected_next: "index_pairing_now_matches_submitted_order",
        });
      }
      return { ...response, signedCheckpointTxs: reordered as string[] };
    } catch (error: unknown) {
      logArkadeWalletSignTrace("checkpoint_order_patch_error", {
        err: truncateForLog(errMsg(error, "unknown"), 120),
        expected_next: "keep_server_order_finalize_may_fail",
      });
      return response;
    }
  };
  provider[ARKADE_CHECKPOINT_ORDER_PATCH_FLAG] = true;
  logArkadeWalletSignTrace("checkpoint_order_patch_installed", {
    expected_next: "submit_tx_responses_reordered_to_submitted_order",
  });
}

export function installArkadeProviderTracePatch(wallet: PatchableArkadeWallet): void {
  const provider = wallet?.arkProvider;
  if (!provider || provider[ARKADE_PROVIDER_TRACE_PATCH_FLAG]) return;
  const pendingIntentHashes = new Set<string>();
  const activeBatchIds = new Set<string>();
  let streamReadyPromise: Promise<void> | null = null;
  let resolveStreamReady: (() => void) | null = null;

  const originalConfirmRegistration =
    typeof provider.confirmRegistration === "function"
      ? provider.confirmRegistration.bind(provider)
      : null;

  const originalRegisterIntent =
    typeof provider.registerIntent === "function" ? provider.registerIntent.bind(provider) : null;
  if (originalRegisterIntent) {
    provider.registerIntent = async (intent: ArkProviderIntent) => {
      const startedAt = Date.now();
      const type = String(intent?.message?.type || "n/a");
      const cosigners = Array.isArray(intent?.message?.cosigners_public_keys)
        ? intent.message.cosigners_public_keys.length
        : 0;
      const onchainOutputs = Array.isArray(intent?.message?.onchain_output_indexes)
        ? intent.message.onchain_output_indexes.length
        : 0;
      const validAt = Number(intent?.message?.valid_at ?? 0);
      const expireAt = Number(intent?.message?.expire_at ?? 0);
      emitTrace({
        atMs: startedAt,
        op: "ark_provider_register_intent",
        status: "attempt",
        detail: `type=${type} cosigners=${cosigners} onchainOutputs=${onchainOutputs} validAt=${validAt} expireAt=${expireAt}`,
      });
      logArkadeWalletSignTrace("ark_provider_register_intent", {
        status: "attempt",
        type,
        cosigners,
        onchain_outputs: onchainOutputs,
        valid_at: validAt,
        expire_at: expireAt,
        proof_present: intent?.proof ? 1 : 0,
        expected_next: "arkade_register_intent_response",
      });
      try {
        if (streamReadyPromise) {
          logArkadeWalletSignTrace("ark_provider_stream_gate", {
            status: "soft_wait_before_register",
            limit_ms: ARKADE_BATCH_STREAM_READY_SOFT_GATE_MS,
            expected_next: "register_after_stream_started_or_continue",
          });
          try {
            await withTimeout(
              "ark_provider_stream_ready_before_register",
              ARKADE_BATCH_STREAM_READY_SOFT_GATE_MS,
              streamReadyPromise,
            );
          } catch (streamGateError: unknown) {
            const message = errMsg(streamGateError, "unknown");
            logArkadeWalletSignTrace("ark_provider_stream_gate", {
              status: "soft_timeout_continue",
              limit_ms: ARKADE_BATCH_STREAM_READY_SOFT_GATE_MS,
              err: truncateForLog(message, 120),
              expected_next: "register_intent_without_blocking_on_sse_marker",
            });
          }
        } else {
          logArkadeWalletSignTrace("ark_provider_stream_gate", {
            status: "not_available",
            detail: "registerIntent called before getEventStream",
            expected_next: "watch_for_batch_started_race",
          });
        }
        const intentId = await originalRegisterIntent(intent);
        emitTrace({
          atMs: Date.now(),
          op: "ark_provider_register_intent",
          status: "ok",
          detail: `durMs=${Date.now() - startedAt} id=${String(intentId || "").slice(0, 12)}...`,
        });
        try {
          const rawId = String(intentId || "").trim();
          if (rawId) {
            const intentHash = bytesToHex(sha256(new TextEncoder().encode(rawId))).toLowerCase();
            pendingIntentHashes.add(intentHash);
            emitTrace({
              atMs: Date.now(),
              op: "ark_provider_register_intent",
              status: "hash",
              detail: `id=${rawId.slice(0, 12)}... hash=${intentHash.slice(0, 12)}... pending=${pendingIntentHashes.size}`,
            });
          }
        } catch {}
        emitTrace({
          atMs: Date.now(),
          op: "ark_provider_confirm_eager",
          status: "disabled",
          detail: "reason=wait_for_local_batch_started_handler",
        });
        return intentId;
      } catch (error: unknown) {
        const errorSummary = summarizeArkadeError(error, 260);
        logArkadeWalletSignTrace("ark_provider_register_intent", {
          status: "failed",
          dur_ms: Date.now() - startedAt,
          source: errorSummary.source,
          err: errorSummary.detail,
          expected_next: "surface_send_error",
        });
        emitTrace({
          atMs: Date.now(),
          op: "ark_provider_register_intent",
          status: "failed",
          detail: `durMs=${Date.now() - startedAt} source=${errorSummary.source} err=${errorSummary.detail}`,
        });
        throw error;
      }
    };
  }

  if (originalConfirmRegistration) {
    provider.confirmRegistration = async (intentId: string) => {
      const startedAt = Date.now();
      emitTrace({
        atMs: startedAt,
        op: "ark_provider_confirm",
        status: "attempt",
        detail: `id=${String(intentId || "").slice(0, 12)}...`,
      });
      try {
        const out = await originalConfirmRegistration(intentId);
        emitTrace({
          atMs: Date.now(),
          op: "ark_provider_confirm",
          status: "ok",
          detail: `durMs=${Date.now() - startedAt} id=${String(intentId || "").slice(0, 12)}...`,
        });
        return out;
      } catch (error: unknown) {
        emitTrace({
          atMs: Date.now(),
          op: "ark_provider_confirm",
          status: "failed",
          detail: `durMs=${Date.now() - startedAt} id=${String(intentId || "").slice(0, 12)}... err=${truncateForLog(errMsg(error, "unknown"), 160)}`,
        });
        throw error;
      }
    };
  }

  const originalGetEventStream =
    typeof provider.getEventStream === "function" ? provider.getEventStream.bind(provider) : null;
  if (originalGetEventStream) {
    provider.getEventStream = (signal: AbortSignal, topics: string[]) => {
      const requestedTopics = Array.isArray(topics)
        ? topics.map((t) => String(t || "").trim()).filter(Boolean)
        : [];
      const topicSet = new Set<string>();
      requestedTopics.forEach((topic) => {
        const normalized = topic.toLowerCase();
        topicSet.add(normalized);
        if (/^[0-9a-f]{66}$/i.test(normalized)) {
          topicSet.add(normalized.slice(2));
        }
      });
      const finalTopics = [...topicSet];
      const topicSample = finalTopics
        .slice(0, 4)
        .map((t) => t.slice(0, 16))
        .join(",");
      emitTrace({
        atMs: Date.now(),
        op: "ark_provider_stream",
        status: "open",
        detail: `topicsReq=${requestedTopics.length} topicsFinal=${finalTopics.length} sample=${topicSample || "n/a"}`,
      });
      streamReadyPromise = new Promise<void>((resolve) => {
        resolveStreamReady = resolve;
      });

      const baseIter = originalGetEventStream(signal, finalTopics);
      const queuedEvents: unknown[] = [];
      const waiters: Array<{
        resolve: (result: IteratorResult<unknown>) => void;
        reject: (error: unknown) => void;
      }> = [];
      let count = 0;
      let done = false;
      let streamError: unknown = null;

      const enqueue = (event: unknown) => {
        const waiter = waiters.shift();
        if (waiter) {
          waiter.resolve({ value: event, done: false });
          return;
        }
        queuedEvents.push(event);
      };
      const finish = (error?: unknown) => {
        done = true;
        streamError = error || null;
        while (waiters.length > 0) {
          const waiter = waiters.shift();
          if (!waiter) continue;
          if (streamError) {
            waiter.reject(streamError);
          } else {
            waiter.resolve({ value: undefined, done: true });
          }
        }
      };

      void (async () => {
        try {
          emitTrace({
            atMs: Date.now(),
            op: "ark_provider_stream",
            status: "priming",
            detail: `topics=${finalTopics.length}`,
          });
          for await (const event of baseIter as AsyncIterable<ArkProviderStreamEvent>) {
            count += 1;
            const type = String(event?.type || "unknown");
            const id = String(event?.id || "");
            const normalizedId = id.trim();
            if (type === "stream_started") {
              resolveStreamReady?.();
              resolveStreamReady = null;
              logArkadeWalletSignTrace("ark_provider_stream_gate", {
                status: "stream_started",
                event: "stream_started",
                id: truncateForLog(id, 24) || "n/a",
                expected_next: "register_intent_safe",
              });
            }
            if (type === "batch_started") {
              const hashes = Array.isArray(event?.intentIdHashes)
                ? event.intentIdHashes.map((h) => String(h || "").toLowerCase()).filter(Boolean)
                : [];
              const matched = hashes.filter((h) => pendingIntentHashes.has(h));
              if (matched.length > 0 && normalizedId) {
                activeBatchIds.add(normalizedId);
                matched.forEach((h) => pendingIntentHashes.delete(h));
              }
              emitTrace({
                atMs: Date.now(),
                op: "ark_provider_stream_batch",
                status: "batch_started",
                detail: `id=${normalizedId ? `${normalizedId.slice(0, 12)}...` : "n/a"} hashes=${hashes.length} matched=${matched.length} active=${activeBatchIds.size} pending=${pendingIntentHashes.size}`,
              });
            } else if (type === "tree_signing_started" && normalizedId) {
              activeBatchIds.add(normalizedId);
              emitTrace({
                atMs: Date.now(),
                op: "ark_provider_stream_batch",
                status: "tree_started",
                detail: `id=${normalizedId.slice(0, 12)}... active=${activeBatchIds.size} pending=${pendingIntentHashes.size}`,
              });
            } else if (type === "batch_finalized" && normalizedId) {
              activeBatchIds.delete(normalizedId);
              emitTrace({
                atMs: Date.now(),
                op: "ark_provider_stream_batch",
                status: "batch_finalized",
                detail: `id=${normalizedId.slice(0, 12)}... active=${activeBatchIds.size}`,
              });
            } else if (type === "batch_failed") {
              const known = normalizedId ? activeBatchIds.has(normalizedId) : false;
              if (normalizedId) {
                activeBatchIds.delete(normalizedId);
              }
              emitTrace({
                atMs: Date.now(),
                op: "ark_provider_stream_batch",
                status: "batch_failed",
                detail: `id=${normalizedId ? `${normalizedId.slice(0, 12)}...` : "n/a"} known=${known ? 1 : 0} active=${activeBatchIds.size} pending=${pendingIntentHashes.size} reason=${truncateForLog(String(event?.reason || "n/a"), 120)}`,
              });
              logArkadeWalletErrorTrace("ark_provider_stream_batch_failed", {
                status: "batch_failed",
                id: truncateForLog(normalizedId, 24) || "n/a",
                known: known ? 1 : 0,
                active: activeBatchIds.size,
                pending: pendingIntentHashes.size,
                reason: truncateForLog(String(event?.reason || "n/a"), 140),
                expected_next: "surface_send_error",
              });
            }
            emitTrace({
              atMs: Date.now(),
              op: "ark_provider_stream",
              status: "event",
              detail: `idx=${count} type=${type} id=${id ? `${id.slice(0, 12)}...` : "n/a"} queued=${queuedEvents.length}`,
            });
            enqueue(event);
          }
          emitTrace({
            atMs: Date.now(),
            op: "ark_provider_stream",
            status: "close",
            detail: `events=${count}`,
          });
          resolveStreamReady?.();
          resolveStreamReady = null;
          finish();
        } catch (error: unknown) {
          resolveStreamReady?.();
          resolveStreamReady = null;
          emitTrace({
            atMs: Date.now(),
            op: "ark_provider_stream",
            status: "error",
            detail: `events=${count} err=${truncateForLog(errMsg(error, "unknown"), 170)}`,
          });
          finish(error);
        }
      })();

      const streamIterator: AsyncIterableIterator<unknown> = {
        next(): Promise<IteratorResult<unknown>> {
          if (queuedEvents.length > 0) {
            return Promise.resolve({ value: queuedEvents.shift(), done: false });
          }
          if (done) {
            return streamError
              ? Promise.reject(streamError)
              : Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve, reject) => {
            waiters.push({ resolve, reject });
          });
        },
        return(): Promise<IteratorResult<unknown>> {
          finish();
          void Promise.resolve((baseIter as { return?: () => Promise<unknown> })?.return?.()).catch(
            () => {},
          );
          return Promise.resolve({ value: undefined, done: true });
        },
        [Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
          emitTrace({
            atMs: Date.now(),
            op: "ark_provider_stream",
            status: "consumer_start",
            detail: `queued=${queuedEvents.length} events=${count}`,
          });
          return streamIterator;
        },
      };
      const contractOk =
        typeof streamIterator.next === "function" &&
        typeof streamIterator[Symbol.asyncIterator] === "function";
      logArkadeWalletSignTrace("ark_provider_stream_contract", {
        status: contractOk ? "ok" : "invalid",
        direct_next: typeof streamIterator.next === "function" ? 1 : 0,
        async_iterator: typeof streamIterator[Symbol.asyncIterator] === "function" ? 1 : 0,
        expected_next: contractOk
          ? "sdk_wallet_settle_can_prime_stream"
          : "block_settle_before_signing",
      });
      emitTrace({
        atMs: Date.now(),
        op: "ark_provider_stream_contract",
        status: contractOk ? "ok" : "invalid",
        detail: `direct_next=${typeof streamIterator.next === "function" ? 1 : 0} async_iterator=${typeof streamIterator[Symbol.asyncIterator] === "function" ? 1 : 0}`,
      });
      return streamIterator;
    };
  }

  provider[ARKADE_PROVIDER_TRACE_PATCH_FLAG] = true;
}
