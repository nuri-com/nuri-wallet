// Data shape + pure helpers for outgoing-spend approval flow.
// Consumed by ArkadeRemoteIdentity (and the upcoming ArkadeSpendApprovalFlow).
import { normalizeHex } from "../../../lib/bytes";

export type ArkadeSpendApprovalScope = "exact" | "direct_session" | "direct_send_session";

export type ArkadeSpendApprovalSummary = {
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
};

export type ArkadeSpendApprovalRequestKind = "direct" | "tree";

export type ArkadeSpendApprovalRequest = {
  kind: ArkadeSpendApprovalRequestKind;
  msg32: string;
  clientPk33: string;
  inputIndex?: number;
  tweak32?: string;
  txid?: string;
};

export type NativeApiSpendApproval = {
  challengeToken: string;
  challenge: string;
  rpId: string;
  origin?: string;
  expiresAtMs?: number;
  canonicalSendSummary?: Record<string, unknown>;
  sendPackage: Record<string, unknown>;
  sendIntentId: string;
};

export type PendingSpendApproval = {
  id: number;
  summary: ArkadeSpendApprovalSummary;
  approvalToken: string | null;
  nativeApiApproval: NativeApiSpendApproval | null;
  authenticatedAtMs: number | null;
  approvedRequestKinds: Set<ArkadeSpendApprovalRequestKind>;
  approvedRequestKeys: Set<string>;
  approvalInFlight: Promise<string | null> | null;
  approvalInFlightKinds: Set<ArkadeSpendApprovalRequestKind> | null;
  state: string | null;
  approvalScope: ArkadeSpendApprovalScope;
  psbtB64: string | null;
  /**
   * The PSBT each signing request belongs to, keyed by msg32.
   *
   * `settle()` signs two different PSBTs concurrently (a valueless delete proof
   * and the destination-bearing register proof) under ONE approval session. A
   * single session-level psbtB64 meant whichever proof arrived first pinned the
   * package, and the other signature was then submitted alongside a PSBT it does
   * not belong to — which the server now correctly rejects.
   */
  psbtByMsg32?: Map<string, string>;
  /**
   * Set once a cosign carrying the session's own PSBT has been accepted.
   *
   * The server re-checks the prepared fingerprint on the FIRST cosign, so the
   * proof that opened the session has to be signed before the other one. The
   * other proof waits on this flag — outside the per-signature lock, since
   * waiting while holding it is a deadlock.
   */
  sessionCosignAccepted?: boolean;
};

export function collectApprovalRequestKinds(
  requests: ArkadeSpendApprovalRequest[],
): ArkadeSpendApprovalRequestKind[] {
  return Array.from(new Set(requests.map((request) => request.kind))).sort();
}

export function approvalKindSetCovers(
  approved: Set<ArkadeSpendApprovalRequestKind> | null | undefined,
  requested: ArkadeSpendApprovalRequestKind[],
  approvalScope: ArkadeSpendApprovalScope = "exact",
): boolean {
  if (approvalScope === "direct_session" || approvalScope === "direct_send_session") {
    return requested.length > 0 && !!approved?.size;
  }
  return requested.length > 0 && requested.every((kind) => approved?.has(kind));
}

export function formatApprovalKinds(kinds: Iterable<ArkadeSpendApprovalRequestKind>): string {
  return Array.from(kinds).sort().join("|") || "none";
}

export function makeApprovalRequestKey(request: ArkadeSpendApprovalRequest): string {
  return [
    String(request.kind || "direct")
      .trim()
      .toLowerCase(),
    normalizeHex(request.txid || ""),
    normalizeHex(request.msg32 || ""),
    normalizeHex(request.clientPk33 || ""),
    normalizeHex(request.tweak32 || ""),
  ].join("|");
}

export function approvalRequestSetCovers(
  approved: Set<string> | null | undefined,
  requested: ArkadeSpendApprovalRequest[],
): boolean {
  return (
    requested.length > 0 &&
    requested.every((request) => approved?.has(makeApprovalRequestKey(request)))
  );
}
