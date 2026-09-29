// The one place that knows what every in-flight SwapKit v2 move is DOING.
//
// Once a quote is accepted the user is finished: the sheet closes and the move
// carries on without a screen of its own. That only works if something outside
// the sheet can say where the move got to — this store is that something. The
// tracker feeds it every order view it sees, the EVM signer names the step it
// is signing, and the status pill renders whatever is here.
//
// Deliberately import-free apart from types: it is a plain observable map, so
// it can be unit-tested without the tracker, the signer, or a React tree.

/** What the pill says, in the order a move passes through it. */
export type SwapKitV2MovePhase =
  /** Accepted, and the wallet has not paid yet: the server is setting the
   * order up and the passkey prompt is still to come. The app must stay open. */
  | "preparing"
  /** Committed, nothing signable happening this instant. */
  | "processing"
  /** The wallet is raising the ERC-20 allowance the route needs. */
  | "approving"
  /** The wallet is broadcasting the call that actually moves the funds. */
  | "executing"
  /** The route needs something this wallet cannot do unattended. */
  | "action_required"
  | "completed"
  | "failed"
  | "refunded";

export type SwapKitV2Move = {
  orderId: string;
  phase: SwapKitV2MovePhase;
  /** Asset ids as committed, for the detail surface and the activity rows. */
  from: string;
  to: string;
  /** Leg amounts as committed, so a rail with no transfer-store coverage (the
   * two Bitcoin rails) can still render this move's in-flight row. `sendAmount`
   * is in the source asset's display unit, `receiveAmount` in the destination's
   * (sats for a Bitcoin leg). Absent until a producer supplies them. */
  sendAmount?: number;
  receiveAmount?: number;
  /** The Bitcoin destination this move settles to, when it has one. Both
   * Bitcoin rails commit as `to: BTC` (on-chain), so the asset id alone cannot
   * say which wallet the sats land in — the settle address does: the arkade
   * boarding address routes the row to the arkade rail, the on-chain receive
   * address to the onchain rail. Absent for non-Bitcoin moves. */
  settleTarget?: string;
  /** Server status behind `phase`, for logs and the detail sheet. */
  status: string;
  /** Why the move needs the user, when it does. */
  blockedReason?: string | null;
  /** A plain wallet↔card transfer rather than a swap order: its id is not an
   * order id, so there is no order detail to open for it. */
  kind?: "transfer";
  /** The in-flight record (pending rows) this pill speaks for, when its id is
   * not the move's own. "Completed" on the pill and the rows leaving are ONE
   * event: the rows go the moment the pill says it. */
  inFlightId?: string;
  /** Presentation only — tracking and recovery are untouched by it. */
  dismissed: boolean;
  updatedAt: number;
};

const TERMINAL_PHASES: Record<string, SwapKitV2MovePhase> = {
  COMPLETED: "completed",
  FAILED: "failed",
  EXPIRED: "failed",
  CANCELLED: "failed",
  REFUNDED: "refunded",
};

export function isTerminalMovePhase(phase: SwapKitV2MovePhase): boolean {
  return phase === "completed" || phase === "failed" || phase === "refunded";
}

const moves = new Map<string, SwapKitV2Move>();
// Provisional id → the order id that replaced it, so anything still holding
// the provisional id (an open pill, its detail sheet) follows the real order.
const replacedBy = new Map<string, string>();
const listeners = new Set<(moves: readonly SwapKitV2Move[]) => void>();

function snapshot(): readonly SwapKitV2Move[] {
  return [...moves.values()].sort((a, b) => a.updatedAt - b.updatedAt);
}

function publish(): void {
  const current = snapshot();
  for (const listener of listeners) {
    try {
      listener(current);
    } catch {}
  }
}

/** Every move this session knows about, oldest first. */
export function listV2Moves(): readonly SwapKitV2Move[] {
  return snapshot();
}

/** The id a move is known by now: a provisional id resolves to its order. */
export function resolveV2MoveId(orderId: string): string {
  let id = orderId;
  for (let hops = 0; hops < 4 && replacedBy.has(id); hops++) id = replacedBy.get(id) ?? id;
  return id;
}

export function getV2Move(orderId: string): SwapKitV2Move | null {
  return moves.get(orderId) ?? null;
}

export function subscribeV2Moves(listener: (moves: readonly SwapKitV2Move[]) => void): () => void {
  listeners.add(listener);
  listener(snapshot());
  return () => {
    listeners.delete(listener);
  };
}

/** What a move IS, as opposed to where it got to. */
const DETAIL_FIELDS = ["from", "to", "sendAmount", "receiveAmount", "settleTarget"] as const;

function write(orderId: string, patch: Partial<SwapKitV2Move>): void {
  const id = String(orderId || "").trim();
  if (!id) return;
  const existing = moves.get(id);
  const next: SwapKitV2Move = {
    orderId: id,
    phase: "processing",
    from: "",
    to: "",
    status: "",
    blockedReason: null,
    dismissed: false,
    ...existing,
    ...patch,
    updatedAt: Date.now(),
  };
  // A terminal phase is final: a late status poll for a completed order must
  // not drag the pill back to "Processing".
  if (existing && isTerminalMovePhase(existing.phase) && !isTerminalMovePhase(next.phase)) return;
  // A repeat of the SAME phase is not news — republishing it would re-show a
  // pill the user dismissed and re-run terminal side effects on duplicates.
  if (
    existing &&
    existing.phase === next.phase &&
    existing.status === next.status &&
    existing.blockedReason === next.blockedReason
  ) {
    // ...but it can still carry details the first write did not have. The
    // sheet's handoff notes the move before the commit flow notes it again
    // with its leg amounts and settle target; dropping those leaves the
    // Bitcoin leg's pending row with 0 sats on the wrong rail. Keep them,
    // without touching the phase or the dismissal.
    const details: Partial<SwapKitV2Move> = {};
    for (const field of DETAIL_FIELDS) {
      const value = patch[field];
      if (value !== undefined && value !== "" && value !== existing[field]) {
        (details as Record<string, unknown>)[field] = value;
      }
    }
    if (Object.keys(details).length === 0) return;
    moves.set(id, { ...existing, ...details, updatedAt: Date.now() });
    publish();
    return;
  }
  // Any genuine phase change is worth showing again, even after a dismissal:
  // the user dismissed "Processing", not "Action required".
  if (existing && existing.phase !== next.phase) next.dismissed = false;
  moves.set(id, next);
  publish();
}

/**
 * A move exists. Called at the commit handoff — the moment the sheet closes —
 * so the pill takes over from the screen with nothing in between.
 */
export function noteV2MoveCommitted(args: {
  orderId: string;
  from?: string;
  to?: string;
  status?: string;
  sendAmount?: number;
  receiveAmount?: number;
  settleTarget?: string;
  /** The provisional id this order takes over from, once the server named it. */
  replaces?: string;
}): void {
  const replaced = args.replaces ? moves.get(args.replaces) : undefined;
  if (args.replaces && args.replaces !== args.orderId) {
    replacedBy.set(args.replaces, String(args.orderId || "").trim());
  }
  write(args.orderId, {
    phase: "preparing",
    from: args.from ?? "",
    to: args.to ?? "",
    status: args.status ?? "",
    ...(typeof args.sendAmount === "number" ? { sendAmount: args.sendAmount } : {}),
    ...(typeof args.receiveAmount === "number" ? { receiveAmount: args.receiveAmount } : {}),
    ...(args.settleTarget ? { settleTarget: args.settleTarget } : {}),
    // Already acknowledged under the provisional id: the same move, not news.
    ...(replaced?.dismissed ? { dismissed: true } : {}),
  });
}

/**
 * App start: a stored order that is still open becomes a move again. The move
 * store lives in memory, so without this every Bitcoin-rail pending row (which
 * is drawn from the move, not from a store of its own) vanished on restart.
 * Never downgrades a move this session already knows.
 */
export function restoreV2Move(args: {
  orderId: string;
  from: string;
  to: string;
  settleTarget?: string;
  sendAmount?: number;
  receiveAmount?: number;
}): void {
  if (moves.has(args.orderId)) return;
  write(args.orderId, {
    phase: "processing",
    from: args.from,
    to: args.to,
    ...(args.settleTarget ? { settleTarget: args.settleTarget } : {}),
    ...(typeof args.sendAmount === "number" ? { sendAmount: args.sendAmount } : {}),
    ...(typeof args.receiveAmount === "number" ? { receiveAmount: args.receiveAmount } : {}),
    // Already seen in an earlier session: restore the row, not the pill.
    dismissed: true,
  });
}

/** Server said something. Terminal statuses win; everything else is progress. */
export function noteV2MoveStatus(args: {
  orderId: string;
  status: string;
  from?: string;
  to?: string;
  blockedReason?: string | null;
}): void {
  const status = String(args.status || "").toUpperCase();
  const terminal = TERMINAL_PHASES[status];
  // Server progress before the wallet has paid is still "preparing": only the
  // wallet's own payment (noteV2MovePaid) or an outcome ends it.
  const stillPreparing = moves.get(args.orderId)?.phase === "preparing";
  write(args.orderId, {
    status: args.status,
    ...(args.from ? { from: args.from } : {}),
    ...(args.to ? { to: args.to } : {}),
    ...(terminal
      ? { phase: terminal, blockedReason: null }
      : args.blockedReason
        ? { phase: "action_required", blockedReason: args.blockedReason }
        : { phase: stillPreparing ? "preparing" : "processing", blockedReason: null }),
  });
}

/** The wallet has paid its part: nothing more needs the app to stay open. */
export function noteV2MovePaid(orderId: string): void {
  const existing = moves.get(orderId);
  if (!existing || existing.phase !== "preparing") return;
  write(orderId, { phase: "processing", blockedReason: null });
}

/**
 * The wallet is signing something right now. This is the only source of
 * "Approving…"/"Executing…": both are wallet-side steps the server's status
 * cannot see, and inferring them from elapsed time would be a guess.
 */
export function noteV2MoveStep(orderId: string, step: "approving" | "executing"): void {
  const existing = moves.get(orderId);
  if (existing && isTerminalMovePhase(existing.phase)) return;
  write(orderId, { phase: step, blockedReason: null });
}

/**
 * The move cannot continue unattended — a step whose key material needs the
 * user. The pill offers it; tapping runs THAT step, nothing else.
 */
export function noteV2MoveNeedsUser(orderId: string, reason: string): void {
  write(orderId, { phase: "action_required", blockedReason: reason });
}

/** A wallet↔card transfer, shown by the same pill as a swap. */
export function noteV2TransferPhase(
  id: string,
  phase: "preparing" | "processing" | "completed" | "failed",
  inFlightId?: string | null,
): void {
  write(id, {
    kind: "transfer",
    phase,
    status: phase,
    blockedReason: null,
    ...(inFlightId ? { inFlightId } : {}),
  });
}

/** Hide the presentation. Tracking, recovery and accounting are untouched. */
export function dismissV2Move(orderId: string): void {
  const existing = moves.get(orderId);
  if (!existing || existing.dismissed) return;
  moves.set(orderId, { ...existing, dismissed: true });
  publish();
}

/** Drop a finished move from the pill once the user has seen its outcome. */
export function forgetV2Move(orderId: string): void {
  if (!moves.delete(orderId)) return;
  publish();
}

/** Soft logout: in-flight moves belong to the previous account. */
export function clearV2Moves(): void {
  replacedBy.clear();
  if (moves.size === 0) return;
  moves.clear();
  publish();
}
