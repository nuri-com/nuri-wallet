/**
 * Centralized crypto imports for consistency and maintainability
 * All cryptographic functions should be imported from this module
 */

// Noble Libraries - Hashing
import { sha256 as _sha256 } from "@noble/hashes/sha2";
import { sha1 as _sha1 } from "@noble/hashes/legacy";
import { keccak_256 as _keccak_256 } from "@noble/hashes/sha3";
import { hkdf as _hkdf } from "@noble/hashes/hkdf";
import { hmac as _hmac } from "@noble/hashes/hmac";
import {
  hexToBytes as _hexToBytes,
  bytesToHex as _bytesToHex,
  randomBytes as _nobleRandomBytes,
} from "@noble/hashes/utils";

// Noble Libraries - Curves
import { x25519 as _x25519 } from "@noble/curves/ed25519";
import * as _secp256k1Module from "@noble/curves/secp256k1";
import { mod as _mod } from "@noble/curves/abstract/modular";

// Noble Libraries - Ciphers
import { xchacha20poly1305 as _xchacha20poly1305 } from "@noble/ciphers/chacha";
import { gcm as _aesGcm } from "@noble/ciphers/aes";

// StableLib - Additional ciphers
import { XChaCha20Poly1305 as _XChaCha20Poly1305 } from "@stablelib/xchacha20poly1305";

// Base64url helpers - canonical implementation in ../bytes
import { bytesToBase64url, base64urlToBytes } from "../bytes";

// Re-export everything
export const sha256 = _sha256;
export const sha256Hash = _sha256; // Alias for consistency
export const sha1 = _sha1;
export const keccak_256 = _keccak_256;
export const hkdf = _hkdf;
export const hmacSha256 = (key: Uint8Array, data: Uint8Array): Uint8Array =>
  _hmac(_sha256, key, data);
export const hexToBytes = _hexToBytes;
export const bytesToHex = _bytesToHex;
// Export the noble randomBytes directly for clarity
export const randomBytes = _nobleRandomBytes;
export const nobleRandomBytes = _nobleRandomBytes;

export const x25519 = _x25519;
export const secp256k1 = _secp256k1Module.secp256k1;
export const schnorr = _secp256k1Module.schnorr;
export const mod = _mod;

// These functions are from @noble/curves/utils but we define them here
// to avoid ESM import issues with React Native Metro bundler
// This is the EXACT implementation from Noble v2.0.0
export function bytesToNumberBE(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = 0; i < bytes.length; i++) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
}

export function numberToBytesBE(n: bigint, length: number): Uint8Array {
  let value = n;
  const bytes = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) {
    bytes[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

// Export the full secp256k1 module for advanced usage (ProjectivePoint, etc.)
export const secp256k1Module = _secp256k1Module;

export const xchacha20poly1305 = _xchacha20poly1305;
export const aesGcm = _aesGcm;

export const XChaCha20Poly1305 = _XChaCha20Poly1305;

// Type exports
export type Bytes = Uint8Array;

/**
 * UTF-8 string to bytes conversion
 */
export function utf8ToBytes(s: string): Bytes {
  const encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : undefined;
  if (encoder) return encoder.encode(s);
  // Fallback simple UTF-8 encoder
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c < 0xd800 || c >= 0xe000) {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      i++;
      const c2 = s.charCodeAt(i);
      const codePoint = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}

/**
 * BIP340 tagged hash for Taproot
 */
export function taggedHash(tag: string, data: Bytes): Bytes {
  const tagBytes = utf8ToBytes(tag);
  const tagHash = _sha256(tagBytes);
  const preimage = new Uint8Array(tagHash.length * 2 + (data as Uint8Array).length);
  preimage.set(tagHash, 0);
  preimage.set(tagHash, tagHash.length);
  preimage.set(data as Uint8Array, tagHash.length * 2);
  return _sha256(preimage);
}

/**
 * Secure buffer zeroization
 */
export function zeroize(buffer: Uint8Array): void {
  // Overwrite with random data first using @noble
  // This helps prevent compiler optimizations from removing the operation
  const randomData = _nobleRandomBytes(buffer.length);
  buffer.set(randomData);

  // Then fill with zeros
  buffer.fill(0);
}

/**
 * KDF salt constant
 */
export const KDF_SALT = utf8ToBytes("nuri-kdf-salt-v1");

// Re-export base64url helpers from ../bytes (single source of truth)
export { bytesToBase64url, base64urlToBytes };

// Aliases for compatibility
export const uint8ArrayToBase64 = bytesToBase64url;
export const uint8ArrayFromBase64 = base64urlToBytes;

/**
 * Standard HKDF configuration for the application
 */
export const standardHkdf = (
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Uint8Array => {
  return _hkdf(_sha256, ikm, salt, info, length);
};

/**
 * HKDF with SHA256
 */
export const hkdfSha256 = (
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Uint8Array => {
  return _hkdf(_sha256, ikm, salt, info, length);
};

/**
 * Generate cryptographically secure random bytes (async wrapper)
 * ONLY uses @noble/hashes - no fallbacks
 */
export async function randomBytesAsync(length: number): Promise<Uint8Array> {
  // ONLY use @noble/hashes randomBytes - NO FALLBACKS
  return _nobleRandomBytes(length);
}

/**
 * Synchronous random bytes
 * ONLY uses @noble/hashes - no fallbacks
 */
export function randomBytesSync(length: number): Uint8Array {
  // ONLY use @noble/hashes randomBytes - NO FALLBACKS
  return _nobleRandomBytes(length);
}
