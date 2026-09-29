// Minimal byte helpers for testable, RN-agnostic code paths
import { randomBytes as nobleRandomBytes } from "@noble/hashes/utils";
import { fromByteArray, toByteArray } from "base64-js";

export type Bytes = Uint8Array;

export function hexToBytes(hex: string): Bytes {
  const s = hex.trim();
  if (!/^[0-9a-fA-F]*$/.test(s) || s.length % 2 !== 0) throw new Error("Invalid hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Bytes): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function isHex(value: string, length?: number): boolean {
  if (!/^[0-9a-f]+$/i.test(String(value || ""))) return false;
  if (length != null && value.length !== length) return false;
  return true;
}

export function normalizeHex(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

export function assertHexLength(value: string, length: number, field: string): void {
  if (!isHex(value, length)) {
    throw new Error(`${field} must be ${length} hex chars`);
  }
}

export function randomBytes(length: number): Bytes {
  // ONLY use @noble/hashes randomBytes - NO FALLBACKS
  return nobleRandomBytes(length);
}

// base64url helpers (no padding)
export function bytesToBase64url(bytes: Bytes): string {
  const b64 = fromByteArray(bytes);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
export function base64urlToBytes(s: string): Bytes {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? 0 : 4 - (b64.length % 4);
  const padded = b64 + "=".repeat(pad);
  return toByteArray(padded);
}

// base64 helpers (with padding) - for PSBT compatibility
export function bytesToBase64(bytes: Bytes): string {
  return fromByteArray(bytes);
}

export function base64ToBytes(s: string): Bytes {
  return toByteArray(s);
}

// Helper to concatenate Uint8Arrays (replaces Buffer.concat)
export function concatBytes(...arrays: Bytes[]): Bytes {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
