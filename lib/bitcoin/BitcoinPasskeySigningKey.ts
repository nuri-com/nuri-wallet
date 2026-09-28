import { zeroize } from "../crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { deriveWalletEntropy } from "../walletDerivation";
import { deriveBitcoinAddress } from "./bip86";

/**
 * Derive a deterministic Bitcoin signing key from a passkey PRF.
 * Returns the private key and x-only public key. Caller must zeroize inputs.
 */
export function deriveBitcoinPasskeySigningKey(prfBytes: Uint8Array): {
  privateKey: Uint8Array;
  xOnlyPubkey: Uint8Array;
} {
  // IMPORTANT:
  // This must match the canonical wallet/BIP86 derivation used in bootstrapWalletFromPrf:
  //   1) entropy = deriveWalletEntropy(prfBytes, "bitcoin")
  //   2) { privateKey } = deriveBitcoinAddress(entropy)
  // so that the stateless path and getPrivateKey("bitcoin") always refer to the same key.
  const entropy = deriveWalletEntropy(prfBytes, "bitcoin");
  const { privateKey } = deriveBitcoinAddress(entropy);
  // Derive x-only pubkey from the same private key (internal key, not the tweaked output key)
  const pubCompressed = secp256k1.getPublicKey(privateKey, true);
  const xOnlyPubkey = pubCompressed.slice(1);
  zeroize(entropy);
  return { privateKey, xOnlyPubkey };
}

/**
 * Zeroize a derived keypair returned from deriveBitcoinPasskeySigningKey.
 */
export function zeroizeBitcoinPasskeySigningKeypair(keypair: {
  privateKey?: Uint8Array;
  xOnlyPubkey?: Uint8Array;
}) {
  if (keypair.privateKey) zeroize(keypair.privateKey);
  if (keypair.xOnlyPubkey) zeroize(keypair.xOnlyPubkey);
}
