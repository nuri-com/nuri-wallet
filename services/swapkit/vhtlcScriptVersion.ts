import { VHTLC } from "@arkade-os/sdk";

/**
 * Which vHTLC script a swap's lockup was built with — kept beside the SDK and
 * nothing else, so it stays reachable from a test (the adapter that uses it
 * pulls in secure storage and the wallet, which a node test cannot load; the
 * refund timing gate lives in its own module for the same reason).
 *
 * Version 0 is the original script, version 1 the strict one whose preimage
 * leaves carry a length check. Satora's Arkade corridor locks to the strict
 * script since 2026-08-21. The two compile to different bytes and therefore to
 * different addresses for the same participants, which is why the SDK keeps
 * them as separate classes rather than a flag — and why the wrong choice does
 * not merely fail, it leaves a funded lockup this wallet cannot open.
 */
export function vhtlcScriptClass(version: unknown): typeof VHTLC.Script | typeof VHTLC.ScriptV2 {
  if (version == null) return VHTLC.Script;
  const n = Number(version);
  if (n === 0) return VHTLC.Script;
  if (n === 1) return VHTLC.ScriptV2;
  throw new Error(
    `SwapKit Arkade VHTLC rejected: vhtlc.scriptVersion ${String(version)} is not a version this wallet can build`,
  );
}
