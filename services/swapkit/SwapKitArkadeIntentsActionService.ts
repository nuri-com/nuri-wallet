// Executor for SwapKit `arkade_intents_v1` wallet actions.
//
// The Lightning send corridor asks the wallet for exactly one signature, and
// only when a payment has to be unwound: the solver went dark on a funded
// lockup and its `refundLocktime` matured. SwapKit notices that and offers a
// `refund` action carrying the covenant's parameters; the wallet rebuilds the
// script, signs the `refundWithoutReceiver` leaf with the key it provisioned
// when the payment started, and submits the arkade txid.
//
// Nothing here decides WHETHER to refund — that is the server's read of the
// swap. What this file refuses is signing the wrong thing: a covenant that
// does not rebuild to the address that was funded, a destination that is not
// this wallet's own, or a swap this wallet never made.
//
// Arkade SDK deps are loaded through dynamic import() inside the handler so
// pulling this module into a service (or a node-side test that mocks the swap
// layer) never drags native modules into the parse-time graph.
import { bytesToHex, hexToBytes } from "../../lib/bytes";
import { LOG_EMOJI, errorWithId, logWithId } from "../../lib/OperationLogUtils";
import {
  isTerminal,
  type SwapKitAction,
  submitSwapKitWalletAction,
  trackSwapKitSwap,
} from "./SwapKitService";
// Static app-module imports. The web export is a single bundle, so an async
// require has no chunk to resolve and each of these threw "Requiring unknown
// module" on the PWA — leaving an unresolved lockup with no way to refund itself
// there. Only the native-heavy SDK packages stay dynamic, for the opposite
// reason: keeping them out of the parse-time graph.
import { withOutgoingBrowserApproval } from "../arkade/internal/browserApproval";
import {
  deleteArkadeLightningSend,
  getArkadeLightningSendOwnerKey,
  listArkadeLightningSends,
  type ArkadeLightningSendRecord,
} from "../arkade/internal/lightningSendStore";
import { createArkadeServerSwapIntent } from "../arkade/internal/swapIntents";
import { journalEntry, loadJournal } from "./SwapKitArkadeIntentsRefundJournal";
// Stable @arkade-os/swap keeps the covenant/recovery primitives on the package ROOT; the
// `/protocol` subpath they were split onto existed only on the 0.1.0-rc line and does not
// resolve on stable.
import { ArkAddress, contractSigner, provisionRefundKey } from "@arkade-os/sdk";
import {
  readLockupFate,
  lightningSendVtxoScript,
  findLockupVtxos,
  pushRefundWithoutReceiver,
} from "@arkade-os/swap";
import { getOrCreateWallet } from "../arkade/internal/walletCache";

const SOURCE = "services/swapkit/SwapKitArkadeIntentsActionService.ts";
export const ARKADE_INTENTS_CAPABILITY = "arkade_intents_v1";

type LockupParams = {
  solverPubkey: string;
  serverPubkey: string;
  emulatorPubkey: string;
  senderPubkey: string;
  receiverPkScript: string;
  refundPkScript: string;
  paymentHash: string;
  claimDelay: number;
  refundLocktime: number;
  // The solver's quoted delay, bound into the current covenant. Dropping it
  // rebuilds a different address; the server verifier carries it the same way.
  refundWithoutReceiverDelay?: number;
};

/**
 * The covenant shapes a funded Arkade Intents lockup can carry, newest first.
 *
 * `undefined` is the current nine-leaf covenant, whose ninth leaf is the
 * timelocked `nonInteractiveRefundWithoutReceiver`; `"preTimelockedRefund"` is
 * the shape lockups funded before that leaf shipped still have. Which one a
 * given lockup used is not in the action's parameters and cannot be derived
 * from them — the two differ only in the covenant the solver quoted — so both
 * are built and the funded address decides.
 *
 * Mirrors the SDK's own `LOCKUP_SHAPE_VARIANTS`, which it keeps internal to
 * `matchQuotedLockup`.
 */
const LOCKUP_SHAPE_VARIANTS: readonly (undefined | "preTimelockedRefund")[] = [
  undefined,
  "preTimelockedRefund",
];

/**
 * Rebuild the covenant from its public parameters and report the Arkade address
 * it derives to, or null when nothing rebuilds.
 *
 * Both shapes are tried because a lockup created before the timelocked-refund
 * leaf shipped still carries the old one. The shape is chosen by the money —
 * the address being checked — never asserted.
 *
 * This is the refund path's own gate, lifted out so the FUNDING path proves the
 * destination with the same code. A second implementation would be free to
 * drift, and the one that broke every Arkade payment on 2026-09-24 (server
 * #338) drifted by a single omitted field.
 */
export function rebuildLockupPkScript(
  params: LockupParams,
  expectedAddress: string,
): { pkScript: string; contract: ReturnType<typeof lightningSendVtxoScript> } | null {
  const contractParams = {
    solverPubkey: hexToBytes(params.solverPubkey),
    refundLocktime: params.refundLocktime,
    serverPubkey: hexToBytes(params.serverPubkey),
    paymentHash: params.paymentHash,
    claimDelay: params.claimDelay,
    emulatorPubkey: hexToBytes(params.emulatorPubkey),
    refundPkScript: hexToBytes(params.refundPkScript),
    senderPubkey: hexToBytes(params.senderPubkey),
    receiverPkScript: hexToBytes(params.receiverPkScript),
    ...(params.refundWithoutReceiverDelay !== undefined
      ? { refundWithoutReceiverDelay: params.refundWithoutReceiverDelay }
      : {}),
  };
  let expected: string;
  try {
    expected = bytesToHex(ArkAddress.decode(expectedAddress).pkScript).toLowerCase();
  } catch {
    return null;
  }
  for (const legacy of LOCKUP_SHAPE_VARIANTS) {
    const contract = lightningSendVtxoScript(
      legacy === undefined ? contractParams : { ...contractParams, legacy },
    );
    const pkScript = bytesToHex(contract.pkScript).toLowerCase();
    if (pkScript === expected) return { pkScript, contract };
  }
  return null;
}

function log(message: string, data?: Record<string, unknown>, action = "refund"): void {
  logWithId(`${LOG_EMOJI.bitcoin} SwapKitArkadeIntents`, message, data, {
    source: `${SOURCE}#handleSwapKitArkadeIntentsAction`,
    event: "FLOW",
    action,
  });
}

/**
 * The txid of the spend that already returned this lockup, when there is one.
 *
 * Read from the chain rather than from local state, and only trusted when the
 * spend was NOT a claim: a claimed lockup means the solver completed the
 * payment, and reporting that as our refund would tell the server a refund
 * landed that never did.
 */
async function recoverRefundTxid(
  wallet: { indexerProvider: unknown },
  swapPkScript: Uint8Array,
  paymentHash: string,
): Promise<string | null> {
  try {
    const indexer = wallet.indexerProvider as Parameters<typeof readLockupFate>[0];
    const fate = await readLockupFate(indexer, { swapPkScript, paymentHash });
    if (fate.fate !== "returned") return null;
    // The SPENT outputs are the whole point here, so this asks the indexer for
    // the lockup's vtxos directly rather than going through `findLockupVtxos`.
    // That helper answers "what can still be refunded" — live and recoverable
    // outputs — and a completed refund leaves none of those, so the very case
    // this recovery exists for came back empty every time.
    //
    // `fate` is already `returned` above, which is decided from the spend
    // witnesses: no spend revealed a preimage matching `paymentHash`. So every
    // spend of this lockup is a refund leaf, and `spentBy` names our own
    // transaction. A claim would have answered `claimed` and returned null.
    const scriptHex = bytesToHex(swapPkScript);
    const read = indexer as unknown as {
      getVtxos: (params: { scripts: string[] }) => Promise<{ vtxos?: unknown[] }>;
    };
    const { vtxos } = await read.getVtxos({ scripts: [scriptHex] });
    for (const vtxo of vtxos ?? []) {
      const spentBy = String((vtxo as { spentBy?: unknown }).spentBy || "")
        .trim()
        .toLowerCase();
      if (spentBy) return spentBy;
    }
    return null;
  } catch {
    return null;
  }
}

/** The 32-byte tail of a pubkey, so a compressed and an x-only spelling of the
 * same key compare equal. */
function xOnly(pubkeyHex: string): string {
  const hex = String(pubkeyHex || "")
    .trim()
    .toLowerCase();
  return hex.length > 64 ? hex.slice(-64) : hex;
}

/**
 * Parse and validate a lockup covenant's PUBLIC parameters. Exported so the v2
 * `arkade_intents_refund` executor can reuse the exact same fail-closed hex/int
 * checks the v1 handler applies before rebuilding the covenant. The v1 wire
 * nests these under `request.lockup`; the v2 contract carries them flat as
 * `lockupParams` — both funnel through here so the covenant rebuild is
 * identical.
 */
export function parseLockupParams(lockup: Record<string, unknown>): LockupParams {
  const hex = (value: unknown, field: string): string => {
    const raw = String(value || "")
      .trim()
      .toLowerCase();
    if (!/^[0-9a-f]+$/.test(raw)) {
      throw new Error(`arkade_intents refund lockup.${field} is not hex`);
    }
    return raw;
  };
  const int = (value: unknown, field: string): number => {
    const num = Math.trunc(Number(value));
    if (!Number.isFinite(num) || num <= 0) {
      throw new Error(`arkade_intents refund lockup.${field} is missing`);
    }
    return num;
  };
  return {
    solverPubkey: hex(lockup.solverPubkey, "solverPubkey"),
    serverPubkey: hex(lockup.serverPubkey, "serverPubkey"),
    emulatorPubkey: hex(lockup.emulatorPubkey, "emulatorPubkey"),
    senderPubkey: hex(lockup.senderPubkey, "senderPubkey"),
    receiverPkScript: hex(lockup.receiverPkScript, "receiverPkScript"),
    refundPkScript: hex(lockup.refundPkScript, "refundPkScript"),
    paymentHash: hex(lockup.paymentHash, "paymentHash"),
    claimDelay: int(lockup.claimDelay, "claimDelay"),
    refundLocktime: int(lockup.refundLocktime, "refundLocktime"),
    ...(lockup.refundWithoutReceiverDelay !== undefined &&
    lockup.refundWithoutReceiverDelay !== null
      ? {
          refundWithoutReceiverDelay: int(
            lockup.refundWithoutReceiverDelay,
            "refundWithoutReceiverDelay",
          ),
        }
      : {}),
  };
}

function readLockupParams(request: Record<string, unknown>): LockupParams {
  return parseLockupParams((request.lockup ?? {}) as Record<string, unknown>);
}

/**
 * A refund whose bound `refundLocktime` has not yet matured. Thrown BEFORE any
 * signing so a caller (the v2 tracker) can treat it as blocked, never as a
 * spurious success — the lockup is still the wallet's money, just not yet
 * spendable on the refund leaf.
 */
export class ArkadeIntentsRefundNotMatureError extends Error {
  readonly code = "refund_not_mature";
  constructor(message: string) {
    super(message);
    this.name = "ArkadeIntentsRefundNotMatureError";
  }
}

export type ArkadeIntentsRefundInput = {
  rfqId: string;
  lockupAddress: string;
  destinationAddress: string;
  params: LockupParams;
};

/**
 * Public material for the v2 `arkade_refund_material` action: the x-only sender
 * public key the server binds into the Arkade Intents lockup covenant, plus an
 * opaque wallet-owned reference. The key is the SAME one the refund signs with
 * — the wallet's deterministic `provisionRefundKey(wallet)` — so a covenant
 * funded with this key is always refundable by this wallet (the refund core
 * re-derives the identical descriptor/key). The ref is opaque and Arkade-scoped
 * (`nuri-arkade-intents-v1:<scope>`); the refund resolves the signer from the
 * wallet, not from the ref, so the ref only carries provenance. */
export async function deriveArkadeIntentsRefundMaterial(
  scope: string,
): Promise<{ senderPublicKey: string; walletKeyRef: string }> {
  const wallet = await getOrCreateWallet();
  const refundKey = await provisionRefundKey(wallet);
  return {
    // provisionRefundKey already returns the x-only (32-byte) pubkey.
    senderPublicKey: bytesToHex(refundKey.pubkey),
    walletKeyRef: `${ARKADE_INTENTS_KEY_REF_PREFIX}:${scope || "refund"}`,
  };
}

/** The opaque wallet-owned ref prefix for Arkade Intents refund material. The
 * refund executor accepts only refs this wallet minted (provenance gate); the
 * actual signer is always re-derived from the wallet, never from the ref. */
export const ARKADE_INTENTS_KEY_REF_PREFIX = "nuri-arkade-intents-v1";

export function isArkadeIntentsRefundKeyRef(raw: string): boolean {
  return String(raw || "").startsWith(`${ARKADE_INTENTS_KEY_REF_PREFIX}:`);
}

/**
 * Rebuild the funded-send record from wallet-owned material when the local
 * cache is gone (full app-data wipe + wallet restore). Every field is derived,
 * never trusted from the server:
 *   - `senderDescriptor` / `senderPublicKey` from `provisionRefundKey(wallet)`,
 *     which for the passkey-bound ArkadeRemoteIdentity is a deterministic
 *     function of the identity's x-only key — the SAME value produced when the
 *     payment was first funded.
 *   - `refundAddress` = this wallet's own Arkade receive address.
 * The `lockupAddress` is taken from the bound action ONLY as the candidate the
 * covenant must rebuild to; the caller's covenant-rebuild gate then proves the
 * derived material controls that exact funded lockup. If it does not rebuild,
 * the refund is refused — a wiped wallet that cannot reconstruct the covenant
 * cannot (and must not) spend it. Amounts are display-only here; the actual
 * returned sats come from the on-chain VTXOs, not this record.
 */
async function reconstructFundedRecord(
  rfqId: string,
  input: ArkadeIntentsRefundInput,
): Promise<ArkadeLightningSendRecord> {
  const wallet = await getOrCreateWallet();
  const refundKey = await provisionRefundKey(wallet);
  const refundAddress = await wallet.getAddress();
  return {
    rfqId,
    txId: "",
    opId: rfqId,
    paymentHash: input.params.paymentHash,
    refundLocktime: input.params.refundLocktime,
    lockupAddress: input.lockupAddress,
    refundAddress,
    fundAmountSats: 0,
    invoiceSats: 0,
    senderDescriptor: refundKey.descriptor,
    senderPublicKey: bytesToHex(refundKey.pubkey),
    createdAtMs: Date.now(),
  };
}

export type ArkadeIntentsRefundDeps = {
  /** Trace/idempotency id passed through to the browser-approval layer. */
  opId?: string;
  /** Current unix time in seconds. When provided, a refund whose locktime has
   * not matured is refused (ArkadeIntentsRefundNotMatureError) BEFORE signing.
   * Omitted by the v1 handler, whose action only exists once matured. */
  nowSeconds?: () => number;
  /** Consent note shown in the approval sheet; a sensible default is used. */
  approvalNote?: string;
  /** Called just before the irreversible push (the v1 handler journals here so
   * a crash between push and evidence is recoverable). */
  onBeforePush?: (info: {
    swapPkScriptHex: string;
    paymentHash: string;
    rfqId: string;
  }) => Promise<void> | void;
  /** Invoked when the lockup holds nothing: the caller may recover an already
   * broadcast refund's txid off-chain and return it, or null to signal the
   * lockup resolved elsewhere. */
  onEmptyLockup?: (info: {
    wallet: Awaited<ReturnType<typeof getOrCreateWallet>>;
    swapPkScript: Uint8Array;
    paymentHash: string;
    rfqId: string;
  }) => Promise<string | null>;
};

export type ArkadeIntentsRefundResult = {
  arkTxid: string;
  swapPkScriptHex: string;
  returnedSats: number;
  /** True when the txid came from onEmptyLockup recovery, not a fresh push. */
  recovered: boolean;
};

/**
 * The refund CORE, reused by both the v1 `arkade_intents_v1` handler and the
 * v2 `arkade_intents_refund` executor. It binds the refund to a swap THIS
 * wallet funded (owner key → record by rfqId), refuses a substituted lockup /
 * destination / sender key / payout script, rebuilds the covenant across both
 * shape variants and confirms it rebuilds to the FUNDED address, then signs
 * `refundWithoutReceiver` with the key provisioned at payment time. No new
 * derivation or crypto: the sender signer comes from the funded record's
 * descriptor. Journaling, replay and evidence submission are the caller's job.
 */
export async function refundArkadeIntentsLockup(
  input: ArkadeIntentsRefundInput,
  deps: ArkadeIntentsRefundDeps = {},
): Promise<ArkadeIntentsRefundResult> {
  const { rfqId, params } = input;

  const ownerKey = await getArkadeLightningSendOwnerKey();
  if (!ownerKey) throw new Error("arkade_intents refund has no local wallet owner");
  const stored = (await listArkadeLightningSends(ownerKey)).find((row) => row.rfqId === rfqId);
  // The funded record is a CACHE, not the source of truth. After a full app-data
  // wipe + wallet restore it is gone, but every field it held is re-derivable
  // from wallet-owned material: the Arkade refund signer descriptor and its
  // x-only pubkey come from the deterministic `provisionRefundKey(wallet)`
  // (ArkadeRemoteIdentity is not HD-allocation-capable, so this resolves to
  // `identityDescriptor` = a pure function of the passkey-bound identity's
  // x-only key), and the refund address is the wallet's own receive address.
  // We reconstruct it from the wallet and let the covenant-rebuild gate below
  // prove the reconstruction actually controls the FUNDED lockup — a wallet
  // that cannot rebuild the funded covenant cannot refund it, wiped or not.
  const record = stored ?? (await reconstructFundedRecord(rfqId, input));

  const lockupAddress = String(input.lockupAddress || "").trim();
  if (lockupAddress !== record.lockupAddress) {
    throw new Error("arkade_intents refund lockup address does not match the funded swap");
  }
  // The destination is bound to what this wallet committed when it paid, not to
  // what arrives now: a server-substituted address is exactly what this check
  // exists to refuse, and the refund pays the covenant's committed script
  // anyway.
  const destinationAddress = String(input.destinationAddress || "").trim();
  if (destinationAddress !== record.refundAddress) {
    throw new Error("arkade_intents refund destination does not match this wallet's address");
  }

  // Compared x-only on both sides: the covenant binds 32 bytes, and a record
  // written with a compressed key must not read as a different wallet's.
  if (xOnly(params.senderPubkey) !== xOnly(record.senderPublicKey)) {
    throw new Error("arkade_intents refund names another wallet's sender key");
  }

  // The covenant pays its COMMITTED script, so matching the destination string
  // above is not enough on its own: the string is what the approval shows the
  // user, and `refundPkScript` is where the sats actually land.
  const recordedRefundPkScript = bytesToHex(
    ArkAddress.decode(record.refundAddress).pkScript,
  ).toLowerCase();
  if (String(params.refundPkScript || "").toLowerCase() !== recordedRefundPkScript) {
    throw new Error("arkade_intents refund pays a script that is not this wallet's");
  }
  // The covenant the server described must be the one that was funded. Same
  // gate the FUNDING path applies before it sends, from the same function.
  const matched = rebuildLockupPkScript(params, record.lockupAddress);
  if (!matched) {
    log(`refund covenant does not rebuild to the funded lockup for rfq ${rfqId}`, {
      funded: record.lockupAddress,
    });
    throw new Error("arkade_intents refund covenant does not rebuild to the funded lockup");
  }
  const script = matched.contract;

  // Locktime gate (v2): the refund leaf is unspendable until its locktime, so a
  // push before then just wastes an approval. Refuse it as blocked rather than
  // attempt a spend that cannot confirm.
  if (deps.nowSeconds) {
    const now = deps.nowSeconds();
    if (Number.isFinite(now) && now < params.refundLocktime) {
      throw new ArkadeIntentsRefundNotMatureError(
        `arkade_intents refund is blocked until locktime ${params.refundLocktime} (now ${now})`,
      );
    }
  }

  const wallet = await getOrCreateWallet();
  const swapPkScriptHex = bytesToHex(script.pkScript);
  const vtxos = await findLockupVtxos(wallet.indexerProvider, script.pkScript);
  if (vtxos.length === 0) {
    const recovered = deps.onEmptyLockup
      ? await deps.onEmptyLockup({
          wallet,
          swapPkScript: script.pkScript,
          paymentHash: params.paymentHash,
          rfqId,
        })
      : null;
    if (recovered) {
      log(`recovered refund txid for rfq ${rfqId}`, { arkTxid: recovered });
      return { arkTxid: recovered, swapPkScriptHex, returnedSats: 0, recovered: true };
    }
    log(`refund has nothing to return for rfq ${rfqId}`);
    throw new Error("Arkade Intents refund lockup is empty");
  }

  const returnedSats = vtxos.reduce((total, vtxo) => total + Number(vtxo.value || 0), 0);

  const swapIntentId = await createArkadeServerSwapIntent({
    kind: "lightning_refund",
    finalRecipient: record.refundAddress,
    finalAmountSats: returnedSats,
    fundingAddress: record.refundAddress,
    fundingAmountSats: returnedSats,
    provider: "arkade_intents",
    rfqId,
    lockupAddress: record.lockupAddress,
    op: "ln_pay_refund",
  });

  if (deps.onBeforePush) {
    await deps.onBeforePush({ swapPkScriptHex, paymentHash: params.paymentHash, rfqId });
  }

  const sender = await contractSigner(wallet, record.senderDescriptor);
  const { arkTxid, amount } = await withOutgoingBrowserApproval(
    {
      kind: "lightning_refund",
      title: "Return Failed Lightning Payment",
      recipient: record.refundAddress,
      amountSats: returnedSats,
      finalAmountSats: returnedSats,
      note: deps.approvalNote ?? "Returning a Lightning payment the receiver never claimed.",
      source: "swap",
      approvalScope: "direct_send_session",
      swapIntentId,
    },
    // Stable `pushRefundWithoutReceiver` takes the covenant as `script` and returns the id
    // as `arkTxid`; the 0.1.0-rc line named them `contract` and `txid`. Same call, same result.
    () => pushRefundWithoutReceiver(wallet.arkProvider, { script, sender, vtxos }),
    { opId: deps.opId ?? rfqId, detail: `flow=arkade.refund rfq=${rfqId} sats=${returnedSats}` },
  );
  log(`refund pushed ${amount} sats for rfq ${rfqId}`, { arkTxid });

  return { arkTxid, swapPkScriptHex, returnedSats, recovered: false };
}

/**
 * The one entry point the swap loop calls for an `arkade_intents_v1` action.
 * Injected into runSwapKitSwapLoop via `options.handleArkadeIntentsAction`.
 */
export async function handleSwapKitArkadeIntentsAction(
  action: SwapKitAction,
  context: { txId: string },
): Promise<void> {
  const actionId = String(action.actionId || "").trim();
  if (!actionId) throw new Error("arkade_intents_v1 action is missing actionId");
  const request = (action.request ?? {}) as Record<string, unknown>;
  const operation = String(request.kind || action.operation || "").toLowerCase();
  if (operation !== "refund" && operation !== "refund_lockup") {
    throw new Error(`unknown arkade_intents_v1 operation: ${operation || "missing"}`);
  }

  // Idempotent per actionId: a re-presented action replays its txid rather
  // than pushing a second refund for the same lockup.
  const provider = String(action.provider || "arkade-intents");
  const externalId = action.externalId ? String(action.externalId) : undefined;
  const journal = await loadJournal();
  const journaled = journal[actionId];
  if (journaled?.txid) {
    log(`replaying journaled refund txid for action ${actionId}`, { txId: context.txId });
    await submitSwapKitWalletAction({
      txId: context.txId,
      actionId,
      provider,
      externalId,
      txHash: journaled.txid,
      result: { txId: journaled.txid },
    });
    return;
  }

  const rfqId = String(request.rfqId || action.externalId || "").trim();
  if (!rfqId) throw new Error("arkade_intents_v1 refund is missing rfqId");

  // Reuse the shared refund core: it binds the refund to a swap this wallet
  // funded, refuses a substituted lockup/destination/sender/payout script,
  // rebuilds the covenant to the funded address and signs `refundWithoutReceiver`.
  // The v1 handler layers its journal + off-chain txid recovery on via deps.
  const { arkTxid, swapPkScriptHex } = await refundArkadeIntentsLockup(
    {
      rfqId,
      lockupAddress: String(request.lockupAddress || "").trim(),
      destinationAddress: String(request.destinationAddress || "").trim(),
      params: readLockupParams(request),
    },
    {
      opId: actionId,
      // Recorded BEFORE the push: from here on a crash must be recoverable, and
      // the only thing that makes the txid findable afterwards is knowing an
      // attempt was made against this lockup.
      onBeforePush: async ({ swapPkScriptHex, paymentHash }) => {
        await journalEntry(actionId, {
          swapPkScriptHex,
          paymentHash,
          rfqId,
          startedAtMs: Date.now(),
        });
      },
      // An empty lockup has two meanings, and they are opposite. If this action
      // already broadcast a refund whose txid was never written down, the money
      // is ours and gone home — recover the txid off the spend and submit it. If
      // no attempt was ever made (no journal), the swap simply resolved elsewhere.
      onEmptyLockup: async ({ wallet, swapPkScript, paymentHash }) => {
        if (!journaled) return null;
        const recovered = await recoverRefundTxid(wallet, swapPkScript, paymentHash);
        if (recovered) {
          await journalEntry(actionId, {
            swapPkScriptHex: bytesToHex(swapPkScript),
            txid: recovered,
          });
        }
        return recovered;
      },
    },
  );
  log(`refund pushed for rfq ${rfqId}`, { txId: context.txId, arkTxid });

  // Journal BEFORE submitting: the sats have moved once the push returns, and
  // a submit that fails must replay this txid rather than push again.
  await journalEntry(actionId, { swapPkScriptHex, txid: arkTxid });
  try {
    await submitSwapKitWalletAction({
      txId: context.txId,
      actionId,
      provider,
      externalId,
      txHash: arkTxid,
      result: { txId: arkTxid },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error || "unknown");
    errorWithId(
      `${LOG_EMOJI.bitcoin} SwapKitArkadeIntents`,
      `refund submit failed txId=${context.txId} — ${reason}`,
      { err: reason },
      { source: `${SOURCE}#handleSwapKitArkadeIntentsAction`, event: "API_ERR", action: "refund" },
    );
    throw error;
  }
}

/**
 * Ask SwapKit whether any funded Lightning send now needs a signature.
 *
 * The corridor's happy path needs nothing from this wallet, and the refund
 * action only exists once `refundLocktime` has matured — hours after the
 * payment — so this runs on the app's own wake-ups rather than on a timer of
 * its own. An empty answer is the normal one, not a failure.
 */
export async function checkArkadeIntentsLightningSends(reason: string): Promise<void> {
  const ownerKey = await getArkadeLightningSendOwnerKey();
  if (!ownerKey) return;
  const records = await listArkadeLightningSends(ownerKey);
  if (records.length === 0) return;

  for (const record of records) {
    try {
      // Re-report the funding txid on every wake until this record is gone.
      // The one-shot report at funding time can be lost to a transient
      // network/server failure after the sats have already left the wallet;
      // without the txid the server never arms the solver-timeout refund
      // (its evidence gate demands a funding hash — #243). notifyDeposit is
      // idempotent for an Intents leg (it latches the hash once, then just
      // refreshes), so re-sending the persisted hash here until the record is
      // deleted at terminal is a bounded, self-healing retry.
      const track = await trackSwapKitSwap(
        record.txId,
        record.fundingTxid ? { depositTxHash: record.fundingTxid } : {},
      );
      const action = (track.actions ?? []).find(
        (candidate) => String(candidate?.type) === ARKADE_INTENTS_CAPABILITY,
      );
      if (action) {
        log(`swapkit asked for a signature on rfq ${record.rfqId} (${reason})`, {
          txId: record.txId,
        });
        await handleSwapKitArkadeIntentsAction(action, { txId: record.txId });
        continue;
      }
      // Terminal means the corridor is done with this swap either way — paid,
      // or unwound and confirmed. The record's only job was to survive until
      // one of those, so it goes.
      //
      // Read through the canonical predicate rather than the boolean alone:
      // `terminal` is optional on the track response, and a status-only
      // COMPLETED/REFUNDED/FAILED answer would otherwise leave the record
      // behind to be re-polled on every wallet-summary wake, forever.
      if (isTerminal(track)) {
        await deleteArkadeLightningSend(ownerKey, record.rfqId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "unknown");
      log(`check failed for rfq ${record.rfqId}: ${message}`, { txId: record.txId }, "check");
    }
  }
}
