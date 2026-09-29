// Cached VTXOs the operator no longer vouches for must not count as money.
//
// The SDK's wallet repository MERGES on save: `saveVtxos` upserts by
// `txid:vout` and never deletes (sdk chunk-3TCWQPAC.js:8645), and
// `syncContracts` only writes back the rows it just fetched, per address. So a
// row that stops coming back from the indexer — an LNURL receive whose lockup
// was never funded, an expired swap — survives in local storage forever.
//
// Before SDK 0.5 those rows carried no `virtualStatus`, so the summary skipped
// them by accident. Reading the 0.5 shape classifies them like any other coin,
// and they inflate the balance: a wallet holding 3617 sats reported 4172, the
// difference being one unfunded 555-sat receive that the app had cached since
// the invoice was minted.
//
// A local flag cannot separate the two — the phantom is flag-identical to a
// funded coin (it took the `isPreconfirmed` branch, not a fallback). Only the
// operator can say which outpoints exist, so the balance asks it.
//
// Fail-open is deliberate: if the indexer is unreachable we keep every cached
// row rather than zero a wallet on a flaky network. An inflated balance is a
// display bug; a wallet that reads empty because the user is on a train is a
// support incident.

/** The subset of the indexer this reconciliation needs. */
export type VtxoConfirmingIndexer = {
  getVtxos: (params: {
    scripts: string[];
    spendableOnly?: boolean;
  }) => Promise<{ vtxos?: unknown[] } | unknown[]>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** `txid:vout`, or "" when the row is not outpoint-shaped. */
export function vtxoOutpointKey(coin: unknown): string {
  if (!isRecord(coin)) return "";
  const txid = String(coin.txid || "").trim();
  const vout = Number(coin.vout);
  if (!txid || !Number.isFinite(vout)) return "";
  return `${txid}:${Math.trunc(vout)}`;
}

/** The scripts a set of cached rows claims to belong to. */
export function scriptsOfVtxos(vtxos: readonly unknown[]): string[] {
  const scripts = new Set<string>();
  for (const coin of vtxos) {
    if (!isRecord(coin)) continue;
    const script = String(coin.script || coin.contractScript || "").trim();
    if (script) scripts.add(script);
  }
  return [...scripts];
}

function rowsOf(response: { vtxos?: unknown[] } | unknown[]): unknown[] {
  if (Array.isArray(response)) return response;
  if (isRecord(response) && Array.isArray(response.vtxos)) return response.vtxos;
  return [];
}

/**
 * Drop cached VTXOs the indexer does not return for their own script.
 *
 * Returns the input unchanged (and `reconciled: false`) whenever the answer
 * cannot be trusted: no indexer, no scripts to ask about, or a failed lookup.
 */
export async function dropUnconfirmedVtxos(
  vtxos: readonly unknown[],
  indexer: VtxoConfirmingIndexer | null | undefined,
): Promise<{ vtxos: unknown[]; reconciled: boolean; droppedCount: number; droppedSats: number }> {
  const unchanged = {
    vtxos: [...vtxos],
    reconciled: false,
    droppedCount: 0,
    droppedSats: 0,
  };
  if (!vtxos.length) return { ...unchanged, reconciled: true };
  if (!indexer || typeof indexer.getVtxos !== "function") return unchanged;

  const scripts = scriptsOfVtxos(vtxos);
  // Rows without a script cannot be checked; keeping them is the fail-open side.
  if (!scripts.length) return unchanged;

  let confirmed: Set<string>;
  try {
    const response = await indexer.getVtxos({ scripts });
    const rows = rowsOf(response);
    confirmed = new Set(rows.map(vtxoOutpointKey).filter(Boolean));
  } catch {
    return unchanged;
  }

  // An empty answer for scripts we hold rows against is more likely a partial
  // or rate-limited read than a wallet that lost every coin at once.
  if (!confirmed.size) return unchanged;

  const kept: unknown[] = [];
  let droppedCount = 0;
  let droppedSats = 0;
  const askedScripts = new Set(scripts);
  for (const coin of vtxos) {
    const key = vtxoOutpointKey(coin);
    const script = isRecord(coin) ? String(coin.script || coin.contractScript || "").trim() : "";
    // An unkeyable row, or one whose script was never part of the question,
    // keeps the benefit of the doubt: the lookup said nothing about it.
    if (!key || !script || !askedScripts.has(script) || confirmed.has(key)) {
      kept.push(coin);
      continue;
    }
    droppedCount += 1;
    const value = isRecord(coin) ? Number(coin.value ?? 0) : 0;
    droppedSats += Number.isFinite(value) ? value : 0;
  }

  return { vtxos: kept, reconciled: true, droppedCount, droppedSats };
}
