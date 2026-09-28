import { LOG_EMOJI, errorWithId, logWithId } from "../../lib/OperationLogUtils";
import { getArkadeReceiveAddress } from "../arkade/ArkadeAddressService";
import { submitSwapKitWalletAction, type SwapKitAction } from "./SwapKitService";
import {
  isVhtlcNotDueYetError,
  isVhtlcRefundable,
  vhtlcSecondsUntilRefundable,
} from "./vhtlcRefundTiming";
import { SwapKitOrderStore } from "./SwapKitOrderStore";
import { claimSwapKitArkadeVhtlc, refundSwapKitArkadeVhtlc } from "./SwapKitArkadeVhtlcService";
import { getCacheValue, setCacheValue } from "../balance/TransactionCacheService";
import { sendArkadeToArk } from "../arkade/ArkadeSendService";

// The claim/refund path is STATIC on purpose: the web export is a single bundle and an async
// import() of an app module compiles to a runtime require() whose target the bundler can drop —
// the PWA died with "Requiring unknown module" on every claim, leaving serverfunded sats stuck in
// the VHTLC (same failure class SwapKitArkadeIntentsActionService already fixed). Storage
// (expo-sqlite) and the ArkadeSendService wallet graph stay dynamic: proven web-safe via the
// intents journal, and node-side tests must not parse them.

/**
 * Executor for SwapKit `arkade_vhtlc_v1` wallet actions (server contract:
 * nuri-mcp-bitcoin-swapkit src/arkade-wallet-contract.mjs, v0.6.18+ with
 * hashLock160). The BTC leg of a swap is a VHTLC on the Arkade wallet instead
 * of a Lightning invoice. Operations arrive as `actions[]` inside
 * runSwapKitSwapLoop:
 *   send   — fund the VHTLC: send request.amountSats to request.to
 *   claim  — claim request.vhtlc to request.destinationAddress
 *            (SwapKitArkadeVhtlcService — fail-closed parameter verification)
 *   refund — return request.vhtlc to request.destinationAddress via the
 *            refundWithoutReceiver leaf (CLTV + [sender, server]), so a
 *            provider that goes silent mid-swap cannot strand the sats.
 *            Before the timelock opens this signals the swap loop's existing
 *            not-ready backoff — it is not a signing failure.
 * Each submits the resulting arkade txid via swap_wallet_submit; the result
 * object carries ONLY { txId } (the server rejects anything else).
 *
 * Idempotent per actionId: a re-presented action replays its journaled txid so
 * a lost submit can never fund/claim twice (a re-send would double-spend VTXOs).
 */

const SOURCE = "services/swapkit/SwapKitArkadeActionService.ts";
const RESULT_STORAGE_KEY = "swapkit:arkade-results:v1";

function log(message: string, data?: Record<string, unknown>, action = "arkade"): void {
  logWithId(`${LOG_EMOJI.bitcoin} SwapKitArkade`, message, data, {
    source: `${SOURCE}#handleSwapKitArkadeAction`,
    event: "FLOW",
    action,
  });
}

/**
 * One journal entry per actionId.
 *
 * A bare txid (legacy, and what a `send` writes) means "this already happened,
 * replay it". A VHTLC claim/refund writes `finalized: false` the moment the ASP
 * accepts the submit and flips it to true only once the tx is finalized, because
 * a submitted-but-unfinalized txid is NOT a completed action: replaying it as
 * done would leave the pending tx unfinalized forever.
 */
type JournalEntry = string | { txid: string; finalized?: boolean };

function entryTxid(entry: JournalEntry | undefined): string {
  if (!entry) return "";
  return typeof entry === "string" ? entry : String(entry.txid || "");
}

function entryIsCompleted(entry: JournalEntry | undefined): boolean {
  if (!entry) return false;
  if (typeof entry === "string") return true;
  return entry.finalized !== false;
}

async function loadJournal(): Promise<Record<string, JournalEntry>> {
  try {
    const parsed = await getCacheValue<unknown>(RESULT_STORAGE_KEY);
    return parsed && typeof parsed === "object"
      ? { ...(parsed as Record<string, JournalEntry>) }
      : {};
  } catch {
    return {};
  }
}

// Serialize journal writes. Each write is load → modify → whole-value replace
// under one shared key, so two concurrent orders can interleave (A loads, B
// loads, A writes {A}, B writes {B}) and drop A's txid — after which a replay of
// A finds no journaled txid and re-broadcasts, double-spending VTXOs. Chain the
// writes (same fix as the HTLC journal) so every read sees the prior write.
let journalChain: Promise<void> = Promise.resolve();
async function writeJournalEntry(actionId: string, entry: JournalEntry): Promise<void> {
  const write = journalChain.then(async () => {
    const current = await loadJournal();
    current[actionId] = entry;
    await setCacheValue(RESULT_STORAGE_KEY, current);
  });
  journalChain = write.catch(() => {});
  await write;
}

async function journalTxId(actionId: string, txid: string): Promise<void> {
  await writeJournalEntry(actionId, txid);
}

/**
 * The ASP accepted the submit; the action is NOT complete yet.
 *
 * Deliberately written per submitted transaction and never upgraded from here:
 * an action that claims several VTXOs is only done when the post-call write below
 * runs, so a crash after the first finalized coin replays the rest instead of
 * reporting the whole action complete on one txid.
 */
async function journalArkTxidSubmitted(actionId: string, txid: string): Promise<void> {
  await writeJournalEntry(actionId, { txid, finalized: false });
}

// The order-bound local Arkade address. Both the refund (return the sats) and
// the claim (receive the swapped sats) must land on THIS wallet's own address,
// never a server-supplied one — so both bind against this before signing.
async function boundArkadeLocalAddress(txId: string): Promise<string> {
  await SwapKitOrderStore.hydrate();
  const order = SwapKitOrderStore.list().find((row) => row.txId === txId);
  const stored = String(order?.arkadeRefundAddress || "").trim();
  if (stored) return stored;

  // Rows created before this binding existed can still recover safely: derive
  // the address from the local wallet, then persist it for every later retry.
  const derived = await getArkadeReceiveAddress();
  if (order) await SwapKitOrderStore.add({ ...order, arkadeRefundAddress: derived });
  return derived;
}

/**
 * The one entry point the swap loop calls for an arkade_vhtlc_v1 action.
 * Injected into runSwapKitSwapLoop via options.handleArkadeAction.
 */
// Provider-neutral dispatch (server briefing 2026-07-15): the request.kind
// (send | claim_vhtlc | refund_vhtlc) decides what runs — never the provider.
// action.operation is only the fallback for shapes without a kind. "send" is
// the funding leg: once it broadcasts, the sats have moved.
export function arkadeActionOperation(action: SwapKitAction): "send" | "claim" | "refund" | string {
  const request = (action.request ?? {}) as Record<string, unknown>;
  const kind = String(request.kind || "").toLowerCase();
  return kind === "send" || kind === "claim_vhtlc" || kind === "refund_vhtlc"
    ? kind.replace("_vhtlc", "")
    : String(action.operation || "").toLowerCase();
}

export async function handleSwapKitArkadeAction(
  action: SwapKitAction,
  context: { txId: string },
  // Fired the instant a `send` txid is journaled — i.e. sats have irreversibly
  // moved — BEFORE the server submit (which can still fail and retry). The
  // caller uses it to mark the funded boundary; firing only after submit
  // returns would miss a broadcast-succeeds/submit-fails window.
  onFunded?: () => void | Promise<void>,
): Promise<void> {
  const actionId = String(action.actionId || "").trim();
  if (!actionId) throw new Error("arkade_vhtlc_v1 action is missing actionId");
  const provider = String(action.provider || "arkade");
  const externalId = action.externalId ? String(action.externalId) : undefined;
  const request = (action.request ?? {}) as Record<string, unknown>;
  const operation = arkadeActionOperation(action);

  // Phase B (server-owned preimage, server contract arkade-wallet-contract.mjs
  // v0.6.48): a claim action carries the preimage in request.preimage — the
  // VHTLC adapter builds the witness from it instead of local derivation. It
  // is a SECRET: never logged, only its presence. (action.preimage is read as
  // a fallback in case the field moves top-level later.)
  const serverPreimage =
    typeof request.preimage === "string"
      ? request.preimage.trim()
      : typeof (action as { preimage?: unknown }).preimage === "string"
        ? (action as { preimage: string }).preimage.trim()
        : "";

  // Log the full shape once per action so the real wire format is visible while
  // testing live — with the preimage secret redacted wherever it sits.
  log(
    `arkade action op=${operation || "?"} txId=${context.txId} server_preimage=${Boolean(serverPreimage)}`,
    {
      action: {
        ...action,
        ...(typeof (action as { preimage?: unknown }).preimage === "string"
          ? { preimage: "[redacted]" }
          : {}),
        request: {
          ...request,
          ...(typeof request.preimage === "string" ? { preimage: "[redacted]" } : {}),
        },
      },
    },
    operation || "arkade",
  );

  const replayEntry = (await loadJournal())[actionId];
  const replayTxid = entryTxid(replayEntry);
  // Only a completed action short-circuits. A txid journaled at submit but never
  // finalized falls through to the flow below, which recovers the pending tx and
  // only then writes the completed entry.
  if (replayTxid && entryIsCompleted(replayEntry)) {
    log(
      `replay journaled txid for ${actionId} — ${replayTxid}`,
      { txid: replayTxid },
      operation || "arkade",
    );
    // A journaled send means the sats already moved in a prior run; the funded
    // boundary holds even if this replay's submit fails again. Awaited so a
    // caller that persists its pending row here finishes that write before the
    // loop can continue to terminal and run cleanup.
    if (operation === "send") await onFunded?.();
    await submitSwapKitWalletAction({
      txId: context.txId,
      actionId,
      provider,
      externalId,
      txHash: replayTxid,
      result: { txId: replayTxid },
    });
    return;
  }
  if (replayTxid) {
    log(
      `journaled txid for ${actionId} is not finalized — recovering ${replayTxid}`,
      { txid: replayTxid },
      operation || "arkade",
    );
  }

  let txid: string;
  try {
    if (operation === "send") {
      const to = String(request.to || "").trim();
      const amountSats = Number(request.amountSats);
      if (!to) throw new Error("arkade send action is missing request.to");
      // Fund ONLY an order this device created with a positive accepted sats
      // bound. A missing or bounds-less row (sats <= 0) — the shape owner
      // discovery re-creates from swap_list after a pre-send abandonment
      // (kind: "discovered") — must NEVER be funded: that is the double-send
      // vector when the user has already retried onto a replacement route.
      // The bound also caps the amount at the user-accepted value (+2% fee).
      await SwapKitOrderStore.hydrate();
      const order = SwapKitOrderStore.list().find((o) => o.txId === context.txId);
      if (!order || !(order.sats > 0)) {
        throw new Error("arkade send refused: no locally bound order for this txId");
      }
      if (amountSats > Math.ceil(order.sats * 1.02)) {
        throw new Error(
          `arkade send exceeds the accepted amount: asked=${amountSats} accepted=${order.sats}`,
        );
      }
      txid = await sendArkadeToArk({ address: to, amountSats });
    } else if (operation === "claim") {
      const keyRef = (action.keyRef ?? {}) as {
        provider?: string;
        keyIndex?: number;
        preimageHash?: string;
      };
      if (String(keyRef.provider || "") !== provider) {
        throw new Error("arkade claim keyRef does not match the action provider");
      }
      // Bind the claim destination to this wallet's own local address before
      // signing — same fail-closed check as the refund path. Otherwise a
      // server-substituted same-network address receives the wallet-signed
      // claim (the swapped-in sats). Sign to the local address, never the
      // server's raw value.
      const claimDestination = await boundArkadeLocalAddress(context.txId);
      const requestedClaimDestination = String(request.destinationAddress || "").trim();
      if (requestedClaimDestination !== claimDestination) {
        throw new Error("arkade claim destination does not match this order's local address");
      }
      txid = await claimSwapKitArkadeVhtlc({
        provider,
        keyIndex: Number(keyRef.keyIndex),
        preimageHash: String(keyRef.preimageHash || ""),
        ...(serverPreimage ? { serverPreimageHex: serverPreimage } : {}),
        vhtlc: request.vhtlc as Parameters<typeof claimSwapKitArkadeVhtlc>[0]["vhtlc"],
        destinationAddress: claimDestination,
        // Journal the arkTxid the instant the ASP accepts the submit, not only
        // after this call returns: a crash between finalizeTx and the journal
        // write below leaves a spent VHTLC with no evidence to replay.
        onSubmittedArkTxid: (arkTxid) => journalArkTxidSubmitted(actionId, arkTxid),
        ...(replayTxid ? { previouslySubmittedArkTxid: replayTxid } : {}),
      });
    } else if (operation === "refund") {
      const keyRef = (action.keyRef ?? {}) as { provider?: string; keyIndex?: number };
      if (String(keyRef.provider || "") !== provider) {
        throw new Error("arkade refund keyRef does not match the action provider");
      }
      const vhtlc = request.vhtlc as Parameters<typeof refundSwapKitArkadeVhtlc>[0]["vhtlc"];
      const requestedDestination = String(request.destinationAddress || "").trim();
      const refundAddress = await boundArkadeLocalAddress(context.txId);
      if (requestedDestination !== refundAddress) {
        throw new Error("arkade refund destination does not match this order's local address");
      }
      // Not due yet is not a failure — the refund leaf is simply unspendable
      // until the timelock passes, and the funds stay safe meanwhile. Two
      // clocks decide that: the wall clock rules out an attempt cheaply, and
      // the ark server rules on the chain's block time (which trails the wall
      // clock by an hour or more). Either way: signal not-ready so the loop
      // backs off and re-presents the action later.
      if (!isVhtlcRefundable(vhtlc)) {
        log(`refund not due yet — locktime ${Number(vhtlc?.refundLocktime)}`, undefined, "refund");
        throw new Error("Arkade VHTLC refund locktime not reached");
      }
      try {
        txid = await refundSwapKitArkadeVhtlc({
          provider,
          keyIndex: Number(keyRef.keyIndex),
          vhtlc,
          destinationAddress: refundAddress,
          onSubmittedArkTxid: (arkTxid) => journalArkTxidSubmitted(actionId, arkTxid),
          ...(replayTxid ? { previouslySubmittedArkTxid: replayTxid } : {}),
        });
      } catch (error) {
        if (!isVhtlcNotDueYetError(error)) throw error;
        const remaining = vhtlcSecondsUntilRefundable(error);
        log(
          `refund not due yet — chain blocktime is behind${remaining ? `, ~${Math.ceil(remaining / 60)} min to go` : ""}`,
          undefined,
          "refund",
        );
        throw error;
      }
    } else {
      throw new Error(`unknown arkade_vhtlc_v1 operation: ${operation || "missing"}`);
    }
  } catch (error) {
    // txId and reason belong in the line itself: the only other place the
    // reason surfaces is a different logger, and correlating two loggers by
    // hand is how a whole debugging session gets burned (issue #872).
    const reason = error instanceof Error ? error.message : String(error || "unknown");
    // Expected timelock waits are already logged as flow lines above and feed
    // the parent loop's backoff. Do not turn them back into API errors here.
    if (!(operation === "refund" && isVhtlcNotDueYetError(error))) {
      errorWithId(
        `${LOG_EMOJI.bitcoin} SwapKitArkade`,
        `arkade ${operation || "?"} failed txId=${context.txId} — ${reason}`,
        { err: reason },
        {
          source: `${SOURCE}#handleSwapKitArkadeAction`,
          event: "API_ERR",
          action: operation || "arkade",
        },
      );
    }
    throw error;
  }

  // The action is only complete here, after the whole spend plan returned: a
  // claim of several VTXOs journals each submitted txid as pending along the way
  // and is marked done once, with this write.
  if (txid) await journalTxId(actionId, txid);
  // Sats are now irreversibly out; mark the boundary before the submit call,
  // which can still throw and be retried by the loop. Awaited so a caller that
  // persists its pending row in the callback completes that write before the
  // loop can reach terminal and run cleanup (or overtake the mirror emit).
  if (operation === "send" && txid) await onFunded?.();
  await submitSwapKitWalletAction({
    txId: context.txId,
    actionId,
    provider,
    externalId,
    txHash: txid || undefined,
    result: { txId: txid },
  });
  log(
    `arkade ${operation} submitted txId=${context.txId} arkTxid=${txid} action=${actionId}`,
    { actionId, txid },
    operation || "arkade",
  );
}
