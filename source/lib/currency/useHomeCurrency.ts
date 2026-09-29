import { useSyncExternalStore } from "react";

import { homeCurrencyService } from "./HomeCurrencyService";
import type { DisplayCurrency } from "./homeCurrencyStore";

const subscribe = (listener: () => void) => homeCurrencyService.subscribe(() => listener());
const getSnapshot = () => homeCurrencyService.getHomeCurrency();

/** The selected display currency; re-renders when it changes. */
export function useHomeCurrency(): DisplayCurrency {
  return useSyncExternalStore(subscribe, getSnapshot);
}
