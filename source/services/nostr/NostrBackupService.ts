import { DEFAULT_NOSTR_RELAYS } from "../../config/endpoints";
import {
  aeadDecryptX,
  aeadEncryptX,
  base64urlToBytes,
  bytesToBase64url,
  bytesToHex,
  bytesToUtf8,
  hkdfSha256,
  randomBytes,
  schnorr,
  sha256,
  utf8ToBytes,
  zeroize,
} from "../../lib/crypto";
import { signEvent, type NostrEvent } from "../../lib/nostr/nostr";
import {
  fetchNewestNostrEventFromRelays,
  publishNostrEventToRelays,
} from "../../lib/nostr/relayPublish";
import { getNostrPrivateKey } from "../../lib/secureKeyStorage";
import { ensureDmRelayListPublished } from "./NostrDmRelayListService";

// NIP-78 addressable app-data events: relays keep only the latest event per
// (pubkey, kind, d-tag), so every publish replaces the previous backup.
// Content is an already-encrypted ArkadeEncryptedRecoveryBackup JSON blob
// (XChaCha20-Poly1305, key derived from the passkey PRF) — relays only ever
// see ciphertext. The signing key is the support-chat Nostr key, itself
// derived from the wallet key, so the whole backup is recoverable from the
// passkey alone, without Nuri.
export const NOSTR_BACKUP_KIND = 30078;
export const NOSTR_BACKUP_D_TAG_EXIT = "nuri:arkade:exit:v1";
export const NOSTR_BACKUP_D_TAG_FULL = "nuri:arkade:recovery:v1";
export const NOSTR_BACKUP_D_TAG_SWAPKIT = "nuri:swapkit:active:v1";

const SWAPKIT_BACKUP_FORMAT = "nuri-swapkit-active-v1";
const SWAPKIT_BACKUP_ENCRYPTION = "xchacha20poly1305-hkdf-sha256-nostr-key-v1";
const SWAPKIT_BACKUP_SALT = sha256(utf8ToBytes("nuri:swapkit:backup:salt:v1"));
const SWAPKIT_BACKUP_INFO = utf8ToBytes("nuri:swapkit:active:v1");

const RELAY_URLS = [
  String(process.env.EXPO_PUBLIC_NOSTR_BACKUP_RELAY || "").trim(),
  ...DEFAULT_NOSTR_RELAYS,
].filter(Boolean);
const RELAY_TIMEOUT_MS = 8_000;
// ponytail: public relays commonly reject events >~128KB; if the full backup
// outgrows this we drop it and rely on the exit-essential event — chunking
// (multiple d-tags) is the upgrade path if that ever becomes the norm.
// A dropped event is recorded as "oversize" below so the UI can warn (#1636).
const MAX_EVENT_CONTENT_CHARS = 100_000;

export type NostrBackupPayload = {
  dTag: string;
  contentJson: string;
};

// Outcome of the latest publish attempt per d-tag, readable by the UI.
// lastPublishedAtMs only moves when at least one relay acked the event, so an
// "oversize" or "failed" state still shows when the last good backup was.
export type NostrBackupPublishStatus = {
  dTag: string;
  state: "published" | "oversize" | "failed";
  contentChars: number;
  attemptedAtMs: number;
  lastPublishedAtMs: number | null;
  error?: string;
};

const publishStatusByDTag = new Map<string, NostrBackupPublishStatus>();

function recordPublishStatus(
  dTag: string,
  state: NostrBackupPublishStatus["state"],
  contentChars: number,
  error?: string,
): void {
  const now = Date.now();
  const previous = publishStatusByDTag.get(dTag);
  publishStatusByDTag.set(dTag, {
    dTag,
    state,
    contentChars,
    attemptedAtMs: now,
    lastPublishedAtMs: state === "published" ? now : (previous?.lastPublishedAtMs ?? null),
    ...(error ? { error } : {}),
  });
}

export function getNostrBackupPublishStatus(dTag: string): NostrBackupPublishStatus | null {
  return publishStatusByDTag.get(dTag) ?? null;
}

/**
 * Publish encrypted backup blobs to Nostr relays under the user's support-chat
 * identity. The Nostr key is provisioned by the canonical wallet-access flow,
 * so this never opens its own prompt or silently skips a missing chat-created
 * identity. Fire-and-forget safe.
 */
export async function publishEncryptedBackupsToNostr(
  payloads: NostrBackupPayload[],
): Promise<void> {
  if (!payloads.length) return;
  let sk: Uint8Array | null = null;
  const recorded = new Set<string>();
  try {
    sk = await getNostrPrivateKey();
    const pubkey = bytesToHex(schnorr.getPublicKey(sk));
    // Keep this identity reachable by NIP-17 senders even if the user never
    // opens the support chat on this install.
    await ensureDmRelayListPublished(sk);
    for (const payload of payloads) {
      if (payload.contentJson.length > MAX_EVENT_CONTENT_CHARS) {
        recordPublishStatus(payload.dTag, "oversize", payload.contentJson.length);
        recorded.add(payload.dTag);
        console.warn(
          `[NostrBackupService] NOT published ${payload.dTag}: content ${payload.contentJson.length} chars exceeds ${MAX_EVENT_CONTENT_CHARS} status=oversize`,
        );
        continue;
      }
      const unsigned: NostrEvent = {
        kind: NOSTR_BACKUP_KIND,
        pubkey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["d", payload.dTag]],
        content: payload.contentJson,
      };
      const result = await publishNostrEventToRelays(
        RELAY_URLS,
        signEvent(unsigned, sk),
        RELAY_TIMEOUT_MS,
      );
      recordPublishStatus(
        payload.dTag,
        result.ackedOk > 0 ? "published" : "failed",
        payload.contentJson.length,
      );
      recorded.add(payload.dTag);
      console.log(
        `[NostrBackupService] published ${payload.dTag} size=${payload.contentJson.length} relays=${result.tried} opened=${result.opened} acked=${result.ackedOk}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const payload of payloads) {
      if (!recorded.has(payload.dTag)) {
        recordPublishStatus(payload.dTag, "failed", payload.contentJson.length, message);
      }
    }
    console.log(`[NostrBackupService] publish failed: ${message}`);
  } finally {
    if (sk) zeroize(sk);
  }
}

type SwapKitSnapshotOrder = {
  kind?: "card_topup" | "discovered";
  txId: string;
  settleTarget: string;
  expectedUsdc: number;
  minEurc?: number;
  usdcBaseline: string;
  sats: number;
  createdAt: number;
  attempts: number;
  // The order-bound Arkade refund address. It pins the sats' origin at create
  // time; without it a restored row falls back to the wallet's CURRENT receive
  // address, which the provider rejects as an unrecognised refund target.
  arkadeRefundAddress?: string;
  recovery?: {
    provider?: string;
    keyIndex?: number;
    actionId?: string;
    operation?: string;
    externalId?: string;
    providerExternalId?: string;
    deadline?: string | number;
    status?: string;
    transactionHashes?: string[];
    fixedFloatExchangeSubmittedAt?: number;
    publicState?: Record<string, unknown>;
    // The approval binding of an action-style sweep. Without it a restored row
    // fails the tracker's isSweepClaim guard, so the loop starts without a
    // signer and ignores the server's action forever — the swap never finishes.
    chainId?: number;
    approvalToken?: string;
    // The ceiling any approval on a restored sweep row may carry. Absent, the
    // signer refuses to approve at all rather than sign an unbounded allowance.
    approvalMaxUnits?: string;
    // What a sweep deposit was, and the hash it went out with. Reporting that
    // hash to the server at funding time is best effort, so after local storage
    // is lost this is the only durable copy left that can re-report it — without
    // it a restored row polls as unfunded while the funds are long gone.
    depositTo?: string;
    depositAmount?: string;
    depositTxHash?: string;
  };
};

/**
 * Encrypt the non-secret active-swap resume coordinates before mirroring them
 * to Nostr. The encryption key is domain-separated from the wallet-derived
 * Nostr key, and neither that key nor provider recovery secrets enter content.
 */
export async function publishSwapKitRecoverySnapshotToNostr(
  orders: ReadonlyArray<SwapKitSnapshotOrder>,
): Promise<void> {
  let sk: Uint8Array | null = null;
  let key: Uint8Array | null = null;
  let plaintext: Uint8Array | null = null;
  try {
    sk = await getNostrPrivateKey();
    key = hkdfSha256(sha256(sk), SWAPKIT_BACKUP_SALT, SWAPKIT_BACKUP_INFO, 32);
    const createdAtMs = Date.now();
    const snapshot = {
      format: SWAPKIT_BACKUP_FORMAT,
      createdAtMs,
      orders: orders.map((order) => ({
        txId: order.txId,
        kind: order.kind,
        settleTarget: order.settleTarget,
        expectedUsdc: order.expectedUsdc,
        ...(order.minEurc != null ? { minEurc: order.minEurc } : {}),
        usdcBaseline: order.usdcBaseline,
        sats: order.sats,
        createdAt: order.createdAt,
        attempts: order.attempts,
        ...(order.arkadeRefundAddress ? { arkadeRefundAddress: order.arkadeRefundAddress } : {}),
        ...(order.recovery
          ? {
              recovery: {
                provider: order.recovery.provider,
                keyIndex: order.recovery.keyIndex,
                actionId: order.recovery.actionId,
                operation: order.recovery.operation,
                externalId: order.recovery.externalId,
                providerExternalId: order.recovery.providerExternalId,
                deadline: order.recovery.deadline,
                status: order.recovery.status,
                transactionHashes: order.recovery.transactionHashes,
                fixedFloatExchangeSubmittedAt: order.recovery.fixedFloatExchangeSubmittedAt,
                publicState: order.recovery.publicState,
                chainId: order.recovery.chainId,
                approvalToken: order.recovery.approvalToken,
                approvalMaxUnits: order.recovery.approvalMaxUnits,
                depositTo: order.recovery.depositTo,
                depositAmount: order.recovery.depositAmount,
                depositTxHash: order.recovery.depositTxHash,
              },
            }
          : {}),
      })),
    };
    const aad = utf8ToBytes(
      JSON.stringify({
        format: SWAPKIT_BACKUP_FORMAT,
        encryption: SWAPKIT_BACKUP_ENCRYPTION,
        createdAtMs,
      }),
    );
    const nonce = randomBytes(24);
    plaintext = utf8ToBytes(JSON.stringify(snapshot));
    const ciphertext = aeadEncryptX(key, nonce, plaintext, aad);
    await publishEncryptedBackupsToNostr([
      {
        dTag: NOSTR_BACKUP_D_TAG_SWAPKIT,
        contentJson: JSON.stringify({
          format: SWAPKIT_BACKUP_FORMAT,
          encryption: SWAPKIT_BACKUP_ENCRYPTION,
          nonce_b64u: bytesToBase64url(nonce),
          aad_b64u: bytesToBase64url(aad),
          ciphertext_b64u: bytesToBase64url(ciphertext),
          created_at_ms: createdAtMs,
        }),
      },
    ]);
  } finally {
    if (plaintext) zeroize(plaintext);
    if (key) zeroize(key);
    if (sk) zeroize(sk);
  }
}

/**
 * Fetch and decrypt the newest active-swap snapshot this wallet published.
 * Authenticity comes from the AEAD: only ciphertext produced with the key
 * derived from THIS wallet's Nostr key decrypts, so no separate event
 * signature check is needed. Returns null on any miss or failure — callers
 * fall back to the bounds-less discovered path.
 */
export async function restoreSwapKitRecoverySnapshotFromNostr(): Promise<
  SwapKitSnapshotOrder[] | null
> {
  let sk: Uint8Array | null = null;
  let key: Uint8Array | null = null;
  let plaintext: Uint8Array | null = null;
  try {
    sk = await getNostrPrivateKey();
    const pubkey = bytesToHex(schnorr.getPublicKey(sk));
    const event = await fetchNewestNostrEventFromRelays(
      RELAY_URLS,
      {
        kinds: [NOSTR_BACKUP_KIND],
        authors: [pubkey],
        "#d": [NOSTR_BACKUP_D_TAG_SWAPKIT],
        limit: 1,
      },
      RELAY_TIMEOUT_MS,
    );
    if (!event?.content) return null;
    const blob = JSON.parse(event.content) as {
      format?: string;
      encryption?: string;
      nonce_b64u?: string;
      aad_b64u?: string;
      ciphertext_b64u?: string;
    };
    if (
      blob.format !== SWAPKIT_BACKUP_FORMAT ||
      blob.encryption !== SWAPKIT_BACKUP_ENCRYPTION ||
      !blob.nonce_b64u ||
      !blob.aad_b64u ||
      !blob.ciphertext_b64u
    ) {
      return null;
    }
    key = hkdfSha256(sha256(sk), SWAPKIT_BACKUP_SALT, SWAPKIT_BACKUP_INFO, 32);
    plaintext = aeadDecryptX(
      key,
      base64urlToBytes(blob.nonce_b64u),
      base64urlToBytes(blob.ciphertext_b64u),
      base64urlToBytes(blob.aad_b64u),
    );
    if (!plaintext) return null;
    const snapshot = JSON.parse(bytesToUtf8(plaintext)) as { orders?: unknown };
    return Array.isArray(snapshot.orders) ? (snapshot.orders as SwapKitSnapshotOrder[]) : null;
  } catch (error) {
    console.log(
      `[NostrBackupService] snapshot restore failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  } finally {
    if (plaintext) zeroize(plaintext);
    if (key) zeroize(key);
    if (sk) zeroize(sk);
  }
}
