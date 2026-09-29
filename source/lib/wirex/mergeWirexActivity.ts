// Merge the three Wirex "activity" rails — card transactions, bank/SEPA
// transactions, and onchain deposits — into a single feed for
// `components/ActivitySheet`. Uses a light dedup-by-id + timestamp-sort
// pattern.

import type { ActivityItem } from "../../components/ActivitySheet";

/**
 * Concatenate the card, bank and deposit rows, dedupe by `key` (first row
 * wins — card is passed first, so it keeps the richest row on a key collision),
 * and sort pending-first then newest-first by `_createdAt`.
 *
 * Note: cross-rail dedup of the SAME economic event (e.g. a bank top-up that
 * also surfaces as an onchain deposit) is not possible here — the row model
 * carries no tx hash, and the two sources mint different `key`s. This dedup
 * only collapses exact `key` collisions.
 */
export function mergeWirexActivity(
  card: ActivityItem[],
  bank: ActivityItem[],
  deposits: ActivityItem[],
): ActivityItem[] {
  const combined = [
    ...(Array.isArray(card) ? card : []),
    ...(Array.isArray(bank) ? bank : []),
    ...(Array.isArray(deposits) ? deposits : []),
  ];

  const byKey = new Map<string, ActivityItem>();
  let index = 0;
  for (const row of combined) {
    // Rows without a key can't collide meaningfully — key them uniquely.
    const key = row.key || `row-${index}`;
    if (!byKey.has(key)) byKey.set(key, row);
    index += 1;
  }

  return Array.from(byKey.values()).sort((a, b) => {
    const aPending = a.pending ?? false;
    const bPending = b.pending ?? false;
    if (aPending !== bPending) return aPending ? -1 : 1;
    return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
  });
}
