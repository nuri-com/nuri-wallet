// What an Arkade-funded order's send waits for, read while the server commits.
// Registered by the executors module, which owns the Arkade send, so the commit
// flows do not pull the wallet modules into every importer.

let warmup: (() => void) | null = null;

export function setV2FundingWarmup(fn: () => void): void {
  warmup = fn;
}

/** Start reading ahead; never throws and never waits. */
export function warmV2Funding(): void {
  try {
    warmup?.();
  } catch {}
}
