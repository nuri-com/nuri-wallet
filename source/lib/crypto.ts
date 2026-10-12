import { toByteArray } from "base64-js";
import {
  sha256 as sha256Hash,
  xchacha20poly1305,
  randomBytes as nobleRandomBytes,
  // Import shared utils for internal use
  utf8ToBytes,
  taggedHash,
  bytesToBase64url,
  base64urlToBytes,
  hexToBytes,
  bytesToHex,
  hkdfSha256,
  hmacSha256,
  randomBytesAsync,
  KDF_SALT,
} from "./crypto/index";

// Re-export curve/cipher primitives from crypto/index
export {
  bytesToNumberBE,
  numberToBytesBE,
  keccak_256,
  secp256k1,
  x25519,
  xchacha20poly1305,
  schnorr,
  aesGcm,
} from "./crypto/index";

// Re-export shared utility functions (canonical implementations in crypto/index)
export {
  utf8ToBytes,
  taggedHash,
  bytesToBase64url,
  base64urlToBytes,
  hexToBytes,
  bytesToHex,
  hkdfSha256,
  hmacSha256,
  randomBytesAsync,
  KDF_SALT,
};

export type Bytes = Uint8Array;

// UTF-8 bytes to string decoder (unique to this module)
export function bytesToUtf8(bytes: Bytes): string {
  const decoder = typeof TextDecoder !== "undefined" ? new TextDecoder() : undefined;
  if (decoder) return decoder.decode(bytes);
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const c = bytes[i++];
    if (c < 0x80) {
      out += String.fromCharCode(c);
    } else if (c < 0xe0) {
      const c2 = bytes[i++] & 0x3f;
      out += String.fromCharCode(((c & 0x1f) << 6) | c2);
    } else if (c < 0xf0) {
      const c2 = bytes[i++] & 0x3f;
      const c3 = bytes[i++] & 0x3f;
      out += String.fromCharCode(((c & 0x0f) << 12) | (c2 << 6) | c3);
    } else {
      // 4 bytes -> surrogate pair
      const c2 = bytes[i++] & 0x3f;
      const c3 = bytes[i++] & 0x3f;
      const c4 = bytes[i++] & 0x3f;
      let u = ((c & 0x07) << 18) | (c2 << 12) | (c3 << 6) | c4;
      u -= 0x10000;
      out += String.fromCharCode(0xd800 | (u >> 10));
      out += String.fromCharCode(0xdc00 | (u & 0x3ff));
    }
  }
  return out;
}

// CSPRNG
export function randomBytes(length: number): Bytes {
  return nobleRandomBytes(length);
}

// SHA256 hash
export function sha256(data: Bytes): Bytes {
  return sha256Hash(data);
}

// XChaCha20-Poly1305 AEAD
export function aeadEncryptX(key: Bytes, nonce: Bytes, plaintext: Bytes, aad?: Bytes): Bytes {
  return xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
}

export function aeadDecryptX(
  key: Bytes,
  nonce: Bytes,
  ciphertext: Bytes,
  aad?: Bytes,
): Bytes | null {
  try {
    return xchacha20poly1305(key, nonce, aad).decrypt(ciphertext);
  } catch {
    return null;
  }
}

// PRF normalization: accept various formats from passkey bridge
export function normalizePrfOutput(v: unknown): Bytes {
  if (!v) throw new Error("No PRF output");
  if (typeof v === "string") {
    const s = v.trim();
    // try base64url (URL-safe base64) - preferred format
    try {
      if (/^[A-Za-z0-9_-]+$/.test(s)) return base64urlToBytes(s);
    } catch {}
    // try standard base64 (with + and /) - fallback
    try {
      if (/^[A-Za-z0-9+/]+=*$/.test(s)) return toByteArray(s);
    } catch {}
    // try hex
    if (/^[0-9a-fA-F]+$/.test(s)) return hexToBytes(s);
    // no UTF-8 fallback for PRF data
    throw new Error("Invalid PRF format");
  }
  if (typeof ArrayBuffer !== "undefined" && v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw new Error("Unknown PRF output format");
}

// Constants
export const PRF_INPUT_BYTES: Bytes = (() => {
  const label = "nuri-prf-input-v1";
  const buf = new Uint8Array(32);
  const src = utf8ToBytes(label);
  buf.set(src.slice(0, Math.min(32, src.length)));
  return buf;
})();

// Derive encryption key from PRF output
export function deriveKey(prfBytes: Bytes): Bytes {
  return hkdfSha256(prfBytes, KDF_SALT, utf8ToBytes("nuri:seed:enc:v1"), 32);
}

// Encrypt a seed with derived encryption key
export function encryptSeed(seed: string, dekBytes: Bytes): { nonce: Bytes; ciphertext: Bytes } {
  const nonce = randomBytes(24);
  const plaintext = utf8ToBytes(seed);
  const ciphertext = aeadEncryptX(dekBytes, nonce, plaintext);
  return { nonce, ciphertext };
}

// Decrypt a seed with derived encryption key
export function decryptSeed(ciphertext: Bytes, nonce: Bytes, dekBytes: Bytes): string | null {
  const plaintext = aeadDecryptX(dekBytes, nonce, ciphertext);
  if (!plaintext) return null;
  return bytesToUtf8(plaintext);
}

// Securely clear sensitive data from memory (enhanced version)
export function zeroize(buffer: Uint8Array): void {
  const randomData = nobleRandomBytes(buffer.length);
  buffer.set(randomData);
  buffer.fill(0);
  for (let i = 0; i < buffer.length; i++) {
    buffer[i] = 0xff;
  }
  buffer.fill(0);
}

// Compatibility aliases for old function names
export const uint8ArrayToBase64 = bytesToBase64url;
export const uint8ArrayFromBase64 = base64urlToBytes;
export const uint8ArrayToHex = bytesToHex;
export const uint8ArrayFromHex = hexToBytes;
