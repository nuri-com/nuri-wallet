// The one commit+resume sequence every v2 order flow runs.
//
// Direct-EVM, stable→BTC and BTC→stable each did the identical nine steps in
// their own copy: derive an idempotency key, derive the recovery key, persist
// the commit intent, commit, resolve the intent to the real order id, announce
// the order id, emit the pending row, start tracking, refresh. Three copies
// meant three chances to omit a step — and exactly that happened: stable→BTC
// shipped without the `executorSpec` its siblings persisted, so a resumed order
// lost its approval ceiling and stranded mid-route.
//
// The flows keep everything that is genuinely theirs (validation, addresses,
// rails, capabilities, executor bounds, pending-row shape) and pass it in.
// What they no longer own is the ORDER of the steps, or the choice to skip one.
import { EventBus } from "../events/AppEventBusService";
import { paymentTimed, paymentTimingMark } from "../../lib/paymentTiming";
import { warmV2Funding } from "./SwapKitV2FundingWarmup";
import { finishInFlight, startSwapInFlight } from "../money/announce";
import type { OwnDestinations } from "../money/assetRails";
import { noteV2MoveCommitted, forgetV2Move } from "./SwapKitV2MoveStatus";
import {
  type SwapKitV2OrderView,
  type SwapKitV2SignerClass,
  asSwapKitV2OrderId,
  commitSwapKitV2,
} from "./SwapKitV2Service";
import { startSwapKitV2Tracking, emitV2SwapRefresh } from "./SwapKitV2PendingTracker";
import {
  newV2CommitIdempotencyKey,
  setV2QuoteRecoveryKeySource,
  takeV2QuoteCommitKey,
} from "./SwapKitV2QuoteCommitKey";
import { getSwapKitV2RecoveryKey } from "./SwapKitV2RecoveryKey";

setV2QuoteRecoveryKeySource(getSwapKitV2RecoveryKey);
import {
  type SwapKitV2ExecutorSpec,
  type SwapKitV2StoredOrder,
  abandonV2CommitIntent,
  persistV2CommitIntent,
  resolveV2CommitIntent,
  recordV2AdoptionHandoff,
  clearV2AdoptionHandoff,
} from "./SwapKitV2OrderStore";
import type { SwapKitV2LoopOptions } from "./SwapKitV2ActionService";

type V2Flow = SwapKitV2StoredOrder["flow"];
type LoopOptions = Partial<SwapKitV2LoopOptions>;

/**
 * Does this failure leave money possibly committed, so the UI must NOT offer to
 * run it again?
 *
 * A SwapKit v2 commit never sets it: nothing leaves the wallet until the app
 * signs, and the app signs nothing before the commit reply (order + actions)
 * is in hand — so a commit that failed or whose reply was lost is simply asked
 * for again. The flag belongs to spends that CAN have moved money before the
 * outcome is known (WirexWithdrawUnconfirmedError), and every surface that can
 * re-submit a spend asks THIS rather than re-deriving the rule.
 */
export function isUnresolvedCommitOutcome(error: unknown): boolean {
  return Boolean((error as { unresolved?: boolean } | null)?.unresolved);
}

/** The exact consent bounds and routing the user accepted. Amounts are exact
 * decimal strings — never re-derived, never re-rounded between persist and
 * commit, because the server binds them immutably on the first commit. */
export type V2CommitSpec = {
  flow: V2Flow;
  owner: string;
  from: string;
  to: string;
  /** Deposit amount in the source asset's own decimal unit. */
  amount: string;
  side: "deposit" | "settle";
  settleTarget: string;
  refundAddress: string;
  /** Display-side accepted deposit (e.g. sats) when it differs from `amount`. */
  acceptedDeposit?: string;
  acceptedDepositAmount: string;
  minimumSettleAmount: string;
  capabilities: readonly string[];
  optionId: string;
  /** The accepted option's quoteId (server contract): the commit names the
   * exact stored quote the user saw. */
  quoteId?: string;
  destination?: "card" | "wallet";
  /** JSON-safe inputs that let a restart rebuild the SAME bounded executors. */
  executorSpec?: SwapKitV2ExecutorSpec;
  /** Bounded executors for the live run. */
  loopOptions?: LoopOptions;
  onOrderId?: (orderId: string) => void;
  /** Committed leg amounts, forwarded to the move store so a Bitcoin-rail leg
   * (which no transfer store covers) can render its in-flight row. `sendAmount`
   * in the source display unit, `receiveAmount` in the destination's (sats for
   * a Bitcoin leg). */
  moveAmounts?: { sendAmount?: number; receiveAmount?: number };
  /** The signer class this flow's quote was priced for. The commit MUST name
   * the same one: an Arkade-funded route is quoted as `arkade-vhtlc`, and
   * committing it as an EOA changes the authority the user accepted. Defaults
   * to the EVM EOA, which is what every stablecoin-funded route uses. */
  signerClass?: SwapKitV2SignerClass;
  /** This wallet's own destinations, so the in-flight record can tell a move
   * INTO one of our balances from a send to someone else (which has no
   * destination screen). Absent means "no own address is known", and every
   * address-judged destination then counts as external. */
  own?: OwnDestinations;
  /** Which card pocket a card-settled swap credits. */
  cardPocket?: "EUR" | "USD" | null;
  /** Flow-specific pending activity row(s), emitted once the order id exists. A
   * flow may return one row or several — a stable→stable swap emits two: an
   * `out` debit on the source rail and an `in` credit on the destination rail. */
  pendingRow?: (
    orderId: string,
  ) =>
    | { event: string; payload: Record<string, unknown> }
    | Array<{ event: string; payload: Record<string, unknown> }>
    | null;
};

/** Waits between durable-adoption attempts, on top of the cache's own retries.
 * SQLite busy is contention that clears in moments; this rides it out before
 * the move is reported unresolved. */
export const ADOPTION_RETRY_DELAYS_MS: readonly number[] = [250, 1_000, 3_000];

/**
 * Write the real order row in place of its intent. The order id is put in the
 * adoption handoff (a separate store) BEFORE any retry wait, so a process that
 * dies while SQLite is busy still adopts this order on its next launch.
 */
async function adoptCommittedOrder(
  idempotencyKey: string,
  orderId: string,
  status: string,
): Promise<void> {
  try {
    await resolveV2CommitIntent(idempotencyKey, orderId, status);
    return;
  } catch (first) {
    // Recorded before any wait, and retried with every attempt until it lands.
    const record = () =>
      recordV2AdoptionHandoff({ idempotencyKey, orderId, status }).then(
        () => true,
        () => false,
      );
    let recorded = await record();
    let last: unknown = first;
    for (const delayMs of ADOPTION_RETRY_DELAYS_MS) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (!recorded) recorded = await record();
      try {
        await resolveV2CommitIntent(idempotencyKey, orderId, status);
        if (recorded) await clearV2AdoptionHandoff(idempotencyKey).catch(() => {});
        return;
      } catch (error) {
        last = error;
      }
    }
    throw last;
  }
}

/**
 * Commit an accepted option and hand the order to the durable tracker.
 *
 * The intent row is written BEFORE the request goes out and becomes the order's
 * durable row (flow + bounded executorSpec) the moment the reply names the
 * order — before any action is signed. A commit whose reply never arrives has
 * nothing signed behind it and is dropped, never replayed: the user asks again
 * (see discardUnsignedV2CommitIntents in SwapKitV2OrderStore). The recovery
 * key is derived ONCE here and persisted with the
 * intent, so every later status/submit/list call reuses the exact value the
 * order was committed with (a live re-derivation can flip EOA↔credId once the
 * passkey credential id populates, which would orphan the order server-side).
 */
export async function commitAndTrackV2Order(
  spec: V2CommitSpec,
): Promise<{ orderId: string; view: SwapKitV2OrderView }> {
  // The key the quote named, so the server already prepared this commit's
  // storage (single use); otherwise a new one.
  const idempotencyKey =
    takeV2QuoteCommitKey(spec.quoteId) ?? newV2CommitIdempotencyKey(spec.owner);
  const recoveryKey = await paymentTimed("recovery key", () => getSwapKitV2RecoveryKey());

  await paymentTimed("phone stores commit intent", () =>
    persistV2CommitIntent({
      idempotencyKey,
      owner: spec.owner,
      from: spec.from,
      to: spec.to,
      amount: spec.amount,
      side: spec.side,
      settleTarget: spec.settleTarget,
      refundAddress: spec.refundAddress,
      acceptedDeposit: spec.acceptedDeposit ?? spec.acceptedDepositAmount,
      acceptedDepositAmount: spec.acceptedDepositAmount,
      minimumSettleAmount: spec.minimumSettleAmount,
      optionId: spec.optionId,
      recoveryKey,
      flow: spec.flow,
      destination: spec.destination,
      executorSpec: spec.executorSpec,
      ...(spec.moveAmounts ? { moveAmounts: spec.moveAmounts } : {}),
    }),
  );

  // Show the move the INSTANT the user accepts, not after the commit round-trip
  // (which is a 2–3s network call). The pill and the pending rows are emitted
  // now under a provisional id; once the real order id is known they are
  // re-emitted under it and the provisional copies dropped. The content is
  // identical, so the swap is visually continuous — the row and pill just
  // appear immediately instead of after the server answers.
  const provisionalId = `pending:${idempotencyKey}`;
  const rowsFor = (id: string) => {
    const rowSpec = spec.pendingRow?.(id);
    return Array.isArray(rowSpec) ? rowSpec : rowSpec ? [rowSpec] : [];
  };
  const emitRows = (id: string) => {
    for (const row of rowsFor(id)) {
      try {
        EventBus.emit(row.event, row.payload);
      } catch {}
    }
  };
  // Only surfaces a flow actually produces are shown/cleared. A flow with no
  // pending row (card top-up destination, etc.) emits nothing here — and thus
  // nothing to clear later.
  const hasProvisionalRows = rowsFor(provisionalId).length > 0;
  noteV2MoveCommitted({
    orderId: provisionalId,
    from: spec.from,
    to: spec.to,
    settleTarget: spec.settleTarget,
    ...(spec.moveAmounts ?? {}),
  });
  if (hasProvisionalRows) emitRows(provisionalId);
  // Every v2 swap passes through here, so this one call is what gives EVERY
  // route its rows on both of its screens — no flow has to remember to.
  const announce = (id: string) =>
    startSwapInFlight({
      orderId: id,
      from: spec.from,
      to: spec.to,
      sendAmount: Number(spec.moveAmounts?.sendAmount ?? 0),
      receiveAmount: Number(spec.moveAmounts?.receiveAmount ?? 0),
      settleTarget: spec.settleTarget,
      own: spec.own ?? {},
      ...(spec.cardPocket ? { cardPocket: spec.cardPocket } : {}),
    }).catch(() => {});
  void announce(provisionalId);

  const dropProvisional = () => {
    forgetV2Move(provisionalId);
    void finishInFlight(provisionalId).catch(() => {});
    if (hasProvisionalRows) {
      try {
        EventBus.emit("wallet:clearPendingTransfer", { txHash: null, orderId: provisionalId });
      } catch {}
    }
  };

  // An Arkade-funded order is signed right after the commit returns; what that
  // send waits for is read while the server commits.
  if (spec.from === "BTC_ARKADE" || spec.from === "BTC_LN") warmV2Funding();
  let view: SwapKitV2OrderView;
  try {
    view = await commitSwapKitV2({
      from: spec.from,
      to: spec.to,
      amount: spec.amount,
      side: spec.side,
      owner: spec.owner,
      settleTarget: spec.settleTarget,
      refundAddress: spec.refundAddress,
      capabilities: spec.capabilities,
      signerClass: spec.signerClass ?? { evm: "eoa" },
      optionId: spec.optionId,
      ...(spec.quoteId ? { quoteId: spec.quoteId } : {}),
      idempotencyKey,
      recoveryKey,
      acceptedDepositAmount: spec.acceptedDepositAmount,
      minimumSettleAmount: spec.minimumSettleAmount,
    });
  } catch (error) {
    // No reply, no order to act on: the wallet has signed nothing for it, so
    // nothing can have left. Whatever the server may have created stays
    // unfunded and is retired by the next commit on this corridor (or expires).
    // So this is a plain failure — drop the intent and the optimistic surfaces
    // and let the caller ask again. Re-sending THIS key later would re-quote a
    // stale price and, at best, adopt an order nobody is waiting for.
    await abandonV2CommitIntent(idempotencyKey).catch(() => {});
    dropProvisional();
    throw error;
  }

  const orderId = asSwapKitV2OrderId(view.orderId);
  try {
    await paymentTimed("phone adopts order", () =>
      adoptCommittedOrder(idempotencyKey, orderId, view.status),
    );
  } catch (error) {
    // The server named a real order but this device could not record it. The
    // order id is kept in the adoption handoff and the next launch (or
    // foreground) adopts it under the same idempotency key, so nothing
    // re-commits. Until then it is unresolved: every money surface refuses a
    // fresh commit on this flag.
    const unresolved = error instanceof Error ? error : new Error(String(error));
    Object.assign(unresolved, { unresolved: true, orderId, idempotencyKey });
    throw unresolved;
  }
  spec.onOrderId?.(orderId);

  // Re-home the optimistic surfaces onto the real order id, then drop the
  // provisional copies. Emit the real rows/pill first so there is never a frame
  // with neither.
  noteV2MoveCommitted({
    orderId,
    replaces: provisionalId,
    from: spec.from,
    to: spec.to,
    settleTarget: spec.settleTarget,
    ...(spec.moveAmounts ?? {}),
  });
  emitRows(orderId);
  void announce(orderId);
  dropProvisional();

  paymentTimingMark("tracking starts");
  startSwapKitV2Tracking(orderId, view, {
    ...spec.loopOptions,
    // Arkade-funded orders: the sats are spoken for from HERE, not from the
    // moment the wallet pays — the server still has to create the provider
    // order and issue the funding invoice, and leaving the amount spendable in
    // that window let a second move race this one.
    holdArkadeSats: Number(spec.acceptedDeposit ?? spec.moveAmounts?.sendAmount ?? 0),
    fromAsset: spec.from,
  });
  emitV2SwapRefresh();
  return { orderId, view };
}
