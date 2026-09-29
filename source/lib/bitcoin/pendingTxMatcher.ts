export type PendingIncomingCandidate = {
  txid: string;
  amountSats: number;
  confirmed: boolean;
  blockTime: number | null;
};

// Guard before removing a (source-based) Mercuryo placeholder via a scanned tx.
// matchPendingIncomingCandidate has loose fallbacks (single-candidate / timing-only)
// that can match an UNRELATED tx. Now that cleanup is by source not address, the row
// could otherwise be cleared by the wrong tx — and we can't lean on "same address" as
// a second fence: in arkade the row is stored under the boarding address, which is
// exactly the address the cleanup scans, so address always matches there. The only
// reliable fence is the amount: remove only when the matched tx is within tolerance of
// the row's KNOWN expected amount. A row with no known amount (amountSats undefined at
// add time) can't be verified, so it is left to the 24h PendingPurchasesStore TTL
// rather than cleared on a coincidental tx — a false "received" is worse than a
// self-healing stuck "processing". Shared by both Mercuryo cleanup loops. (#688 review)
export function isMatchSafeForRow(params: {
  expectedSats: number;
  match: PendingIncomingCandidate | null;
}): boolean {
  const { expectedSats, match } = params;
  if (!match?.txid) return false;
  if (!(expectedSats > 0)) return false;
  const tolerance = Math.max(500, Math.round(expectedSats * 0.03));
  return Math.abs(match.amountSats - expectedSats) <= tolerance;
}

export function matchPendingIncomingCandidate(params: {
  expectedSats: number;
  createdAtMs: number | null;
  candidates: PendingIncomingCandidate[];
}): PendingIncomingCandidate | null {
  const { expectedSats, createdAtMs, candidates } = params;
  const hasCreatedAt = Number.isFinite(createdAtMs) && (createdAtMs || 0) > 0;
  const createdAt = hasCreatedAt ? Number(createdAtMs) : 0;

  const scopedCandidates = candidates.filter((c) => {
    if (!hasCreatedAt) return true;
    if (!c.confirmed) return true;
    if (c.blockTime == null) return true;
    return c.blockTime * 1000 >= createdAt - 120_000;
  });

  let match: PendingIncomingCandidate | null = null;

  if (expectedSats > 0) {
    match = scopedCandidates.find((c) => c.amountSats === expectedSats) || null;
    if (!match && scopedCandidates.length > 0) {
      const tolerance = Math.max(500, Math.round(expectedSats * 0.03));
      const nearest = scopedCandidates
        .map((c) => ({ c, d: Math.abs(c.amountSats - expectedSats) }))
        .sort((a, b) => a.d - b.d)[0];
      if (nearest && (nearest.d <= tolerance || scopedCandidates.length === 1)) {
        match = nearest.c;
      }
    }
  }

  // Fallback: if amount is unknown/wrong, rely on timing to avoid stale placeholders.
  if (!match && hasCreatedAt) {
    const timedConfirmed = scopedCandidates
      .filter((c) => c.confirmed && c.blockTime != null)
      .map((c) => ({ c, d: Math.abs((c.blockTime ?? 0) * 1000 - createdAt) }))
      .sort((a, b) => a.d - b.d);
    if (timedConfirmed.length === 1) {
      match = timedConfirmed[0].c;
    } else if (timedConfirmed.length > 1 && timedConfirmed[0].d <= 2 * 60 * 60 * 1000) {
      match = timedConfirmed[0].c;
    }
  }

  if (!match && scopedCandidates.length === 1) {
    match = scopedCandidates[0];
  }

  if (!match && hasCreatedAt) {
    match =
      scopedCandidates
        .filter((c) => c.confirmed && c.blockTime != null)
        .sort((a, b) => (b.blockTime || 0) - (a.blockTime || 0))[0] || null;
  }

  return match;
}
