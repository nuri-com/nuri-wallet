// Internal arkade outgoing send-approval wrapper shared by prod-tier and debug-tier code.
import { errMsg } from "../../../lib/errorMessage";
import { getOrCreateArkadeIdentity } from "./identity";
import { emitTrace, logArkadeWalletSignTrace } from "./logging";
import type { ArkadeSpendApprovalScope } from "./spendApproval";
import { truncateForLog } from "./utils";

let outgoingBrowserApprovalInFlight: Promise<unknown> | null = null;

export function getArkadeOutgoingBrowserApprovalInFlight(): Promise<unknown> | null {
  return outgoingBrowserApprovalInFlight;
}

export function clearArkadeOutgoingBrowserApprovalInFlight(): void {
  outgoingBrowserApprovalInFlight = null;
}

export async function withOutgoingBrowserApproval<T>(
  summary: {
    kind: string;
    title: string;
    recipient?: string;
    amountSats?: number;
    note?: string;
    source?: string;
    approvalScope?: ArkadeSpendApprovalScope;
    finalAmountSats?: number;
    paymentHash?: string;
    psbtB64?: string;
    swapIntentId?: string;
    onSigned?: (txid: string) => void | Promise<void>;
  },
  work: () => Promise<T>,
  traceContext?: {
    opId?: string;
    detail?: string;
    onSubmitted?: (txid: string) => void | Promise<void>;
  },
): Promise<T> {
  if (outgoingBrowserApprovalInFlight) {
    logArkadeWalletSignTrace("native_send_approval_blocked", {
      kind: summary.kind,
      amount_sats: summary.amountSats ?? "n/a",
      recipient: truncateForLog(summary.recipient || "n/a", 90),
      expected_next: "wait_for_existing_approval",
    });
    emitTrace({
      atMs: Date.now(),
      op: "native_v5_send",
      status: "blocked",
      id: traceContext?.opId || undefined,
      detail:
        traceContext?.detail ||
        `flow=arkade.v5_send kind=${summary.kind} amount=${summary.amountSats ?? "n/a"} recipient=${summary.recipient || "n/a"}`,
    });
    throw new Error("outgoing send approval already in progress");
  }

  const run = (async () => {
    const identity = await getOrCreateArkadeIdentity();
    const approvalId = identity.armOutgoingSpendApproval(summary);
    logArkadeWalletSignTrace("native_send_approval_armed", {
      src: "services/arkade/internal/browserApproval.ts#withOutgoingBrowserApproval",
      approval_id: approvalId,
      kind: summary.kind,
      amount_sats: summary.amountSats ?? "n/a",
      recipient: truncateForLog(summary.recipient || "n/a", 90),
      scope: summary.approvalScope || "exact",
      prompt_budget: "native_passkey_prf_assertion_1_keychain_face_id_0_expected",
      server_approval: "native_v5_assertion",
      native_passkey_after_prepare: "prf_assertion_or_cache",
      keychain_biometric: 0,
      expected_next: "arkade_sdk_requests_identity_sign",
    });
    emitTrace({
      atMs: Date.now(),
      op: "native_v5_send",
      status: "armed",
      id: traceContext?.opId || undefined,
      detail:
        traceContext?.detail ||
        `flow=arkade.v5_send kind=${summary.kind} amount=${summary.amountSats ?? "n/a"} recipient=${summary.recipient || "n/a"}`,
    });
    try {
      logArkadeWalletSignTrace("native_send_approval_work_start", {
        src: "services/arkade/internal/browserApproval.ts#withOutgoingBrowserApproval",
        approval_id: approvalId,
        kind: summary.kind,
        prompt_budget: "track_passkey_module_and_keychain_logs",
        expected_passkey_log: "passkey_prf_assertion_or_prf_assertion_cache_hit",
        expected_face_id_log: "keychain_biometric_is_bug_for_arkade",
        expected_next: "v5_prepare_then_native_passkey_then_v5_cosign",
      });
      const out = await identity.withMaintenanceSigningScope(
        `native_v5_send_${summary.kind}`,
        work,
      );
      if (typeof out === "string" && out.trim()) {
        try {
          await traceContext?.onSubmitted?.(out);
        } catch (submittedError: unknown) {
          logArkadeWalletSignTrace("native_send_submitted_callback_failed", {
            approval_id: approvalId,
            kind: summary.kind,
            err: truncateForLog(errMsg(submittedError, "unknown"), 180),
            expected_next: "continue_send_complete_ack",
          });
        }
      }
      // The send is already broadcast/funded once `work` returns; the
      // completion ack is bookkeeping. A transient /send/complete failure
      // must not surface as a failed send or skip settlement/claim
      // continuation in the callers.
      try {
        await identity.completeOutgoingSpendApproval(typeof out === "string" ? out : undefined);
      } catch (completeError: unknown) {
        logArkadeWalletSignTrace("native_send_complete_ack_failed", {
          approval_id: approvalId,
          kind: summary.kind,
          err: truncateForLog(errMsg(completeError, "unknown"), 180),
          expected_next: "send_continues_server_expires_challenge",
        });
      }
      logArkadeWalletSignTrace("native_send_approval_work_returned", {
        approval_id: approvalId,
        kind: summary.kind,
        expected_next: "send_function_logs_txid",
      });
      emitTrace({
        atMs: Date.now(),
        op: "native_v5_send",
        status: "work_returned",
        id: traceContext?.opId || undefined,
        detail:
          traceContext?.detail ||
          `flow=arkade.v5_send kind=${summary.kind} amount=${summary.amountSats ?? "n/a"} recipient=${summary.recipient || "n/a"}`,
      });
      return out;
    } catch (error: unknown) {
      logArkadeWalletSignTrace("native_send_approval_work_failed", {
        approval_id: approvalId,
        kind: summary.kind,
        err: truncateForLog(errMsg(error, "unknown"), 180),
        expected_next: "surface_send_error",
      });
      emitTrace({
        atMs: Date.now(),
        op: "native_v5_send",
        status: "work_failed",
        id: traceContext?.opId || undefined,
        detail: `${traceContext?.detail || `flow=arkade.v5_send kind=${summary.kind}`} err=${truncateForLog(errMsg(error, "unknown"), 180)}`,
      });
      throw error;
    } finally {
      logArkadeWalletSignTrace("native_send_approval_clear", {
        approval_id: approvalId,
        kind: summary.kind,
        expected_next: "pending_approval_removed_and_key_zeroized",
      });
      identity.clearOutgoingSpendApproval("work_complete", approvalId);
      identity.clearClientSigningKey("native_v5_send_work_complete");
    }
  })();

  outgoingBrowserApprovalInFlight = run;
  try {
    return await run;
  } finally {
    if (outgoingBrowserApprovalInFlight === run) {
      outgoingBrowserApprovalInFlight = null;
    }
  }
}
