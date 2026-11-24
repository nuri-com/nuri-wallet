import type { ArkadeRecoveryStatus } from "../../services/arkade/ArkadeApiService";

/**
 * Existing-passkey restore gate (#1086).
 *
 * `GET /arkade/info` looks the recovery record up by credential id, so
 * `registered && passkey_pubkey_present` comes back for ANY client key derived
 * for that credential. A second PRF-derived client key for the same synced
 * passkey (#606) therefore passed the gate and signed in to a normal-looking
 * empty wallet that then failed at `/arkade/auth`. The server now answers
 * `recovery.client_match` (nuri-server-musig2-v4-arkade #173); sign-in proceeds
 * only on an explicit `match`.
 *
 * - `proceed`: the record is bound to exactly this client key.
 * - `not_registered`: no record / no passkey pubkey (pre-cutover passkey path,
 *   unchanged behaviour).
 * - `client_mismatch`: registered credential bound to another client key.
 * - `protocol_error`: anything else (field missing, `unknown`, contradicting
 *   `unregistered`): fail closed, nothing is persisted.
 */
export type RestoreClientMatchDecision =
  | { kind: "proceed" }
  | { kind: "not_registered" }
  | { kind: "client_mismatch" }
  | { kind: "protocol_error"; reason: string };

export function decideRestoreClientMatch(
  recovery: ArkadeRecoveryStatus | null | undefined,
): RestoreClientMatchDecision {
  if (!recovery?.registered || !recovery.passkey_pubkey_present) {
    return { kind: "not_registered" };
  }
  const clientMatch: unknown = recovery.client_match;
  if (clientMatch === "match") return { kind: "proceed" };
  if (clientMatch === "mismatch") return { kind: "client_mismatch" };
  if (clientMatch === undefined || clientMatch === null) {
    return { kind: "protocol_error", reason: "client_match_missing" };
  }
  if (typeof clientMatch !== "string") {
    return { kind: "protocol_error", reason: "client_match_invalid" };
  }
  // `unregistered` next to registered=true contradicts itself; `unknown` means
  // the server holds no client key for the record. Neither proves ownership.
  return {
    kind: "protocol_error",
    reason: `client_match_${clientMatch.replace(/[^a-z_]/gi, "").slice(0, 24) || "invalid"}`,
  };
}

/**
 * One redacted support line for a refused restore: decision and short
 * fingerprints only, never the credential id, keys or PRF material.
 */
export function restoreClientMatchDiagnostic(
  decision: RestoreClientMatchDecision,
  recovery: ArkadeRecoveryStatus | null | undefined,
  clientPk33Hex: string,
): string {
  const reason = decision.kind === "protocol_error" ? `:${decision.reason}` : "";
  const fingerprint = (recovery?.passkey_pubkey_fingerprint ?? "").slice(0, 8) || "none";
  const clientTail = clientPk33Hex.length >= 8 ? clientPk33Hex.slice(-8) : "none";
  return `restore_gate=${decision.kind}${reason} passkey_fp=${fingerprint} client_pk_tail=${clientTail}`;
}
