// Which coins the wallet summary may count as "renewal due" (#1977).
//
// The summary reads every coin with `getVtxos()`, but the renewal itself only
// settles what `getSpendableVtxos({ withRecoverable: false })` returns (the SDK
// skips intent-locked, gated and deprecated-signer coins there). Counting from
// the wider read offered a renewal that the tap then found nothing to do for,
// and that empty run surfaced as "Payment Received unlock failed". Counting
// from the same read the renewal uses keeps the offer and the execution in
// step. The summary's own list stays the outer bound: a coin it dropped (spent
// on the indexer, never confirmed) is not offered just because the spendable
// read still has it.

type OutpointLike = { txid?: unknown; vout?: unknown };

type SpendableReader = {
  getSpendableVtxos?: (filter?: { withRecoverable?: boolean }) => Promise<unknown[]>;
};

function outpointKey(coin: unknown): string | null {
  if (!coin || typeof coin !== "object") return null;
  const { txid, vout } = coin as OutpointLike;
  if (typeof txid !== "string" || !txid || !Number.isFinite(Number(vout))) return null;
  return `${txid}:${Math.trunc(Number(vout))}`;
}

/**
 * The summary's coins the renewal could actually settle. Fails open to the
 * summary's list when the spendable read is missing or throws, so a slow read
 * never hides a genuinely due renewal; the tap re-checks with the same read
 * and asks for no passkey when nothing is due.
 */
export async function readArkadeRenewalEligibleVtxos<T>(
  wallet: SpendableReader,
  summaryVtxos: readonly T[],
  read: (work: Promise<unknown[]>) => Promise<unknown[]> = (work) => work,
): Promise<{ vtxos: T[]; source: "spendable" | "summary_fallback" }> {
  if (typeof wallet.getSpendableVtxos !== "function") {
    return { vtxos: [...summaryVtxos], source: "summary_fallback" };
  }
  try {
    const spendable = await read(wallet.getSpendableVtxos({ withRecoverable: false }));
    const keys = new Set(
      (Array.isArray(spendable) ? spendable : []).map(outpointKey).filter(Boolean),
    );
    return {
      vtxos: summaryVtxos.filter((coin) => {
        const key = outpointKey(coin);
        return key !== null && keys.has(key);
      }),
      source: "spendable",
    };
  } catch {
    return { vtxos: [...summaryVtxos], source: "summary_fallback" };
  }
}
