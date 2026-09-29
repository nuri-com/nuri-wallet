// Pure classification of arkade's advertised deprecated signers by their
// cooperative-spend cutoff. Kept dependency-light (only hex validation) so the
// #852 decision — does a signer's cutoff bar the cooperative sweep? — is unit
// testable without pulling in the wallet/SDK/RN module graph.
import { isHex } from "../../../lib/bytes";

// A deprecated arkade signer as advertised by `/info`, with its cooperative-spend
// cutoff. `cutoffSec` is the Unix-second deadline after which arkd rejects any
// cooperative spend under this signer (INVALID_VTXO_SCRIPT); null when the node
// advertises no cutoff (still cooperatively migratable — the SDK's DUE_NOW).
export type DeprecatedSignerEntry = { pubkeyHex: string; cutoffSec: number | null };

// Accept only real signer pubkey hex: 64-char x-only (32 bytes) or 66-char
// compressed (33 bytes, 02/03 prefix). Anything else from `/info` is rejected
// so it never reaches hexToBytes().
function isDeprecatedSignerPubkeyHex(hex: string): boolean {
  return isHex(hex, 64) || ((hex.startsWith("02") || hex.startsWith("03")) && isHex(hex, 66));
}

// Every deprecated arkade signer the node advertises, normalized + validated +
// deduped, each carrying its cutoff. Array-safe against unexpected `/info`
// payloads, and returns ALL valid signers (not just the first) so a wallet with
// funds under more than one rotated signer is fully recovered. A malformed entry
// is skipped, not thrown, so one bad value can't abort recovery for the rest.
// A 0 (or absent/non-numeric) cutoff maps to null — arkd/SDK classify 0 as
// DUE_NOW (migrate now), NOT as an epoch-old expiry.
export function parseDeprecatedSigners(info: {
  deprecatedSigners?: unknown;
}): DeprecatedSignerEntry[] {
  const list = Array.isArray(info.deprecatedSigners) ? info.deprecatedSigners : [];
  const seen = new Set<string>();
  const out: DeprecatedSignerEntry[] = [];
  for (const entry of list) {
    const rec = entry as { pubkey?: unknown; cutoffDate?: unknown } | null;
    const hex = String(rec?.pubkey || "")
      .replace(/^0x/i, "")
      .trim()
      .toLowerCase();
    if (!isDeprecatedSignerPubkeyHex(hex) || seen.has(hex)) continue;
    seen.add(hex);
    const cutoffRaw = Number(rec?.cutoffDate ?? Number.NaN);
    const cutoffSec = Number.isFinite(cutoffRaw) && cutoffRaw > 0 ? Math.trunc(cutoffRaw) : null;
    out.push({ pubkeyHex: hex, cutoffSec });
  }
  return out;
}

// Compressed/x-only hexes only — for callers that don't need the cutoff.
export function deprecatedSignerHexes(info: { deprecatedSigners?: unknown }): string[] {
  return parseDeprecatedSigners(info).map((entry) => entry.pubkeyHex);
}

// arkd rejects cooperative spends (send/settle/sendSelectedVtxosToSelf) once a
// signer's advertised cutoff has passed — the funds are EXPIRED and must follow
// the sweep→recover lifecycle instead of a cooperative self-send. A signer with
// no advertised cutoff is still cooperatively migratable (DUE_NOW). See #852.
export function isPastCutoff(
  entry: DeprecatedSignerEntry,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  return entry.cutoffSec !== null && nowSec >= entry.cutoffSec;
}
