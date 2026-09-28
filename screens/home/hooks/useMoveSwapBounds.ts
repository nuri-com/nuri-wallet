// The Move sheet's pre-quote amount bounds for the chosen pair.
//
// Read once per pair from the server's `swap_limits` (read-only: no price, no
// order), so the CTA can say "Min …" before the user asks for prices. Null
// while loading, for a pair that is a plain transfer, and whenever the server
// cannot answer — in every one of those cases the sheet behaves exactly as it
// did before the bound existed.
import { useEffect, useState } from "react";
import type { SwapAmountBounds } from "../../../services/swapkit/SwapAmountBounds";
import { type SwapAssetId, swapAmountBounds } from "../../../services/swapkit/SwapContract";

export function useMoveSwapBounds(pair: {
  from?: SwapAssetId | undefined;
  to?: SwapAssetId | undefined;
  sendSource?: "arkade" | "onchain" | undefined;
}): SwapAmountBounds | null {
  const { from, to, sendSource } = pair;
  const [bounds, setBounds] = useState<SwapAmountBounds | null>(null);
  useEffect(() => {
    setBounds(null);
    if (!from || !to) return;
    let live = true;
    swapAmountBounds({ from, to, ...(sendSource ? { sendSource } : {}) })
      .then((next) => {
        if (live) setBounds(next);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [from, to, sendSource]);
  return bounds;
}
