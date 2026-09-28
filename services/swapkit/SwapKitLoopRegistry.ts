import { LOG_EMOJI, logWithId } from "../../lib/OperationLogUtils";
const SOURCE = "services/swapkit/SwapKitLoopRegistry.ts";

// App-wide one-loop-per-order registry. Every signer path (foreground topup
// loop, background tracker, discovered-order resume, USDC recovery) must claim
// the txId here before polling/signing. Two concurrent loops for one order
// double-broadcast the same leg (observed live 2026-07-13: one tx reverted
// onchain). In-memory only — a fresh process starts empty by design.
const activeSwapLoops = new Set<string>();

// Diagnostic for issue #894: every poll line is currently printed twice for the
// same txId, which means two loops are running despite the registry above. Two
// candidate causes, and this tag separates them: if the two claim lines carry
// DIFFERENT registry ids, there are two module instances (several call sites
// reach this file through `await import(...)`, so a second copy is plausible)
// and the Set cannot see across them. Same id on both means the registry is
// shared and we have a release/re-arm race instead. Cheap enough to keep.
const REGISTRY_ID = `reg_${Math.random().toString(36).slice(2, 8)}`;

/** Claim exclusive tracking of an order. False when another loop holds it. */
export function claimSwapLoop(txId: string): boolean {
  const key = (txId || "").trim().toLowerCase();
  const refused = !key || activeSwapLoops.has(key);
  if (!refused) activeSwapLoops.add(key);
  logWithId(
    `${LOG_EMOJI.bitcoin} SwapKit.loop`,
    `loop claim ${refused ? "REFUSED" : "OK"} registry=${REGISTRY_ID} held=${activeSwapLoops.size}`,
    { txId: key },
    { source: `${SOURCE}#claimSwapLoop`, event: "FLOW", action: "claim" },
  );
  return !refused;
}

export function releaseSwapLoop(txId: string): void {
  const key = (txId || "").trim().toLowerCase();
  activeSwapLoops.delete(key);
  logWithId(
    `${LOG_EMOJI.bitcoin} SwapKit.loop`,
    `loop released registry=${REGISTRY_ID} held=${activeSwapLoops.size}`,
    { txId: key },
    { source: `${SOURCE}#releaseSwapLoop`, event: "FLOW", action: "release" },
  );
}

/** Is a loop currently driving this order? The status UI asks before offering
 * the user a step to run: while a loop holds the claim, every action the wallet
 * can execute is already being executed, and a "Continue" button would claim
 * the same registry key and do nothing. */
export function isSwapLoopActive(txId: string): boolean {
  const key = (txId || "").trim().toLowerCase();
  return key ? activeSwapLoops.has(key) : false;
}
