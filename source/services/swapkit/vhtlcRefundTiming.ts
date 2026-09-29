/**
 * The timelock gate for Arkade VHTLC refunds — deliberately dependency-free so
 * it can be imported (and unit-tested) without pulling in @arkade-os/sdk.
 *
 * Two clocks matter here and they are far apart. A CLTV timelock is evaluated
 * against the chain's block time (median time past), which trails the wall
 * clock by roughly an hour or two. So wall-clock time is only a cheap
 * pre-filter: it can prove a refund is definitely NOT due, never that it is.
 * The authority is the ark server, which answers FORFEIT_CLOSURE_LOCKED with
 * the actual block time when we ask too early.
 */

/**
 * False while the VHTLC's absolute refund timelock lies in the wall-clock
 * future — then it cannot possibly be due, so the swap loop skips without a
 * round trip. True only means "worth attempting": the chain may still be
 * behind, which isVhtlcNotDueYetError() then recognises in the response.
 */
export function isVhtlcRefundable(
  vhtlc: { refundLocktime?: number },
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  const locktime = Number(vhtlc?.refundLocktime);
  if (!Number.isSafeInteger(locktime) || locktime <= 0) return false;
  return nowSeconds >= locktime;
}

/**
 * True when the ark server rejected a refund purely because the chain has not
 * reached the timelock yet, e.g.
 *
 *   FORFEIT_CLOSURE_LOCKED (11): 1784471181 > 1784468590 (blocktime)
 *
 * That is not a failure — the funds are safe and the same attempt succeeds
 * once block time passes the locktime. Callers treat it as "skip, try again"
 * instead of surfacing an error on every poll.
 */
export function isVhtlcNotDueYetError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /FORFEIT_CLOSURE_LOCKED|locktime .*not .*(reached|expired)/i.test(message);
}

/**
 * The seconds of block time still missing, parsed out of a
 * FORFEIT_CLOSURE_LOCKED message — for a log line that says how long the wait
 * actually is. Null when the message carries no usable pair of timestamps.
 */
export function vhtlcSecondsUntilRefundable(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const match = message.match(/(\d{10})\s*>\s*(\d{10})/);
  if (!match) return null;
  const remaining = Number(match[1]) - Number(match[2]);
  return Number.isSafeInteger(remaining) && remaining > 0 ? remaining : null;
}
