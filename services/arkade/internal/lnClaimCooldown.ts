// In-flight tracking + per-id failure cooldown for LN receive claims. Owned
// state so the resume Core and the orchestrator don't share `let` plumbing.
import { errorMessageText } from "./utils";

const ARKADE_LN_RECEIVE_CLAIM_FAILURE_RETRY_MS = 30_000;
const ARKADE_LN_RECEIVE_CLAIM_CREDENTIAL_RETRY_MS = 10 * 60_000;

export const claimInFlightSwapIds: Set<string> = new Set();

const lnReceiveClaimFailureCooldownById: Map<string, { untilMs: number; reason: string }> =
  new Map();

export function classifyLnReceiveClaimError(error: unknown): string {
  const msg = errorMessageText(error).toLowerCase();
  if (msg.includes("wallet passkey credential mismatch")) return "credential_mismatch";
  if (msg.includes("cancel") || msg.includes("user")) return "user_cancel";
  if (msg.includes("passkey") || msg.includes("credential")) return "passkey";
  return "claim_error";
}

export function getLnReceiveClaimCooldown(
  id: string,
): { remainingMs: number; reason: string } | null {
  const cached = lnReceiveClaimFailureCooldownById.get(id);
  if (!cached) return null;
  const remainingMs = cached.untilMs - Date.now();
  if (remainingMs <= 0) {
    lnReceiveClaimFailureCooldownById.delete(id);
    return null;
  }
  return { remainingMs, reason: cached.reason };
}

export function setLnReceiveClaimCooldown(
  id: string,
  error: unknown,
): { retryMs: number; reason: string } {
  const reason = classifyLnReceiveClaimError(error);
  const retryMs =
    reason === "credential_mismatch" || reason === "passkey" || reason === "user_cancel"
      ? ARKADE_LN_RECEIVE_CLAIM_CREDENTIAL_RETRY_MS
      : ARKADE_LN_RECEIVE_CLAIM_FAILURE_RETRY_MS;
  lnReceiveClaimFailureCooldownById.set(id, {
    untilMs: Date.now() + retryMs,
    reason,
  });
  return { retryMs, reason };
}

export function clearLnReceiveClaimCooldowns(): void {
  lnReceiveClaimFailureCooldownById.clear();
}

export function deleteLnReceiveClaimCooldown(id: string): void {
  lnReceiveClaimFailureCooldownById.delete(id);
}
