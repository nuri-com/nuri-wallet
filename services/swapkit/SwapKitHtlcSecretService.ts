import { bytesToNumberBE, hmacSha256, secp256k1, utf8ToBytes, zeroize } from "../../lib/crypto";
import { getSwapKitHtlcRoot } from "../../lib/secureKeyStorage";
import type { SwapKitHtlcProvider } from "../../lib/walletDerivation";
import { SWAPKIT_HTLC_PROVIDERS } from "../../lib/walletDerivation";

/**
 * SECRET materialization for the SwapKit HTLC wallet contract — the only
 * module that hands secret bytes (preimages, swap private keys) to a caller.
 * The seam exists so the secret-touching surface stays one small auditable
 * file and future deletions cut along it. It is NOT claim-only: the Phase B
 * lockup pre-sign (WP9 presign_package) needs these functions too — what
 * eventually dies (WP11) is claim EXECUTION, not this module.
 *
 * Everything here is re-derived on demand from the provider root in the
 * keychain and returned in memory only; callers zeroize the bytes right after
 * signing and must never persist or submit them. Public-material derivation
 * and key-index allocation live in SwapKitHtlcKeyService.
 */

export function assertProvider(provider: string): asserts provider is SwapKitHtlcProvider {
  if (!(SWAPKIT_HTLC_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`Unknown SwapKit HTLC provider: ${provider || "missing"}`);
  }
}

// Contract: derive scalars from `swap/<index>` / `user/<index>`; retry with a
// deterministic suffix only when a candidate is not a valid scalar. The server
// never sees private keys, so the suffix scheme only has to be stable for us.
export function deriveScalar(root: Uint8Array, label: string): Uint8Array {
  for (let attempt = 0; ; attempt++) {
    const candidate = hmacSha256(root, utf8ToBytes(attempt === 0 ? label : `${label}/${attempt}`));
    const value = bytesToNumberBE(candidate);
    if (value > 0n && value < secp256k1.Point.Fn.ORDER) return candidate;
    zeroize(candidate);
  }
}

/** Preimage = HMAC(swapKey, "preimage/v1") — the single definition both the
 * public preimageHash (derive_material) and the secret path derive from. */
export function deriveSwapKitHtlcPreimage(swapKey: Uint8Array): Uint8Array {
  return hmacSha256(swapKey, utf8ToBytes("preimage/v1"));
}

/**
 * Materialize the preimage for an action with `needsPreimage:true` — in memory
 * only. The caller zeroizes it immediately after the signed/broadcast action
 * and must never persist or submit it.
 */
export async function materializeSwapKitHtlcPreimage(
  provider: string,
  keyIndex: number,
): Promise<Uint8Array> {
  assertProvider(provider);
  if (!Number.isInteger(keyIndex) || keyIndex < 0) {
    throw new Error("SwapKit HTLC preimage requires a valid keyIndex.");
  }
  const root = await getSwapKitHtlcRoot(provider);
  try {
    const swapKey = deriveScalar(root, `swap/${keyIndex}`);
    try {
      return deriveSwapKitHtlcPreimage(swapKey);
    } finally {
      zeroize(swapKey);
    }
  } finally {
    zeroize(root);
  }
}

/**
 * Materialize the swap PRIVATE key for an Arkade VHTLC claim/refund — in
 * memory only, same contract as the preimage: the caller zeroizes it right
 * after signing and must never persist or submit it. This is the key whose
 * public half was returned as `publicKey` by derive_material, i.e. the
 * receiver (claim) / sender (refund) key the provider locked the VHTLC to.
 */
export async function materializeSwapKitHtlcSwapKey(
  provider: string,
  keyIndex: number,
): Promise<Uint8Array> {
  assertProvider(provider);
  if (!Number.isInteger(keyIndex) || keyIndex < 0) {
    throw new Error("SwapKit HTLC swap key requires a valid keyIndex.");
  }
  const root = await getSwapKitHtlcRoot(provider);
  try {
    return deriveScalar(root, `swap/${keyIndex}`);
  } finally {
    zeroize(root);
  }
}
