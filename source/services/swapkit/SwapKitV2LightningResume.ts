import {
  deleteArkadeLightningSend,
  getArkadeLightningSendOwnerKey,
  listArkadeLightningSends,
} from "../arkade/internal/lightningSendStore";
import { getSwapKitV2Status, isSwapKitV2OrderId, isSwapKitV2Terminal } from "./SwapKitV2Service";
import { startSwapKitV2Tracking } from "./SwapKitV2PendingTracker";
import { SwapKitV2OrderStore } from "./SwapKitV2OrderStore";
import { getSwapKitV2RecoveryKey } from "./SwapKitV2RecoveryKey";

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
      if (isSwapKitV2Terminal(view)) await deleteArkadeLightningSend(owner, record.rfqId);
      else startSwapKitV2Tracking(record.txId, view);
    } catch {
      // Retain the record and its funding evidence for the next wallet wake.
    }
  }
}
