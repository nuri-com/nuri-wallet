// eSIM purchases from nadanada.me (no account, no API key), paid over Lightning
// by the wallet's own send flow. This module does the I/O; the parsing and the
// record rules live in esimModel.ts.
//
// Flow: createOrder() asks nadanada for a BOLT11 (with Nuri's referral code)
// and persists the order BEFORE anything is paid, so a closed app never loses
// the handle on a paid eSIM. The UI hands the invoice to the regular Bitcoin
// send sheet; claim() then polls /esim/complete (402 until the invoice settles,
// idempotent after) and moves the order to the owned eSIMs.
//
// Storage: the record (owned eSIMs with their install codes, pending orders)
// lives in secure storage on the device, and a copy is published to the Nostr
// relays encrypted under a key derived one-way from the wallet's Nostr key, so
// a restored wallet gets its eSIMs back. Install codes are bearer secrets: they
// never leave the device unencrypted.
import { Platform } from "react-native";
import { DEFAULT_NOSTR_RELAYS } from "../../config/endpoints";
import { decodeBolt11Facts } from "../../lib/bitcoin/lightning";
import {
  aeadDecryptX,
  aeadEncryptX,
  base64urlToBytes,
  bytesToBase64url,
  bytesToHex,
  bytesToUtf8,
  hkdfSha256,
  hmacSha256,
  randomBytes,
  schnorr,
  secp256k1,
  sha256,
  utf8ToBytes,
  zeroize,
} from "../../lib/crypto";
import { type NostrEvent, signEvent, verifyEvent } from "../../lib/nostr/event";
import { getOrCreateNostrKeypair } from "../../lib/nostr/nostr";
import {
  fetchNewestNostrEventFromRelays,
  publishNostrEventToRelays,
} from "../../lib/nostr/relayPublish";
import { deleteAuthData, getAuthData, storeAuthData } from "../../lib/secureKeyStorage";
import { createForegroundPoller, onAppForegroundEnter } from "../app/ForegroundPoller";
import { EventBus } from "../events/AppEventBusService";
import { registerLightningFundingGuard } from "../arkade/lightningFundingGuards";
import {
  type CompleteResult,
  type EsimPendingOrder,
  type EsimPlace,
  type EsimPlan,
  type EsimRecord,
  type EsimStatus,
  type OwnedEsim,
  assertInvoiceMatchesOrder,
  canDropPending,
  canReopenPayment,
  visiblePending,
  mergeRecords,
  parseComplete,
  parseCreatedOrder,
  parsePlaces,
  parsePlans,
  parseRecord,
  purchaseRequestBody,
  sameRecord,
  emptyEsimRecord,
  parseEsimStatus,
  parseTopupComplete,
  installUrlForPlatform,
} from "./esimModel";
import { ESIM_RECORD_STORAGE_KEY } from "./esimStorageKey";

/** nadanada serves no browser CORS; the web build goes through /api/nadanada. */
export const NADANADA_ORIGIN = "https://nadanada.me";
const API = `${NADANADA_ORIGIN}/api/v2`;
const TIMEOUT_MS = 20_000;
const RELAY_TIMEOUT_MS = 8_000;

export { ESIM_RECORD_STORAGE_KEY };

const BACKUP_KIND = 30078;
const BACKUP_FORMAT = "nuri-esim-v1";
const SALT = utf8ToBytes("nuri-esim-salt-v1");

function apiUrl(path: string): string {
  // The PWA's fetch interceptor (lib/web/apiProxy) rewrites this origin to the
  // same-origin /api/nadanada proxy; native calls nadanada directly.
  return `${API}${path}`;
}

async function request(
  path: string,
  init?: { method?: "GET" | "POST"; body?: unknown; answers?: number[] },
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(apiUrl(path), {
      method: init?.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    const raw = await res.text();
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      // nadanada answers maintenance and unknown paths with an HTML page under
      // a 200; never read that as data.
      throw new Error("nadanada is unavailable right now");
    }
    if (!res.ok && !(init?.answers ?? [402]).includes(res.status)) {
      const message =
        body && typeof body === "object" && "error" in body
          ? String((body as { error: unknown }).error)
          : `nadanada ${res.status}`;
      throw new Error(message);
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

let placesCache: Promise<EsimPlace[]> | null = null;

/** Every country and region nadanada sells eSIMs for (regions first). */
export function getEsimPlaces(): Promise<EsimPlace[]> {
  if (!placesCache) {
    placesCache = request("/esim/countries")
      .then(({ body }) => parsePlaces(body))
      .catch((error) => {
        placesCache = null;
        throw error;
      });
  }
  return placesCache;
}

/** The plans for one place, cheapest first. */
export async function getEsimPlans(place: EsimPlace): Promise<EsimPlan[]> {
  const query =
    place.kind === "country"
      ? `country=${encodeURIComponent(place.code)}`
      : `region=${encodeURIComponent(place.slug)}`;
  const { body } = await request(`/esim/bundles?${query}`);
  return parsePlans(body);
}

/** Install state and bundles of an owned eSIM; null when nadanada can't say. */
export async function getEsimStatus(iccid: string): Promise<EsimStatus | null> {
  try {
    const { body } = await request(`/esim/${encodeURIComponent(iccid)}`);
    return parseEsimStatus(body);
  } catch {
    return null;
  }
}

// ── Record: secure storage + encrypted relay backup ────────────────────

type BackupKeys = { sk: Uint8Array; pubkey: string; encKey: Uint8Array; slot: string };

/** One-way, domain-separated from the wallet's Nostr key (like the address book). */
async function backupKeys(): Promise<BackupKeys> {
  const nostr = await getOrCreateNostrKeypair();
  const ikm = sha256(nostr.sk);
  zeroize(nostr.sk);
  try {
    let sk = hkdfSha256(ikm, SALT, utf8ToBytes("nuri:esim:sign:v1"), 32);
    for (let i = 0; i < 256 && !secp256k1.utils.isValidSecretKey(sk); i += 1) {
      const next = sha256(sk);
      zeroize(sk);
      sk = next;
    }
    const encKey = hkdfSha256(ikm, SALT, utf8ToBytes("nuri:esim:enc:v1"), 32);
    const tagKey = hkdfSha256(ikm, SALT, utf8ToBytes("nuri:esim:tag:v1"), 32);
    const slot = bytesToHex(hmacSha256(tagKey, utf8ToBytes("esims-v1")));
    zeroize(tagKey);
    return { sk, pubkey: bytesToHex(schnorr.getPublicKey(sk)), encKey, slot };
  } finally {
    zeroize(ikm);
  }
}

function closeKeys(keys: BackupKeys): void {
  zeroize(keys.sk);
  zeroize(keys.encKey);
}

function aad(slot: string): Uint8Array {
  return utf8ToBytes(JSON.stringify({ format: BACKUP_FORMAT, d: slot }));
}

function sealRecord(keys: BackupKeys, record: EsimRecord): NostrEvent {
  const nonce = randomBytes(24);
  const plaintext = utf8ToBytes(JSON.stringify(record));
  try {
    const ciphertext = aeadEncryptX(keys.encKey, nonce, plaintext, aad(keys.slot));
    return signEvent(
      {
        kind: BACKUP_KIND,
        pubkey: keys.pubkey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["d", keys.slot]],
        content: JSON.stringify({
          format: BACKUP_FORMAT,
          nonce_b64u: bytesToBase64url(nonce),
          ciphertext_b64u: bytesToBase64url(ciphertext),
        }),
      },
      keys.sk,
    );
  } finally {
    zeroize(plaintext);
  }
}

function openRecord(keys: BackupKeys, event: NostrEvent | null): EsimRecord | null {
  if (!event || event.kind !== BACKUP_KIND || event.pubkey !== keys.pubkey) return null;
  if (!verifyEvent(event)) return null;
  try {
    const envelope = JSON.parse(event.content) as {
      format?: string;
      nonce_b64u?: string;
      ciphertext_b64u?: string;
    };
    if (envelope.format !== BACKUP_FORMAT || !envelope.nonce_b64u || !envelope.ciphertext_b64u) {
      return null;
    }
    const plaintext = aeadDecryptX(
      keys.encKey,
      base64urlToBytes(envelope.nonce_b64u),
      base64urlToBytes(envelope.ciphertext_b64u),
      aad(keys.slot),
    );
    try {
      return parseRecord(bytesToUtf8(plaintext));
    } finally {
      zeroize(plaintext);
    }
  } catch {
    return null;
  }
}

let current: EsimRecord = parseRecord(null);
let loaded: Promise<EsimRecord> | null = null;
let queue: Promise<unknown> = Promise.resolve();
const listeners = new Set<(record: EsimRecord) => void>();

/**
 * Bumped by every reset. Each async path (sync, backup, order, claim) captures
 * it when it starts and is refused once it moved: work begun for wallet A must
 * never write into, or encrypt under the keys of, the wallet that replaced it.
 */
let generation = 0;

class EsimResetError extends Error {
  constructor() {
    super("eSIM state was reset");
  }
}

function assertGeneration(gen: number): void {
  if (gen !== generation) throw new EsimResetError();
}

/** The relay copy is behind the device copy (a publish failed): retry it. */
let backupDirty = false;
/** The relay copy has been read (and merged) at least once this session. */
let relaySynced = false;

function emit(): void {
  for (const listener of listeners) listener(current);
}

export function subscribeEsims(listener: (record: EsimRecord) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function currentEsims(): EsimRecord {
  return current;
}

/**
 * Serialize record edits, so a claim and a new order never overwrite each
 * other. `gen` is the generation the caller's work started in.
 */
function edit(
  mutate: (record: EsimRecord) => EsimRecord,
  gen: number = generation,
): Promise<EsimRecord> {
  const run = queue.then(async () => {
    assertGeneration(gen);
    await loadEsims();
    assertGeneration(gen);
    const next = mutate(current);
    current = next;
    await storeAuthData(ESIM_RECORD_STORAGE_KEY, JSON.stringify(next));
    backupDirty = true;
    emit();
    void backup(gen);
    return next;
  });
  queue = run.catch(() => {});
  return run;
}

let backupChain: Promise<unknown> = Promise.resolve();

/**
 * Publish the current record (serialized, newest state at run time). Returns
 * how many relays acknowledged it; zero leaves the record dirty so the
 * tracker retries.
 */
function backup(gen: number = generation): Promise<number> {
  const run = backupChain.then(async () => {
    if (gen !== generation) return 0;
    const snapshot = current;
    let keys: BackupKeys | null = null;
    try {
      keys = await backupKeys();
      if (gen !== generation) return 0;
      const result = await publishNostrEventToRelays(
        DEFAULT_NOSTR_RELAYS,
        sealRecord(keys, snapshot),
        RELAY_TIMEOUT_MS,
      );
      if (result.ackedOk > 0 && gen === generation && snapshot === current) backupDirty = false;
      return result.ackedOk;
    } catch {
      return 0;
    } finally {
      if (keys) closeKeys(keys);
    }
  });
  backupChain = run.catch(() => {});
  return run;
}

/** The device copy, read once per wallet. */
export function loadEsims(): Promise<EsimRecord> {
  if (!loaded) {
    const gen = generation;
    loaded = (async () => {
      const stored = parseRecord(await getAuthData(ESIM_RECORD_STORAGE_KEY));
      assertGeneration(gen);
      current = stored;
      emit();
      void syncFromRelays();
      return current;
    })().catch((error) => {
      loaded = null;
      throw error;
    });
  }
  return loaded;
}

let syncing: Promise<boolean> | null = null;

/**
 * Merge the relay copy into the device copy, and publish the device copy when
 * the relays have none or an older one. Repeats (start, foreground, tracker)
 * until it has succeeded once, so a restore that began offline still runs.
 * Resolves true when the relay copy was read and merged by this pass.
 * Overlapping calls share one pass.
 */
export function syncFromRelays(): Promise<boolean> {
  if (!syncing) {
    const gen = generation;
    syncing = (async () => {
      let mergedOk = false;
      let keys: BackupKeys | null = null;
      try {
        keys = await backupKeys();
        assertGeneration(gen);
        const event = await fetchNewestNostrEventFromRelays(
          DEFAULT_NOSTR_RELAYS,
          { kinds: [BACKUP_KIND], authors: [keys.pubkey], "#d": [keys.slot], limit: 1 },
          RELAY_TIMEOUT_MS,
        );
        assertGeneration(gen);
        const remote = event ? openRecord(keys, event) : emptyEsimRecord();
        // An event we cannot read is not proof the relays are empty.
        if (!remote) return;
        relaySynced = true;
        const merged = mergeRecords(current, remote);
        if (!sameRecord(merged, current)) {
          await edit((record) => mergeRecords(record, remote), gen);
        } else if (!sameRecord(merged, remote)) {
          backupDirty = true;
        }
        mergedOk = true;
      } catch {
        // Offline or reset: the next pass retries.
      } finally {
        if (keys) closeKeys(keys);
      }
      if (gen === generation && backupDirty && hasContent(current)) await backup(gen);
      return mergedOk;
    })().finally(() => {
      syncing = null;
    });
  }
  return syncing;
}

function hasContent(record: EsimRecord): boolean {
  return record.esims.length > 0 || record.pending.length > 0 || record.doneTopups.length > 0;
}

/** Retry whatever the relays are missing (tracker tick, foreground). */
export function healEsimBackup(): Promise<void> {
  return !relaySynced || backupDirty ? syncFromRelays().then(() => {}) : Promise.resolve();
}

/**
 * Logout / factory reset / wallet replacement: forget this wallet's eSIMs.
 * Bumps the generation first, so nothing already in flight can write back,
 * then waits for the edit queue before deleting the stored copy.
 */
export async function resetEsims(): Promise<void> {
  generation += 1;
  stopTracking?.();
  await queue.catch(() => {});
  current = parseRecord(null);
  loaded = null;
  backupDirty = false;
  relaySynced = false;
  emit();
  await deleteAuthData(ESIM_RECORD_STORAGE_KEY);
}

// ── Orders ─────────────────────────────────────────────────────────────

export type EsimOrderInvoice = { invoice: string; amountSats: number; order: EsimPendingOrder };

/**
 * Create a Lightning order for one plan and persist it before returning: the
 * caller pays `invoice`; the eSIM is claimed with the order's payment hash.
 */
export async function createEsimOrder(place: EsimPlace, plan: EsimPlan): Promise<EsimOrderInvoice> {
  const gen = generation;
  const { body } = await request("/esim/purchase", {
    method: "POST",
    body: purchaseRequestBody(place, plan),
  });
  return persistOrder(gen, body, plan.name, place);
}

/**
 * Top up an owned eSIM with another bundle (same country/region pricing), no
 * reinstall. Same safety as a new order: persisted and backed up before the
 * invoice is handed out, claimed by payment hash app-wide.
 */
export async function createEsimTopup(
  esim: OwnedEsim,
  place: EsimPlace,
  plan: EsimPlan,
): Promise<EsimOrderInvoice> {
  const gen = generation;
  const { body } = await request(`/esim/${encodeURIComponent(esim.iccid)}/purchase`, {
    method: "POST",
    body: purchaseRequestBody(place, plan),
  });
  return persistOrder(gen, body, plan.name, { ...place, name: esim.placeName }, esim.iccid);
}

async function persistOrder(
  gen: number,
  body: unknown,
  bundleName: string,
  place: EsimPlace,
  topupIccid?: string,
): Promise<EsimOrderInvoice> {
  const created = parseCreatedOrder(body);
  const facts = decodeBolt11Facts(created.invoice);
  assertInvoiceMatchesOrder(created, facts, { bundleName, slug: place.slug });
  const order: EsimPendingOrder = {
    paymentHash: created.paymentHash,
    checkoutId: created.checkoutId,
    invoice: created.invoice,
    bundleName,
    placeName: place.name,
    placeSlug: place.slug,
    priceUsd: created.priceUsd,
    createdAt: Date.now(),
    expiresAt: created.expiresAt ?? facts.expiresAt * 1000,
    ...(topupIccid ? { topupIccid } : {}),
  };
  await edit((record) => ({ ...record, pending: [order, ...record.pending] }), gen);
  // The order is the only claim on what it pays for. Before any money can
  // move it must exist off this device too, so a lost or wiped phone can still
  // claim it: no relay copy, no invoice.
  if ((await backup(gen)) === 0) {
    await edit(
      (record) => ({
        ...record,
        pending: record.pending.filter((p) => p.paymentHash !== order.paymentHash),
      }),
      gen,
    ).catch(() => {});
    throw new Error("Couldn't save the order. Check your connection and try again.");
  }
  assertGeneration(gen);
  return { invoice: created.invoice, amountSats: facts.amountSats, order };
}

/**
 * Ask nadanada for the eSIM of one order. Unpaid stays pending (and is dropped
 * once its invoice is long expired); paid moves to the owned eSIMs.
 */
export async function claimEsimOrder(paymentHash: string): Promise<CompleteResult | null> {
  const gen = generation;
  const order = current.pending.find((p) => p.paymentHash === paymentHash);
  if (!order) return null;
  if (order.topupIccid) return claimTopup(order, gen);
  // 404 = nadanada has no checkout for this payment: an answer, not a failure.
  const { status, body } = await request("/esim/complete", {
    method: "POST",
    body: { paymentHash },
    answers: [402, 404],
  });
  const result = parseComplete(status, body);
  if (result.status === "unpaid") {
    if (canDropPending(order, Date.now())) {
      await edit(
        (record) => ({
          ...record,
          pending: record.pending.filter((p) => p.paymentHash !== paymentHash),
        }),
        gen,
      );
    }
    return result;
  }
  const owned: OwnedEsim = {
    iccid: result.iccid,
    bundleName: result.bundleName || order.bundleName,
    placeName: order.placeName,
    priceUsd: order.priceUsd,
    purchasedAt: Date.now(),
    paymentHash,
    install: result.install,
    checkoutId: order.checkoutId,
    orderReference: result.orderReference,
    ...(order.placeSlug ? { placeSlug: order.placeSlug } : {}),
  };
  await edit(
    (record) => mergeRecords({ ...record, esims: [owned, ...record.esims] }, emptyEsimRecord()),
    gen,
  );
  return result;
}

async function claimTopup(order: EsimPendingOrder, gen: number): Promise<CompleteResult | null> {
  const iccid = order.topupIccid as string;
  const { status, body } = await request(`/esim/${encodeURIComponent(iccid)}/complete`, {
    method: "POST",
    body: { paymentHash: order.paymentHash },
  });
  const result = parseTopupComplete(status, body);
  if (result.status === "unpaid") {
    if (canDropPending(order, Date.now())) {
      await edit(
        (record) => ({
          ...record,
          pending: record.pending.filter((p) => p.paymentHash !== order.paymentHash),
        }),
        gen,
      );
    }
    return { status: "unpaid" };
  }
  await edit(
    (record) => ({
      ...record,
      pending: record.pending.filter((p) => p.paymentHash !== order.paymentHash),
      doneTopups: [...new Set([...record.doneTopups, order.paymentHash])],
    }),
    gen,
  );
  statusListeners.forEach((listener) => listener(iccid));
  return null;
}

const statusListeners = new Set<(iccid: string) => void>();

/** Fires when an eSIM gained a bundle, so its dashboard re-reads nadanada. */
export function onEsimToppedUp(listener: (iccid: string) => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

/**
 * Whether this wallet ever started a Lightning send for a payment hash. The
 * caller supplies it (the Lightning send store lives in the Arkade layer,
 * which this service does not import); it must fail closed, true when unsure.
 */
export type SendStartedFor = (paymentHash: string) => Promise<boolean>;

/**
 * The invoice of an unpaid order, to pay it now (the user ordered and left
 * before paying). Null when it must not be paid again: the wallet started a
 * send for it, it was marked paid, or the invoice is about to expire.
 */
export async function reopenEsimPayment(
  paymentHash: string,
  sendStartedFor: SendStartedFor,
): Promise<{ invoice: string; amountSats: number } | null> {
  const gen = generation;
  try {
    // Another device may have paid it: decide on the merged relay copy only.
    await reconciledEsims(gen);
  } catch {
    return null;
  }
  const order = current.pending.find((p) => p.paymentHash === paymentHash);
  if (!order) return null;
  let started = true;
  try {
    started = await sendStartedFor(order.paymentHash);
  } catch {
    // Unsure means started: never offer an invoice that may have a send.
  }
  if (!canReopenPayment(order, Date.now(), started)) return null;
  const facts = decodeBolt11Facts(order.invoice);
  // The stored invoice is what the order is claimed with: it must still
  // commit to the order's hash and an amount.
  if (facts.paymentHash.toLowerCase() !== order.paymentHash) return null;
  if (!Number.isFinite(facts.amountSats) || facts.amountSats <= 0) return null;
  return { invoice: order.invoice, amountSats: facts.amountSats };
}

let claiming: Promise<void> | null = null;

/**
 * Claim pending orders once (all of them, or only those `which` selects).
 * Overlapping calls share one pass.
 */
export function claimPendingEsims(
  which: (order: EsimPendingOrder) => boolean = () => true,
): Promise<void> {
  if (!claiming) {
    claiming = (async () => {
      await loadEsims();
      for (const order of current.pending.filter(which)) {
        try {
          await claimEsimOrder(order.paymentHash);
        } catch {
          // nadanada or the network failed: the order stays, the next pass retries.
        }
      }
    })().finally(() => {
      claiming = null;
    });
  }
  return claiming;
}

/**
 * Load the record and merge a fresh read of the relay copy. Whether an
 * invoice was already paid is decided across devices: another device can mark
 * an order at any time, so every decision that could lead to a payment reads
 * the relays now, never relying on an earlier sync this session. Throws when
 * that read does not succeed, so callers fail closed.
 */
async function reconciledEsims(gen: number): Promise<void> {
  await loadEsims();
  const fresh = await syncFromRelays();
  assertGeneration(gen);
  if (!fresh) throw new Error("eSIM record not reconciled with its backup");
}

/**
 * Funding guard (runs right before this wallet funds a Lightning payment).
 * Decides on the merged relay copy: an eSIM order known here is not paid
 * while that merge fails. For an invoice that belongs to an eSIM order:
 * - refuses when the order already has `sendStartedAt`: a send for it began
 *   here or on another device, and a second one would fund the invoice twice;
 * - otherwise records `sendStartedAt` and backs the record up to the relays
 *   before allowing the payment. No relay acknowledgement, no payment.
 * The marker is restored with the wallet, so no device offers the invoice
 * again. A payment that is not for an eSIM order passes.
 */
export async function guardEsimInvoiceFunding(paymentHash: string): Promise<void> {
  const hash = String(paymentHash || "").toLowerCase();
  if (!hash) return;
  const gen = generation;
  let reconciled = true;
  try {
    await reconciledEsims(gen);
  } catch {
    reconciled = false;
  }
  const order = current.pending.find((p) => p.paymentHash === hash);
  // An eSIM order this device knows of is only paid on the merged copy. An
  // invoice it does not know passes even with the relays down: this guard
  // must not stop every other Lightning payment, and the app offers no eSIM
  // invoice it holds no order for.
  if (!reconciled && order) {
    throw new Error("Couldn't check your eSIM orders. Check your connection and try again.");
  }
  if (!order) return;
  if (order.sendStartedAt !== undefined || order.paidAt !== undefined) {
    throw new Error("This eSIM order already has a payment. Nothing was sent.");
  }
  await edit(
    (record) => ({
      ...record,
      pending: record.pending.map((p) =>
        p.paymentHash === hash && p.sendStartedAt === undefined
          ? { ...p, sendStartedAt: Date.now() }
          : p,
      ),
    }),
    gen,
  );
  if ((await backup(gen)) === 0) {
    throw new Error("Couldn't save the eSIM order. Check your connection and try again.");
  }
  assertGeneration(gen);
}

registerLightningFundingGuard(guardEsimInvoiceFunding);

/** Record that this wallet's own Lightning send for an order was funded. */
async function markPaid(paymentHash: string | undefined): Promise<void> {
  const hash = String(paymentHash || "")
    .trim()
    .toLowerCase();
  if (!hash) return;
  const gen = generation;
  await loadEsims();
  if (!current.pending.some((p) => p.paymentHash === hash && p.paidAt === undefined)) return;
  await edit(
    (record) => ({
      ...record,
      pending: record.pending.map((p) =>
        p.paymentHash === hash && p.paidAt === undefined ? { ...p, paidAt: Date.now() } : p,
      ),
    }),
    gen,
  );
  void claimPendingEsims();
}

const CLAIM_INTERVAL_MS = 5_000;
let stopTracking: (() => void) | null = null;

/**
 * App-wide, for the signed-in wallet: notes when the wallet pays an order and
 * claims pending orders on start, on every return to the foreground and every
 * few seconds while any are open, wherever the user is in the app.
 */
export function startEsimTracking(): () => void {
  if (stopTracking) return stopTracking;
  // Only the submitted event: it fires once the Lightning lockup is funded
  // (it carries the funding txid). "Authenticated" fires before signing and
  // can still end in no payment, which must leave the order droppable.
  const offSubmitted = EventBus.on<{ paymentHash?: string }>("bitcoin:sendSubmitted", (p) => {
    void markPaid(p?.paymentHash).catch(() => {});
  });
  const poller = createForegroundPoller({
    intervalMs: CLAIM_INTERVAL_MS,
    // Fast cadence only for orders that can still settle now (open invoice or
    // already paid); an abandoned one is rechecked on start and foreground.
    canTick: () =>
      backupDirty || !relaySynced || current.pending.some((p) => visiblePending(p, Date.now())),
    tick: () => {
      void healEsimBackup();
      void claimPendingEsims((p) => visiblePending(p, Date.now()));
    },
  });
  poller.start();
  const offForeground = onAppForegroundEnter(() => {
    void healEsimBackup();
    void claimPendingEsims();
  });
  void claimPendingEsims().catch(() => {});
  stopTracking = () => {
    offSubmitted();
    offForeground();
    poller.stop();
    stopTracking = null;
  };
  return stopTracking;
}

/**
 * The one-tap install link for the device asking, when nadanada gave one. On
 * the web (PWA) the browser's user agent says whether this is an Android or an
 * iPhone, so the right link is chosen there too.
 */
export function installUrlFor(esim: OwnedEsim): string | null {
  const platform = Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "web";
  const userAgent =
    platform === "web" && typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  return installUrlForPlatform(esim.install, platform, userAgent);
}
