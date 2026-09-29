import { HDKey } from "@scure/bip32";
import { keccak_256, secp256k1, bytesToNumberBE } from "../crypto";

export function deriveEthereumAddress(entropy: Uint8Array): {
  address: string;
  privateKey: Uint8Array;
} {
  // Create HD root from entropy
  const root = HDKey.fromMasterSeed(entropy);

  // Derive BIP-44 path for Ethereum: m/44'/60'/0'/0/0
  const path = "m/44'/60'/0'/0/0";
  const child = root.derive(path);

  if (!child.privateKey) {
    throw new Error("Failed to derive private key");
  }

  // Get uncompressed public key using @noble/curves
  // In Noble v2, we need to create a point from the private key
  const privKeyBigInt = bytesToNumberBE(child.privateKey);
  const point = secp256k1.Point.BASE.multiply(privKeyBigInt);
  const publicKey = point.toBytes(false); // false for uncompressed

  // For Ethereum address, we need to hash the public key without the 0x04 prefix
  // publicKey is 65 bytes: 0x04 + 64 bytes of x,y coordinates
  const publicKeyBytes = publicKey.slice(1);

  // Hash with Keccak256
  const hash = keccak_256(publicKeyBytes);

  // Take the last 20 bytes as the address
  const addressBytes = hash.slice(-20);

  // Convert to hex string with 0x prefix
  const address = `0x${Array.from(addressBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;

  const checksumAddress = toChecksumAddress(address);

  return {
    address: checksumAddress,
    privateKey: new Uint8Array(child.privateKey), // Return a copy of the private key
  };
}

// EIP-55 checksum implementation
function toChecksumAddress(address: string): string {
  // Remove 0x prefix if present
  const addr = address.toLowerCase().replace(/^0x/i, "");

  // Hash the lowercase address (without 0x prefix)
  const hash = keccak_256(new TextEncoder().encode(addr));

  let checksumAddress = "0x";

  for (let i = 0; i < addr.length; i++) {
    const char = addr[i];

    // Check if character is a letter (a-f)
    if (/[a-f]/.test(char)) {
      // Get the corresponding nibble from hash
      const nibble = hash[Math.floor(i / 2)];
      const highNibble = i % 2 === 0 ? nibble >> 4 : nibble & 0x0f;

      // Uppercase if high nibble >= 8
      checksumAddress += highNibble >= 8 ? char.toUpperCase() : char;
    } else {
      // It's a number (0-9), keep as is
      checksumAddress += char;
    }
  }

  return checksumAddress;
}
