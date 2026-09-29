// Persisted lightning-send swaps, written BEFORE the wallet funds one.
//
// Not a job queue: nothing here has to run for the payment to complete. The
// corridor fills non-interactively — the solver claims the lockup with the
// preimage it learns by paying the invoice — and when a payment has to be
// unwound, the swap server notices and hands the wallet a signing step like
// any other. What this file is, is the handle: `rfqId` is the only way to look
// a swap up afterwards, and `refundLocktime` is when its unwind path opens. A
// user who funds and closes the app has both on disk rather than in a promise
// that died with the process.
//
// Everything stored is public: the negotiation id, the order id, the timelock,
// the funded address and amounts, and the descriptor and pubkey of the refund
// key the wallet provisioned for this swap. No key material, no preimage.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { bytesToHex } from "../../../lib/bytes";
import { sha256 } from "../../../lib/crypto";
import { scopeArkadeV4StorageKey } from "../ArkadeRecoveryBackupService";
import { errMsg } from "../../../lib/errorMessage";
import { emitTrace } from "./logging";
import { truncateForLog } from "./utils";
import { getCachedArkadeIdentity } from "./walletCache";

const ARKADE_LIGHTNING_SEND_STORE_VERSION = "arkade-intents-lightning-send-v1";
const ARKADE_LIGHTNING_SEND_FUNDING_OUTBOX_VERSION = "arkade-intents-funding-outbox-v1";

export type ArkadeLightningSendRecord = {
  /** The negotiation id — the only handle for looking this swap up later. */
  rfqId: string;
  /** SwapKit's own order id. */
  txId: string;
  /** The trace op this send was started under. */
  opId: string;
  paymentHash: string;
  /** When the lockup's unwind path opens, unix seconds. */
  refundLocktime: number;
  lockupAddress: string;
  /** Where a refund must pay: this wallet's own Arkade address, committed when
   * the payment started. A refund action naming anything else is refused. */
  refundAddress: string;
  /** What the lockup carries: the invoice amount plus the corridor fee. */
  fundAmountSats: number;
  /** What the invoice asks for — display only, never the funded number. */
  invoiceSats: number;
  /** The wallet descriptor the refund key was provisioned from: how its signer
   * is found again when the server asks for a signature. */
  senderDescriptor: string;
  /** That key's x-only pubkey, as bound into the lockup covenant. */
  senderPublicKey: string;
  createdAtMs: number;
  fundingTxid?: string;
};

/**
 * The key these records are scoped under: the wallet's own client pubkey, the
 * same owner the Boltz swap repository uses. Reads the CACHED identity and
 * never builds one — scoping is a storage concern and must not be able to
 * trigger a passkey prompt.
 */
export async function getArkadeLightningSendOwnerKey(): Promise<string> {
  const identity = getCachedArkadeIdentity();
  if (!identity) return "";
  try {
    const context = await identity.getSigningPublicContext();
    const ownerKey = String(context.clientPk33 || "")
      .trim()
      .toLowerCase();
    return /^[0-9a-f]{66}$/.test(ownerKey) ? ownerKey : "";
  } catch {
    return "";
  }
}

function ownerHash(ownerKey: string): string {
  const normalized = String(ownerKey || "")
    .trim()
    .toLowerCase();
  return bytesToHex(sha256(new TextEncoder().encode(normalized))).slice(0, 16);
}

function storeKey(ownerKey: string): string {
  return scopeArkadeV4StorageKey(
    `collection:ln-send:${ARKADE_LIGHTNING_SEND_STORE_VERSION}:${ownerHash(ownerKey)}`,
  );
}

function fundingOutboxKey(ownerKey: string): string {
  return scopeArkadeV4StorageKey(
    `collection:ln-send:${ARKADE_LIGHTNING_SEND_FUNDING_OUTBOX_VERSION}:${ownerHash(ownerKey)}`,
  );
}

// One writer at a time: a send saving its record while a resume deletes a
// settled one would otherwise read-modify-write over each other.
let writeQueue: Promise<void> = Promise.resolve();

// Last-resort process-local copy only. The DURABLE fallback is the independent
// funding outbox above: if the primary record update fails after wallet.send,
// recordArkadeLightningSendFunding writes {rfqId: txid} there before returning.
// This map covers the narrower case where both AsyncStorage writes fail in the
// same process; it is never treated as the restart-safe recovery path.
const pendingFundingTxids = new Map<string, string>();
const pendingFundingKey = (ownerKey: string, rfqId: string): string => `${ownerKey}\u0000${rfqId}`;
type FundingOutbox = Record<string, string>;

/**
 * The stored records, or a throw.
 *
 * A read that failed is not an empty store, and the difference decides money
 * here: every mutation below replaces the whole array, so treating a transient
 * failure as "no records" would write back a list missing every OTHER funded
 * send — losing the RFQ and the refund key descriptor those sends need to be
 * resumed and signed. Callers that only display records may soften this; the
 * ones that write must not.
 */
async function readRecordsStrict(ownerKey: string): Promise<ArkadeLightningSendRecord[]> {
  const raw = await AsyncStorage.getItem(storeKey(ownerKey));
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed as ArkadeLightningSendRecord[]) : [];
}

async function readRecords(ownerKey: string): Promise<ArkadeLightningSendRecord[]> {
  try {
    return await readRecordsStrict(ownerKey);
  } catch (error: unknown) {
    emitTrace({
      atMs: Date.now(),
      op: "ln_send_store",
      status: "read_failed",
      detail: truncateForLog(errMsg(error, "unknown"), 170),
    });
    return [];
  }
}

/**
 * Read for a mutation: a failure aborts the write with the stored records
 * untouched, and says so on the trace.
 */
async function readRecordsForMutation(
  ownerKey: string,
  op: string,
): Promise<ArkadeLightningSendRecord[]> {
  try {
    return await readRecordsStrict(ownerKey);
  } catch (error: unknown) {
    emitTrace({
      atMs: Date.now(),
      op: "ln_send_store",
      status: "mutation_read_failed",
      detail: `op=${op} why=records_left_untouched err=${truncateForLog(errMsg(error, "unknown"), 140)}`,
    });
    throw error;
  }
}

async function writeRecords(ownerKey: string, records: ArkadeLightningSendRecord[]): Promise<void> {
  await AsyncStorage.setItem(storeKey(ownerKey), JSON.stringify(records));
}

async function readFundingOutboxStrict(ownerKey: string): Promise<FundingOutbox> {
  const raw = await AsyncStorage.getItem(fundingOutboxKey(ownerKey));
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const outbox: FundingOutbox = {};
  for (const [rfqId, txid] of Object.entries(parsed as Record<string, unknown>)) {
    if (rfqId && typeof txid === "string" && txid) outbox[rfqId] = txid;
  }
  return outbox;
}

async function writeFundingOutbox(ownerKey: string, outbox: FundingOutbox): Promise<void> {
  await AsyncStorage.setItem(fundingOutboxKey(ownerKey), JSON.stringify(outbox));
}

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(work);
  // The queue itself must never reject: one failed write would otherwise poison
  // every write after it.
  writeQueue = run.then(
    (): void => undefined,
    (): void => undefined,
  );
  return run;
}

export async function listArkadeLightningSends(
  ownerKey: string,
): Promise<ArkadeLightningSendRecord[]> {
  // Fail closed on the outbox: after a primary funding annotation failed this
  // may be the ONLY persisted copy of the txid. Softening a transient read
  // failure to {} would let the poller track bare; if that answer is terminal,
  // it deletes both the primary record and the now-readable outbox, permanently
  // losing the refund handle for sats that already left (#243 P1). Propagate so
  // this wake does no tracking/deletion and the next wake retries the read.
  const durableOutbox = await readFundingOutboxStrict(ownerKey);
  const records = await readRecords(ownerKey);
  const pendingFor = (record: ArkadeLightningSendRecord): string | undefined => {
    // The primary record is authoritative once it has a txid: an older outbox
    // entry must never shadow a later successful annotation.
    if (record.fundingTxid) return undefined;
    return (
      pendingFundingTxids.get(pendingFundingKey(ownerKey, record.rfqId)) ??
      durableOutbox[record.rfqId]
    );
  };
  const merged = records.map((record) => {
    const fundingTxid = pendingFor(record);
    return fundingTxid ? { ...record, fundingTxid } : record;
  });
  if (merged.some((record, index) => record !== records[index])) {
    // Fold durable/volatile outbox entries back into the primary record through
    // the same serialized mutation queue. A repeated failure is softened: the
    // outbox remains intact and the overlaid txid is still returned to the
    // wake-up poller for its server report on this wake.
    await enqueue(async () => {
      const [current, storedOutbox] = await Promise.all([
        readRecordsForMutation(ownerKey, "retry-funding-txid"),
        readFundingOutboxStrict(ownerKey),
      ]);
      const prefix = `${ownerKey}\u0000`;
      const retryOutbox: FundingOutbox = { ...storedOutbox };
      for (const [key, txid] of pendingFundingTxids) {
        if (key.startsWith(prefix)) retryOutbox[key.slice(prefix.length)] = txid;
      }
      const consumed = new Set<string>();
      let changed = false;
      const next = current.map((record) => {
        if (record.fundingTxid) {
          consumed.add(record.rfqId); // clear a stale outbox; primary wins
          return record;
        }
        const fundingTxid = retryOutbox[record.rfqId];
        if (!fundingTxid) return record;
        consumed.add(record.rfqId);
        changed = true;
        return { ...record, fundingTxid };
      });
      if (changed) await writeRecords(ownerKey, next);
      if (consumed.size > 0) {
        for (const rfqId of consumed) delete retryOutbox[rfqId];
        await writeFundingOutbox(ownerKey, retryOutbox);
        for (const rfqId of consumed)
          pendingFundingTxids.delete(pendingFundingKey(ownerKey, rfqId));
      }
    }).catch(() => {});
  }
  return merged;
}

export function saveArkadeLightningSend(
  ownerKey: string,
  record: ArkadeLightningSendRecord,
): Promise<void> {
  return enqueue(async () => {
    const records = await readRecordsForMutation(ownerKey, "save");
    const next = records.filter((item) => item.rfqId !== record.rfqId);
    next.push(record);
    await writeRecords(ownerKey, next);
    // A new durable record supersedes any volatile annotation left under this
    // owner+RFQ key (normally only possible in tests or an RFQ-id reuse bug).
    pendingFundingTxids.delete(pendingFundingKey(ownerKey, record.rfqId));
  });
}

export function updateArkadeLightningSend(
  ownerKey: string,
  rfqId: string,
  changes: Partial<Omit<ArkadeLightningSendRecord, "rfqId">>,
): Promise<void> {
  return enqueue(async () => {
    const records = await readRecordsForMutation(ownerKey, "update");
    const next = records.map((item) => (item.rfqId === rfqId ? { ...item, ...changes } : item));
    await writeRecords(ownerKey, next);
  });
}

/**
 * Note the funding txid on an already-persisted send, and never throw.
 *
 * Called after `wallet.send` has committed: the money is gone by then, so a
 * storage failure here must not be reported as a failed payment. If the primary
 * annotation fails, synchronously persist the public txid in an independent
 * owner-scoped outbox before returning. A process-local copy remains only as a
 * last fallback if both storage writes fail; listArkadeLightningSends loads the
 * durable outbox after restart, exposes its txid to the server retry, and folds
 * it back into the primary record when storage recovers.
 */
export async function recordArkadeLightningSendFunding(
  ownerKey: string,
  rfqId: string,
  fundingTxid: string,
): Promise<void> {
  const key = pendingFundingKey(ownerKey, rfqId);
  try {
    await updateArkadeLightningSend(ownerKey, rfqId, { fundingTxid });
    // Any successful durable funding write supersedes an older volatile retry
    // for this owner+RFQ (for example txid-2 after txid-1 failed).
    pendingFundingTxids.delete(key);
    // A stale durable outbox entry cannot shadow the primary record (primary
    // wins on reads), but remove it best-effort so the outbox remains bounded.
    await enqueue(async () => {
      const outbox = await readFundingOutboxStrict(ownerKey);
      if (!outbox[rfqId]) return;
      delete outbox[rfqId];
      await writeFundingOutbox(ownerKey, outbox);
    }).catch(() => {});
  } catch (error: unknown) {
    pendingFundingTxids.set(key, fundingTxid);
    emitTrace({
      atMs: Date.now(),
      op: "ln_send_store",
      status: "funding_txid_write_failed",
      id: rfqId,
      detail: `why=send_already_submitted err=${truncateForLog(errMsg(error, "unknown"), 140)}`,
    });
    try {
      await enqueue(async () => {
        const outbox = await readFundingOutboxStrict(ownerKey);
        outbox[rfqId] = fundingTxid;
        await writeFundingOutbox(ownerKey, outbox);
      });
    } catch (outboxError: unknown) {
      // Both storage paths failed. Keep the in-memory copy for this process and
      // say explicitly that restart durability was not obtained; never throw a
      // post-send error that could invite a duplicate payment.
      emitTrace({
        atMs: Date.now(),
        op: "ln_send_store",
        status: "funding_outbox_write_failed",
        id: rfqId,
        detail: `why=memory_fallback_only err=${truncateForLog(errMsg(outboxError, "unknown"), 140)}`,
      });
    }
  }
}

export function deleteArkadeLightningSend(ownerKey: string, rfqId: string): Promise<void> {
  return enqueue(async () => {
    const [records, outbox] = await Promise.all([
      readRecordsForMutation(ownerKey, "delete"),
      readFundingOutboxStrict(ownerKey),
    ]);
    await writeRecords(
      ownerKey,
      records.filter((item) => item.rfqId !== rfqId),
    );
    if (outbox[rfqId]) {
      delete outbox[rfqId];
      await writeFundingOutbox(ownerKey, outbox);
    }
    pendingFundingTxids.delete(pendingFundingKey(ownerKey, rfqId));
  });
}
