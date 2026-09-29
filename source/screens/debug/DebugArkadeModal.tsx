import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Clipboard from "expo-clipboard";
import { View as RNView, ScrollView, StyleSheet, TextInput } from "react-native";
import {
  Button,
  ButtonText,
  Header,
  IconButton,
  Scroll,
  Text,
  TextField,
  TextFieldLabel,
  Topbar,
  TopbarTrailing,
  View,
} from "@ds";
import DsSheetHost from "../../components/DsSheetHost";
import Spinner from "../../components/Spinner";
import { isBolt11Invoice } from "../../lib/bitcoin/lightning";
import { parseBitcoinUri } from "../../lib/bitcoin/uri";
import { shortTime } from "../../lib/debugUtils";
import { sendBitcoin, type BitcoinSendTarget } from "../../services/bitcoin/BitcoinSendService";
import { formatArkadeLightningPayError } from "../../services/arkade/ArkadeLightningSendService";
import { EventBus } from "../../services/events/AppEventBusService";
import {
  compactUiText,
  formatArkadeActionLabel,
  formatReceiveStageLabel,
  trimArkadeLogs,
  withActionTimeout,
} from "../../lib/arkade/helpers";
import { shortId } from "../../lib/formatting";
import { sanitizeDigits } from "../../lib/sanitizeDigits";
import { isLnurlPaymentInput, normalizeLightningInput } from "../../services/bitcoin/LnurlService";
import {
  arkadeHealth,
  type ArkadeHealthResponse,
  subscribeArkadeApiTrace,
} from "../../services/arkade/ArkadeApiService";
import { getArkadePendingLnurlSwapsSnapshot } from "../../services/arkade/ArkadeTransactionHistoryService";
import {
  type ArkadeDeprecatedSignerBoardingInfo,
  type ArkadeDeprecatedSignerReport,
  type ArkadeDeprecatedSignerVtxoProbe,
  getArkadeDeprecatedSignerBoardingAddress,
  getArkadeDeprecatedSignerStatus,
  getArkadeDeprecatedSignerVtxos,
  runArkadeDeprecatedSignerSweep,
} from "../../services/arkade/ArkadeDeprecatedSignerMigrationService";
import { arkadeServerConfigService } from "../../services/arkade/ArkadeServerConfigService";
import { finalizeArkadePendingTxs } from "../../services/arkade/internal/pendingTxRescue";
import {
  type ArkadeIdentityReadinessSummary,
  type ArkadeLnurlStatus,
  type ArkadePendingLnurlSwap,
  type ArkadeReceiveStageSnapshot,
  type ArkadeRecoveryContractSummary,
  type ArkadeWalletSummary,
  getArkadeIdentityReadinessSummary,
  getArkadeIdentityReadinessSummarySnapshot,
  getArkadeLnurlStatus,
  getArkadePendingLnurlSwaps,
  getArkadeReceiveStageSnapshot,
  getArkadeRecoveryContractSummary,
  getArkadeRecoveryContractSummarySnapshot,
  getArkadeWalletSummary,
  getArkadeWalletSummarySnapshot,
  sendArkadeBitcoin,
  settleArkadePreconfirmedVtxos,
  claimArkadeLnurlUsername,
  subscribeArkadeWalletDebugTrace,
} from "../../services/arkade/debug/ArkadeRecoveryAndLabService";
import {
  addArkadeReceiveUnlockStateListener,
  getArkadeReceiveUnlockState,
  refreshArkadeReceiveUnlockState,
  runArkadeReceiveUnlock,
  type ArkadeReceiveUnlockState,
} from "../../services/arkade/ArkadeReceiveUnlockService";
import {
  ARKADE_CLIENT_VERSION,
  ARKADE_EXPECTED_SIGNER_SERVER,
  ARKADE_SDK_HINT,
  ARKADE_SDK_VERSION,
  BITCOIN_TX_VERSION,
  NURI_CSV_POLICY,
  NURI_CONTRACT_VERSION,
  NURI_SERVER_API_VERSION,
} from "../../services/arkade/ArkadeVersion";
import type { ArkadeUiActionState, DebugArkadeProps } from "../../types/debug";

const DEBUG_ARKADE_WALLET_SUMMARY_OPTIONS = {
  scheduleAutoClaim: false,
  scheduleAutoBoardingSweep: false,
  scheduleAutoRecover: false,
  scheduleAutoSettle: false,
} as const;

type Props = DebugArkadeProps;

type CopyAddressTarget = "lnurl" | "bitcoin" | "ark";
type ParsedSendTarget =
  | { kind: "lightning"; request: string }
  | { kind: "ark"; address: string }
  | { kind: "bitcoin"; address: string; amountSats?: number };

const initialActionState: ArkadeUiActionState = {
  kind: "idle",
  label: null,
  detail: null,
  atMs: 0,
};

function formatServerCsv(health: ArkadeHealthResponse | null): string {
  const csv = health?.nuri_server_csv;
  if (!csv) return "not_checked";
  return `${csv.value}_${csv.type}`;
}

function formatHealthServerVersion(health: ArkadeHealthResponse | null): string {
  return health?.nuri_server_version || health?.version || "not checked";
}

function serverCsvReady(health: ArkadeHealthResponse | null): boolean {
  const csv = health?.nuri_server_csv;
  return Boolean(
    health?.ok &&
      health?.nuri_server_api === NURI_SERVER_API_VERSION &&
      csv?.type === NURI_CSV_POLICY.type &&
      csv?.value === NURI_CSV_POLICY.value,
  );
}

function formatLnurlAddress(status: ArkadeLnurlStatus | null): string {
  return status?.lightningAddress || "";
}

function hasUsefulLnurlStatus(status: ArkadeLnurlStatus | null): boolean {
  return Boolean(status?.registered || status?.username || status?.lightningAddress);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "unknown");
}

function parseSendAmountSats(raw: string): number | null {
  const digits = sanitizeDigits(raw);
  if (!digits) return null;
  const amount = Number(digits);
  return Number.isFinite(amount) && amount > 0 ? Math.trunc(amount) : null;
}

function parseSendTarget(raw: string): ParsedSendTarget {
  const target = String(raw || "").trim();
  if (!target) {
    throw new Error("payment target required");
  }
  const lightningRequest = normalizeLightningInput(target);
  if (isBolt11Invoice(lightningRequest) || isLnurlPaymentInput(lightningRequest)) {
    return { kind: "lightning", request: lightningRequest };
  }
  if (/^ark/i.test(target)) {
    return { kind: "ark", address: target };
  }
  const bitcoin = parseBitcoinUri(target);
  if (!bitcoin?.address) {
    throw new Error("bitcoin address required");
  }
  return { kind: "bitcoin", address: bitcoin.address, amountSats: bitcoin.amountSats };
}

const DebugArkadeModal: React.FC<Props> = ({ visible, onClose }) => {
  const signerUrl = useMemo(() => arkadeServerConfigService.getSignerServerUrl(), []);
  const [health, setHealth] = useState<ArkadeHealthResponse | null>(null);
  const [walletSummary, setWalletSummary] = useState<ArkadeWalletSummary | null>(() =>
    getArkadeWalletSummarySnapshot(),
  );
  const [recoverySummary, setRecoverySummary] = useState<ArkadeRecoveryContractSummary | null>(() =>
    getArkadeRecoveryContractSummarySnapshot(),
  );
  const [identitySummary, setIdentitySummary] = useState<ArkadeIdentityReadinessSummary | null>(
    () => getArkadeIdentityReadinessSummarySnapshot(),
  );
  const [lnurlStatus, setLnurlStatus] = useState<ArkadeLnurlStatus | null>(null);
  const [lnurlCheckState, setLnurlCheckState] = useState<
    "not_checked" | "checking" | "checked" | "error"
  >("not_checked");
  const [lnurlServerChecked, setLnurlServerChecked] = useState(false);
  const [lnurlError, setLnurlError] = useState("");
  const [lnurlUsernameInput, setLnurlUsernameInput] = useState("");
  const [receiveStage, setReceiveStage] = useState<ArkadeReceiveStageSnapshot>(() =>
    getArkadeReceiveStageSnapshot(),
  );
  const [unlockState, setUnlockState] = useState<ArkadeReceiveUnlockState>(() =>
    getArkadeReceiveUnlockState(),
  );
  const [pendingSwaps, setPendingSwaps] = useState<ArkadePendingLnurlSwap[]>(() =>
    getArkadePendingLnurlSwapsSnapshot(),
  );
  const [sendAmountInput, setSendAmountInput] = useState("");
  const [sendTargetInput, setSendTargetInput] = useState("");
  const [running, setRunning] = useState(false);
  const [activeActionLabel, setActiveActionLabel] = useState<string | null>(null);
  const [lastActionState, setLastActionState] = useState<ArkadeUiActionState>(initialActionState);
  const [logs, setLogs] = useState<string[]>([]);
  const [deprecatedReports, setDeprecatedReports] = useState<ArkadeDeprecatedSignerReport[] | null>(
    null,
  );
  const [deprecatedAddrs, setDeprecatedAddrs] = useState<ArkadeDeprecatedSignerBoardingInfo | null>(
    null,
  );
  const [deprecatedVtxos, setDeprecatedVtxos] = useState<ArkadeDeprecatedSignerVtxoProbe | null>(
    null,
  );
  const runningRef = useRef(false);
  const autoLoadVisibleRef = useRef(false);
  const activeActionLabelRef = useRef<string | null>(null);

  const serverCsvLabel = formatServerCsv(health);
  const csvReady = serverCsvReady(health);
  const walletCsvMatched = walletSummary?.recoveryCsvStatus === "matched";
  const walletLoaded = Boolean(walletSummary?.boardingAddress || walletSummary?.arkAddress);
  const vtxoReadWarning = useMemo(
    () =>
      walletSummary?.debugVtxoDetails?.find((line) =>
        String(line || "").startsWith("vtxos_failed"),
      ) || null,
    [walletSummary?.debugVtxoDetails],
  );
  const contractWarning =
    walletSummary?.contractDiagnosticsStatus === "warning"
      ? walletSummary.contractDiagnosticsLine
      : null;
  const arkadeReady =
    csvReady && walletLoaded && walletCsvMatched && !vtxoReadWarning && !contractWarning;
  const spendableSats = walletSummary?.balanceAvailableSats || "0";
  const boardingSats = Math.max(0, Number(walletSummary?.balanceBoardingTotalSats || 0));
  const bitcoinAddress = walletSummary?.boardingAddress || "";
  const arkAddress = walletSummary?.arkAddress || "";
  const lightningAddress = formatLnurlAddress(lnurlStatus);
  const lnurlRegistered = Boolean(lnurlStatus?.registered && lightningAddress);
  const lnurlCanRegister = lnurlServerChecked && lnurlCheckState === "checked" && !lnurlRegistered;
  const sendTargetReady = sendTargetInput.trim().length > 0;
  const visibleLogs = logs.slice(-18);

  const statusBanner = useMemo(() => {
    if (running) {
      return {
        tone: "active" as const,
        title: `${formatArkadeActionLabel(activeActionLabel)} running`,
        detail: "Keep this screen open until the action finishes.",
      };
    }
    if (lastActionState.kind === "error") {
      return {
        tone: "error" as const,
        title: `${formatArkadeActionLabel(lastActionState.label)} failed`,
        detail: compactUiText(lastActionState.detail || "Unknown error.", 180),
      };
    }
    if (arkadeReady) {
      if (receiveStage.detail.includes("sweep_blocked=1")) {
        return {
          tone: "error" as const,
          title: "Boarding sweep blocked",
          detail: compactUiText(receiveStage.detail, 180),
        };
      }
      if (unlockState.boardingSweepReadyCount > 0) {
        return {
          tone: "active" as const,
          title: "Boarding sweep ready",
          detail: `${unlockState.boardingSweepReadySats} sats require Unlock Wallet.`,
        };
      }
      if (boardingSats > 0) {
        return {
          tone: "warning" as const,
          title: "Boarding funds pending",
          detail: `${boardingSats} sats are waiting for server sweep_ready.`,
        };
      }
      if (
        receiveStage.claimableCount > 0 ||
        receiveStage.status === "claimable" ||
        receiveStage.status === "claiming"
      ) {
        return {
          tone: "active" as const,
          title: "Receiving funds",
          detail: compactUiText(
            receiveStage.detail || "Claiming claimable Lightning receive.",
            180,
          ),
        };
      }
      return {
        tone: "success" as const,
        title: "Arkade ready",
        detail: `${spendableSats} sats spendable. Nuri server CSV ${serverCsvLabel}.`,
      };
    }
    if (vtxoReadWarning) {
      return {
        tone: "warning" as const,
        title: "Wallet loaded with VTXO warning",
        detail: compactUiText(vtxoReadWarning, 180),
      };
    }
    if (contractWarning) {
      return {
        tone: "warning" as const,
        title: "Wallet loaded with contract warning",
        detail: compactUiText(contractWarning, 180),
      };
    }
    if (!csvReady && health) {
      return {
        tone: "error" as const,
        title: "Server CSV not ready",
        detail:
          `Expected nuri_server_api=${NURI_SERVER_API_VERSION} nuri_server_csv=${NURI_CSV_POLICY.value}_${NURI_CSV_POLICY.type}. ` +
          `Got nuri_server_api=${health.nuri_server_api || "missing"} version=${formatHealthServerVersion(health)} nuri_server_csv=${serverCsvLabel}.`,
      };
    }
    if (walletLoaded) {
      return {
        tone: "warning" as const,
        title: "Wallet loaded, checks pending",
        detail: `Recovery CSV ${walletSummary?.recoveryCsvStatus || "not_checked"}.`,
      };
    }
    return {
      tone: "neutral" as const,
      title: "Loading Arkade",
      detail: "Opening this screen automatically checks server, wallet, balances, and addresses.",
    };
  }, [
    activeActionLabel,
    arkadeReady,
    boardingSats,
    contractWarning,
    csvReady,
    health,
    lastActionState.detail,
    lastActionState.kind,
    lastActionState.label,
    receiveStage.claimableCount,
    receiveStage.detail,
    receiveStage.status,
    running,
    serverCsvLabel,
    spendableSats,
    unlockState.boardingSweepReadyCount,
    unlockState.boardingSweepReadySats,
    vtxoReadWarning,
    walletLoaded,
    walletSummary?.recoveryCsvStatus,
  ]);

  const appendLog = useCallback((msg: string) => {
    setLogs((prev) =>
      trimArkadeLogs([...prev, `🧪 [${shortTime()} DebugArkadeModal] ${compactUiText(msg, 260)}`]),
    );
  }, []);

  const applySnapshots = useCallback(() => {
    setWalletSummary(getArkadeWalletSummarySnapshot());
    setRecoverySummary(getArkadeRecoveryContractSummarySnapshot());
    setIdentitySummary(getArkadeIdentityReadinessSummarySnapshot());
    setReceiveStage(getArkadeReceiveStageSnapshot());
    setUnlockState(getArkadeReceiveUnlockState());
    setPendingSwaps(getArkadePendingLnurlSwapsSnapshot());
  }, []);

  const runAction = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      if (runningRef.current) {
        appendLog(`action=${label} ignored active=${activeActionLabelRef.current || "unknown"}`);
        return;
      }
      runningRef.current = true;
      activeActionLabelRef.current = label;
      setActiveActionLabel(label);
      setRunning(true);
      setLastActionState({
        kind: "running",
        label,
        detail: null,
        atMs: Date.now(),
      });
      try {
        await withActionTimeout(label, fn());
        setLastActionState({
          kind: "success",
          label,
          detail: "ok",
          atMs: Date.now(),
        });
        appendLog(`action=${label} ok`);
      } catch (error: unknown) {
        const detail = errorMessage(error);
        setLastActionState({
          kind: "error",
          label,
          detail,
          atMs: Date.now(),
        });
        appendLog(`action=${label} failed err=${detail}`);
      } finally {
        runningRef.current = false;
        activeActionLabelRef.current = null;
        setActiveActionLabel(null);
        setRunning(false);
      }
    },
    [appendLog],
  );

  const loadArkadeState = useCallback(async () => {
    setWalletSummary(null);
    const nextHealth = await arkadeHealth();
    setHealth(nextHealth);
    appendLog(
      `server version=${nextHealth.version || "n/a"} csv=${formatServerCsv(nextHealth)} signer=${signerUrl}`,
    );

    const summary = await getArkadeWalletSummary(DEBUG_ARKADE_WALLET_SUMMARY_OPTIONS);
    setWalletSummary(summary);
    appendLog(
      `wallet loaded spendable=${summary.balanceAvailableSats} settled=${summary.balanceSettledSats} finalizing=${summary.balancePreconfirmedSats} csv=${summary.recoveryCsvStatus}`,
    );
    const summaryBoardingConfirmed = Math.max(0, Number(summary.balanceBoardingConfirmedSats || 0));
    const summaryBoardingTotal = Math.max(0, Number(summary.balanceBoardingTotalSats || 0));
    if (summaryBoardingConfirmed > 0) {
      appendLog(`incoming maintenance boarding_pending_confirmed=${summaryBoardingConfirmed}`);
    } else if (summaryBoardingTotal > 0) {
      appendLog(`incoming maintenance boarding_waiting total=${summaryBoardingTotal}`);
    }
    if (summary.contractDiagnosticsStatus !== "ok") {
      appendLog(
        `contracts status=${summary.contractDiagnosticsStatus} ${summary.contractDiagnosticsLine}`,
      );
    }

    const recovery = await getArkadeRecoveryContractSummary();
    setRecoverySummary(recovery);
    appendLog(
      `recovery status=${recovery.status} nuriServerCsv=${recovery.nuriServerCsvLabel || "n/a"} passkeyPolicy=${recovery.passkeyPubkeyPolicy || "n/a"}`,
    );

    const identity = await getArkadeIdentityReadinessSummary();
    setIdentitySummary(identity);
    appendLog(
      `identity status=${identity.status} hard=${identity.readyForHardMode ? 1 : 0} serverLoss=${identity.readyForServerLossRecovery ? 1 : 0}`,
    );

    try {
      setLnurlCheckState("checking");
      setLnurlServerChecked(false);
      setLnurlError("");
      const cachedStatus = await getArkadeLnurlStatus(undefined, {
        allowPrompt: false,
        reason: "lnurl_status_load_cached",
      });
      const status = hasUsefulLnurlStatus(cachedStatus)
        ? cachedStatus
        : await getArkadeLnurlStatus(undefined, {
            allowPrompt: true,
            reason: "lnurl_status_load_server",
          });
      setLnurlStatus(status);
      setLnurlCheckState("checked");
      setLnurlServerChecked(!hasUsefulLnurlStatus(cachedStatus));
      if (status.username) {
        setLnurlUsernameInput(status.username);
      }
      appendLog(
        `lnurl status username=${status.username || "n/a"} address=${status.lightningAddress || "n/a"} registered=${status.registered ? 1 : 0} published=${status.hasPublishedInvoice ? 1 : 0}`,
      );
    } catch (error: unknown) {
      const detail = errorMessage(error);
      setLnurlCheckState("error");
      setLnurlServerChecked(false);
      setLnurlError(detail);
      appendLog(`lnurl status failed err=${detail}`);
    }

    const pending = await getArkadePendingLnurlSwaps({
      allowPrompt: false,
      reason: "debug_wallet_load_pending",
    }).catch(() => getArkadePendingLnurlSwapsSnapshot());
    setPendingSwaps(pending);
    setReceiveStage(getArkadeReceiveStageSnapshot());
    if (pending.length > 0) {
      appendLog(`incoming maintenance pending=${pending.length} manual_claim_available=1`);
    }
    const unlock = await refreshArkadeReceiveUnlockState({
      reason: "debug_arkade_load",
      forceFresh: true,
    });
    setUnlockState(unlock);
    appendLog(
      `unlock_state status=${unlock.status} actionable=${unlock.actionableCount} sats=${unlock.actionableSats} ln_pending=${unlock.lnReceivePendingCount} ln_claimable=${unlock.lnReceiveClaimableCount} boarding_sweep_ready=${unlock.boardingSweepReadyCount} wallet_pending_vtxos=${unlock.arkadeWalletPendingVtxoCount}`,
    );
  }, [appendLog, signerUrl]);

  const handleLoadWallet = useCallback(() => {
    void runAction("wallet_summary", loadArkadeState);
  }, [loadArkadeState, runAction]);

  const handleUnlockWallet = useCallback(() => {
    void runAction("unlock_wallet", async () => {
      const result = await runArkadeReceiveUnlock("debug_unlock_wallet");
      setUnlockState(result.state);
      appendLog(
        `unlock_wallet ok=${result.ok ? 1 : 0} status=${result.state.status} actionable=${result.state.actionableCount} errors=${result.errors.length}`,
      );
      for (const line of result.logs) {
        appendLog(`unlock_log ${line}`);
      }
      for (const error of result.errors) {
        appendLog(`unlock_error ${error}`);
      }
      if (!result.ok) {
        throw new Error(result.errors.join("; ") || "unlock wallet failed");
      }
    });
  }, [appendLog, runAction]);

  const handleRescuePendingTxs = useCallback(() => {
    void runAction("pending_tx_rescue", async () => {
      const result = await finalizeArkadePendingTxs("debug_manual");
      appendLog(
        `pending_tx_rescue finalized=${result.finalized.length} pending=${result.pending.length}`,
      );
      for (const txid of result.pending) {
        appendLog(
          `pending_tx ${txid.slice(0, 16)}… ${result.finalized.includes(txid) ? "FINALIZED" : "still pending (finalize failed, see logs)"}`,
        );
      }
      if (result.pending.length === 0) {
        appendLog("pending_tx_rescue: server reports no pending txs for this wallet");
      }
    });
  }, [appendLog, runAction]);

  const handleSettlePreconfirmed = useCallback(() => {
    void runAction("settle_preconfirmed", async () => {
      const summary = await settleArkadePreconfirmedVtxos();
      appendLog(
        `settle_preconfirmed settled=${summary.balanceSettledSats} finalizing=${summary.balancePreconfirmedSats}`,
      );
    });
  }, [appendLog, runAction]);

  const handleCheckDeprecatedSigner = useCallback(() => {
    void runAction("deprecated_signer_status", async () => {
      const reports = await getArkadeDeprecatedSignerStatus();
      setDeprecatedReports(reports);
      if (reports.length === 0) {
        appendLog("deprecated_signer status: none (no funds under a deprecated signer)");
        return;
      }
      for (const r of reports) {
        appendLog(
          `deprecated_signer ${r.signerPubKey.slice(0, 14)} status=${r.status} vtxos=${r.vtxoCount}/${r.totalValue} boarding=${r.boardingCount}/${r.boardingValue} secsToCutoff=${r.secondsUntilCutoff ?? "n/a"}`,
        );
      }
    });
  }, [appendLog, runAction]);

  const handleMigrateDeprecatedSigner = useCallback(() => {
    void runAction("deprecated_signer_sweep", async () => {
      const result = await runArkadeDeprecatedSignerSweep("debug_deprecated_signer_sweep");
      appendLog(
        `deprecated_signer sweep enrolled=${result.enrolledVtxoCount} selected=${result.selectedCount} (${result.selectedValueSats} sats) txid=${result.txid || "none"}`,
      );
      const probe = await getArkadeDeprecatedSignerVtxos();
      setDeprecatedVtxos(probe);
      appendLog(`deprecated_signer post-sweep remaining vtxos=${probe.vtxoCount}`);
    });
  }, [appendLog, runAction]);

  const handleDeriveDeprecatedBoarding = useCallback(() => {
    void runAction("deprecated_signer_boarding", async () => {
      const info = await getArkadeDeprecatedSignerBoardingAddress();
      setDeprecatedAddrs(info);
      appendLog(`current boarding ${info.currentBoardingAddress}`);
      appendLog(`deprecated signer ${info.deprecatedSignerPubKey || "none"}`);
      appendLog(`deprecated boarding ${info.deprecatedBoardingAddress || "none"}`);
    });
  }, [appendLog, runAction]);

  const handleProbeDeprecatedVtxos = useCallback(() => {
    void runAction("deprecated_signer_vtxo_probe", async () => {
      const probe = await getArkadeDeprecatedSignerVtxos();
      setDeprecatedVtxos(probe);
      appendLog(`deprecated ark script ${probe.arkScriptHex || "none"}`);
      appendLog(
        `deprecated vtxos=${probe.vtxoCount} total=${probe.totalValueSats} sats spendable=${probe.spendableCount} (${probe.spendableValueSats} sats)`,
      );
    });
  }, [appendLog, runAction]);

  const deprecatedHasFunds = useMemo(
    () =>
      (deprecatedReports || []).some((r) => r.vtxoCount > 0 || r.boardingCount > 0) ||
      (deprecatedVtxos?.totalValueSats ?? 0) > 0,
    [deprecatedReports, deprecatedVtxos],
  );

  const handleCopyAddress = useCallback(
    (target: CopyAddressTarget) => {
      void runAction(`copy_${target}_address`, async () => {
        const value =
          target === "lnurl"
            ? lightningAddress
            : target === "bitcoin"
              ? bitcoinAddress
              : arkAddress;
        if (!value) {
          throw new Error(`${target} address unavailable`);
        }
        await Clipboard.setStringAsync(value);
        appendLog(`copied ${target} address len=${value.length}`);
      });
    },
    [appendLog, arkAddress, bitcoinAddress, lightningAddress, runAction],
  );

  const handleRegisterLnurl = useCallback(() => {
    void runAction("register_lnurl", async () => {
      const username = lnurlUsernameInput.trim();
      setLnurlCheckState("checking");
      setLnurlServerChecked(false);
      setLnurlError("");
      try {
        const existing = await getArkadeLnurlStatus(undefined, {
          allowPrompt: true,
          reason: "lnurl_register_preflight",
        });
        setLnurlServerChecked(true);
        if (existing.registered && existing.lightningAddress) {
          setLnurlStatus(existing);
          setLnurlCheckState("checked");
          if (existing.username) {
            setLnurlUsernameInput(existing.username);
          }
          appendLog(
            `lnurl already registered username=${existing.username || "n/a"} address=${existing.lightningAddress}`,
          );
          return;
        }
        setLnurlCheckState("checked");
        const status = await claimArkadeLnurlUsername(username);
        setLnurlStatus(status);
        setLnurlServerChecked(true);
        if (status.username) {
          setLnurlUsernameInput(status.username);
        }
        appendLog(
          `lnurl registered username=${status.username || username} address=${status.lightningAddress || "n/a"}`,
        );
      } catch (error: unknown) {
        const detail = errorMessage(error);
        setLnurlCheckState("error");
        setLnurlServerChecked(false);
        setLnurlError(detail);
        appendLog(`lnurl register failed err=${detail}`);
        throw error;
      }
    });
  }, [appendLog, lnurlUsernameInput, runAction]);

  const handleSendPayment = useCallback(() => {
    void runAction("send_payment", async () => {
      const target = parseSendTarget(sendTargetInput);
      const enteredAmountSats = parseSendAmountSats(sendAmountInput);
      const amountSats =
        enteredAmountSats || (target.kind === "bitcoin" ? target.amountSats || null : null);

      if (target.kind === "lightning") {
        appendLog("send lightning sdk=@arkade-os/swap corridor=arkade_intents_v1 path=swapkit");
        const isBolt11 = isBolt11Invoice(target.request);
        const sendTarget: BitcoinSendTarget = isBolt11
          ? { kind: "bolt11", invoice: target.request }
          : { kind: "lnurl", lnurl: target.request, amountSats: enteredAmountSats || 0 };
        try {
          const result = await sendBitcoin(sendTarget);
          applySnapshots();
          appendLog(`send lightning ok paymentHash=${shortId(result.paymentHash || "lightning")}`);
        } catch (error: unknown) {
          appendLog(`send lightning failed err=${formatArkadeLightningPayError(error)}`);
          throw error;
        }
        return;
      }

      if (!amountSats || amountSats <= 0) {
        throw new Error("amount required");
      }

      if (target.kind === "ark") {
        // Offchain Ark-address send is debug-only and not exposed through the
        // sendBitcoin wrapper (no prod surface uses it). Calls the debug-tier
        // helper directly and emits the same refresh events.
        const txid = await sendArkadeBitcoin({
          address: target.address,
          amountSats,
        });
        applySnapshots();
        try {
          EventBus.emit("bitcoin:refresh");
        } catch {}
        try {
          EventBus.emit("bitcoin:syncWallet");
        } catch {}
        appendLog(`send ark ok sats=${amountSats} txid=${shortId(txid)}`);
        return;
      }

      const result = await sendBitcoin({
        kind: "bitcoin_onchain",
        address: target.address,
        amountSats,
      });
      applySnapshots();
      appendLog(`send bitcoin ok sats=${amountSats} txid=${shortId(result.txid || "n/a")}`);
    });
  }, [appendLog, applySnapshots, runAction, sendAmountInput, sendTargetInput]);

  const handleClearLogs = useCallback(() => {
    setLogs([`🧪 [${shortTime()} DebugArkadeModal] logs cleared`]);
  }, []);

  const handleCopyLogs = useCallback(() => {
    void runAction("copy_arkade_logs", async () => {
      const payload = [
        `client=${ARKADE_CLIENT_VERSION}`,
        `sdk=${ARKADE_SDK_HINT}`,
        `expected_server=${ARKADE_EXPECTED_SIGNER_SERVER}`,
        `actual_server=${formatHealthServerVersion(health)}`,
        `nuri_server_api=${NURI_SERVER_API_VERSION}`,
        `actual_nuri_server_api=${health?.nuri_server_api || "not_checked"}`,
        `nuri_contract_version=${NURI_CONTRACT_VERSION}`,
        `arkade_sdk_version=${ARKADE_SDK_VERSION}`,
        `bitcoin_tx_version=${BITCOIN_TX_VERSION}`,
        "arkade_csv=from_arkade",
        `nuri_csv=${serverCsvLabel}`,
        `signer_url=${signerUrl}`,
        `server_csv=${serverCsvLabel}`,
        `wallet_csv=${walletSummary?.recoveryCsvStatus || "not_checked"}`,
        `spendable=${spendableSats}`,
        `unlock_status=${unlockState.status}`,
        `unlock_actionable_count=${unlockState.actionableCount}`,
        `unlock_actionable_sats=${unlockState.actionableSats}`,
        `ln_receive_pending_count=${unlockState.lnReceivePendingCount}`,
        `ln_receive_claimable_count=${unlockState.lnReceiveClaimableCount}`,
        `boarding_sweep_ready_count=${unlockState.boardingSweepReadyCount}`,
        `arkade_wallet_pending_vtxo_count=${unlockState.arkadeWalletPendingVtxoCount}`,
        `arkade_wallet_pending_vtxo_sats=${unlockState.arkadeWalletPendingVtxoSats}`,
        `lnurl=${lightningAddress}`,
        `bitcoin=${bitcoinAddress || "n/a"}`,
        "--- LOGS ---",
        ...logs,
      ].join("\n");
      await Clipboard.setStringAsync(payload);
      appendLog(`copied logs lines=${payload.split("\n").length}`);
    });
  }, [
    appendLog,
    bitcoinAddress,
    health,
    lightningAddress,
    logs,
    serverCsvLabel,
    signerUrl,
    spendableSats,
    unlockState.actionableCount,
    unlockState.actionableSats,
    unlockState.arkadeWalletPendingVtxoCount,
    unlockState.arkadeWalletPendingVtxoSats,
    unlockState.boardingSweepReadyCount,
    unlockState.lnReceiveClaimableCount,
    unlockState.lnReceivePendingCount,
    unlockState.status,
    walletSummary?.recoveryCsvStatus,
    runAction,
  ]);

  useEffect(() => {
    if (!visible) {
      autoLoadVisibleRef.current = false;
      return;
    }
    if (autoLoadVisibleRef.current) return;
    autoLoadVisibleRef.current = true;
    appendLog("auto load wallet");
    handleLoadWallet();
  }, [appendLog, handleLoadWallet, visible]);

  useEffect(() => {
    const off = subscribeArkadeApiTrace((trace) => {
      appendLog(
        `api ${trace.method} ${trace.path} status=${trace.status} durMs=${trace.durMs}${trace.reason ? ` reason=${trace.reason}` : ""}`,
      );
    });
    return off;
  }, [appendLog]);

  useEffect(() => addArkadeReceiveUnlockStateListener(setUnlockState), []);

  useEffect(() => {
    const off = subscribeArkadeWalletDebugTrace((trace) => {
      if (
        trace.op === "wallet_summary" ||
        trace.op === "recovery_contract" ||
        trace.op === "identity_readiness" ||
        trace.op === "contract_diagnostics" ||
        trace.op === "contract_delete_invalid" ||
        trace.op === "ln_receive_stage" ||
        trace.op === "ln_receive_manual_claim" ||
        trace.op === "arkade_receive_unlock_state" ||
        trace.op === "arkade_receive_unlock" ||
        trace.op === "lnurl_pending_snapshot" ||
        trace.op === "ark_settle" ||
        trace.op === "send_ark" ||
        trace.op === "send_bitcoin_onchain" ||
        trace.op === "ln_pay"
      ) {
        applySnapshots();
      }
      if (
        trace.op === "wallet_summary" ||
        trace.op === "contract_diagnostics" ||
        trace.op === "contract_delete_invalid" ||
        trace.op === "send_ark" ||
        trace.op === "send_bitcoin_onchain" ||
        trace.op === "ln_pay" ||
        trace.op === "ln_pay_request" ||
        trace.op === "ln_pay_prompt_plan" ||
        trace.op === "ln_receive_auto_claim" ||
        trace.op === "ln_receive_claim" ||
        trace.op === "ln_receive_manual_claim" ||
        trace.op === "ln_receive_stage" ||
        trace.op === "lnurl_pending_snapshot" ||
        trace.op === "ark_settle" ||
        trace.op === "arkade_receive_unlock_state" ||
        trace.op === "arkade_receive_unlock" ||
        trace.op === "arkade_boarding_auto_sweep" ||
        trace.op === "arkade_boarding_sweep" ||
        trace.op === "arkade_boarding_sweep_preflight" ||
        trace.op === "arkade_boarding_sweep_signing_gate" ||
        trace.op === "browser_confirm"
      ) {
        appendLog(
          `flow op=${trace.op} status=${trace.status}${trace.detail ? ` detail=${trace.detail}` : ""}`,
        );
      }
    });
    return off;
  }, [appendLog, applySnapshots]);

  const statusAccent =
    statusBanner.tone === "warning" || statusBanner.tone === "error"
      ? ("orange" as const)
      : statusBanner.tone === "neutral"
        ? ("neutral" as const)
        : ("lilac" as const);

  return (
    <DsSheetHost visible={visible} onClose={onClose} mode="full">
      <Header safeAreaTop chrome="canvas">
        <Topbar surface="transparent">
          <TopbarTrailing>
            <IconButton icon="cross" variant="soft" accessibilityLabel="Close" onPress={onClose} />
          </TopbarTrailing>
        </Topbar>
      </Header>

      <Scroll safeAreaBottom>
        <View direction="column" align="stretch" gap="lg" paddingX="lg" paddingBottom="lg">
          <Text size="lg" emphasis>
            Arkade Wallet
          </Text>

          <View
            variant="soft"
            accent={statusAccent}
            radius="lg"
            padding="lg"
            direction="column"
            align="stretch"
            gap="xs"
          >
            <Text size="xs" muted>
              Status
            </Text>
            <Text size="lg" emphasis>
              {statusBanner.title}
            </Text>
            <Text size="sm" muted>
              {statusBanner.detail}
            </Text>
          </View>

          <View variant="soft" radius="lg" padding="lg" direction="column" align="stretch" gap="xs">
            <Text size="md" emphasis>
              Spendable Balance
            </Text>
            <Text size="lg" emphasis>
              {spendableSats} sats
            </Text>
            <Text size="sm" muted>
              Settled {walletSummary?.balanceSettledSats || "0"} sats · Finalizing{" "}
              {walletSummary?.balancePreconfirmedSats || "0"} sats
            </Text>
            <Text size="sm" muted>
              Boarding {walletSummary?.balanceBoardingTotalSats || "0"} sats · Recoverable{" "}
              {walletSummary?.balanceRecoverableSats || "0"} sats
            </Text>
          </View>

          <View variant="soft" radius="lg" padding="lg" direction="column" align="stretch" gap="sm">
            <Text size="md" emphasis>
              Addresses
            </Text>
            <Text size="sm" muted>
              LNURL
            </Text>
            {lnurlRegistered ? (
              <>
                <Text size="sm" mono>
                  {lightningAddress}
                </Text>
                <Button
                  size="sm"
                  variant="soft"
                  onPress={() => handleCopyAddress("lnurl")}
                  disabled={!lnurlStatus?.lightningAddress}
                >
                  <ButtonText>Copy LNURL</ButtonText>
                </Button>
              </>
            ) : lnurlCheckState === "checking" ? (
              <Text size="sm" muted>
                Checking LNURL...
              </Text>
            ) : lnurlCheckState === "error" ? (
              <View variant="soft" accent="orange" radius="md" padding="md" align="stretch">
                <Text size="sm">{compactUiText(lnurlError || "LNURL check failed.", 260)}</Text>
              </View>
            ) : lnurlCanRegister ? (
              <View direction="column" align="stretch" gap="sm">
                <TextField
                  value={lnurlUsernameInput}
                  onChangeText={setLnurlUsernameInput}
                  placeholder="username"
                  autoCapitalize="none"
                >
                  <TextFieldLabel>username</TextFieldLabel>
                </TextField>
                <Button
                  size="sm"
                  variant="soft"
                  onPress={handleRegisterLnurl}
                  disabled={running || lnurlUsernameInput.trim().length < 3}
                >
                  <ButtonText>Register LNURL</ButtonText>
                </Button>
              </View>
            ) : (
              <Text size="sm" muted>
                Load wallet to check LNURL.
              </Text>
            )}
            <Text size="sm" muted>
              Bitcoin Address
            </Text>
            <Text size="sm" mono>
              {bitcoinAddress || "loading"}
            </Text>
            <Button
              size="sm"
              variant="soft"
              onPress={() => handleCopyAddress("bitcoin")}
              disabled={!bitcoinAddress}
            >
              <ButtonText>Copy Bitcoin Address</ButtonText>
            </Button>
            <Text size="sm" muted>
              Ark Address
            </Text>
            <Text size="sm" mono>
              {arkAddress || "loading"}
            </Text>
            <Button
              size="sm"
              variant="soft"
              onPress={() => handleCopyAddress("ark")}
              disabled={!arkAddress}
            >
              <ButtonText>Copy Ark Address</ButtonText>
            </Button>
          </View>

          <View variant="soft" radius="lg" padding="lg" direction="column" align="stretch" gap="sm">
            <Text size="md" emphasis>
              Send
            </Text>
            <TextField
              value={sendAmountInput}
              onChangeText={(value) => setSendAmountInput(sanitizeDigits(value))}
              placeholder="Amount sats"
              inputMode="numeric"
            >
              <TextFieldLabel>Amount sats</TextFieldLabel>
            </TextField>
            <View variant="outline" radius="md" paddingX="md" paddingY="sm" align="stretch">
              <TextInput
                style={styles.sendTargetInput}
                value={sendTargetInput}
                onChangeText={setSendTargetInput}
                placeholder="Bitcoin address, LN invoice, LNURL"
                autoCapitalize="none"
                autoCorrect={false}
                multiline
                textAlignVertical="top"
                returnKeyType="done"
              />
            </View>
            <Button
              size="sm"
              variant="solid"
              accent="lilac"
              onPress={handleSendPayment}
              disabled={running || !sendTargetReady}
            >
              <ButtonText>Send</ButtonText>
            </Button>
          </View>

          <View variant="soft" radius="lg" padding="lg" direction="column" align="stretch" gap="sm">
            <Text size="md" emphasis>
              Nuri V4 Checks
            </Text>
            <View direction="row" justify="between" gap="md">
              <Text size="md" muted>
                Server version
              </Text>
              <Text size="md">{formatHealthServerVersion(health)}</Text>
            </View>
            <View direction="row" justify="between" gap="md">
              <Text size="md" muted>
                Server API
              </Text>
              <Text size="md">{health?.nuri_server_api || "not checked"}</Text>
            </View>
            <View direction="row" justify="between" gap="md">
              <Text size="md" muted>
                Nuri contract
              </Text>
              <Text size="md">{health?.nuri_contract_version || NURI_CONTRACT_VERSION}</Text>
            </View>
            <View direction="row" justify="between" gap="md">
              <Text size="md" muted>
                Nuri server CSV
              </Text>
              <Text size="md">{serverCsvLabel}</Text>
            </View>
            <View direction="row" justify="between" gap="md">
              <Text size="md" muted>
                Wallet CSV
              </Text>
              <Text size="md">{walletSummary?.recoveryCsvStatus || "not checked"}</Text>
            </View>
            <View direction="row" justify="between" gap="md">
              <Text size="md" muted>
                Passkey policy
              </Text>
              <Text size="md">{recoverySummary?.passkeyPubkeyPolicy || "not checked"}</Text>
            </View>
            <View direction="row" justify="between" gap="md">
              <Text size="md" muted>
                Recovery
              </Text>
              <Text size="md">{recoverySummary?.status || "not checked"}</Text>
            </View>
            <View direction="row" justify="between" gap="md">
              <Text size="md" muted>
                Identity
              </Text>
              <Text size="md">{identitySummary?.status || "not checked"}</Text>
            </View>
            <View direction="row" justify="between" gap="md">
              <Text size="md" muted>
                VTXO read
              </Text>
              <Text size="md">
                {vtxoReadWarning ? "warning" : walletLoaded ? "ok" : "not checked"}
              </Text>
            </View>
            <View direction="row" justify="between" gap="md">
              <Text size="md" muted>
                Contracts
              </Text>
              <Text size="md">{walletSummary?.contractDiagnosticsStatus || "not checked"}</Text>
            </View>
            {vtxoReadWarning ? (
              <View variant="soft" accent="orange" radius="md" padding="md" align="stretch">
                <Text size="sm">{compactUiText(vtxoReadWarning, 240)}</Text>
              </View>
            ) : null}
            {contractWarning ? (
              <View variant="soft" accent="orange" radius="md" padding="md" align="stretch">
                <Text size="sm">{compactUiText(contractWarning, 260)}</Text>
              </View>
            ) : null}
            <Text size="sm" muted>
              {compactUiText(
                walletSummary?.recoveryCsvDetail || "Load wallet to check policy.",
                220,
              )}
            </Text>
          </View>

          <View variant="soft" radius="lg" padding="lg" direction="column" align="stretch" gap="sm">
            <Text size="md" emphasis>
              Unlock Wallet
            </Text>
            <Text size="md" emphasis>
              {unlockState.status.replace(/_/g, " ")}
            </Text>
            <Text size="sm" mono muted>
              actionable_count={unlockState.actionableCount} actionable_sats=
              {unlockState.actionableSats}
            </Text>
            <Text size="sm" mono muted>
              ln_receive_pending_count={unlockState.lnReceivePendingCount}
            </Text>
            <Text size="sm" mono muted>
              ln_receive_claimable_count={unlockState.lnReceiveClaimableCount}
            </Text>
            <Text size="sm" mono muted>
              boarding_sweep_ready_count={unlockState.boardingSweepReadyCount}
            </Text>
            <Text size="sm" mono muted>
              arkade_wallet_pending_vtxo_count={unlockState.arkadeWalletPendingVtxoCount} (
              {unlockState.arkadeWalletPendingVtxoSats} sats)
            </Text>
            {unlockState.lastError ? (
              <View variant="soft" accent="orange" radius="md" padding="md" align="stretch">
                <Text size="sm" mono>
                  {compactUiText(unlockState.lastError, 260)}
                </Text>
              </View>
            ) : null}
            <Button
              size="sm"
              variant="solid"
              accent="lilac"
              onPress={handleUnlockWallet}
              disabled={running || unlockState.actionableCount <= 0}
            >
              <ButtonText>Run Unlock Wallet</ButtonText>
            </Button>
          </View>

          <View variant="soft" radius="lg" padding="lg" direction="column" align="stretch" gap="sm">
            <Text size="md" emphasis>
              Pending TX Rescue
            </Text>
            <Text size="sm" muted>
              Finalizes sends that were submitted but never finalized (stranded funds). Asks the
              server for pending txs and co-signs their checkpoints — one passkey prompt.
            </Text>
            <Button
              size="sm"
              variant="solid"
              accent="lilac"
              onPress={handleRescuePendingTxs}
              disabled={running || !walletLoaded}
            >
              <ButtonText>Rescue Pending TXs</ButtonText>
            </Button>
          </View>

          <View variant="soft" radius="lg" padding="lg" direction="column" align="stretch" gap="sm">
            <Text size="md" emphasis>
              Settle Preconfirmed VTXOs
            </Text>
            <Text size="sm" muted>
              Joins the operator's next batch round so "Finalizing" VTXOs become settled — until
              then they are not part of the spendable balance. Auto-settle is off, so this is the
              only way to trigger it. One passkey prompt.
            </Text>
            <Button
              size="sm"
              variant="solid"
              accent="lilac"
              onPress={handleSettlePreconfirmed}
              disabled={running || !walletLoaded}
            >
              <ButtonText>Settle Preconfirmed</ButtonText>
            </Button>
          </View>

          <View variant="soft" radius="lg" padding="lg" direction="column" align="stretch" gap="sm">
            <Text size="md" emphasis>
              Deprecated Signer Migration
            </Text>
            {deprecatedReports === null ? (
              <Text size="sm" muted>
                Run check to query funds under deprecated signers.
              </Text>
            ) : deprecatedReports.length === 0 ? (
              <Text size="sm" muted>
                No funds under a deprecated signer.
              </Text>
            ) : (
              deprecatedReports.map((r) => (
                <Text key={r.signerPubKey} size="sm" mono muted>
                  {r.signerPubKey.slice(0, 14)}… status={r.status} vtxos={r.vtxoCount} (
                  {r.totalValue} sats) boarding={r.boardingCount} ({r.boardingValue} sats)
                  secsToCutoff=
                  {r.secondsUntilCutoff ?? "n/a"}
                </Text>
              ))
            )}
            {deprecatedAddrs ? (
              <>
                <Text size="sm" muted>
                  Current boarding (active signer):
                </Text>
                <Text size="sm" mono>
                  {deprecatedAddrs.currentBoardingAddress}
                </Text>
                <Text size="sm" muted>
                  Deprecated signer: {deprecatedAddrs.deprecatedSignerPubKey || "none advertised"}
                </Text>
                <Text size="sm" muted>
                  Deprecated boarding (check onchain for funds):
                </Text>
                <Text size="sm" mono>
                  {deprecatedAddrs.deprecatedBoardingAddress || "n/a"}
                </Text>
              </>
            ) : null}
            <Button
              size="sm"
              variant="solid"
              accent="lilac"
              onPress={handleCheckDeprecatedSigner}
              disabled={running}
            >
              <ButtonText>Check Deprecated Signer</ButtonText>
            </Button>
            <Button
              size="sm"
              variant="solid"
              accent="lilac"
              onPress={handleDeriveDeprecatedBoarding}
              disabled={running}
            >
              <ButtonText>Derive Deprecated Boarding Addr</ButtonText>
            </Button>
            {deprecatedVtxos ? (
              <Text size="sm" muted>
                Deprecated ark vtxos: {deprecatedVtxos.vtxoCount} ({deprecatedVtxos.totalValueSats}{" "}
                sats) · spendable {deprecatedVtxos.spendableCount} (
                {deprecatedVtxos.spendableValueSats} sats)
              </Text>
            ) : null}
            <Button
              size="sm"
              variant="solid"
              accent="lilac"
              onPress={handleProbeDeprecatedVtxos}
              disabled={running}
            >
              <ButtonText>Probe Deprecated VTXOs (in arkade)</ButtonText>
            </Button>
            <Button
              size="sm"
              variant="solid"
              accent="lilac"
              onPress={handleMigrateDeprecatedSigner}
              disabled={running || !deprecatedHasFunds}
            >
              <ButtonText>Sweep Deprecated → My Wallet</ButtonText>
            </Button>
          </View>

          <View variant="soft" radius="lg" padding="lg" direction="column" align="stretch" gap="sm">
            <Text size="md" emphasis>
              Receive State
            </Text>
            <Text size="md" emphasis>
              {formatReceiveStageLabel(receiveStage.status)}
            </Text>
            <Text size="sm" muted>
              {compactUiText(receiveStage.detail || "No pending receive activity.", 220)}
            </Text>
            <Text size="sm" muted>
              LN receive pending: {receiveStage.pendingCount}
            </Text>
            <Text size="sm" muted>
              LN receive claimable: {receiveStage.claimableCount}
            </Text>
            <Text size="sm" muted>
              Wallet pending VTXOs: {walletSummary?.debugPendingVtxoCount || 0} (
              {walletSummary?.debugPendingVtxoTotalSats || "0"} sats)
            </Text>
            <Text size="sm" muted>
              LN receive rows: {pendingSwaps.length}
            </Text>
            {pendingSwaps.slice(0, 3).map((swap) => (
              <Text key={swap.id} size="sm" mono muted>
                {swap.amountSats} sats · {swap.status || "n/a"} · {shortId(swap.id)}
              </Text>
            ))}
          </View>

          <View direction="row" gap="sm" distribute="even">
            <Button
              size="sm"
              variant="solid"
              accent="lilac"
              onPress={handleLoadWallet}
              disabled={running}
            >
              <ButtonText>{running ? "Loading" : "Refresh Wallet"}</ButtonText>
            </Button>
            <Button size="sm" variant="soft" onPress={handleCopyLogs}>
              <ButtonText>Copy Logs</ButtonText>
            </Button>
          </View>

          <View variant="soft" radius="lg" padding="lg" direction="column" align="stretch" gap="sm">
            <View direction="row" align="center" justify="between" gap="sm">
              <Text size="md" emphasis>
                Action Log
              </Text>
              <Button size="sm" variant="soft" onPress={handleClearLogs}>
                <ButtonText>Clear</ButtonText>
              </Button>
            </View>
            <ScrollView
              style={styles.logsViewport}
              contentContainerStyle={styles.logViewportContent}
              nestedScrollEnabled
            >
              {visibleLogs.length === 0 ? (
                <Text size="sm" mono muted>
                  No logs yet.
                </Text>
              ) : (
                visibleLogs.map((line, idx) => (
                  <Text key={`${idx}-${line.slice(0, 14)}`} size="sm" mono>
                    {line}
                  </Text>
                ))
              )}
            </ScrollView>
          </View>
        </View>
      </Scroll>

      {running ? (
        <RNView style={styles.loadingOverlay}>
          <Spinner />
        </RNView>
      ) : null}
    </DsSheetHost>
  );
};

const styles = StyleSheet.create({
  sendTargetInput: {
    minHeight: 86,
  },
  logsViewport: {
    maxHeight: 260,
  },
  logViewportContent: {
    gap: 4,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(240, 240, 240, 0.53)",
  },
});

export default DebugArkadeModal;
