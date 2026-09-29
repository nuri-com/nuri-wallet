// lib/wirex/bridgeCallback.ts
//
// Wirex passkey approval bridge — client-side envelope wrapper.
//
// When a REST call needs a signature, the backend returns an `approval_url`.
// Instead of opening it in a browser, we sign on-device and POST an encrypted
// envelope to the bridge callback. This module builds that envelope so it
// byte-matches the server's `decryptEnvelope`/`assertBridgePayload` (see the
// nuri-wirex-mcp bridge implementation):
//
//   plaintext  = JSON({ version, state, intent, address, message, signature,
//                       public_key?, credentialIdB64u? })
//   sharedX    = ECDH(ephemeralPriv, client_pubkey).x        (32 bytes, Node computeSecret)
//   salt       = sha256(utf8(`${VERSION}:${state}`))
//   key        = HKDF-SHA256(sharedX, salt, utf8(RESPONSE_INFO), 32)
//   ciphertext = AES-256-GCM(key, iv=12rand, plaintext)      (noble appends 16-byte tag)
//   envelope   = { version, state, alg, epk(uncompressed b64u), iv(b64u), ciphertext(b64u) }
//
// The `sign` function is injected by the caller (reuses the on-device EOA
// keychain signer). This module never touches the private signing key.

import { getBytes } from "ethers";

import { p256 } from "@noble/curves/nist";

import {
  aesGcm,
  bytesToBase64url,
  base64urlToBytes,
  hkdfSha256,
  randomBytes,
  sha256,
  utf8ToBytes,
  zeroize,
} from "../crypto";
import {
  WIREX_BRIDGE_ENVELOPE_ALG,
  WIREX_BRIDGE_RESPONSE_INFO,
  WIREX_BRIDGE_VERSION,
} from "../../services/wirex/wirexConfig";

type SignFn = (payload: {
  message: string | Uint8Array;
}) => Promise<{ address: string; signature: string; publicKey?: string }>;

interface SubmitSignedApprovalParams {
  approvalUrl: string;
  sign: SignFn;
  credentialIdB64u?: string;
  // Wallet passkey SPKI pubkey (b64u) for the backend to install as an
  // additional smart-account signer next to the EOA (server reads
  // payload.credentialPubkeyB64u; the credential id rides the existing
  // credentialIdB64u field). Must be on the ONBOARD envelope — the register
  // UserOp is prepared server-side before the register envelope is signed.
  // Public data only; optional (EOA-only registration when absent).
  credentialPubkeyB64u?: string;
  // Fired exactly once, right before the callback POST — the point of no return.
  // Everything above is read-only approval loading plus local sign/encryption;
  // no approval has been submitted yet. Callers persist any durable "in-flight"
  // marker here so a signing/biometric failure BEFORE the POST leaves no marker,
  // while a lost POST response does. If this throws, the POST is not sent.
  onBeforeCallbackPost?: () => Promise<void> | void;
}

// Parsed subset of the approval_url we consume. `siwe` is phase-2; we throw if
// it's the only mode present.
interface ParsedApproval {
  state: string;
  intent: string;
  callback: string;
  clientPubkey: Uint8Array; // uncompressed P-256 (65 bytes)
  message: string; // hash hex (0x…) in hash mode, or the UTF-8 string in msg mode
  messageToSign: string | Uint8Array; // raw bytes in hash mode, string in msg mode
}

type ParsedApprovalMessage = Pick<ParsedApproval, "message" | "messageToSign">;

// The plaintext payload the server decrypts. Field names must NOT contain any
// secret-like token (private/secret/seed/mnemonic/prf/…) — the server rejects
// those via assertNoSecretFieldNames.
interface BridgePayload {
  version: string;
  state: string;
  intent: string;
  address: string;
  message: string;
  signature: string;
  public_key?: string;
  credentialIdB64u?: string;
  credentialPubkeyB64u?: string;
}

interface BridgeEnvelope {
  version: string;
  state: string;
  alg: string;
  epk: string;
  iv: string;
  ciphertext: string;
}

function requireParam(params: URLSearchParams, name: string): string {
  const value = params.get(name);
  if (!value) throw new Error(`approval_url_missing_${name}`);
  return value;
}

function parseHashMessage(hash: string): ParsedApprovalMessage {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error("approval_url_hash_must_be_0x_32_bytes");
  }
  return { message: hash, messageToSign: getBytes(hash) };
}

function parseTextMessage(text: string): ParsedApprovalMessage {
  if (!text.trim() || text.length > 4096) throw new Error("approval_payload_sign_text_invalid");
  return { message: text, messageToSign: text };
}

async function fetchApprovalMessage(
  approvalUrl: URL,
  callback: string,
  state: string,
): Promise<ParsedApprovalMessage> {
  const sessionId = requireParam(approvalUrl.searchParams, "session_id");
  const callbackUrl = new URL(callback);
  const allowedHost =
    callbackUrl.hostname === "localhost" || callbackUrl.hostname.endsWith(".nuri.com");
  if (callbackUrl.origin !== approvalUrl.origin || !allowedHost) {
    throw new Error("approval_payload_origin_invalid");
  }

  const callbackPath = `/mcp/api/browser-sessions/${encodeURIComponent(sessionId)}/callback`;
  if (callbackUrl.pathname !== callbackPath) throw new Error("approval_payload_callback_invalid");

  const endpoint = new URL(callbackUrl);
  endpoint.pathname = callbackPath.replace(/\/callback$/, "/approval");
  endpoint.search = "";
  endpoint.hash = "";
  endpoint.searchParams.set("state", state);

  const response = await fetch(endpoint.toString(), {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`approval_payload_failed:${response.status}`);

  const payload = (await response.json()) as {
    sign_hash?: unknown;
    sign_text?: unknown;
    siwe?: unknown;
  };
  if (typeof payload.sign_hash === "string") return parseHashMessage(payload.sign_hash);
  if (typeof payload.sign_text === "string") return parseTextMessage(payload.sign_text);
  if (payload.siwe) throw new Error("approval_url_siwe_mode_not_supported");
  throw new Error("approval_payload_missing_sign_hash_or_text");
}

async function parseApprovalUrl(approvalUrl: string): Promise<ParsedApproval> {
  const url = new URL(approvalUrl);
  const params = url.searchParams;

  const state = requireParam(params, "state");
  const intent = requireParam(params, "intent");
  const callback = requireParam(params, "callback");
  const clientPubkeyB64u = requireParam(params, "client_pubkey");
  const clientPubkey = base64urlToBytes(clientPubkeyB64u);

  const hash = params.get("hash");
  const msg = params.get("msg");
  const siwe = params.get("siwe");

  if (hash) {
    return { state, intent, callback, clientPubkey, ...parseHashMessage(hash) };
  }

  if (msg) {
    const text = new TextDecoder().decode(base64urlToBytes(msg));
    return { state, intent, callback, clientPubkey, ...parseTextMessage(text) };
  }

  if (siwe) {
    throw new Error("approval_url_siwe_mode_not_supported");
  }

  return {
    state,
    intent,
    callback,
    clientPubkey,
    ...(await fetchApprovalMessage(url, callback, state)),
  };
}

// ECDH shared secret = X coordinate only (32 bytes), matching Node's
// crypto.createECDH('prime256v1').computeSecret(epk). noble's getSharedSecret
// returns a 33-byte compressed point (prefix || 32-byte X); we take the X.
function deriveEnvelopeKey(
  ephemeralSecret: Uint8Array,
  clientPubkey: Uint8Array,
  state: string,
): Uint8Array {
  const sharedPoint = p256.getSharedSecret(ephemeralSecret, clientPubkey);
  const sharedX = sharedPoint.slice(1, 33);
  zeroize(sharedPoint);

  const salt = sha256(utf8ToBytes(`${WIREX_BRIDGE_VERSION}:${state}`));
  const info = utf8ToBytes(WIREX_BRIDGE_RESPONSE_INFO);
  const key = hkdfSha256(sharedX, salt, info, 32);
  zeroize(sharedX);
  return key;
}

function buildEnvelope(payload: BridgePayload, parsed: ParsedApproval): BridgeEnvelope {
  const ephemeralSecret = p256.utils.randomSecretKey();
  const ephemeralPublicKey = p256.getPublicKey(ephemeralSecret, false); // uncompressed, 65 bytes

  const key = deriveEnvelopeKey(ephemeralSecret, parsed.clientPubkey, parsed.state);
  zeroize(ephemeralSecret);

  const iv = randomBytes(12);
  const plaintext = utf8ToBytes(JSON.stringify(payload));
  // noble gcm.encrypt returns ciphertext || 16-byte tag concatenated, exactly
  // what the server splits back apart.
  const ciphertext = aesGcm(key, iv).encrypt(plaintext);
  zeroize(key);

  return {
    version: WIREX_BRIDGE_VERSION,
    state: parsed.state,
    alg: WIREX_BRIDGE_ENVELOPE_ALG,
    epk: bytesToBase64url(ephemeralPublicKey),
    iv: bytesToBase64url(iv),
    ciphertext: bytesToBase64url(ciphertext),
  };
}

export async function submitSignedApproval(params: SubmitSignedApprovalParams): Promise<void> {
  const { approvalUrl, sign, credentialIdB64u, credentialPubkeyB64u } = params;
  const parsed = await parseApprovalUrl(approvalUrl);

  const { address, signature, publicKey } = await sign({ message: parsed.messageToSign });

  const payload: BridgePayload = {
    version: WIREX_BRIDGE_VERSION,
    state: parsed.state,
    intent: parsed.intent,
    address,
    message: parsed.message,
    signature,
    public_key: publicKey ?? undefined,
    credentialIdB64u: credentialIdB64u ?? undefined,
    credentialPubkeyB64u: credentialPubkeyB64u ?? undefined,
  };

  const envelope = buildEnvelope(payload, parsed);

  // Point of no return: signing succeeded and the callback POST is next.
  await params.onBeforeCallbackPost?.();

  const response = await fetch(parsed.callback, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`bridge_callback_failed:${response.status}:${body}`);
  }
}
