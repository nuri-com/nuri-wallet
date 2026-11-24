import {
  clearArkadeLightningSendDeclined,
  getArkadeLightningSendOwnerKey,
  listArkadeLightningSends,
  markArkadeLightningSendDeclined,
  retireArkadeLightningSend,
} from "../arkade/internal/lightningSendStore";
import { getSwapKitV2Status, isSwapKitV2OrderId, isSwapKitV2Terminal } from "./SwapKitV2Service";
import { setV2LightningSendDeclineHooks, startSwapKitV2Tracking } from "./SwapKitV2PendingTracker";
import { SwapKitV2OrderStore } from "./SwapKitV2OrderStore";
import { getSwapKitV2RecoveryKey } from "./SwapKitV2RecoveryKey";
import { wasAnyV2ActionStarted } from "./SwapKitV2ActionService";

/** The tracker's view of a cancelled prompt reaches the send records (#1780). */
export const v2LightningSendDeclineHooks = {
  async mark(orderId: string): Promise<void> {
    const owner = await getArkadeLightningSendOwnerKey();
    if (owner) await markArkadeLightningSendDeclined(owner, orderId);
  },
  async clear(orderId: string): Promise<void> {
    const owner = await getArkadeLightningSendOwnerKey();
    if (owner) await clearArkadeLightningSendDeclined(owner, orderId);
  },
};
setV2LightningSendDeclineHooks(v2LightningSendDeclineHooks);

/** Fails closed: an unreadable journal counts as started. */
async function noV2ActionStarted(orderId: string): Promise<boolean> {
  try {
    return !(await wasAnyV2ActionStarted(orderId));
  } catch {
    return false;
  }
}

export async function checkV2LightningSends(_reason: string): Promise<void> {
  const owner = await getArkadeLightningSendOwnerKey();
  if (!owner) return;
  await SwapKitV2OrderStore.hydrate();
  for (const record of await listArkadeLightningSends(owner)) {
    // Never reinterpret a legacy id as a v2 order or erase its refund material.
    if (!isSwapKitV2OrderId(record.txId)) continue;
    try {
      const recoveryKey =
        SwapKitV2OrderStore.get(record.txId)?.recoveryKey ?? (await getSwapKitV2RecoveryKey());
      const view = await getSwapKitV2Status(record.txId, { recoveryKey });
      if (isSwapKitV2Terminal(view)) {
        // A send the user stopped at the passkey prompt that never started is
        // retired without a paid-hash tombstone, so the same invoice can still
        // be paid on purpose (#1780). A completed order never qualifies, and
        // the store re-checks that no funding txid exists for the record.
        const neverSent =
          String(view.status).toUpperCase() !== "COMPLETED" &&
          (await noV2ActionStarted(record.txId));
        await retireArkadeLightningSend(owner, record.rfqId, { noActionStarted: neverSent });
      } else startSwapKitV2Tracking(record.txId, view);
    } catch {
      // Retain the record and its funding evidence for the next wallet wake.
    }
  }
}
