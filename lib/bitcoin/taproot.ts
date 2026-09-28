// Generic BIP-341 taproot helpers (tweak math, sighash append, leaf script
// inspection, PSBT input tap-merkle-root extraction).
import { sha256 } from "@noble/hashes/sha2";
import * as btc from "@scure/btc-signer";
import { bytesToHex, hexToBytes } from "../bytes";

const TAP_TWEAK_TAG = sha256(new TextEncoder().encode("TapTweak"));

type PsbtTransactionInput = ReturnType<btc.Transaction["getInput"]>;

export function computeTapTweak(
  aggregatedXonly32: string,
  tapMerkleRoot?: Uint8Array | null,
): Uint8Array {
  const internal = hexToBytes(aggregatedXonly32);
  const preimage =
    tapMerkleRoot && tapMerkleRoot.length === 32
      ? new Uint8Array([...internal, ...tapMerkleRoot])
      : internal;
  return sha256(new Uint8Array([...TAP_TWEAK_TAG, ...TAP_TWEAK_TAG, ...preimage]));
}

export function getInputTapMerkleRoot(
  input: PsbtTransactionInput | null | undefined,
): Uint8Array | null {
  const root = input?.tapMerkleRoot;
  if (!root) return null;
  if (root instanceof Uint8Array && root.length === 32) return root;
  if (ArrayBuffer.isView(root)) {
    const bytes = new Uint8Array(root.buffer, root.byteOffset, root.byteLength);
    return bytes.length === 32 ? new Uint8Array(bytes) : null;
  }
  return null;
}

export function appendTaprootSighash(sig64: Uint8Array, sighashType: number): Uint8Array {
  if (sighashType === btc.SigHash.DEFAULT) return sig64;
  const out = new Uint8Array(sig64.length + 1);
  out.set(sig64, 0);
  out[sig64.length] = Number(sighashType) & 0xff;
  return out;
}

export function scriptContainsXOnlyPubkey(scriptOps: unknown[], xOnlyPubkey: Uint8Array): boolean {
  const xOnlyHex = bytesToHex(xOnlyPubkey).toLowerCase();
  for (const op of scriptOps) {
    if (!(op instanceof Uint8Array)) continue;
    if (op.length === 32 && bytesToHex(op).toLowerCase() === xOnlyHex) {
      return true;
    }
    if (op.length === 33 && bytesToHex(op.slice(1)).toLowerCase() === xOnlyHex) {
      return true;
    }
  }
  return false;
}
