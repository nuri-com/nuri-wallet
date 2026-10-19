// VTXO renewal before batch expiry (#1635): which VTXOs are due, and where a
// renewal may send them.
//
// Pure on purpose: the wallet summary (to raise the unlock item) and the
// renewal run (to build the settle) read the same selection, and both are
// tested here without a wallet.
//
// Expiry source is the VTXO's own batch (tree) expiry as the SDK exposes it on
// the coin — `expiresAt`, read through the SDK's `isVtxoExpiringSoon`
// (node_modules/@arkade-os/sdk/dist/chunk-ZTGTQP2W.js) — never the server's
// `/v1/info` batch defaults, which describe a fresh batch, not this coin's.
import { isRecoverable, isSpendable, isVtxoExpiringSoon } from "@arkade-os/sdk";
import {
  buildArkadeServerDecayLeaves,
  buildArkadeServerDecayVtxoScript,
  type ArkadeServerDecayPolicyParams,
} from "../ArkadeServerDecayPolicy";
import { bytesToHex } from "../../../lib/bytes";

/** Renew a VTXO once its batch expires within this many days. */
export const ARKADE_VTXO_RENEWAL_THRESHOLD_DAYS = 3;
export const ARKADE_VTXO_RENEWAL_THRESHOLD_MS = ARKADE_VTXO_RENEWAL_THRESHOLD_DAYS * 86_400_000;
/** The SDK's own per-settlement input cap (`MAX_VTXOS_PER_SETTLEMENT`, not exported). */
export const ARKADE_VTXO_RENEWAL_MAX_INPUTS = 50;

export type ArkadeVtxoRenewalSelection<T> = {
  candidates: T[];
  count: number;
  sats: number;
};

type SdkVtxo = Parameters<typeof isVtxoExpiringSoon>[0];

function vtxoSats(vtxo: unknown): number {
  const value = Number((vtxo as { value?: unknown })?.value);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/**
 * The VTXOs a renewal should settle into a fresh batch: unspent, not already
 * swept (a swept coin is recoverable and has its own unlock item), and whose
 * batch expires within `thresholdMs` but has not expired yet.
 */
export function selectArkadeVtxoRenewalCandidates<T>(
  vtxos: readonly T[] | null | undefined,
  thresholdMs: number = ARKADE_VTXO_RENEWAL_THRESHOLD_MS,
): ArkadeVtxoRenewalSelection<T> {
  const candidates: T[] = [];
  let sats = 0;
  if (!Array.isArray(vtxos)) return { candidates, count: 0, sats };
  for (const vtxo of vtxos) {
    if (!vtxo || typeof vtxo !== "object") continue;
    if (candidates.length >= ARKADE_VTXO_RENEWAL_MAX_INPUTS) break;
    const coin = vtxo as unknown as SdkVtxo;
    if (!isSpendable(coin) || isRecoverable(coin)) continue;
    if (!isVtxoExpiringSoon(coin, thresholdMs)) continue;
    candidates.push(vtxo);
    sats += vtxoSats(vtxo);
  }
  return { candidates, count: candidates.length, sats };
}

/**
 * Keep a renewal's one output at or under the node's VTXO maximum: take the
 * soonest-expiring coins first and stop before the total would pass it. Coins
 * left out stay due and are renewed by the next run. A maximum of 0 or below
 * means the node sets none.
 */
export function capArkadeVtxoRenewalCoins<T extends { value: number; expiresAt?: unknown }>(
  coins: readonly T[],
  maxSats: number,
): T[] {
  if (!Number.isFinite(maxSats) || maxSats <= 0) return [...coins];
  const expiryMs = (coin: T) => {
    const value = coin.expiresAt;
    const ms = value instanceof Date ? value.getTime() : Number(value);
    return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
  };
  const kept: T[] = [];
  let total = 0;
  for (const coin of [...coins].sort((a, b) => expiryMs(a) - expiryMs(b))) {
    if (total + coin.value > maxSats) continue;
    kept.push(coin);
    total += coin.value;
  }
  return kept;
}

/**
 * Refuse a renewal whose destination no longer carries the three decay leaves
 * (ArkadeServerDecayPolicy.buildArkadeServerDecayLeaves): the arkade path, the
 * aggregate CSV recovery and the client-only CSV recovery. A settle re-locks
 * the coins under the destination script, so renewing into anything else
 * would silently trade the user's unilateral exit for a fresh batch.
 */
export function assertArkadeRenewalDestinationHasDecayLeaves(args: {
  destinationPkScript: Uint8Array;
  destinationLeafScripts: readonly Uint8Array[];
  params: ArkadeServerDecayPolicyParams;
}): void {
  const expected = buildArkadeServerDecayLeaves(args.params);
  const present = new Set(args.destinationLeafScripts.map((script) => bytesToHex(script)));
  const failures: string[] = [];
  if (args.destinationLeafScripts.length !== 3) {
    failures.push(`leaf_count=${args.destinationLeafScripts.length}`);
  }
  if (!present.has(bytesToHex(expected.arkadePathScript))) failures.push("arkade_path_missing");
  if (!present.has(bytesToHex(expected.aggregateRecoveryScript))) {
    failures.push("aggregate_recovery_missing");
  }
  if (!present.has(bytesToHex(expected.clientRecoveryScript))) {
    failures.push("client_recovery_missing");
  }
  const expectedPkScript = bytesToHex(buildArkadeServerDecayVtxoScript(args.params).pkScript);
  if (bytesToHex(args.destinationPkScript) !== expectedPkScript) {
    failures.push("script_pubkey_mismatch");
  }
  if (failures.length > 0) {
    throw new Error(`vtxo renewal refused: destination lacks decay leaves ${failures.join(",")}`);
  }
}
