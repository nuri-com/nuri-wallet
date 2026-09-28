import { useEffect, useState } from "react";
import { homeCurrencyService } from "../currency/HomeCurrencyService";
import { btcSpotPriceService } from "../../services/pricing/BtcSpotPriceService";
import { CURRENCIES, type FiatCode } from "../tokens";

export type SwapKitRateState = {
  fiatPerBtc: number | null;
  loadingPrice: boolean;
  priceUnavailable: boolean;
};

export function useSwapKitRate(
  active: boolean,
  currency?: FiatCode | string | null,
): SwapKitRateState {
  const [fiatPerBtc, setFiatPerBtc] = useState<number | null>(null);
  const [loadingPrice, setLoadingPrice] = useState(false);

  useEffect(() => {
    if (!active) return;
    const rawCurrency = (currency ?? homeCurrencyService.getHomeCurrency() ?? "EUR").toUpperCase();
    const homeCur: FiatCode = rawCurrency in CURRENCIES ? (rawCurrency as FiatCode) : "EUR";
    let mounted = true;

    const loadRate = async () => {
      try {
        setLoadingPrice(true);
        const snap = await btcSpotPriceService.getFresh(homeCur);
        if (mounted) setFiatPerBtc(snap.valid && snap.price > 0 ? snap.price : null);
      } catch (error: unknown) {
        console.warn(
          "[useSwapKitRate] spot price failed:",
          error instanceof Error ? error.message : String(error),
        );
        if (mounted) setFiatPerBtc(null);
      } finally {
        if (mounted) setLoadingPrice(false);
      }
    };

    void loadRate();

    return () => {
      mounted = false;
    };
  }, [active, currency]);

  const priceUnavailable = !loadingPrice && (fiatPerBtc === null || fiatPerBtc <= 0);
  return { fiatPerBtc, loadingPrice, priceUnavailable };
}
