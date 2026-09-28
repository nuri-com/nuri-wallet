import { useEffect } from "react";

import { homeCurrencyService } from "../currency/HomeCurrencyService";
import { btcSpotPriceService } from "../../services/pricing/BtcSpotPriceService";

const REQUOTE_DEBOUNCE_MS = 600;

/**
 * Refetch fiat-per-BTC while an amount is being typed, debounced, so the sats
 * actually sent reflect a fresh price.
 *
 * Gated on the RAW digits, not the derived sats: in fiat mode a failed initial
 * price load leaves the derived amount at 0 forever, and gating on that would
 * mean the rate never recovers. A failed refetch keeps the last known price —
 * there is no per-keystroke error to surface.
 */
export function useLiveBtcPrice(
  active: boolean,
  satsDigits: string,
  fiatDigits: string,
  onPrice: (price: number) => void,
): void {
  useEffect(() => {
    if (!active) return;
    const hasInput =
      (satsDigits && Number.parseInt(satsDigits, 10) > 0) ||
      (fiatDigits && Number(fiatDigits || "0") > 0);
    if (!hasInput) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const snapshot = await btcSpotPriceService.getFresh(
            homeCurrencyService.getHomeCurrency(),
          );
          if (cancelled) return;
          if (snapshot.valid && snapshot.price !== null && snapshot.price > 0) {
            onPrice(snapshot.price);
          }
        } catch {}
      })();
    }, REQUOTE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `onPrice` is a setState updater in both consumers — stable by identity.
  }, [active, satsDigits, fiatDigits, onPrice]);
}
