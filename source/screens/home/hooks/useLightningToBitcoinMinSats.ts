// The Lightning -> Bitcoin corridor floor, re-read from the server each time
// `active` turns true (the sheets stay mounted while hidden). Until the first
// answer it is the fallback; afterwards the last good answer.
import { useEffect, useSyncExternalStore } from "react";
import {
  getLightningToBitcoinMinSats,
  subscribeLightningToBitcoinMinSats,
} from "../../../services/swapkit/LightningToBitcoinLimits";
import { refreshLightningToBitcoinMinSats } from "../../../services/swapkit/SwapKitV2ArkadeToBtcService";

export function useLightningToBitcoinMinSats(active: boolean): number {
  useEffect(() => {
    if (active) void refreshLightningToBitcoinMinSats();
  }, [active]);
  return useSyncExternalStore(subscribeLightningToBitcoinMinSats, getLightningToBitcoinMinSats);
}
