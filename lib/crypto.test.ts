import { afterEach, describe, expect, it } from "vitest";
import {
  base64urlToBytes,
  bytesToBase64url,
  bytesToHex,
  bytesToUtf8,
  decryptSeed,
  deriveKey,
  encryptSeed,
  hexToBytes,
  normalizePrfOutput,
} from "./crypto";

const originalTextDecoder = globalThis.TextDecoder;

describe("crypto wallet helpers", () => {
  afterEach(() => {
    globalThis.TextDecoder = originalTextDecoder;
  });

  it("normalizes PRF output from base64url, base64, ArrayBuffer, and typed views", () => {
    const prf = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const base64 = "AAEC/f7/";

    expect(normalizePrfOutput(bytesToBase64url(prf))).toEqual(prf);
    expect(normalizePrfOutput(base64)).toEqual(prf);
    expect(normalizePrfOutput(prf.buffer.slice(0))).toEqual(prf);
    expect(normalizePrfOutput(new DataView(prf.buffer, 1, 3))).toEqual(new Uint8Array([1, 2, 253]));
  });

  it("rejects absent, malformed, and unsupported PRF output", () => {
    expect(() => normalizePrfOutput(null)).toThrow("No PRF output");
    expect(() => normalizePrfOutput("not valid!?")).toThrow("Invalid PRF format");
    expect(() => normalizePrfOutput({ prf: true })).toThrow("Unknown PRF output format");
  });

  it("decodes four-byte UTF-8 sequences through the manual surrogate-pair path", () => {
    // Force the fallback branch so RN/JSC hosts without TextDecoder keep decoding wallet seeds.
    globalThis.TextDecoder = undefined as typeof TextDecoder | undefined;

    expect(bytesToUtf8(new Uint8Array([0x6e, 0x75, 0x72, 0x69]))).toBe("nuri");
    expect(bytesToUtf8(new Uint8Array([0xf0, 0x9f, 0x94, 0x90]))).toBe("🔐");
  });

  it("derives a fixed seed-encryption key and round-trips seed ciphertext", () => {
    const prf = base64urlToBytes("cGhhc2UtNC1wcmYtdmVjdG9y");
    const key = deriveKey(prf);
    const seed =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    expect(bytesToHex(key)).toBe(
      "7c180659f8d300383c38e626340c59bc33be967bec1b2f061ecdd594cb729ea3",
    );

    const encrypted = encryptSeed(seed, key);
    expect(encrypted.nonce).toHaveLength(24);
    expect(encrypted.ciphertext.length).toBeGreaterThan(seed.length);
    expect(decryptSeed(encrypted.ciphertext, encrypted.nonce, key)).toBe(seed);

    const wrongKey = hexToBytes("00".repeat(32));
    expect(decryptSeed(encrypted.ciphertext, encrypted.nonce, wrongKey)).toBeNull();
  });
});
