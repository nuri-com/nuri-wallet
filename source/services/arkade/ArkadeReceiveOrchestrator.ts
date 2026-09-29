// Prod-tier orchestrator facade for the Arkade receive flow. The receive-stage
// state machine + state lives in services/arkade/internal/receiveStage.ts and
// the scheduler implementations live in services/arkade/internal/receiveAuto*.
// This file re-exports the public surfaces and exposes the scheduler wrapper
// functions so the prod tier still owns the public API.
import type { ArkadeWalletSummary } from "./types/wallet";
import { readPendingLnurlSwapsCache } from "./internal/pendingLnurlSwaps";
import {
  scheduleArkadeLnurlPendingAutoLoadImpl,
  scheduleArkadeWalletAutoSettleImpl,
} from "./internal/receiveAutoClaim";
import { scheduleArkadeRecoverableAutoClaimImpl } from "./internal/receiveAutoRecover";
import { scheduleArkadeBoardingAutoSweepImpl } from "./internal/receiveAutoSweep";

export type { ArkadeBoardingSweepFailureSnapshot } from "./internal/boardingSweepFailure";
export type { ArkadeReceiveStageBaseCounts } from "./internal/receiveStage";

export {
  deriveArkadeReceiveStageStatus,
  getArkadeReceiveStageBaseCounts,
  getArkadeReceiveStageSnapshot,
  refreshArkadeReceiveStageFromCaches,
  resetArkadeReceiveOrchestratorState,
  setReceiveStage,
  updateReceiveStageFromWalletSummary,
} from "./internal/receiveStage";

export function readArkadePendingLnurlSwapsCache(): ReturnType<typeof readPendingLnurlSwapsCache> {
  return readPendingLnurlSwapsCache();
}

export function scheduleArkadeLnurlPendingAutoLoad(
  reason: string,
  allowPrompt: boolean,
  force = false,
): void {
  scheduleArkadeLnurlPendingAutoLoadImpl(reason, allowPrompt, force);
}

export function scheduleArkadeBoardingAutoSweep(
  summary: ArkadeWalletSummary,
  reason: string,
  force = false,
): void {
  scheduleArkadeBoardingAutoSweepImpl(summary, reason, force);
}

export function scheduleArkadeRecoverableAutoClaim(
  summary: ArkadeWalletSummary,
  reason: string,
  force = false,
): void {
  scheduleArkadeRecoverableAutoClaimImpl(summary, reason, force);
}

export function scheduleArkadeWalletAutoSettle(reason: string, force = false): void {
  scheduleArkadeWalletAutoSettleImpl(reason, force);
}
