/**
 * Home Currency Service
 *
 * The display currency the user picked in Settings (EUR or USD, default EUR).
 * Every converted or aggregated figure — the home total, the overview groups,
 * a bitcoin balance's fiat side, the "≈" part of a euro or dollar row, the fiat
 * entry of a bitcoin send — is stated in it. Balances keep the currency they are
 * held in: the wallet still holds and sends Base EURC/USDC, and IBAN/KYC stay
 * EUR. Logic lives in `homeCurrencyStore.ts`; this file wires device storage and
 * the app's `currency:changed` event (BtcFiatRateStore re-reads its rate on it).
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

import { EventBus } from "../../services/events/AppEventBusService";
import { HomeCurrencyStore, type DisplayCurrency } from "./homeCurrencyStore";

export {
  DISPLAY_CURRENCIES,
  DEFAULT_DISPLAY_CURRENCY,
  type DisplayCurrency,
} from "./homeCurrencyStore";

class HomeCurrencyService {
  private readonly store = new HomeCurrencyStore({
    storage: AsyncStorage,
    onChange: (currency) => EventBus.emit("currency:changed", { currency }),
  });

  /** Loads the stored choice. Awaited in App before the first render. */
  initialize(): Promise<void> {
    return this.store.initialize();
  }

  /** The selected display currency. */
  getHomeCurrency(): DisplayCurrency {
    return this.store.getHomeCurrency();
  }

  /** The ISO code figures in the home currency are written with. */
  getHomeFiatCode(): DisplayCurrency {
    return this.store.getHomeCurrency();
  }

  /** Persist, notify subscribers, emit `currency:changed`. */
  setHomeCurrency(currency: DisplayCurrency): Promise<void> {
    return this.store.setHomeCurrency(currency);
  }

  subscribe(listener: (currency: DisplayCurrency) => void): () => void {
    return this.store.subscribe(listener);
  }

  /** Logout. The display currency is a device preference and survives it. */
  reset(): void {
    // intentionally keeps the choice
  }
}

export const homeCurrencyService = new HomeCurrencyService();
