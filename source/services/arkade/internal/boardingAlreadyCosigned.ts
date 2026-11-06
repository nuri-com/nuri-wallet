// A boarding sweep refused because the coin already left through an earlier one.
//
// The ASP cosigns the onchain tx that moves a boarding coin into the wallet and
// records the coin as spent. A second sweep over the same coin, started before
// our server or the local coin list has seen that spend (another tab, a reload,
// a second tap right after the first one finished), is refused with:
//
//   INVALID_PSBT_INPUT (5): boarding input(s) already cosigned onchain: <txid>:<vout>
//
// The ASP only cosigns a boarding coin with this wallet's own signature, so the
// coin is already on its way into the wallet. That is the outcome the user asked
// for, not a failure, and another attempt can never change it.
//
// The sibling refusal `boarding input(s) being cosigned onchain` is NOT matched:
// it only means another cosign of the coin is in flight, and that one can still
// fail before broadcast and leave the coin where it is. It stays a failure.

import { errorText } from "./duplicatedIntent";

const COSIGNED_ONCHAIN_RE = /boarding input\(s\) already cosigned onchain:\s*(.+)/i;
const OUTPOINT_RE = /([0-9a-fA-F]{64}):(\d+)/g;

/** Outpoints (`txid:vout`, lowercase) the ASP says were already cosigned onchain. */
export function boardingCosignedOutpoints(error: unknown): string[] {
  const match = COSIGNED_ONCHAIN_RE.exec(errorText(error));
  if (!match) return [];
  const outpoints: string[] = [];
  for (const [, txid, vout] of match[1].matchAll(OUTPOINT_RE)) {
    outpoints.push(`${txid.toLowerCase()}:${Number(vout)}`);
  }
  return outpoints;
}

/**
 * Was every coin this sweep selected refused as already cosigned onchain? A
 * refusal naming only some of them leaves the rest unswept, so it stays a failure.
 */
export function isBoardingAlreadyCosigned(error: unknown, selectedOutpoints: string[]): boolean {
  if (selectedOutpoints.length === 0) return false;
  const cosigned = new Set(boardingCosignedOutpoints(error));
  return selectedOutpoints.every((outpoint) => cosigned.has(outpoint.toLowerCase()));
}
