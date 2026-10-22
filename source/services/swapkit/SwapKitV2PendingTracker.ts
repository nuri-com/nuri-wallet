// Durable, self-healing tracker for SwapKit V2 orders — the v2 counterpart of
// SwapKitPendingTracker, sharing its one-loop-per-order claim registry so a v2
// order can never run two signers (the registry is id-keyed; ord_ ids and v1
// tx ids never collide).
//
// Responsibilities:
//   - resume every non-terminal stored v2 order on app start/foreground;
//   - reconcile against server-side swap_list(owner) so a reinstalled app
//     re-adopts orders whose local rows are gone;
//   - run each order's action/status loop with the standard executor set;
//   - keep the last order view available to the status UI.
import { toSatsFromBtcAmount } from "../../lib/amounts";
import { getEthereumAddress } from "../../lib/secureKeyStorage";
import { LOG_EMOJI, errorWithId, logWithId } from "../../lib/OperationLogUtils";
import type { PendingWalletTransfer } from "../../types/wallet";
import { PendingWalletTransfersStore } from "../balance/PendingWalletTransfersStore";
import { EventBus } from "../events/AppEventBusService";
import { claimSwapLoop, isSwapLoopActive, releaseSwapLoop } from "./SwapKitLoopRegistry";
import {
  type SwapKitV2OrderView,
  asSwapKitV2OrderId,
  cancelSwapKitV2Order,
  getSwapKitV2Status,
  isSwapKitV2Terminal,
  listSwapKitV2Orders,
  SwapKitV2Error,
} from "./SwapKitV2Service";
import {
  getJournaledV2Evidence,
  isRefusedBeforeBroadcast,
  runSwapKitV2OrderLoop,
  SwapKitV2LoopAbortedError,
  type SwapKitV2LoopOptions,
  wasV2ActionStartedWithoutEvidence,
} from "./SwapKitV2ActionService";
import { makeRecoveryOnlyV2Executors, makeStandardV2Executors } from "./SwapKitV2Executors";
import { rebuildV2ExecutorsForOrder } from "./SwapKitV2ResumeExecutors";
import { getSwapKitV2RecoveryKey } from "./SwapKitV2RecoveryKey";
import { DIRECT_SWAP_SETTLED_EVENT } from "./SwapKitDirectEvmSwapService";
import { SwapKitV2OrderStore } from "./SwapKitV2OrderStore";
import { formatV2TrackingFailureDiagnostic } from "./SwapKitV2TrackingDiagnostic";
import { finishInFlight } from "../money/announce";
import { MoneyInFlightStore } from "../money/MoneyInFlightStore";
import {
  applyV2TerminalBalances,
  holdV2ArkadeFunding,
  releaseV2ArkadeFunding,
  restoreV2ArkadeReservations,
} from "./SwapKitV2MoveAccounting";
import { noteV2MoveNeedsUser, noteV2MoveStatus, restoreV2Move } from "./SwapKitV2MoveStatus";
import { t } from "../../lib/i18n";

const SOURCE = "services/swapkit/SwapKitV2PendingTracker.ts";

// Last order view per live order — the status UI reads legs/actions/failure
// from it without a second network path (v1 lastStatuses pattern).
const lastViews = new Map<string, SwapKitV2OrderView>();

export function getSwapKitV2LastView(orderId: string): SwapKitV2OrderView | null {
  return lastViews.get(orderId) ?? null;
}

export function getSwapKitV2StatusMessage(orderId: string): string | null {
  const view = lastViews.get(orderId);
  if (!view) return null;
  if (view.failure?.message) return view.failure.message;
  return (
    (
      {
        AWAITING_ACTION: "Waiting for wallet",
        IN_FLIGHT: "Payment in progress",
        SETTLING: "Settling",
        COMPLETED: "Completed",
        REFUNDED: "Refunded",
        FAILED: "Failed",
        EXPIRED: "Expired",
        CANCELLED: "Cancelled",
      } as Record<string, string>
    )[view.status] ?? view.status
  );
}

export function emitV2SwapRefresh(): void {
  for (const event of ["wallet:refresh", "transactions:refresh", "bitcoin:refresh"] as const) {
    try {
      EventBus.emit(event);
    } catch {}
  }
}

/** Orders already reconciled this session — reconciliation is idempotent, but
 * this keeps a polling loop from re-emitting the same events every few seconds. */
const reconciledTerminal = new Set<string>();

function rememberView(view: SwapKitV2OrderView): void {
  lastViews.set(view.orderId, view);
  // The moment the SERVER calls the order finished, the swap is finished: clear
  // the optimistic pending row, settle the balances, confirm/revert a card
  // credit. This used to run only where the tracking loop returned normally, so
  // a loop that ended in "Tracking failed" — a poll timing out, the app
  // backgrounded, any transport error after the order was already COMPLETED —
  // left the swap showing as pending forever while the money had arrived.
  // Doing it here covers every path that reads a status at all.
  if (isSwapKitV2Terminal(view) && !reconciledTerminal.has(view.orderId)) {
    reconciledTerminal.add(view.orderId);
    reconcileV2TerminalOrder(view.orderId, view);
  }
  void SwapKitV2OrderStore.setStatus(view.orderId, view.status);
  // The pill reads every order view the tracker sees. A blocked action is only
  // the USER's problem when no loop is driving the order any more: while this
  // loop is alive it keeps polling and will execute the action the moment the
  // server unblocks it, and a "Continue" button there would claim the same
  // registry key and do nothing. A live loop therefore reports progress, and
  // the catch below — which runs after the claim is released — is what turns a
  // genuinely stuck order into something the user can act on.
  const blocked = view.actions?.find((action) => action.state === "blocked") ?? null;
  const row = SwapKitV2OrderStore.get(view.orderId);
  const needsUser = blocked != null && !isSwapLoopActive(view.orderId);
  noteV2MoveStatus({
    orderId: view.orderId,
    status: view.status,
    ...(row?.from ? { from: row.from } : {}),
    ...(row?.to ? { to: row.to } : {}),
    ...(needsUser ? { blockedReason: blocked?.blockedReason || `Needs ${blocked?.kind}` } : {}),
  });
}

/**
 * Everything that must happen exactly once when an order reaches a terminal
 * state: clear the optimistic pending row, confirm/revert an optimistic card
 * credit, apply the balance deltas, and refresh.
 *
 * Extracted because it has to run for BOTH terminal paths. An order that
 * completed while the app was suspended comes back ALREADY terminal, and the
 * early return for that case skipped all of this — leaving a stale pending row,
 * an unconfirmed card credit and pre-swap balances until some unrelated refresh
 * happened to correct them. Every step is keyed by orderId and idempotent, so
 * running it from either path (or twice) cannot double-count.
 */
function reconcileV2TerminalOrder(id: string, result: SwapKitV2OrderView): void {
  logWithId(
    `${LOG_EMOJI.bitcoin} SwapKitV2.track`,
    `order ${id} terminal: ${result.status}`,
    { orderId: id, status: result.status },
    { source: `${SOURCE}#startSwapKitV2Tracking`, event: "FLOW", action: "terminal" },
  );
  // Clear any optimistic pending-transfer row this order created. The
  // wallet's PendingWalletTransfersStore.prune deliberately RETAINS
  // SwapKit rows regardless of age, so a completed/failed/refunded order
  // shows as pending forever unless we emit the keyed clear here. Keyed by
  // orderId — the same key every flow used when it emitted the row — so
  // this is a no-op for orders (e.g. sweep, card) that created none.
  try {
    EventBus.emit("wallet:clearPendingTransfer", { txHash: null, orderId: id });
  } catch {}
  // How it ended, for anything held on this order (an address-book save).
  try {
    EventBus.emit(MoneyInFlightStore.OUTCOME, {
      id,
      outcome: String(result.status || "").toUpperCase() === "COMPLETED" ? "completed" : "failed",
    });
  } catch {}
  // The one call that retires BOTH ends of the move. There are not two rows to
  // keep in step — there is one record — so a half-cleared move cannot happen.
  void finishInFlight(id).catch(() => {});
  // The committed sats are no longer spoken for: a completed order really spent
  // them and a failed one never did, so the live balance is the answer either way.
  try {
    releaseV2ArkadeFunding(id);
  } catch {}
  // Card-destination orders optimistically credited the Wirex card at
  // commit; the home screen listens for DIRECT_SWAP_SETTLED_EVENT keyed by
  // this id to CONFIRM the credit on success or REVERT it on failure.
  // Without this a failed card top-up shows as card balance until an
  // unrelated refresh corrects it. No-op for wallet-settled orders.
  const row = SwapKitV2OrderStore.get(id);
  if (row?.destination === "card") {
    try {
      EventBus.emit(DIRECT_SWAP_SETTLED_EVENT, {
        txId: id,
        destination: "card",
        ok: String(result.status || "").toUpperCase() === "COMPLETED",
      });
    } catch {}
  }
  // Move the balances the instant the order completes. The refresh below
  // is an indexer read that lags by seconds; without this the move shows
  // as finished while both sides still read their pre-swap figures. Keyed
  // by orderId and idempotent, so a duplicate terminal callback, a
  // foreground resume, or a late poll cannot double-count it.
  try {
    applyV2TerminalBalances(
      {
        orderId: id,
        from: row?.from ?? "",
        to: row?.to ?? "",
        ...(row?.destination ? { destination: row.destination } : {}),
      },
      result.status,
    );
  } catch {}
  emitV2SwapRefresh();
}

/**
 * An order the wallet refused to act on before anything was broadcast (a
 * binding refusal, a failed simulation, a stale provider call) cannot move on
 * by itself, and "Action required" would only re-run the same refusal. If the
 * server confirms nothing was funded, cancel it there and drop it from this
 * device — the user simply asks for a new price.
 *
 * The server is the only judge of "unfunded": `swap_cancel` checks its evidence
 * ledger and refuses an order that moved funds (an ERC-20 approval is not
 * funding). Any refusal or error leaves the order exactly as before.
 */
async function cancelUnfundedV2Order(id: string, recoveryKey: string): Promise<boolean> {
  // A step this device may have broadcast without the server knowing must never
  // be cancelled away: only an order whose live actions carry no journaled
  // evidence and no started marker here qualifies.
  for (const action of lastViews.get(id)?.actions ?? []) {
    if (
      (await getJournaledV2Evidence(id, action.actionId)) ||
      (await wasV2ActionStartedWithoutEvidence(id, action.actionId))
    ) {
      return false;
    }
  }
  let view: SwapKitV2OrderView;
  try {
    view = await cancelSwapKitV2Order(asSwapKitV2OrderId(id), { recoveryKey });
  } catch (error) {
    logWithId(
      `${LOG_EMOJI.bitcoin} SwapKitV2.track`,
      `cancel refused for ${id}; keeping it`,
      { err: error instanceof Error ? error.message : String(error) },
      { source: `${SOURCE}#cancelUnfundedV2Order`, event: "FLOW", action: "cancel" },
    );
    return false;
  }
  if (!view || !isSwapKitV2Terminal(view) || String(view.status).toUpperCase() === "COMPLETED") {
    return false;
  }
  // The move ends like any other: the pill states the outcome once and goes,
  // the pending row and the optimistic balances are retired, and the row
  // leaves this device so nothing resumes it.
  rememberView(view);
  reconcileV2TerminalOrder(id, view);
  lastViews.delete(id);
  await SwapKitV2OrderStore.remove(id).catch(() => {});
  logWithId(
    `${LOG_EMOJI.bitcoin} SwapKitV2.track`,
    `cancelled unfunded order ${id} (${view.status}) and removed it`,
    { orderId: id, status: view.status },
    { source: `${SOURCE}#cancelUnfundedV2Order`, event: "FLOW", action: "cancel" },
  );
  return true;
}

/**
 * Executors for a caller that supplied none.
 *
 * A row re-adopted from swap_list (or no row at all) carries no accepted
 * quote, route or amount, so nothing on this device can bound a spend for it.
 * It gets the recovery-only set, never the universal money-moving one: the
 * universal set would let a listed ready EVM call, typed-data signature or
 * Arkade funding action run with none of the original order's limits.
 */
function defaultV2ExecutorsFor(
  stored: ReturnType<typeof SwapKitV2OrderStore.get>,
): SwapKitV2LoopOptions["executors"] {
  if (!stored || (stored.flow === "other" && !stored.executorSpec)) {
    return makeRecoveryOnlyV2Executors();
  }
  return makeStandardV2Executors();
}

/**
 * Track one v2 order to terminal in the background. Claims the shared loop
 * registry; a second call for the same order is a no-op. Loop options may
 * widen the EVM chain allowlist (sweep) or override executors.
 */
/** Every running v2 tracker, so soft logout can stop them before it wipes
 * the keys and order rows they depend on. */
const activeV2Trackers = new Map<string, { controller: AbortController; done: Promise<void> }>();
/** False from the moment soft logout begins stopping trackers: every start
 * is refused so nothing can outlive the account wipe. */
let trackingIntakeOpen = true;

/**
 * Stop every running v2 tracker, immediately. Called by logout and the wallet
 * wipe: the old account's swap loops must not keep running into the next
 * session. Nothing waits — each loop stops at its next step, and intake is
 * closed so no new loop can start until resumeSwapKitV2TrackingIntake().
 */
export function stopAllSwapKitV2Tracking(): void {
  trackingIntakeOpen = false;
  for (const tracker of activeV2Trackers.values()) tracker.controller.abort();
}

/** Re-open tracker intake for a fresh session (after sign-in). Soft logout
 * relaunches the app, so a new process starts with intake open; this exists
 * for the in-process re-login path and for tests. */
export function resumeSwapKitV2TrackingIntake(): void {
  trackingIntakeOpen = true;
}

/** The source assets paid out of the Arkade wallet. */
const ARKADE_SOURCE_ASSETS = new Set(["BTC_ARKADE", "BTC_LN"]);

/**
 * The Arkade hold a PERSISTED order re-arms with: the same source and amount
 * the commit path passes (`acceptedDeposit`, else the committed send amount),
 * always in sats. `acceptedDeposit` is sats for the flows that persist it from
 * a sats figure (btc_to_stable, arkade_to_btc) but decimal BTC for
 * arkade_lightning, which persists the quote's `depositAmount` as-is; read raw,
 * 0.00001003 would truncate to a zero hold.
 * Resume must not depend on the reservation ledger already having the row: a
 * crash between the commit intent being persisted and the first tracker
 * reserving leaves no row, and the ready funding action would otherwise run
 * with the sats still shown as spendable. The reserve is idempotent per
 * order, so re-deriving an existing row replaces it with the same amount.
 */
export function v2ArkadeHoldForOrder(order: {
  from?: string;
  flow?: string;
  acceptedDeposit?: string;
  moveAmounts?: { sendAmount?: number };
}): { fromAsset: string; holdArkadeSats: number } | undefined {
  const fromAsset = String(order.from ?? "");
  if (!ARKADE_SOURCE_ASSETS.has(fromAsset.toUpperCase())) return undefined;
  const holdArkadeSats =
    order.flow === "arkade_lightning" && order.acceptedDeposit != null
      ? toSatsFromBtcAmount(order.acceptedDeposit)
      : Number(order.acceptedDeposit ?? order.moveAmounts?.sendAmount ?? 0);
  return { fromAsset, holdArkadeSats };
}

export function startSwapKitV2Tracking(
  orderId: string,
  initialView?: SwapKitV2OrderView | null,
  loopOptions?: Partial<SwapKitV2LoopOptions> & {
    /** Sats this order committed from the Arkade wallet, held until it ends. */
    holdArkadeSats?: number;
    /** The order's source asset, so only Arkade-funded ones hold. */
    fromAsset?: string;
  },
): void {
  const id = asSwapKitV2OrderId(orderId);
  if (!trackingIntakeOpen) {
    logWithId(
      `${LOG_EMOJI.bitcoin} SwapKitV2.track`,
      `refusing to start tracking id=${id}: tracker intake is closed (logout in progress)`,
      { orderId: id },
      { source: `${SOURCE}#startSwapKitV2Tracking`, event: "FLOW", action: "skip" },
    );
    return;
  }
  if (!claimSwapLoop(id)) return;
  // The committed sats are held for the life of the order. The internal
  // board/offboard path has always done this; the swap path, which is where
  // the sats actually go, did not — so a second move could race the first.
  //
  // AWAITED before the action loop can execute, and a failed write stops the
  // order: a hold that never reached disk does not survive the crash it exists
  // for, and funding broadcast against it would leave those sats spendable
  // again on the next launch.
  const arkadeHoldSats =
    loopOptions?.fromAsset && ARKADE_SOURCE_ASSETS.has(loopOptions.fromAsset.toUpperCase())
      ? Number(loopOptions.holdArkadeSats)
      : 0;
  let failure: string | null = null;
  let refusedUnsent = false;
  let isProviderRefused = false;
  let orderRecoveryKey: string | null = null;
  const controller = new AbortController();
  const aborted = () => controller.signal.aborted;
  // The hold is written while the funding is prepared, and the broadcast waits
  // for it: every funding executor awaits `beforeFunding` at its broadcast
  // boundary (markStarted), so no sats leave before the hold is on disk, and
  // a failed write refuses the broadcast and stops the order.
  const held: Promise<void> =
    arkadeHoldSats > 0 ? holdV2ArkadeFunding(id, arkadeHoldSats) : Promise.resolve();
  held.catch((error: unknown) => {
    // Nothing has been signed or sent yet: refusing here costs the user a
    // retry, while funding without a durable hold risks spending the same
    // sats twice after a crash.
    errorWithId(
      `${LOG_EMOJI.bitcoin} SwapKitV2.track`,
      `refusing to fund ${id}: its sats could not be reserved durably`,
      { orderId: id, err: error instanceof Error ? error.message : String(error) },
      { source: `${SOURCE}#startSwapKitV2Tracking`, event: "API_ERR", action: "reserve" },
    );
    controller.abort();
    noteV2MoveNeedsUser(id, "Could not reserve the sats for this swap.");
  });
  const done = (async () => {
    try {
      // The order's authed calls (status/submit) all carry the wallet's
      // recovery capability (contract 2.2.0). The server indexes the order by
      // the recoveryKey it was COMMITTED with, so prefer the persisted value
      // and never let a live re-derivation (which can flip EOA↔credId when the
      // passkey credential id populates later in the session) orphan the order.
      // Only derive when there is no stored key (older rows), and persist it so
      // it stays stable thereafter.
      const stored = SwapKitV2OrderStore.get(id);
      let recoveryKey = stored?.recoveryKey;
      if (!recoveryKey) {
        recoveryKey = await getSwapKitV2RecoveryKey();
        if (stored) {
          await SwapKitV2OrderStore.upsert({ ...stored, recoveryKey }).catch(() => {});
        }
      }
      const view = initialView ?? (await getSwapKitV2Status(id, { recoveryKey }));
      orderRecoveryKey = recoveryKey;
      if (aborted() || !trackingIntakeOpen) return;
      rememberView(view);
      // An order that reached a terminal state while the app was suspended
      // comes back already terminal. Returning here skipped the pending-row
      // clear, the card confirm/revert, the balance application and the
      // refresh, so it kept stale optimistic state until something unrelated
      // corrected it. Reconcile it on THIS path too, then stop — there is no
      // loop to run for an order that is already finished.
      if (isSwapKitV2Terminal(view)) {
        reconcileV2TerminalOrder(id, view);
        return;
      }
      const result = await runSwapKitV2OrderLoop(view, id, {
        recoveryKey,
        executors: loopOptions?.executors ?? defaultV2ExecutorsFor(stored),
        allowedEvmChains: loopOptions?.allowedEvmChains,
        intervalMs: loopOptions?.intervalMs,
        maxPolls: loopOptions?.maxPolls,
        signal: controller.signal,
        beforeFunding: held,
        onUpdate: (latest) => {
          if (aborted()) return;
          rememberView(latest);
          try {
            loopOptions?.onUpdate?.(latest);
          } catch {}
        },
      });
      if (aborted()) return;
      rememberView(result); // reconciles when terminal
    } catch (error) {
      // A deliberate stop (soft logout) is not a failure: publish nothing,
      // write nothing — the account this order belonged to is going away.
      if (error instanceof SwapKitV2LoopAbortedError || aborted()) return;
      const last = lastViews.get(id);
      errorWithId(
        `${LOG_EMOJI.bitcoin} SwapKitV2.track`,
        `tracking stopped id=${id} ${formatV2TrackingFailureDiagnostic(error, last)}`,
        { err: error instanceof Error ? error.message : String(error) },
        { source: `${SOURCE}#startSwapKitV2Tracking`, event: "API_ERR", action: "track" },
      );
      failure = error instanceof Error ? error.message : String(error);
      isProviderRefused =
        (error instanceof SwapKitV2Error && error.code === "provider_refused") ||
        /solver refused|exposure_cap|provider_at_capacity|insufficient_float/i.test(failure);
      // Nothing left the wallet on this pass: the step was refused before its
      // broadcast, or the route needs an action this order's executors cannot
      // run at all (checked before anything executes).
      refusedUnsent =
        isRefusedBeforeBroadcast(error) ||
        (error instanceof SwapKitV2Error && error.code === "unsupported_action_kind") ||
        isProviderRefused;
    } finally {
      releaseSwapLoop(id);
      // Nothing was broadcast for the refused step: if the server confirms the
      // order is unfunded it is cancelled and removed, never left as a stuck
      // "Action required" move. A funded order keeps the path below.
      if (failure && refusedUnsent && orderRecoveryKey && trackingIntakeOpen) {
        const cancelled = await cancelUnfundedV2Order(id, orderRecoveryKey).catch(() => false);
        if (cancelled) {
          failure = null;
          // The partner refused this order: say so, plainly, instead of a
          // silent retry until it expires. Nothing was funded.
          if (isProviderRefused) recordProviderRefusedTerminalMessage(id);
        }
      }
      // AFTER the claim is released, never before: the pill's only CTA resumes
      // tracking, and a resume that races this loop's own claim would be
      // refused by the registry and silently do nothing.
      //
      // The loop only throws on something waiting cannot fix — an action kind
      // this flow cannot execute, an order the server does not know, a rejected
      // bound request. The user is no longer on a screen that could report it,
      // so it becomes an actionable pill rather than a log line nobody reads.
      // "Action required" is a claim that the USER can do something. It is
      // true only when the order's last known view actually carries a step for
      // them. A read that failed — swap_status erroring, the server slow or
      // briefly not recognising the order — says nothing about the order and
      // must not put an orange Continue on a swap that is finished or simply
      // still running: the user tapped nothing, so being told to act is wrong
      // and Continue only repeats the same failing read.
      const last = lastViews.get(id);
      if (failure && last && isSwapKitV2Terminal(last)) failure = null;
      if (
        failure &&
        !(last?.actions ?? []).some((a) => a.state === "ready" || a.state === "blocked")
      ) {
        logWithId(
          `${LOG_EMOJI.network} SwapKitV2.track`,
          `tracking stopped for ${id} with no user step pending; leaving it processing`,
          { orderId: id, err: failure },
          { source: `${SOURCE}#startSwapKitV2Tracking`, event: "FLOW", action: "quiet-stop" },
        );
        failure = null;
      }
      if (failure) noteV2MoveNeedsUser(id, failure);
    }
  })();
  activeV2Trackers.set(id, { controller, done });
  void done.finally(() => {
    if (activeV2Trackers.get(id)?.done === done) activeV2Trackers.delete(id);
  });
}

export function recordProviderRefusedTerminalMessage(orderId: string): void {
  const message = t("screen.BitcoinSendScreen.errorSendPartnerFull");
  const currentView = lastViews.get(orderId);
  const failureView: SwapKitV2OrderView = {
    ...(currentView ?? {
      mode: "commit" as const,
      orderId: asSwapKitV2OrderId(orderId),
      actions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    status: "FAILED",
    failure: {
      code: "provider_refused",
      message,
    },
  };
  lastViews.set(orderId, failureView);
  noteV2MoveStatus({
    orderId,
    status: "FAILED",
    failureReason: message,
  });
}

/**
 * Explicit Continue: re-arm tracking for an order whose loop has stopped, with
 * the same bounded executors foreground recovery uses.
 *
 * Throws when a loop is already driving the order. That is not a no-op to
 * swallow: the caller is a user-facing CTA, and silently resolving would show
 * a button that appears to do something and does not.
 */
export async function resumeSwapKitV2Order(
  orderId: string,
  view?: SwapKitV2OrderView,
): Promise<void> {
  if (isSwapLoopActive(orderId)) {
    throw new Error("This swap is already running.");
  }
  await SwapKitV2OrderStore.hydrate();
  const order = SwapKitV2OrderStore.get(orderId);
  const owner = await getEthereumAddress();
  if (!order || !owner || order.owner.toLowerCase() !== owner.toLowerCase()) {
    throw new Error("This swap does not belong to the signed-in wallet.");
  }
  const rebuilt = await rebuildV2ExecutorsForOrder(order);
  if (order.executorSpec && !rebuilt) throw new Error("Swap funding bounds are unavailable.");
  startSwapKitV2Tracking(orderId, view, { ...(rebuilt ?? {}), ...v2ArkadeHoldForOrder(order) });
}

/**
 * The server is the authority for which V2 swaps are still in flight. A
 * pending row naming a V2 order the server no longer lists as active is
 * confirmed against that order's own status and dropped once the server says
 * it is terminal or does not know it — the order finished (or expired) while
 * this device was not watching, or its commit never produced an order, and
 * nothing else would ever clear the row. A provisional row (`pending:<key>`)
 * is kept only while its commit is still in flight on this device. Any
 * transport failure keeps the row: an unreachable server proves nothing.
 * V1 rows (sk_… ids) and plain transfers are not touched here.
 */
async function dropSettledV2PendingRows(
  rows: readonly PendingWalletTransfer[],
  listed: readonly SwapKitV2OrderView[],
  recoveryKey: string,
): Promise<void> {
  const live = new Set(
    listed.filter((view) => !isSwapKitV2Terminal(view)).map((view) => view.orderId.toLowerCase()),
  );
  for (const row of rows) {
    const id = String(row.orderId || "").trim();
    if (!id || !String(row.source || "").startsWith("swapkit")) continue;
    if (id.startsWith("pending:")) {
      if (SwapKitV2OrderStore.get(`ord_${id}`)) continue; // its commit is still in flight
    } else if (id.startsWith("ord_")) {
      if (live.has(id.toLowerCase())) continue;
      const key = SwapKitV2OrderStore.get(id)?.recoveryKey ?? recoveryKey;
      try {
        const view = await getSwapKitV2Status(asSwapKitV2OrderId(id), { recoveryKey: key });
        if (!isSwapKitV2Terminal(view)) continue; // live after all (listed under another key)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // ONLY an authoritative "no such order" retires a row. An authorization
        // failure proves nothing about the order: the wrong key was presented,
        // or the right one was rejected, and the order may be very much alive
        // and funded. Deleting the row on that reading loses the user's only
        // handle on money in flight. The server answers both with one message,
        // so a key we could not authenticate keeps the row and retries.
        if (!/unknown order/i.test(message) || /unauthorized recoveryKey/i.test(message)) continue;
      }
    } else {
      continue;
    }
    await PendingWalletTransfersStore.remove(null, id).catch(() => {});
    logWithId(
      `${LOG_EMOJI.network} SwapKitV2.track`,
      `dropped pending row ${id}: the server has no live order behind it`,
      { orderId: id },
      { source: `${SOURCE}#dropSettledV2PendingRows`, event: "FLOW", action: "cleanup" },
    );
  }
}

/**
 * Startup/foreground resume: hydrate the local store, reconcile with the
 * server's swap_list for this owner (re-adopting orders lost to reinstall),
 * then re-arm tracking for every non-terminal order. v1 orders are untouched —
 * they resume through the v1 SwapKitPendingTracker.
 */
export async function resumeSwapKitV2Orders(): Promise<void> {
  await SwapKitV2OrderStore.hydrate();
  // The committed sats of every order still open. Held in memory only, a
  // relaunch mid-swap showed them as spendable again.
  await restoreV2ArkadeReservations().catch(() => {});
  const owner = await getEthereumAddress().catch(() => null as string | null);
  const recoveryKey = await getSwapKitV2RecoveryKey().catch(() => null as string | null);

  // Server-side reconciliation: an order the server still reports active must
  // be tracked even when the local row is gone (reinstall/clear-data). The
  // recovery capability is the wipe-stable index the server restores by.
  if (owner && recoveryKey) {
    // The swap rows the wallet shows as pending, as they were BEFORE the server
    // is asked. A commit that lands while swap_list is in flight writes its row
    // afterwards and is not judged by an answer that could not include it.
    const rowsBeforeList = await PendingWalletTransfersStore.list().catch(
      (): PendingWalletTransfer[] => [],
    );
    try {
      const listed = await listSwapKitV2Orders({ owner, recoveryKey, activeOnly: true });
      await dropSettledV2PendingRows(rowsBeforeList, listed.orders ?? [], recoveryKey);
      const recoveryOnly = makeRecoveryOnlyV2Executors();
      for (const view of listed.orders ?? []) {
        if (isSwapKitV2Terminal(view)) continue;
        if (!SwapKitV2OrderStore.get(view.orderId)) {
          // A discovered row never signs. An order with a READY action outside
          // the recovery-only set — typically the funding call of a commit
          // whose reply never reached this device, so nothing was signed for
          // it — would only fail its loop into "Action required" with a
          // Continue that fails the same way. Leave it unadopted: the next
          // commit on the corridor retires it, or the server expires it.
          const unexecutable = (view.actions ?? []).find(
            (action) =>
              action.state === "ready" && !recoveryOnly[action.kind as keyof typeof recoveryOnly],
          );
          if (unexecutable) {
            logWithId(
              `${LOG_EMOJI.network} SwapKitV2.track`,
              `not adopting ${view.orderId}: it waits on ${unexecutable.kind}, which a discovered row cannot sign`,
              { orderId: view.orderId },
              { source: `${SOURCE}#resumeSwapKitV2Orders`, event: "FLOW", action: "skip" },
            );
            continue;
          }
          await SwapKitV2OrderStore.upsert({
            orderId: view.orderId,
            owner,
            from: "",
            to: "",
            amount: "",
            side: "deposit",
            settleTarget: "",
            idempotencyKey: "",
            // Discovered rows have no accepted quote, route or amount. They
            // run recovery-only executors (claim/refund to this wallet); any
            // funding or signing action stops the loop for the user.
            status: view.status,
            flow: "other",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
      }
    } catch (error) {
      logWithId(
        `${LOG_EMOJI.network} SwapKitV2.track`,
        "swap_list reconcile failed (resuming from local rows only)",
        { err: error instanceof Error ? error.message : String(error) },
        { source: `${SOURCE}#resumeSwapKitV2Orders`, event: "API_ERR", action: "list" },
      );
    }
  }

  for (const order of SwapKitV2OrderStore.listOpen()) {
    if (order.orderId.startsWith("ord_pending:")) continue; // unresolved commit intents are handled by their owning flow
    // Owner binding: NEVER resume an order that belongs to a different wallet
    // than the one currently signed in. A stored order whose owner does not
    // match the current EOA (a prior user on this device, or a store not yet
    // cleared on logout) must not be driven with this wallet's keys.
    if (order.owner && owner && order.owner.toLowerCase() !== owner.toLowerCase()) {
      logWithId(
        `${LOG_EMOJI.network} SwapKitV2.track`,
        `skipping resume of order ${order.orderId}: owner mismatch`,
        { orderId: order.orderId },
        { source: `${SOURCE}#resumeSwapKitV2Orders`, event: "FLOW", action: "skip" },
      );
      continue;
    }
    // No current owner resolvable → cannot prove the order is ours; do not act.
    if (!owner) continue;
    // Rebuild the flow-specific executor set (bounded send_asset funder, chain
    // allowlist, approval ceiling) from the persisted spec. Without this a
    // resumed btc_to_stable/sweep order would fall back to the standard set and
    // reject its still-ready funding action, stranding funds (P1: resume
    // rebuild). Standard-executor flows return undefined and keep the default.
    const rebuilt = await rebuildV2ExecutorsForOrder(order).catch(
      () => null as Awaited<ReturnType<typeof rebuildV2ExecutorsForOrder>>,
    );
    // FAIL CLOSED, exactly as the single-order resume does: an order that
    // PERSISTED bounds whose rebuild failed must not be re-armed with the broad
    // default set. Doing so widens authority precisely where the recorded
    // consent could not be reconstructed — a malformed or unreadable spec would
    // grant the universal executors instead of the narrow ones the user agreed
    // to. Skip it; the next resume retries, and nothing moves meanwhile.
    if (order.executorSpec && !rebuilt) {
      console.log(
        `[SwapKitV2Resume] not re-arming ${order.orderId}: its bounded executors could not be rebuilt`,
      );
      continue;
    }
    if (order.from && order.to) {
      restoreV2Move({
        orderId: order.orderId,
        from: order.from,
        to: order.to,
        ...(order.settleTarget ? { settleTarget: order.settleTarget } : {}),
        ...(order.moveAmounts ?? {}),
      });
    }
    startSwapKitV2Tracking(order.orderId, undefined, {
      ...(rebuilt
        ? { executors: rebuilt.executors, allowedEvmChains: rebuilt.allowedEvmChains }
        : {}),
      // Re-reserve from the persisted order, not only from the ledger: the
      // row is missing when the app died before the first tracker wrote it.
      ...v2ArkadeHoldForOrder(order),
    });
  }
}
