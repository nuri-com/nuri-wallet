// The status pill for a move that is not a swap order: wallet↔card transfers,
// the two bitcoin wallets, plain sends. The user leaves the sheet the same way
// as for a swap, so the SAME pill carries it: "Preparing" (keep the app open)
// while the wallet still has to sign, "Processing" once it is out, and
// Completed / Move failed at the end. When the move has pending rows, the pill
// completes exactly when they clear, and the rows clear exactly when the pill
// completes — one event, never two clocks.
// Presentation only: nothing here touches a balance.
import { isUserCancelledAuth } from "../../lib/support/isUserCancelledAuth";
import { shouldRevertOptimisticWithdraw } from "../../lib/wirex/withdrawRollback";
import { EventBus } from "../events/AppEventBusService";
import { MoneyInFlightStore } from "../money/MoneyInFlightStore";
import { forgetV2Move, noteV2TransferPhase } from "../swapkit/SwapKitV2MoveStatus";

// A broadcast whose receipt never arrives must not spin forever.
const SETTLE_WATCH_MS = 10 * 60_000;
// A move settled by its pending rows (a bitcoin send waits on a block).
const ROWS_WATCH_MS = 3 * 60 * 60_000;
// The rows are written by the producer a moment after the broadcast returns.
const ROWS_APPEAR_GRACE_MS = 15_000;

let sequence = 0;

export type MovePillOptions<T> = {
  /** Start in "Preparing" (keep the app open): the wallet still has to sign. */
  preparing?: boolean;
  /** The in-flight record the move's pending rows are written under. */
  inFlightIdOf?: (result: T) => string | null | undefined;
  /** The result was handed to a tracked order, whose own pill takes over. */
  handedOff?: (result: T) => boolean;
  /** The move is complete when `run` resolves (a card withdrawal): the pill
   * says Completed then, and its rows go with it. Otherwise a move with rows
   * completes when they clear. */
  completesOnResolve?: boolean;
};

/**
 * Run a move under the pill. `settlesByTx` names the tx hash when the transfer
 * resolves at broadcast (wallet → card): the pill then completes on that
 * hash's `wallet:transferSettled`. A move with pending rows completes when its
 * rows clear. Otherwise resolving is completion.
 */
export async function withCardTransferPill<T>(
  run: () => Promise<T>,
  settlesByTx?: ((result: T) => { txHash?: string; confirmed: boolean } | null | undefined) | null,
  options: MovePillOptions<T> = {},
): Promise<T> {
  sequence += 1;
  const id = `transfer:${Date.now()}:${sequence}`;
  noteV2TransferPhase(id, options.preparing ? "preparing" : "processing");
  let result: T;
  try {
    result = await run();
  } catch (error) {
    // Cancelling the passkey prompt moved nothing, and an unconfirmed
    // withdrawal may still settle (the Move sheet holds that state): neither is
    // a failure to report.
    if (isUserCancelledAuth(error) || !shouldRevertOptimisticWithdraw(error)) forgetV2Move(id);
    else noteV2TransferPhase(id, "failed");
    throw error;
  }
  if (options.handedOff?.(result)) {
    forgetV2Move(id);
    return result;
  }
  const inFlightId = options.inFlightIdOf?.(result)?.trim() || null;
  const broadcast = settlesByTx?.(result);
  const txHash = broadcast?.txHash?.trim().toLowerCase();
  if (broadcast && !broadcast.confirmed && txHash) {
    noteV2TransferPhase(id, "processing", inFlightId ?? txHash);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = EventBus.on<{ txHash?: string | null; reverted?: boolean }>(
      "wallet:transferSettled",
      (payload) => {
        if (
          String(payload?.txHash ?? "")
            .trim()
            .toLowerCase() !== txHash
        )
          return;
        off();
        if (timer) clearTimeout(timer);
        noteV2TransferPhase(id, payload?.reverted ? "failed" : "completed");
      },
    );
    timer = setTimeout(() => {
      off();
      forgetV2Move(id);
    }, SETTLE_WATCH_MS);
    return result;
  }
  if (!inFlightId || options.completesOnResolve) {
    noteV2TransferPhase(id, "completed", inFlightId);
    return result;
  }
  // Settled by its rows: "Completed" is the moment they clear.
  noteV2TransferPhase(id, "processing", inFlightId);
  settleWithRows(id, inFlightId);
  return result;
}

export type MovePill = {
  /** The wallet has signed and the money is out: settled by its rows. */
  settleByRows: (inFlightId: string | null | undefined) => void;
  /** Handed to a tracked order whose own pill takes over. */
  handedOff: () => void;
  /** Nothing moved (a cancelled prompt, a refusal before signing). */
  drop: () => void;
  /** Went wrong after the hand-off. */
  fail: () => void;
};

/** The same pill, for a flow that is not one promise. Starts in Preparing. */
export function startMovePill(): MovePill {
  sequence += 1;
  const id = `transfer:${Date.now()}:${sequence}`;
  noteV2TransferPhase(id, "preparing");
  let done = false;
  const once = (fn: () => void) => () => {
    if (done) return;
    done = true;
    fn();
  };
  return {
    settleByRows: (inFlightId) => {
      if (done) return;
      done = true;
      const key = inFlightId?.trim();
      if (!key) {
        noteV2TransferPhase(id, "completed");
        return;
      }
      noteV2TransferPhase(id, "processing", key);
      settleWithRows(id, key);
    },
    handedOff: once(() => forgetV2Move(id)),
    drop: once(() => forgetV2Move(id)),
    fail: once(() => noteV2TransferPhase(id, "failed")),
  };
}

function settleWithRows(pillId: string, inFlightId: string): void {
  const startedAt = Date.now();
  let seen = false;
  let settled = false;
  let off: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const finish = (phase: "completed" | null) => {
    if (settled) return;
    settled = true;
    off?.();
    if (timer) clearTimeout(timer);
    if (phase) noteV2TransferPhase(pillId, phase, inFlightId);
    else forgetV2Move(pillId);
  };
  const check = () => {
    const present = MoneyInFlightStore.list().some((row) => row.id === inFlightId);
    if (present) {
      seen = true;
      return;
    }
    if (seen || Date.now() - startedAt > ROWS_APPEAR_GRACE_MS) finish("completed");
  };
  off = EventBus.on(MoneyInFlightStore.CHANGED, check);
  timer = setTimeout(() => finish(null), ROWS_WATCH_MS);
  void MoneyInFlightStore.hydrate()
    .then(check)
    .catch(() => {});
  // Rows never written still resolve the pill once the grace has passed.
  setTimeout(check, ROWS_APPEAR_GRACE_MS + 50);
}
