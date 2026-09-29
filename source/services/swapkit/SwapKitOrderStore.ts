import { setCacheValue } from "../balance/TransactionCacheService";

// What is left of the SwapKit v1 order store: the wipe. Nothing reads or
// writes v1 orders any more (every swap runs on SwapKit v2, whose rows live in
// SwapKitV2OrderStore), but a device that ran a v1 build can still hold rows
// under this key, and logout/reset must not leave them behind.
const STORAGE_KEY = "swapkit:orders:v1";

export const SwapKitOrderStore = {
  async clear(): Promise<void> {
    await setCacheValue(STORAGE_KEY, []);
    try {
      console.log("[SwapKitOrderStore] clear");
    } catch {}
  },
};
