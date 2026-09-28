// The node's own send floors, read off its info rather than stated here.
//
// Its own module because `ArkadeSendService` imports `@arkade-os/sdk` at the
// top level and vitest cannot transform it — and the floor is exactly the part
// worth proving, since it moved from 3000 to 330 sats without a release and a
// figure hardcoded in the app refused sends the server accepts.

type NodeAmountFields = {
  /** Floor for an on-chain output — what an offboard creates. */
  utxoMinAmount?: number | string | bigint;
  /** Floor for a VTXO — what an ark→ark send creates. */
  vtxoMinAmount?: number | string | bigint;
};

function toSats(value: unknown): number {
  const sats = Number(value);
  return Number.isFinite(sats) ? Math.trunc(sats) : Number.NaN;
}

/**
 * The floor for a send that creates a VTXO, or a throw.
 *
 * Fail closed on unreadable node info: an unknown floor is not a floor of zero,
 * and letting the send through would spend a passkey prompt and an approval on
 * an amount the server refuses moments later.
 */
export function requireVtxoMinimumSats(info: NodeAmountFields | null | undefined): number {
  if (!info) {
    throw new Error("arkade_send_missing_node_info");
  }
  const min = toSats(info.vtxoMinAmount);
  if (!Number.isFinite(min) || min <= 0) {
    throw new Error("arkade_send_missing_vtxo_minimum");
  }
  return min;
}

/** Refuse an amount the node's floor already rules out, naming both figures. */
export function assertMeetsVtxoMinimum(sats: number, minSats: number): void {
  if (sats < minSats) {
    throw new Error(`ark_send_amount_below_minimum requested=${sats} min_vtxo_sats=${minSats}`);
  }
}
