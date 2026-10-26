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

/**
 * The same floor for a screen to state before Confirm, or null when the node
 * cannot be read. Null keeps the button free; `requireVtxoMinimumSats` still
 * refuses at send time, so an unknown floor never lets a send through.
 */
export function vtxoMinimumSatsOrNull(info: NodeAmountFields | null | undefined): number | null {
  try {
    return requireVtxoMinimumSats(info);
  } catch {
    return null;
  }
}

/** Whether a typed amount sits under a known floor. Zero is "nothing typed yet". */
export function isBelowVtxoMinimum(sats: number, minSats: number | null): boolean {
  return minSats !== null && sats > 0 && sats < minSats;
}

/** Refuse an amount the node's floor already rules out, naming both figures. */
export function assertMeetsVtxoMinimum(sats: number, minSats: number): void {
  if (sats < minSats) {
    throw new Error(`ark_send_amount_below_minimum requested=${sats} min_vtxo_sats=${minSats}`);
  }
}

/**
 * What an Arkade balance can actually send, for a screen to show.
 *
 * Every output, the change included, has to clear the node's floor, so a send
 * that leaves 1 to `floor - 1` sats behind cannot go out. Everything up to
 * `balance - floor` can (the send adds a coin when the change would be too
 * small); above that only the whole balance works, since it leaves no change.
 * An unknown floor shows the balance: the send re-reads it and refuses.
 */
export function arkadeSendableSats(
  balanceSats: number | null,
  minSats: number | null,
): number | null {
  if (balanceSats === null) return null;
  const balance = Math.max(0, Math.trunc(balanceSats));
  if (minSats === null || !(minSats > 0)) return balance;
  return Math.max(0, balance - Math.trunc(minSats));
}
