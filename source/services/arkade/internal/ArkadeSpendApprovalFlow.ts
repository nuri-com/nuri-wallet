// Owns the outgoing-spend approval lifecycle (arm / clear / ensure /
// requestApproved*). Identity delegates to this sister class to keep
// ArkadeRemoteIdentity focused on key derivation and SDK Identity wiring.
import { AppState } from "react-native";
import { paymentTimed, paymentTimingMark } from "../../../lib/paymentTiming";
import { ArkAddress } from "@arkade-os/sdk";
import * as btc from "@scure/btc-signer";
import { base64 } from "@scure/base";
import { WEBAUTHN_RP_ID } from "../../../config/constants";
import { bytesToHex } from "../../../lib/bytes";
import { shortTime } from "../../../lib/logShared";
import {
  arkadeSwapIntentCreate,
  arkadeApiSendCosign,
  arkadeApiSendComplete,
  arkadeApiSendPrepare,
  type ArkadeAuthResponse,
  type ArkadeSignResponse,
} from "../ArkadeApiService";
import {
  logArkadeWalletErrorTrace,
  logArkadeWalletSignTrace as logArkadeSignTrace,
} from "./logging";
import type { AssertionCache } from "./assertionCache";
import type { SignerHttpClient } from "./signerHttpClient";
import type { SigningKeyVault } from "./signingKeyVault";
import {
  type ArkadeSpendApprovalRequest,
  type ArkadeSpendApprovalScope,
  type NativeApiSpendApproval,
  type PendingSpendApproval,
  approvalKindSetCovers,
  approvalRequestSetCovers,
  collectApprovalRequestKinds,
  formatApprovalKinds,
  makeApprovalRequestKey,
} from "./spendApproval";

// How long a valueless delete proof waits for the register proof to bind the
// session before the send is failed as missing its intent.
const REGISTER_INTENT_WAIT_MS = 20_000;
const REGISTER_INTENT_POLL_MS = 150;
// How long the valueless proof gives the valued one to open the session.
const VALUED_SESSION_OPEN_WAIT_MS = 20_000;
const VALUED_SESSION_OPEN_POLL_MS = 50;
// How long the joining proof waits for the session's own proof to be cosigned.
const SESSION_COSIGN_WAIT_MS = 60_000;
const SESSION_COSIGN_POLL_MS = 50;

const NATIVE_API_APPROVAL_TOKEN_PREFIX = "native-api:";

type CredentialMeta = {
  credIdB64u: string;
  credPubkeyB64u?: string;
  clientPk33: string;
};

type PublicContext = {
  clientPk33: string;
  /** The cosigner key the tree round checks every server response against. */
  serverPk33?: string;
};

export type SpendApprovalFlowDeps = {
  httpClient: SignerHttpClient;
  assertionCache: AssertionCache;
  signingKeyVault: SigningKeyVault;
  getCredentialMeta: () => CredentialMeta;
  getPublicContext: () => Promise<PublicContext>;
};

export type ArmSpendApprovalSummary = {
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
  /** Runs once, after the first transaction signed under this approval and
   * before it is returned to the SDK for submission: the real irreversible
   * boundary. Gets the signed tx id. A throw here stops the send before
   * anything is submitted. */
  onSigned?: (txid: string) => void | Promise<void>;
};

function shortRef(value: string, head = 8, tail = 4): string {
  const raw = String(value || "").trim();
  if (!raw) return "n/a";
  if (tail <= 0) {
    return raw.length <= head ? raw : `${raw.slice(0, head)}...`;
  }
  if (raw.length <= head + tail + 3) return raw;
  return `${raw.slice(0, head)}...${raw.slice(-tail)}`;
}

function nativeApiApprovalToken(challengeToken: string): string {
  return `${NATIVE_API_APPROVAL_TOKEN_PREFIX}${challengeToken}`;
}

function nativeApiChallengeToken(approvalToken: string): string | null {
  const raw = String(approvalToken || "").trim();
  if (!raw.startsWith(NATIVE_API_APPROVAL_TOKEN_PREFIX)) return null;
  const token = raw.slice(NATIVE_API_APPROVAL_TOKEN_PREFIX.length).trim();
  return token || null;
}

/**
 * The output the spend actually creates, matched by script.
 *
 * Accepts an Ark address (offchain settle) or a Bitcoin address (collaborative
 * exit — the offboard settles straight into an on-chain output). Reading script
 * and amount off the PSBT is the point: the server validates the intent against
 * this exact output, so anything derived from client-side assumptions drifts.
 * The offboard in particular deducts its fee FROM the requested amount, so the
 * output is never the number the user typed.
 */
/**
 * Every output the PSBT pays, rendered the way the arkade server renders them
 * when it validates a swap intent. Diagnostic only.
 */
/**
 * True when the PSBT pays at least one real output. The delete-intent proof the
 * SDK signs alongside every settle has none (a single 0-sat OP_RETURN), which is
 * how it is told apart from the register proof that carries the destination.
 */
export function hasSpendableOutputs(psbtB64: string): boolean {
  let tx: btc.Transaction;
  try {
    tx = btc.Transaction.fromPSBT(base64.decode(psbtB64));
  } catch {
    return false;
  }
  for (let i = 0; i < tx.outputsLength; i += 1) {
    const output = tx.getOutput(i) as { amount?: unknown } | null;
    if (typeof output?.amount === "bigint" && output.amount > 0n) return true;
  }
  return false;
}

function summarizePsbtOutputsForLog(psbtB64: string): string {
  let tx: btc.Transaction;
  try {
    tx = btc.Transaction.fromPSBT(base64.decode(psbtB64));
  } catch {
    return "unparseable";
  }
  const rows: string[] = [];
  for (let i = 0; i < tx.outputsLength; i += 1) {
    const output = tx.getOutput(i) as { amount?: unknown; script?: Uint8Array } | null;
    const amount = typeof output?.amount === "bigint" ? Number(output.amount) : -1;
    let address = "?";
    try {
      if (output?.script) address = btc.Address().encode(btc.OutScript.decode(output.script));
    } catch {}
    rows.push(`${i}:${address}=${amount}`);
  }
  return rows.join(" ") || "none";
}

export function findPsbtOutputForAddress(
  psbtB64: string,
  address: string,
): { amountSats: number; scriptHex: string } | null {
  const normalizedAddress = String(address || "").trim();
  if (!normalizedAddress) return null;
  let expectedScriptHex = "";
  try {
    expectedScriptHex = bytesToHex(ArkAddress.decode(normalizedAddress).pkScript).toLowerCase();
  } catch {
    try {
      expectedScriptHex = bytesToHex(
        btc.OutScript.encode(btc.Address().decode(normalizedAddress)),
      ).toLowerCase();
    } catch {
      return null;
    }
  }
  let tx: btc.Transaction;
  try {
    tx = btc.Transaction.fromPSBT(base64.decode(psbtB64));
  } catch {
    return null;
  }

  let best: { amountSats: number; scriptHex: string } | null = null;
  for (let i = 0; i < tx.outputsLength; i += 1) {
    const output = tx.getOutput(i) as { amount?: unknown; script?: Uint8Array } | null;
    const amount = output?.amount;
    const scriptHex = output?.script ? bytesToHex(output.script).toLowerCase() : "";
    if (scriptHex !== expectedScriptHex || typeof amount !== "bigint") continue;
    const amountSats = Number(amount);
    if (!Number.isSafeInteger(amountSats) || amountSats <= 0) continue;
    if (!best || amountSats > best.amountSats) {
      best = { amountSats, scriptHex };
    }
  }
  return best;
}

export class ArkadeSpendApprovalFlow {
  private pendingSpendApproval: PendingSpendApproval | null = null;
  /** The armed approval's onSigned, until it has run once. */
  private onSigned: {
    approvalId: number;
    run: NonNullable<ArmSpendApprovalSummary["onSigned"]>;
  } | null = null;
  private nextSpendApprovalId = 1;

  constructor(private readonly deps: SpendApprovalFlowDeps) {}

  hasActive(): boolean {
    return this.pendingSpendApproval !== null;
  }

  /** Hand out the active approval's onSigned exactly once. */
  takeOnSigned(): NonNullable<ArmSpendApprovalSummary["onSigned"]> | null {
    const hook = this.onSigned;
    if (!hook || hook.approvalId !== this.pendingSpendApproval?.id) return null;
    this.onSigned = null;
    return hook.run;
  }

  getPendingForHttp(): { state: string | null; approvalScope: ArkadeSpendApprovalScope } | null {
    if (!this.pendingSpendApproval) return null;
    return {
      state: this.pendingSpendApproval.state,
      approvalScope: this.pendingSpendApproval.approvalScope,
    };
  }

  arm(summary: ArmSpendApprovalSummary): number {
    const approvalScope =
      summary.approvalScope === "direct_session"
        ? "direct_session"
        : summary.approvalScope === "exact"
          ? "exact"
          : "direct_send_session";
    const id = this.nextSpendApprovalId;
    this.nextSpendApprovalId += 1;
    this.pendingSpendApproval = {
      id,
      summary: {
        kind: String(summary.kind || "outgoing").trim() || "outgoing",
        title: String(summary.title || "Approve Arkade Spend").trim() || "Approve Arkade Spend",
        recipient: String(summary.recipient || "").trim() || undefined,
        amountSats:
          typeof summary.amountSats === "number" && Number.isFinite(summary.amountSats)
            ? Math.max(0, Math.trunc(summary.amountSats))
            : undefined,
        note: String(summary.note || "").trim() || undefined,
        source: String(summary.source || "debug_arkade").trim() || "debug_arkade",
        approvalScope,
        finalAmountSats:
          typeof summary.finalAmountSats === "number" && Number.isFinite(summary.finalAmountSats)
            ? Math.max(0, Math.trunc(summary.finalAmountSats))
            : undefined,
        paymentHash: String(summary.paymentHash || "").trim() || undefined,
        psbtB64: summary.psbtB64 || undefined,
        swapIntentId: summary.swapIntentId || undefined,
      },
      approvalToken: null,
      nativeApiApproval: null,
      authenticatedAtMs: null,
      approvedRequestKinds: new Set(),
      approvedRequestKeys: new Set(),
      approvalInFlight: null,
      approvalInFlightKinds: null,
      state: null,
      approvalScope,
      psbtB64: summary.psbtB64 || null,
    };
    this.onSigned = summary.onSigned ? { approvalId: id, run: summary.onSigned } : null;
    console.log(
      `🔐 [${shortTime()} ArkadeRemoteIdentity.spendApproval] action=arm id=${id} kind=${this.pendingSpendApproval.summary.kind} title=${this.pendingSpendApproval.summary.title} scope=${approvalScope}`,
    );
    return id;
  }

  clear(reason = "cleared", approvalId?: number): void {
    if (
      approvalId != null &&
      this.pendingSpendApproval &&
      this.pendingSpendApproval.id !== approvalId
    ) {
      logArkadeSignTrace("approval_clear_skipped", {
        reason,
        approval_id: approvalId,
        active_id: this.pendingSpendApproval.id,
        expected_next: "keep_active_approval_cache",
      });
      return;
    }
    if (this.pendingSpendApproval) {
      const id = this.pendingSpendApproval.id;
      this.pendingSpendApproval = null;
      console.log(
        `🔐 [${shortTime()} ArkadeRemoteIdentity.spendApproval] action=clear id=${id} reason=${reason}`,
      );
    }
    this.deps.signingKeyVault.clearSigningKeyCache(`approval_${reason}`);
  }

  async ensure(
    requests: ArkadeSpendApprovalRequest[],
    psbtB64?: string | null,
  ): Promise<string | null> {
    const pending = this.pendingSpendApproval;
    if (!pending) {
      logArkadeSignTrace("approval_not_required", {
        requests: requests.length,
        expected_next: "sign_with_assertion_or_plain_flow",
      });
      return null;
    }
    if (!requests.length) {
      throw new Error("outgoing spend approval requires sign requests");
    }
    const requestedKinds = collectApprovalRequestKinds(requests);
    // A settle signs in rounds, and only the first one is knowable in advance.
    // The register and delete proofs are approved up front; then the batch tree
    // arrives (after the intent is registered), then the forfeit transaction
    // (after the tree is signed). Both come with messages that could not have
    // been in the approved set, because the batch they belong to did not exist
    // when the user approved.
    //
    // They ride the session the user did approve, and the server is what binds
    // them: a tree round only signs messages it re-derives from a commitment
    // paying this intent's destination, and a direct follow-up is checked
    // against the same unconsumed intent. Refusing them here only breaks the
    // send — it does not make the signature safer.
    const isNativeSendSessionRound = Boolean(pending.nativeApiApproval);
    if (pending.approvalToken) {
      const tokenCoversRequest =
        isNativeSendSessionRound ||
        (pending.approvalScope === "direct_session" ||
        pending.approvalScope === "direct_send_session"
          ? approvalKindSetCovers(
              pending.approvedRequestKinds,
              requestedKinds,
              pending.approvalScope,
            )
          : approvalRequestSetCovers(pending.approvedRequestKeys, requests));
      if (!tokenCoversRequest) {
        logArkadeSignTrace("approval_token_request_mismatch", {
          approval_id: pending.id,
          scope: pending.approvalScope,
          requested_kinds: formatApprovalKinds(requestedKinds),
          approved_kinds: formatApprovalKinds(pending.approvedRequestKinds),
          requests: requests.length,
          approved_requests: pending.approvedRequestKeys.size,
          expected_next:
            pending.approvalScope === "exact"
              ? "clear_stale_exact_token_and_use_cached_assertion"
              : "request_new_approval_token",
        });
        if (pending.approvalScope === "exact") {
          const approvalId = pending.id;
          logArkadeSignTrace("native_v5_exact_request_mismatch_blocked", {
            approval_id: approvalId,
            requests: requests.length,
            expected_next: "surface_multi_sign_contract_error",
          });
          throw new Error("native v5 send approval does not cover additional signing request");
        }
        pending.approvalToken = null;
        pending.nativeApiApproval = null;
        pending.approvedRequestKinds.clear();
        pending.approvedRequestKeys.clear();
        pending.state = null;
      } else {
        console.log(
          `🔐 [${shortTime()} ArkadeRemoteIdentity.spendApproval] action=reuseApprovalToken id=${pending.id} appState=${AppState.currentState}`,
        );
        logArkadeSignTrace("approval_token_reused", {
          approval_id: pending.id,
          scope: pending.approvalScope,
          requests: requests.length,
          request_kinds: formatApprovalKinds(requestedKinds),
          approved_kinds: formatApprovalKinds(pending.approvedRequestKinds),
          approved_requests: pending.approvedRequestKeys.size,
          coverage:
            pending.approvalScope === "direct_session" ||
            pending.approvalScope === "direct_send_session"
              ? "kind_session"
              : "exact_requests",
          app_state: AppState.currentState,
          expected_next: "sdk_calls_approved_sign",
        });
        return pending.approvalToken;
      }
    }
    if (pending.approvalInFlight) {
      if (
        approvalKindSetCovers(pending.approvalInFlightKinds, requestedKinds, pending.approvalScope)
      ) {
        logArkadeSignTrace("approval_inflight_wait", {
          approval_id: pending.id,
          scope: pending.approvalScope,
          requests: requests.length,
          request_kinds: formatApprovalKinds(requestedKinds),
          inflight_kinds: formatApprovalKinds(pending.approvalInFlightKinds || []),
          state: shortRef(pending.state || "pending", 8, 0),
          app_state: AppState.currentState,
          expected_next: "reuse_single_browser_approval",
        });
        return pending.approvalInFlight;
      }
      logArkadeSignTrace("approval_inflight_kind_mismatch", {
        approval_id: pending.id,
        scope: pending.approvalScope,
        requests: requests.length,
        request_kinds: formatApprovalKinds(requestedKinds),
        inflight_kinds: formatApprovalKinds(pending.approvalInFlightKinds || []),
        state: shortRef(pending.state || "pending", 8, 0),
        app_state: AppState.currentState,
        expected_next: "wait_then_request_new_approval_token",
      });
      await pending.approvalInFlight.catch((_error: unknown): null => null);
      return this.ensure(requests, psbtB64);
    }
    logArkadeSignTrace("approval_prf_prewarm_skipped", {
      approval_id: pending.id,
      requests: requests.length,
      request_kinds: formatApprovalKinds(requestedKinds),
      expected_next: "native_v5_prepare_without_browser",
    });
    const approvalInFlight = this.createNativeApiSpendApproval(pending, requests, psbtB64);
    pending.approvalInFlight = approvalInFlight;
    pending.approvalInFlightKinds = new Set(requestedKinds);
    logArkadeSignTrace("approval_inflight_created", {
      approval_id: pending.id,
      requests: requests.length,
      request_kinds: formatApprovalKinds(requestedKinds),
      expected_next: "join_concurrent_sign_requests",
    });
    try {
      return await approvalInFlight;
    } finally {
      if (this.pendingSpendApproval === pending && pending.approvalInFlight === approvalInFlight) {
        pending.approvalInFlight = null;
        pending.approvalInFlightKinds = null;
      }
    }
  }

  getNativeApiCombinedAssertionAuth(
    approvalToken: string | null | undefined,
  ): ArkadeAuthResponse | null {
    const approval = this.getNativeApiApproval(approvalToken);
    if (!approval) return null;
    return {
      token: approval.challengeToken,
      challenge: approval.challenge,
      rp_id: approval.rpId,
      origin: approval.origin,
    };
  }

  async completeNativeApiSend(txid?: string): Promise<void> {
    const approval = this.pendingSpendApproval?.nativeApiApproval;
    if (!approval) return;
    await arkadeApiSendComplete({
      challenge_token: approval.challengeToken,
      send_intent_id: approval.sendIntentId,
      txid,
    });
    logArkadeSignTrace("native_v5_send_complete_ok", {
      intent: shortRef(approval.sendIntentId, 12, 6),
      challenge: shortRef(approval.challengeToken, 8, 4),
      txid: shortRef(String(txid || ""), 12, 8),
      expected_next: "clear_native_send_session",
    });
  }

  markNativeApiSendAuthenticated(approvalToken: string | null | undefined): {
    id: number;
    kind: string;
    recipient?: string;
    amountSats?: number;
    finalAmountSats?: number;
    paymentHash?: string;
  } | null {
    const approval = this.getNativeApiApproval(approvalToken);
    const pending = this.pendingSpendApproval;
    if (!approval || !pending || pending.authenticatedAtMs) return null;
    pending.authenticatedAtMs = Date.now();
    logArkadeSignTrace("native_v5_send_authenticated", {
      approval_id: pending.id,
      kind: pending.summary.kind,
      amount_sats: pending.summary.amountSats ?? "n/a",
      expected_next: "ui_closes_send_modal_before_final_txid",
    });
    return {
      id: pending.id,
      kind: pending.summary.kind,
      recipient: pending.summary.recipient,
      amountSats: pending.summary.amountSats,
      finalAmountSats: pending.summary.finalAmountSats,
      paymentHash: pending.summary.paymentHash,
    };
  }

  async prepareAndEnsure(
    txPsbtB64: string,
    clientPk33: string,
    requests: ArkadeSpendApprovalRequest[],
  ): Promise<string | null> {
    const pending = this.pendingSpendApproval;
    if (!pending) {
      throw new Error("prepareAndEnsure called without an active pending approval");
    }
    pending.psbtB64 = txPsbtB64;
    console.log(
      `🔐 [${shortTime()} ArkadeRemoteIdentity.prepareAndEnsure] psbt=${txPsbtB64.slice(0, 16)} valued=${hasSpendableOutputs(txPsbtB64) ? 1 : 0} msgs=${requests.map((r) => String(r?.msg32 || "").slice(0, 12)).join(",") || "none"}`,
    );
    // Remember which PSBT each request belongs to, so its signature is submitted
    // with that PSBT rather than whichever one happened to open the session.
    if (!pending.psbtByMsg32) pending.psbtByMsg32 = new Map<string, string>();
    for (const request of requests) {
      const msg32 = String(request?.msg32 || "").trim();
      if (msg32) pending.psbtByMsg32.set(msg32, txPsbtB64);
    }
    if (pending.approvalScope === "direct_send_session" && pending.nativeApiApproval) {
      // The session package keeps the PSBT `prepare` was bound to — overwriting
      // it here would make the first cosign re-derive a digest the server never
      // prepared. The later proof rides `psbtByMsg32` into a follow-up instead.
      logArkadeSignTrace("native_v5_send_session_psbt_recorded", {
        approval_id: pending.id,
        challenge: shortRef(pending.nativeApiApproval.challengeToken, 8, 4),
        psbt: shortRef(txPsbtB64, 12, 6),
        requests: requests.length,
        expected_next: "reuse_passkey_assertion_for_current_psbt_cosign",
      });
    }
    await this.attachArkSettleIntentFromPsbt(pending, txPsbtB64, clientPk33);
    // The VALUED proof must be the one that opens the session. The server
    // fingerprints the PSBT presented at prepare and re-checks it on the first
    // cosign, and the valued proof is always the first to be signed — but it is
    // also the slower one to arrive here, because it creates the swap intent on
    // the way. Left alone, the valueless proof opens the session and the first
    // signature is then rejected against a fingerprint it can never match.
    if (!hasSpendableOutputs(txPsbtB64)) {
      await this.awaitValuedSessionOpen(pending);
    }
    const approvalToken = await this.ensure(requests, txPsbtB64);
    // Whichever proof opens the session is always the one the SDK signs SECOND
    // — the other proof joins the in-flight approval and resumes first. Since
    // the server checks its prepared fingerprint against the first cosign, hold
    // the joiner here, before it starts signing: the per-signature lock is taken
    // inside the sign loop, so waiting any later deadlocks the two proofs.
    const sessionPsbtB64 = String(pending.nativeApiApproval?.sendPackage.psbt_b64 || "").trim();
    if (sessionPsbtB64 && sessionPsbtB64 !== txPsbtB64) {
      await this.awaitSessionCosignAccepted(pending);
    }
    return approvalToken;
  }

  async requestApprovedSign(
    approvalToken: string,
    payload: {
      msg32: string;
      client_pk33: string;
      client_pub_nonce: string;
      input_index?: number;
      tweak32?: string;
      outer_agg_nonce66?: string;
      outer_pubkeys33?: string[];
    },
  ): Promise<ArkadeSignResponse> {
    console.log(
      `🔐 [${shortTime()} ArkadeRemoteIdentity.signApproved] action=request msg=${String(payload.msg32 || "").slice(0, 12)}... tweak=${payload.tweak32 ? 1 : 0} token=${approvalToken ? 1 : 0}`,
    );
    logArkadeSignTrace("approved_sign_request", {
      msg32: shortRef(String(payload.msg32 || ""), 10, 4),
      client_pk: shortRef(String(payload.client_pk33 || ""), 10, 4),
      input_index:
        typeof payload.input_index === "number" && Number.isInteger(payload.input_index)
          ? payload.input_index
          : "n/a",
      has_tweak: payload.tweak32 ? 1 : 0,
      has_outer_nonce: payload.outer_agg_nonce66 ? 1 : 0,
      outer_pubkeys: payload.outer_pubkeys33?.length || 0,
      token_present: approvalToken ? 1 : 0,
      expected_next: "server_returns_partial_signature",
    });
    const nativeApproval = this.getNativeApiApproval(approvalToken);
    if (nativeApproval) {
      const nativeAssertion = await this.getNativeApiSigningAssertion(approvalToken);
      if (!nativeAssertion) {
        throw new Error("native v5 send assertion missing for approval token");
      }
      // Submit the PSBT this request was prepared against, not the session's.
      const pending = this.pendingSpendApproval;
      const sessionPsbtB64 = String(nativeApproval.sendPackage.psbt_b64 || "").trim();
      const requestPsbtB64 =
        pending?.psbtByMsg32?.get(String(payload.msg32 || "").trim()) || sessionPsbtB64;
      // The session's own proof signs first (it is the one that opened the
      // session), so this never has to hold a request back — the other proof
      // arrives afterwards and the server validates it as a follow-up, against
      // the PSBT presented here rather than the prepared one.
      console.log(
        `🔐 [${shortTime()} ArkadeRemoteIdentity.cosignPsbt] msg=${String(payload.msg32 || "").slice(0, 12)} session_psbt=${sessionPsbtB64.slice(0, 16)} request_psbt=${requestPsbtB64.slice(0, 16)} same=${requestPsbtB64 === sessionPsbtB64 ? 1 : 0} mapped=${pending?.psbtByMsg32?.has(String(payload.msg32 || "").trim()) ? 1 : 0} map_size=${pending?.psbtByMsg32?.size ?? 0}`,
      );
      logArkadeSignTrace("native_v5_send_cosign_psbt", {
        approval_id: pending?.id ?? "n/a",
        msg32: shortRef(String(payload.msg32 || ""), 10, 4),
        session_psbt: shortRef(sessionPsbtB64, 10, 4),
        request_psbt: shortRef(requestPsbtB64, 10, 4),
        is_session_psbt: requestPsbtB64 === sessionPsbtB64 ? 1 : 0,
        expected_next: "server_cosigns_strict_or_followup",
      });
      const response = await arkadeApiSendCosign<ArkadeSignResponse>(
        nativeAssertion,
        nativeAssertion.token,
        {
          ...nativeApproval.sendPackage,
          ...(requestPsbtB64 ? { psbt_b64: requestPsbtB64 } : {}),
          assertion_cred_id_b64u: this.deps.getCredentialMeta().credIdB64u,
          cosign_requests: [payload],
        },
      );
      // The session is now past its prepared-fingerprint check, so the other
      // proof may go ahead as a follow-up.
      if (pending && requestPsbtB64 === sessionPsbtB64) pending.sessionCosignAccepted = true;
      return response;
    }
    return this.deps.httpClient.postSignerJson("signApproved", "/arkade/sign", {
      approval_token: approvalToken,
      ...payload,
    });
  }

  async requestApprovedTreeSessionInit(
    approvalToken: string,
    payload: {
      client_pk33: string;
      txids: string[];
      /** Batch material the server re-derives the tree's messages from. */
      commitment_tx_b64?: string;
      script_root?: string;
      tree_nodes?: Array<{ tx_b64: string }>;
    },
  ): Promise<{
    session_id: string;
    server_pubkey: string;
    server_version?: string;
    ttl_ms?: number;
  }> {
    console.log(
      `🔐 [${shortTime()} ArkadeRemoteIdentity.treeSessionApproved] action=request txids=${payload.txids.length} token=${approvalToken ? 1 : 0}`,
    );
    logArkadeSignTrace("approved_tree_session_request", {
      txids: payload.txids.length,
      sample_txid: shortRef(String(payload.txids[0] || ""), 10, 4),
      client_pk: shortRef(String(payload.client_pk33 || ""), 10, 4),
      token_present: approvalToken ? 1 : 0,
      expected_next: "server_returns_tree_session",
    });
    return this.deps.httpClient.postSignerJson(
      "treeSessionInitApproved",
      "/arkade/tree/session-init",
      {
        ...this.treeAuthFields(approvalToken),
        ...payload,
      },
    );
  }

  /**
   * How a tree call proves it may be made.
   *
   * A send approved through the native v5 flow has no approval token the tree
   * routes can verify — it has a send session. The batch tree only exists after
   * that session registered its intent, so the session is the authorization,
   * and the server checks it is passkey-verified, funded, unexpired, and still
   * holding an unconsumed intent. Everything else keeps sending its approval
   * token unchanged.
   */
  private treeAuthFields(approvalToken: string): Record<string, string> {
    const challengeToken = nativeApiChallengeToken(approvalToken);
    return challengeToken ? { challenge_token: challengeToken } : { approval_token: approvalToken };
  }

  async requestApprovedTreeNonce(
    approvalToken: string,
    payload: {
      session_id: string;
      txid: string;
      msg32: string;
      client_pk33: string;
      client_pub_nonce: string;
      tweak32?: string;
    },
  ): Promise<{
    txid: string;
    server_pub_nonce66: string;
    server_pubkey: string;
    server_version?: string;
  }> {
    console.log(
      `🔐 [${shortTime()} ArkadeRemoteIdentity.treeNonceApproved] action=request txid=${String(payload.txid || "").slice(0, 12)}... token=${approvalToken ? 1 : 0}`,
    );
    logArkadeSignTrace("approved_tree_nonce_request", {
      txid: shortRef(String(payload.txid || ""), 10, 4),
      msg32: shortRef(String(payload.msg32 || ""), 10, 4),
      client_pk: shortRef(String(payload.client_pk33 || ""), 10, 4),
      has_tweak: payload.tweak32 ? 1 : 0,
      token_present: approvalToken ? 1 : 0,
      expected_next: "server_returns_tree_nonce",
    });
    return this.deps.httpClient.postSignerJson("treeNonceApproved", "/arkade/tree/nonce", {
      ...this.treeAuthFields(approvalToken),
      ...payload,
    });
  }

  async requestApprovedTreeSign(
    approvalToken: string,
    payload: {
      session_id: string;
      txid: string;
      msg32: string;
      client_pk33: string;
      client_pub_nonce: string;
      tweak32?: string;
      outer_agg_nonce66?: string;
      outer_pubkeys33?: string[];
    },
  ): Promise<{
    txid: string;
    server_partial32: string;
    server_pub_nonce66: string;
    server_pubkey: string;
    server_version?: string;
  }> {
    console.log(
      `🔐 [${shortTime()} ArkadeRemoteIdentity.treeSignApproved] action=request txid=${String(payload.txid || "").slice(0, 12)}... token=${approvalToken ? 1 : 0}`,
    );
    logArkadeSignTrace("approved_tree_sign_request", {
      txid: shortRef(String(payload.txid || ""), 10, 4),
      msg32: shortRef(String(payload.msg32 || ""), 10, 4),
      client_pk: shortRef(String(payload.client_pk33 || ""), 10, 4),
      has_tweak: payload.tweak32 ? 1 : 0,
      has_outer_nonce: payload.outer_agg_nonce66 ? 1 : 0,
      outer_pubkeys: payload.outer_pubkeys33?.length || 0,
      token_present: approvalToken ? 1 : 0,
      expected_next: "server_returns_tree_partial_signature",
    });
    return this.deps.httpClient.postSignerJson("treeSignApproved", "/arkade/tree/sign", {
      ...this.treeAuthFields(approvalToken),
      ...payload,
    });
  }

  private getNativeApiApproval(
    approvalToken: string | null | undefined,
  ): NativeApiSpendApproval | null {
    const challengeToken = nativeApiChallengeToken(String(approvalToken || ""));
    if (!challengeToken) return null;
    const approval = this.pendingSpendApproval?.nativeApiApproval;
    if (!approval || approval.challengeToken !== challengeToken) return null;
    return approval;
  }

  private async getNativeApiSigningAssertion(approvalToken: string): Promise<{
    token: string;
    clientDataB64u: string;
    authDataB64u: string;
    sigB64u: string;
  } | null> {
    const challengeToken = nativeApiChallengeToken(approvalToken);
    if (!challengeToken) return null;
    const meta = this.deps.getCredentialMeta();
    const cached = await this.deps.assertionCache.getCachedAssertion(meta);
    if (!cached || cached.token !== challengeToken) {
      throw new Error("native v5 send assertion missing for prepared challenge");
    }
    if (!this.deps.assertionCache.isPrfAssertion(cached)) {
      throw new Error("native v5 send requires combined PRF assertion");
    }
    return this.deps.assertionCache.toSigningAssertionPayload(cached);
  }

  private async createNativeApiSpendApproval(
    pending: PendingSpendApproval,
    requests: ArkadeSpendApprovalRequest[],
    sessionPsbtB64?: string | null,
  ): Promise<string | null> {
    const requestKinds = collectApprovalRequestKinds(requests);
    const requestSummary = requests
      .slice(0, 5)
      .map((request) =>
        [
          String(request.kind || "n/a"),
          shortRef(String(request.txid || "no_txid"), 8, 4),
          shortRef(String(request.msg32 || "no_msg"), 8, 4),
          request.tweak32 ? "tweak=1" : "tweak=0",
        ].join(":"),
      )
      .join(",");
    logArkadeSignTrace("native_v5_send_prepare_start", {
      approval_id: pending.id,
      requests: requests.length,
      request_kinds: formatApprovalKinds(requestKinds),
      summary_kind: pending.summary.kind,
      scope: pending.approvalScope,
      request_sample: requestSummary || "n/a",
      app_state: AppState.currentState,
      expected_next: "post_v5_send_prepare",
    });

    paymentTimingMark("SDK built the transaction, approval signing starts");
    const meta = this.deps.getCredentialMeta();
    const pubCtx = await paymentTimed("signing context", () => this.deps.getPublicContext());
    let sendIntentId = pending.summary.swapIntentId || null;
    // The session belongs to the proof that OPENS it, never to whichever one
    // last touched `pending.psbtB64` — the two proofs reach this class
    // concurrently, so that field is already the other one by the time the
    // prepare fires, and the server then binds its digest to a PSBT whose
    // signature is requested second.
    const psbtB64 = sessionPsbtB64 || pending.psbtB64 || pending.summary.psbtB64 || null;
    // `settle()` signs a register proof and a valueless delete proof
    // concurrently. Only the register proof carries a destination, so only it
    // can attach the swap intent — but the delete proof can reach here first and
    // has no id of its own. Wait for the register proof to bind the session
    // rather than failing the send on that race; the session id is what both
    // proofs must share.
    if (!sendIntentId && psbtB64 && !hasSpendableOutputs(psbtB64)) {
      sendIntentId = await this.awaitRegisterIntentId(pending);
    }
    if (requestKinds.some((kind) => kind !== "direct")) {
      throw new Error("native v5 send only supports direct swap signing");
    }
    if (requestKinds.includes("direct") && !sendIntentId) {
      throw new Error("direct native v5 send requires send_intent_id");
    }
    if (requestKinds.includes("direct") && !psbtB64) {
      throw new Error("direct native v5 send requires psbt_b64");
    }

    console.log(
      `🔐 [${shortTime()} ArkadeRemoteIdentity.sessionOpen] psbt=${String(psbtB64 || "").slice(0, 16)} pinned=${sessionPsbtB64 ? 1 : 0} valued=${psbtB64 && hasSpendableOutputs(psbtB64) ? 1 : 0} msgs=${requests.map((r) => String(r?.msg32 || "").slice(0, 12)).join(",") || "none"}`,
    );
    const approvalSummary = {
      kind: pending.summary.kind,
      title: pending.summary.title,
      recipient: pending.summary.recipient,
      amount_sats: pending.summary.amountSats,
      note: pending.summary.note,
      source: pending.summary.source,
      final_amount_sats: pending.summary.finalAmountSats,
      payment_hash: pending.summary.paymentHash,
    };
    const routeScope = "direct_send_session";
    const sendPackage = {
      cred_id_b64u: meta.credIdB64u,
      client_signer_pubkey: pubCtx.clientPk33,
      route_scope: routeScope,
      approval_summary: approvalSummary,
      approval_scope: routeScope,
      psbt_b64: psbtB64,
      send_intent_id: sendIntentId,
    };

    const prepared = await paymentTimed("nuri send prepare", () =>
      arkadeApiSendPrepare(sendPackage),
    );

    const challengeToken = String(prepared.challenge_token || "").trim();
    const challenge = String(prepared.challenge || "").trim();
    if (!challengeToken || !challenge) {
      throw new Error("native v5 send prepare missing challenge");
    }
    const rpId = String(prepared.rp_id || WEBAUTHN_RP_ID).trim() || WEBAUTHN_RP_ID;
    const approvalToken = nativeApiApprovalToken(challengeToken);
    pending.approvalToken = approvalToken;
    pending.nativeApiApproval = {
      challengeToken,
      challenge,
      rpId,
      origin: String(prepared.origin || "").trim() || undefined,
      expiresAtMs:
        typeof prepared.expires_at_ms === "number" && Number.isFinite(prepared.expires_at_ms)
          ? prepared.expires_at_ms
          : undefined,
      canonicalSendSummary:
        prepared.canonical_send_summary &&
        typeof prepared.canonical_send_summary === "object" &&
        !Array.isArray(prepared.canonical_send_summary)
          ? prepared.canonical_send_summary
          : undefined,
      sendPackage,
      sendIntentId,
    };
    pending.approvedRequestKinds = new Set(requestKinds);
    pending.approvedRequestKeys = new Set(requests.map(makeApprovalRequestKey));
    pending.state = challengeToken;
    logArkadeSignTrace("native_v5_send_prepare_ready", {
      approval_id: pending.id,
      challenge: shortRef(challengeToken, 8, 4),
      rp_id: rpId,
      approved_kinds: formatApprovalKinds(pending.approvedRequestKinds),
      approved_requests: pending.approvedRequestKeys.size,
      app_state: AppState.currentState,
      expected_next: "native_passkey_prf_assertion_then_v5_cosign",
    });
    return approvalToken;
  }

  /**
   * Hold the joining proof until the session's own proof has been cosigned.
   *
   * Bounded and non-throwing: if that cosign never lands the send has already
   * failed on its own error, and replacing it with a timeout here would only
   * hide it.
   */
  private async awaitSessionCosignAccepted(pending: PendingSpendApproval): Promise<void> {
    const deadline = Date.now() + SESSION_COSIGN_WAIT_MS;
    while (!pending.sessionCosignAccepted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, SESSION_COSIGN_POLL_MS));
    }
    console.log(
      `🔐 [${shortTime()} ArkadeRemoteIdentity.followupRelease] session_cosigned=${pending.sessionCosignAccepted ? 1 : 0}`,
    );
    logArkadeSignTrace("native_v5_followup_proof_released", {
      approval_id: pending.id,
      session_cosign_accepted: pending.sessionCosignAccepted ? 1 : 0,
      expected_next: "sign_followup_proof_against_its_own_psbt",
    });
  }

  /**
   * Hold a valueless proof back until the valued one has opened the session.
   *
   * Bounded and non-throwing: if the valued proof never arrives, opening the
   * session here is still better than failing the send outright, and the server
   * validates that case on its own (a valueless-opened session binds its valued
   * follow-ups instead).
   */
  private async awaitValuedSessionOpen(pending: PendingSpendApproval): Promise<void> {
    const deadline = Date.now() + VALUED_SESSION_OPEN_WAIT_MS;
    while (!pending.approvalToken && !pending.approvalInFlight && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, VALUED_SESSION_OPEN_POLL_MS));
    }
    logArkadeSignTrace("native_v5_valueless_proof_released", {
      approval_id: pending.id,
      opened_by_valued_proof: pending.approvalToken || pending.approvalInFlight ? 1 : 0,
      expected_next: "join_session_opened_by_valued_proof",
    });
  }

  /**
   * Wait for the register proof to publish this session's swap intent id.
   *
   * Bounded: a settle that never produces a register proof must fail rather
   * than hang, and the existing `send_intent_id` guard below is what reports it.
   */
  private async awaitRegisterIntentId(pending: PendingSpendApproval): Promise<string | null> {
    const deadline = Date.now() + REGISTER_INTENT_WAIT_MS;
    while (Date.now() < deadline) {
      if (pending.summary.swapIntentId) return pending.summary.swapIntentId;
      await new Promise((resolve) => setTimeout(resolve, REGISTER_INTENT_POLL_MS));
    }
    logArkadeWalletErrorTrace("swap_intent_register_proof_timeout", {
      approval_id: pending.id,
      kind: pending.summary.kind,
      waited_ms: REGISTER_INTENT_WAIT_MS,
      expected_next: "surface_missing_send_intent_id",
    });
    return pending.summary.swapIntentId || null;
  }

  private async attachArkSettleIntentFromPsbt(
    pending: PendingSpendApproval,
    psbtB64: string,
    clientPk33: string,
  ): Promise<void> {
    const settleKinds = ["arkade_settle", "bitcoin_offboard"];
    if (!settleKinds.includes(pending.summary.kind) || pending.summary.swapIntentId) {
      return;
    }
    const recipient = String(pending.summary.recipient || "").trim();
    const target = findPsbtOutputForAddress(psbtB64, recipient);
    if (!target) {
      // `settle()` signs TWO proofs concurrently: a register intent, whose
      // outputs include the destination, and a delete intent created with no
      // outputs at all (SDK: Intent.create(message, coins, []) — one 0-sat
      // OP_RETURN). Either can reach this hook first. A proof without the
      // recipient is the delete one, so skip it and let the register proof
      // attach the intent — throwing here failed the whole send on a race.
      if (!hasSpendableOutputs(psbtB64)) {
        logArkadeSignTrace("swap_intent_skipped_non_register_proof", {
          approval_id: pending.id,
          kind: pending.summary.kind,
          expected_next: "await_register_intent_proof",
        });
        return;
      }
      // Dump what the PSBT actually pays, encoded the same way the server does
      // (arkade-psbt-summary.js: Address().encode(OutScript.decode(script))), so
      // the mismatch can be read off directly instead of inferred. The server
      // requires an output matching the intent's amount AND address/script
      // (ArkadeSwapIntent.js#hasFundingOutput), so if the recipient is absent
      // here it is absent for the server too.
      // Error level on purpose: logArkadeWalletSignTrace writes via traceLog.trace,
      // which the default console filters out — the diagnostic was invisible.
      logArkadeWalletErrorTrace("swap_intent_funding_output_missing", {
        approval_id: pending.id,
        kind: pending.summary.kind,
        recipient: shortRef(recipient, 12, 6),
        outputs: summarizePsbtOutputsForLog(psbtB64),
        expected_next: "compare_against_server_hasFundingOutput",
      });
      throw new Error(`${pending.summary.kind} PSBT missing recipient output`);
    }
    const meta = this.deps.getCredentialMeta();
    const response = await arkadeSwapIntentCreate(null, {
      kind: pending.summary.kind === "bitcoin_offboard" ? "btc_onchain" : "ark_settle",
      cred_id_b64u: meta.credIdB64u,
      client_signer_pubkey: clientPk33,
      final_recipient: recipient,
      final_amount_sats: target.amountSats,
      funding_address: recipient,
      funding_script_hex: target.scriptHex,
      funding_amount_sats: target.amountSats,
    });
    const intentId = String(response.intent?.id || "").trim();
    if (!intentId) {
      throw new Error("arkade settle intent create returned empty id");
    }
    pending.summary.amountSats = target.amountSats;
    pending.summary.finalAmountSats = target.amountSats;
    pending.summary.swapIntentId = intentId;
    pending.summary.approvalScope = "exact";
    pending.approvalScope = "exact";
    pending.psbtB64 = psbtB64;
    logArkadeSignTrace("settle_intent_created", {
      approval_id: pending.id,
      intent: shortRef(intentId, 12, 6),
      amount_sats: target.amountSats,
      recipient: shortRef(recipient, 18, 8),
      expected_next: "v5_prepare_with_server_bound_settle_intent",
    });
  }
}
