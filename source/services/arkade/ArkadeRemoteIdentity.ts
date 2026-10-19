import * as btc from "@scure/btc-signer";
import * as musig2 from "@scure/btc-signer/musig2.js";
import { base64 } from "@scure/base";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { schnorr } from "@noble/curves/secp256k1";
import { type Identity, type SignRequest, type Transaction } from "@arkade-os/sdk";
import { assertHexLength, bytesToHex, hexToBytes, isHex, normalizeHex } from "../../lib/bytes";
import {
  appendTaprootSighash,
  computeTapTweak,
  getInputTapMerkleRoot,
  scriptContainsXOnlyPubkey,
} from "../../lib/bitcoin/taproot";
import { sha256, utf8ToBytes, zeroize } from "../../lib/crypto";
import { shortTime } from "../../lib/logShared";
import { authStateManager, type ArkadeSignerContext } from "../auth/AuthStateService";
import { EventBus } from "../events/AppEventBusService";
import {
  arkadeAuthBegin,
  arkadeBoardingSweepApprove,
  arkadeReceiveClaimApprove,
  arkadeRecoverableApprove,
  type ArkadeAuthResponse,
  type ArkadeReceiveOwner,
  type ArkadeCosignerDerivation,
  type ArkadeRelativeTimelock,
  type ArkadeRecoveryPolicy,
  type ArkadeRecoveryStatus,
} from "./ArkadeApiService";
import { arkadeServerConfigService } from "./ArkadeServerConfigService";
import {
  ARKADE_CLIENT_VERSION,
  ARKADE_EXPECTED_SIGNER_SERVER,
  ARKADE_STRICT_AGGREGATED_KEY_MATCH,
  NURI_SERVER_API_VERSION,
  formatArkadeVersionMatrix,
} from "./ArkadeVersion";
import { ArkadeRemoteSignerSession } from "./ArkadeRemoteSignerSession";
import { AssertionCache, type SigningAssertionPayload } from "./internal/assertionCache";
import { ArkadeSpendApprovalFlow } from "./internal/ArkadeSpendApprovalFlow";
import { emitArkadeReceiveUnlockProgress } from "./internal/receiveUpdatedEvents";
import { SignerHttpClient } from "./internal/signerHttpClient";
import { SigningKeyVault } from "./internal/signingKeyVault";
import {
  type ArkadeSpendApprovalRequest,
  approvalRequestSetCovers,
  makeApprovalRequestKey,
} from "./internal/spendApproval";

const ARKADE_SIGN_TRACE_MARKER = "ARKADE_SIGN_TRACE_V2_20260417";

type CredentialMeta = {
  credIdB64u: string;
  credPubkeyB64u?: string;
  clientPk33: string;
  storedArkadeSignerContext?: ArkadeSignerContext;
};

type PublicContext = {
  clientPk33: string;
  serverPk33: string;
  aggregatedPk33: string;
  aggregatedXonly32: string;
  serverVersion: string;
  tokenKeyFingerprint: string;
  nuriServerCsv: ArkadeRelativeTimelock | null;
  recoveryPolicy: ArkadeRecoveryPolicy | null;
  recovery: ArkadeRecoveryStatus | null;
  cosignerDerivation: ArkadeCosignerDerivation | null;
  passkeyPubkeyPolicy: string;
  recoveryBackupFormat: string;
  cosignerAccountFingerprint: string;
};

type ReceiveClaimApprovalState = {
  id: number;
  swapId: string;
  approvalToken: string | null;
  claimSessionToken: string | null;
  claimSessionExpiresAtMs: number | null;
  approvedRequestKeys: Set<string>;
  approvalInFlight: Promise<string | null> | null;
  combinedAssertionAuth: ArkadeAuthResponse | null;
  psbtB64: string | null;
};

export type ArkadeBoardingSweepApprovalContext = {
  selectedOutpoints: string[];
  selectedTotalSats: number;
};

type BoardingSweepApprovalState = ArkadeBoardingSweepApprovalContext & {
  id: number;
  approvalToken: string | null;
  boardingSweepSessionToken: string | null;
  boardingSweepSessionExpiresAtMs: number | null;
  approvedRequestKeys: Set<string>;
  approvalInFlight: Promise<string | null> | null;
  approvalInFlightRequestKeys: Set<string> | null;
  combinedAssertionAuth: ArkadeAuthResponse | null;
  psbtB64: string | null;
  scopedSignJobs: ArkadeDirectSignJob[];
  scopedSignTxFingerprint: string | null;
};

type RecoverableApprovalState = {
  id: number;
  approvalToken: string | null;
  recoverableSessionToken: string | null;
  recoverableSessionExpiresAtMs: number | null;
  approvedRequestKeys: Set<string>;
  approvalInFlight: Promise<string | null> | null;
  combinedAssertionAuth: ArkadeAuthResponse | null;
  psbtB64: string | null;
};

type ArkadeDirectSignJob =
  | Readonly<{
      path: "script";
      inputIndex: number;
      outpointKey: string;
      txFingerprint: string;
      sighashType: number;
      msg32: Uint8Array;
      request: ArkadeSpendApprovalRequest;
      leafScript: Uint8Array;
      leafVersion: number;
      leafHash: Uint8Array;
    }>
  | Readonly<{
      path: "key";
      inputIndex: number;
      outpointKey: string;
      txFingerprint: string;
      sighashType: number;
      msg32: Uint8Array;
      request: ArkadeSpendApprovalRequest;
      tweak32: Uint8Array;
    }>;

export type ArkadeIdentityReadiness = {
  readyForHardMode: boolean;
  readyForServerLossRecovery: boolean;
  softModeActive: boolean;
  passkeyPubkeyRequired: boolean;
  passkeyPubkeyMissingAllowed: boolean;
  hasPasskeyCredId: boolean;
  hasPasskeyCredPubkey: boolean;
  hasClientSignerPubkey: boolean;
  hasStoredServerPubkey: boolean;
  hasStoredAggregatedPubkey: boolean;
  hasStoredAggregatedXonly: boolean;
  hasNuriServerCsv: boolean;
  hasRecoveryPolicy: boolean;
  hasCosignerDerivation: boolean;
  hasServerRecoveryStatus: boolean;
  actualRecoveryProofStatus: "pass" | "fail" | "not_checked";
  actualRecoveryProofDetail: string;
  nuriServerCsv: ArkadeRelativeTimelock | null;
  signerUrl: string | null;
  passkeyPubkeyPolicy: string;
  serverPubkeyPreview: string | null;
  aggregatedPubkeyPreview: string | null;
  missing: string[];
  hardModeMissing: string[];
  serverLossRecoveryMissing: string[];
};

export type ArkadeActualRecoveryProofReadiness = {
  pass: boolean;
  status: "pass" | "fail" | "not_checked";
  detail: string;
};

let actualRecoveryProofReadinessProvider: (() => ArkadeActualRecoveryProofReadiness | null) | null =
  null;

export function setArkadeActualRecoveryProofReadinessProvider(
  provider: (() => ArkadeActualRecoveryProofReadiness | null) | null,
): void {
  actualRecoveryProofReadinessProvider = provider;
}

let sharedPublicContextCache: { key: string; context: PublicContext } | null = null;
let sharedPublicContextInFlight: { key: string; promise: Promise<PublicContext> } | null = null;

function normalizeSignerUrl(value: string): string {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "");
}

function normalizeNuriServerCsv(value: unknown): ArkadeRelativeTimelock | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const type = String(raw.type || "")
    .trim()
    .toLowerCase();
  if (type !== "blocks" && type !== "seconds") return null;
  const amount = Math.trunc(Number(raw.value));
  if (!Number.isInteger(amount) || amount <= 0) return null;
  return { type, value: amount };
}

function formatNuriServerCsv(value: ArkadeRelativeTimelock | null | undefined): string {
  if (!value) return "n/a";
  return `${value.value}_${value.type}`;
}

function publicContextCacheKey(meta: CredentialMeta, signerUrl: string): string {
  return [meta.credIdB64u, meta.clientPk33, normalizeSignerUrl(signerUrl)].join("|");
}

function isRequestAuthTokenFormat(token: string): boolean {
  return String(token || "").includes(".");
}

function shortRef(value: string, head = 8, tail = 4): string {
  const raw = String(value || "").trim();
  if (!raw) return "n/a";
  if (tail <= 0) {
    return raw.length <= head ? raw : `${raw.slice(0, head)}...`;
  }
  if (raw.length <= head + tail + 3) return raw;
  return `${raw.slice(0, head)}...${raw.slice(-tail)}`;
}

function signTraceValue(value: unknown): string {
  if (value === null || value === undefined) return "n/a";
  if (typeof value === "string") return value.replace(/\s+/g, "_");
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.join(",");
  return String(value).replace(/\s+/g, "_");
}

function logArkadeSignTrace(step: string, fields: Record<string, unknown> = {}): void {
  const detail = Object.entries(fields)
    .map(([key, value]) => `${key}=${signTraceValue(value)}`)
    .join(" ");
  console.log(
    `🔐 [${shortTime()} ${ARKADE_SIGN_TRACE_MARKER}] nuri_server_api=${NURI_SERVER_API_VERSION} step=${step}${detail ? ` ${detail}` : ""}`,
  );
}

function assertExpectedSignerServerVersion(serverVersion: string, source: string): void {
  const got = String(serverVersion || "").trim();
  if (!got || got === ARKADE_EXPECTED_SIGNER_SERVER) return;
  console.log(
    `🔐 [${shortTime()} src=services/arkade/ArkadeRemoteIdentity.ts#assertExpectedSignerServerVersion ERROR VALIDATION grp=Bitcoin] expected=${ARKADE_EXPECTED_SIGNER_SERVER} got=${got} client=${ARKADE_CLIENT_VERSION} source=${source}`,
  );
  throw new Error(
    `arkade signer server version mismatch expected=${ARKADE_EXPECTED_SIGNER_SERVER} got=${got}`,
  );
}

logArkadeSignTrace("module_loaded", {
  file: "services/arkade/ArkadeRemoteIdentity.ts",
  expected_next: "send_flow_calls_identity",
});

// Module-level "armed" pre-obtained passkey for the receive-claim path. The
// PaymentReceivedModal "Passkey Unlock" button runs the WebView ceremony itself
// (one tap), pre-fetching the auth (prepareReceiveClaimPasskey) and arming the
// result (armReceiveClaimPasskeyResult). The claim-approve branch then uses both
// instead of prompting again. Module-level because the claim may run on a
// different ArkadeRemoteIdentity instance than the one the modal prepared.
type ArmedReceiveClaimResult = {
  prfB64: string;
  credIdB64u: string;
  clientDataB64u: string;
  authDataB64u: string;
  sigB64u: string;
};
let armedReceiveClaimAuth: ArkadeAuthResponse | null = null;
let armedReceiveClaimResult: ArmedReceiveClaimResult | null = null;

export function armReceiveClaimPasskeyResult(result: ArmedReceiveClaimResult): void {
  armedReceiveClaimResult = result;
}

export function clearArmedReceiveClaimPasskey(): void {
  armedReceiveClaimAuth = null;
  armedReceiveClaimResult = null;
}

function takeArmedReceiveClaimPasskey(): {
  auth: ArkadeAuthResponse;
  result: ArmedReceiveClaimResult;
} | null {
  if (armedReceiveClaimAuth && armedReceiveClaimResult) {
    const out = { auth: armedReceiveClaimAuth, result: armedReceiveClaimResult };
    armedReceiveClaimAuth = null;
    armedReceiveClaimResult = null;
    return out;
  }
  return null;
}

// Pre-fetched auth for the username (lnurl-register) claim. The onboarding
// Continue button runs the WebView ceremony itself; its assertion is cached
// (with this auth's token) so the existing claimArkadeLnurlUsername — which reads
// the assertion cache (getPrfSigningAssertion(false)) — finds it, no second
// screen. Username-independent (challenge is bound to the credential, not name).
let pendingLnurlRegisterAuth: { auth: ArkadeAuthResponse; meta: CredentialMeta } | null = null;

export class ArkadeRemoteIdentity implements Identity {
  private publicContextCache: PublicContext | null = null;
  private publicContextCacheKey: string | null = null;
  private readonly httpClient: SignerHttpClient;
  private readonly assertionCache: AssertionCache;
  private readonly signingKeyVault: SigningKeyVault;
  private readonly spendApproval: ArkadeSpendApprovalFlow;
  private receiveClaimApproval: ReceiveClaimApprovalState | null = null;
  private boardingSweepApproval: BoardingSweepApprovalState | null = null;
  private recoverableApproval: RecoverableApprovalState | null = null;
  private boardingSweepSignQueue: Promise<void> = Promise.resolve();
  private nextReceiveClaimApprovalId = 1;
  private nextBoardingSweepApprovalId = 1;
  private nextRecoverableApprovalId = 1;

  constructor() {
    this.httpClient = new SignerHttpClient(() => this.getApprovalTraceState());
    this.assertionCache = new AssertionCache({
      getCredentialMeta: () => this.getCredentialMeta(),
      getPublicContext: () => this.getPublicContext(),
      withClientSigningKeyScope: (reason, fn) =>
        this.signingKeyVault.withClientSigningKeyScope(reason, fn),
      clearSigningKeyCache: (reason) => this.signingKeyVault.clearSigningKeyCache(reason),
      getSigningKey: (clientPk33, reason, auth) =>
        this.signingKeyVault.getSigningKey(clientPk33, reason, auth),
    });
    this.signingKeyVault = new SigningKeyVault({
      getCredentialMeta: () => this.getCredentialMeta(),
      getPublicContext: () => this.getPublicContext(),
      assertionCache: this.assertionCache,
    });
    this.spendApproval = new ArkadeSpendApprovalFlow({
      httpClient: this.httpClient,
      assertionCache: this.assertionCache,
      signingKeyVault: this.signingKeyVault,
      getCredentialMeta: () => this.getCredentialMeta(),
      getPublicContext: () => this.getPublicContext(),
    });
  }

  private getApprovalTraceState():
    | { state: string | null; approvalScope: "exact" | "direct_session" | "direct_send_session" }
    | { state: string | null; approvalScope: "receive_claim" }
    | { state: string | null; approvalScope: "boarding_sweep" }
    | { state: string | null; approvalScope: "recoverable_wallet_update" }
    | null {
    const spendState = this.spendApproval?.getPendingForHttp() ?? null;
    if (spendState) return spendState;
    if (this.receiveClaimApproval) {
      return {
        state: `receive_claim:${this.receiveClaimApproval.swapId}`,
        approvalScope: "receive_claim",
      };
    }
    if (this.boardingSweepApproval) {
      return {
        state: `boarding_sweep:${this.boardingSweepApproval.selectedOutpoints.join(",")}`,
        approvalScope: "boarding_sweep",
      };
    }
    if (this.recoverableApproval) {
      return {
        state: `recoverable_wallet_update:${this.recoverableApproval.id}`,
        approvalScope: "recoverable_wallet_update",
      };
    }
    return null;
  }

  async withMaintenanceSigningScope<T>(reason: string, fn: () => Promise<T>): Promise<T> {
    return this.signingKeyVault.withMaintenanceSigningScope(reason, fn);
  }

  armOutgoingSpendApproval(summary: Parameters<ArkadeSpendApprovalFlow["arm"]>[0]): number {
    if (this.receiveClaimApproval || this.boardingSweepApproval || this.recoverableApproval) {
      throw new Error("receive approval already in progress");
    }
    return this.spendApproval.arm(summary);
  }

  clearOutgoingSpendApproval(reason = "cleared", approvalId?: number): void {
    this.spendApproval.clear(reason, approvalId);
  }

  async completeOutgoingSpendApproval(txid?: string): Promise<void> {
    return this.spendApproval.completeNativeApiSend(txid);
  }

  armReceiveClaimApproval(swapId: string): number {
    const normalizedSwapId = String(swapId || "").trim();
    if (!normalizedSwapId) {
      throw new Error("receive claim approval requires swap_id");
    }
    if (this.spendApproval.hasActive()) {
      throw new Error("outgoing spend approval already in progress");
    }
    if (this.receiveClaimApproval || this.boardingSweepApproval || this.recoverableApproval) {
      throw new Error("receive approval already in progress");
    }
    const id = this.nextReceiveClaimApprovalId;
    this.nextReceiveClaimApprovalId += 1;
    this.receiveClaimApproval = {
      id,
      swapId: normalizedSwapId,
      approvalToken: null,
      claimSessionToken: null,
      claimSessionExpiresAtMs: null,
      approvedRequestKeys: new Set(),
      approvalInFlight: null,
      combinedAssertionAuth: null,
      psbtB64: null,
    };
    logArkadeSignTrace("receive_claim_approval_arm", {
      approval_id: id,
      swap_id: shortRef(normalizedSwapId, 12, 6),
      expected_next: "claim_psbt_sign_requests_then_receive_claim_approve",
    });
    return id;
  }

  clearReceiveClaimApproval(reason = "cleared", approvalId?: number): void {
    if (
      approvalId != null &&
      this.receiveClaimApproval &&
      this.receiveClaimApproval.id !== approvalId
    ) {
      logArkadeSignTrace("receive_claim_approval_clear_skipped", {
        reason,
        approval_id: approvalId,
        active_id: this.receiveClaimApproval.id,
        expected_next: "keep_active_claim_approval",
      });
      return;
    }
    if (this.receiveClaimApproval) {
      logArkadeSignTrace("receive_claim_approval_clear", {
        approval_id: this.receiveClaimApproval.id,
        swap_id: shortRef(this.receiveClaimApproval.swapId, 12, 6),
        token_present: this.receiveClaimApproval.approvalToken ? 1 : 0,
        session_present: this.receiveClaimApproval.claimSessionToken ? 1 : 0,
        reason,
        expected_next: "claim_scope_removed_and_key_zeroized",
      });
      this.receiveClaimApproval = null;
    }
    this.assertionCache.clearAssertionCache(`receive_claim_${reason}`);
    this.signingKeyVault.clearSigningKeyCache(`receive_claim_${reason}`);
  }

  // Pre-fetch the combined-assertion auth so PaymentReceivedModal can run the
  // WebView passkey ceremony on its own button tap (challenge ready up front),
  // then arm the result via armReceiveClaimPasskeyResult. Returns the WebView
  // inputs, or null if unavailable (modal then falls back to the prompt path).
  async prepareReceiveClaimPasskey(): Promise<{
    rpId: string;
    challengeB64u: string;
    credIdB64u: string;
  } | null> {
    try {
      const meta = this.getCredentialMeta();
      const pubCtx = await this.getPublicContext();
      const auth = await this.assertionCache.beginCombinedAssertionAuth(
        meta,
        pubCtx,
        "receive_claim_prefetch",
        "miss",
      );
      armedReceiveClaimAuth = auth;
      return { rpId: auth.rp_id, challengeB64u: auth.challenge, credIdB64u: meta.credIdB64u };
    } catch {
      armedReceiveClaimAuth = null;
      return null;
    }
  }

  // Pre-fetch the lnurl-register auth so the onboarding Continue button can run
  // the WebView passkey ceremony on its own tap. Returns WebView inputs or null.
  async prepareLnurlRegisterPasskey(): Promise<{
    rpId: string;
    challengeB64u: string;
    credIdB64u: string;
  } | null> {
    try {
      const meta = this.getCredentialMeta();
      const pubCtx = await this.getPublicContext();
      const auth = await this.assertionCache.beginCombinedAssertionAuth(
        meta,
        pubCtx,
        "lnurl_register_prefetch",
        "miss",
      );
      pendingLnurlRegisterAuth = { auth, meta };
      return { rpId: auth.rp_id, challengeB64u: auth.challenge, credIdB64u: meta.credIdB64u };
    } catch {
      pendingLnurlRegisterAuth = null;
      return null;
    }
  }

  // Cache the assertion the Continue-button WebView produced so the subsequent
  // claimArkadeLnurlUsername reads it from the assertion cache (no second screen).
  // Returns false if there was no pre-fetch to bind it to.
  cacheLnurlRegisterAssertion(assertion: {
    clientDataB64u: string;
    authDataB64u: string;
    sigB64u: string;
  }): boolean {
    const pending = pendingLnurlRegisterAuth;
    pendingLnurlRegisterAuth = null;
    if (!pending) return false;
    this.assertionCache.cacheAssertion(
      pending.meta,
      pending.auth.token,
      assertion,
      "lnurl_register",
      "passkey_prf_assertion",
    );
    return true;
  }

  async withReceiveClaimApproval<T>(
    swapId: string,
    reason: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const approvalId = this.armReceiveClaimApproval(swapId);
    try {
      logArkadeSignTrace("receive_claim_scope_enter", {
        approval_id: approvalId,
        swap_id: shortRef(swapId, 12, 6),
        expected_next: "receive_claim_approve_start",
      });
      return await this.withMaintenanceSigningScope(`receive_claim_${reason}`, work);
    } finally {
      const tokenPresent =
        this.receiveClaimApproval?.id === approvalId && this.receiveClaimApproval.approvalToken
          ? 1
          : 0;
      logArkadeSignTrace("receive_claim_scope_clear", {
        approval_id: approvalId,
        swap_id: shortRef(swapId, 12, 6),
        token_present: tokenPresent,
        expected_next: "claim_scope_removed",
      });
      this.clearReceiveClaimApproval("work_complete", approvalId);
      this.clearClientSigningKey("receive_claim_work_complete");
    }
  }

  armRecoverableApproval(): number {
    if (this.spendApproval.hasActive()) {
      throw new Error("outgoing spend approval already in progress");
    }
    if (this.receiveClaimApproval || this.boardingSweepApproval || this.recoverableApproval) {
      throw new Error("receive approval already in progress");
    }
    const id = this.nextRecoverableApprovalId;
    this.nextRecoverableApprovalId += 1;
    this.recoverableApproval = {
      id,
      approvalToken: null,
      recoverableSessionToken: null,
      recoverableSessionExpiresAtMs: null,
      approvedRequestKeys: new Set(),
      approvalInFlight: null,
      combinedAssertionAuth: null,
      psbtB64: null,
    };
    logArkadeSignTrace("recoverable_approval_arm", {
      approval_id: id,
      expected_next: "recoverable_psbt_sign_requests_then_approve",
    });
    return id;
  }

  clearRecoverableApproval(reason = "cleared", approvalId?: number): void {
    if (
      approvalId != null &&
      this.recoverableApproval &&
      this.recoverableApproval.id !== approvalId
    ) {
      logArkadeSignTrace("recoverable_approval_clear_skipped", {
        reason,
        approval_id: approvalId,
        active_id: this.recoverableApproval.id,
        expected_next: "keep_active_recoverable_approval",
      });
      return;
    }
    if (this.recoverableApproval) {
      logArkadeSignTrace("recoverable_approval_clear", {
        approval_id: this.recoverableApproval.id,
        token_present: this.recoverableApproval.approvalToken ? 1 : 0,
        reason,
        expected_next: "recoverable_scope_removed_and_key_zeroized",
      });
      this.recoverableApproval = null;
    }
    this.assertionCache.clearAssertionCache(`recoverable_${reason}`);
    this.signingKeyVault.clearSigningKeyCache(`recoverable_${reason}`);
  }

  async withRecoverableApproval<T>(reason: string, work: () => Promise<T>): Promise<T> {
    const approvalId = this.armRecoverableApproval();
    try {
      logArkadeSignTrace("recoverable_scope_enter", {
        approval_id: approvalId,
        expected_next: "recoverable_approve_start",
      });
      return await this.withMaintenanceSigningScope(`recoverable_${reason}`, work);
    } finally {
      const tokenPresent =
        this.recoverableApproval?.id === approvalId && this.recoverableApproval.approvalToken
          ? 1
          : 0;
      logArkadeSignTrace("recoverable_scope_clear", {
        approval_id: approvalId,
        token_present: tokenPresent,
        expected_next: "recoverable_scope_removed",
      });
      this.clearRecoverableApproval("work_complete", approvalId);
      this.clearClientSigningKey("recoverable_work_complete");
    }
  }

  armBoardingSweepApproval(context: ArkadeBoardingSweepApprovalContext): number {
    const selectedOutpoints = Array.isArray(context.selectedOutpoints)
      ? context.selectedOutpoints.map((value) => String(value || "").trim()).filter(Boolean)
      : [];
    const selectedTotalSats = Math.max(0, Math.trunc(Number(context.selectedTotalSats || 0)));
    if (selectedOutpoints.length === 0) {
      throw new Error("boarding sweep approval requires selected outpoints");
    }
    if (selectedTotalSats <= 0) {
      throw new Error("boarding sweep approval requires selected amount");
    }
    if (this.spendApproval.hasActive()) {
      throw new Error("outgoing spend approval already in progress");
    }
    if (this.receiveClaimApproval || this.boardingSweepApproval || this.recoverableApproval) {
      throw new Error("receive approval already in progress");
    }
    const id = this.nextBoardingSweepApprovalId;
    this.nextBoardingSweepApprovalId += 1;
    this.boardingSweepApproval = {
      id,
      selectedOutpoints,
      selectedTotalSats,
      approvalToken: null,
      boardingSweepSessionToken: null,
      boardingSweepSessionExpiresAtMs: null,
      approvedRequestKeys: new Set(),
      approvalInFlight: null,
      approvalInFlightRequestKeys: null,
      combinedAssertionAuth: null,
      psbtB64: null,
      scopedSignJobs: [],
      scopedSignTxFingerprint: null,
    };
    logArkadeSignTrace("boarding_sweep_approval_arm", {
      approval_id: id,
      selected_count: selectedOutpoints.length,
      selected_total: selectedTotalSats,
      expected_next: "boarding_sweep_psbt_sign_requests_then_approve",
    });
    return id;
  }

  clearBoardingSweepApproval(reason = "cleared", approvalId?: number): void {
    if (
      approvalId != null &&
      this.boardingSweepApproval &&
      this.boardingSweepApproval.id !== approvalId
    ) {
      logArkadeSignTrace("boarding_sweep_approval_clear_skipped", {
        reason,
        approval_id: approvalId,
        active_id: this.boardingSweepApproval.id,
        expected_next: "keep_active_boarding_sweep_approval",
      });
      return;
    }
    if (this.boardingSweepApproval) {
      logArkadeSignTrace("boarding_sweep_approval_clear", {
        approval_id: this.boardingSweepApproval.id,
        selected_count: this.boardingSweepApproval.selectedOutpoints.length,
        selected_total: this.boardingSweepApproval.selectedTotalSats,
        direct_token_present: this.boardingSweepApproval.approvalToken ? 1 : 0,
        reason,
        expected_next: "boarding_sweep_scope_removed_and_key_zeroized",
      });
      this.boardingSweepApproval = null;
    }
    this.assertionCache.clearAssertionCache(`boarding_sweep_${reason}`);
    this.signingKeyVault.clearSigningKeyCache(`boarding_sweep_${reason}`);
  }

  async withBoardingSweepApproval<T>(
    context: ArkadeBoardingSweepApprovalContext,
    reason: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const approvalId = this.armBoardingSweepApproval(context);
    try {
      logArkadeSignTrace("boarding_sweep_scope_enter", {
        approval_id: approvalId,
        selected_count: context.selectedOutpoints.length,
        selected_total: context.selectedTotalSats,
        expected_next: "boarding_sweep_approve_start",
      });
      return await this.withMaintenanceSigningScope(`boarding_sweep_${reason}`, work);
    } finally {
      const tokenPresent =
        this.boardingSweepApproval?.id === approvalId && this.boardingSweepApproval.approvalToken
          ? 1
          : 0;
      logArkadeSignTrace("boarding_sweep_scope_clear", {
        approval_id: approvalId,
        token_present: tokenPresent,
        expected_next: "boarding_sweep_scope_removed",
      });
      this.clearBoardingSweepApproval("work_complete", approvalId);
      this.clearClientSigningKey("boarding_sweep_work_complete");
    }
  }

  async getSigningKeyCopy(
    expectedClientPk33: string,
    reason = "client_key_copy",
  ): Promise<Uint8Array> {
    return this.signingKeyVault.getSigningKeyCopy(expectedClientPk33, reason);
  }

  async prewarmSigningKey(reason = "prewarm"): Promise<void> {
    return this.signingKeyVault.prewarmSigningKey(reason);
  }

  clearClientSigningKey(reason = "cleared"): void {
    this.signingKeyVault.clearSigningKeyCache(reason);
  }

  getReceiveOwner(): ArkadeReceiveOwner {
    const meta = this.getCredentialMeta();
    return {
      credIdB64u: meta.credIdB64u,
      clientPublicKey33Hex: meta.clientPk33,
    };
  }

  private getCredentialMeta(): CredentialMeta {
    const authState = authStateManager.getState();
    const walletPublicKeys = authState.walletPublicKeys;
    const credIdB64u = String(walletPublicKeys?.walletPasskeyCredIdB64u || "").trim();
    const credPubkeyB64u = String(walletPublicKeys?.walletPasskeyCredPubkeyB64u || "").trim();
    const clientPk33 = normalizeHex(String(walletPublicKeys?.userExternal || ""));
    const rawArkadeSignerContext = authState.arkadeSignerContext;
    const storedArkadeSignerContext =
      rawArkadeSignerContext &&
      isHex(normalizeHex(String(rawArkadeSignerContext.clientPk33 || "")), 66) &&
      isHex(normalizeHex(String(rawArkadeSignerContext.serverPk33 || "")), 66) &&
      isHex(normalizeHex(String(rawArkadeSignerContext.aggregatedPk33 || "")), 66) &&
      isHex(normalizeHex(String(rawArkadeSignerContext.aggregatedXonly32 || "")), 64)
        ? {
            clientPk33: normalizeHex(String(rawArkadeSignerContext.clientPk33 || "")),
            serverPk33: normalizeHex(String(rawArkadeSignerContext.serverPk33 || "")),
            aggregatedPk33: normalizeHex(String(rawArkadeSignerContext.aggregatedPk33 || "")),
            aggregatedXonly32: normalizeHex(String(rawArkadeSignerContext.aggregatedXonly32 || "")),
            signerUrl: normalizeSignerUrl(String(rawArkadeSignerContext.signerUrl || "")),
            updatedAtMs:
              typeof rawArkadeSignerContext.updatedAtMs === "number"
                ? rawArkadeSignerContext.updatedAtMs
                : 0,
          }
        : undefined;

    if (!credIdB64u) {
      throw new Error("missing wallet passkey credential id");
    }
    if (!isHex(clientPk33, 66)) {
      throw new Error("missing user external compressed pubkey");
    }

    return {
      credIdB64u,
      credPubkeyB64u: credPubkeyB64u || undefined,
      clientPk33,
      storedArkadeSignerContext,
    };
  }

  private async getPublicContext(): Promise<PublicContext> {
    const meta = this.getCredentialMeta();
    const signerUrl = normalizeSignerUrl(arkadeServerConfigService.getSignerServerUrl());
    const cacheKey = publicContextCacheKey(meta, signerUrl);

    if (this.publicContextCache && this.publicContextCacheKey === cacheKey) {
      return this.publicContextCache;
    }
    if (sharedPublicContextCache?.key === cacheKey) {
      this.publicContextCache = sharedPublicContextCache.context;
      this.publicContextCacheKey = cacheKey;
      logArkadeSignTrace("public_context_cache_hit", {
        source: "shared",
        client_pk: shortRef(meta.clientPk33, 10, 4),
        expected_next: "skip_redundant_auth_begin",
      });
      return sharedPublicContextCache.context;
    }
    if (sharedPublicContextInFlight?.key === cacheKey) {
      const context = await sharedPublicContextInFlight.promise;
      this.publicContextCache = context;
      this.publicContextCacheKey = cacheKey;
      return context;
    }

    const inFlight = (async () => {
      const info = await arkadeAuthBegin({
        credIdB64u: meta.credIdB64u,
        credPubkeyB64u: meta.credPubkeyB64u,
        clientSignerPubkeyHex: meta.clientPk33,
      });
      assertExpectedSignerServerVersion(String(info.server_version || ""), "public_context");
      const serverPk33 = normalizeHex(String(info.server_pubkey || ""));
      if (!isHex(serverPk33, 66)) {
        throw new Error("arkade auth missing server_pubkey");
      }

      const sorted = musig2.sortKeys([hexToBytes(meta.clientPk33), hexToBytes(serverPk33)]);
      const agg = musig2.keyAggregate(sorted);
      const aggExport = musig2.keyAggExport(agg);

      const aggCompressed = aggExport.length === 33 ? aggExport : agg.aggPublicKey.toBytes(true);
      if (!(aggCompressed instanceof Uint8Array) || aggCompressed.length !== 33) {
        throw new Error("failed to derive aggregated compressed pubkey");
      }

      const aggXonly = aggExport.length === 32 ? aggExport : aggCompressed.slice(1);
      if (aggXonly.length !== 32) {
        throw new Error("failed to derive aggregated x-only pubkey");
      }
      const nuriServerCsv =
        normalizeNuriServerCsv(info.nuri_server_csv) ||
        normalizeNuriServerCsv(info.recovery_policy?.nuri_server_csv) ||
        normalizeNuriServerCsv(info.cosigner_derivation?.nuri_server_csv) ||
        normalizeNuriServerCsv(info.cosigner_derivation?.recovery_policy?.nuri_server_csv);
      if (!nuriServerCsv) {
        logArkadeSignTrace("public_context_recovery_metadata_missing", {
          reason: "nuri_server_csv_unavailable",
          server_version: String(info.server_version || "n/a"),
          expected_next: "wallet_load_allowed_recovery_actions_blocked",
        });
      }

      const out: PublicContext = {
        clientPk33: meta.clientPk33,
        serverPk33,
        aggregatedPk33: bytesToHex(aggCompressed).toLowerCase(),
        aggregatedXonly32: bytesToHex(aggXonly).toLowerCase(),
        serverVersion: String(info.server_version || ""),
        tokenKeyFingerprint: String(info.token_key_fingerprint || ""),
        nuriServerCsv,
        recoveryPolicy: info.recovery_policy || null,
        recovery: info.recovery || null,
        cosignerDerivation: info.cosigner_derivation || null,
        passkeyPubkeyPolicy: String(
          info.recovery?.passkey_pubkey_policy || info.passkey_pubkey_policy || "",
        ),
        recoveryBackupFormat: String(info.recovery_backup_format || ""),
        cosignerAccountFingerprint: String(
          info.cosigner_derivation?.account_fingerprint || info.cosigner_account_fingerprint || "",
        ),
      };

      const stored = meta.storedArkadeSignerContext;
      if (
        stored &&
        stored.clientPk33 === out.clientPk33 &&
        (!stored.signerUrl || stored.signerUrl === signerUrl) &&
        (stored.serverPk33 !== out.serverPk33 ||
          stored.aggregatedPk33 !== out.aggregatedPk33 ||
          stored.aggregatedXonly32 !== out.aggregatedXonly32)
      ) {
        const expected = stored.aggregatedXonly32;
        const got = out.aggregatedXonly32;
        console.log(
          `🔐 [${shortTime()} ArkadeRemoteIdentity.pubctxMismatch] expected=${expected.slice(0, 16)}... got=${got.slice(0, 16)}... strict=${ARKADE_STRICT_AGGREGATED_KEY_MATCH ? 1 : 0}`,
        );
        if (ARKADE_STRICT_AGGREGATED_KEY_MATCH) {
          throw new Error("aggregated external key mismatch vs auth state");
        }
      }

      const nextArkadeSignerContext: ArkadeSignerContext = {
        clientPk33: out.clientPk33,
        serverPk33: out.serverPk33,
        aggregatedPk33: out.aggregatedPk33,
        aggregatedXonly32: out.aggregatedXonly32,
        signerUrl,
        updatedAtMs: Date.now(),
      };
      const shouldPersistContext =
        !stored ||
        stored.clientPk33 !== nextArkadeSignerContext.clientPk33 ||
        stored.serverPk33 !== nextArkadeSignerContext.serverPk33 ||
        stored.aggregatedPk33 !== nextArkadeSignerContext.aggregatedPk33 ||
        stored.aggregatedXonly32 !== nextArkadeSignerContext.aggregatedXonly32 ||
        normalizeSignerUrl(stored.signerUrl) !== nextArkadeSignerContext.signerUrl;
      if (shouldPersistContext) {
        await authStateManager.upsertArkadeSignerContext(nextArkadeSignerContext);
      }

      console.log(
        `🔐 [${shortTime()} src=services/arkade/ArkadeRemoteIdentity.ts#getSigningPublicContext INFO STATE grp=Bitcoin] client=${out.clientPk33.slice(0, 16)}... server=${out.serverPk33.slice(0, 16)}... agg=${out.aggregatedPk33.slice(0, 16)}... nuriServerCsv=${formatNuriServerCsv(out.nuriServerCsv)} policy=${out.passkeyPubkeyPolicy || "n/a"} registered=${out.recovery?.registered ? 1 : 0} hasPasskeyPub=${out.recovery?.passkey_pubkey_present ? 1 : 0} ${formatArkadeVersionMatrix(
          {
            nuriCsv: out.nuriServerCsv,
            serverVersion: out.serverVersion,
          },
        )}`,
      );
      return out;
    })();

    sharedPublicContextInFlight = { key: cacheKey, promise: inFlight };
    try {
      const out = await inFlight;
      sharedPublicContextCache = { key: cacheKey, context: out };
      this.publicContextCache = out;
      this.publicContextCacheKey = cacheKey;
      return out;
    } finally {
      if (sharedPublicContextInFlight?.key === cacheKey) {
        sharedPublicContextInFlight = null;
      }
    }
  }

  async getSigningPublicContext(): Promise<{
    clientPk33: string;
    serverPk33: string;
    aggregatedPk33: string;
    aggregatedXonly32: string;
    serverVersion: string;
    tokenKeyFingerprint: string;
    nuriServerCsv: ArkadeRelativeTimelock | null;
    recoveryPolicy: ArkadeRecoveryPolicy | null;
    recovery: ArkadeRecoveryStatus | null;
    cosignerDerivation: ArkadeCosignerDerivation | null;
    passkeyPubkeyPolicy: string;
    recoveryBackupFormat: string;
    cosignerAccountFingerprint: string;
  }> {
    const pubCtx = await this.getPublicContext();
    return {
      clientPk33: pubCtx.clientPk33,
      serverPk33: pubCtx.serverPk33,
      aggregatedPk33: pubCtx.aggregatedPk33,
      aggregatedXonly32: pubCtx.aggregatedXonly32,
      serverVersion: pubCtx.serverVersion,
      tokenKeyFingerprint: pubCtx.tokenKeyFingerprint,
      nuriServerCsv: pubCtx.nuriServerCsv,
      recoveryPolicy: pubCtx.recoveryPolicy,
      recovery: pubCtx.recovery,
      cosignerDerivation: pubCtx.cosignerDerivation,
      passkeyPubkeyPolicy: pubCtx.passkeyPubkeyPolicy,
      recoveryBackupFormat: pubCtx.recoveryBackupFormat,
      cosignerAccountFingerprint: pubCtx.cosignerAccountFingerprint,
    };
  }

  /**
   * The signing public context WITHOUT a network round-trip, a passkey ceremony or
   * a biometric prompt: the warm in-memory cache first, else the persisted
   * arkadeSignerContext (already hex-validated in getCredentialMeta, so this reuses
   * that validation instead of adding a second one). The on-chain MuSig2 address
   * derives from the very same v4 aggregate key the signer uses, so it has to be
   * readable at startup. null means "nothing usable cached" — the caller then takes
   * the authenticated getSigningPublicContext() path.
   *
   * nuriServerCsv is null on the persisted path: the recovery timelock is not part
   * of the stored context, only the keys are.
   */
  getCachedSigningPublicContext(): {
    clientPk33: string;
    serverPk33: string;
    aggregatedPk33: string;
    aggregatedXonly32: string;
    nuriServerCsv: ArkadeRelativeTimelock | null;
  } | null {
    let meta: CredentialMeta;
    try {
      meta = this.getCredentialMeta();
    } catch {
      // No wallet credential yet (signed out / pre-bootstrap) — nothing to serve.
      return null;
    }

    const signerUrl = normalizeSignerUrl(arkadeServerConfigService.getSignerServerUrl());
    const cacheKey = publicContextCacheKey(meta, signerUrl);
    const warm =
      (this.publicContextCacheKey === cacheKey ? this.publicContextCache : null) ||
      (sharedPublicContextCache?.key === cacheKey ? sharedPublicContextCache.context : null);
    if (warm) {
      logArkadeSignTrace("cached_public_context_hit", {
        source: "memory",
        agg_xonly: shortRef(warm.aggregatedXonly32, 10, 4),
      });
      return {
        clientPk33: warm.clientPk33,
        serverPk33: warm.serverPk33,
        aggregatedPk33: warm.aggregatedPk33,
        aggregatedXonly32: warm.aggregatedXonly32,
        nuriServerCsv: warm.nuriServerCsv,
      };
    }

    // Same guard the mismatch tripwire in getPublicContext() applies: the stored
    // context only counts for THIS client key and THIS signer server.
    const stored = meta.storedArkadeSignerContext;
    if (!stored || stored.clientPk33 !== meta.clientPk33) return null;
    if (stored.signerUrl && stored.signerUrl !== signerUrl) return null;

    logArkadeSignTrace("cached_public_context_hit", {
      source: "persisted",
      agg_xonly: shortRef(stored.aggregatedXonly32, 10, 4),
    });
    return {
      clientPk33: stored.clientPk33,
      serverPk33: stored.serverPk33,
      aggregatedPk33: stored.aggregatedPk33,
      aggregatedXonly32: stored.aggregatedXonly32,
      nuriServerCsv: null,
    };
  }

  async getSwapIntentContext(): Promise<{
    credIdB64u: string;
    credPubkeyB64u?: string;
    clientPk33: string;
  }> {
    const meta = this.getCredentialMeta();
    const pubCtx = await this.getPublicContext();
    return {
      credIdB64u: meta.credIdB64u,
      credPubkeyB64u: meta.credPubkeyB64u,
      clientPk33: pubCtx.clientPk33,
    };
  }

  async getIdentityReadinessSnapshot(): Promise<ArkadeIdentityReadiness> {
    await authStateManager.initialize();
    const authState = authStateManager.getState();
    const walletPublicKeys = authState.walletPublicKeys;
    const storedContext = authState.arkadeSignerContext;
    const cachedContext = this.publicContextCache;

    const clientPk33 = normalizeHex(String(walletPublicKeys?.userExternal || ""));
    const storedServerPk33 = normalizeHex(String(storedContext?.serverPk33 || ""));
    const storedAggregatedPk33 = normalizeHex(String(storedContext?.aggregatedPk33 || ""));
    const storedAggregatedXonly32 = normalizeHex(String(storedContext?.aggregatedXonly32 || ""));
    const cachedNuriServerCsv = cachedContext?.nuriServerCsv || null;

    const hasPasskeyCredId = Boolean(
      String(walletPublicKeys?.walletPasskeyCredIdB64u || "").trim(),
    );
    const hasPasskeyCredPubkey = Boolean(
      String(walletPublicKeys?.walletPasskeyCredPubkeyB64u || "").trim(),
    );
    const hasClientSignerPubkey = isHex(clientPk33, 66);
    const hasStoredServerPubkey = isHex(storedServerPk33, 66);
    const hasStoredAggregatedPubkey = isHex(storedAggregatedPk33, 66);
    const hasStoredAggregatedXonly = isHex(storedAggregatedXonly32, 64);
    const hasNuriServerCsv = Boolean(cachedNuriServerCsv);
    const hasRecoveryPolicy = Boolean(cachedContext?.recoveryPolicy);
    const hasCosignerDerivation = Boolean(cachedContext?.cosignerDerivation);
    const hasServerRecoveryStatus = Boolean(cachedContext?.recovery);
    const passkeyPubkeyPolicy = String(cachedContext?.passkeyPubkeyPolicy || "")
      .trim()
      .toLowerCase();
    const passkeyPubkeyRequired = passkeyPubkeyPolicy === "hard";
    const softModeActive = passkeyPubkeyPolicy === "soft";
    const passkeyPubkeyMissingAllowed = softModeActive && !hasPasskeyCredPubkey;
    const actualRecoveryProof =
      actualRecoveryProofReadinessProvider?.() ||
      ({
        pass: false,
        status: "not_checked",
        detail: "not_checked",
      } satisfies ArkadeActualRecoveryProofReadiness);

    const hardModeMissing: string[] = [];
    if (!hasPasskeyCredId) hardModeMissing.push("passkey_cred_id");
    if (!hasPasskeyCredPubkey) hardModeMissing.push("passkey_pubkey");
    if (!hasClientSignerPubkey) hardModeMissing.push("client_signer_pubkey");

    const serverLossRecoveryMissing: string[] = [];
    if (!hasPasskeyCredId) serverLossRecoveryMissing.push("passkey_cred_id");
    if (!hasClientSignerPubkey) serverLossRecoveryMissing.push("client_signer_pubkey");
    if (!hasStoredServerPubkey) serverLossRecoveryMissing.push("stored_server_pubkey");
    if (!hasStoredAggregatedPubkey) serverLossRecoveryMissing.push("stored_aggregated_pubkey");
    if (!hasStoredAggregatedXonly) serverLossRecoveryMissing.push("stored_aggregated_xonly");
    if (!hasNuriServerCsv) serverLossRecoveryMissing.push("nuri_server_csv");
    if (!hasRecoveryPolicy) serverLossRecoveryMissing.push("recovery_policy");
    if (!hasCosignerDerivation) serverLossRecoveryMissing.push("cosigner_derivation");
    if (!actualRecoveryProof.pass) serverLossRecoveryMissing.push("actual_recovery_proof");

    const missing = [...new Set([...hardModeMissing, ...serverLossRecoveryMissing])];

    const readyForHardMode = hardModeMissing.length === 0;
    const readyForServerLossRecovery =
      serverLossRecoveryMissing.length === 0 && (hasPasskeyCredPubkey || !passkeyPubkeyRequired);

    console.log(
      `🔐 [${shortTime()} src=services/arkade/ArkadeRemoteIdentity.ts#getIdentityReadinessSnapshot INFO STATE grp=Bitcoin] hard=${readyForHardMode ? 1 : 0} recovery=${readyForServerLossRecovery ? 1 : 0} proof=${actualRecoveryProof.status} soft=${softModeActive ? 1 : 0} nuriServerCsv=${formatNuriServerCsv(cachedNuriServerCsv)} policy=${passkeyPubkeyPolicy || "n/a"} hardMissing=${hardModeMissing.join(",") || "none"} recoveryMissing=${serverLossRecoveryMissing.join(",") || "none"}`,
    );

    return {
      readyForHardMode,
      readyForServerLossRecovery,
      softModeActive,
      passkeyPubkeyRequired,
      passkeyPubkeyMissingAllowed,
      hasPasskeyCredId,
      hasPasskeyCredPubkey,
      hasClientSignerPubkey,
      hasStoredServerPubkey,
      hasStoredAggregatedPubkey,
      hasStoredAggregatedXonly,
      hasNuriServerCsv,
      hasRecoveryPolicy,
      hasCosignerDerivation,
      hasServerRecoveryStatus,
      actualRecoveryProofStatus: actualRecoveryProof.status,
      actualRecoveryProofDetail: actualRecoveryProof.detail,
      nuriServerCsv: hasNuriServerCsv ? cachedNuriServerCsv : null,
      signerUrl: storedContext?.signerUrl || null,
      passkeyPubkeyPolicy,
      serverPubkeyPreview: hasStoredServerPubkey ? shortRef(storedServerPk33, 12, 8) : null,
      aggregatedPubkeyPreview: hasStoredAggregatedPubkey
        ? shortRef(storedAggregatedPk33, 12, 8)
        : null,
      missing,
      hardModeMissing,
      serverLossRecoveryMissing,
    };
  }

  async getSigningAssertion(
    forceRefresh = false,
    reason = "signing_assertion",
  ): Promise<SigningAssertionPayload> {
    const assertion = await this.assertionCache.getAssertion(forceRefresh, reason);
    return this.assertionCache.toSigningAssertionPayload(assertion);
  }

  async getPrfSigningAssertion(
    forceRefresh = false,
    reason = "signing_prf_assertion",
  ): Promise<SigningAssertionPayload> {
    const assertion = await this.assertionCache.getPrfAssertion(forceRefresh, reason);
    return this.assertionCache.toSigningAssertionPayload(assertion);
  }

  async getCachedSigningAssertion(): Promise<SigningAssertionPayload | null> {
    const assertion = await this.assertionCache.getCachedAssertion(this.getCredentialMeta());
    if (!assertion) {
      logArkadeSignTrace("cached_assertion_missing", {
        expected_next: "skip_background_auth_without_prompt",
      });
      return null;
    }
    if (!isRequestAuthTokenFormat(assertion.token)) {
      logArkadeSignTrace("cached_assertion_rejected", {
        reason: "non_request_auth_token_format",
        cached_prompt_kind: assertion.promptKind || "passkey_assertion",
        expected_next: "skip_background_auth_without_prompt",
      });
      return null;
    }
    return this.assertionCache.toSigningAssertionPayload(assertion);
  }

  async getCachedPrfSigningAssertion(
    reason = "cached_prf_signing_assertion",
  ): Promise<SigningAssertionPayload | null> {
    const assertion = await this.assertionCache.getCachedAssertion(this.getCredentialMeta());
    if (!assertion) {
      logArkadeSignTrace("cached_prf_assertion_missing", {
        reason,
        expected_next: "skip_background_auth_without_prompt",
      });
      return null;
    }
    if (!isRequestAuthTokenFormat(assertion.token)) {
      logArkadeSignTrace("cached_prf_assertion_rejected", {
        reason,
        cached_prompt_kind: assertion.promptKind || "passkey_prf_assertion",
        why: "non_request_auth_token_format",
        expected_next: "skip_background_auth_without_prompt",
      });
      return null;
    }
    if (!this.assertionCache.isPrfAssertion(assertion)) {
      logArkadeSignTrace("cached_prf_assertion_rejected", {
        reason,
        cached_prompt_kind: assertion.promptKind || "passkey_assertion",
        expected_prompt_kind: "passkey_prf_assertion",
        expected_next: "wait_for_foreground_prf_prompt",
      });
      return null;
    }
    return this.assertionCache.toSigningAssertionPayload(assertion);
  }

  async ensureOutgoingSpendApproval(
    requests: ArkadeSpendApprovalRequest[],
  ): Promise<string | null> {
    if (this.boardingSweepApproval && requests.some((request) => request.kind === "tree")) {
      return this.ensureBoardingSweepTreeApproval(requests);
    }
    if (this.recoverableApproval && requests.some((request) => request.kind === "tree")) {
      return this.ensureRecoverableTreeApproval(requests);
    }
    return this.spendApproval.ensure(requests);
  }

  async requestApprovedSign(
    ...args: Parameters<ArkadeSpendApprovalFlow["requestApprovedSign"]>
  ): ReturnType<ArkadeSpendApprovalFlow["requestApprovedSign"]> {
    return this.spendApproval.requestApprovedSign(...args);
  }

  async requestApprovedTreeSessionInit(
    ...args: Parameters<ArkadeSpendApprovalFlow["requestApprovedTreeSessionInit"]>
  ): ReturnType<ArkadeSpendApprovalFlow["requestApprovedTreeSessionInit"]> {
    return this.spendApproval.requestApprovedTreeSessionInit(...args);
  }

  async requestApprovedTreeNonce(
    ...args: Parameters<ArkadeSpendApprovalFlow["requestApprovedTreeNonce"]>
  ): ReturnType<ArkadeSpendApprovalFlow["requestApprovedTreeNonce"]> {
    const [approvalToken, payload] = args;
    if (this.getBoardingSweepCombinedAssertionAuth(approvalToken)) {
      this.assertBoardingSweepApprovedRequest(approvalToken, {
        kind: "tree",
        txid: String(payload.txid || "").toLowerCase(),
        msg32: String(payload.msg32 || "").toLowerCase(),
        clientPk33: String(payload.client_pk33 || "").toLowerCase(),
        tweak32: payload.tweak32 ? String(payload.tweak32).toLowerCase() : undefined,
      });
    }
    if (this.getRecoverableCombinedAssertionAuth(approvalToken)) {
      this.assertRecoverableApprovedRequest(approvalToken, {
        kind: "tree",
        txid: String(payload.txid || "").toLowerCase(),
        msg32: String(payload.msg32 || "").toLowerCase(),
        clientPk33: String(payload.client_pk33 || "").toLowerCase(),
        tweak32: payload.tweak32 ? String(payload.tweak32).toLowerCase() : undefined,
      });
    }
    return this.spendApproval.requestApprovedTreeNonce(...args);
  }

  async requestApprovedTreeSign(
    ...args: Parameters<ArkadeSpendApprovalFlow["requestApprovedTreeSign"]>
  ): ReturnType<ArkadeSpendApprovalFlow["requestApprovedTreeSign"]> {
    const [approvalToken, payload] = args;
    if (this.getBoardingSweepCombinedAssertionAuth(approvalToken)) {
      this.assertBoardingSweepApprovedRequest(approvalToken, {
        kind: "tree",
        txid: String(payload.txid || "").toLowerCase(),
        msg32: String(payload.msg32 || "").toLowerCase(),
        clientPk33: String(payload.client_pk33 || "").toLowerCase(),
        tweak32: payload.tweak32 ? String(payload.tweak32).toLowerCase() : undefined,
      });
    }
    if (this.getRecoverableCombinedAssertionAuth(approvalToken)) {
      this.assertRecoverableApprovedRequest(approvalToken, {
        kind: "tree",
        txid: String(payload.txid || "").toLowerCase(),
        msg32: String(payload.msg32 || "").toLowerCase(),
        clientPk33: String(payload.client_pk33 || "").toLowerCase(),
        tweak32: payload.tweak32 ? String(payload.tweak32).toLowerCase() : undefined,
      });
    }
    return this.spendApproval.requestApprovedTreeSign(...args);
  }

  private getReceiveClaimCombinedAssertionAuth(
    approvalToken: string | null | undefined,
  ): ArkadeAuthResponse | null {
    const pending = this.receiveClaimApproval;
    if (!pending || !approvalToken || pending.approvalToken !== approvalToken) return null;
    return pending.combinedAssertionAuth;
  }

  private getBoardingSweepCombinedAssertionAuth(
    approvalToken: string | null | undefined,
  ): ArkadeAuthResponse | null {
    const pending = this.boardingSweepApproval;
    if (!pending || !approvalToken || pending.approvalToken !== approvalToken) return null;
    return pending.combinedAssertionAuth;
  }

  private getRecoverableCombinedAssertionAuth(
    approvalToken: string | null | undefined,
  ): ArkadeAuthResponse | null {
    const pending = this.recoverableApproval;
    if (!pending || !approvalToken || pending.approvalToken !== approvalToken) return null;
    return pending.combinedAssertionAuth;
  }

  private toReceiveClaimSignRequestPayload(
    request: ArkadeSpendApprovalRequest,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {
      kind: request.kind,
      msg32: request.msg32,
      client_pk33: request.clientPk33,
    };
    if (typeof request.inputIndex === "number" && Number.isInteger(request.inputIndex)) {
      out.input_index = request.inputIndex;
    }
    if (request.tweak32) {
      out.tweak32 = request.tweak32;
    }
    if (request.txid) {
      out.txid = request.txid;
    }
    return out;
  }

  private requestKeysFor(requests: ArkadeSpendApprovalRequest[]): Set<string> {
    return new Set(requests.map(makeApprovalRequestKey));
  }

  private requestKeySetCovers(
    approved: Set<string> | null | undefined,
    requests: ArkadeSpendApprovalRequest[],
  ): boolean {
    return (
      requests.length > 0 &&
      requests.every((request) => approved?.has(makeApprovalRequestKey(request)))
    );
  }

  private async ensureBoardingSweepTreeApproval(
    requests: ArkadeSpendApprovalRequest[],
  ): Promise<string | null> {
    const pending = this.boardingSweepApproval;
    if (!pending) return null;
    if (!requests.length) {
      throw new Error("boarding sweep tree approval requires sign requests");
    }
    if (requests.some((request) => request.kind !== "tree")) {
      throw new Error("boarding sweep tree approval only supports tree signing requests");
    }
    if (!pending.psbtB64) {
      throw new Error("boarding sweep tree approval requires direct PSBT approval first");
    }
    const directRequests = pending.scopedSignJobs.map((job) => job.request);
    if (!directRequests.length) {
      throw new Error("boarding sweep tree approval requires direct sign requests");
    }
    return this.ensureBoardingSweepApproval(pending.psbtB64, [...directRequests, ...requests]);
  }

  private async ensureRecoverableTreeApproval(
    requests: ArkadeSpendApprovalRequest[],
  ): Promise<string | null> {
    const pending = this.recoverableApproval;
    if (!pending) return null;
    if (!pending.psbtB64) {
      throw new Error("recoverable tree approval requires direct PSBT approval first");
    }
    return this.ensureRecoverableApproval(pending.psbtB64, requests);
  }

  private async ensureBoardingSweepApproval(
    txPsbtB64: string,
    requests: ArkadeSpendApprovalRequest[],
  ): Promise<string | null> {
    const pending = this.boardingSweepApproval;
    if (!pending) return null;
    if (!requests.length) {
      throw new Error("boarding sweep approval requires sign requests");
    }
    if (!requests.some((request) => request.kind === "direct")) {
      throw new Error("boarding sweep approval requires direct signing requests");
    }
    pending.psbtB64 = txPsbtB64;
    if (pending.approvalToken) {
      if (this.requestKeySetCovers(pending.approvedRequestKeys, requests)) {
        logArkadeSignTrace("boarding_sweep_approval_token_reused", {
          approval_id: pending.id,
          requests: requests.length,
          expected_next: "sdk_calls_approved_sign",
        });
        return pending.approvalToken;
      }
      logArkadeSignTrace("boarding_sweep_approval_token_request_mismatch", {
        approval_id: pending.id,
        requests: requests.length,
        approved_requests: pending.approvedRequestKeys.size,
        session_present: pending.boardingSweepSessionToken ? 1 : 0,
        expected_next: "request_new_boarding_sweep_approval_token_with_session",
      });
      // Keep combinedAssertionAuth + session token so the re-mint for the
      // widened request set reuses the session and does NOT trigger another
      // passkey prompt. If no session token (e.g. a server without session
      // support), fall through to a fresh PRF approve instead of failing.
      pending.approvalToken = null;
      pending.approvedRequestKeys.clear();
    }
    if (pending.approvalInFlight) {
      if (this.requestKeySetCovers(pending.approvalInFlightRequestKeys, requests)) {
        logArkadeSignTrace("boarding_sweep_approval_inflight_wait", {
          approval_id: pending.id,
          requests: requests.length,
          expected_next: "reuse_single_boarding_sweep_approval",
        });
        return pending.approvalInFlight;
      }
      logArkadeSignTrace("boarding_sweep_approval_inflight_wait", {
        approval_id: pending.id,
        requests: requests.length,
        inflight_requests: pending.approvalInFlightRequestKeys?.size || 0,
        expected_next: "wait_then_request_exact_boarding_sweep_approval",
      });
      await pending.approvalInFlight.catch((_error: unknown): null => null);
      return this.ensureBoardingSweepApproval(txPsbtB64, requests);
    }

    pending.approvalInFlightRequestKeys = this.requestKeysFor(requests);
    const approvalInFlight = this.requestBoardingSweepApprovalToken(pending, txPsbtB64, requests);
    pending.approvalInFlight = approvalInFlight;
    try {
      return await approvalInFlight;
    } finally {
      if (this.boardingSweepApproval === pending && pending.approvalInFlight === approvalInFlight) {
        pending.approvalInFlight = null;
        pending.approvalInFlightRequestKeys = null;
      }
    }
  }

  private async requestBoardingSweepApprovalToken(
    pending: BoardingSweepApprovalState,
    txPsbtB64: string,
    requests: ArkadeSpendApprovalRequest[],
  ): Promise<string> {
    const signRequests = requests.map((request) => this.toReceiveClaimSignRequestPayload(request));
    let combinedAssertionAuth = pending.combinedAssertionAuth;
    let response: Awaited<ReturnType<typeof arkadeBoardingSweepApprove>>;

    // Drop a session about to expire so we re-prompt cleanly instead of failing
    // mid-sweep on an expired session token.
    if (
      pending.boardingSweepSessionToken &&
      pending.boardingSweepSessionExpiresAtMs !== null &&
      pending.boardingSweepSessionExpiresAtMs <= Date.now() + 30_000
    ) {
      logArkadeSignTrace("boarding_sweep_session_expired", {
        approval_id: pending.id,
        expires_at_ms: pending.boardingSweepSessionExpiresAtMs,
        expected_next: "fresh_boarding_sweep_assertion",
      });
      pending.boardingSweepSessionToken = null;
      pending.boardingSweepSessionExpiresAtMs = null;
      pending.combinedAssertionAuth = null;
      combinedAssertionAuth = null;
    }

    if (pending.boardingSweepSessionToken) {
      // Session approve sends no assertion — the session token alone authorizes
      // the re-mint. Mirror the receive-claim guard for parity/defense-in-depth;
      // the session token and combinedAssertionAuth are always set/cleared together.
      if (!combinedAssertionAuth) {
        throw new Error("boarding sweep assertion state missing for session approval");
      }
      logArkadeSignTrace("boarding_sweep_session_approve_start", {
        approval_id: pending.id,
        psbt: shortRef(txPsbtB64, 12, 6),
        requests: requests.length,
        session_present: 1,
        expected_next: "boarding_sweep_approve_with_session_token_no_prompt",
      });
      response = await arkadeBoardingSweepApprove(null, {
        boarding_sweep_session_token: pending.boardingSweepSessionToken,
        selected_outpoints: pending.selectedOutpoints,
        selected_total_sats: pending.selectedTotalSats,
        psbt_b64: txPsbtB64,
        sign_requests: signRequests,
      });
    } else {
      const meta = this.getCredentialMeta();
      const pubCtx = await this.getPublicContext();
      logArkadeSignTrace("boarding_sweep_approve_start", {
        approval_id: pending.id,
        selected_count: pending.selectedOutpoints.length,
        selected_total: pending.selectedTotalSats,
        psbt: shortRef(txPsbtB64, 12, 6),
        requests: requests.length,
        expected_next: "native_passkey_prf_assertion",
      });
      const cacheState = await this.assertionCache.getCombinedAssertionAuthState(meta);
      combinedAssertionAuth = await this.assertionCache.beginCombinedAssertionAuth(
        meta,
        pubCtx,
        "boarding_sweep_approval",
        cacheState,
      );
      this.signingKeyVault.clearSigningKeyCache("boarding_sweep_requires_fresh_native_result");
      await this.signingKeyVault.getSigningKey(
        pubCtx.clientPk33,
        "boarding_sweep_approval",
        combinedAssertionAuth,
      );
      const cachedAssertion = await this.assertionCache.getCachedAssertion(meta);
      if (
        !cachedAssertion ||
        cachedAssertion.token !== combinedAssertionAuth.token ||
        !this.assertionCache.isPrfAssertion(cachedAssertion)
      ) {
        throw new Error("boarding sweep approval requires combined PRF assertion");
      }
      response = await arkadeBoardingSweepApprove(
        this.assertionCache.toSigningAssertionPayload(cachedAssertion),
        {
          selected_outpoints: pending.selectedOutpoints,
          selected_total_sats: pending.selectedTotalSats,
          psbt_b64: txPsbtB64,
          sign_requests: signRequests,
        },
      );
    }

    const sessionToken = String(response.boarding_sweep_session_token || "").trim();
    if (sessionToken) {
      pending.boardingSweepSessionToken = sessionToken;
      pending.boardingSweepSessionExpiresAtMs = Number.isFinite(
        response.boarding_sweep_session_expires_at_ms,
      )
        ? Number(response.boarding_sweep_session_expires_at_ms)
        : null;
      logArkadeSignTrace("boarding_sweep_session_ready", {
        approval_id: pending.id,
        expires_at_ms: pending.boardingSweepSessionExpiresAtMs || "n/a",
        expected_next: "reuse_session_for_tree_sign_no_second_prompt",
      });
    } else if (!pending.boardingSweepSessionToken) {
      logArkadeSignTrace("boarding_sweep_session_missing", {
        approval_id: pending.id,
        expected_next: "tree_sign_will_reprompt_without_session",
      });
    }

    const approvalToken = String(response.approval_token || "").trim();
    if (!approvalToken || response.approval_scope !== "boarding_sweep") {
      throw new Error("boarding sweep approval did not return boarding_sweep token");
    }
    pending.approvalToken = approvalToken;
    pending.combinedAssertionAuth = combinedAssertionAuth;
    pending.approvedRequestKeys = new Set(requests.map(makeApprovalRequestKey));
    logArkadeSignTrace("boarding_sweep_approve_ready", {
      approval_id: pending.id,
      requests: requests.length,
      request_count: response.request_count ?? requests.length,
      token_present: 1,
      session_used: pending.boardingSweepSessionToken ? 1 : 0,
      expected_next: "approved_arkade_sign_boarding_sweep",
    });
    // The user's part is done: the settlement round runs unattended from here.
    emitArkadeReceiveUnlockProgress({
      phase: "sweep_approved",
      reason: "boarding_sweep_approved",
      id: String(pending.id),
    });
    return approvalToken;
  }

  private async ensureReceiveClaimApproval(
    txPsbtB64: string,
    requests: ArkadeSpendApprovalRequest[],
  ): Promise<string | null> {
    const pending = this.receiveClaimApproval;
    if (!pending) return null;
    if (!requests.length) {
      throw new Error("receive claim approval requires sign requests");
    }
    if (requests.some((request) => request.kind !== "direct")) {
      throw new Error("receive claim approval only supports direct signing requests");
    }
    pending.psbtB64 = txPsbtB64;
    if (pending.approvalToken) {
      if (approvalRequestSetCovers(pending.approvedRequestKeys, requests)) {
        logArkadeSignTrace("receive_claim_approval_token_reused", {
          approval_id: pending.id,
          swap_id: shortRef(pending.swapId, 12, 6),
          requests: requests.length,
          expected_next: "sdk_calls_approved_sign",
        });
        return pending.approvalToken;
      }
      logArkadeSignTrace("receive_claim_approval_token_request_mismatch", {
        approval_id: pending.id,
        swap_id: shortRef(pending.swapId, 12, 6),
        requests: requests.length,
        approved_requests: pending.approvedRequestKeys.size,
        session_present: pending.claimSessionToken ? 1 : 0,
        expected_next: "request_new_receive_claim_approval_token_with_session",
      });
      pending.approvalToken = null;
      pending.approvedRequestKeys.clear();
      if (!pending.claimSessionToken) {
        throw new Error("receive claim session token required for additional approval");
      }
    }
    if (pending.approvalInFlight) {
      logArkadeSignTrace("receive_claim_approval_inflight_wait", {
        approval_id: pending.id,
        swap_id: shortRef(pending.swapId, 12, 6),
        requests: requests.length,
        expected_next: "reuse_single_receive_claim_approval",
      });
      return pending.approvalInFlight;
    }

    const approvalInFlight = this.requestReceiveClaimApprovalToken(pending, txPsbtB64, requests);
    pending.approvalInFlight = approvalInFlight;
    try {
      return await approvalInFlight;
    } finally {
      if (this.receiveClaimApproval === pending && pending.approvalInFlight === approvalInFlight) {
        pending.approvalInFlight = null;
      }
    }
  }

  private async requestReceiveClaimApprovalToken(
    pending: ReceiveClaimApprovalState,
    txPsbtB64: string,
    requests: ArkadeSpendApprovalRequest[],
  ): Promise<string> {
    const signRequests = requests.map((request) => this.toReceiveClaimSignRequestPayload(request));
    let combinedAssertionAuth = pending.combinedAssertionAuth;
    let response: Awaited<ReturnType<typeof arkadeReceiveClaimApprove>>;

    if (
      pending.claimSessionToken &&
      pending.claimSessionExpiresAtMs !== null &&
      pending.claimSessionExpiresAtMs <= Date.now() + 30_000
    ) {
      logArkadeSignTrace("receive_claim_session_expired", {
        approval_id: pending.id,
        swap_id: shortRef(pending.swapId, 12, 6),
        expires_at_ms: pending.claimSessionExpiresAtMs,
        expected_next: "fresh_receive_claim_assertion",
      });
      pending.claimSessionToken = null;
      pending.claimSessionExpiresAtMs = null;
      pending.combinedAssertionAuth = null;
      combinedAssertionAuth = null;
    }

    if (pending.claimSessionToken) {
      if (!combinedAssertionAuth) {
        throw new Error("receive claim assertion state missing for session approval");
      }
      logArkadeSignTrace("receive_claim_session_approve_start", {
        approval_id: pending.id,
        swap_id: shortRef(pending.swapId, 12, 6),
        psbt: shortRef(txPsbtB64, 12, 6),
        requests: requests.length,
        session_present: 1,
        expected_next: "receive_claim_approve_with_session_token",
      });
      response = await arkadeReceiveClaimApprove(null, {
        claim_session_token: pending.claimSessionToken,
        swap_id: pending.swapId,
        psbt_b64: txPsbtB64,
        sign_requests: signRequests,
      });
    } else {
      const meta = this.getCredentialMeta();
      const pubCtx = await this.getPublicContext();
      logArkadeSignTrace("receive_claim_approve_start", {
        approval_id: pending.id,
        swap_id: shortRef(pending.swapId, 12, 6),
        psbt: shortRef(txPsbtB64, 12, 6),
        requests: requests.length,
        expected_next: "native_passkey_prf_assertion",
      });
      // If the PaymentReceivedModal "Passkey Unlock" button already ran the
      // WebView ceremony (one tap), use that pre-fetched auth + result instead
      // of prompting again. Otherwise fetch auth and prompt as usual.
      const armedPasskey = takeArmedReceiveClaimPasskey();
      if (armedPasskey) {
        combinedAssertionAuth = armedPasskey.auth;
      } else {
        const cacheState = await this.assertionCache.getCombinedAssertionAuthState(meta);
        combinedAssertionAuth = await this.assertionCache.beginCombinedAssertionAuth(
          meta,
          pubCtx,
          "receive_claim_approval",
          cacheState,
        );
      }
      this.signingKeyVault.clearSigningKeyCache("receive_claim_requires_fresh_native_result");
      await this.signingKeyVault.getSigningKey(
        pubCtx.clientPk33,
        "receive_claim_approval",
        combinedAssertionAuth,
        armedPasskey?.result ?? null,
      );
      const cachedAssertion = await this.assertionCache.getCachedAssertion(meta);
      if (
        !cachedAssertion ||
        cachedAssertion.token !== combinedAssertionAuth.token ||
        !this.assertionCache.isPrfAssertion(cachedAssertion)
      ) {
        throw new Error("receive claim approval requires combined PRF assertion");
      }
      response = await arkadeReceiveClaimApprove(
        this.assertionCache.toSigningAssertionPayload(cachedAssertion),
        {
          swap_id: pending.swapId,
          psbt_b64: txPsbtB64,
          sign_requests: signRequests,
        },
      );
      const claimSessionToken = String(response.claim_session_token || "").trim();
      if (claimSessionToken) {
        pending.claimSessionToken = claimSessionToken;
        pending.claimSessionExpiresAtMs = Number.isFinite(response.claim_session_expires_at_ms)
          ? Number(response.claim_session_expires_at_ms)
          : null;
        logArkadeSignTrace("receive_claim_session_ready", {
          approval_id: pending.id,
          swap_id: shortRef(pending.swapId, 12, 6),
          expires_at_ms: pending.claimSessionExpiresAtMs || "n/a",
          expected_next: "reuse_session_for_additional_claim_approvals",
        });
      } else {
        logArkadeSignTrace("receive_claim_session_missing", {
          approval_id: pending.id,
          swap_id: shortRef(pending.swapId, 12, 6),
          expected_next: "fail_closed_if_additional_claim_approval_needed",
        });
      }
    }

    const approvalToken = String(response.approval_token || "").trim();
    if (!approvalToken || response.approval_scope !== "receive_claim") {
      throw new Error("receive claim approval did not return receive_claim token");
    }
    pending.approvalToken = approvalToken;
    pending.combinedAssertionAuth = combinedAssertionAuth;
    pending.approvedRequestKeys = new Set(requests.map(makeApprovalRequestKey));
    logArkadeSignTrace("receive_claim_approve_ready", {
      approval_id: pending.id,
      swap_id: shortRef(pending.swapId, 12, 6),
      requests: requests.length,
      request_count: response.request_count ?? requests.length,
      token_present: 1,
      session_present: pending.claimSessionToken ? 1 : 0,
      expected_next: "approved_arkade_sign_receive_claim",
    });
    return approvalToken;
  }

  private async ensureRecoverableApproval(
    txPsbtB64: string,
    requests: ArkadeSpendApprovalRequest[],
  ): Promise<string | null> {
    const pending = this.recoverableApproval;
    if (!pending) return null;
    if (!requests.length) {
      throw new Error("recoverable approval requires sign requests");
    }
    pending.psbtB64 = txPsbtB64;
    if (pending.approvalToken) {
      if (approvalRequestSetCovers(pending.approvedRequestKeys, requests)) {
        logArkadeSignTrace("recoverable_approval_token_reused", {
          approval_id: pending.id,
          requests: requests.length,
          expected_next: "sdk_calls_approved_sign",
        });
        return pending.approvalToken;
      }
      pending.approvalToken = null;
      pending.approvedRequestKeys.clear();
    }
    if (pending.approvalInFlight) {
      logArkadeSignTrace("recoverable_approval_inflight_wait", {
        approval_id: pending.id,
        requests: requests.length,
        expected_next: "reuse_single_recoverable_approval",
      });
      return pending.approvalInFlight;
    }
    const approvalInFlight = this.requestRecoverableApprovalToken(pending, txPsbtB64, requests);
    pending.approvalInFlight = approvalInFlight;
    try {
      return await approvalInFlight;
    } finally {
      if (this.recoverableApproval === pending && pending.approvalInFlight === approvalInFlight) {
        pending.approvalInFlight = null;
      }
    }
  }

  private async requestRecoverableApprovalToken(
    pending: RecoverableApprovalState,
    txPsbtB64: string,
    requests: ArkadeSpendApprovalRequest[],
  ): Promise<string> {
    const signRequests = requests.map((request) => this.toReceiveClaimSignRequestPayload(request));

    // Drop a session about to expire so we re-prompt cleanly instead of failing
    // mid-operation (e.g. a checkpoint approve) on an expired session token.
    if (
      pending.recoverableSessionToken &&
      pending.recoverableSessionExpiresAtMs !== null &&
      pending.recoverableSessionExpiresAtMs <= Date.now() + 30_000
    ) {
      logArkadeSignTrace("recoverable_session_expired", {
        approval_id: pending.id,
        expires_at_ms: pending.recoverableSessionExpiresAtMs,
        expected_next: "fresh_recoverable_assertion",
      });
      pending.recoverableSessionToken = null;
      pending.recoverableSessionExpiresAtMs = null;
      pending.combinedAssertionAuth = null;
    }

    let response: Awaited<ReturnType<typeof arkadeRecoverableApprove>>;
    if (pending.recoverableSessionToken) {
      // Session token alone authorizes the approve — no assertion, no PRF
      // prompt. Mints once on the first approve (below), then every subsequent
      // per-checkpoint approve in this operation rides it.
      logArkadeSignTrace("recoverable_session_approve_start", {
        approval_id: pending.id,
        psbt: shortRef(txPsbtB64, 12, 6),
        requests: requests.length,
        session_present: 1,
        expected_next: "recoverable_approve_with_session_token_no_prompt",
      });
      response = await arkadeRecoverableApprove(null, {
        psbt_b64: txPsbtB64,
        sign_requests: signRequests,
        recoverable_session_token: pending.recoverableSessionToken,
      });
    } else {
      const meta = this.getCredentialMeta();
      const pubCtx = await this.getPublicContext();
      logArkadeSignTrace("recoverable_approve_start", {
        approval_id: pending.id,
        psbt: shortRef(txPsbtB64, 12, 6),
        requests: requests.length,
        expected_next: "native_passkey_prf_assertion",
      });
      const cacheState = await this.assertionCache.getCombinedAssertionAuthState(meta);
      const combinedAssertionAuth = await this.assertionCache.beginCombinedAssertionAuth(
        meta,
        pubCtx,
        "recoverable_approval",
        cacheState,
      );
      this.signingKeyVault.clearSigningKeyCache("recoverable_requires_fresh_native_result");
      await this.signingKeyVault.getSigningKey(
        pubCtx.clientPk33,
        "recoverable_approval",
        combinedAssertionAuth,
      );
      const cachedAssertion = await this.assertionCache.getCachedAssertion(meta);
      if (
        !cachedAssertion ||
        cachedAssertion.token !== combinedAssertionAuth.token ||
        !this.assertionCache.isPrfAssertion(cachedAssertion)
      ) {
        throw new Error("recoverable approval requires combined PRF assertion");
      }
      response = await arkadeRecoverableApprove(
        this.assertionCache.toSigningAssertionPayload(cachedAssertion),
        {
          psbt_b64: txPsbtB64,
          sign_requests: signRequests,
        },
      );
      pending.combinedAssertionAuth = combinedAssertionAuth;
    }

    const approvalToken = String(response.approval_token || "").trim();
    if (!approvalToken || response.approval_scope !== "recoverable_wallet_update") {
      throw new Error("recoverable approval did not return recoverable_wallet_update token");
    }
    // Capture the session token the server mints on the first assertion-backed
    // approve so subsequent per-checkpoint approves skip the PRF prompt.
    const sessionToken = String(response.recoverable_session_token || "").trim();
    if (sessionToken) {
      pending.recoverableSessionToken = sessionToken;
      pending.recoverableSessionExpiresAtMs = Number.isFinite(
        response.recoverable_session_expires_at_ms,
      )
        ? Number(response.recoverable_session_expires_at_ms)
        : null;
      logArkadeSignTrace("recoverable_session_ready", {
        approval_id: pending.id,
        expires_at_ms: pending.recoverableSessionExpiresAtMs || "n/a",
        expected_next: "reuse_session_for_checkpoints_no_second_prompt",
      });
    }
    pending.approvalToken = approvalToken;
    pending.approvedRequestKeys = new Set(requests.map(makeApprovalRequestKey));
    logArkadeSignTrace("recoverable_approve_ready", {
      approval_id: pending.id,
      requests: requests.length,
      request_count: response.request_count ?? requests.length,
      token_present: 1,
      session_used: pending.recoverableSessionToken ? 1 : 0,
      expected_next: "approved_arkade_sign_recoverable",
    });
    return approvalToken;
  }

  private assertRecoverableApprovedRequest(
    approvalToken: string,
    request: ArkadeSpendApprovalRequest,
  ): void {
    const pending = this.recoverableApproval;
    if (!pending || pending.approvalToken !== approvalToken) {
      throw new Error("recoverable approval state missing for sign request");
    }
    const requestKey = makeApprovalRequestKey(request);
    if (pending.approvedRequestKeys.has(requestKey)) return;
    logArkadeSignTrace("recoverable_approved_request_missing", {
      approval_id: pending.id,
      request_hash: bytesToHex(sha256(utf8ToBytes(requestKey))).toLowerCase(),
      approved_requests: pending.approvedRequestKeys.size,
      expected_next: "request_exact_recoverable_approval",
    });
    throw new Error("recoverable approval token does not cover sign request");
  }

  private assertBoardingSweepApprovedRequest(
    approvalToken: string,
    request: ArkadeSpendApprovalRequest,
  ): void {
    const pending = this.boardingSweepApproval;
    if (!pending || pending.approvalToken !== approvalToken) {
      throw new Error("boarding sweep approval state missing for sign request");
    }
    const requestKey = makeApprovalRequestKey(request);
    if (pending.approvedRequestKeys.has(requestKey)) return;

    const requestHash = bytesToHex(sha256(utf8ToBytes(requestKey))).toLowerCase();
    logArkadeSignTrace("boarding_sweep_approved_request_missing", {
      approval_id: pending.id,
      input_index:
        typeof request.inputIndex === "number" && Number.isInteger(request.inputIndex)
          ? request.inputIndex
          : "n/a",
      msg32: shortRef(request.msg32, 10, 4),
      has_tweak: request.tweak32 ? 1 : 0,
      approved_requests: pending.approvedRequestKeys.size,
      missing_request_hash: requestHash,
      expected_next: "fail_before_arkade_sign",
    });
    throw new Error(`boarding sweep approval missing sign request ${requestHash}`);
  }

  private async runBoardingSweepSignExclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.boardingSweepSignQueue;
    let releaseCurrent: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    this.boardingSweepSignQueue = current;
    await previous.catch((_error: unknown): undefined => undefined);
    try {
      return await work();
    } finally {
      releaseCurrent();
      if (this.boardingSweepSignQueue === current) {
        this.boardingSweepSignQueue = Promise.resolve();
      }
    }
  }

  private async signMsg32WithCosigner(
    msg32: Uint8Array,
    tweak32?: Uint8Array,
    approvalToken?: string | null,
    inputIndex?: number,
    approvalRequest?: ArkadeSpendApprovalRequest,
  ): Promise<Uint8Array> {
    const run = () =>
      this.signingKeyVault.runSignExclusive(async () => {
        const msg32Hex = bytesToHex(msg32).toLowerCase();
        const pubCtx = await this.getPublicContext();
        const tweak32Hex = tweak32 ? bytesToHex(tweak32).toLowerCase() : undefined;
        if (approvalRequest) {
          if (normalizeHex(approvalRequest.msg32) !== msg32Hex) {
            throw new Error("approval sign request msg32 mismatch");
          }
          if (normalizeHex(approvalRequest.clientPk33) !== normalizeHex(pubCtx.clientPk33)) {
            throw new Error("approval sign request client key mismatch");
          }
          if (normalizeHex(approvalRequest.tweak32 || "") !== normalizeHex(tweak32Hex || "")) {
            throw new Error("approval sign request tweak mismatch");
          }
          if (
            typeof approvalRequest.inputIndex === "number" &&
            Number.isInteger(approvalRequest.inputIndex) &&
            typeof inputIndex === "number" &&
            Number.isInteger(inputIndex) &&
            approvalRequest.inputIndex !== inputIndex
          ) {
            throw new Error("approval sign request input index mismatch");
          }
        }
        const signRequest: ArkadeSpendApprovalRequest =
          approvalRequest ||
          ({
            kind: "direct",
            msg32: msg32Hex,
            clientPk33: pubCtx.clientPk33,
            ...(typeof inputIndex === "number" && Number.isInteger(inputIndex)
              ? { inputIndex }
              : {}),
            ...(tweak32Hex ? { tweak32: tweak32Hex } : {}),
          } satisfies ArkadeSpendApprovalRequest);
        logArkadeSignTrace("sign_msg32_start", {
          msg32: shortRef(msg32Hex, 10, 4),
          client_pk: shortRef(pubCtx.clientPk33, 10, 4),
          server_pk: shortRef(pubCtx.serverPk33, 10, 4),
          agg_xonly: shortRef(pubCtx.aggregatedXonly32, 10, 4),
          has_tweak: tweak32 ? 1 : 0,
          approval_token: approvalToken ? 1 : 0,
          expected_next: "load_passkey_prf_client_key",
        });

        let priv: Uint8Array | null = null;
        let secretNonce: Uint8Array | null = null;

        try {
          if (!approvalToken) {
            logArkadeSignTrace("approval_token_missing_sign_blocked", {
              msg32: shortRef(msg32Hex, 10, 4),
              has_pending_spend_approval: this.spendApproval.hasActive() ? 1 : 0,
              has_receive_claim_approval: this.receiveClaimApproval ? 1 : 0,
              has_boarding_sweep_approval: this.boardingSweepApproval ? 1 : 0,
              has_recoverable_approval: this.recoverableApproval ? 1 : 0,
              receive_swap: this.receiveClaimApproval
                ? shortRef(this.receiveClaimApproval.swapId, 12, 6)
                : "n/a",
              has_tweak: tweak32 ? 1 : 0,
              expected_next: "surface_approval_scope_error",
            });
            throw new Error("Arkade signing requires approval token");
          }
          const credentialMeta = this.getCredentialMeta();
          const signingReason = "approved_msg32_sign";
          const assertionReason = "approved_msg32_sign";
          const nativeApiAssertionAuth =
            this.spendApproval.getNativeApiCombinedAssertionAuth(approvalToken);
          const receiveClaimAssertionAuth =
            this.getReceiveClaimCombinedAssertionAuth(approvalToken);
          const boardingSweepAssertionAuth =
            this.getBoardingSweepCombinedAssertionAuth(approvalToken);
          const recoverableAssertionAuth =
            this.recoverableApproval?.approvalToken === approvalToken
              ? this.recoverableApproval.combinedAssertionAuth
              : null;
          if (receiveClaimAssertionAuth && !this.signingKeyVault.getCachedPriv32()) {
            logArkadeSignTrace("receive_claim_key_missing_scoped_sign_blocked", {
              msg32: shortRef(msg32Hex, 10, 4),
              receive_swap: this.receiveClaimApproval
                ? shortRef(this.receiveClaimApproval.swapId, 12, 6)
                : "n/a",
              expected_next: "surface_claim_scope_error_without_second_prompt",
            });
            throw new Error("receive claim signing key missing from active scope");
          }
          if (boardingSweepAssertionAuth && !this.signingKeyVault.getCachedPriv32()) {
            logArkadeSignTrace("boarding_sweep_key_missing_scoped_sign_blocked", {
              msg32: shortRef(msg32Hex, 10, 4),
              expected_next: "surface_boarding_sweep_scope_error_without_second_prompt",
            });
            throw new Error("boarding sweep signing key missing from active scope");
          }
          if (recoverableAssertionAuth && !this.signingKeyVault.getCachedPriv32()) {
            logArkadeSignTrace("recoverable_key_missing_scoped_sign_blocked", {
              msg32: shortRef(msg32Hex, 10, 4),
              expected_next: "surface_recoverable_scope_error_without_second_prompt",
            });
            throw new Error("recoverable signing key missing from active scope");
          }
          let combinedAssertionAuth =
            nativeApiAssertionAuth ||
            receiveClaimAssertionAuth ||
            boardingSweepAssertionAuth ||
            recoverableAssertionAuth ||
            (await this.assertionCache.beginCombinedAssertionAuthIfNeeded(
              credentialMeta,
              pubCtx,
              assertionReason,
            ));

          if (!combinedAssertionAuth) {
            const cacheState =
              await this.assertionCache.getCombinedAssertionAuthState(credentialMeta);
            logArkadeSignTrace("assertion_auth_required_for_client_key", {
              src: "services/arkade/ArkadeRemoteIdentity.ts#signMsg32WithCosigner",
              reason: assertionReason,
              cache_state: cacheState,
              expected_next: "post_arkade_auth_begin_for_client_key",
            });
            combinedAssertionAuth = await this.assertionCache.beginCombinedAssertionAuth(
              credentialMeta,
              pubCtx,
              `${assertionReason}_client_key`,
              cacheState,
            );
          }

          priv = await this.signingKeyVault.getSigningKey(
            pubCtx.clientPk33,
            signingReason,
            combinedAssertionAuth,
          );
          if (nativeApiAssertionAuth) {
            const authenticated = this.spendApproval.markNativeApiSendAuthenticated(approvalToken);
            if (authenticated) {
              try {
                EventBus.emit("bitcoin:sendAuthenticated", authenticated);
              } catch {}
            }
          }
          logArkadeSignTrace("client_key_ready", {
            client_pk: shortRef(pubCtx.clientPk33, 10, 4),
            key_source: "passkey_prf_scope_or_prompt",
            expected_next: "generate_musig_nonce",
          });

          const nonces = musig2.nonceGen(
            hexToBytes(pubCtx.clientPk33),
            priv,
            hexToBytes(pubCtx.aggregatedXonly32),
            msg32,
          );
          secretNonce = nonces.secret;
          const clientPubNonce = bytesToHex(nonces.public).toLowerCase();
          logArkadeSignTrace("client_nonce_ready", {
            msg32: shortRef(msg32Hex, 10, 4),
            client_nonce: shortRef(clientPubNonce, 10, 4),
            expected_next: "approved_server_sign",
          });

          const payload = {
            msg32: signRequest.msg32,
            client_pk33: signRequest.clientPk33,
            client_pub_nonce: clientPubNonce,
            tweak32: signRequest.tweak32 || undefined,
          };
          const approvedPayload =
            typeof signRequest.inputIndex === "number" && Number.isInteger(signRequest.inputIndex)
              ? {
                  ...payload,
                  input_index: signRequest.inputIndex,
                }
              : payload;

          console.log(
            `🔐 [${shortTime()} ArkadeRemoteIdentity.sign] action=useApprovalToken msg=${msg32Hex.slice(0, 12)}... tweak=${tweak32 ? 1 : 0}`,
          );
          const approvalScope = receiveClaimAssertionAuth
            ? "receive_claim"
            : boardingSweepAssertionAuth
              ? "boarding_sweep"
              : recoverableAssertionAuth
                ? "recoverable_wallet_update"
                : nativeApiAssertionAuth
                  ? "native_send"
                  : "spend";
          if (boardingSweepAssertionAuth) {
            this.assertBoardingSweepApprovedRequest(approvalToken, signRequest);
          }
          logArkadeSignTrace("server_sign_with_approval_token", {
            mode: "approval_token",
            scope: approvalScope,
            msg32: shortRef(msg32Hex, 10, 4),
            input_index:
              typeof signRequest.inputIndex === "number" && Number.isInteger(signRequest.inputIndex)
                ? signRequest.inputIndex
                : "n/a",
            has_tweak: tweak32 ? 1 : 0,
            expected_next: "post_arkade_sign_approved",
          });
          const signResponse = await this.requestApprovedSign(approvalToken, approvedPayload);

          const sortedKeys = musig2.sortKeys([
            hexToBytes(pubCtx.clientPk33),
            hexToBytes(pubCtx.serverPk33),
          ]);
          assertHexLength(signResponse.server_pub_nonce66, 132, "server_pub_nonce66");
          assertHexLength(signResponse.server_partial32, 64, "server_partial32");
          assertHexLength(signResponse.server_pubkey, 66, "server_pubkey");
          if (normalizeHex(signResponse.server_pubkey) !== pubCtx.serverPk33) {
            throw new Error("server pubkey mismatch in sign response");
          }
          logArkadeSignTrace("server_partial_ready", {
            msg32: shortRef(msg32Hex, 10, 4),
            server_nonce: shortRef(signResponse.server_pub_nonce66, 10, 4),
            server_partial: shortRef(signResponse.server_partial32, 10, 4),
            expected_next: "verify_and_aggregate_signature",
          });
          const serverPubNonce = hexToBytes(signResponse.server_pub_nonce66);
          const serverPartial = hexToBytes(signResponse.server_partial32);
          const aggNonce = musig2.nonceAggregate([hexToBytes(clientPubNonce), serverPubNonce]);

          const sessionObj = tweak32
            ? new musig2.Session(aggNonce, sortedKeys, msg32, [tweak32], [true])
            : new musig2.Session(aggNonce, sortedKeys, msg32);

          const serverIndex = sortedKeys.findIndex(
            (pk) => bytesToHex(pk).toLowerCase() === pubCtx.serverPk33,
          );
          if (serverIndex < 0) {
            throw new Error("server key missing in sorted set");
          }

          const orderedNonces = sortedKeys.map((pk) =>
            bytesToHex(pk).toLowerCase() === pubCtx.serverPk33
              ? serverPubNonce
              : hexToBytes(clientPubNonce),
          );

          const serverOk = sessionObj.partialSigVerify(serverPartial, orderedNonces, serverIndex);
          if (!serverOk) {
            throw new Error("server partial verification failed");
          }
          logArkadeSignTrace("server_partial_verified", {
            msg32: shortRef(msg32Hex, 10, 4),
            server_pk: shortRef(pubCtx.serverPk33, 10, 4),
            server_partial_ok: 1,
            expected_next: "sign_client_partial",
          });

          const clientPartial = sessionObj.sign(secretNonce, priv);
          const finalSig = sessionObj.partialSigAgg([clientPartial, serverPartial]);
          if (!tweak32) {
            const finalSigOk = schnorr.verify(
              finalSig,
              msg32,
              hexToBytes(pubCtx.aggregatedXonly32),
            );
            if (!finalSigOk) {
              throw new Error("aggregated signature verification failed");
            }
            logArkadeSignTrace("signature_verified", {
              msg32: shortRef(msg32Hex, 10, 4),
              agg_xonly: shortRef(pubCtx.aggregatedXonly32, 10, 4),
              final_sig_ok: 1,
              expected_next: "arkade_sdk_broadcast_or_next_input",
            });
          } else {
            logArkadeSignTrace("signature_verified", {
              msg32: shortRef(msg32Hex, 10, 4),
              final_sig_ok: "skipped_tweaked_key",
              expected_next: "arkade_sdk_broadcast_or_next_input",
            });
          }
          logArkadeSignTrace("signature_aggregated", {
            msg32: shortRef(msg32Hex, 10, 4),
            sig_bytes: finalSig.length,
            expected_next: "arkade_sdk_broadcast_or_next_input",
          });
          return finalSig;
        } finally {
          if (secretNonce) {
            zeroize(secretNonce);
          }
          if (priv && this.signingKeyVault.getCachedPriv32() !== priv) {
            zeroize(priv);
          }
        }
      });
    if (this.signingKeyVault.getScopeDepth() > 0) {
      return run();
    }
    return this.signingKeyVault.withClientSigningKeyScope("standalone_msg32_sign_done", run);
  }

  async compressedPublicKey(): Promise<Uint8Array> {
    const pubCtx = await this.getPublicContext();
    return hexToBytes(pubCtx.aggregatedPk33);
  }

  async xOnlyPublicKey(): Promise<Uint8Array> {
    const pubCtx = await this.getPublicContext();
    return hexToBytes(pubCtx.aggregatedXonly32);
  }

  async clientCompressedPublicKey(): Promise<Uint8Array> {
    const pubCtx = await this.getPublicContext();
    return hexToBytes(pubCtx.clientPk33);
  }

  async clientXOnlyPublicKey(): Promise<Uint8Array> {
    const pubCtx = await this.getPublicContext();
    return hexToBytes(pubCtx.clientPk33.slice(2));
  }

  signerSession() {
    return new ArkadeRemoteSignerSession(this);
  }

  async signMessage(
    message: Uint8Array,
    signatureType: "schnorr" | "ecdsa" = "schnorr",
  ): Promise<Uint8Array> {
    if (signatureType !== "schnorr") {
      throw new Error("ArkadeRemoteIdentity supports schnorr signatures only");
    }
    const msg32 = message.length === 32 ? message : sha256(message);
    if (message.length !== 32) {
      console.log(
        `🔐 [${shortTime()} ArkadeRemoteIdentity.signMessage] sourceLen=${message.length} hashed=1`,
      );
    }
    return this.signMsg32WithCosigner(msg32);
  }

  private getInputOutpointKey(txCopy: Transaction, inputIndex: number): string | null {
    const input = txCopy.getInput(inputIndex);
    const txid =
      input?.txid instanceof Uint8Array
        ? bytesToHex(input.txid).toLowerCase()
        : String(input?.txid || "")
            .trim()
            .toLowerCase();
    const vout = Number(input?.index);
    if (!/^[a-f0-9]{64}$/.test(txid) || !Number.isInteger(vout) || vout < 0) {
      return null;
    }
    return `${txid}:${vout}`;
  }

  private buildUnsignedTxFingerprint(txCopy: Transaction): string {
    const parts: string[] = ["arkade-sign-tx-v1"];
    for (let inputIndex = 0; inputIndex < txCopy.inputsLength; inputIndex += 1) {
      const input = txCopy.getInput(inputIndex);
      const outpoint = this.getInputOutpointKey(txCopy, inputIndex) || `input:${inputIndex}`;
      const amount = input?.witnessUtxo?.amount?.toString() || "0";
      const script = input?.witnessUtxo?.script
        ? bytesToHex(input.witnessUtxo.script).toLowerCase()
        : "";
      parts.push(`in:${inputIndex}:${outpoint}:${amount}:${script}`);
    }
    for (let outputIndex = 0; outputIndex < txCopy.outputsLength; outputIndex += 1) {
      const output = txCopy.getOutput(outputIndex);
      const amount = output?.amount?.toString() || "0";
      const script = output?.script ? bytesToHex(output.script).toLowerCase() : "";
      parts.push(`out:${outputIndex}:${amount}:${script}`);
    }
    return bytesToHex(sha256(utf8ToBytes(parts.join("|")))).toLowerCase();
  }

  private prepareBoardingSweepSignJobs(
    pending: BoardingSweepApprovalState,
    txFingerprint: string,
    freshJobs: ArkadeDirectSignJob[],
    targets: number[],
  ): ArkadeDirectSignJob[] {
    const targetSet = new Set(targets);
    const scopedTargetJobs = pending.scopedSignJobs.filter((job) => targetSet.has(job.inputIndex));
    const canReuseScopedJobs =
      pending.scopedSignTxFingerprint === txFingerprint &&
      targets.every((inputIndex) => scopedTargetJobs.some((job) => job.inputIndex === inputIndex));
    if (canReuseScopedJobs) {
      logArkadeSignTrace("boarding_sweep_scoped_sign_jobs_reused", {
        approval_id: pending.id,
        tx: shortRef(txFingerprint, 12, 6),
        jobs: pending.scopedSignJobs.length,
        targets: targets.join(",") || "none",
        expected_next: "reuse_original_boarding_sweep_msg32",
      });
      return pending.scopedSignJobs;
    }

    if (
      pending.approvalToken &&
      !this.requestKeySetCovers(
        pending.approvedRequestKeys,
        freshJobs.map((job) => job.request),
      )
    ) {
      logArkadeSignTrace("boarding_sweep_scoped_sign_jobs_replaced", {
        approval_id: pending.id,
        tx: shortRef(txFingerprint, 12, 6),
        previous_tx: shortRef(pending.scopedSignTxFingerprint || "none", 12, 6),
        jobs: freshJobs.length,
        approved_requests: pending.approvedRequestKeys.size,
        expected_next: "request_exact_boarding_sweep_approval",
      });
      // Tx changed -> the exact approval token no longer matches; drop it.
      // Keep combinedAssertionAuth + session token so the re-mint reuses the
      // session (one prompt) instead of forcing a fresh PRF prompt.
      pending.approvalToken = null;
      pending.approvedRequestKeys.clear();
    }

    pending.scopedSignJobs = freshJobs;
    pending.scopedSignTxFingerprint = txFingerprint;
    return freshJobs;
  }

  private buildDirectSignJobs(
    txCopy: Transaction,
    targets: number[],
    prevScripts: Uint8Array[],
    prevAmounts: bigint[],
    aggregatedXonly32: string,
    options: {
      txFingerprint: string;
    },
  ): ArkadeDirectSignJob[] {
    const out: ArkadeDirectSignJob[] = [];
    const xOnlyPubkey = hexToBytes(aggregatedXonly32);
    const clientPk33 = this.getCredentialMeta().clientPk33;

    for (const inputIndex of targets) {
      const input = txCopy.getInput(inputIndex);
      if (!input?.witnessUtxo) continue;

      const outpointKey = this.getInputOutpointKey(txCopy, inputIndex) || `input:${inputIndex}`;
      const script = input.witnessUtxo.script;
      const isTaproot = script?.length === 34 && script[0] === 0x51 && script[1] === 0x20;
      if (!isTaproot) continue;

      const sighashType = input.sighashType || btc.SigHash.DEFAULT;
      let inputMatched = false;
      const tapLeafScripts = Array.isArray(input.tapLeafScript) ? input.tapLeafScript : [];

      if (Array.isArray(tapLeafScripts) && tapLeafScripts.length > 0) {
        for (const leaf of tapLeafScripts) {
          if (!Array.isArray(leaf) || leaf.length < 2) continue;
          const scriptWithVersion = leaf[1];
          if (!(scriptWithVersion instanceof Uint8Array) || scriptWithVersion.length < 2) continue;
          const leafScript = scriptWithVersion.subarray(0, -1);
          const leafVersion = scriptWithVersion[scriptWithVersion.length - 1];
          let decoded: unknown[] = [];
          try {
            decoded = btc.Script.decode(leafScript);
          } catch {
            continue;
          }
          if (!scriptContainsXOnlyPubkey(decoded, xOnlyPubkey)) {
            continue;
          }
          const leafMsg32 = txCopy.preimageWitnessV1(
            inputIndex,
            prevScripts,
            sighashType,
            prevAmounts,
            undefined,
            leafScript,
            leafVersion,
          );
          const msg32Hex = bytesToHex(leafMsg32).toLowerCase();
          out.push({
            path: "script",
            inputIndex,
            outpointKey,
            txFingerprint: options.txFingerprint,
            sighashType,
            msg32: leafMsg32,
            request: {
              kind: "direct",
              inputIndex,
              msg32: msg32Hex,
              clientPk33,
            },
            leafScript,
            leafVersion,
            leafHash: tapLeafHash(leafScript, leafVersion),
          });
          inputMatched = true;
        }
      }

      if (!inputMatched) {
        const msg32 = txCopy.preimageWitnessV1(inputIndex, prevScripts, sighashType, prevAmounts);
        const merkleRoot = getInputTapMerkleRoot(input);
        const tweak32 = computeTapTweak(aggregatedXonly32, merkleRoot);
        const msg32Hex = bytesToHex(msg32).toLowerCase();
        const tweak32Hex = bytesToHex(tweak32).toLowerCase();
        out.push({
          path: "key",
          inputIndex,
          outpointKey,
          txFingerprint: options.txFingerprint,
          sighashType,
          msg32,
          request: {
            kind: "direct",
            inputIndex,
            msg32: msg32Hex,
            clientPk33,
            tweak32: tweak32Hex,
          },
          tweak32,
        });
      }
    }

    return out;
  }

  async sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction> {
    if (this.boardingSweepApproval || this.recoverableApproval) {
      return this.runBoardingSweepSignExclusive(() =>
        this.signTransactionWithApproval(tx, inputIndexes),
      );
    }
    return this.signTransactionWithApproval(tx, inputIndexes);
  }

  async signMultiple(requests: SignRequest[]): Promise<Transaction[]> {
    logArkadeSignTrace("sign_multiple_start", {
      request_count: requests.length,
      expected_next: "sign_each_request_in_order",
    });
    return this.signingKeyVault.withClientSigningKeyScope("sign_multiple", async () => {
      const signed: Transaction[] = [];
      for (const request of requests) {
        signed.push(await this.sign(request.tx, request.inputIndexes));
      }
      return signed;
    });
  }

  private async signTransactionWithApproval(
    tx: Transaction,
    inputIndexes?: number[],
  ): Promise<Transaction> {
    const txCopy = tx.clone();
    const pubCtx = await this.getPublicContext();
    const xOnlyPubkey = hexToBytes(pubCtx.aggregatedXonly32);

    const targets: number[] = Array.isArray(inputIndexes)
      ? [...inputIndexes]
      : [...Array(txCopy.inputsLength).keys()];

    const prevScripts: Uint8Array[] = [];
    const prevAmounts: bigint[] = [];

    for (let i = 0; i < txCopy.inputsLength; i += 1) {
      const input = txCopy.getInput(i);
      if (!input?.witnessUtxo) {
        if (inputIndexes?.includes(i)) {
          throw new Error(`input ${i} missing witnessUtxo`);
        }
        prevScripts.push(new Uint8Array());
        prevAmounts.push(0n);
        continue;
      }
      prevScripts.push(input.witnessUtxo.script);
      prevAmounts.push(input.witnessUtxo.amount);
    }

    let approvalToken: string | null = null;
    const hasOutgoingSpendApproval = this.spendApproval.hasActive();
    const hasReceiveClaimApproval = Boolean(this.receiveClaimApproval);
    const hasBoardingSweepApproval = Boolean(this.boardingSweepApproval);
    const hasRecoverableApproval = Boolean(this.recoverableApproval);
    const activeApprovalScopes = [
      hasOutgoingSpendApproval,
      hasReceiveClaimApproval,
      hasBoardingSweepApproval,
      hasRecoverableApproval,
    ].filter(Boolean).length;
    if (activeApprovalScopes > 1) {
      throw new Error("multiple Arkade approval scopes are active");
    }
    if (activeApprovalScopes === 0) {
      logArkadeSignTrace("approval_scope_missing_transaction_sign_blocked", {
        inputs: targets.length,
        expected_next:
          "start_native_send_receive_claim_boarding_sweep_or_recoverable_approval_first",
      });
      throw new Error("Arkade transaction signing requires approval scope");
    }
    const txPsbtB64 = base64.encode(txCopy.toPSBT());
    const txFingerprint = this.buildUnsignedTxFingerprint(txCopy);
    const boardingSweepPending = this.boardingSweepApproval;
    const signJobTargets = boardingSweepPending ? [...Array(txCopy.inputsLength).keys()] : targets;
    const freshDirectSignJobs = this.buildDirectSignJobs(
      txCopy,
      signJobTargets,
      prevScripts,
      prevAmounts,
      pubCtx.aggregatedXonly32,
      {
        txFingerprint,
      },
    );
    const directSignJobs = boardingSweepPending
      ? this.prepareBoardingSweepSignJobs(
          boardingSweepPending,
          txFingerprint,
          freshDirectSignJobs,
          targets,
        )
      : freshDirectSignJobs;
    const directApprovalRequests = directSignJobs.map((job) => job.request);
    if (this.receiveClaimApproval) {
      const inputOutpoints = targets.map((inputIndex) => {
        const input = txCopy.getInput(inputIndex);
        const txid =
          input?.txid instanceof Uint8Array
            ? bytesToHex(input.txid).toLowerCase()
            : String(input?.txid || "missing").toLowerCase();
        const vout = Number(input?.index);
        return `${txid}:${Number.isInteger(vout) && vout >= 0 ? vout : "missing"}`;
      });
      logArkadeSignTrace("receive_claim_psbt_inputs", {
        swap_id: shortRef(this.receiveClaimApproval.swapId, 12, 6),
        input_indexes: targets.join(",") || "none",
        input_outpoints: inputOutpoints.join(",") || "none",
        sign_request_count: directApprovalRequests.length,
        expected_next: "receive_claim_approve_with_same_psbt",
      });
    }
    if (this.recoverableApproval) {
      logArkadeSignTrace("recoverable_psbt_inputs", {
        approval_id: this.recoverableApproval.id,
        input_indexes: targets.join(",") || "none",
        sign_request_count: directApprovalRequests.length,
        expected_next: "recoverable_approve_with_same_psbt",
      });
    }
    if (this.boardingSweepApproval) {
      const inputOutpoints = targets.map((inputIndex) => {
        const input = txCopy.getInput(inputIndex);
        const txid =
          input?.txid instanceof Uint8Array
            ? bytesToHex(input.txid).toLowerCase()
            : String(input?.txid || "missing").toLowerCase();
        const vout = Number(input?.index);
        return `${txid}:${Number.isInteger(vout) && vout >= 0 ? vout : "missing"}`;
      });
      logArkadeSignTrace("boarding_sweep_psbt_inputs", {
        approval_id: this.boardingSweepApproval.id,
        selected_count: this.boardingSweepApproval.selectedOutpoints.length,
        selected_total: this.boardingSweepApproval.selectedTotalSats,
        input_indexes: targets.join(",") || "none",
        input_outpoints: inputOutpoints.join(",") || "none",
        approval_input_indexes: signJobTargets.join(",") || "none",
        tx: shortRef(txFingerprint, 12, 6),
        sign_request_count: directApprovalRequests.length,
        expected_next: "boarding_sweep_approve_with_same_psbt",
      });
    }
    approvalToken = hasOutgoingSpendApproval
      ? await this.spendApproval.prepareAndEnsure(
          txPsbtB64,
          pubCtx.clientPk33,
          directApprovalRequests,
        )
      : hasReceiveClaimApproval
        ? await this.ensureReceiveClaimApproval(txPsbtB64, directApprovalRequests)
        : hasRecoverableApproval
          ? await this.ensureRecoverableApproval(txPsbtB64, directApprovalRequests)
          : await this.ensureBoardingSweepApproval(txPsbtB64, directApprovalRequests);
    if (!approvalToken) {
      throw new Error("scoped Arkade transaction signing requires approval token");
    }
    const directSignJobsByInputIndex = new Map<number, ArkadeDirectSignJob[]>();
    for (const job of directSignJobs) {
      const existing = directSignJobsByInputIndex.get(job.inputIndex);
      if (existing) {
        existing.push(job);
      } else {
        directSignJobsByInputIndex.set(job.inputIndex, [job]);
      }
    }

    return this.signingKeyVault.withClientSigningKeyScope("tx_sign_done", async () => {
      let signed = 0;
      let signedKeyPath = 0;
      let signedScriptPath = 0;

      for (const inputIndex of targets) {
        const input = txCopy.getInput(inputIndex);
        if (!input?.witnessUtxo) {
          if (inputIndexes) {
            throw new Error(`input ${inputIndex} missing witnessUtxo`);
          }
          continue;
        }

        const script = input.witnessUtxo.script;
        const isTaproot = script?.length === 34 && script[0] === 0x51 && script[1] === 0x20;
        if (!isTaproot) {
          if (inputIndexes) {
            throw new Error(`input ${inputIndex} is not taproot`);
          }
          continue;
        }

        const inputJobs = directSignJobsByInputIndex.get(inputIndex) || [];
        if (!inputJobs.length) {
          if (inputIndexes) {
            throw new Error(`input ${inputIndex} has no sign job`);
          }
          continue;
        }

        let inputSigned = false;
        for (const job of inputJobs) {
          if (job.path !== "script") continue;
          const leafSig64 = await this.signMsg32WithCosigner(
            job.msg32,
            undefined,
            approvalToken,
            job.inputIndex,
            job.request,
          );
          const leafSig = appendTaprootSighash(leafSig64, job.sighashType);
          txCopy.updateInput(
            inputIndex,
            {
              tapScriptSig: [[{ pubKey: xOnlyPubkey, leafHash: job.leafHash }, leafSig]],
            },
            true,
          );
          inputSigned = true;
        }

        if (inputSigned) {
          signedScriptPath += 1;
        } else {
          const keyJob = inputJobs.find(
            (job): job is Extract<ArkadeDirectSignJob, { path: "key" }> => job.path === "key",
          );
          if (!keyJob) {
            throw new Error(`input ${inputIndex} missing key-path sign job`);
          }
          const finalSig64 = await this.signMsg32WithCosigner(
            keyJob.msg32,
            keyJob.tweak32,
            approvalToken,
            keyJob.inputIndex,
            keyJob.request,
          );
          const finalSig = appendTaprootSighash(finalSig64, keyJob.sighashType);

          txCopy.updateInput(inputIndex, {
            tapKeySig: finalSig,
            tapInternalKey: hexToBytes(pubCtx.aggregatedXonly32),
          });
          signedKeyPath += 1;
        }

        signed += 1;
      }

      if (inputIndexes && signed !== inputIndexes.length) {
        throw new Error(`requested ${inputIndexes.length} signatures, produced ${signed}`);
      }
      if (!inputIndexes && signed === 0) {
        throw new Error("No inputs signed");
      }

      console.log(
        `🔐 [${shortTime()} ArkadeRemoteIdentity.sign] signed=${signed} keyPath=${signedKeyPath} scriptPath=${signedScriptPath} inputs=${targets.length}`,
      );
      if (hasReceiveClaimApproval && this.receiveClaimApproval) {
        emitArkadeReceiveUnlockProgress({
          phase: "claim_signed",
          reason: "receive_claim_tx_signed",
          id: shortRef(this.receiveClaimApproval.swapId, 16, 6),
        });
      }

      if (hasOutgoingSpendApproval) {
        const onSigned = this.spendApproval.takeOnSigned();
        if (onSigned) await onSigned(txCopy.id);
      }

      return txCopy;
    });
  }
}
