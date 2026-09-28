// Runtime-loaded debug component bindings. Prod code MUST import debug
// components from here, not directly from `screens/debug/*`, so that
// typecheck does not require the debug tree to exist:
//   rm -rf screens/debug services/arkade/debug && tsc --noEmit  →  passes
//
// Metro/RN still resolves these `require()` calls at build time, so debug
// components remain part of the shipped bundle when the files exist. The
// try/catch only matters for the static-analysis acceptance test above.

import type React from "react";

declare const __DEV__: boolean | undefined;

export const DEBUG_UI_ENABLED = typeof __DEV__ !== "undefined" && __DEV__ === true;
import type {
  DebugArkadeProps,
  DebugBankTxDumpProps,
  DebugDsReviewProps,
  DebugEoaKeyExportProps,
  DebugModalProps,
  DebugNotificationsProps,
  DebugSatoraRefundProps,
  DebugUsdcRecoveryProps,
  DebugWirexWithdrawProps,
  DebugWirexSignUpProps,
} from "../../types/debug";

function loadDebugComponent<P>(loader: () => unknown): React.ComponentType<P> | null {
  if (!DEBUG_UI_ENABLED) return null;
  try {
    const mod = loader() as { default?: React.ComponentType<P> };
    return mod?.default ?? null;
  } catch {
    return null;
  }
}

export const DebugModal = loadDebugComponent<DebugModalProps>(() =>
  require("../../screens/debug/DebugModal"),
);

export const DebugArkadeModal = loadDebugComponent<DebugArkadeProps>(() =>
  require("../../screens/debug/DebugArkadeModal"),
);

export const DebugWirexSignUpModal = loadDebugComponent<DebugWirexSignUpProps>(() =>
  require("../../screens/debug/DebugWirexSignUpModal"),
);

export const DebugBankTxDumpModal = loadDebugComponent<DebugBankTxDumpProps>(() =>
  require("../../screens/debug/DebugBankTxDumpModal"),
);

export const DebugEoaKeyExportModal = loadDebugComponent<DebugEoaKeyExportProps>(() =>
  require("../../screens/debug/DebugEoaKeyExportModal"),
);

export const DebugUsdcRecoveryModal = loadDebugComponent<DebugUsdcRecoveryProps>(() =>
  require("../../screens/debug/DebugUsdcRecoveryModal"),
);

/** TEMPORARY — remove with the Satora collab-refund debug tool. */
export const DebugSatoraRefundModal = loadDebugComponent<DebugSatoraRefundProps>(() =>
  require("../../screens/debug/DebugSatoraRefundModal"),
);

export const DebugWirexWithdrawModal = loadDebugComponent<DebugWirexWithdrawProps>(() =>
  require("../../screens/debug/DebugWirexWithdrawModal"),
);

export const DebugDsReviewModal = loadDebugComponent<DebugDsReviewProps>(() =>
  require("../../screens/debug/DebugDsReviewModal"),
);

export const DebugNotificationsModal = loadDebugComponent<DebugNotificationsProps>(() =>
  require("../../screens/debug/DebugNotificationsModal"),
);
