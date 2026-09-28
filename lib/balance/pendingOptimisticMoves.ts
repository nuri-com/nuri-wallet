// Ties an optimistic balance move to the transaction that is supposed to make
// it real, on BOTH sides of a transfer.
//
// A wallet → card top-up does not wait for its receipt: the sheet closes, the
// wallet is debited and the card credited as soon as the transfer is broadcast.
// If that transaction is later mined REVERTED, neither move should stand — but
// an anchor cannot tell a reverted transfer from a slow one, so it would hold
// the promised figures until they expired. The moves' handles are parked here
// under the tx hash and claimed once the receipt is in: reverted → revert those
// exact moves, mined → drop the entries.
//
// Scoped because the two sides own separate anchors (the card's lives in
// WirexAccountService, the wallet's in its own balance state) and are reverted by
// different owners.
//
// Kept import-free so it is unit-testable without pulling either of those
// (native-dependency-heavy) modules into the test environment.

// One balance each. "wallet" is the euro wallet and "dollar" the USDC one on the
// same address — two stores, so a move parked under the wrong scope would be
// reverted against a balance it never touched.
export type OptimisticMoveScope = "card" | "wallet" | "dollar";

const pending = new Map<string, number>();

function keyFor(scope: OptimisticMoveScope, txHash: string | null | undefined): string {
  const hash = String(txHash ?? "")
    .trim()
    .toLowerCase();
  return hash ? `${scope}:${hash}` : "";
}

export function rememberOptimisticMove(
  scope: OptimisticMoveScope,
  txHash: string | null | undefined,
  handle: number | null,
): void {
  const key = keyFor(scope, txHash);
  if (!key || handle == null) return;
  pending.set(key, handle);
}

/** Returns the handle for this tx and forgets it. Null when nothing is parked. */
export function takeOptimisticMove(
  scope: OptimisticMoveScope,
  txHash: string | null | undefined,
): number | null {
  const key = keyFor(scope, txHash);
  if (!key) return null;
  const handle = pending.get(key);
  if (handle == null) return null;
  pending.delete(key);
  return handle;
}

// Settlements that arrived before their credit was parked. A direct swap runs to its terminal state
// before it returns, so its settlement always comes first; a credit parked afterwards must learn the
// outcome here instead of waiting for an event that already passed. Bounded: an entry nobody claims
// is dropped with the oldest.
const EARLY_SETTLEMENT_LIMIT = 50;
const early = new Map<string, boolean>();

/**
 * An order reached its outcome. Returns the parked handle (taken) when its credit is already
 * parked; otherwise records the outcome for the credit that is still on its way, and returns null.
 */
export function settleOptimisticMove(
  scope: OptimisticMoveScope,
  id: string | null | undefined,
  ok: boolean,
): number | null {
  const handle = takeOptimisticMove(scope, id);
  if (handle != null) return handle;
  const key = keyFor(scope, id);
  if (!key) return null;
  early.delete(key);
  early.set(key, ok);
  while (early.size > EARLY_SETTLEMENT_LIMIT) {
    const oldest = early.keys().next().value;
    if (oldest === undefined) break;
    early.delete(oldest);
  }
  return null;
}

/** The outcome that arrived before this credit, taken. Null when none has arrived. */
export function takeEarlySettlement(
  scope: OptimisticMoveScope,
  id: string | null | undefined,
): boolean | null {
  const key = keyFor(scope, id);
  if (!key || !early.has(key)) return null;
  const ok = early.get(key) === true;
  early.delete(key);
  return ok;
}

/**
 * Park a credit's handle until its order settles, unless it already has. Returns the outcome when
 * the settlement came first (nothing is parked then, and the caller owns the handle), else null.
 */
export function parkOptimisticMove(
  scope: OptimisticMoveScope,
  id: string | null | undefined,
  handle: number | null,
): boolean | null {
  const outcome = takeEarlySettlement(scope, id);
  if (outcome != null) return outcome;
  rememberOptimisticMove(scope, id, handle);
  return null;
}

/** Session teardown — a new identity must not inherit the previous one's moves. */
export function clearOptimisticMoves(): void {
  pending.clear();
  early.clear();
}
