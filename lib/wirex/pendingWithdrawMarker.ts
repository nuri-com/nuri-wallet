// The durable "a withdrawal crossed the point of no return" marker, and the
// only two questions asked of it: is it still worth holding the lock for, and
// can it be dated at all.
//
// The lock exists so a second withdrawal cannot start while an earlier one may
// still settle. Markers written before the `at` field existed cannot age out on
// their own, which once meant a factory reset was the only way to withdraw
// again. Clearing them on sight fixed that and broke the guard: a legacy marker
// can belong to a withdrawal that crossed the point of no return moments ago.
//
// So an undated marker is DATED instead — stamped the first time it is seen —
// and from then on it expires like any other. The lock is never dropped because
// a poll timed out or the network blipped; only real age releases it.
//
// Kept in its own import-free module so it is unit-testable without pulling the
// (native-dependency-heavy) Wirex service into the test environment.

export type PendingWithdrawMarker = {
  sessionId: string;
  /** Epoch ms. 0 means the marker predates this field. */
  at: number;
};

export function parsePendingWithdrawMarker(raw: string): PendingWithdrawMarker | null {
  let sessionId = "";
  let at = 0;
  try {
    const parsed = JSON.parse(raw) as { sessionId?: unknown; at?: unknown };
    sessionId = String(parsed?.sessionId || "");
    at = Number(parsed?.at) || 0;
  } catch {}
  if (!sessionId) return null;
  return { sessionId, at: at > 0 ? at : 0 };
}

/**
 * Give an undated marker a date so it can age out. Returns null when the marker
 * already has one and nothing needs writing back.
 */
export function stampUndatedMarker(
  marker: PendingWithdrawMarker,
  now: number,
): PendingWithdrawMarker | null {
  if (marker.at > 0) return null;
  return { sessionId: marker.sessionId, at: now };
}

export function isPendingWithdrawMarkerExpired(
  marker: PendingWithdrawMarker,
  now: number,
  maxAgeMs: number,
): boolean {
  // An undated marker is about to be stamped with `now`, so it is never old.
  if (marker.at <= 0) return false;
  return now - marker.at > maxAgeMs;
}
