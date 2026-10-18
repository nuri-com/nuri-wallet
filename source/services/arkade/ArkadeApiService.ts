import { ARKADE_HTTP_TIMEOUT_MS } from "../../config/constants";
import { errMsg, errName } from "../../lib/errorMessage";
import { shortTime } from "../../lib/logShared";
import { arkadeServerConfigService } from "./ArkadeServerConfigService";
import {
  adoptServerSettlementMinExpiryGapSeconds,
  getSettlementMinExpiryGapMs,
  loadSettlementMinExpiryGapMs,
} from "./internal/vtxoSettleability";
import {
  ARKADE_CLIENT_VERSION,
  ARKADE_EXPECTED_SIGNER_SERVER,
  ARKADE_SDK_HINT,
  formatArkadeVersionMatrix,
} from "./ArkadeVersion";

export type ArkadeApiTrace = {
  atMs: number;
  op: string;
  method: string;
  path: string;
  status: string;
  durMs: number;
  timeoutMs: number;
  auth: boolean;
  reason?: string;
};

export type ArkadeRelativeTimelock = {
  type: "blocks" | "seconds";
  value: number;
};

export type ArkadeRecoveryPolicy = {
  type?: string;
  nuri_server_csv?: ArkadeRelativeTimelock;
  cooperative_path?: string;
  recovery_path?: string;
  client_key_exit_after_csv?: boolean;
  server_key_required_before_csv?: boolean;
  server_key_expires?: boolean;
};

export type ArkadeCosignerDerivation = {
  derivation_version?: string;
  nuri_server_csv?: ArkadeRelativeTimelock;
  recovery_policy?: ArkadeRecoveryPolicy;
  wallet_id?: string;
  client_pubkey?: string;
  server_pubkey?: string;
  path?: string;
  account_public_key?: string;
  account_chain_code?: string;
  account_fingerprint?: string;
};

export type ArkadeRecoveryStatus = {
  registered: boolean;
  passkey_pubkey_policy: string;
  passkey_pubkey_present: boolean;
  passkey_pubkey_fingerprint: string;
  identity_id: string;
  backup_present: boolean;
  backup_ciphertext_hash: string;
  backup_ciphertext_size: number;
  backup_updated_at_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
};

export type ArkadeEncryptedRecoveryBackup = {
  format: string;
  encryption: string;
  nonce_b64u: string;
  aad_b64u?: string;
  ciphertext_b64u: string;
  ciphertext_hash?: string;
  ciphertext_size?: number;
  created_at_ms: number;
  updated_at_ms?: number;
};

export type ArkadeRecoveryBackupUploadResponse = {
  ok: boolean;
  public_envelope?: Record<string, unknown>;
  recovery?: ArkadeRecoveryStatus;
};

export type ArkadeRecoveryBackupReadResponse = {
  ok: boolean;
  public_envelope?: Record<string, unknown>;
  encrypted_backup: ArkadeEncryptedRecoveryBackup;
  recovery?: ArkadeRecoveryStatus;
};

export type ArkadeCredentialHintResponse = {
  username: string;
  credential_id_b64u: string;
};

export type ArkadeBootstrapClaimAuthResponse = {
  token: string;
  challenge: string;
  rp_id: string;
  origin?: string;
  username: string;
};

type ArkadeRecoveryContractFields = {
  nuri_server_api?: string;
  nuri_server_version?: string;
  nuri_contract_version?: string;
  nuri_contract_type?: string;
  arkade_sdk_version?: string;
  bitcoin_tx_version?: string;
  arkade_csv?: string;
  nuri_csv?: ArkadeRelativeTimelock;
  token_key_fingerprint?: string;
  passkey_pubkey_policy?: string;
  recovery_store?: string;
  recovery_backup_format?: string;
  cosigner_derivation_version?: string;
  cosigner_account_public_key?: string;
  cosigner_account_chain_code?: string;
  cosigner_account_fingerprint?: string;
  nuri_server_csv?: ArkadeRelativeTimelock;
  recovery_policy?: ArkadeRecoveryPolicy;
  cosigner_derivation?: ArkadeCosignerDerivation;
  recovery?: ArkadeRecoveryStatus;
};

const traceSubscribers: Set<(trace: ArkadeApiTrace) => void> = new Set();

function emitTrace(trace: ArkadeApiTrace): void {
  traceSubscribers.forEach((cb) => {
    try {
      cb(trace);
    } catch {}
  });
}

export function subscribeArkadeApiTrace(callback: (trace: ArkadeApiTrace) => void): () => void {
  traceSubscribers.add(callback);
  return () => {
    traceSubscribers.delete(callback);
  };
}

export type ArkadeAssertionFields = {
  token: string;
  clientDataB64u: string;
  authDataB64u: string;
  sigB64u: string;
};

type AssertionFields = ArkadeAssertionFields;

export type ArkadeHealthResponse = ArkadeRecoveryContractFields & {
  ok: boolean;
  version?: string;
  token_ttl_ms?: number;
  mode?: string;
  /** Same value as on `/arkade/info`, in seconds; `null` when unset. */
  settlement_min_expiry_gap_seconds?: number | null;
};

export type ArkadeAuthResponse = ArkadeRecoveryContractFields & {
  token: string;
  challenge: string;
  rp_id: string;
  origin?: string;
  server_pubkey?: string;
  server_version?: string;
};

export type ArkadeInfoResponse = ArkadeRecoveryContractFields & {
  server_pubkey: string;
  /** Public handle only when credId + client signer key match the stored owner. */
  username?: string | null;
  server_version?: string;
  /**
   * The Ark operator's minimum settlement expiry gap in SECONDS, mirrored by our
   * server so a client knows it BEFORE its first send (arkd publishes it
   * nowhere — see internal/vtxoSettleability). `null` when that deployment was
   * never told the value; absent on servers older than
   * nuri-server-musig2-v4-arkade#75.
   */
  settlement_min_expiry_gap_seconds?: number | null;
};

export type ArkadeSignResponse = ArkadeRecoveryContractFields & {
  server_partial32: string;
  server_pub_nonce66: string;
  server_pubkey: string;
  server_version?: string;
  cached?: boolean;
};

export type ArkadeApiSendPrepareResponse = ArkadeRecoveryContractFields & {
  ok?: boolean;
  challenge_token: string;
  challenge: string;
  rp_id?: string;
  origin?: string;
  canonical_send_summary?: Record<string, unknown>;
  expires_at_ms?: number;
  server_version?: string;
};

export type ArkadeApiSendCosignResponse = ArkadeRecoveryContractFields & {
  session_id?: string;
  txid?: string;
  server_partial32?: string;
  server_pub_nonce66?: string;
  server_pubkey?: string;
  server_version?: string;
  ttl_ms?: number;
  cached?: boolean;
};

export type ArkadeApiSendCompleteResponse = ArkadeRecoveryContractFields & {
  ok?: boolean;
  send_intent_id?: string;
  route_scope?: string;
  txid?: string;
  consumed_at_ms?: number;
  cosign_count?: number;
  server_version?: string;
};

export type ArkadeLnurlRegisterResponse = {
  ok: boolean;
  username: string;
  lightning_address: string;
  evm_address?: string | null;
  arkade_address?: string | null;
  btc_address?: string | null;
  lnurl_base_url: string;
  callback_url: string;
  min_sendable_msat: number;
};

export type ArkadeLnurlStatusResponse = {
  ok: boolean;
  username: string | null;
  registered: boolean;
  lightning_address: string | null;
  evm_address?: string | null;
  /** Whether `evm_address` is proven by its own signature (older servers omit it). */
  evm_address_verified?: boolean;
  arkade_address?: string | null;
  btc_address?: string | null;
  email?: string | null;
  lnurlp_url?: string;
  callback_url?: string;
  min_sendable_msat?: number;
  max_sendable_msat?: number;
  has_published_invoice?: boolean;
  invoice_expires_at_ms?: number;
};

export type ArkadeLnurlSetProfileResponse = {
  ok: boolean;
  username: string;
  evm_address: string | null;
  evm_address_verified?: boolean;
  arkade_address?: string | null;
  btc_address?: string | null;
  email?: string | null;
};

export type ArkadeLnurlNamesResponse = {
  ok: boolean;
  /** Lowercase address -> username, null where no single user proved it. */
  names: Record<string, string | null>;
};

export type ArkadeLnurlPendingSwap = {
  id: string;
  username: string;
  invoice: string;
  preimage_hex: string;
  preimage_hash_hex: string;
  amount_msat: number;
  status: string;
  created_at_ms: number;
  updated_at_ms: number;
};

export type ArkadeLnurlPendingSwapsResponse = {
  ok: boolean;
  pending_swaps: ArkadeLnurlPendingSwap[];
};

export type ArkadeReceiveOwner = {
  credIdB64u: string;
  clientPublicKey33Hex: string;
};

export type ArkadeReceiveRestore = {
  id: string;
  type: "reverse";
  createdAt: number;
  preimage: string;
  status: string;
  request?: Record<string, unknown> | null;
  response?: Record<string, unknown> | null;
};

export type ArkadeReceiveLightningRow = {
  id?: string;
  receive_id?: string;
  type: "lightning";
  source?: string;
  status?: string;
  swap_id?: string;
  username?: string;
  invoice?: string;
  payment_hash_hex?: string;
  preimage_hash_hex?: string;
  preimage_hex?: string;
  amount_msat?: number;
  expires_at_ms?: number;
  boltz_status?: string;
  created_at_ms?: number;
  updated_at_ms?: number;
  restore?: ArkadeReceiveRestore | null;
};

export type ArkadeReceiveBoardingRow = {
  id?: string;
  receive_id?: string;
  type: "boarding";
  source?: string;
  status?: string;
  boarding_address?: string;
  address_preview?: string;
  txid?: string;
  vout?: number;
  value_sats?: number;
  script_pubkey?: string;
  scriptPubKey?: string;
  confirmations?: number;
  chain_status?: string;
  first_seen_at_ms?: number;
  updated_at_ms?: number;
  sweep?: Record<string, unknown>;
};

export type ArkadeReceiveRow = ArkadeReceiveLightningRow | ArkadeReceiveBoardingRow;

export type ArkadeReceiveInvoiceResponse = ArkadeRecoveryContractFields & {
  ok: boolean;
  swap_id: string;
  invoice: string;
  payment_hash_hex?: string;
  amount_msat: number;
  expires_at_ms: number;
  status?: string;
  source: "app_invoice";
  restore?: ArkadeReceiveRestore | null;
};

export type ArkadeReceiveSyncResponse = ArkadeRecoveryContractFields & {
  ok: boolean;
  receives: ArkadeReceiveRow[];
  lightning?: ArkadeReceiveLightningRow[];
  boarding?: ArkadeReceiveBoardingRow[];
  boarding_address?: {
    address: string;
    address_preview?: string;
    metadata?: Record<string, unknown>;
    updated_at_ms?: number;
  } | null;
};

export type ArkadeReceiveBoardingAddressResponse = ArkadeRecoveryContractFields & {
  ok: boolean;
  boarding_address?: {
    address: string;
    address_preview?: string;
    metadata?: Record<string, unknown>;
    updated_at_ms?: number;
  };
};

export type ArkadeReceiveClaimApproveResponse = ArkadeRecoveryContractFields & {
  ok: boolean;
  approval_token: string;
  approval_scope: "receive_claim";
  swap_id: string;
  claim_session_token?: string;
  claim_session_expires_at_ms?: number;
  request_count?: number;
  approved_at_ms?: number;
};

export type ArkadeBoardingSweepApproveResponse = ArkadeRecoveryContractFields & {
  ok: boolean;
  approval_token: string;
  approval_scope: "boarding_sweep";
  selected_outpoints?: string[];
  selected_total_sats?: number;
  boarding_sweep_session_token?: string;
  boarding_sweep_session_expires_at_ms?: number;
  request_count?: number;
  approved_at_ms?: number;
  expires_at_ms?: number;
};

export type ArkadeRecoverableApproveResponse = ArkadeRecoveryContractFields & {
  ok: boolean;
  approval_token: string;
  approval_scope: "recoverable_wallet_update";
  recoverable_session_token?: string;
  recoverable_session_expires_at_ms?: number;
  request_count?: number;
  approved_at_ms?: number;
  expires_at_ms?: number;
};

export type ArkadeSwapIntentResponse = {
  ok: boolean;
  intent: {
    id: string;
    kind: string;
    final_recipient: string;
    final_amount_sats?: number;
    output_asset?: string;
    output_amount?: number;
    output_chain?: string;
    route_id?: string;
    refund_locktime?: number;
    funding_address?: string;
    funding_script_hex?: string;
    funding_amount_sats: number;
    payment_hash?: string;
    invoice?: string;
    expires_at_ms: number;
  };
  approval_summary: {
    kind: string;
    title: string;
    recipient: string;
    amount_sats: number;
    note: string;
    source: string;
    final_recipient: string;
    final_amount_sats?: number;
    output_asset?: string;
    output_amount?: number;
    output_chain?: string;
    route_id?: string;
    refund_locktime?: number;
    payment_hash?: string;
  };
};

function shortPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search || ""}`;
  } catch {
    return url;
  }
}

function buildHeaders(contentTypeJson: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Arkade-Client": ARKADE_CLIENT_VERSION,
    "X-Arkade-Sdk": ARKADE_SDK_HINT,
  };
  if (contentTypeJson) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

function buildSignerUrl(path: string): string {
  const base = arkadeServerConfigService.getSignerServerUrl().replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

function buildSignerOriginUrl(path: string): string {
  const base = arkadeServerConfigService
    .getSignerServerUrl()
    .replace(/\/+$/, "")
    .replace(/\/v4$/i, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

function buildReceiveApiUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return buildSignerOriginUrl(`/api/arkade/receive${normalizedPath}`);
}

function buildSendApiUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return buildSignerOriginUrl(`/api/arkade/send${normalizedPath}`);
}

function receiveOwnerBody(owner: ArkadeReceiveOwner): Record<string, unknown> {
  return {
    cred_id_b64u: owner.credIdB64u,
    client_public_key_33_hex: owner.clientPublicKey33Hex,
  };
}

function hasAuthorizationHeader(headers: RequestInit["headers"]): boolean {
  if (!headers) return false;
  if (headers instanceof Headers) {
    return headers.has("Authorization");
  }
  if (Array.isArray(headers)) {
    return headers.some(([key]) => String(key).toLowerCase() === "authorization");
  }
  const record = headers as Record<string, string>;
  return Object.keys(record).some((key) => String(key).toLowerCase() === "authorization");
}

async function fetchWithTimeout(op: string, url: string, init: RequestInit): Promise<Response> {
  const startMs = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ARKADE_HTTP_TIMEOUT_MS);
  const method = String(init.method || "GET");
  const path = shortPath(url);
  const authEnabled = hasAuthorizationHeader(init.headers);

  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    const durMs = Date.now() - startMs;
    emitTrace({
      atMs: Date.now(),
      op,
      method,
      path,
      status: String(res.status),
      durMs,
      timeoutMs: ARKADE_HTTP_TIMEOUT_MS,
      auth: authEnabled,
    });
    // No console.log here: NetworkLogger (global fetch wrapper) already emits the
    // richer `🌐 CALL <method> <host><path> ←<status>` line for this same call.
    // The structured emitTrace above still feeds the debug-trace UI. (#640 C3)
    return res;
  } catch (error: unknown) {
    const name = errName(error);
    const durMs = Date.now() - startMs;
    const reason =
      name === "AbortError" ? `timeout_${ARKADE_HTTP_TIMEOUT_MS}ms` : errMsg(error, "fetch_failed");
    emitTrace({
      atMs: Date.now(),
      op,
      method,
      path,
      status: "ERR",
      durMs,
      timeoutMs: ARKADE_HTTP_TIMEOUT_MS,
      auth: authEnabled,
      reason,
    });
    // No console.log here: NetworkLogger already emits the `🌐 … ×ERR` line for
    // this failed call; `reason` is preserved in emitTrace above. (#640 C3)
    if (name === "AbortError") {
      throw new Error(
        `${op} timeout after ${ARKADE_HTTP_TIMEOUT_MS}ms path=${path} auth=${authEnabled ? 1 : 0}`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function parseJsonResponse<T>(op: string, res: Response): Promise<T> {
  if (res.ok) {
    return (await res.json()) as T;
  }

  const text = await res.text().catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  const parsedRecord =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;

  const parsedError =
    parsedRecord && typeof parsedRecord.error === "string" ? parsedRecord.error : "";
  const message = parsedError || (text ? text.slice(0, 220) : `HTTP ${res.status}`);

  const parsedDetails =
    parsedRecord && typeof parsedRecord.details === "string" ? parsedRecord.details.trim() : "";
  const details = parsedDetails ? `: ${parsedDetails}` : "";

  throw new Error(
    `${op} http_${res.status} path=${shortPath(res.url || "n/a")} message=${message}${details}`,
  );
}

function toRequestBody(
  assertion: AssertionFields,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    token: assertion.token,
    client_data_b64u: assertion.clientDataB64u,
    auth_data_b64u: assertion.authDataB64u,
    sig_b64u: assertion.sigB64u,
    ...payload,
  };
}

let settlementGapLoad: Promise<number | null> | null = null;

/**
 * Load the operator's settlement window before any balance, history, or send
 * classifies VTXOs. Persisted state handles normal starts; `/health` covers an
 * existing signed-in session that never called `/arkade/info` after the server
 * began publishing the value.
 */
export async function ensureSettlementMinExpiryGapMs(): Promise<number | null> {
  const stored = await loadSettlementMinExpiryGapMs();
  if (stored !== null) return stored;
  if (!settlementGapLoad) {
    settlementGapLoad = arkadeHealth()
      .then(() => getSettlementMinExpiryGapMs())
      .catch((): null => null)
      .finally(() => {
        settlementGapLoad = null;
      });
  }
  return settlementGapLoad;
}

export async function arkadeHealth(): Promise<ArkadeHealthResponse> {
  const res = await fetchWithTimeout("health", buildSignerUrl("/health"), {
    method: "GET",
    headers: buildHeaders(false),
  });
  const out = await parseJsonResponse<ArkadeHealthResponse>("health", res);
  // Health is unauthenticated, so a client that has not signed in yet still
  // learns the gap here.
  await adoptServerSettlementMinExpiryGapSeconds(out?.settlement_min_expiry_gap_seconds).catch(
    (): null => null,
  );
  console.log(
    `🔐 [${shortTime()} src=services/arkade/ArkadeApiService.ts#arkadeHealth INFO FLOW grp=Bitcoin] client=${ARKADE_CLIENT_VERSION} sdk=${ARKADE_SDK_HINT} expectedServer=${ARKADE_EXPECTED_SIGNER_SERVER} gotServer=${String(out?.version || "n/a")} ${formatArkadeVersionMatrix(
      {
        arkadeCsv: out?.arkade_csv,
        nuriCsv: out?.nuri_csv || out?.nuri_server_csv,
        serverVersion: out?.nuri_server_version || out?.version,
      },
    )}`,
  );
  return out;
}

export async function arkadeInfo(params: {
  credIdB64u: string;
  credPubkeyB64u?: string;
  clientSignerPubkeyHex: string;
}): Promise<ArkadeInfoResponse> {
  let url =
    `${buildSignerUrl("/arkade/info")}?cred_id_b64u=${encodeURIComponent(params.credIdB64u)}` +
    `&client_signer_pubkey=${encodeURIComponent(params.clientSignerPubkeyHex)}`;
  if (params.credPubkeyB64u) {
    url += `&cred_pubkey_b64u=${encodeURIComponent(params.credPubkeyB64u)}`;
  }

  const res = await fetchWithTimeout("info", url, {
    method: "GET",
    headers: buildHeaders(false),
  });
  const info = await parseJsonResponse<ArkadeInfoResponse>("info", res);
  // Adopted here rather than at the call sites: every flow that reaches the
  // server for wallet info should teach the client the gap, and a client that
  // knows it never has to discover it from a failed send.
  await adoptServerSettlementMinExpiryGapSeconds(info?.settlement_min_expiry_gap_seconds).catch(
    (): null => null,
  );
  return info;
}

export async function arkadeAuthBegin(params: {
  credIdB64u: string;
  credPubkeyB64u?: string;
  clientSignerPubkeyHex: string;
}): Promise<ArkadeAuthResponse> {
  const res = await fetchWithTimeout("auth", buildSignerUrl("/arkade/auth"), {
    method: "POST",
    headers: buildHeaders(true),
    body: JSON.stringify({
      cred_id_b64u: params.credIdB64u,
      cred_pubkey_b64u: params.credPubkeyB64u,
      client_signer_pubkey: params.clientSignerPubkeyHex,
    }),
  });
  const out = await parseJsonResponse<ArkadeAuthResponse>("auth", res);
  console.log(
    `🔐 [${shortTime()} src=services/arkade/ArkadeApiService.ts#arkadeAuthBegin INFO FLOW grp=Bitcoin] client=${ARKADE_CLIENT_VERSION} expectedServer=${ARKADE_EXPECTED_SIGNER_SERVER} gotServer=${String(out?.server_version || "n/a")} ${formatArkadeVersionMatrix(
      {
        arkadeCsv: out?.arkade_csv,
        nuriCsv: out?.nuri_csv || out?.nuri_server_csv,
        serverVersion: out?.nuri_server_version || out?.server_version,
      },
    )}`,
  );
  return out;
}

export async function arkadeApiSendPrepare(
  payload: Record<string, unknown>,
): Promise<ArkadeApiSendPrepareResponse> {
  const res = await fetchWithTimeout("apiSendPrepare", buildSendApiUrl("/prepare"), {
    method: "POST",
    headers: buildHeaders(true),
    body: JSON.stringify(payload),
  });
  return parseJsonResponse<ArkadeApiSendPrepareResponse>("apiSendPrepare", res);
}

export async function arkadeApiSendCosign<T extends ArkadeApiSendCosignResponse>(
  assertion: AssertionFields,
  challengeToken: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const res = await fetchWithTimeout("apiSendCosign", buildSendApiUrl("/cosign"), {
    method: "POST",
    headers: buildHeaders(true),
    body: JSON.stringify({
      challenge_token: challengeToken,
      client_data_b64u: assertion.clientDataB64u,
      auth_data_b64u: assertion.authDataB64u,
      sig_b64u: assertion.sigB64u,
      ...payload,
    }),
  });
  return parseJsonResponse<T>("apiSendCosign", res);
}

export async function arkadeApiSendComplete(payload: {
  challenge_token: string;
  send_intent_id: string;
  txid?: string;
}): Promise<ArkadeApiSendCompleteResponse> {
  const res = await fetchWithTimeout("apiSendComplete", buildSendApiUrl("/complete"), {
    method: "POST",
    headers: buildHeaders(true),
    body: JSON.stringify(payload),
  });
  return parseJsonResponse<ArkadeApiSendCompleteResponse>("apiSendComplete", res);
}

/**
 * Vouches to the notification server that this wallet owns `subscriptionId`.
 * The server holds no wallet identity and verifies no passkeys — arkade does
 * that here (it already runs `verifyAssertion`) and forwards the binding.
 *
 * Deliberately its own endpoint rather than a field on `/arkade/lnurl/register`:
 * that one runs once, when a username is claimed, so existing users and anyone
 * switching notifications on later would never bind.
 */
export async function arkadeBindNotificationSubscription(
  assertion: AssertionFields,
  subscriptionId: string,
): Promise<void> {
  const res = await fetchWithTimeout(
    "bindNotificationSubscription",
    buildSignerUrl("/arkade/notifications/bind"),
    {
      method: "POST",
      headers: buildHeaders(true),
      body: JSON.stringify(toRequestBody(assertion, { subscription_id: subscriptionId })),
    },
  );
  if (!res.ok) throw new Error(`arkade bind failed: HTTP ${res.status}`);
}

export async function arkadeRecoveryBackupUpload(
  assertion: AssertionFields,
  backup: ArkadeEncryptedRecoveryBackup,
): Promise<ArkadeRecoveryBackupUploadResponse> {
  const res = await fetchWithTimeout(
    "recoveryBackupUpload",
    buildSignerUrl("/arkade/recovery/backup"),
    {
      method: "POST",
      headers: buildHeaders(true),
      body: JSON.stringify(toRequestBody(assertion, { backup })),
    },
  );
  return parseJsonResponse<ArkadeRecoveryBackupUploadResponse>("recoveryBackupUpload", res);
}

export async function arkadeRecoveryBackupRead(
  assertion: AssertionFields,
): Promise<ArkadeRecoveryBackupReadResponse> {
  const res = await fetchWithTimeout(
    "recoveryBackupRead",
    buildSignerUrl("/arkade/recovery/backup/read"),
    {
      method: "POST",
      headers: buildHeaders(true),
      body: JSON.stringify(toRequestBody(assertion, {})),
    },
  );
  return parseJsonResponse<ArkadeRecoveryBackupReadResponse>("recoveryBackupRead", res);
}

export async function arkadeCredentialHintOrNull(
  username: string,
): Promise<ArkadeCredentialHintResponse | null> {
  const res = await fetchWithTimeout(
    "credentialHint",
    buildSignerUrl(`/arkade/lnurl/credential-hint/${encodeURIComponent(username)}`),
    { method: "GET", headers: buildHeaders(false) },
  );
  // Only an authoritative 404 means the username is available to claim.
  // Timeouts and every other server error must block account creation.
  if (res.status === 404) return null;
  return parseJsonResponse<ArkadeCredentialHintResponse>("credentialHint", res);
}

export async function arkadeCredentialHint(
  username: string,
): Promise<ArkadeCredentialHintResponse> {
  const hint = await arkadeCredentialHintOrNull(username);
  if (!hint) throw new Error("credentialHint http_404 message=username_not_found");
  return hint;
}

export async function arkadeBootstrapClaimAuth(payload: {
  username: string;
  cred_id_b64u: string;
  cred_pubkey_b64u: string;
}): Promise<ArkadeBootstrapClaimAuthResponse> {
  const res = await fetchWithTimeout(
    "bootstrapClaimAuth",
    buildSignerUrl("/arkade/lnurl/register-bootstrap/auth"),
    {
      method: "POST",
      headers: buildHeaders(true),
      body: JSON.stringify(payload),
    },
  );
  return parseJsonResponse<ArkadeBootstrapClaimAuthResponse>("bootstrapClaimAuth", res);
}

export async function arkadeBootstrapClaimRegister(
  assertion: AssertionFields,
  payload: {
    username: string;
    client_signer_pubkey: string;
    evm_address?: string;
    arkade_address?: string;
    btc_address?: string;
  },
): Promise<ArkadeLnurlRegisterResponse> {
  const res = await fetchWithTimeout(
    "bootstrapClaimRegister",
    buildSignerUrl("/arkade/lnurl/register-bootstrap"),
    {
      method: "POST",
      headers: buildHeaders(true),
      body: JSON.stringify(toRequestBody(assertion, payload)),
    },
  );
  return parseJsonResponse<ArkadeLnurlRegisterResponse>("bootstrapClaimRegister", res);
}

export async function arkadeLnurlRegister(
  assertion: AssertionFields,
  payload: {
    username: string;
    client_pk33?: string;
    aggregated_pk33?: string;
    evm_address?: string;
    arkade_address?: string;
    btc_address?: string;
  },
): Promise<ArkadeLnurlRegisterResponse> {
  const res = await fetchWithTimeout("lnurlRegister", buildSignerUrl("/arkade/lnurl/register"), {
    method: "POST",
    headers: buildHeaders(true),
    body: JSON.stringify(toRequestBody(assertion, payload as Record<string, unknown>)),
  });
  return parseJsonResponse<ArkadeLnurlRegisterResponse>("lnurlRegister", res);
}

export async function arkadeLnurlStatus(
  assertion: AssertionFields,
  payload?: {
    username?: string;
  },
): Promise<ArkadeLnurlStatusResponse> {
  const res = await fetchWithTimeout("lnurlStatus", buildSignerUrl("/arkade/lnurl/status"), {
    method: "POST",
    headers: buildHeaders(true),
    body: JSON.stringify(toRequestBody(assertion, (payload || {}) as Record<string, unknown>)),
  });
  return parseJsonResponse<ArkadeLnurlStatusResponse>("lnurlStatus", res);
}

// The server updates only the fields present in the payload; at least one
// address field is required.
export async function arkadeLnurlSetProfile(
  assertion: AssertionFields,
  payload: {
    username: string;
    evm_address?: string;
    /** personal_sign by evm_address of "nuri-evm-binding-v1:<credIdB64u>". */
    evm_address_signature?: string;
    arkade_address?: string;
    btc_address?: string;
    email?: string;
  },
): Promise<ArkadeLnurlSetProfileResponse> {
  const res = await fetchWithTimeout(
    "lnurlSetProfile",
    buildSignerUrl("/arkade/lnurl/set-profile"),
    {
      method: "POST",
      headers: buildHeaders(true),
      body: JSON.stringify(toRequestBody(assertion, payload as Record<string, unknown>)),
    },
  );
  return parseJsonResponse<ArkadeLnurlSetProfileResponse>("lnurlSetProfile", res);
}

// Usernames for up to 100 EVM addresses, named only where one user proved the
// address (see the server's /arkade/lnurl/names).
export async function arkadeLnurlNames(
  assertion: AssertionFields,
  addresses: string[],
): Promise<ArkadeLnurlNamesResponse> {
  const res = await fetchWithTimeout("lnurlNames", buildSignerUrl("/arkade/lnurl/names"), {
    method: "POST",
    headers: buildHeaders(true),
    body: JSON.stringify(toRequestBody(assertion, { addresses })),
  });
  return parseJsonResponse<ArkadeLnurlNamesResponse>("lnurlNames", res);
}

export async function arkadeLnurlPendingSwaps(
  assertion: AssertionFields,
): Promise<ArkadeLnurlPendingSwapsResponse> {
  const res = await fetchWithTimeout(
    "lnurlPendingSwaps",
    buildSignerUrl("/arkade/lnurl/pending-swaps"),
    {
      method: "POST",
      headers: buildHeaders(true),
      body: JSON.stringify(toRequestBody(assertion, {})),
    },
  );
  return parseJsonResponse<ArkadeLnurlPendingSwapsResponse>("lnurlPendingSwaps", res);
}

export async function arkadeReceiveInvoice(
  owner: ArkadeReceiveOwner,
  payload: {
    amount_sats?: number;
    amount_msat?: number;
    memo?: string;
  },
): Promise<ArkadeReceiveInvoiceResponse> {
  const res = await fetchWithTimeout("receiveInvoice", buildReceiveApiUrl("/invoice"), {
    method: "POST",
    headers: buildHeaders(true),
    body: JSON.stringify({
      ...receiveOwnerBody(owner),
      ...payload,
    }),
  });
  return parseJsonResponse<ArkadeReceiveInvoiceResponse>("receiveInvoice", res);
}

// Owner-keyed single-flight. Several receive flows (screen sync loop, unlock
// refresh, foreground monitor, wallet-summary listener, claim resume) can fire
// arkadeReceiveSync for the same owner at once; concurrent same-owner callers
// share one in-flight request instead of a sync storm. Key is public (cred id +
// client pubkey), no secrets. Cleared in finally so the next burst fetches fresh.
const inFlightReceiveSync = new Map<string, Promise<ArkadeReceiveSyncResponse>>();

export async function arkadeReceiveSync(
  owner: ArkadeReceiveOwner,
): Promise<ArkadeReceiveSyncResponse> {
  const key = `${owner.credIdB64u}:${owner.clientPublicKey33Hex}`;
  const existing = inFlightReceiveSync.get(key);
  if (existing) return existing;
  const request = (async () => {
    const res = await fetchWithTimeout("receiveSync", buildReceiveApiUrl("/sync"), {
      method: "POST",
      headers: buildHeaders(true),
      body: JSON.stringify(receiveOwnerBody(owner)),
    });
    return parseJsonResponse<ArkadeReceiveSyncResponse>("receiveSync", res);
  })();
  inFlightReceiveSync.set(key, request);
  try {
    return await request;
  } finally {
    inFlightReceiveSync.delete(key);
  }
}

export async function arkadeReceiveBoardingAddress(
  assertion: AssertionFields,
  payload: {
    boarding_address: string;
    metadata?: Record<string, unknown>;
  },
): Promise<ArkadeReceiveBoardingAddressResponse> {
  const res = await fetchWithTimeout(
    "receiveBoardingAddress",
    buildReceiveApiUrl("/boarding-address"),
    {
      method: "POST",
      headers: buildHeaders(true),
      body: JSON.stringify(toRequestBody(assertion, payload as Record<string, unknown>)),
    },
  );
  return parseJsonResponse<ArkadeReceiveBoardingAddressResponse>("receiveBoardingAddress", res);
}

export async function arkadeReceiveClaimApprove(
  assertion: AssertionFields | null,
  payload: {
    swap_id: string;
    psbt_b64: string;
    sign_requests: Array<Record<string, unknown>>;
    claim_session_token?: string;
  },
): Promise<ArkadeReceiveClaimApproveResponse> {
  const body = assertion
    ? toRequestBody(assertion, payload as Record<string, unknown>)
    : (payload as Record<string, unknown>);
  const res = await fetchWithTimeout("receiveClaimApprove", buildReceiveApiUrl("/claim/approve"), {
    method: "POST",
    headers: buildHeaders(true),
    body: JSON.stringify(body),
  });
  return parseJsonResponse<ArkadeReceiveClaimApproveResponse>("receiveClaimApprove", res);
}

export async function arkadeBoardingSweepApprove(
  assertion: AssertionFields | null,
  payload: {
    selected_outpoints: string[];
    selected_total_sats: number;
    psbt_b64: string;
    sign_requests: Array<Record<string, unknown>>;
    boarding_sweep_session_token?: string;
  },
): Promise<ArkadeBoardingSweepApproveResponse> {
  const body = assertion
    ? toRequestBody(assertion, payload as Record<string, unknown>)
    : (payload as Record<string, unknown>);
  const res = await fetchWithTimeout(
    "boardingSweepApprove",
    buildReceiveApiUrl("/boarding/sweep/approve"),
    {
      method: "POST",
      headers: buildHeaders(true),
      body: JSON.stringify(body),
    },
  );
  return parseJsonResponse<ArkadeBoardingSweepApproveResponse>("boardingSweepApprove", res);
}

export async function arkadeRecoverableApprove(
  assertion: AssertionFields | null,
  payload: {
    psbt_b64: string;
    sign_requests: Array<Record<string, unknown>>;
    recoverable_session_token?: string;
  },
): Promise<ArkadeRecoverableApproveResponse> {
  // Session-token mode (no assertion) skips the PRF prompt — the server mints
  // the session on the first assertion-backed approve and authorizes
  // subsequent per-checkpoint approves within the same recoverable operation.
  const body = assertion
    ? toRequestBody(assertion, payload as Record<string, unknown>)
    : (payload as Record<string, unknown>);
  const res = await fetchWithTimeout(
    "recoverableApprove",
    buildReceiveApiUrl("/recoverable/approve"),
    {
      method: "POST",
      headers: buildHeaders(true),
      body: JSON.stringify(body),
    },
  );
  return parseJsonResponse<ArkadeRecoverableApproveResponse>("recoverableApprove", res);
}

export async function arkadeSwapIntentCreate(
  assertion: AssertionFields | null,
  payload: {
    kind: string;
    cred_id_b64u: string;
    client_signer_pubkey: string;
    final_recipient: string;
    final_amount_sats?: number;
    output_asset?: string;
    output_amount?: number;
    output_chain?: string;
    route_id?: string;
    refund_locktime?: number;
    funding_address?: string;
    funding_script_hex?: string;
    funding_amount_sats: number;
    payment_hash?: string;
    invoice?: string;
    provider?: string;
    rfq_id?: string;
    lockup_address?: string;
  },
): Promise<ArkadeSwapIntentResponse> {
  const res = await fetchWithTimeout(
    "swapIntentCreate",
    buildSignerUrl("/arkade/swap-intent/create"),
    {
      method: "POST",
      headers: buildHeaders(true),
      body: JSON.stringify(
        assertion ? toRequestBody(assertion, payload as Record<string, unknown>) : payload,
      ),
    },
  );
  return parseJsonResponse<ArkadeSwapIntentResponse>("swapIntentCreate", res);
}
