/**
 * Home Currency Service
 *
 * The app's home fiat is EUR, always. The Wirex/Base migration made the product
 * EUR-only: the wallet holds and sends Base EURC, KYC/IBAN are EUR, and the old
 * multi-currency picker (SafeCurrencyService) is gone. Nothing in this build
 * writes a home currency, and there are no users on any other currency — the
 * only builds that could ever persist GBP/USD are pre-Wirex, and those accounts
 * go through the one-time forced re-onboarding. Pinning to EUR keeps the
 * spendable balance, send-modal labels, and on-chain tx classification
 * consistent with the EURC that is actually held and sent.
 */

import type { FiatCode } from "../tokens";

const HOME_FIAT: FiatCode = "EUR";

class HomeCurrencyService {
  /** Kept for call-site compatibility (App init). EUR-only — nothing to load. */
  async initialize(): Promise<void> {
    // no-op
  }

  /** The app's home fiat — always EUR. */
  getHomeCurrency(): FiatCode {
    return HOME_FIAT;
  }

  /** The ISO code amounts in the home currency are written with ("EUR"). */
  getHomeFiatCode(): FiatCode {
    return HOME_FIAT;
  }

  /** Kept for call-site compatibility (logout). EUR-only — nothing to reset. */
  reset(): void {
    // no-op
  }
}

export const homeCurrencyService = new HomeCurrencyService();
