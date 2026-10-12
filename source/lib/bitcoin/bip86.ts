import { HDKey } from "@scure/bip32";
import { bech32m } from "@scure/base";
import { taggedHash, bytesToHex, bytesToNumberBE } from "../crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { mod } from "@noble/curves/abstract/modular";

// Proper BIP-86 implementation with taproot tweaking
export function deriveBitcoinAddress(entropy: Uint8Array): {
  address: string;
  xOnlyPubkey: Uint8Array;
  privateKey: Uint8Array;
} {
  // Create HD root from entropy
  const root = HDKey.fromMasterSeed(entropy);

  // Derive BIP-86 path for mainnet: m/86'/0'/0'/0/0
  const path = "m/86'/0'/0'/0/0";
  const child = root.derive(path);

  if (!child.privateKey || !child.publicKey) {
    throw new Error("Failed to derive keys");
  }

  // Get x-only pubkey (32 bytes) - remove the prefix byte from compressed pubkey
  const xOnlyPubkey = child.publicKey.slice(1);

  // BIP-86 specifies using the internal key with an empty script tree
  // For key-path only spending, we need to apply the taproot tweak
  // tweak = tagged_hash("TapTweak", internal_pubkey)
  const tweak = taggedHash("TapTweak", xOnlyPubkey);

  // Convert internal pubkey to point (need to convert Uint8Array to hex string)
  const internalPubkey = secp256k1.Point.fromHex(bytesToHex(child.publicKey));

  // Convert tweak to bigint - using the order from Fn field
  const tweakScalar = mod(bytesToNumberBE(tweak), secp256k1.Point.Fn.ORDER);

  // Apply tweak: output_key = internal_key + tweak * G
  const tweakedPoint = internalPubkey.add(secp256k1.Point.BASE.multiply(tweakScalar));

  // Get the tweaked x-only pubkey (compressed format, then remove prefix byte)
  const outputPubkey = tweakedPoint.toBytes(true).slice(1);

  // Encode as bech32m address for Taproot (witness version 1)
  const words = bech32m.toWords(outputPubkey);
  const address = bech32m.encode("bc", [1, ...words]);
  return {
    address,
    xOnlyPubkey: outputPubkey, // Return the tweaked output pubkey
    privateKey: new Uint8Array(child.privateKey), // Return a copy of the private key
  };
}
