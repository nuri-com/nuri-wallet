import { hkdfSha256, hmacSha256, secp256k1, sha256, utf8ToBytes } from "./crypto";

const NOSTR_DERIVE_SALT = sha256(utf8ToBytes("nuri-nostr-salt-v1"));
const NOSTR_DERIVE_INFO = utf8ToBytes("nuri:nostr:sk:v1");

export function deriveWalletEntropy(
  prfBytes: Uint8Array,
  chain: "bitcoin" | "ethereum",
): Uint8Array {
  // Deterministic salt as suggested
  const saltString = "app:nuri.com|wallet|v1";
  const salt = sha256(new TextEncoder().encode(saltString));

  // Domain-separated info strings
  const infoString =
    chain === "bitcoin"
      ? "app:nuri.com|wallet|v1|chain=bitcoin|fmt=taproot"
      : "app:nuri.com|wallet|v1|chain=ethereum|fmt=secp256k1";

  const info = new TextEncoder().encode(infoString);

  // HKDF to derive 32 bytes of entropy
  const entropy = hkdfSha256(prfBytes, salt, info, 32);
  return entropy;
}

export function isValidNostrPrivateKey(candidate: Uint8Array): boolean {
  const utils = secp256k1.utils as unknown as {
    isValidSecretKey?: (value: Uint8Array) => boolean;
    isValidPrivateKey?: (value: Uint8Array) => boolean;
  };
  if (utils?.isValidSecretKey) return utils.isValidSecretKey(candidate);
  if (utils?.isValidPrivateKey) return utils.isValidPrivateKey(candidate);
  return candidate.length === 32 && candidate.some((byte) => byte !== 0);
}

export function deriveNostrPrivateKeyFromBitcoinKey(bitcoinPrivateKey: Uint8Array): Uint8Array {
  let candidate = hkdfSha256(sha256(bitcoinPrivateKey), NOSTR_DERIVE_SALT, NOSTR_DERIVE_INFO, 32);
  for (let attempt = 0; attempt < 256; attempt += 1) {
    if (isValidNostrPrivateKey(candidate)) return candidate;
    const next = sha256(candidate);
    candidate.fill(0);
    candidate = next;
  }
  candidate.fill(0);
  throw new Error("Unable to derive valid Nostr private key");
}

// Boltz was removed: the provider is shut down, the server no longer returns
// it, and the client no longer derives material for it. An action that still
// names it is refused by assertProvider instead of being keyed into a corridor
// that does not exist.
export type SwapKitHtlcProvider = "satora";
export const SWAPKIT_HTLC_PROVIDERS: readonly SwapKitHtlcProvider[] = ["satora"];

/**
 * Provider-separated HTLC root per the SwapKit v2 wallet contract
 * (nuri-mcp-bitcoin-swapkit docs/HTLC-WALLET-CONTRACT.md):
 * `HMAC-SHA256(PRF_ROOT, "nuri/swapkit/htlc/v1/" + provider)`.
 * Deterministic from the passkey PRF, so a reinstall + passkey restore
 * reproduces the same swap keys and preimages.
 */
export function deriveSwapKitHtlcProviderRoot(
  prfBytes: Uint8Array,
  provider: SwapKitHtlcProvider,
): Uint8Array {
  return hmacSha256(prfBytes, new TextEncoder().encode(`nuri/swapkit/htlc/v1/${provider}`));
}
