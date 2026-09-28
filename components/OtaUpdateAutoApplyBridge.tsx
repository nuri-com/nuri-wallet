import * as React from "react";

import { hasOpenSurface, subscribeOpenSurfaces } from "../lib/ui/openSurfaces";
import { walletAccessController } from "../services/auth/WalletAccessController";
import { isAppForeground, onAppForegroundEnter } from "../services/app/ForegroundPoller";
import {
  applyPendingUpdate,
  fetchPendingUpdate,
  isUpdatePending,
  logOtaUpdate,
  onUpdatePending,
} from "../services/app/OtaUpdateService";
import { startOtaUpdateAutoApply, type OtaAutoApplyDeps } from "../services/app/OtaUpdateAutoApply";

/**
 * OtaUpdateAutoApplyBridge — mounting this is what puts a downloaded OTA bundle
 * into use. Renders nothing.
 *
 * The rules live in services/app/OtaUpdateAutoApply.ts; this is only where they
 * are wired to the app: the foreground, the open-surface counter, the
 * wallet-access ceremony and expo-updates.
 *
 * Mounted once inside DsOverlayRoot.
 */
const deps: OtaAutoApplyDeps = {
  isAppForeground,
  hasOpenSurface,
  isWalletAccessBusy: () => walletAccessController.isBusy(),
  isUpdatePending,
  fetchPendingUpdate,
  applyPendingUpdate,
  onAppForegroundEnter,
  onUpdatePending,
  onOpenSurfacesChange: subscribeOpenSurfaces,
  log: logOtaUpdate,
};

export default function OtaUpdateAutoApplyBridge(): null {
  React.useEffect(() => startOtaUpdateAutoApply(deps), []);
  return null;
}
