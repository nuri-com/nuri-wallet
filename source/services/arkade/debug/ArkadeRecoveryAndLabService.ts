import {
  networks as arkadeNetworks,
  OnchainWallet,
  SingleKey,
  Transaction,
  Unroll,
  VtxoScript,
} from "@arkade-os/sdk";
import * as musig2 from "@scure/btc-signer/musig2.js";
import { bytesToHex } from "../../../lib/bytes";
import { zeroize } from "../../../lib/crypto";
import { shortTime } from "../../../lib/logShared";
import { authStateManager } from "../../auth/AuthStateService";
import {
  ArkadeRemoteIdentity,
  setArkadeActualRecoveryProofReadinessProvider,
  type ArkadeIdentityReadiness,
} from "../ArkadeRemoteIdentity";
import type { ArkadeRelativeTimelock } from "../ArkadeApiService";
import {
  decryptArkadeRecoveryBackup,
  restoreArkadeRecoveryBackup,
  setArkadeRecoveryBackupProofReadinessProvider,
  uploadArkadeRecoveryBackup,
  type ArkadeRecoveryBackupSummary,
} from "../ArkadeRecoveryBackupService";
import { sendArkadeToArk } from "../ArkadeSendService";
import { ARKADE_LIGHTNING_STATUS } from "../ArkadeVersion";
import {
  ARKADE_CLIENT_RECOVERY_CONTRACT_TYPE,
  ArkadeClientRecoveryVtxoScript,
  buildArkadeClientRecoveryProof,
  type ArkadeClientRecoveryContractParams,
  type ArkadeClientRecoveryProof,
} from "../ArkadeClientRecoveryContract";
import { verifyArkadeServerDecayVtxoPolicy } from "../ArkadeServerDecayPolicy";
import type { ArkadeWalletSummary } from "../types/wallet";
import { resetArkadeLnurlCache } from "../ArkadeLnurlService";
import {
  getArkadeWalletSummary,
  getArkadeWalletSummarySnapshot,
  getLastGoodArkadeWalletSummarySnapshot,
  loadArkadeWalletSummary,
  resetArkadeWalletSummaryCache,
} from "../ArkadeWalletService";
import { resetArkadeReceiveOrchestratorState } from "../ArkadeReceiveOrchestrator";
import { resetBoardingSweepFailureCache } from "../internal/boardingSweepFailure";
import {
  resetArkadeBoardingAutoSweepState,
  sweepArkadeBoardingToOffchain,
} from "../internal/receiveAutoSweep";
import { resetArkadeOutgoingSwapResumeState } from "../internal/outgoingSwapResume";
import {
  getArkadePendingLnurlSwaps,
  resetArkadeReceiveAutoClaimState,
  resumeArkadeLightningClaimsManual,
  settleArkadePreconfirmedVtxos,
  triggerArkadeReceiveActiveRetry,
  triggerArkadeReceiveAutomation,
  type ArkadeLightningClaimSummary,
} from "../internal/receiveAutoClaim";
export {
  getArkadeWalletSummary,
  getArkadeWalletSummarySnapshot,
  getLastGoodArkadeWalletSummarySnapshot,
  loadArkadeWalletSummary,
};
export {
  getArkadeReceiveStageBaseCounts,
  getArkadeReceiveStageSnapshot,
  readArkadePendingLnurlSwapsCache,
  scheduleArkadeBoardingAutoSweep,
  scheduleArkadeLnurlPendingAutoLoad,
  scheduleArkadeWalletAutoSettle,
  setReceiveStage,
  updateReceiveStageFromWalletSummary,
} from "../ArkadeReceiveOrchestrator";
export {
  getArkadePendingLnurlSwaps,
  settleArkadePreconfirmedVtxos,
  sweepArkadeBoardingToOffchain,
  triggerArkadeReceiveActiveRetry,
  triggerArkadeReceiveAutomation,
};
import {
  ARKADE_CHAIN_SWAP_CLAIM_TIMEOUT_MS,
  ARKADE_LN_CREATE_TIMEOUT_MS,
  ARKADE_NODE_INFO_TIMEOUT_MS,
} from "../internal/constants";
import {
  hexToBytesLocal,
  isZeroArkadeWalletSummary,
  truncateForLog,
  withTimeout,
} from "../internal/utils";
import {
  emitTrace,
  logArkadeWalletErrorTrace,
  logArkadeWalletSignTrace,
  subscribeArkadeWalletDebugTrace,
} from "../internal/logging";
import { normalizeArkadeRelativeTimelock } from "../internal/timelocks";
import {
  getOnchainProbeUrl,
  inferArkadeNetwork,
  probeUrl,
  type ArkadeDependencyProbe,
} from "../internal/network";
import { arkadeServerConfigService } from "../ArkadeServerConfigService";
import type { BoltzSwap } from "../internal/legacySwapTypes";
import { getArkadeLnurlAssertion, getOrCreateArkadeIdentity } from "../internal/identity";
import { getOrCreateWallet, resetArkadeWalletCacheState } from "../internal/walletCache";
import { getOrCreateLightning, resetArkadeLightningCacheState } from "../internal/lightningCache";
import { stopArkadeIncomingFundsSubscription } from "../internal/subscriptions";
import { formatPendingVtxoDebugLine, formatVtxoDebugLine } from "../internal/vtxoFormat";
import { createArkadeServerSwapIntent } from "../internal/swapIntents";
import {
  assertArkadeRecoveryCsvCompatible,
  inspectArkadeRecoveryCsvStatus,
} from "../internal/recovery";
import {
  clearArkadeOutgoingBrowserApprovalInFlight,
  withOutgoingBrowserApproval,
} from "../internal/browserApproval";
import {
  assertInvoicePrefixForNetwork,
  type ArkadeLightningLimits,
} from "../internal/lightningHelpers";
import {
  getArkadeContractDiagnosticsSummary,
  type ArkadeContractDiagnostic,
  type ArkadeContractDiagnosticsSummary,
} from "../internal/diagnostics";
import {
  getCachedStableParamsSnapshot,
  persistArkadeStableParams,
  readCachedStableParams,
  resetCachedStableParams,
  type ArkadeStableParams,
} from "../internal/persistence";
import {
  buildRecoveryContractSummary,
  formatRelativeTimelockForUi,
  getArkadeClientRecoveryContractParams,
  scriptHashForLog,
} from "../internal/recoveryDefaults";
import {
  getArkadeSwapRepository,
  resetArkadeStorageAdapterCache,
} from "../internal/storageAdapter";
import { arkadeErrorText } from "../internal/walletPatches";
import {
  attachOutgoingPaySwap,
  createTraceOpId,
  emitOutgoingPayWalletSnapshot,
  formatOutgoingPayTraceDetail,
  isDuplicateOffchainClaimError,
  preimageHashStatus,
  registerOutgoingPayTrace,
  safePaymentHashFromInvoice,
} from "../internal/payTrace";
import type {
  ArkadeDebugBalance,
  ArkadeOutgoingPayTrace,
  ArkadeRecoveryCsvStatus,
  ArkadeWalletDebugTrace,
} from "../internal/types";
export {
  ARKADE_CHAIN_SWAP_CLAIM_TIMEOUT_MS,
  ARKADE_LN_CREATE_TIMEOUT_MS,
  ARKADE_NODE_INFO_TIMEOUT_MS,
  assertArkadeRecoveryCsvCompatible,
  assertInvoicePrefixForNetwork,
  attachOutgoingPaySwap,
  createArkadeServerSwapIntent,
  createTraceOpId,
  emitOutgoingPayWalletSnapshot,
  emitTrace,
  formatOutgoingPayTraceDetail,
  formatPendingVtxoDebugLine,
  formatVtxoDebugLine,
  getArkadeContractDiagnosticsSummary,
  getArkadeLnurlAssertion,
  getOrCreateArkadeIdentity,
  getOrCreateArkadeIdentity as getOrCreateDebugIdentity,
  getOrCreateLightning,
  getOrCreateWallet,
  hexToBytesLocal,
  inferArkadeNetwork,
  inspectArkadeRecoveryCsvStatus,
  isDuplicateOffchainClaimError,
  isZeroArkadeWalletSummary,
  logArkadeWalletErrorTrace,
  logArkadeWalletSignTrace,
  normalizeArkadeRelativeTimelock,
  persistArkadeStableParams,
  preimageHashStatus,
  probeUrl,
  registerOutgoingPayTrace,
  safePaymentHashFromInvoice,
  subscribeArkadeWalletDebugTrace,
  truncateForLog,
  withOutgoingBrowserApproval,
  withTimeout,
};
export type {
  ArkadeContractDiagnostic,
  ArkadeContractDiagnosticsSummary,
  ArkadeDebugBalance,
  ArkadeDependencyProbe,
  ArkadeLightningLimits,
  ArkadeOutgoingPayTrace,
  ArkadeRecoveryCsvStatus,
  ArkadeWalletDebugTrace,
};

export type { ArkadeWalletSummary } from "../types/wallet";

// ArkadeContractDiagnostic and ArkadeContractDiagnosticsSummary re-exported from ./internal/diagnostics at top of file.

// ArkadeInvalidContractDeleteSummary moved alongside deleteInvalidArkadeRecoveryContracts in ./internal/recoveryDefaults.

export type { ArkadeWalletSummaryOptions } from "../types/wallet";

// ArkadeDebugBalance is re-exported from ./internal/types via the top of this file.

export type { ArkadeRecoveryBackupSummary };
export type { ArkadeClientRecoveryProof };

export type ArkadeIdentityReadinessSummary = ArkadeIdentityReadiness & {
  status: "ready" | "soft_mode_ready" | "hard_mode_ready" | "missing";
  updatedAtMs: number;
  detail: string;
  actualRecoveryProofStatus: ArkadeExitDebugSummary["recoveryProofInvariantStatus"];
  actualRecoveryProofDetail: string;
};

export type ArkadeRecoveryBackupCompletenessSummary = {
  status: "ready" | "soft_mode_ready" | "hard_mode_ready" | "missing";
  updatedAtMs: number;
  detail: string;
  hardModeComplete: boolean;
  serverLossRecoveryComplete: boolean;
  softModeActive: boolean;
  passkeyPubkeyRequired: boolean;
  passkeyPubkeyPresent: boolean;
  hasPublicRecoveryMetadata: boolean;
  hasArkadeStorage: boolean;
  storageItemCount: number;
  nuriServerCsv: ArkadeRelativeTimelock | null;
  nuriServerCsvLabel: string;
  passkeyPubkeyPolicy: string;
  ciphertextSize: number;
  plaintextHash: string;
  matchesCurrentStorage: boolean | null;
  actualRecoveryProofStatus: ArkadeExitDebugSummary["recoveryProofInvariantStatus"];
  actualRecoveryProofDetail: string;
  hardModeMissing: string[];
  serverLossRecoveryMissing: string[];
};

export type ArkadeRecoveryContractSummary = {
  status: "ready" | "missing_passkey_pubkey" | "missing_csv" | "missing_recovery_policy";
  serverVersion: string;
  tokenKeyFingerprint: string;
  clientPk33: string;
  serverPk33: string;
  aggregatedPk33: string;
  derivationVersion: string;
  accountFingerprint: string;
  nuriServerCsv: ArkadeRelativeTimelock | null;
  nuriServerCsvLabel: string;
  recoveryType: string;
  cooperativePath: string;
  recoveryPath: string;
  serverKeyExpires: boolean;
  passkeyPubkeyPolicy: string;
  passkeyPubkeyPresent: boolean;
  passkeyPubkeyFingerprint: string;
  registered: boolean;
  identityId: string;
  backupPresent: boolean;
  backupCiphertextSize: number;
  backupUpdatedAtMs: number;
  recoveryBackupFormat: string;
};

// ArkadeLightningLimits, ArkadeWalletDebugTrace, ArkadeOutgoingPayTrace, ArkadeDependencyProbe
// re-exported from ./internal/* at top of file.

export type { ArkadeLightningClaimSummary };

export type ArkadeWalletTestResult = {
  summary: ArkadeWalletSummary;
  /** `limits` removed with Boltz: it reported the shut-down swap service's bounds. */
  probes: ArkadeDependencyProbe[];
  claims: ArkadeLightningClaimSummary;
};

export type ArkadeVtxoContractMode = typeof ARKADE_CLIENT_RECOVERY_CONTRACT_TYPE;

export type ArkadeExitDebugSummary = {
  status:
    | "no_vtxos"
    | "needs_anchor_funds"
    | "needs_unroll"
    | "waiting_confirmation"
    | "proof_mismatch"
    | "ready_to_complete";
  anchorAddress: string;
  anchorBalanceSats: string;
  totalVtxos: number;
  unrolledVtxos: number;
  pendingUnrollVtxos: number;
  selectedTxid: string;
  selectedVout: number;
  selectedValueSats: string;
  lastStep: string;
  lastTxid: string;
  completedTxid: string;
  outputAddress: string;
  vtxoContractMode: ArkadeVtxoContractMode;
  actualUnrollContractMode: string;
  csvSignerStatus: string;
  csvSignerDetail: string;
  actualUnrollAddress: string;
  actualUnrollScriptPubKey: string;
  actualUnrollCsvTimelock: string;
  actualUnrollCsvSequence: string;
  actualUnrollClientKeyMatch: boolean;
  actualUnrollAggregateKeyMatch: boolean;
  recoveryProofAddress: string;
  recoveryProofScriptPubKey: string;
  recoveryProofCsvSequence: string;
  recoveryProofInvariantStatus: "pass" | "fail" | "not_checked";
  recoveryProofInvariantDetail: string;
  detail: string;
  updatedAtMs: number;
};

export type ArkadeRecoverabilityAuditSummary = {
  status: "pass" | "fail";
  stage:
    | "no_funds"
    | "boarding_only"
    | "ready_to_unroll"
    | "waiting_unroll"
    | "waiting_csv"
    | "spend_ready"
    | "proof_failed"
    | "metadata_failed";
  failures: string[];
  recoveryStatus: ArkadeRecoveryContractSummary["status"];
  identityStatus: ArkadeIdentityReadinessSummary["status"];
  exitStatus: ArkadeExitDebugSummary["status"];
  totalSats: string;
  boardingConfirmedSats: string;
  boardingUnconfirmedSats: string;
  boardingTotalSats: string;
  availableSats: string;
  settledSats: string;
  preconfirmedSats: string;
  recoverableSats: string;
  walletVtxoCount: number;
  walletVtxoSettledCount: number;
  walletVtxoPreconfirmedCount: number;
  walletVtxoRecoverableCount: number;
  walletVtxoTotalSats: string;
  walletVtxoDetails: string[];
  proofAddress: string;
  proofScriptPubKey: string;
  proofCsvSequence: number;
  anchorAddress: string;
  anchorBalanceSats: string;
  actualUnrollAddress: string;
  actualUnrollScriptPubKey: string;
  actualUnrollContractMode: string;
  actualUnrollClientKeyMatch: boolean;
  actualUnrollAggregateKeyMatch: boolean;
  recoveryProofInvariantStatus: ArkadeExitDebugSummary["recoveryProofInvariantStatus"];
  recoveryProofInvariantDetail: string;
  totalVtxos: number;
  pendingUnrollVtxos: number;
  unrolledVtxos: number;
  proof: ArkadeClientRecoveryProof;
  logLine: string;
  updatedAtMs: number;
};

export type ArkadeRecoveryBoardingSettleSummary = {
  status: "pending" | "skipped" | "swept";
  reason: string;
  sweepId: string;
  before: ArkadeWalletSummary;
  after: ArkadeWalletSummary;
  logLine: string;
  updatedAtMs: number;
};

export type { ArkadeLnurlStatus, ArkadePendingLnurlSwap } from "../types/lnurl";

export type { ArkadeReceiveStageStatus, ArkadeReceiveStageSnapshot } from "../types/receive";

// Debug-tier alias for the cached wallet. The real type is ArkadeWallet in
// ./internal/types — used throughout the internal/* helpers. Debug code
// reaches into a couple of private SDK fields (cachedExitDebugSummary
// contract anchor inspection, etc.) where strict types would block
// experimentation, so the alias keeps that work readable here.
import type { ArkadeWallet } from "../internal/types";

type ArkadeWalletLike = ArkadeWallet;
// ArkToBtcClaimResult moved to ./internal/lightningHelpers.
// Wallet/lightning/identity cache state + their init impls live in
// ./internal/walletCache and ./internal/lightningCache. Recovery default
// helpers, storage adapter, debug patches, subscriptions, and stable params
// persistence live alongside them in ./internal/.

let cachedIdentityReadinessSummary: ArkadeIdentityReadinessSummary | null = null;
let cachedRecoveryContractSummary: ArkadeRecoveryContractSummary | null = null;
let cachedRecoveryBackupSummary: ArkadeRecoveryBackupSummary | null = null;
let cachedRecoveryBackupCompletenessSummary: ArkadeRecoveryBackupCompletenessSummary | null = null;
let cachedExitDebugSummary: ArkadeExitDebugSummary | null = null;
let cachedVerifiedArkadeClientRecoveryProof: ArkadeClientRecoveryProof | null = null;
let cachedVerifiedArkadeClientRecoveryProofSource = "";
const arkadeVtxoContractMode: ArkadeVtxoContractMode = ARKADE_CLIENT_RECOVERY_CONTRACT_TYPE;
// outgoingPayOpsByHash / outgoingPayOpsBySwapId moved into ./internal/payTrace.
// arkToBtcClaimInFlightById moved into ./internal/lightningHelpers.
// Receive-flow scheduler state (in-flight handles, throttle stamps, active
// retry queues, foreground monitor, boarding sweep failure cache) lives in
// ./internal/receiveAutoClaim and ./internal/receiveAutoSweep.
// Stable-params cache + readers live in ./internal/persistence.
let recoveryBoardingSweepInFlight: Promise<string> | null = null;
let recoveryBoardingSweepStartedAtMs = 0;

function getCachedActualRecoveryProofTruth(): {
  pass: boolean;
  status: ArkadeExitDebugSummary["recoveryProofInvariantStatus"];
  detail: string;
} {
  const status = cachedExitDebugSummary?.recoveryProofInvariantStatus || "not_checked";
  const pass = status === "pass" && Boolean(cachedVerifiedArkadeClientRecoveryProof);
  return {
    pass,
    status: pass ? "pass" : status,
    detail:
      cachedExitDebugSummary?.recoveryProofInvariantDetail ||
      (cachedVerifiedArkadeClientRecoveryProof ? "verified_proof_cache_available" : "not_checked"),
  };
}

setArkadeActualRecoveryProofReadinessProvider(getCachedActualRecoveryProofTruth);
setArkadeRecoveryBackupProofReadinessProvider(getCachedActualRecoveryProofTruth);

// Wallet/lightning init constants + node-info retry constants live alongside
// the bootstrap code in ./internal/walletCache, ./internal/lightningCache,
// and ./internal/network. PrefetchedExpoArkProvider + the batch/provider
// trace patches live in ./internal/walletPatches.
const ARKADE_RECOVERY_SWEEP_HANDOFF_MS = 120_000;

// emitTrace re-exported from ./internal/logging at top of file.

// Pending LNURL swap helpers, receive-stage state machine, and the maintenance
// identity helper now live in ./internal/pendingLnurlSwaps,
// ./ArkadeReceiveOrchestrator, and ./internal/receiveAutoClaim respectively.

// compactArkadeErrorText moved into ./internal/utils.truncateForLog at top of file.

// truncateForLog, logArkadeWalletSignTrace, logArkadeWalletErrorTrace
// re-exported from ./internal/utils and ./internal/logging at top of file.

logArkadeWalletSignTrace("module_loaded", {
  file: "services/arkade/ArkadeWalletDebugService.ts",
  expected_next: "debug_send_button_calls_send_function",
});

// compactArkadeLogValue + stringifyArkadeErrorData live in ./internal/utils.
// formatVtxoDebugLine, formatPendingVtxoDebugLine moved to ./internal/vtxoFormat.

// summarizeBoardingCoins, getBoardingSelectionSnapshot, extractBoardingFailureTxid
// moved to ./internal/receiveAutoSweep alongside the sweep flow.
// summarizeArkadeError lives in ./internal/walletPatches.

// setBoardingSweepFailure moved to ./internal/boardingSweepFailure.

// isZeroArkadeWalletSummary, hexToBytesLocal — from ./internal/utils
// createTraceOpId, safePaymentHashFromInvoice, formatOutgoingPayTraceDetail,
// registerOutgoingPayTrace, emitOutgoingPayWalletSnapshot, attachOutgoingPaySwap,
// matchOutgoingPayTraceForSwap, preimageHashStatus, isDuplicateOffchainClaimError — from ./internal/payTrace
// createArkadeServerSwapIntent — from ./internal/swapIntents
// All re-exported at the top of this file.

export {
  formatArkadeLightningPayError,
  isArkadeLightningReusedInvoiceError,
} from "../ArkadeLightningSendService";

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// withTimeout moved to ./internal/utils.

function decodeRawArkadeTransaction(txHex: string): any {
  const bytes = hexToBytesLocal(txHex);
  if (bytes.length <= 0) {
    throw new Error("raw transaction hex invalid");
  }
  return (Transaction as any).fromRaw(bytes);
}

async function getOnchainTxVisibility(onchainProvider: any, txid: string): Promise<string> {
  try {
    const status = await onchainProvider.getTxStatus(txid);
    return status?.confirmed ? `confirmed:${status.blockHeight || "unknown"}` : "mempool";
  } catch (error) {
    return `missing:${arkadeErrorText(error, 160)}`;
  }
}

// getArkToBtcMinimumReceiveSats, claimArkToBtcSwapWithPolling, findBitcoinOutputTxid
// moved to ./internal/lightningHelpers.

export async function probeArkadeDependencies(): Promise<ArkadeDependencyProbe[]> {
  const nodeUrl = arkadeServerConfigService.getArkadeNodeUrl().replace(/\/+$/, "");
  const network = inferArkadeNetwork(nodeUrl);
  const onchainUrl = getOnchainProbeUrl(network);

  // No Boltz probe: the engine is retired and the endpoint would only report a
  // dead dependency as a red line in the lab.
  const jobs: Array<Promise<ArkadeDependencyProbe>> = [probeUrl("node", `${nodeUrl}/v1/info`)];
  if (onchainUrl) {
    jobs.push(probeUrl("onchain", onchainUrl));
  }
  return Promise.all(jobs);
}

// subscribeArkadeWalletDebugTrace re-exported from ./internal/logging at top of file.
// Wallet bootstrap (init impl + cached state) lives in ./internal/walletCache.
// Identity helpers live in ./internal/identity.

function cacheIdentityReadinessSummary(
  readiness: ArkadeIdentityReadiness,
): ArkadeIdentityReadinessSummary {
  const proofTruth = getCachedActualRecoveryProofTruth();
  const serverLossRecoveryMissing = [...readiness.serverLossRecoveryMissing];
  if (!proofTruth.pass && !serverLossRecoveryMissing.includes("actual_recovery_proof")) {
    serverLossRecoveryMissing.push("actual_recovery_proof");
  }
  const missing = [...readiness.missing];
  if (!proofTruth.pass && !missing.includes("actual_recovery_proof")) {
    missing.push("actual_recovery_proof");
  }
  const readyForServerLossRecovery = readiness.readyForServerLossRecovery && proofTruth.pass;
  const status: ArkadeIdentityReadinessSummary["status"] =
    readyForServerLossRecovery && readiness.readyForHardMode
      ? "ready"
      : readyForServerLossRecovery && readiness.softModeActive
        ? "soft_mode_ready"
        : readiness.readyForHardMode
          ? "hard_mode_ready"
          : "missing";
  const detail =
    `hard=${readiness.readyForHardMode ? 1 : 0} recovery=${readyForServerLossRecovery ? 1 : 0} ` +
    `proof=${proofTruth.status} ` +
    `soft=${readiness.softModeActive ? 1 : 0} nuriServerCsv=${formatRelativeTimelockForUi(readiness.nuriServerCsv)} ` +
    `policy=${readiness.passkeyPubkeyPolicy || "n/a"} hardMissing=${readiness.hardModeMissing.join(",") || "none"} ` +
    `recoveryMissing=${serverLossRecoveryMissing.join(",") || "none"}`;
  const summary: ArkadeIdentityReadinessSummary = {
    ...readiness,
    readyForServerLossRecovery,
    status,
    updatedAtMs: Date.now(),
    detail,
    actualRecoveryProofStatus: proofTruth.status,
    actualRecoveryProofDetail: proofTruth.detail,
    missing,
    hardModeMissing: [...readiness.hardModeMissing],
    serverLossRecoveryMissing,
  };
  cachedIdentityReadinessSummary = {
    ...summary,
    missing: [...summary.missing],
    hardModeMissing: [...summary.hardModeMissing],
    serverLossRecoveryMissing: [...summary.serverLossRecoveryMissing],
  };
  emitTrace({
    atMs: summary.updatedAtMs,
    op: "identity_readiness",
    status,
    detail,
  });
  return {
    ...summary,
    missing: [...summary.missing],
    hardModeMissing: [...summary.hardModeMissing],
    serverLossRecoveryMissing: [...summary.serverLossRecoveryMissing],
  };
}

export function getArkadeIdentityReadinessSummarySnapshot(): ArkadeIdentityReadinessSummary | null {
  return cachedIdentityReadinessSummary
    ? {
        ...cachedIdentityReadinessSummary,
        missing: [...cachedIdentityReadinessSummary.missing],
        hardModeMissing: [...cachedIdentityReadinessSummary.hardModeMissing],
        serverLossRecoveryMissing: [...cachedIdentityReadinessSummary.serverLossRecoveryMissing],
      }
    : null;
}

export async function getArkadeIdentityReadinessSummary(): Promise<ArkadeIdentityReadinessSummary> {
  const identity = await getOrCreateArkadeIdentity();
  const readiness = await identity.getIdentityReadinessSnapshot();
  return cacheIdentityReadinessSummary(readiness);
}

export function getArkadeRecoveryContractSummarySnapshot(): ArkadeRecoveryContractSummary | null {
  return cachedRecoveryContractSummary ? { ...cachedRecoveryContractSummary } : null;
}

export function getArkadeRecoveryBackupSummarySnapshot(): ArkadeRecoveryBackupSummary | null {
  return cachedRecoveryBackupSummary ? { ...cachedRecoveryBackupSummary } : null;
}

function cloneRecoveryBackupCompletenessSummary(
  summary: ArkadeRecoveryBackupCompletenessSummary,
): ArkadeRecoveryBackupCompletenessSummary {
  return {
    ...summary,
    hardModeMissing: [...summary.hardModeMissing],
    serverLossRecoveryMissing: [...summary.serverLossRecoveryMissing],
  };
}

export function getArkadeRecoveryBackupCompletenessSummarySnapshot(): ArkadeRecoveryBackupCompletenessSummary | null {
  return cachedRecoveryBackupCompletenessSummary
    ? cloneRecoveryBackupCompletenessSummary(cachedRecoveryBackupCompletenessSummary)
    : null;
}

export async function getArkadeRecoveryContractSummary(): Promise<ArkadeRecoveryContractSummary> {
  const identity = await getOrCreateArkadeIdentity();
  const pubCtx = await identity.getSigningPublicContext();
  const summary = buildRecoveryContractSummary(pubCtx);
  cachedRecoveryContractSummary = { ...summary };
  emitTrace({
    atMs: Date.now(),
    op: "recovery_contract",
    status: summary.status === "ready" ? "ok" : "warning",
    detail:
      `server=${summary.serverVersion || "n/a"} nuriServerCsv=${summary.nuriServerCsvLabel || "n/a"} ` +
      `policy=${summary.passkeyPubkeyPolicy || "n/a"} passkeyPub=${summary.passkeyPubkeyPresent ? 1 : 0} ` +
      `registered=${summary.registered ? 1 : 0} backup=${summary.backupPresent ? 1 : 0}`,
  });
  return summary;
}

async function buildExpectedArkadeClientRecoveryProof(
  wallet: ArkadeWalletLike,
): Promise<ArkadeClientRecoveryProof> {
  const params = await getArkadeClientRecoveryContractParams(
    wallet as unknown as Parameters<typeof getArkadeClientRecoveryContractParams>[0],
  );
  return buildArkadeClientRecoveryProof({
    ...params,
    network: String((wallet as any)?.networkName || "mainnet"),
  });
}

export async function getArkadeClientRecoveryProof(): Promise<ArkadeClientRecoveryProof> {
  if (!cachedVerifiedArkadeClientRecoveryProof) {
    const summary = await getArkadeExitDebugSummary();
    if (
      summary.recoveryProofInvariantStatus !== "pass" ||
      !cachedVerifiedArkadeClientRecoveryProof
    ) {
      throw new Error(
        `arkade client recovery proof not verified by vtxo tapTree ${summary.recoveryProofInvariantDetail}`,
      );
    }
  }
  const proof = cachedVerifiedArkadeClientRecoveryProof;
  if (!proof) {
    throw new Error("arkade client recovery proof cache unavailable after verification");
  }
  emitTrace({
    atMs: Date.now(),
    op: "recovery_proof_verified",
    status: "ok",
    detail:
      `mode=${arkadeVtxoContractMode} source=${cachedVerifiedArkadeClientRecoveryProofSource || "tapTree"} ` +
      `address=${truncateForLog(proof.address, 28)} csvSequence=${proof.csvSequence || "n/a"} ` +
      `script_hash=${scriptHashForLog(proof.scriptPubKeyHex)} merkle_root=${scriptHashForLog(proof.tapMerkleRootHex) || "n/a"}`,
  });
  return proof;
}

export async function runArkadeRecoverabilityAudit(): Promise<ArkadeRecoverabilityAuditSummary> {
  const recovery = await getArkadeRecoveryContractSummary();
  const walletSummary = await loadArkadeWalletSummary({
    scheduleAutoClaim: false,
    scheduleAutoSettle: false,
  });
  const exit = await getArkadeExitDebugSummary();
  const identity = await getArkadeIdentityReadinessSummary();
  const wallet = await getOrCreateWallet();
  const proof =
    cachedVerifiedArkadeClientRecoveryProof ||
    (await buildExpectedArkadeClientRecoveryProof(wallet));
  const failures: string[] = [];
  const totalSats = Math.max(0, Number(walletSummary.balanceTotalSats || "0") || 0);
  const boardingTotalSats = Math.max(0, Number(walletSummary.balanceBoardingTotalSats || "0") || 0);
  const availableSats = Math.max(0, Number(walletSummary.balanceAvailableSats || "0") || 0);
  const identityRecoveryMetadataReady = identity.serverLossRecoveryMissing.every(
    (item) => item === "actual_recovery_proof",
  );
  const recoveryReady =
    recovery.status === "ready" ||
    (recovery.status === "missing_passkey_pubkey" && identityRecoveryMetadataReady);

  if (!recoveryReady) {
    failures.push(`recovery=${recovery.status}`);
  }
  if (!identityRecoveryMetadataReady) {
    failures.push(`identity=${identity.status}`);
  }
  if (!Number.isInteger(proof.csvSequence) || proof.csvSequence <= 0) {
    failures.push("csv=invalid");
  }
  if (exit.totalVtxos <= 0) {
    failures.push("vtxos=0");
  }
  if (exit.recoveryProofInvariantStatus !== "pass") {
    failures.push(`proof=${exit.recoveryProofInvariantStatus}`);
  }
  if (exit.actualUnrollContractMode !== "nuri_server_decay_recovery") {
    failures.push(`contract=${exit.actualUnrollContractMode}`);
  }
  if (!exit.actualUnrollClientKeyMatch) {
    failures.push("client_leaf=0");
  }
  if (!exit.actualUnrollAggregateKeyMatch) {
    failures.push("aggregate_leaf=0");
  }
  const metadataFailed =
    failures.some((failure) => failure.startsWith("recovery=")) ||
    failures.some((failure) => failure.startsWith("identity=")) ||
    failures.includes("csv=invalid");
  const proofFailed =
    !metadataFailed &&
    (failures.some((failure) => failure.startsWith("proof=")) ||
      failures.some((failure) => failure.startsWith("contract=")) ||
      failures.includes("client_leaf=0") ||
      failures.includes("aggregate_leaf=0"));
  const boardingOnly = walletSummary.debugVtxoCount <= 0 && boardingTotalSats > 0;
  const stage: ArkadeRecoverabilityAuditSummary["stage"] = metadataFailed
    ? "metadata_failed"
    : totalSats <= 0
      ? "no_funds"
      : boardingOnly
        ? "boarding_only"
        : proofFailed
          ? "proof_failed"
          : exit.pendingUnrollVtxos > 0
            ? "ready_to_unroll"
            : exit.unrolledVtxos > 0
              ? "waiting_csv"
              : availableSats > 0 && exit.totalVtxos > 0
                ? "waiting_unroll"
                : "proof_failed";

  const status: ArkadeRecoverabilityAuditSummary["status"] = failures.length ? "fail" : "pass";
  const logLine = [
    `verdict=${status}`,
    `stage=${stage}`,
    `recovery=${recovery.status}`,
    `identity=${identity.status}`,
    `exit=${exit.status}`,
    `proof=${exit.recoveryProofInvariantStatus}`,
    `proof_detail=${exit.recoveryProofInvariantDetail || "n/a"}`,
    `contract=${exit.actualUnrollContractMode || "not_checked"}`,
    `client_leaf=${exit.actualUnrollClientKeyMatch ? 1 : 0}`,
    `aggregate_leaf=${exit.actualUnrollAggregateKeyMatch ? 1 : 0}`,
    `csvSequence=${proof.csvSequence}`,
    `total=${walletSummary.balanceTotalSats}`,
    `boarding=${walletSummary.balanceBoardingTotalSats}`,
    `boarding_confirmed=${walletSummary.balanceBoardingConfirmedSats}`,
    `available=${walletSummary.balanceAvailableSats}`,
    `settled=${walletSummary.balanceSettledSats}`,
    `preconfirmed=${walletSummary.balancePreconfirmedSats}`,
    `anchor=${exit.anchorAddress || "n/a"}`,
    `anchor_sats=${exit.anchorBalanceSats || "0"}`,
    `wallet_vtxos=${walletSummary.debugVtxoCount}`,
    `wallet_vtxo_total=${walletSummary.debugVtxoTotalSats}`,
    `vtxos=${exit.totalVtxos}`,
    `pending=${exit.pendingUnrollVtxos}`,
    `unrolled=${exit.unrolledVtxos}`,
    `actual=${truncateForLog(exit.actualUnrollAddress, 28) || "n/a"}`,
    `proof_addr=${truncateForLog(proof.address, 28)}`,
    `failures=${failures.join(",") || "none"}`,
    "spend=not_attempted",
  ].join(" ");

  logArkadeWalletSignTrace("arkade_recoverability_audit", {
    verdict: status,
    stage,
    recovery: recovery.status,
    identity: identity.status,
    proof: exit.recoveryProofInvariantStatus,
    proof_detail: exit.recoveryProofInvariantDetail || "n/a",
    contract: exit.actualUnrollContractMode || "not_checked",
    csvSequence: proof.csvSequence,
    total: walletSummary.balanceTotalSats,
    boarding: walletSummary.balanceBoardingTotalSats,
    available: walletSummary.balanceAvailableSats,
    anchor: exit.anchorAddress || "n/a",
    anchor_sats: exit.anchorBalanceSats || "0",
    wallet_vtxos: walletSummary.debugVtxoCount,
    vtxos: exit.totalVtxos,
    pending: exit.pendingUnrollVtxos,
    unrolled: exit.unrolledVtxos,
    failures: failures.join(",") || "none",
    spend: "not_attempted",
    expected_next:
      exit.status === "needs_anchor_funds"
        ? "fund_exit_anchor"
        : status === "pass"
          ? "scan_recovery_utxos"
          : stage === "boarding_only"
            ? "sweep_boarding_to_vtxo"
            : "fix_recoverability_failure",
  });
  emitTrace({
    atMs: Date.now(),
    op: "recoverability_audit",
    status,
    detail: logLine,
  });

  return {
    status,
    stage,
    failures,
    recoveryStatus: recovery.status,
    identityStatus: identity.status,
    exitStatus: exit.status,
    totalSats: walletSummary.balanceTotalSats,
    boardingConfirmedSats: walletSummary.balanceBoardingConfirmedSats,
    boardingUnconfirmedSats: walletSummary.balanceBoardingUnconfirmedSats,
    boardingTotalSats: walletSummary.balanceBoardingTotalSats,
    availableSats: walletSummary.balanceAvailableSats,
    settledSats: walletSummary.balanceSettledSats,
    preconfirmedSats: walletSummary.balancePreconfirmedSats,
    recoverableSats: walletSummary.balanceRecoverableSats,
    walletVtxoCount: walletSummary.debugVtxoCount,
    walletVtxoSettledCount: walletSummary.debugVtxoSettledCount,
    walletVtxoPreconfirmedCount: walletSummary.debugVtxoPreconfirmedCount,
    walletVtxoRecoverableCount: walletSummary.debugVtxoRecoverableCount,
    walletVtxoTotalSats: walletSummary.debugVtxoTotalSats,
    walletVtxoDetails: [...walletSummary.debugVtxoDetails],
    proofAddress: proof.address,
    proofScriptPubKey: proof.scriptPubKeyHex,
    proofCsvSequence: proof.csvSequence,
    anchorAddress: exit.anchorAddress,
    anchorBalanceSats: exit.anchorBalanceSats,
    actualUnrollAddress: exit.actualUnrollAddress,
    actualUnrollScriptPubKey: exit.actualUnrollScriptPubKey,
    actualUnrollContractMode: exit.actualUnrollContractMode,
    actualUnrollClientKeyMatch: exit.actualUnrollClientKeyMatch,
    actualUnrollAggregateKeyMatch: exit.actualUnrollAggregateKeyMatch,
    recoveryProofInvariantStatus: exit.recoveryProofInvariantStatus,
    recoveryProofInvariantDetail: exit.recoveryProofInvariantDetail,
    totalVtxos: exit.totalVtxos,
    pendingUnrollVtxos: exit.pendingUnrollVtxos,
    unrolledVtxos: exit.unrolledVtxos,
    proof,
    logLine,
    updatedAtMs: Date.now(),
  };
}

export async function settleArkadeBoardingForRecoveryAudit(): Promise<ArkadeRecoveryBoardingSettleSummary> {
  const before = await loadArkadeWalletSummary({
    scheduleAutoClaim: false,
    scheduleAutoSettle: false,
  });
  const boardingConfirmedSats = Math.max(0, Number(before.balanceBoardingConfirmedSats || 0));
  const boardingTotalSats = Math.max(0, Number(before.balanceBoardingTotalSats || 0));
  const existingVtxos = Math.max(0, Math.trunc(Number(before.debugVtxoCount || 0)));
  const baseFields = {
    before_boarding_confirmed: before.balanceBoardingConfirmedSats,
    before_boarding_total: before.balanceBoardingTotalSats,
    before_vtxos: before.debugVtxoCount,
  };

  if (existingVtxos > 0) {
    const logLine =
      `status=skipped reason=already_has_vtxo boarding_confirmed=${before.balanceBoardingConfirmedSats} ` +
      `boarding_total=${before.balanceBoardingTotalSats} vtxos=${before.debugVtxoCount}`;
    logArkadeWalletSignTrace("arkade_recovery_boarding_settle", {
      ...baseFields,
      status: "skipped",
      reason: "already_has_vtxo",
      spend: "not_attempted",
      expected_next: "run_taptree_proof_audit",
    });
    return {
      status: "skipped",
      reason: "already_has_vtxo",
      sweepId: "",
      before,
      after: before,
      logLine,
      updatedAtMs: Date.now(),
    };
  }

  if (boardingConfirmedSats <= 0) {
    const reason = boardingTotalSats > 0 ? "boarding_unconfirmed" : "no_boarding_funds";
    const logLine =
      `status=skipped reason=${reason} boarding_confirmed=${before.balanceBoardingConfirmedSats} ` +
      `boarding_total=${before.balanceBoardingTotalSats} vtxos=${before.debugVtxoCount}`;
    logArkadeWalletSignTrace("arkade_recovery_boarding_settle", {
      ...baseFields,
      status: "skipped",
      reason,
      spend: "not_attempted",
      expected_next:
        reason === "boarding_unconfirmed" ? "wait_for_bitcoin_confirmation" : "fund_boarding",
    });
    return {
      status: "skipped",
      reason,
      sweepId: "",
      before,
      after: before,
      logLine,
      updatedAtMs: Date.now(),
    };
  }

  logArkadeWalletSignTrace("arkade_recovery_boarding_settle", {
    ...baseFields,
    status: "attempt",
    spend: "boarding_to_vtxo",
    expected_next: "sweep_confirmed_boarding_then_reaudit",
  });
  let sweepId = "";
  if (!recoveryBoardingSweepInFlight) {
    recoveryBoardingSweepStartedAtMs = Date.now();
    recoveryBoardingSweepInFlight = sweepArkadeBoardingToOffchain()
      .then((id) => {
        logArkadeWalletSignTrace("arkade_recovery_boarding_settle", {
          ...baseFields,
          status: "sweep_completed",
          reason: "background_sweep_finished",
          sweep_id: id || "n/a",
          dur_ms: Date.now() - recoveryBoardingSweepStartedAtMs,
          spend: "boarding_to_vtxo",
          expected_next: "poll_vtxo_indexer_for_taptree",
        });
        return id;
      })
      .catch((error: any) => {
        const message = String(error?.message || error || "unknown");
        logArkadeWalletSignTrace("arkade_recovery_boarding_settle", {
          ...baseFields,
          status: "sweep_failed",
          reason: "background_sweep_failed",
          error: truncateForLog(message, 140),
          dur_ms: Date.now() - recoveryBoardingSweepStartedAtMs,
          spend: "blocked",
          expected_next: "inspect_boarding_sweep_failure",
        });
        throw error;
      })
      .finally(() => {
        recoveryBoardingSweepInFlight = null;
        recoveryBoardingSweepStartedAtMs = 0;
      });
  } else {
    logArkadeWalletSignTrace("arkade_recovery_boarding_settle", {
      ...baseFields,
      status: "pending",
      reason: "sweep_already_in_flight",
      in_flight_ms: Date.now() - recoveryBoardingSweepStartedAtMs,
      spend: "blocked",
      expected_next: "poll_vtxo_indexer_for_taptree",
    });
  }
  const activeRecoveryBoardingSweep = recoveryBoardingSweepInFlight;
  if (!activeRecoveryBoardingSweep) {
    throw new Error("arkade recovery boarding sweep failed to start");
  }
  try {
    sweepId = await withTimeout(
      "arkade_recovery_boarding_sweep_handoff",
      ARKADE_RECOVERY_SWEEP_HANDOFF_MS,
      activeRecoveryBoardingSweep,
    );
  } catch (error: any) {
    const message = String(error?.message || error || "unknown");
    const isTimeout = message.toLowerCase().includes("timeout");
    if (isTimeout) {
      const after = await loadArkadeWalletSummary({
        scheduleAutoClaim: false,
        scheduleAutoSettle: false,
      }).catch(() => before);
      const logLine =
        `status=pending reason=sweep_in_flight before_boarding_confirmed=${before.balanceBoardingConfirmedSats} ` +
        `before_vtxos=${before.debugVtxoCount} after_boarding_confirmed=${after.balanceBoardingConfirmedSats} ` +
        `after_available=${after.balanceAvailableSats} after_preconfirmed=${after.balancePreconfirmedSats} ` +
        `after_vtxos=${after.debugVtxoCount} in_flight_ms=${Date.now() - recoveryBoardingSweepStartedAtMs}`;
      logArkadeWalletSignTrace("arkade_recovery_boarding_settle", {
        ...baseFields,
        status: "pending",
        reason: "sweep_in_flight",
        error: truncateForLog(message, 140),
        after_boarding_confirmed: after.balanceBoardingConfirmedSats,
        after_available: after.balanceAvailableSats,
        after_preconfirmed: after.balancePreconfirmedSats,
        after_vtxos: after.debugVtxoCount,
        in_flight_ms: Date.now() - recoveryBoardingSweepStartedAtMs,
        spend: "blocked",
        expected_next: "poll_vtxo_indexer_for_taptree",
      });
      logArkadeWalletSignTrace("arkade_recovery_boarding_wait", {
        status: "polling",
        reason: "sdk_onboard_in_flight",
        in_flight_ms: Date.now() - recoveryBoardingSweepStartedAtMs,
        after_boarding_confirmed: after.balanceBoardingConfirmedSats,
        after_vtxos: after.debugVtxoCount,
        spend: "blocked",
        expected_next: "post_settle_poll",
      });
      return {
        status: "pending",
        reason: "sweep_in_flight",
        sweepId: "",
        before,
        after,
        logLine,
        updatedAtMs: Date.now(),
      };
    }
    logArkadeWalletSignTrace("arkade_recovery_boarding_settle", {
      ...baseFields,
      status: "failed",
      reason: "sweep_failed",
      error: truncateForLog(message, 140),
      spend: "blocked",
      expected_next: "inspect_boarding_sweep_failure",
    });
    throw error;
  }
  const after = await loadArkadeWalletSummary({
    scheduleAutoClaim: false,
    scheduleAutoSettle: false,
  });
  const afterVtxos = Math.max(0, Math.trunc(Number(after.debugVtxoCount || 0)));
  const afterPreconfirmedSats = Math.max(0, Number(after.balancePreconfirmedSats || 0));
  const afterAvailableSats = Math.max(0, Number(after.balanceAvailableSats || 0));
  if (afterVtxos <= 0 && afterPreconfirmedSats <= 0 && afterAvailableSats <= 0) {
    const logLine =
      `status=failed reason=no_vtxo_after_sweep sweep_id=${sweepId || "n/a"} ` +
      `before_boarding_confirmed=${before.balanceBoardingConfirmedSats} before_vtxos=${before.debugVtxoCount} ` +
      `after_boarding_confirmed=${after.balanceBoardingConfirmedSats} after_available=${after.balanceAvailableSats} ` +
      `after_preconfirmed=${after.balancePreconfirmedSats} after_vtxos=${after.debugVtxoCount}`;
    logArkadeWalletSignTrace("arkade_recovery_boarding_settle", {
      status: "failed",
      reason: "no_vtxo_after_sweep",
      sweep_id: sweepId || "n/a",
      after_boarding_confirmed: after.balanceBoardingConfirmedSats,
      after_available: after.balanceAvailableSats,
      after_preconfirmed: after.balancePreconfirmedSats,
      after_vtxos: after.debugVtxoCount,
      spend: "blocked",
      expected_next: "inspect_boarding_sweep_result",
    });
    throw new Error(logLine);
  }
  const logLine =
    `status=swept reason=boarding_only sweep_id=${sweepId || "n/a"} ` +
    `before_boarding_confirmed=${before.balanceBoardingConfirmedSats} before_vtxos=${before.debugVtxoCount} ` +
    `after_boarding_confirmed=${after.balanceBoardingConfirmedSats} after_available=${after.balanceAvailableSats} ` +
    `after_preconfirmed=${after.balancePreconfirmedSats} after_vtxos=${after.debugVtxoCount}`;
  logArkadeWalletSignTrace("arkade_recovery_boarding_settle", {
    status: "swept",
    reason: "boarding_only",
    sweep_id: sweepId || "n/a",
    after_boarding_confirmed: after.balanceBoardingConfirmedSats,
    after_available: after.balanceAvailableSats,
    after_preconfirmed: after.balancePreconfirmedSats,
    after_vtxos: after.debugVtxoCount,
    spend: "boarding_to_vtxo",
    expected_next: "run_taptree_proof_audit",
  });
  return {
    status: "swept",
    reason: "boarding_only",
    sweepId: sweepId || "",
    before,
    after,
    logLine,
    updatedAtMs: Date.now(),
  };
}

function cacheRecoveryBackupSummary(
  summary: ArkadeRecoveryBackupSummary,
): ArkadeRecoveryBackupSummary {
  const proofTruth = getCachedActualRecoveryProofTruth();
  const serverLossRecoveryMissing = [...summary.serverLossRecoveryMissing];
  if (!proofTruth.pass && !serverLossRecoveryMissing.includes("actual_recovery_proof")) {
    serverLossRecoveryMissing.push("actual_recovery_proof");
  }
  const serverLossRecoveryComplete = summary.serverLossRecoveryComplete && proofTruth.pass;
  const adjustedSummary: ArkadeRecoveryBackupSummary = {
    ...summary,
    serverLossRecoveryComplete,
    serverLossRecoveryMissing,
  };
  cachedRecoveryBackupSummary = { ...adjustedSummary };
  const completenessStatus: ArkadeRecoveryBackupCompletenessSummary["status"] =
    serverLossRecoveryComplete && summary.hardModeComplete
      ? "ready"
      : serverLossRecoveryComplete && summary.softModeActive
        ? "soft_mode_ready"
        : summary.hardModeComplete
          ? "hard_mode_ready"
          : "missing";
  const completenessDetail =
    `hard=${summary.hardModeComplete ? 1 : 0} recovery=${serverLossRecoveryComplete ? 1 : 0} ` +
    `proof=${proofTruth.status} ` +
    `soft=${summary.softModeActive ? 1 : 0} metadata=${summary.hasPublicRecoveryMetadata ? 1 : 0} ` +
    `storage=${summary.hasArkadeStorage ? 1 : 0} items=${summary.storageItemCount} nuriServerCsv=${summary.nuriServerCsvLabel || "n/a"} ` +
    `hardMissing=${summary.hardModeMissing.join(",") || "none"} ` +
    `recoveryMissing=${serverLossRecoveryMissing.join(",") || "none"}`;
  cachedRecoveryBackupCompletenessSummary = {
    status: completenessStatus,
    updatedAtMs: Date.now(),
    detail: completenessDetail,
    hardModeComplete: summary.hardModeComplete,
    serverLossRecoveryComplete,
    softModeActive: summary.softModeActive,
    passkeyPubkeyRequired: summary.passkeyPubkeyRequired,
    passkeyPubkeyPresent: summary.passkeyPubkeyPresent,
    hasPublicRecoveryMetadata: summary.hasPublicRecoveryMetadata,
    hasArkadeStorage: summary.hasArkadeStorage,
    storageItemCount: summary.storageItemCount,
    nuriServerCsv: summary.nuriServerCsv,
    nuriServerCsvLabel: summary.nuriServerCsvLabel,
    passkeyPubkeyPolicy: summary.passkeyPubkeyPolicy,
    ciphertextSize: summary.ciphertextSize,
    plaintextHash: summary.plaintextHash,
    matchesCurrentStorage: summary.matchesCurrentStorage,
    actualRecoveryProofStatus: proofTruth.status,
    actualRecoveryProofDetail: proofTruth.detail,
    hardModeMissing: [...summary.hardModeMissing],
    serverLossRecoveryMissing,
  };
  emitTrace({
    atMs: Date.now(),
    op: "recovery_backup",
    status: summary.status,
    detail:
      `items=${summary.storageItemCount} cipherSize=${summary.ciphertextSize} ` +
      `match=${summary.matchesCurrentStorage === null ? "n/a" : summary.matchesCurrentStorage ? 1 : 0} ` +
      `complete=${serverLossRecoveryComplete ? 1 : 0} proof=${proofTruth.status}`,
  });
  emitTrace({
    atMs: cachedRecoveryBackupCompletenessSummary.updatedAtMs,
    op: "recovery_backup_completeness",
    status: completenessStatus,
    detail: completenessDetail,
  });
  return { ...adjustedSummary, serverLossRecoveryMissing: [...serverLossRecoveryMissing] };
}

export async function uploadArkadeDebugRecoveryBackup(): Promise<ArkadeRecoveryBackupSummary> {
  await getOrCreateWallet();
  const identity = await getOrCreateArkadeIdentity();
  const summary = await uploadArkadeRecoveryBackup(identity);
  await getArkadeRecoveryContractSummary().catch((): null => null);
  return cacheRecoveryBackupSummary(summary);
}

export async function decryptArkadeDebugRecoveryBackup(): Promise<ArkadeRecoveryBackupSummary> {
  const identity = await getOrCreateArkadeIdentity();
  const summary = await decryptArkadeRecoveryBackup(identity);
  await getArkadeRecoveryContractSummary().catch((): null => null);
  return cacheRecoveryBackupSummary(summary);
}

export async function restoreArkadeDebugRecoveryBackup(): Promise<ArkadeRecoveryBackupSummary> {
  const identity = await getOrCreateArkadeIdentity();
  const { summary } = await restoreArkadeRecoveryBackup(identity);
  resetArkadeWalletDebug();
  return cacheRecoveryBackupSummary(summary);
}

function selectExitCandidate(vtxos: any[]): any | null {
  return (
    [...vtxos]
      .filter((vtxo) => !vtxo?.isUnrolled && !vtxo?.isSpent && Number(vtxo?.value || 0) > 0)
      .sort((a, b) => Number(b?.value || 0) - Number(a?.value || 0))[0] || null
  );
}

function selectCompletedExitTxids(vtxos: any[]): string[] {
  return [...vtxos]
    .filter((vtxo) => vtxo?.isUnrolled && !vtxo?.isSpent && Number(vtxo?.value || 0) > 0)
    .map((vtxo) => String(vtxo?.txid || "").trim())
    .filter(Boolean);
}

type ArkadeExitSignerPreflight = {
  status: "no_vtxos" | "client_only_ready" | "aggregate_required" | "ambiguous" | "unknown";
  detail: string;
  signer: "client" | "aggregate" | "unknown";
};

type ArkadeActualUnrollAddressProbe = {
  actualUnrollContractMode: string;
  actualUnrollAddress: string;
  actualUnrollScriptPubKey: string;
  actualUnrollCsvTimelock: string;
  actualUnrollCsvSequence: string;
  actualUnrollClientKeyMatch: boolean;
  actualUnrollAggregateKeyMatch: boolean;
  recoveryProofAddress: string;
  recoveryProofScriptPubKey: string;
  recoveryProofCsvSequence: string;
  recoveryProofInvariantStatus: "pass" | "fail" | "not_checked";
  recoveryProofInvariantDetail: string;
  detail: string;
};

function proofNetworkFromWallet(wallet: ArkadeWalletLike): ArkadeClientRecoveryProof["network"] {
  const networkName = String((wallet as any)?.networkName || "mainnet");
  if (networkName === "testnet") return "testnet";
  if (networkName === "regtest") return "regtest";
  return "main";
}

function cacheVerifiedArkadeClientRecoveryProof(
  proof: ArkadeClientRecoveryProof,
  source: string,
): void {
  cachedVerifiedArkadeClientRecoveryProof = proof;
  cachedVerifiedArkadeClientRecoveryProofSource = source;
  logArkadeWalletSignTrace("arkade_recovery_verified_proof_cached", {
    source,
    address: truncateForLog(proof.address, 28),
    csvSequence: proof.csvSequence,
    script_hash: scriptHashForLog(proof.scriptPubKeyHex),
    merkle_root: scriptHashForLog(proof.tapMerkleRootHex) || "n/a",
    spend: "allowed_after_csv",
    expected_next: "scan_verified_l1_output",
  });
}

function clearVerifiedArkadeClientRecoveryProof(reason: string): void {
  if (!cachedVerifiedArkadeClientRecoveryProof) return;
  logArkadeWalletSignTrace("arkade_recovery_verified_proof_cleared", {
    reason,
    spend: "blocked",
    expected_next: "recheck_vtxo_taptree",
  });
  cachedVerifiedArkadeClientRecoveryProof = null;
  cachedVerifiedArkadeClientRecoveryProofSource = "";
}

function xOnlyFromCompressedPk33(pk33: string): string {
  const normalized = String(pk33 || "")
    .trim()
    .toLowerCase();
  return /^[0-9a-f]{66}$/.test(normalized) ? normalized.slice(2) : "";
}

function scriptIncludesXOnly(script: Uint8Array | undefined, xonlyHex: string): boolean {
  if (!(script instanceof Uint8Array)) return false;
  const normalized = String(xonlyHex || "")
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) return false;
  return bytesToHex(script).toLowerCase().includes(normalized);
}

function emptyActualUnrollAddressProbe(detail = ""): ArkadeActualUnrollAddressProbe {
  return {
    actualUnrollContractMode: "unknown",
    actualUnrollAddress: "",
    actualUnrollScriptPubKey: "",
    actualUnrollCsvTimelock: "",
    actualUnrollCsvSequence: "",
    actualUnrollClientKeyMatch: false,
    actualUnrollAggregateKeyMatch: false,
    recoveryProofAddress: "",
    recoveryProofScriptPubKey: "",
    recoveryProofCsvSequence: "",
    recoveryProofInvariantStatus: "not_checked",
    recoveryProofInvariantDetail: detail || "not_checked",
    detail,
  };
}

async function inspectActualArkadeUnrollAddress(
  wallet: ArkadeWalletLike,
  vtxos: any[],
): Promise<ArkadeActualUnrollAddressProbe> {
  const candidate = selectExitCandidate(vtxos) || (Array.isArray(vtxos) ? vtxos[0] : null);
  if (!candidate?.tapTree) {
    clearVerifiedArkadeClientRecoveryProof("no_vtxo_taptree");
    return emptyActualUnrollAddressProbe("no vtxo tapTree available");
  }

  try {
    const contractParams = await getArkadeClientRecoveryContractParams(
      wallet as unknown as Parameters<typeof getArkadeClientRecoveryContractParams>[0],
    );
    const verification = verifyArkadeServerDecayVtxoPolicy({
      tapTree: candidate.tapTree,
      params: contractParams,
      network: (wallet as any).network,
      proofNetwork: proofNetworkFromWallet(wallet),
    });
    const actualProof = verification.clientProof as ArkadeClientRecoveryProof | null;
    const actualUnrollContractMode = verification.contractMode;
    const actualUnrollAddress = verification.address;
    const actualUnrollScriptPubKey = verification.scriptPubKeyHex;
    const actualUnrollCsvTimelock = verification.clientRecoveryCsvLabel;
    const actualUnrollCsvSequence = verification.clientRecoveryCsvSequence;
    const actualUnrollClientKeyMatch = verification.clientRecoveryPathMatch;
    const actualUnrollAggregateKeyMatch = verification.aggregateRecoveryPathMatch;
    const recoveryProofInvariantStatus = verification.pass ? "pass" : "fail";
    const recoveryProofInvariantDetail = verification.pass
      ? "decoded_taptree_matches_nuri_server_decay_policy"
      : verification.failures.join(",");
    const detail = [
      `contract=${actualUnrollContractMode}`,
      `proof=${recoveryProofInvariantStatus}`,
      `actual=${truncateForLog(actualUnrollAddress, 24) || "n/a"}`,
      `proof_addr=${truncateForLog(actualProof?.address || actualUnrollAddress, 24) || "n/a"}`,
      `client_leaf=${actualUnrollClientKeyMatch ? 1 : 0}`,
      `aggregate_leaf=${actualUnrollAggregateKeyMatch ? 1 : 0}`,
      `arkade_path=${verification.arkadePathMatch ? 1 : 0}`,
      `unsafe_client_leaf=${verification.unsafeClientOnlyBeforeNuriServerCsv ? 1 : 0}`,
      `nuri_server_direct=${verification.directNuriServerKeyInLeaf ? 1 : 0}`,
      `arkade_csv=${verification.arkadeCsvLabel}`,
      `nuri_server_csv=${verification.nuriServerCsvLabel}`,
      `client_csv=${verification.clientRecoveryCsvLabel}`,
      `script_hash=${scriptHashForLog(actualUnrollScriptPubKey)}`,
      `merkle_root=${scriptHashForLog(actualProof?.tapMerkleRootHex || "") || "n/a"}`,
      verification.detail,
    ].join(" ");
    if (recoveryProofInvariantStatus === "pass" && actualProof) {
      const sourceTxid = String(candidate?.txid || "").trim();
      const sourceVout = Math.max(0, Math.trunc(Number(candidate?.vout || 0)));
      cacheVerifiedArkadeClientRecoveryProof(
        actualProof,
        `${truncateForLog(sourceTxid, 18)}:${sourceVout}:${scriptHashForLog(actualUnrollScriptPubKey)}`,
      );
    } else {
      clearVerifiedArkadeClientRecoveryProof(recoveryProofInvariantDetail);
    }
    return {
      actualUnrollContractMode,
      actualUnrollAddress,
      actualUnrollScriptPubKey,
      actualUnrollCsvTimelock,
      actualUnrollCsvSequence,
      actualUnrollClientKeyMatch,
      actualUnrollAggregateKeyMatch,
      recoveryProofAddress: actualProof?.address || actualUnrollAddress,
      recoveryProofScriptPubKey: actualProof?.scriptPubKeyHex || actualUnrollScriptPubKey,
      recoveryProofCsvSequence: actualUnrollCsvSequence,
      recoveryProofInvariantStatus,
      recoveryProofInvariantDetail,
      detail,
    };
  } catch (error: any) {
    clearVerifiedArkadeClientRecoveryProof("inspect_failed");
    return emptyActualUnrollAddressProbe(
      `actual_unroll_inspect_failed ${truncateForLog(String(error?.message || error || "unknown"), 160)}`,
    );
  }
}

async function inspectArkadeExitSigner(
  wallet: ArkadeWalletLike,
  vtxos: any[],
): Promise<ArkadeExitSignerPreflight> {
  const candidate = selectExitCandidate(vtxos) || (Array.isArray(vtxos) ? vtxos[0] : null);
  if (!candidate) {
    return {
      status: "no_vtxos",
      signer: "unknown",
      detail: "no vtxos available for signer inspection",
    };
  }

  const pubCtx = await (wallet.identity as ArkadeRemoteIdentity).getSigningPublicContext();
  const clientXonly = xOnlyFromCompressedPk33(pubCtx.clientPk33);
  const aggregateXonly = pubCtx.aggregatedXonly32;
  let clientMatches = 0;
  let aggregateMatches = 0;
  let exitPaths = 0;

  try {
    const decoded = VtxoScript.decode(candidate.tapTree);
    const paths = decoded.exitPaths();
    exitPaths = Array.isArray(paths) ? paths.length : 0;
    for (const exit of paths) {
      const script = (exit as any)?.script;
      if (!(script instanceof Uint8Array)) continue;
      if (scriptIncludesXOnly(script, clientXonly)) clientMatches += 1;
      if (scriptIncludesXOnly(script, aggregateXonly)) aggregateMatches += 1;
    }
  } catch (error: any) {
    return {
      status: "unknown",
      signer: "unknown",
      detail: `inspect_failed id=${String(candidate?.txid || "n/a").slice(0, 12)} err=${truncateForLog(String(error?.message || error || "unknown"), 120)}`,
    };
  }

  const id = `${String(candidate?.txid || "n/a").slice(0, 12)}:${Math.max(0, Math.trunc(Number(candidate?.vout || 0)))}`;
  if (aggregateMatches > 0 && clientMatches <= 0) {
    return {
      status: "aggregate_required",
      signer: "aggregate",
      detail: `id=${id} exit_paths=${exitPaths} client_match=0 aggregate_match=${aggregateMatches}`,
    };
  }
  if (clientMatches > 0 && aggregateMatches <= 0) {
    return {
      status: "client_only_ready",
      signer: "client",
      detail: `id=${id} exit_paths=${exitPaths} client_match=${clientMatches} aggregate_match=0`,
    };
  }
  if (clientMatches > 0 && aggregateMatches > 0) {
    return {
      status: "ambiguous",
      signer: "unknown",
      detail: `id=${id} exit_paths=${exitPaths} client_match=${clientMatches} aggregate_match=${aggregateMatches}`,
    };
  }
  return {
    status: "unknown",
    signer: "unknown",
    detail: `id=${id} exit_paths=${exitPaths} client_match=0 aggregate_match=0`,
  };
}

function formatUnrollStepType(type: unknown): string {
  if (type === Unroll.StepType.UNROLL) return "unroll";
  if (type === Unroll.StepType.WAIT) return "wait";
  if (type === Unroll.StepType.DONE) return "done";
  return "unknown";
}

async function getClientSingleKeyIdentity(): Promise<any> {
  const identity = await getOrCreateArkadeIdentity();
  const pubCtx = await identity.getSigningPublicContext();
  const priv = await identity.getSigningKeyCopy(pubCtx.clientPk33);
  try {
    logArkadeWalletSignTrace("client_exit_key_ready", {
      source: "passkey_prf",
      client_pk: truncateForLog(pubCtx.clientPk33, 18),
      expected_next: "build_client_only_exit_identity",
    });
    return SingleKey.fromPrivateKey(priv.slice());
  } finally {
    zeroize(priv);
    identity.clearClientSigningKey("client_exit_identity_created");
  }
}

async function broadcastArkadeUnrollPackage(
  anchorWallet: any,
  tx: any,
): Promise<{
  parentTxid: string;
  childTxid: string;
}> {
  const [parentHex, childHex] = await anchorWallet.bumpP2A(tx);
  const parentTx = decodeRawArkadeTransaction(parentHex);
  const childTx = decodeRawArkadeTransaction(childHex);
  logArkadeWalletSignTrace("arkade_exit_unroll_package_built", {
    parent_txid: truncateForLog(String(parentTx.id || ""), 24),
    child_txid: truncateForLog(String(childTx.id || ""), 24),
    parent_bytes: hexToBytesLocal(parentHex).length,
    child_bytes: hexToBytesLocal(childHex).length,
    parent_matches_step: parentTx.id === tx?.id ? 1 : 0,
    expected_next: "broadcast_unroll_package",
  });

  try {
    const response = await anchorWallet.provider.broadcastTransaction(parentHex, childHex);
    logArkadeWalletSignTrace("arkade_exit_unroll_package_broadcast", {
      status: "ok",
      parent_txid: truncateForLog(String(parentTx.id || ""), 24),
      child_txid: truncateForLog(String(childTx.id || ""), 24),
      response: truncateForLog(JSON.stringify(response), 180),
      expected_next: "verify_unroll_package_visibility",
    });
  } catch (error) {
    logArkadeWalletSignTrace("arkade_exit_unroll_package_broadcast", {
      status: "failed",
      parent_txid: truncateForLog(String(parentTx.id || ""), 24),
      child_txid: truncateForLog(String(childTx.id || ""), 24),
      err: arkadeErrorText(error, 180),
      expected_next: "surface_unroll_broadcast_error",
    });
  }

  await sleepMs(2_000);
  const [parentStatus, childStatus] = await Promise.all([
    getOnchainTxVisibility(anchorWallet.provider, String(parentTx.id || "")),
    getOnchainTxVisibility(anchorWallet.provider, String(childTx.id || "")),
  ]);
  logArkadeWalletSignTrace("arkade_exit_unroll_package_visibility", {
    parent_txid: truncateForLog(String(parentTx.id || ""), 24),
    parent: parentStatus,
    child_txid: truncateForLog(String(childTx.id || ""), 24),
    child: childStatus,
    expected_next:
      parentStatus.startsWith("mempool") || parentStatus.startsWith("confirmed")
        ? "wait_unroll_confirmed"
        : "inspect_unroll_package_failure",
  });
  if (!parentStatus.startsWith("mempool") && !parentStatus.startsWith("confirmed")) {
    throw new Error(`arkade_unroll_parent_not_visible ${parentStatus}`);
  }
  if (!childStatus.startsWith("mempool") && !childStatus.startsWith("confirmed")) {
    throw new Error(`arkade_unroll_child_not_visible ${childStatus}`);
  }
  return {
    parentTxid: String(parentTx.id || ""),
    childTxid: String(childTx.id || ""),
  };
}

async function getExitAnchorWallet(wallet: ArkadeWalletLike): Promise<any> {
  const identity = await getClientSingleKeyIdentity();
  const networkName = String(
    (wallet as unknown as { networkName?: unknown })?.networkName || "",
  ).trim();
  if (!networkName) {
    throw new Error("arkade wallet network unavailable");
  }
  return OnchainWallet.create(identity, networkName as any, wallet.onchainProvider);
}

async function getExitAnchorWatchWallet(wallet: ArkadeWalletLike): Promise<any> {
  const remoteIdentity = wallet.identity as ArkadeRemoteIdentity;
  const pubCtx = await remoteIdentity.getSigningPublicContext();
  const networkName = String(
    (wallet as unknown as { networkName?: unknown })?.networkName || "",
  ).trim();
  if (!networkName) {
    throw new Error("arkade wallet network unavailable");
  }
  const identity = {
    xOnlyPublicKey: async () => xOnlyFromCompressedPk33(pubCtx.clientPk33),
  };
  return OnchainWallet.create(identity as any, networkName as any, wallet.onchainProvider);
}

function cacheExitDebugSummary(summary: ArkadeExitDebugSummary): ArkadeExitDebugSummary {
  cachedExitDebugSummary = { ...summary };
  emitTrace({
    atMs: Date.now(),
    op: "exit_debug",
    status: summary.status,
    id: summary.lastTxid || summary.selectedTxid || undefined,
    detail:
      `anchor=${summary.anchorAddress || "n/a"} anchorBalance=${summary.anchorBalanceSats} ` +
      `vtxos=${summary.totalVtxos} unrolled=${summary.unrolledVtxos} pending=${summary.pendingUnrollVtxos} ` +
      `step=${summary.lastStep || "n/a"} proof=${summary.recoveryProofInvariantStatus} out=${summary.outputAddress || "n/a"}`,
  });
  return { ...summary };
}

async function buildArkadeExitDebugSummary(fields?: {
  lastStep?: string;
  lastTxid?: string;
  completedTxid?: string;
  outputAddress?: string;
  detail?: string;
}): Promise<ArkadeExitDebugSummary> {
  const wallet = await getOrCreateWallet();
  const anchorWallet = await getExitAnchorWatchWallet(wallet);
  const [anchorBalance, vtxos] = await Promise.all([
    anchorWallet.getBalance().catch(() => 0),
    wallet.getVtxos({ withRecoverable: true, withUnrolled: true }).catch((): any[] => []),
  ]);
  const list = Array.isArray(vtxos) ? vtxos : [];
  const candidate = selectExitCandidate(list);
  const unrolledTxids = selectCompletedExitTxids(list);
  const pendingUnrollVtxos = list.filter(
    (vtxo) => !vtxo?.isUnrolled && !vtxo?.isSpent && Number(vtxo?.value || 0) > 0,
  ).length;
  const anchorBalanceSats = Math.max(0, Math.trunc(Number(anchorBalance || 0)));
  const lastStep = String(fields?.lastStep || "").trim();
  const signerPreflight = await inspectArkadeExitSigner(wallet, list);
  const actualUnrollProbe = await inspectActualArkadeUnrollAddress(wallet, list);
  logArkadeWalletSignTrace("arkade_exit_signer_preflight", {
    status: signerPreflight.status,
    signer: signerPreflight.signer,
    detail: signerPreflight.detail,
    expected_next:
      signerPreflight.signer === "client"
        ? "client_only_exit_possible"
        : signerPreflight.signer === "aggregate"
          ? "aggregate_exit_blocked"
          : "inspect_vtxo_taptree",
  });
  logArkadeWalletSignTrace("actual_unroll_address_preflight", {
    contract: actualUnrollProbe.actualUnrollContractMode,
    proof: actualUnrollProbe.recoveryProofInvariantStatus,
    proof_detail: actualUnrollProbe.recoveryProofInvariantDetail || "n/a",
    actual: truncateForLog(actualUnrollProbe.actualUnrollAddress, 28) || "n/a",
    proof_addr: truncateForLog(actualUnrollProbe.recoveryProofAddress, 28) || "n/a",
    actual_csv: actualUnrollProbe.actualUnrollCsvTimelock || "n/a",
    client_leaf: actualUnrollProbe.actualUnrollClientKeyMatch ? 1 : 0,
    aggregate_leaf: actualUnrollProbe.actualUnrollAggregateKeyMatch ? 1 : 0,
    expected_next: "verify_decoded_taptree_client_csv_leaf",
  });
  logArkadeWalletSignTrace("arkade_recoverability_verdict", {
    verdict: actualUnrollProbe.recoveryProofInvariantStatus,
    detail: actualUnrollProbe.recoveryProofInvariantDetail,
    server_call: 0,
    expected_next:
      actualUnrollProbe.recoveryProofInvariantStatus === "pass"
        ? "client_key_can_spend_after_csv"
        : "block_recovery_until_decoded_taptree_passes",
  });
  const status: ArkadeExitDebugSummary["status"] =
    list.length === 0
      ? "no_vtxos"
      : actualUnrollProbe.recoveryProofInvariantStatus !== "pass"
        ? "proof_mismatch"
        : lastStep === "wait"
          ? "waiting_confirmation"
          : pendingUnrollVtxos > 0 && anchorBalanceSats <= 0
            ? "needs_anchor_funds"
            : pendingUnrollVtxos > 0
              ? "needs_unroll"
              : "ready_to_complete";

  return cacheExitDebugSummary({
    status,
    anchorAddress: String(anchorWallet.address || ""),
    anchorBalanceSats: String(anchorBalanceSats),
    totalVtxos: list.length,
    unrolledVtxos: unrolledTxids.length,
    pendingUnrollVtxos,
    selectedTxid: String(candidate?.txid || unrolledTxids[0] || ""),
    selectedVout: Math.max(0, Math.trunc(Number(candidate?.vout || 0))),
    selectedValueSats: String(Math.max(0, Math.trunc(Number(candidate?.value || 0)))),
    lastStep,
    lastTxid: String(fields?.lastTxid || ""),
    completedTxid: String(fields?.completedTxid || ""),
    outputAddress: String(fields?.outputAddress || ""),
    vtxoContractMode: arkadeVtxoContractMode,
    actualUnrollContractMode: actualUnrollProbe.actualUnrollContractMode,
    csvSignerStatus: signerPreflight.status,
    csvSignerDetail: signerPreflight.detail,
    actualUnrollAddress: actualUnrollProbe.actualUnrollAddress,
    actualUnrollScriptPubKey: actualUnrollProbe.actualUnrollScriptPubKey,
    actualUnrollCsvTimelock: actualUnrollProbe.actualUnrollCsvTimelock,
    actualUnrollCsvSequence: actualUnrollProbe.actualUnrollCsvSequence,
    actualUnrollClientKeyMatch: actualUnrollProbe.actualUnrollClientKeyMatch,
    actualUnrollAggregateKeyMatch: actualUnrollProbe.actualUnrollAggregateKeyMatch,
    recoveryProofAddress: actualUnrollProbe.recoveryProofAddress,
    recoveryProofScriptPubKey: actualUnrollProbe.recoveryProofScriptPubKey,
    recoveryProofCsvSequence: actualUnrollProbe.recoveryProofCsvSequence,
    recoveryProofInvariantStatus: actualUnrollProbe.recoveryProofInvariantStatus,
    recoveryProofInvariantDetail: actualUnrollProbe.recoveryProofInvariantDetail,
    detail: String(fields?.detail || actualUnrollProbe.detail || ""),
    updatedAtMs: Date.now(),
  });
}

export function getArkadeExitDebugSummarySnapshot(): ArkadeExitDebugSummary | null {
  return cachedExitDebugSummary ? { ...cachedExitDebugSummary } : null;
}

export async function getArkadeExitDebugSummary(): Promise<ArkadeExitDebugSummary> {
  return buildArkadeExitDebugSummary();
}

export async function broadcastArkadeExitUnrollStep(): Promise<ArkadeExitDebugSummary> {
  const wallet = await getOrCreateWallet();
  const vtxos = await wallet
    .getVtxos({ withRecoverable: true, withUnrolled: true })
    .catch((): any[] => []);
  const candidate = selectExitCandidate(Array.isArray(vtxos) ? vtxos : []);
  if (!candidate) {
    return buildArkadeExitDebugSummary({
      lastStep: "done",
      detail: "no pending vtxo to unroll",
    });
  }
  const actualUnrollProbe = await inspectActualArkadeUnrollAddress(
    wallet,
    Array.isArray(vtxos) ? vtxos : [],
  );
  if (actualUnrollProbe.recoveryProofInvariantStatus !== "pass") {
    logArkadeWalletSignTrace("arkade_exit_unroll_broadcast_blocked", {
      verdict: actualUnrollProbe.recoveryProofInvariantStatus,
      proof: actualUnrollProbe.recoveryProofInvariantStatus,
      contract: actualUnrollProbe.actualUnrollContractMode || "not_checked",
      client_leaf: actualUnrollProbe.actualUnrollClientKeyMatch ? 1 : 0,
      aggregate_leaf: actualUnrollProbe.actualUnrollAggregateKeyMatch ? 1 : 0,
      csvSequence: actualUnrollProbe.recoveryProofCsvSequence || "n/a",
      spend: "blocked",
      failures: actualUnrollProbe.recoveryProofInvariantDetail || "proof_not_passed",
      expected_next: "run_recoverability_audit_until_pass",
    });
    throw new Error(
      `arkade unroll broadcast blocked proof=${actualUnrollProbe.recoveryProofInvariantStatus} ${actualUnrollProbe.recoveryProofInvariantDetail}`,
    );
  }
  const anchorWallet = await getExitAnchorWallet(wallet);
  const anchorBalance = await anchorWallet.getBalance().catch(() => 0);
  const anchorAddress = String(anchorWallet.address || "");
  const anchorBalanceSats = Math.max(0, Math.trunc(Number(anchorBalance || 0)));
  logArkadeWalletSignTrace("arkade_exit_anchor_preflight", {
    status: anchorBalanceSats > 0 ? "ready" : "needs_funds",
    anchor: anchorAddress || "n/a",
    anchor_sats: anchorBalanceSats,
    spend: anchorBalanceSats > 0 ? "allowed" : "blocked",
    expected_next: anchorBalanceSats > 0 ? "broadcast_unroll_package" : "fund_exit_anchor",
  });
  if (anchorBalanceSats <= 0) {
    throw new Error(
      `fund exit anchor address before broadcasting unroll anchor=${anchorAddress || "n/a"} anchor_sats=${anchorBalanceSats}`,
    );
  }

  const session = await Unroll.Session.create(
    {
      txid: String(candidate.txid || ""),
      vout: Math.max(0, Math.trunc(Number(candidate.vout || 0))),
    },
    anchorWallet,
    anchorWallet.provider,
    wallet.indexerProvider,
  );
  const step = await session.next();
  const stepName = formatUnrollStepType(step.type);
  if (step.type === Unroll.StepType.UNROLL) {
    await broadcastArkadeUnrollPackage(anchorWallet, (step as any).tx);
  }
  return buildArkadeExitDebugSummary({
    lastStep: stepName,
    lastTxid:
      step.type === Unroll.StepType.UNROLL
        ? String((step as any)?.tx?.id || candidate.txid || "")
        : step.type === Unroll.StepType.WAIT
          ? String((step as any)?.txid || "")
          : String((step as any)?.vtxoTxid || ""),
    detail:
      step.type === Unroll.StepType.UNROLL
        ? "broadcasted unroll package"
        : step.type === Unroll.StepType.WAIT
          ? "waiting for unroll transaction confirmation"
          : "vtxo already unrolled",
  });
}

export async function completeArkadeExitUnroll(
  outputAddress: string,
): Promise<ArkadeExitDebugSummary> {
  const address = String(outputAddress || "").trim();
  if (!address) {
    throw new Error("exit output address required");
  }
  const wallet: ArkadeWalletLike = await getOrCreateWallet();
  const vtxos = await wallet.getVtxos({ withRecoverable: true, withUnrolled: true });
  const list = Array.isArray(vtxos) ? vtxos : [];
  const signerPreflight = await inspectArkadeExitSigner(wallet, list);
  const actualUnrollProbe = await inspectActualArkadeUnrollAddress(wallet, list);
  if (actualUnrollProbe.recoveryProofInvariantStatus !== "pass") {
    logArkadeWalletSignTrace("arkade_exit_complete_blocked", {
      verdict: actualUnrollProbe.recoveryProofInvariantStatus,
      proof: actualUnrollProbe.recoveryProofInvariantStatus,
      contract: actualUnrollProbe.actualUnrollContractMode || "not_checked",
      client_leaf: actualUnrollProbe.actualUnrollClientKeyMatch ? 1 : 0,
      aggregate_leaf: actualUnrollProbe.actualUnrollAggregateKeyMatch ? 1 : 0,
      csvSequence: actualUnrollProbe.recoveryProofCsvSequence || "n/a",
      spend: "blocked",
      failures: actualUnrollProbe.recoveryProofInvariantDetail || "proof_not_passed",
      expected_next: "run_recoverability_audit_until_pass",
    });
    throw new Error(
      `arkade recovery proof not pass ${actualUnrollProbe.recoveryProofInvariantDetail}`,
    );
  }
  const txids = selectCompletedExitTxids(list);
  if (!txids.length) {
    throw new Error("no unrolled vtxos ready to complete");
  }
  const originalIdentity = wallet.identity;
  if (signerPreflight.signer !== "client") {
    throw new Error(`arkade_exit_signer_unavailable ${signerPreflight.detail}`);
  }
  const clientIdentity = await getClientSingleKeyIdentity();
  let txid = "";
  try {
    logArkadeWalletSignTrace("arkade_exit_complete_signer", {
      signer: "client_only",
      status: signerPreflight.status,
      detail: signerPreflight.detail,
      expected_next: "sdk_builds_csv_exit_transaction_without_nuri_server",
    });
    // Debug-only: swap wallet identity for the client-only signing path. The
    // SDK marks Wallet.identity readonly; we cast to a mutable view to flip it.
    const mutableWallet = wallet as unknown as { identity: typeof clientIdentity };
    mutableWallet.identity = clientIdentity;
    txid = await Unroll.completeUnroll(wallet, txids, address);
    logArkadeWalletSignTrace("arkade_exit_complete_broadcast", {
      txid: truncateForLog(txid, 32),
      signer: "client_only",
      server: "not_used",
      output: truncateForLog(address, 28),
      expected_next: "l1_client_csv_spend_seen_in_mempool",
    });
  } finally {
    (wallet as unknown as { identity: typeof originalIdentity }).identity = originalIdentity;
  }
  await loadArkadeWalletSummary({
    scheduleAutoClaim: false,
    scheduleAutoSettle: false,
  }).catch((): null => null);
  return buildArkadeExitDebugSummary({
    lastStep: "complete",
    lastTxid: txid,
    completedTxid: txid,
    outputAddress: address,
    detail: `completed=${txids.length} signer=client_only server=nuri_not_used`,
  });
}

// getArkadePendingLnurlSwaps moved to ./internal/receiveAutoClaim and
// re-exported from the top of this file.

// inferArkadeNetwork moved to ./internal/network.
// parseInvoicePrefix / assertInvoicePrefixForNetwork moved to ./internal/lightningHelpers.

// isReverseFinalStatus, classifyLnReceiveClaimError, cooldown helpers,
// emitArkadeReceiveUpdated, emitArkadeWalletSummaryUpdated, and
// scheduleArkadeReceiveBalanceRefresh moved to ./internal/receiveAutoClaim.

// Receive-flow helpers (isReverseFinalStatus, classifyLnReceiveClaimError,
// claim cooldowns, emit/refresh helpers) live in ./internal/receiveAutoClaim.

// Receive-flow active-retry queue helpers moved to ./internal/receiveAutoClaim.

// Boarding-sweep active-retry queue helpers moved to ./internal/receiveAutoSweep.

// Claim-flow helpers + resume implementation moved to ./internal/receiveAutoClaim.

// getLightningLimitsInternal moved to ./internal/lightningHelpers.

// Scheduler implementations moved to ./internal/receiveAutoClaim.

// Boarding-sweep scheduler impl moved to ./internal/receiveAutoSweep.

// Auto-settle scheduler impl moved to ./internal/receiveAutoClaim.

// registerArkadeReceiveOrchestratorSchedulers removed — the orchestrator
// has real scheduler bodies; no DI registration is needed.

// Lightning bootstrap (init impl + cached state) lives in ./internal/lightningCache.

export function resetArkadeWalletDebug(): void {
  stopArkadeIncomingFundsSubscription("reset");
  resetArkadeLightningCacheState();
  resetArkadeWalletCacheState();
  resetArkadeStorageAdapterCache();
  recoveryBoardingSweepInFlight = null;
  recoveryBoardingSweepStartedAtMs = 0;
  clearArkadeOutgoingBrowserApprovalInFlight();
  resetArkadeLnurlCache();
  resetCachedStableParams();
  resetArkadeWalletSummaryCache();
  cachedIdentityReadinessSummary = null;
  cachedRecoveryContractSummary = null;
  cachedRecoveryBackupSummary = null;
  cachedRecoveryBackupCompletenessSummary = null;
  cachedExitDebugSummary = null;
  cachedVerifiedArkadeClientRecoveryProof = null;
  cachedVerifiedArkadeClientRecoveryProofSource = "";
  resetArkadeReceiveAutoClaimState();
  resetArkadeBoardingAutoSweepState();
  resetArkadeReceiveOrchestratorState();
  resetArkadeOutgoingSwapResumeState();
  resetBoardingSweepFailureCache();
  console.log(
    `🔐 [${shortTime()} ArkadeWalletDebugService.reset] cached=0 lightningMode=${ARKADE_LIGHTNING_STATUS} contractMode=${arkadeVtxoContractMode}`,
  );
}

// Wallet-summary loader, public read APIs, and their cooldown / rate-limit
// state moved to services/arkade/ArkadeWalletService.ts. The re-exports at the
// top of this file keep in-file callers and external imports working.

/**
 * Lists all swaps stored in the local legacy swap repository (scoped to the
 * current wallet's clientPk33). Includes pending swaps that the LNURL
 * auto-claim loop keeps polling — clear them with `deleteArkadeSwap(id)` to
 * stop the wallet-summary cascade.
 */
export async function listArkadeSwaps(): Promise<
  Array<{ id: string; status: string; type: string; createdAt?: number }>
> {
  const wallet = await getOrCreateWallet();
  const ctx = await (wallet.identity as ArkadeRemoteIdentity).getSigningPublicContext();
  const ownerKey = String(ctx.clientPk33 || "")
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{66}$/.test(ownerKey)) {
    throw new Error("listArkadeSwaps: signing public context missing clientPk33");
  }
  const repo = getArkadeSwapRepository(ownerKey);
  const swaps = await repo.getAllSwaps<BoltzSwap>();
  return swaps.map((s: any) => ({
    id: String(s?.id || ""),
    status: String(s?.status || ""),
    type: String(s?.type || ""),
    createdAt: typeof s?.createdAt === "number" ? s.createdAt : undefined,
  }));
}

/**
 * Deletes a swap from the local legacy swap repository by id. Used by the
 * debug lab to clear stuck pending swaps that drive the LNURL auto-claim
 * loop into the wallet-summary cascade described above.
 */
export async function deleteArkadeSwap(id: string): Promise<void> {
  const normalized = String(id || "").trim();
  if (!normalized) throw new Error("deleteArkadeSwap: id required");
  const wallet = await getOrCreateWallet();
  const ctx = await (wallet.identity as ArkadeRemoteIdentity).getSigningPublicContext();
  const ownerKey = String(ctx.clientPk33 || "")
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{66}$/.test(ownerKey)) {
    throw new Error("deleteArkadeSwap: signing public context missing clientPk33");
  }
  const repo = getArkadeSwapRepository(ownerKey);
  await repo.deleteSwap(normalized);
}

// getArkadeLightningLimits removed with Boltz: it reported the Boltz swap
// service's min/max, read from a shut-down API. Lightning limits now come from
// the SwapKit route quote.

export {
  getArkadeLnurlStatusPersisted,
  getArkadeLnurlStatusSnapshot,
} from "../ArkadeLnurlService";

export async function deriveBoardingAddressOffline(): Promise<string | null> {
  let params: ArkadeStableParams | null = getCachedStableParamsSnapshot();
  if (!params) {
    params = await readCachedStableParams();
  }
  if (!params) return null;

  const clientPk33Hex = String(authStateManager.getState().walletPublicKeys?.userExternal || "")
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{66}$/.test(clientPk33Hex)) return null;

  try {
    const clientPk33Bytes = hexToBytesLocal(clientPk33Hex);
    const nuriPk33Bytes = hexToBytesLocal(params.nuriServerPubKeyHex33);

    const sorted = musig2.sortKeys([clientPk33Bytes, nuriPk33Bytes]);
    const agg = musig2.keyAggregate(sorted);
    const aggExport = musig2.keyAggExport(agg);
    const aggCompressed =
      aggExport instanceof Uint8Array && aggExport.length === 33
        ? aggExport
        : // biome-ignore lint/suspicious/noExplicitAny: SDK shape varies across versions
          ((agg as any)?.aggPublicKey?.toBytes?.(true) as Uint8Array | undefined);
    if (!(aggCompressed instanceof Uint8Array) || aggCompressed.length !== 33) return null;

    const clientXOnly = clientPk33Bytes.slice(1);
    const aggregateXOnly = aggCompressed.slice(1);
    const nuriServerXOnly = nuriPk33Bytes.slice(1);
    const arkadeServerPubKey = hexToBytesLocal(params.arkadeServerPubKeyHex32);

    if (
      clientXOnly.length !== 32 ||
      aggregateXOnly.length !== 32 ||
      nuriServerXOnly.length !== 32 ||
      arkadeServerPubKey.length !== 32
    ) {
      return null;
    }

    const arkadeCsvTimelock = {
      type: params.arkadeCsvTimelock.type,
      value: BigInt(params.arkadeCsvTimelock.value),
    } as ArkadeClientRecoveryContractParams["arkadeCsvTimelock"];
    const nuriServerCsvTimelock = {
      type: params.nuriServerCsvTimelock.type,
      value: BigInt(params.nuriServerCsvTimelock.value),
    } as ArkadeClientRecoveryContractParams["nuriServerCsvTimelock"];

    const script = new ArkadeClientRecoveryVtxoScript({
      aggregatePubKey: aggregateXOnly,
      clientPubKey: clientXOnly,
      nuriServerPubKey: nuriServerXOnly,
      arkadeServerPubKey,
      arkadeCsvTimelock,
      nuriServerCsvTimelock,
    });
    const network = arkadeNetworks[params.networkName];
    const address = script.onchainAddress(network);
    return typeof address === "string" && address ? address : null;
  } catch {
    return null;
  }
}

export { claimArkadeLnurlUsername, getArkadeLnurlStatus } from "../ArkadeLnurlService";

// Debug entry point kept for the debug UI. The ark → ark send flow now lives in
// the prod-tier `sendArkadeToArk`; this delegates so there is a single source
// of truth (tracing/emitTrace happens inside the prod function).
export async function sendArkadeBitcoin(params: {
  address: string;
  amountSats: number;
}): Promise<string> {
  return sendArkadeToArk(params);
}

export { sendArkadeBitcoinOnchain } from "../ArkadeSendService";

// sweepArkadeBoardingToOffchain moved to ./internal/receiveAutoSweep (re-exported above).

export { createArkadeLightningInvoice } from "../ArkadeLightningReceiveService";

// resumeArkadeLightningClaims is replaced by resumeArkadeLightningClaimsManual from ./internal/receiveAutoClaim (re-exported below).

export async function runArkadeWalletTest(): Promise<ArkadeWalletTestResult> {
  const summary = await getArkadeWalletSummary({
    scheduleAutoClaim: false,
    scheduleAutoBoardingSweep: false,
  });
  const [probes, claims] = await Promise.all([
    probeArkadeDependencies(),
    resumeArkadeLightningClaimsManual(),
  ]);
  // `limits` came from the Boltz swap service, which is shut down.
  return { summary, probes, claims };
}

export { payArkadeLightningInvoice } from "../ArkadeLightningSendService";

// ---------------------------------------------------------------------------
// Migration helpers (Wave 3b)
//
// Bypass the ambient `getOrCreateArkadeIdentity()` so the LNURL register call
// can bind a username to a NEW passkey credId + new aggregated key. The normal
// `claimArkadeLnurlUsername` uses the current logged-in identity from auth
// state — for migration we need to bind the LNURL to keys derived from a
// freshly-created passkey that hasn't been written to auth state yet.
// ---------------------------------------------------------------------------

export { UsernameAlreadyClaimedError } from "../types/errors";

export {
  claimArkadeLnurlUsernameForCredId,
  arkadeAuthBeginForCredId,
  arkadeInfoForCredId,
  arkadeRecoveryStatusForCredId,
  deriveBoardingAddressForCredId,
} from "../ArkadeCredIdAccountService";
