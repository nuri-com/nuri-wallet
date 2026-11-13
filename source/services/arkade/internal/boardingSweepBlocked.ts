// Boarding outpoints the ASP has refused because another registration holds
// them.
//
// While an attempt's registration is queued or in a running round, every other
// attempt over the same coin is refused with
// `duplicated input, <txid>:<vout> already registered by another intent`, and
// the matching `deleteIntent` is refused too. In arkd v0.9.26 that hold ends
// when the next round starts, within about a minute (see duplicatedIntent.ts).
//
// Without this list the sweep re-selects the same held outpoint on every tick:
// `selectSingleBoardingUtxoForSweep` sorts candidates and takes the lowest, so a
// held coin would be picked again before any other boarding UTXO is attempted.
//
// So: remember the outpoints the ASP named in that refusal and skip them while
// other candidates exist, for about as long as the hold can last. In-memory
// only, so a reload costs one retry of the held coin before it is skipped again.
import { emitTrace } from "./logging";

/** Outpoints named in a `duplicated input` refusal, as `txid:vout`. */
export type BoardingOutpointRef = { txid: string; vout: number };

/**
 * How long an outpoint stays skipped after the ASP refused it: one round to end
 * and the next to start, with margin.
 */
export const BOARDING_SWEEP_BLOCKED_TTL_MS = 2 * 60 * 1000;

type BlockedOutpointEntry = {
  expiresAtMs: number;
  detail: string;
  /**
   * Turns this coin has taken as the attempt target. Rotation is driven by
   * turns, and a turn is consumed by EVERY selection, including one that then
   * fails before it reaches the ASP (preflight: summary load, fee info,
   * approval). Counting only ASP-reaching attempts would let a coin whose
   * preflight keeps failing be re-selected forever, because it would never
   * accumulate the count that moves the rotation on.
   */
  turns: number;
  /**
   * Times the sweep actually reached the ASP with this coin. This is the count
   * that means something about the block itself, so it is only incremented at
   * the settle call, never by a preflight failure.
   */
  attempts: number;
  /**
   * When this coin was last selected, as a monotonic sequence number. Ties on
   * `turns` are broken by this rather than by outpoint: a key tie-break always
   * favours the lowest outpoint, which lets a coin refused a moment ago be
   * selected again immediately. The oldest selection goes first instead.
   */
  selectedSeq: number;
};

/**
 * Monotonic selection counter. Only ever compared against itself, so the actual
 * value is meaningless; what matters is the order coins were selected in.
 */
let selectionSeq = 0;

function nextSelectionSeq(): number {
  selectionSeq += 1;
  return selectionSeq;
}

const blockedOutpoints = new Map<string, BlockedOutpointEntry>();

export function boardingOutpointRefKey(ref: BoardingOutpointRef): string | null {
  const txid = String(ref?.txid || "")
    .trim()
    .toLowerCase();
  const vout = Number(ref?.vout);
  if (!/^[0-9a-f]{64}$/.test(txid) || !Number.isInteger(vout) || vout < 0) return null;
  return `${txid}:${vout}`;
}

/**
 * Record that the ASP holds a registration over these outpoints, so selection
 * can prefer other candidates. Returns the keys actually recorded.
 */
export function markBoardingOutpointsBlocked(
  refs: BoardingOutpointRef[],
  detail: string,
  nowMs = Date.now(),
): string[] {
  const recorded: string[] = [];
  for (const ref of Array.isArray(refs) ? refs : []) {
    const key = boardingOutpointRefKey(ref);
    if (!key || recorded.includes(key)) continue;
    const existing = blockedOutpoints.get(key);
    blockedOutpoints.set(key, {
      expiresAtMs: nowMs + BOARDING_SWEEP_BLOCKED_TTL_MS,
      detail: existing && existing.expiresAtMs > nowMs ? existing.detail : detail,
      // A coin that is blocked for the first time joins at the rotation level of
      // the coins already waiting, not at zero. Starting at zero hands the
      // newcomer the front of the queue and it keeps it until it catches up,
      // which starves the coins that were already blocked.
      turns: existing?.turns ?? highestTurns(nowMs),
      attempts: existing?.attempts || 0,
      // It also counts as just selected, because its own attempt is what got it
      // blocked. That is what keeps it from being picked straight back up: on
      // equal turns the oldest selection wins, and everyone waiting was selected
      // before this coin was.
      selectedSeq: existing?.selectedSeq ?? nextSelectionSeq(),
    });
    recorded.push(key);
  }
  if (recorded.length > 0) {
    emitTrace({
      atMs: nowMs,
      op: "arkade_boarding_sweep_blocked",
      status: "marked",
      detail: `outpoints=${recorded.join(",")} ttlMs=${BOARDING_SWEEP_BLOCKED_TTL_MS} err=${detail}`,
    });
  }
  return recorded;
}

export function isBoardingOutpointBlocked(key: string, nowMs = Date.now()): boolean {
  const entry = key ? blockedOutpoints.get(key) : undefined;
  if (!entry) return false;
  if (entry.expiresAtMs <= nowMs) {
    blockedOutpoints.delete(key);
    return false;
  }
  return true;
}

/** Drop the block on outpoints that just swept, so they are not skipped later. */
export function clearBoardingOutpointsBlocked(keys: string[]): void {
  let cleared = 0;
  for (const key of Array.isArray(keys) ? keys : []) {
    // The entry carries the rotation counts, so clearing the block clears them
    // too: a coin that gets stuck again starts even.
    if (key && blockedOutpoints.delete(key)) cleared += 1;
  }
  if (cleared > 0) {
    emitTrace({
      atMs: Date.now(),
      op: "arkade_boarding_sweep_blocked",
      status: "cleared",
      detail: `count=${cleared}`,
    });
  }
}

/**
 * The blocked coin the next attempt should target: the least-attempted one,
 * lowest outpoint first on a tie.
 *
 * The fallback exists so a cleared registration is rediscovered, but selection
 * sorts by outpoint and takes the lowest. Handing it every blocked coin
 * unchanged retries the lowest forever. Handing it the list minus the coin that
 * just failed only alternates between the lowest two, so with three stuck coins
 * the highest is never attempted. Picking strictly by attempt count is what
 * reaches every coin; reordering cannot work, because the selection sorts what
 * it is given.
 *
 * ONE coin is returned for that reason: it is what the selection will choose.
 */
export function selectNextBlockedBoardingCandidate<T>(
  coins: T[],
  keyOf: (coin: T) => string | null,
): T | null {
  const list = Array.isArray(coins) ? coins : [];
  let best: { coin: T; seq: number; turns: number } | null = null;
  for (const coin of list) {
    const key = keyOf(coin);
    if (!key) continue;
    const entry = blockedOutpoints.get(key);
    const turns = entry?.turns || 0;
    const seq = entry?.selectedSeq || 0;
    if (!best || turns < best.turns || (turns === best.turns && seq < best.seq)) {
      best = { coin, seq, turns };
    }
  }
  return best ? best.coin : list[0] || null;
}

/**
 * The coin took a turn as the attempt target. Called at selection, so a turn
 * consumed by a preflight failure still rotates the next attempt onto another
 * coin instead of retrying this one forever.
 */
export function recordBlockedBoardingTurn(key: string | null): void {
  const entry = key ? blockedOutpoints.get(key) : undefined;
  if (!entry) return;
  entry.turns += 1;
  entry.selectedSeq = nextSelectionSeq();
}

/**
 * The sweep reached the ASP with this coin. Only this count says anything about
 * the registration itself, so it is recorded at the settle call and never by a
 * preflight failure.
 */
export function recordBlockedBoardingAttempt(key: string | null): void {
  const entry = key ? blockedOutpoints.get(key) : undefined;
  if (!entry) return;
  entry.attempts += 1;
}

/** Rotation and ASP-attempt counts for the trace and for tests. */
export function getBlockedBoardingRotationState(): Record<
  string,
  { turns: number; attempts: number }
> {
  const state: Record<string, { turns: number; attempts: number }> = {};
  for (const [key, entry] of blockedOutpoints) {
    state[key] = { turns: entry.turns, attempts: entry.attempts };
  }
  return state;
}

/**
 * Split candidates into the ones worth attempting and the ones currently
 * blocked by a server-side registration.
 *
 * When EVERY candidate is blocked the blocked ones are returned as candidates
 * anyway, rotated away from the one just attempted: a registration may have
 * cleared, and a wallet whose boarding UTXOs are all stuck must still get the
 * attempts that discover it.
 */
export function partitionBlockedBoardingCandidates<T>(
  coins: T[],
  keyOf: (coin: T) => string | null,
  nowMs = Date.now(),
): { candidates: T[]; skipped: string[] } {
  const list = Array.isArray(coins) ? coins : [];
  if (list.length === 0) return { candidates: [], skipped: [] };
  const open: T[] = [];
  const skipped: string[] = [];
  for (const coin of list) {
    const key = keyOf(coin);
    if (key && isBoardingOutpointBlocked(key, nowMs)) {
      skipped.push(key);
      continue;
    }
    open.push(coin);
  }
  if (open.length === 0) {
    const next = selectNextBlockedBoardingCandidate(list, keyOf);
    const nextKey = next ? keyOf(next) : null;
    emitTrace({
      atMs: nowMs,
      op: "arkade_boarding_sweep_blocked",
      status: "all_blocked_retry",
      detail: `blocked=${skipped.join(",")} next=${nextKey || "none"} attempts=${attemptCountsText(skipped)} expected_next=sweep_attempt_redetects_clearing`,
    });
    return { candidates: next ? [next] : list, skipped };
  }
  return { candidates: open, skipped };
}

/** The rotation level of the coins currently waiting, so newcomers join behind. */
function highestTurns(nowMs: number): number {
  let highest = 0;
  for (const entry of blockedOutpoints.values()) {
    if (entry.expiresAtMs <= nowMs) continue;
    if (entry.turns > highest) highest = entry.turns;
  }
  return highest;
}

function attemptCountsText(keys: string[]): string {
  return (
    keys
      .map((key) => {
        const entry = blockedOutpoints.get(key);
        return `${key}=turns${entry?.turns || 0}/attempts${entry?.attempts || 0}`;
      })
      .join(",") || "none"
  );
}

export function resetBoardingSweepBlockedCache(): void {
  blockedOutpoints.clear();
  selectionSeq = 0;
}
