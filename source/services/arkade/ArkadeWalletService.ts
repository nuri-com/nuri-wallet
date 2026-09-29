// Prod-tier wallet-summary public API. Thin re-export shim — the loader,
// cache state, validation/rate-limit helpers, per-stage instrumentation, AND
// the rate-limited public wrapper (`getArkadeWalletSummary`) all live in
// services/arkade/internal/walletSummary.ts so internal receive-flow modules
// can read/load the summary without re-introducing the prod→internal→prod
// cycle flagged on PR #546.
export {
  getArkadeWalletSummary,
  loadArkadeWalletSummary,
  resetArkadeWalletSummaryCache,
} from "./internal/walletSummary";

// Side-effect import: registers the wallet-summary listener that eagerly
// initializes lightning after an app restart while the persisted swap store
// still holds a non-final swap, so the SDK SwapManager resumes it.
import "./internal/outgoingSwapResume";
import "./internal/lightningSendResume";

import { getCachedWalletSummary, getLastGoodWalletSummary } from "./internal/walletSummary";
import type { ArkadeWalletSummary } from "./types/wallet";

export function getArkadeWalletSummarySnapshot(): ArkadeWalletSummary | null {
  return getCachedWalletSummary();
}

export function getLastGoodArkadeWalletSummarySnapshot(): ArkadeWalletSummary | null {
  return getLastGoodWalletSummary();
}

// Every summary load, for UI that mirrors a figure the summary owns. The
// balance travels on its own store; the pending-VTXO figure has no store, so
// without this a screen holding it only learns of a change when some unrelated
// event happens to fire.
export {
  addArkadeWalletSummaryListener,
  removeArkadeWalletSummaryListener,
} from "./internal/walletSummaryEvents";
