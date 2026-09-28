// The Arkade Lightning (Boltz) engine is retired.
//
// The app used to run its Lightning receive on `@arkade-os/boltz-swap`. Boltz is
// gone, the package is out of the tree, and Arkade receive today is the boarding
// address, so nothing here talks to a swap provider any more. This module keeps
// the old export surface so the callers that are still being unwound compile and
// fail honestly instead of reaching for a package that no longer exists.
//
// Do not add a replacement engine here: the Arkade Intents corridor owns
// Lightning sends (services/swapkit), and there is no Lightning receive rail.

import { emitTrace } from "./logging";

/** The retired engine's shape, kept only to type the caches consumers read. */
export type RetiredArkadeLightning = {
  readonly retired: true;
};

let cachedLightning: RetiredArkadeLightning | null = null;

const RETIRED_REASON =
  "Arkade Lightning is retired: the Boltz engine is gone and receive is the boarding address";

function traceRetiredCall(caller: string): void {
  emitTrace({
    atMs: Date.now(),
    op: "arkade_lightning_retired",
    status: "blocked",
    detail: `caller=${caller} reason=boltz_engine_removed expected_next=use_boarding_address_or_swapkit_intents`,
  });
}

export function getCachedArkadeLightning(): RetiredArkadeLightning | null {
  return cachedLightning;
}

export function getCachedArkadeBoltzUrl(): string | null {
  return null;
}

export async function disposeCachedArkadeLightningOnWalletReset(): Promise<void> {
  cachedLightning = null;
}

export function resetArkadeLightningCacheState(): void {
  cachedLightning = null;
}

export async function getOrCreateLightning(): Promise<RetiredArkadeLightning> {
  traceRetiredCall("getOrCreateLightning");
  throw new Error(RETIRED_REASON);
}
