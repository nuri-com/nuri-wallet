// Internal wallet-cache lifecycle event listeners. Receive modules register
// here to react to wallet ready/recreating events without walletCache having
// to import them directly (avoids the walletCache → receiveAutoClaim cycle).
//
// Importing types is fine (zero-runtime); importing the receive modules from
// here would re-introduce the cycle, so don't.

export type ArkadeWalletCacheEvent = "ready" | "recreating";

export type ArkadeWalletCacheListener = (
  event: ArkadeWalletCacheEvent,
  reason: string,
) => void | Promise<void>;

const listeners: Set<ArkadeWalletCacheListener> = new Set();

export function addArkadeWalletCacheListener(listener: ArkadeWalletCacheListener): void {
  listeners.add(listener);
}

export function removeArkadeWalletCacheListener(listener: ArkadeWalletCacheListener): void {
  listeners.delete(listener);
}

/**
 * Emit a wallet-cache lifecycle event. Awaits each listener so async cleanup
 * (e.g. `lightningCache` disposing its swap manager on "recreating") can
 * complete before the caller proceeds with the next step. Synchronous
 * listeners stay compatible — they just resolve immediately.
 */
export async function emitArkadeWalletCacheEvent(
  event: ArkadeWalletCacheEvent,
  reason: string,
): Promise<void> {
  for (const listener of listeners) {
    try {
      await listener(event, reason);
    } catch (err: unknown) {
      console.error("[ArkadeWalletCache] listener threw:", err);
    }
  }
}
