import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking, Platform } from "react-native";
import * as Clipboard from "expo-clipboard";
import { WebView, WebViewMessageEvent } from "react-native-webview";
import { privateKeyToAccount } from "viem/accounts";
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
import { styles } from "./DebugWirexSignUpModal.styles";
import SumsubWebModal from "../../components/SumsubWebModal";
import { getPrivateKey } from "../../lib/secureKeyStorage";
import { bytesToHex, zeroize } from "../../lib/crypto";
import { WALLET_RP_ID } from "../../config/passkey";
import {
  bootstrapWirexAaOnDeviceSelfhost,
  normalizePasskeyPublicKeyForAaBootstrapSelfhost,
} from "../../lib/wirex/aaBootstrapSelfhost";
import { inspectSelfhostWirexAaReadiness } from "../../lib/wirex/aaSelfhostClient";
import { sendSponsoredAaTokenTransferSelfhost } from "../../lib/wirex/aaSelfhostTransfer";
import { runWirexDebugFlowSteps } from "../../lib/wirex/debugFlowRunner";
import { type WirexIssuedCard, wirexService } from "../../services/wirex/WirexService";
import { errMsg } from "../../lib/errorMessage";
import {
  createWalletPasskey,
  useExistingWalletPasskey,
} from "../../services/auth/PasskeyNativeModuleService";
import {
  buildWirexSandboxEmail,
  checkWirexProxyHealth,
  getWirexDebugOnboardingProgress,
  runWirexDebugCreateCardRecipientFromCard,
  runWirexDebugMintSandboxBalance,
  runWirexDebugOnboarding,
  runWirexDebugPushToCardFlow,
  runWirexDebugPushToCard,
} from "../../lib/wirex/createUser";
import { authStateManager } from "../../services/auth/AuthStateService";
import type { DebugWirexSignUpProps, AaPendingCredential } from "../../types/debug";
type Props = DebugWirexSignUpProps;

import {
  COUNTRY,
  CHAIN_ID,
  BANK_ACCOUNT_TYPE,
  HARDCODED_WIREX_PROXY_URL,
  DEFAULT_BASE_SEPOLIA_PUBLIC_RPC_URL,
  DEFAULT_SELFHOST_BUNDLER_RPC_URL,
  DEFAULT_SELFHOST_PAYMASTER_ADDRESS,
  DEFAULT_WIREX_SUMSUB_CLIENT_ID,
  DEFAULT_PUSH_TO_CARD_AMOUNT,
  DEFAULT_PUSH_TO_CARD_CURRENCY,
  DEFAULT_PUSH_CARD_NUMBER,
  DEFAULT_PUSH_CARDHOLDER_NAME,
  DEFAULT_PUSH_CARD_LABEL,
  WALLET_PASSKEY_PRF_SALT,
  STAGE_DONE,
  STAGE_ACTION,
  STAGE_PENDING,
  STAGE_FAILED,
  LIVE_PROGRESS_POLL_MS,
  AA_BOOTSTRAP_RETRY_DELAY_MS,
  AA_ONBOARDING_SYNC_RETRY_MAX,
  AA_BOOTSTRAP_RETRY_MAX,
  AA_CREATE_BOOTSTRAP_PASSES_MAX,
  PASSKEY_CAPTURE_DEFAULT_HINT,
  type StageState,
} from "../../lib/wirex/debugConfig";
import {
  sanitizePasskeyUserName,
  normalizePasskeyKeyBase,
  buildPasskeyKeyBase,
  buildPasskeyKeyLabel,
} from "../../lib/wirex/passkeyUtils";
import {
  HARDWARE_KEY_CAPTURE_WEBVIEW_HTML,
  PASSKEY_METADATA_CAPTURE_WEBVIEW_HTML,
} from "../../lib/wirex/webViewHTML";
import {
  shortAddress,
  isHexAddress,
  asObject,
  asArray,
  asString,
  asNumber,
  waitMs,
  truncateMiddle,
  readArray,
  toVisibleText,
  extractSumsubClientIdFromKycUrl,
} from "../../lib/wirex/debugHelpers";
import {
  buildHttpErrorDigest,
  shouldRetryAaBootstrapError,
  shouldAutoRetryAaBootstrapError,
  shouldKeepPendingAaCredentialAfterError,
  getAaBootstrapRetryDelayMs,
} from "../../lib/wirex/errorHandling";
import {
  getStageLabel,
  getFriendlyStepName,
  formatBackendStage,
  isLocalProxyUrl,
} from "../../lib/wirex/stageFormatting";
import {
  isStepHealthy,
  hasActiveSepa,
  hasActiveCard,
  getKycSdkTokenFromPayload,
  needsOnDeviceAaBootstrap,
} from "../../lib/wirex/onboardingAnalysis";
import {
  aaBootstrapStageLabel,
  formatAaBootstrapError,
  attachAaBootstrapSummary,
} from "../../lib/wirex/aaBootstrapFormatting";
import {
  buildOnboardingSummary,
  buildProvisioningSummary,
  buildPushFlowSummary,
  buildPushMintSummary,
  buildPushSummary,
  buildPushRecipientSummary,
  buildAaSponsoredSendSummary,
  buildWirexRunAllSummary,
} from "../../lib/wirex/summaryBuilding";
import { getSumsubSdk } from "../../lib/sumsub/sumsubSdk";

const BASE_SEPOLIA_ADDRESS_EXPLORER_BASE_URL = "https://sepolia.basescan.org/address/";

const DebugWirexSignUpModal: React.FC<Props> = ({ visible, onClose, walletAddress }) => {
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [proxyBaseUrl, setProxyBaseUrl] = useState<string>(HARDCODED_WIREX_PROXY_URL);
  const [aaPublicRpcUrl, setAaPublicRpcUrl] = useState<string>(DEFAULT_BASE_SEPOLIA_PUBLIC_RPC_URL);
  const [aaBundlerRpcUrl, setAaBundlerRpcUrl] = useState<string>(DEFAULT_SELFHOST_BUNDLER_RPC_URL);
  const [aaPaymasterAddress, setAaPaymasterAddress] = useState<string>(
    DEFAULT_SELFHOST_PAYMASTER_ADDRESS,
  );
  const [sharingToken, setSharingToken] = useState<string>("");
  const [wirexSumsubClientId, setWirexSumsubClientId] = useState<string>(
    DEFAULT_WIREX_SUMSUB_CLIENT_ID,
  );
  const [snapshot, setSnapshot] = useState<string>("");
  const [isPushLoading, setIsPushLoading] = useState(false);
  const [isPushRecipientLoading, setIsPushRecipientLoading] = useState(false);
  const [isPushMintLoading, setIsPushMintLoading] = useState(false);
  const [isPushFlowLoading, setIsPushFlowLoading] = useState(false);
  const [pushResult, setPushResult] = useState<string>("");
  const [pushError, setPushError] = useState<string>("");
  const [pushMintResult, setPushMintResult] = useState<string>("");
  const [pushMintError, setPushMintError] = useState<string>("");
  const [pushRecipientResult, setPushRecipientResult] = useState<string>("");
  const [pushRecipientError, setPushRecipientError] = useState<string>("");
  const [pushFlowResult, setPushFlowResult] = useState<string>("");
  const [pushFlowError, setPushFlowError] = useState<string>("");
  const [onboardingSummary, setOnboardingSummary] = useState<string>("");
  const [provisioningSummary, setProvisioningSummary] = useState<string>("");
  const [pushSummary, setPushSummary] = useState<string>("");
  const [pushMintSummary, setPushMintSummary] = useState<string>("");
  const [pushRecipientSummary, setPushRecipientSummary] = useState<string>("");
  const [pushFlowSummary, setPushFlowSummary] = useState<string>("");
  const [onboardingPayload, setOnboardingPayload] = useState<Record<string, unknown> | null>(null);
  const [pushPayload, setPushPayload] = useState<Record<string, unknown> | null>(null);
  const [pushMintPayload, setPushMintPayload] = useState<Record<string, unknown> | null>(null);
  const [pushRecipientPayload, setPushRecipientPayload] = useState<Record<string, unknown> | null>(
    null,
  );
  const [pushFlowPayload, setPushFlowPayload] = useState<Record<string, unknown> | null>(null);
  const [showRawOnboarding, setShowRawOnboarding] = useState(false);
  const [showRawSnapshot, setShowRawSnapshot] = useState(false);
  const [showRawPush, setShowRawPush] = useState(false);
  const [showRawPushMint, setShowRawPushMint] = useState(false);
  const [showRawPushRecipient, setShowRawPushRecipient] = useState(false);
  const [showRawPushFlow, setShowRawPushFlow] = useState(false);
  const [kycUrl, setKycUrl] = useState<string | null>(null);
  const [kycSdkToken, setKycSdkToken] = useState<string | null>(null);
  const [isKycModalVisible, setIsKycModalVisible] = useState(false);
  const [sharingSource, setSharingSource] = useState<"manual" | "none">("none");
  const [pushExternalCardId, setPushExternalCardId] = useState<string>("");
  const [pushCardNumber, setPushCardNumber] = useState<string>(DEFAULT_PUSH_CARD_NUMBER);
  const [pushCardholderName, setPushCardholderName] = useState<string>(
    DEFAULT_PUSH_CARDHOLDER_NAME,
  );
  const [pushCardLabel, setPushCardLabel] = useState<string>(DEFAULT_PUSH_CARD_LABEL);
  const [pushTokenAddress, setPushTokenAddress] = useState<string>("");
  const [pushAmount, setPushAmount] = useState<string>(DEFAULT_PUSH_TO_CARD_AMOUNT);
  const [pushCurrency, setPushCurrency] = useState<string>(DEFAULT_PUSH_TO_CARD_CURRENCY);
  const [copyStatus, setCopyStatus] = useState<string>("");
  const [proxyHealthStatus, setProxyHealthStatus] = useState<string>("unchecked");
  const [isCheckingProxy, setIsCheckingProxy] = useState(false);
  // Raw Wirex user profile (GET /api/v2/user via the eligibility route) — shows
  // the email/phone_number Wirex holds (the ones Apple's card verification uses).
  const [profileDump, setProfileDump] = useState<string>("");
  const [isDumpingProfile, setIsDumpingProfile] = useState(false);
  // Read-only /status card list — the shape the carousel is built from, verbatim.
  const [statusCardsDump, setStatusCardsDump] = useState<string>("");
  const [isDumpingStatusCards, setIsDumpingStatusCards] = useState(false);
  // Issue-an-extra-virtual-card result (POST /card/virtual + the /status re-read).
  const [virtualCardDump, setVirtualCardDump] = useState<string>("");
  const [isIssuingVirtualCard, setIsIssuingVirtualCard] = useState(false);
  // Permanent close (POST /card/close). `closeCardId` is typed in by hand and the
  // confirm arms the action — the signature prompt IS the point of no return.
  const [closeCardId, setCloseCardId] = useState<string>("");
  // Signed and re-checked against Wirex, so it must match what /status shows.
  const [closeCardLast4, setCloseCardLast4] = useState<string>("");
  const [closeArmed, setCloseArmed] = useState(false);
  const [closeCardDump, setCloseCardDump] = useState<string>("");
  const [isClosingCard, setIsClosingCard] = useState(false);
  const [loadingStageText, setLoadingStageText] = useState<string>("");
  const [requestStartedAtMs, setRequestStartedAtMs] = useState<number | null>(null);
  const [requestElapsedSec, setRequestElapsedSec] = useState(0);
  const [liveBackendProgress, setLiveBackendProgress] = useState<Record<string, unknown> | null>(
    null,
  );
  const [liveBackendError, setLiveBackendError] = useState<string>("");
  const [walletPasskeyCredIdB64u, setWalletPasskeyCredIdB64u] = useState<string>("");
  const [walletPasskeyCredPubkeyB64u, setWalletPasskeyCredPubkeyB64u] = useState<string>("");
  const [passkeyKeyUserName, setPasskeyKeyUserName] = useState<string>("");
  const [passkeyKeyBaseOverride, setPasskeyKeyBaseOverride] = useState<string>("");
  const [storedPasskeyKeyBase, setStoredPasskeyKeyBase] = useState<string>("");
  const [passkeyCaptureCreateKeyIndex, setPasskeyCaptureCreateKeyIndex] = useState<1 | 2>(1);
  const [tempCredPubkeyForAaBootstrap, setTempCredPubkeyForAaBootstrap] = useState<string>("");
  const [lastResolvedSharingToken, setLastResolvedSharingToken] = useState<string>("");
  const [lastResolvedSharingTokenSource, setLastResolvedSharingTokenSource] = useState<
    "manual" | "none"
  >("none");
  const [sharingTokenFetchError, setSharingTokenFetchError] = useState<string>("");
  const [isPasskeyCaptureVisible, setIsPasskeyCaptureVisible] = useState<boolean>(false);
  const [isPasskeyCaptureRunning, setIsPasskeyCaptureRunning] = useState<boolean>(false);
  const [passkeyCaptureError, setPasskeyCaptureError] = useState<string>("");
  const [passkeyCaptureHint, setPasskeyCaptureHint] = useState<string>(
    PASSKEY_CAPTURE_DEFAULT_HINT,
  );
  const [passkeyCaptureLog, setPasskeyCaptureLog] = useState<string>("");
  const [aaTraceLog, setAaTraceLog] = useState<string>("");
  const [onboardingErrorRaw, setOnboardingErrorRaw] = useState<string>("");
  const liveProgressPollingRef = useRef(false);
  const passkeyWebViewRef = useRef<WebView>(null);
  const passkeyCaptureResolverRef = useRef<
    | ((
        value: {
          credId: string;
          credPubkey: string;
          keyLabel?: string;
          source: "native_existing" | "native_created" | "web_existing" | "web_created";
        } | null,
      ) => void)
    | null
  >(null);
  const [passkeyWebauthnUnsupported, setPasskeyWebauthnUnsupported] = useState<boolean>(false);
  const [passkeyCaptureSessionKey, setPasskeyCaptureSessionKey] = useState<number>(0);
  const [passkeyWebAutoTriggerExisting, setPasskeyWebAutoTriggerExisting] =
    useState<boolean>(false);
  const [passkeyWebviewKey, setPasskeyWebviewKey] = useState<number>(0);
  const [webAuthnCaptureMode, setWebAuthnCaptureMode] = useState<"passkey" | "hardware">("passkey");
  const [passkeyCaptureIntent, setPasskeyCaptureIntent] = useState<"metadata" | "auth_only">(
    "metadata",
  );
  const [isAaPasskeySignTestLoading, setIsAaPasskeySignTestLoading] = useState(false);
  const [isAaAddCredentialLoading, setIsAaAddCredentialLoading] = useState(false);
  const [isAaReadinessLoading, setIsAaReadinessLoading] = useState(false);
  const [isAaSponsoredSendLoading, setIsAaSponsoredSendLoading] = useState(false);
  const [isRunAllLoading, setIsRunAllLoading] = useState(false);
  const [aaAddCredentialSummary, setAaAddCredentialSummary] = useState<string>("");
  const [aaAddCredentialResult, setAaAddCredentialResult] = useState<string>("");
  const [aaAddCredentialError, setAaAddCredentialError] = useState<string>("");
  const [showRawAaAddCredential, setShowRawAaAddCredential] = useState(false);
  const [pendingAaCredential, setPendingAaCredential] = useState<AaPendingCredential | null>(null);
  const [aaPasskeySignTestSummary, setAaPasskeySignTestSummary] = useState<string>("");
  const [aaPasskeySignTestResult, setAaPasskeySignTestResult] = useState<string>("");
  const [aaPasskeySignTestError, setAaPasskeySignTestError] = useState<string>("");
  const [showRawAaPasskeySignTest, setShowRawAaPasskeySignTest] = useState(false);
  const [aaReadinessSummary, setAaReadinessSummary] = useState<string>("");
  const [aaReadinessResult, setAaReadinessResult] = useState<string>("");
  const [aaReadinessError, setAaReadinessError] = useState<string>("");
  const [showRawAaReadiness, setShowRawAaReadiness] = useState(false);
  const [aaSponsoredSendRecipient, setAaSponsoredSendRecipient] = useState<string>("");
  const [aaSponsoredSendTokenAddress, setAaSponsoredSendTokenAddress] = useState<string>("");
  const [aaSponsoredSendAmount, setAaSponsoredSendAmount] = useState<string>(
    DEFAULT_PUSH_TO_CARD_AMOUNT,
  );
  const [aaSponsoredSendSummary, setAaSponsoredSendSummary] = useState<string>("");
  const [aaSponsoredSendResult, setAaSponsoredSendResult] = useState<string>("");
  const [aaSponsoredSendError, setAaSponsoredSendError] = useState<string>("");
  const [showRawAaSponsoredSend, setShowRawAaSponsoredSend] = useState(false);
  const [runAllSummary, setRunAllSummary] = useState<string>("");
  const [runAllResult, setRunAllResult] = useState<string>("");
  const [runAllError, setRunAllError] = useState<string>("");
  const [showRawRunAll, setShowRawRunAll] = useState(false);
  const [lastAaAddress, setLastAaAddress] = useState<string>("");
  const [lastKernelAddress, setLastKernelAddress] = useState<string>("");
  const [lastPermissionId, setLastPermissionId] = useState<string>("");

  const normalizedWallet = useMemo(() => String(walletAddress || "").trim(), [walletAddress]);
  const sanitizedPasskeyUserName = useMemo(
    () => sanitizePasskeyUserName(passkeyKeyUserName),
    [passkeyKeyUserName],
  );
  const normalizedPasskeyKeyBaseOverride = useMemo(
    () => normalizePasskeyKeyBase(passkeyKeyBaseOverride),
    [passkeyKeyBaseOverride],
  );
  const normalizedStoredPasskeyKeyBase = useMemo(
    () => normalizePasskeyKeyBase(storedPasskeyKeyBase),
    [storedPasskeyKeyBase],
  );

  const resolvePasskeyCreateLabelConfig = useCallback(
    (keyIndex: 1 | 2) => {
      let base = normalizedStoredPasskeyKeyBase || normalizedPasskeyKeyBaseOverride || "";
      if (!base && keyIndex === 1 && sanitizedPasskeyUserName) {
        base = buildPasskeyKeyBase(sanitizedPasskeyUserName, new Date());
      }
      const label = buildPasskeyKeyLabel(base, keyIndex);
      if (!label) {
        return {
          ok: false,
          keyIndex,
          base: "",
          label: "",
          error:
            keyIndex === 2
              ? "Key2 requires the original key base (YYMMDD-Nuri-UserName)."
              : "Enter a user name to build Key1 label.",
          createButtonText: "Create wallet passkey",
          existingButtonText: "Use existing Nuri Wallet Passkey",
        } as const;
      }
      return {
        ok: true,
        keyIndex,
        base,
        label,
        error: "",
        createButtonText: `Create ${keyIndex === 2 ? "Key2" : "Key1"} passkey`,
        existingButtonText: "Use existing Nuri Wallet Passkey",
      } as const;
    },
    [normalizedPasskeyKeyBaseOverride, normalizedStoredPasskeyKeyBase, sanitizedPasskeyUserName],
  );

  const passkeyCreateLabelConfig = useMemo(
    () => resolvePasskeyCreateLabelConfig(passkeyCaptureCreateKeyIndex),
    [passkeyCaptureCreateKeyIndex, resolvePasskeyCreateLabelConfig],
  );
  const isPasskeyBaseLockedForKey2 = useMemo(
    () => passkeyCaptureCreateKeyIndex === 2 && Boolean(normalizedStoredPasskeyKeyBase),
    [passkeyCaptureCreateKeyIndex, normalizedStoredPasskeyKeyBase],
  );
  useEffect(() => {
    if (!visible) return;
    if (normalizedWallet && !aaSponsoredSendRecipient.trim()) {
      setAaSponsoredSendRecipient(normalizedWallet);
    }
  }, [aaSponsoredSendRecipient, normalizedWallet, visible]);
  useEffect(() => {
    if (!visible) return;
    const normalizedPushToken = pushTokenAddress.trim();
    if (normalizedPushToken && !aaSponsoredSendTokenAddress.trim()) {
      setAaSponsoredSendTokenAddress(normalizedPushToken);
    }
  }, [aaSponsoredSendTokenAddress, pushTokenAddress, visible]);
  useEffect(() => {
    if (!visible) {
      return;
    }
    let canceled = false;
    (async () => {
      try {
        await authStateManager.initialize();
        if (canceled) {
          return;
        }
        const authState = authStateManager.getState();
        const keys = authState.walletPublicKeys;
        const storedCredId = asString(keys?.walletPasskeyCredIdB64u).trim();
        const storedCredPubkey = asString(keys?.walletPasskeyCredPubkeyB64u).trim();
        const storedKeyBase = normalizePasskeyKeyBase(
          asString(authState.walletPasskeyNameBase).trim(),
        );
        if (storedCredId) {
          setWalletPasskeyCredIdB64u((prev) => prev.trim() || storedCredId);
        }
        if (storedCredPubkey) {
          setWalletPasskeyCredPubkeyB64u((prev) => prev.trim() || storedCredPubkey);
        }
        setStoredPasskeyKeyBase(storedKeyBase || "");
      } catch {
        // Keep modal flow resilient even if auth-state preload fails.
      }
    })();
    return () => {
      canceled = true;
    };
  }, [visible]);
  const appendPasskeyCaptureLog = useCallback((message: string) => {
    const stamp = new Date().toISOString().slice(11, 19);
    const line = `[${stamp}] ${message}`;
    console.log("[WirexDebug][passkey]", line);
    setPasskeyCaptureLog((prev) => {
      const next = prev ? `${prev}\n${line}` : line;
      const lines = next.split("\n");
      return lines.slice(-18).join("\n");
    });
  }, []);
  const appendAaTraceLog = useCallback((message: string) => {
    const stamp = new Date().toISOString().slice(11, 19);
    const line = `[${stamp}] ${message}`;
    console.log("[WirexDebug][trace]", line);
    setAaTraceLog((prev) => {
      const next = prev ? `${prev}\n${line}` : line;
      const lines = next.split("\n");
      return lines.slice(-40).join("\n");
    });
  }, []);
  const persistPasskeyKeyBase = useCallback(async (valueRaw: string) => {
    const normalized = normalizePasskeyKeyBase(valueRaw);
    if (!normalized) return;
    setStoredPasskeyKeyBase(normalized);
    try {
      await authStateManager.setWalletPasskeyNameBase(normalized);
    } catch {
      // Keep naming flow resilient even if storage write fails.
    }
  }, []);
  const normalizeAaPasskeyPublicKey = useCallback((valueRaw: string) => {
    const value = asString(valueRaw).trim();
    if (!value) {
      return {
        ok: false as const,
        normalized: "",
        sourceFormat: "missing",
        error: "missing_wallet_passkey_public_key",
      };
    }
    try {
      const normalized = normalizePasskeyPublicKeyForAaBootstrapSelfhost(value);
      return {
        ok: true as const,
        normalized: normalized.normalizedPublicKeyB64u,
        sourceFormat: normalized.sourceFormat,
        error: "",
      };
    } catch (error: unknown) {
      const message = errMsg(error);
      return {
        ok: false as const,
        normalized: "",
        sourceFormat: "invalid",
        error: message,
      };
    }
  }, []);
  const email = useMemo(() => buildWirexSandboxEmail(normalizedWallet), [normalizedWallet]);
  const usefulCopyPayload = useMemo(() => {
    const nowIso = new Date().toISOString();
    const root = asObject(liveBackendProgress);
    const steps = asArray(root?.steps)
      .map((value) => asObject(value))
      .filter(Boolean) as Record<string, unknown>[];
    const stepLines = steps
      .slice(-12)
      .map((step) => {
        const ok = step.ok === true ? "ok" : "issue";
        const name = asString(step.name, "unknown_step");
        const status = asNumber(step.status);
        const note = asString(step.note);
        return [
          ok,
          getFriendlyStepName(name),
          status !== null ? `(${status})` : "",
          note ? `- ${note}` : "",
        ]
          .filter(Boolean)
          .join(" ");
      })
      .filter(Boolean);
    const liveBackendDigest = [
      "LIVE BACKEND",
      `status: ${asString(root?.status, "unknown")}`,
      `stage: ${formatBackendStage(asString(root?.stage, "idle"))}`,
      `error: ${asString(root?.error, "none") || "none"}`,
      `elapsedMs: ${String(root?.elapsedMs ?? "unknown")}`,
      stepLines.length ? "steps:" : "",
      ...stepLines,
    ]
      .filter(Boolean)
      .join("\n");

    const onboardingErrorDigest = buildHttpErrorDigest(onboardingErrorRaw.trim() || error.trim());
    const aaAddCredentialErrorDigest = buildHttpErrorDigest(aaAddCredentialError.trim());
    const aaPasskeySignTestErrorDigest = buildHttpErrorDigest(aaPasskeySignTestError.trim());
    const pendingAaCredentialAgeSec =
      pendingAaCredential && pendingAaCredential.capturedAtMs > 0
        ? Math.max(0, Math.floor((Date.now() - pendingAaCredential.capturedAtMs) / 1000))
        : 0;

    const runtimeSummary = [
      "RUNTIME",
      `generatedAt: ${nowIso}`,
      `wallet: ${normalizedWallet || "missing"}`,
      `loading: ${
        isLoading ||
        isPushLoading ||
        isPushRecipientLoading ||
        isPushMintLoading ||
        isPushFlowLoading
          ? "yes"
          : "no"
      }`,
      `stage: ${loadingStageText || "idle"}`,
      `elapsedSec: ${String(requestElapsedSec)}`,
      `proxy: ${proxyBaseUrl.trim() || "missing"}`,
      `proxyHealth: ${proxyHealthStatus}`,
      "aaProvider: selfhost",
      `aaPublicRpc: ${aaPublicRpcUrl.trim() || "missing"}`,
      `aaBundlerRpc: ${aaBundlerRpcUrl.trim() || "missing"}`,
      `aaPaymaster: ${aaPaymasterAddress.trim() || "missing"}`,
      `lastEoaForAa: ${lastAaAddress || "none"}`,
      `lastAaAddress: ${lastKernelAddress || "none"}`,
      `lastPermissionId: ${lastPermissionId || "none"}`,
      `walletPasskeyCredIdLen: ${walletPasskeyCredIdB64u.length}`,
      `walletPasskeyCredPubLen: ${walletPasskeyCredPubkeyB64u.length}`,
      `tempCredPubkeyForAaBootstrapLen: ${tempCredPubkeyForAaBootstrap.length}`,
      `passkeyKeyBaseStored: ${normalizedStoredPasskeyKeyBase || "none"}`,
      `passkeyNextCreateLabel: ${passkeyCreateLabelConfig.label || "missing"}`,
      `pendingAaCredential: ${pendingAaCredential ? "yes" : "no"}`,
      `pendingAaCredentialCredIdLen: ${pendingAaCredential?.credId.length || 0}`,
      `pendingAaCredentialCredPubLen: ${pendingAaCredential?.credPubkey.length || 0}`,
      `pendingAaCredentialAgeSec: ${pendingAaCredentialAgeSec}`,
      `passkeyCaptureVisible: ${isPasskeyCaptureVisible ? "yes" : "no"}`,
      `sharingTokenSource: ${lastResolvedSharingTokenSource}`,
      `sharingTokenLen: ${lastResolvedSharingToken.length}`,
    ].join("\n");

    const sections = [
      "USEFUL LOGS V1",
      runtimeSummary,
      liveBackendDigest,
      aaTraceLog.trim() ? `AA TRACE\n${aaTraceLog.trim()}` : "",
      passkeyCaptureLog.trim() ? `PASSKEY CAPTURE\n${passkeyCaptureLog.trim()}` : "",
      onboardingSummary.trim() ? `ONBOARDING SUMMARY\n${onboardingSummary.trim()}` : "",
      provisioningSummary.trim() ? `PROVISIONING SUMMARY\n${provisioningSummary.trim()}` : "",
      aaPasskeySignTestSummary.trim()
        ? `AA PASSKEY SIGN TEST SUMMARY\n${aaPasskeySignTestSummary.trim()}`
        : "",
      aaReadinessSummary.trim() ? `AA READINESS SUMMARY\n${aaReadinessSummary.trim()}` : "",
      aaSponsoredSendSummary.trim()
        ? `AA SPONSORED SEND SUMMARY\n${aaSponsoredSendSummary.trim()}`
        : "",
      runAllSummary.trim() ? `WIREX RUN-ALL SUMMARY\n${runAllSummary.trim()}` : "",
      aaAddCredentialSummary.trim()
        ? `AA ADD CREDENTIAL SUMMARY\n${aaAddCredentialSummary.trim()}`
        : "",
      onboardingErrorDigest ? `ONBOARDING ERROR DIGEST\n${onboardingErrorDigest}` : "",
      error.trim() ? `ONBOARDING ERROR\n${truncateMiddle(error.trim(), 2200)}` : "",
      onboardingErrorRaw.trim()
        ? `ONBOARDING ERROR RAW\n${truncateMiddle(onboardingErrorRaw.trim(), 3200)}`
        : "",
      aaPasskeySignTestErrorDigest
        ? `AA PASSKEY SIGN TEST ERROR DIGEST\n${aaPasskeySignTestErrorDigest}`
        : "",
      aaPasskeySignTestError.trim()
        ? `AA PASSKEY SIGN TEST ERROR\n${truncateMiddle(aaPasskeySignTestError.trim(), 2200)}`
        : "",
      aaReadinessError.trim()
        ? `AA READINESS ERROR\n${truncateMiddle(aaReadinessError.trim(), 2200)}`
        : "",
      aaSponsoredSendError.trim()
        ? `AA SPONSORED SEND ERROR\n${truncateMiddle(aaSponsoredSendError.trim(), 2200)}`
        : "",
      runAllError.trim() ? `WIREX RUN-ALL ERROR\n${truncateMiddle(runAllError.trim(), 2200)}` : "",
      aaAddCredentialErrorDigest
        ? `AA ADD CREDENTIAL ERROR DIGEST\n${aaAddCredentialErrorDigest}`
        : "",
      aaAddCredentialError.trim()
        ? `AA ADD CREDENTIAL ERROR\n${truncateMiddle(aaAddCredentialError.trim(), 2200)}`
        : "",
    ].filter(Boolean);
    return sections.join("\n\n");
  }, [
    aaAddCredentialError,
    aaAddCredentialSummary,
    aaPasskeySignTestError,
    aaPasskeySignTestSummary,
    aaPaymasterAddress,
    aaReadinessError,
    aaReadinessSummary,
    aaSponsoredSendError,
    aaSponsoredSendSummary,
    runAllError,
    runAllSummary,
    aaBundlerRpcUrl,
    aaPublicRpcUrl,
    aaTraceLog,
    error,
    isLoading,
    isPushFlowLoading,
    isPasskeyCaptureVisible,
    isPushMintLoading,
    isPushLoading,
    isPushRecipientLoading,
    lastAaAddress,
    lastKernelAddress,
    lastPermissionId,
    lastResolvedSharingToken,
    lastResolvedSharingTokenSource,
    liveBackendProgress,
    loadingStageText,
    normalizedWallet,
    onboardingErrorRaw,
    onboardingSummary,
    passkeyCaptureLog,
    passkeyCreateLabelConfig,
    provisioningSummary,
    proxyBaseUrl,
    proxyHealthStatus,
    requestElapsedSec,
    tempCredPubkeyForAaBootstrap,
    normalizedStoredPasskeyKeyBase,
    walletPasskeyCredIdB64u,
    walletPasskeyCredPubkeyB64u,
    pendingAaCredential,
  ]);
  const copyPayload = useMemo(() => {
    const liveBackendSummary = liveBackendProgress
      ? `LIVE BACKEND\n${JSON.stringify(liveBackendProgress, null, 2)}`
      : "";
    const onboardingErrorDigest = buildHttpErrorDigest(onboardingErrorRaw.trim() || error.trim());
    const aaAddCredentialErrorDigest = buildHttpErrorDigest(aaAddCredentialError.trim());
    const aaPasskeySignTestErrorDigest = buildHttpErrorDigest(aaPasskeySignTestError.trim());
    const pendingAaCredentialAgeSec =
      pendingAaCredential && pendingAaCredential.capturedAtMs > 0
        ? Math.max(0, Math.floor((Date.now() - pendingAaCredential.capturedAtMs) / 1000))
        : 0;
    const runtimeSummary = [
      "RUNTIME",
      `loading: ${
        isLoading ||
        isPushLoading ||
        isPushRecipientLoading ||
        isPushMintLoading ||
        isPushFlowLoading
          ? "yes"
          : "no"
      }`,
      `aaPasskeySignTestLoading: ${isAaPasskeySignTestLoading ? "yes" : "no"}`,
      `aaAddCredentialLoading: ${isAaAddCredentialLoading ? "yes" : "no"}`,
      `stage: ${loadingStageText || "idle"}`,
      `elapsedSec: ${String(requestElapsedSec)}`,
      `proxy: ${proxyBaseUrl.trim() || "missing"}`,
      `proxyHealth: ${proxyHealthStatus}`,
      "aaProvider: selfhost",
      `aaPublicRpc: ${aaPublicRpcUrl.trim() || "missing"}`,
      `aaBundlerRpc: ${aaBundlerRpcUrl.trim() || "missing"}`,
      `aaPaymaster: ${aaPaymasterAddress.trim() || "missing"}`,
      `lastEoaForAa: ${lastAaAddress || "none"}`,
      `lastAaAddress: ${lastKernelAddress || "none"}`,
      `lastPermissionId: ${lastPermissionId || "none"}`,
      `walletPasskeyCredIdLen: ${walletPasskeyCredIdB64u.length}`,
      `walletPasskeyCredPubLen: ${walletPasskeyCredPubkeyB64u.length}`,
      `tempCredPubkeyForAaBootstrapLen: ${tempCredPubkeyForAaBootstrap.length}`,
      `passkeyKeyBaseStored: ${normalizedStoredPasskeyKeyBase || "none"}`,
      `passkeyNextCreateLabel: ${passkeyCreateLabelConfig.label || "missing"}`,
      `pendingAaCredential: ${pendingAaCredential ? "yes" : "no"}`,
      `pendingAaCredentialCredIdLen: ${pendingAaCredential?.credId.length || 0}`,
      `pendingAaCredentialCredPubLen: ${pendingAaCredential?.credPubkey.length || 0}`,
      `pendingAaCredentialAgeSec: ${pendingAaCredentialAgeSec}`,
      `passkeyCaptureVisible: ${isPasskeyCaptureVisible ? "yes" : "no"}`,
      `sharingTokenSource: ${lastResolvedSharingTokenSource}`,
      `sharingTokenLen: ${lastResolvedSharingToken.length}`,
      `aaTraceLines: ${aaTraceLog.trim() ? aaTraceLog.trim().split("\n").length : 0}`,
    ].join("\n");
    const sections = [
      runtimeSummary,
      liveBackendSummary,
      aaTraceLog.trim() ? `AA TRACE\n${aaTraceLog.trim()}` : "",
      passkeyCaptureLog.trim() ? `PASSKEY CAPTURE\n${passkeyCaptureLog.trim()}` : "",
      result.trim() ? `ONBOARDING LOGS\n${result.trim()}` : "",
      snapshot.trim() ? `SNAPSHOT\n${snapshot.trim()}` : "",
      pushFlowResult.trim() ? `PUSH DEMO\n${pushFlowResult.trim()}` : "",
      pushResult.trim() ? `PUSH TO CARD\n${pushResult.trim()}` : "",
      pushMintResult.trim() ? `PUSH MINT\n${pushMintResult.trim()}` : "",
      pushRecipientResult.trim() ? `PUSH RECIPIENT FROM CARD\n${pushRecipientResult.trim()}` : "",
      aaPasskeySignTestResult.trim()
        ? `AA PASSKEY SIGN TEST\n${aaPasskeySignTestResult.trim()}`
        : "",
      aaReadinessResult.trim() ? `AA READINESS\n${aaReadinessResult.trim()}` : "",
      aaSponsoredSendResult.trim() ? `AA SPONSORED SEND\n${aaSponsoredSendResult.trim()}` : "",
      runAllResult.trim() ? `WIREX RUN-ALL\n${runAllResult.trim()}` : "",
      aaAddCredentialResult.trim() ? `AA ADD CREDENTIAL\n${aaAddCredentialResult.trim()}` : "",
      onboardingErrorDigest ? `ONBOARDING ERROR DIGEST\n${onboardingErrorDigest}` : "",
      error.trim() ? `ONBOARDING ERROR\n${error.trim()}` : "",
      onboardingErrorRaw.trim() ? `ONBOARDING ERROR RAW\n${onboardingErrorRaw.trim()}` : "",
      pushFlowError.trim() ? `PUSH DEMO ERROR\n${pushFlowError.trim()}` : "",
      pushError.trim() ? `PUSH ERROR\n${pushError.trim()}` : "",
      pushMintError.trim() ? `PUSH MINT ERROR\n${pushMintError.trim()}` : "",
      pushRecipientError.trim() ? `PUSH RECIPIENT ERROR\n${pushRecipientError.trim()}` : "",
      aaPasskeySignTestErrorDigest
        ? `AA PASSKEY SIGN TEST ERROR DIGEST\n${aaPasskeySignTestErrorDigest}`
        : "",
      aaPasskeySignTestError.trim()
        ? `AA PASSKEY SIGN TEST ERROR\n${aaPasskeySignTestError.trim()}`
        : "",
      aaReadinessError.trim() ? `AA READINESS ERROR\n${aaReadinessError.trim()}` : "",
      aaSponsoredSendError.trim() ? `AA SPONSORED SEND ERROR\n${aaSponsoredSendError.trim()}` : "",
      runAllError.trim() ? `WIREX RUN-ALL ERROR\n${runAllError.trim()}` : "",
      aaAddCredentialErrorDigest
        ? `AA ADD CREDENTIAL ERROR DIGEST\n${aaAddCredentialErrorDigest}`
        : "",
      aaAddCredentialError.trim() ? `AA ADD CREDENTIAL ERROR\n${aaAddCredentialError.trim()}` : "",
    ].filter(Boolean);
    return sections.join("\n\n");
  }, [
    aaAddCredentialError,
    aaAddCredentialResult,
    aaTraceLog,
    aaPasskeySignTestError,
    aaPasskeySignTestResult,
    aaPaymasterAddress,
    aaReadinessError,
    aaReadinessResult,
    aaSponsoredSendError,
    aaSponsoredSendResult,
    runAllError,
    runAllResult,
    aaBundlerRpcUrl,
    aaPublicRpcUrl,
    isAaAddCredentialLoading,
    isAaPasskeySignTestLoading,
    error,
    isLoading,
    isPushFlowLoading,
    isPushMintLoading,
    isPushLoading,
    isPushRecipientLoading,
    loadingStageText,
    liveBackendProgress,
    onboardingErrorRaw,
    proxyBaseUrl,
    proxyHealthStatus,
    pushFlowError,
    pushFlowResult,
    pushError,
    pushMintError,
    pushMintResult,
    pushRecipientError,
    pushResult,
    pushRecipientResult,
    requestElapsedSec,
    result,
    snapshot,
    passkeyCaptureLog,
    passkeyCreateLabelConfig,
    isPasskeyCaptureVisible,
    lastAaAddress,
    lastKernelAddress,
    lastPermissionId,
    lastResolvedSharingToken,
    lastResolvedSharingTokenSource,
    tempCredPubkeyForAaBootstrap,
    normalizedStoredPasskeyKeyBase,
    walletPasskeyCredIdB64u,
    walletPasskeyCredPubkeyB64u,
    pendingAaCredential,
  ]);
  const visibleResult = useMemo(() => toVisibleText(result), [result]);
  const visibleSnapshot = useMemo(() => toVisibleText(snapshot), [snapshot]);
  const visiblePushResult = useMemo(() => toVisibleText(pushResult), [pushResult]);
  const visiblePushMintResult = useMemo(() => toVisibleText(pushMintResult), [pushMintResult]);
  const visiblePushRecipientResult = useMemo(
    () => toVisibleText(pushRecipientResult),
    [pushRecipientResult],
  );
  const visiblePushFlowResult = useMemo(() => toVisibleText(pushFlowResult), [pushFlowResult]);
  const visibleAaPasskeySignTestResult = useMemo(
    () => toVisibleText(aaPasskeySignTestResult),
    [aaPasskeySignTestResult],
  );
  const visibleAaReadinessResult = useMemo(
    () => toVisibleText(aaReadinessResult),
    [aaReadinessResult],
  );
  const visibleAaAddCredentialResult = useMemo(
    () => toVisibleText(aaAddCredentialResult),
    [aaAddCredentialResult],
  );
  const visibleAaSponsoredSendResult = useMemo(
    () => toVisibleText(aaSponsoredSendResult),
    [aaSponsoredSendResult],
  );
  const visibleRunAllResult = useMemo(() => toVisibleText(runAllResult), [runAllResult]);
  const liveProgressView = useMemo(() => {
    const root = asObject(liveBackendProgress);
    const status = asString(root?.status, "unknown");
    const stage = formatBackendStage(asString(root?.stage, "idle"));
    const errorText = asString(root?.error);
    const steps = asArray(root?.steps)
      .map((value) => asObject(value))
      .filter(Boolean) as Record<string, unknown>[];
    const summary = asObject(root?.summary);
    return {
      status,
      stage,
      errorText,
      steps,
      summary,
      hasProgress:
        Boolean(liveBackendProgress) ||
        status !== "unknown" ||
        steps.length > 0 ||
        Boolean(errorText),
    };
  }, [liveBackendProgress]);
  const latestPushSnapshot = useMemo(() => {
    const snapshotText = snapshot.trim();
    if (snapshotText) {
      try {
        const parsed = JSON.parse(snapshotText) as unknown;
        const snapshotObject = asObject(parsed);
        if (snapshotObject) {
          return snapshotObject;
        }
      } catch {
        // Keep fallback candidates below.
      }
    }
    const candidates = [
      asObject(pushFlowPayload?.snapshot),
      asObject(pushPayload?.snapshot),
      asObject(pushMintPayload?.snapshot),
      asObject(pushRecipientPayload?.snapshot),
      asObject(onboardingPayload?.snapshot),
    ];
    return candidates.find(Boolean) || null;
  }, [
    onboardingPayload,
    pushFlowPayload,
    pushMintPayload,
    pushPayload,
    pushRecipientPayload,
    snapshot,
  ]);
  const latestWirexWallet = useMemo(
    () => asObject(latestPushSnapshot?.wallet),
    [latestPushSnapshot],
  );
  const latestWalletBalances = useMemo(
    () =>
      asArray(latestWirexWallet?.balances)
        .map((value) => asObject(value))
        .filter(Boolean) as Record<string, unknown>[],
    [latestWirexWallet],
  );
  const latestExternalCardId = useMemo(
    () =>
      asString(pushFlowPayload?.externalCardId, "") ||
      asString(pushPayload?.externalCardId, "") ||
      asString(pushRecipientPayload?.externalCardId, "") ||
      pushExternalCardId.trim(),
    [pushExternalCardId, pushFlowPayload, pushPayload, pushRecipientPayload],
  );
  const latestSelectedTokenAddress = useMemo(
    () =>
      asString(pushFlowPayload?.selectedTokenAddress, "") ||
      asString(pushPayload?.selectedTokenAddress, "") ||
      asString(pushMintPayload?.selectedTokenAddress, "") ||
      pushTokenAddress.trim(),
    [pushFlowPayload, pushMintPayload, pushPayload, pushTokenAddress],
  );
  const latestWirexWalletAddress = useMemo(
    () => asString(latestWirexWallet?.wallet_address, ""),
    [latestWirexWallet],
  );
  const latestOnchainBalanceBeforeMint = useMemo(
    () =>
      asObject(latestPushSnapshot?.onchainBalanceBeforeMint) ||
      asObject(asObject(pushMintPayload?.snapshot)?.onchainBalanceBeforeMint) ||
      null,
    [latestPushSnapshot, pushMintPayload],
  );
  const latestOnchainBalanceAfterMint = useMemo(
    () =>
      asObject(latestPushSnapshot?.onchainBalanceAfterMint) ||
      asObject(asObject(pushMintPayload?.snapshot)?.onchainBalanceAfterMint) ||
      null,
    [latestPushSnapshot, pushMintPayload],
  );
  const latestExplorerUrl = useMemo(() => {
    const explicit =
      asString(asObject(pushFlowPayload?.summary)?.explorerUrl, "") ||
      asString(asObject(pushMintPayload?.summary)?.explorerUrl, "");
    if (explicit) return explicit;
    if (!latestWirexWalletAddress) return "";
    return `${BASE_SEPOLIA_ADDRESS_EXPLORER_BASE_URL}${latestWirexWalletAddress}`;
  }, [latestWirexWalletAddress, pushFlowPayload, pushMintPayload]);
  const latestPushOutcome = useMemo(() => {
    const flowSummaryValue = asObject(pushFlowPayload?.summary);
    const pushSummaryValue = asObject(pushPayload?.summary);
    if (pushFlowPayload) {
      if (pushFlowPayload.ok === true) {
        return {
          title: "Result: Push succeeded",
          body: "Sandbox recipient, funding, and push completed successfully.",
          success: true,
        };
      }
      if (asString(flowSummaryValue?.reason, "") === "funded_onchain_waiting_for_wirex_balance") {
        return {
          title: "Result: Waiting on Wirex balance sync",
          body: "The sandbox token reached the smart wallet onchain, but Wirex still shows zero internal balance.",
          success: false,
        };
      }
      return {
        title: "Result: Push blocked",
        body: "The combined demo flow ran, but one of the critical steps failed.",
        success: false,
      };
    }
    if (pushPayload) {
      if (pushPayload.ok === true) {
        return {
          title: "Result: Push succeeded",
          body: "Push-to-card completed successfully.",
          success: true,
        };
      }
      if (asString(pushSummaryValue?.transferId, "")) {
        return {
          title: "Result: Push succeeded",
          body: "Push-to-card returned a transfer id.",
          success: true,
        };
      }
      return {
        title: "Result: Push blocked",
        body: "Push-to-card executed but did not return a successful transfer.",
        success: false,
      };
    }
    return null;
  }, [pushFlowPayload, pushPayload]);
  const flowSummary = useMemo(() => {
    const summary = asObject(onboardingPayload?.summary);
    const snapshotPayload = asObject(onboardingPayload?.snapshot);
    const bankAccounts = readArray(snapshotPayload, "bankAccounts")
      .map((value) => asObject(value))
      .filter(Boolean) as Record<string, unknown>[];
    const cards = readArray(snapshotPayload, "cards")
      .map((value) => asObject(value))
      .filter(Boolean) as Record<string, unknown>[];
    const steps = asArray(onboardingPayload?.steps)
      .map((value) => asObject(value))
      .filter(Boolean) as Record<string, unknown>[];
    const verificationStatus = asString(summary?.verificationStatus, "unknown");
    const userStatus = asString(onboardingPayload?.userStatus, "unknown");
    const sharing = asObject(summary?.sharing);
    const sharingAttempted = sharing?.attempted === true;
    const sharingApplied = sharing?.applied === true;
    const sepaReady = hasActiveSepa(bankAccounts);
    const cardReady = hasActiveCard(cards);
    const approvedKyc = verificationStatus === "Approved";
    const sharingNotRequired = approvedKyc && !sharingAttempted;
    const accountStage: StageState =
      userStatus === "created" || userStatus === "exists" ? STAGE_DONE : STAGE_PENDING;
    const sharingStage: StageState = sharingNotRequired
      ? STAGE_DONE
      : !sharingAttempted
        ? STAGE_PENDING
        : sharingApplied
          ? STAGE_DONE
          : STAGE_FAILED;
    const sharingStatusText = sharingNotRequired
      ? "Skipped: already KYC approved (sharing is pre-KYC)."
      : sharingAttempted
        ? sharingApplied
          ? "Sharing token accepted"
          : "Sharing token attempt failed"
        : "Not attempted yet (optional path before KYC).";
    const kycStartStage: StageState = approvedKyc
      ? STAGE_DONE
      : kycUrl
        ? STAGE_ACTION
        : STAGE_PENDING;
    const kycApprovedStage: StageState = approvedKyc ? STAGE_DONE : STAGE_PENDING;
    const cardDataStage: StageState = cardReady
      ? STAGE_DONE
      : approvedKyc
        ? STAGE_ACTION
        : STAGE_PENDING;
    const bankDataStage: StageState = sepaReady
      ? STAGE_DONE
      : approvedKyc
        ? STAGE_ACTION
        : STAGE_PENDING;
    return {
      verificationStatus,
      userStatus,
      sharingAttempted,
      sharingApplied,
      sharingNotRequired,
      sharingStatusText,
      sepaReady,
      cardReady,
      bankAccounts,
      cards,
      steps,
      accountStage,
      sharingStage,
      kycStartStage,
      kycApprovedStage,
      cardDataStage,
      bankDataStage,
      completed: approvedKyc && sepaReady && cardReady,
    };
  }, [kycUrl, onboardingPayload]);
  const primaryActionLabel = useMemo(() => {
    if (!onboardingPayload) return "1. Create / sync Wirex account";
    if (flowSummary.verificationStatus !== "Approved") return "1. Create / sync and refresh status";
    if (!flowSummary.sepaReady || !flowSummary.cardReady)
      return "3. Finish bank + card provisioning";
    return "Refresh live status";
  }, [
    flowSummary.cardReady,
    flowSummary.sepaReady,
    flowSummary.verificationStatus,
    onboardingPayload,
  ]);
  const currentFlowStage = useMemo(() => {
    if (latestPushOutcome?.success) {
      return {
        title: "Result: Fully proven",
        body: "Account, provisioning, push-to-card, and sponsored AA wallet movement are ready to test.",
        success: true,
      };
    }
    if (!onboardingPayload) {
      return {
        title: "Step 1: Run account sync",
        body: "Start with the full Wirex sync to create or refresh the sandbox user and bootstrap AA when needed.",
        success: false,
      };
    }
    if (flowSummary.verificationStatus !== "Approved") {
      return {
        title: kycUrl ? "Step 2: Complete KYC" : "Step 2: Refresh KYC state",
        body: kycUrl
          ? "KYC is the current blocker. Complete it, then rerun account sync."
          : "KYC is not approved yet and no link is currently available. Refresh the Wirex sync.",
        success: false,
      };
    }
    if (!flowSummary.sepaReady || !flowSummary.cardReady) {
      return {
        title: "Step 3: Wait for provisioning",
        body: "KYC is approved, but Wirex has not finished returning active bank/card capabilities yet.",
        success: false,
      };
    }
    if (!latestExternalCardId) {
      return {
        title: "Step 4: Create recipient",
        body: "The account is provisioned. Create or reuse the card recipient before mint and push.",
        success: false,
      };
    }
    return {
      title: "Step 5: Run push and sponsored send",
      body: "The account is provisioned and recipient data is ready. Run push-to-card or the sponsored AA token send.",
      success: false,
    };
  }, [
    flowSummary.cardReady,
    flowSummary.sepaReady,
    flowSummary.verificationStatus,
    kycUrl,
    latestExternalCardId,
    latestPushOutcome?.success,
    onboardingPayload,
  ]);
  const addAaCredentialButtonLabel = useMemo(() => {
    if (!pendingAaCredential) return "Add AA credential (second passkey)";
    const ageSec =
      pendingAaCredential.capturedAtMs > 0
        ? Math.max(0, Math.floor((Date.now() - pendingAaCredential.capturedAtMs) / 1000))
        : 0;
    return `Retry pending AA credential (${ageSec}s old)`;
  }, [pendingAaCredential]);

  useEffect(() => {
    if (!visible) return;
    setIsLoading(false);
    setIsPushLoading(false);
    setIsPushRecipientLoading(false);
    setIsPushMintLoading(false);
    setIsPushFlowLoading(false);
    setResult("");
    setSnapshot("");
    setPushResult("");
    setPushError("");
    setPushMintResult("");
    setPushMintError("");
    setPushRecipientResult("");
    setPushRecipientError("");
    setPushFlowResult("");
    setPushFlowError("");
    setError("");
    setOnboardingErrorRaw("");
    setOnboardingSummary("");
    setProvisioningSummary("");
    setPushSummary("");
    setPushMintSummary("");
    setPushRecipientSummary("");
    setPushFlowSummary("");
    setOnboardingPayload(null);
    setPushPayload(null);
    setPushMintPayload(null);
    setPushRecipientPayload(null);
    setPushFlowPayload(null);
    setShowRawOnboarding(false);
    setShowRawSnapshot(false);
    setShowRawPush(false);
    setShowRawPushMint(false);
    setShowRawPushRecipient(false);
    setShowRawPushFlow(false);
    setKycUrl(null);
    setKycSdkToken(null);
    setIsKycModalVisible(false);
    setSharingSource("none");
    setProxyBaseUrl(HARDCODED_WIREX_PROXY_URL);
    setAaPublicRpcUrl(DEFAULT_BASE_SEPOLIA_PUBLIC_RPC_URL);
    setWirexSumsubClientId(DEFAULT_WIREX_SUMSUB_CLIENT_ID);
    setPushExternalCardId("");
    setPushCardNumber(DEFAULT_PUSH_CARD_NUMBER);
    setPushCardholderName(DEFAULT_PUSH_CARDHOLDER_NAME);
    setPushCardLabel(DEFAULT_PUSH_CARD_LABEL);
    setPushTokenAddress("");
    setPushAmount(DEFAULT_PUSH_TO_CARD_AMOUNT);
    setPushCurrency(DEFAULT_PUSH_TO_CARD_CURRENCY);
    setCopyStatus("");
    setProxyHealthStatus("unchecked");
    setIsCheckingProxy(false);
    setLoadingStageText("");
    setRequestStartedAtMs(null);
    setRequestElapsedSec(0);
    setLiveBackendProgress(null);
    setLiveBackendError("");
    setWalletPasskeyCredIdB64u("");
    setWalletPasskeyCredPubkeyB64u("");
    setPasskeyKeyUserName("");
    setPasskeyKeyBaseOverride("");
    setStoredPasskeyKeyBase("");
    setPasskeyCaptureCreateKeyIndex(1);
    setTempCredPubkeyForAaBootstrap("");
    setLastResolvedSharingToken("");
    setLastResolvedSharingTokenSource("none");
    setSharingTokenFetchError("");
    setIsPasskeyCaptureVisible(false);
    setIsPasskeyCaptureRunning(false);
    setPasskeyCaptureError("");
    setPasskeyCaptureHint(PASSKEY_CAPTURE_DEFAULT_HINT);
    setPasskeyCaptureLog("");
    setAaTraceLog("");
    setPasskeyWebauthnUnsupported(false);
    setPasskeyCaptureSessionKey(0);
    setPasskeyWebAutoTriggerExisting(false);
    setPasskeyWebviewKey(0);
    setWebAuthnCaptureMode("passkey");
    setPasskeyCaptureIntent("metadata");
    passkeyCaptureResolverRef.current = null;
    liveProgressPollingRef.current = false;
    setIsAaPasskeySignTestLoading(false);
    setIsAaAddCredentialLoading(false);
    setAaAddCredentialSummary("");
    setAaAddCredentialResult("");
    setAaAddCredentialError("");
    setShowRawAaAddCredential(false);
    setPendingAaCredential(null);
    setAaPasskeySignTestSummary("");
    setAaPasskeySignTestResult("");
    setAaPasskeySignTestError("");
    setShowRawAaPasskeySignTest(false);
    setLastAaAddress("");
    setLastKernelAddress("");
    setLastPermissionId("");
  }, [visible]);

  const handleCopyValue = useCallback(async (label: string, value: string) => {
    const normalized = String(value || "").trim();
    if (!normalized) {
      setCopyStatus(`${label} missing`);
      return;
    }
    try {
      await Clipboard.setStringAsync(normalized);
      setCopyStatus(`${label} copied`);
    } catch {
      setCopyStatus(`${label} copy failed`);
    }
  }, []);

  // Fetch the raw Wirex user profile so the phone/email on file are visible.
  // The physical-eligibility route proxies Wirex's GET /api/v2/user and returns
  // the full payload on `raw` (profile incl. phone_number).
  const handleDumpUserProfile = useCallback(async () => {
    if (!normalizedWallet) {
      setProfileDump("No wallet address on screen state.");
      return;
    }
    setIsDumpingProfile(true);
    setProfileDump("");
    try {
      const elig = await wirexService.getUser(normalizedWallet);
      setProfileDump(JSON.stringify(elig.raw, null, 2));
    } catch (e) {
      setProfileDump(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsDumpingProfile(false);
    }
  }, [normalizedWallet]);

  // Issue an ADDITIONAL virtual card for an already-onboarded account (POST
  // /card/virtual, signed on-device). The new card only appears in `cards[]`
  // after a fresh /status read, so status is re-read either way: on an error the
  // card list is the ONLY safe way to find out whether the card was created —
  // re-tapping would sign again and risk a second card.
  const handleIssueVirtualCard = useCallback(async () => {
    if (!normalizedWallet) {
      setVirtualCardDump("No wallet address on screen state.");
      return;
    }
    setIsIssuingVirtualCard(true);
    setVirtualCardDump("");
    let issueError = "";
    let issued: WirexIssuedCard | null = null;
    try {
      issued = await wirexService.issueVirtualCard();
    } catch (e) {
      issueError = e instanceof Error ? e.message : String(e);
    }
    try {
      const status = await wirexService.getStatus({ wallet: normalizedWallet });
      setVirtualCardDump(
        JSON.stringify(
          { ...(issueError ? { error: issueError } : { issued }), cards: status.cards },
          null,
          2,
        ),
      );
    } catch (e) {
      const statusError = e instanceof Error ? e.message : String(e);
      setVirtualCardDump(
        JSON.stringify({ error: issueError || null, issued, statusError }, null, 2),
      );
    } finally {
      setIsIssuingVirtualCard(false);
    }
  }, [normalizedWallet]);

  // Read /status and dump cards[] verbatim — no signing beyond the read session,
  // nothing is created or changed. This is the exact array the card carousel is
  // built from, so it answers what a card looks like after it was closed.
  const handleDumpStatusCards = useCallback(async () => {
    if (!normalizedWallet) {
      setStatusCardsDump("No wallet address on screen state.");
      return;
    }
    setIsDumpingStatusCards(true);
    setStatusCardsDump("");
    try {
      const status = await wirexService.getStatus({ wallet: normalizedWallet });
      setStatusCardsDump(
        JSON.stringify(
          { verification_status: status.verificationStatus, cards: status.cards },
          null,
          2,
        ),
      );
    } catch (e) {
      setStatusCardsDump(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsDumpingStatusCards(false);
    }
  }, [normalizedWallet]);

  // PERMANENTLY close one card. Two taps: the first arms it, the second signs.
  // Irreversible — Wirex cannot reopen the card and has no reissue route, so a
  // replacement means issuing the new virtual card FIRST (and confirming it in
  // /status) and closing only afterwards. Freeze is the reversible option and
  // lives in the card screen, not here. `last4` is signed and verified against
  // Wirex, so it must be the value /status shows for this card_id.
  const handleCloseCard = useCallback(async () => {
    const cardId = closeCardId.trim();
    const last4 = closeCardLast4.trim();
    if (!cardId || !last4) {
      setCloseCardDump("Enter the card_id AND the last4 shown for it.");
      return;
    }
    if (!closeArmed) {
      setCloseArmed(true);
      setCloseCardDump(
        `Tap again to PERMANENTLY close ${cardId} (••${last4}). This cannot be undone.`,
      );
      return;
    }
    setCloseArmed(false);
    setIsClosingCard(true);
    setCloseCardDump("");
    let closeError = "";
    try {
      await wirexService.closeCard(cardId, last4);
    } catch (e) {
      closeError = e instanceof Error ? e.message : String(e);
    }
    try {
      const status = normalizedWallet
        ? await wirexService.getStatus({ wallet: normalizedWallet })
        : null;
      setCloseCardDump(
        JSON.stringify(
          { closed: closeError ? null : cardId, error: closeError || null, cards: status?.cards },
          null,
          2,
        ),
      );
    } catch (e) {
      const statusError = e instanceof Error ? e.message : String(e);
      setCloseCardDump(
        JSON.stringify(
          { closed: closeError ? null : cardId, error: closeError || null, statusError },
          null,
          2,
        ),
      );
    } finally {
      setIsClosingCard(false);
    }
  }, [closeArmed, closeCardId, closeCardLast4, normalizedWallet]);

  const handleOpenLatestExplorer = useCallback(async () => {
    if (!latestExplorerUrl) return;
    try {
      await Linking.openURL(latestExplorerUrl);
    } catch {
      setCopyStatus("Explorer open failed");
    }
  }, [latestExplorerUrl]);

  const persistPasskeyMetadata = useCallback(
    async (credIdRaw: string, credPubkeyRaw?: string) => {
      const credId = asString(credIdRaw).trim();
      if (!credId) return;
      const credPubkey = asString(credPubkeyRaw).trim();
      setWalletPasskeyCredIdB64u(credId);
      if (credPubkey) {
        setWalletPasskeyCredPubkeyB64u(credPubkey);
        setTempCredPubkeyForAaBootstrap(credPubkey);
      }
      appendPasskeyCaptureLog(
        `passkey metadata kept in-memory only credIdLen=${credId.length} pubLen=${credPubkey.length}`,
      );
    },
    [appendPasskeyCaptureLog],
  );

  const closePasskeyCapture = useCallback(
    (
      result: {
        credId: string;
        credPubkey: string;
        keyLabel?: string;
        source: "native_existing" | "native_created" | "web_existing" | "web_created";
      } | null,
    ) => {
      appendPasskeyCaptureLog(
        result
          ? `capture complete source=${result.source} credIdLen=${result.credId.length} pubLen=${result.credPubkey.length}${result.keyLabel ? ` label=${result.keyLabel}` : ""}`
          : "capture closed without result",
      );
      if (result) {
        const normalizedPubkey = asString(result.credPubkey).trim();
        if (normalizedPubkey) {
          setWalletPasskeyCredPubkeyB64u(normalizedPubkey);
          setTempCredPubkeyForAaBootstrap(normalizedPubkey);
        }
        void persistPasskeyMetadata(result.credId, normalizedPubkey || undefined);
      }
      const resolver = passkeyCaptureResolverRef.current;
      passkeyCaptureResolverRef.current = null;
      setIsPasskeyCaptureRunning(false);
      setIsPasskeyCaptureVisible(false);
      if (resolver) {
        resolver(result);
      }
    },
    [appendPasskeyCaptureLog, persistPasskeyMetadata],
  );

  const openPasskeyCapturePanel = useCallback(
    (opts?: {
      autoTriggerExisting?: boolean;
      intent?: "metadata" | "auth_only";
      createKeyIndex?: 1 | 2;
    }) => {
      setPasskeyCaptureError("");
      setPasskeyCaptureHint(PASSKEY_CAPTURE_DEFAULT_HINT);
      setPasskeyCaptureLog("");
      appendPasskeyCaptureLog("open passkey capture panel");
      setPasskeyWebauthnUnsupported(false);
      setPasskeyWebAutoTriggerExisting(opts?.autoTriggerExisting === true);
      setPasskeyCaptureIntent(opts?.intent === "auth_only" ? "auth_only" : "metadata");
      setPasskeyCaptureCreateKeyIndex(opts?.createKeyIndex === 2 ? 2 : 1);
      setPasskeyCaptureSessionKey((value) => value + 1);
      setWebAuthnCaptureMode("passkey");
      setIsPasskeyCaptureVisible(true);
    },
    [appendPasskeyCaptureLog],
  );

  const requestPasskeyMetadataViaCapturePanel = (opts?: {
    autoTriggerExisting?: boolean;
    intent?: "metadata" | "auth_only";
    createKeyIndex?: 1 | 2;
  }): Promise<{
    credId: string;
    credPubkey: string;
    keyLabel?: string;
    source: "native_existing" | "native_created" | "web_existing" | "web_created";
  } | null> =>
    new Promise((resolve) => {
      passkeyCaptureResolverRef.current = resolve;
      openPasskeyCapturePanel(opts);
    });

  const handlePasskeyWebViewMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const data = String(event.nativeEvent.data || "");
      if (!data) return;
      const managedCreateLabel = passkeyCreateLabelConfig.ok ? passkeyCreateLabelConfig.label : "";
      const managedCreateBase = passkeyCreateLabelConfig.ok ? passkeyCreateLabelConfig.base : "";
      appendPasskeyCaptureLog(`webview message: ${data.slice(0, 120)}`);
      if (data.startsWith("info:")) {
        setPasskeyCaptureHint(data.replace(/^info:/, "").replace(/_/g, " "));
        return;
      }
      if (data.startsWith("wallet_meta_create:")) {
        const parts = data.split(":");
        const credId = asString(parts[1]).trim();
        const credPubkeyRaw = asString(parts[2]).trim();
        const normalizedPubkey = normalizeAaPasskeyPublicKey(credPubkeyRaw);
        if (credId) {
          setWalletPasskeyCredIdB64u(credId);
        }
        if (normalizedPubkey.ok) {
          setWalletPasskeyCredPubkeyB64u(normalizedPubkey.normalized);
          setTempCredPubkeyForAaBootstrap(normalizedPubkey.normalized);
        }
        if (!credId || !credPubkeyRaw) {
          setPasskeyCaptureHint("Passkey metadata incomplete.");
          setPasskeyCaptureError(
            "Passkey create finished but metadata was incomplete. Retry create.",
          );
          return;
        }
        if (!normalizedPubkey.ok) {
          setPasskeyCaptureHint("Passkey public key format is unsupported.");
          setPasskeyCaptureError(
            `unsupported_passkey_public_key_format: ${normalizedPubkey.error}`,
          );
          appendPasskeyCaptureLog(
            `passkey create returned unsupported pubkey format reason=${normalizedPubkey.error}`,
          );
          return;
        }
        closePasskeyCapture({
          credId,
          credPubkey: normalizedPubkey.normalized,
          keyLabel: managedCreateLabel || undefined,
          source: "web_created",
        });
        if (managedCreateBase) {
          void persistPasskeyKeyBase(managedCreateBase);
        }
        return;
      }
      if (data.startsWith("wallet_meta_existing:")) {
        const parts = data.split(":");
        const credId = asString(parts[1]).trim();
        const existingPub =
          tempCredPubkeyForAaBootstrap.trim() || walletPasskeyCredPubkeyB64u.trim();
        const normalizedExistingPub = normalizeAaPasskeyPublicKey(existingPub);
        if (credId) {
          setWalletPasskeyCredIdB64u(credId);
        }
        if (!credId) {
          setPasskeyCaptureHint("Existing passkey returned no credential ID.");
          setPasskeyCaptureError("Existing passkey response missing credential ID.");
          return;
        }
        if (passkeyCaptureIntent === "auth_only") {
          if (normalizedExistingPub.ok) {
            setWalletPasskeyCredPubkeyB64u(normalizedExistingPub.normalized);
            setTempCredPubkeyForAaBootstrap(normalizedExistingPub.normalized);
          }
          closePasskeyCapture({
            credId,
            credPubkey: normalizedExistingPub.ok ? normalizedExistingPub.normalized : "",
            source: "web_existing",
          });
          return;
        }
        if (!existingPub) {
          setPasskeyCaptureHint("Existing passkey needs stored public key.");
          setPasskeyCaptureError(
            "No in-memory passkey public key. Tap Create Nuri Wallet Passkey once.",
          );
          return;
        }
        if (!normalizedExistingPub.ok) {
          setPasskeyCaptureHint("Stored passkey key format is invalid.");
          setPasskeyCaptureError(
            "Stored passkey public key is invalid for AA bootstrap. Tap Create Nuri Wallet Passkey once.",
          );
          appendPasskeyCaptureLog(
            `existing passkey metadata invalid reason=${normalizedExistingPub.error}`,
          );
          setWalletPasskeyCredPubkeyB64u("");
          setTempCredPubkeyForAaBootstrap("");
          return;
        }
        closePasskeyCapture({
          credId,
          credPubkey: normalizedExistingPub.normalized,
          source: "web_existing",
        });
        return;
      }
      if (data.startsWith("wallet_prf_create:") || data.startsWith("wallet_prf_import:")) {
        const isCreate = data.startsWith("wallet_prf_create:");
        const parts = data.split(":");
        const credId = asString(parts[2]).trim();
        const credPubkeyRaw = asString(parts[3]).trim();
        const normalizedPubkey = normalizeAaPasskeyPublicKey(credPubkeyRaw);
        if (credId) {
          setWalletPasskeyCredIdB64u(credId);
        }
        if (normalizedPubkey.ok) {
          setWalletPasskeyCredPubkeyB64u(normalizedPubkey.normalized);
          setTempCredPubkeyForAaBootstrap(normalizedPubkey.normalized);
        }
        if (!credId) {
          setPasskeyCaptureHint("Passkey credential ID missing.");
          setPasskeyCaptureError("Passkey response missing credential ID.");
          return;
        }
        if (!credPubkeyRaw) {
          setPasskeyCaptureHint("Passkey metadata incomplete.");
          setPasskeyCaptureError("Missing passkey public key. Use Create wallet passkey once.");
          return;
        }
        if (!normalizedPubkey.ok) {
          setPasskeyCaptureHint("Passkey public key format is unsupported.");
          setPasskeyCaptureError(
            `unsupported_passkey_public_key_format: ${normalizedPubkey.error}`,
          );
          appendPasskeyCaptureLog(
            `wallet_prf payload returned unsupported pubkey format reason=${normalizedPubkey.error}`,
          );
          return;
        }
        closePasskeyCapture({
          credId,
          credPubkey: normalizedPubkey.normalized,
          keyLabel: managedCreateLabel || undefined,
          source: isCreate ? "web_created" : "web_existing",
        });
        if (isCreate && managedCreateBase) {
          void persistPasskeyKeyBase(managedCreateBase);
        }
        return;
      }
      if (data.startsWith("wallet_hw_create:")) {
        const parts = data.split(":");
        const credId = asString(parts[1]).trim();
        const credPubkeyRaw = asString(parts[2]).trim();
        const normalizedPubkey = normalizeAaPasskeyPublicKey(credPubkeyRaw);
        if (credId) {
          setWalletPasskeyCredIdB64u(credId);
        }
        if (normalizedPubkey.ok) {
          setWalletPasskeyCredPubkeyB64u(normalizedPubkey.normalized);
          setTempCredPubkeyForAaBootstrap(normalizedPubkey.normalized);
        }
        if (!credId || !credPubkeyRaw) {
          setPasskeyCaptureHint("Hardware key metadata incomplete.");
          setPasskeyCaptureError("Hardware key returned incomplete credential metadata.");
          return;
        }
        if (!normalizedPubkey.ok) {
          setPasskeyCaptureHint("Hardware key format is unsupported.");
          setPasskeyCaptureError(
            `unsupported_passkey_public_key_format: ${normalizedPubkey.error}`,
          );
          appendPasskeyCaptureLog(
            `hardware key returned unsupported pubkey format reason=${normalizedPubkey.error}`,
          );
          return;
        }
        closePasskeyCapture({
          credId,
          credPubkey: normalizedPubkey.normalized,
          keyLabel: managedCreateLabel || undefined,
          source: "web_created",
        });
        if (managedCreateBase) {
          void persistPasskeyKeyBase(managedCreateBase);
        }
        return;
      }
      if (data.startsWith("error:") || data.startsWith("error_auth_only:")) {
        const lowered = data.toLowerCase();
        if (lowered.includes("missing_managed_label")) {
          setPasskeyCaptureHint("Managed key label missing.");
          setPasskeyCaptureError(
            passkeyCreateLabelConfig.error || "Provide passkey key naming input.",
          );
          return;
        }
        if (
          lowered.includes("document is not focused") ||
          lowered.includes("document_not_focused")
        ) {
          setPasskeyCaptureHint("WebView is not focused. Tap inside the passkey panel and retry.");
          appendPasskeyCaptureLog("webauthn requires focused document");
          return;
        }
        if (
          lowered.includes("webauthn:not_supported") ||
          lowered.includes("webauthn_not_supported")
        ) {
          setPasskeyWebauthnUnsupported(true);
        }
        setPasskeyCaptureHint("Passkey capture reported an error.");
        setPasskeyCaptureError(data);
      }
    },
    [
      appendPasskeyCaptureLog,
      closePasskeyCapture,
      normalizeAaPasskeyPublicKey,
      passkeyCaptureIntent,
      passkeyCreateLabelConfig,
      persistPasskeyKeyBase,
      tempCredPubkeyForAaBootstrap,
      walletPasskeyCredPubkeyB64u,
    ],
  );

  const handlePasskeyWebViewReload = useCallback(() => {
    appendPasskeyCaptureLog(`reload web capture mode=${webAuthnCaptureMode}`);
    setPasskeyCaptureError("");
    setPasskeyCaptureHint(PASSKEY_CAPTURE_DEFAULT_HINT);
    setPasskeyWebauthnUnsupported(false);
    setPasskeyWebAutoTriggerExisting(false);
    setPasskeyWebviewKey((value) => value + 1);
  }, [appendPasskeyCaptureLog, webAuthnCaptureMode]);

  const syncPasskeyWebCaptureConfig = useCallback(() => {
    const createText =
      webAuthnCaptureMode === "hardware"
        ? passkeyCreateLabelConfig.ok
          ? `Create hardware ${passkeyCreateLabelConfig.keyIndex === 2 ? "Key2" : "Key1"}`
          : "Create Hardware Key Credential"
        : passkeyCreateLabelConfig.createButtonText;
    const js = `try {
      window.__nuriCreateLabel = ${JSON.stringify(passkeyCreateLabelConfig.label)};
      window.__nuriRequireManagedLabel = "1";
      window.__nuriCreateButtonText = ${JSON.stringify(createText)};
      window.__nuriExistingButtonText = ${JSON.stringify(
        passkeyCreateLabelConfig.existingButtonText,
      )};
      var createEl = document.getElementById("create");
      if (createEl) {
        createEl.textContent = window.__nuriCreateButtonText || createEl.textContent;
        createEl.disabled = ${passkeyCreateLabelConfig.ok ? "false" : "true"};
        createEl.style.opacity = ${passkeyCreateLabelConfig.ok ? '"1"' : '"0.5"'};
      }
      var haveEl = document.getElementById("have");
      if (haveEl && window.__nuriExistingButtonText) {
        haveEl.textContent = window.__nuriExistingButtonText;
      }
    } catch (_e) {}
    true;`;
    passkeyWebViewRef.current?.injectJavaScript(js);
  }, [passkeyCreateLabelConfig, webAuthnCaptureMode]);

  const handleSelectPasskeyWebMode = useCallback(
    (mode: "passkey" | "hardware") => {
      appendPasskeyCaptureLog(`switch web capture mode=${mode}`);
      setWebAuthnCaptureMode(mode);
      setPasskeyCaptureError("");
      setPasskeyCaptureHint(
        mode === "hardware" ? "Using hardware key WebAuthn capture." : PASSKEY_CAPTURE_DEFAULT_HINT,
      );
      setPasskeyWebauthnUnsupported(false);
      setPasskeyWebAutoTriggerExisting(false);
      setPasskeyWebviewKey((value) => value + 1);
    },
    [appendPasskeyCaptureLog],
  );

  const handlePasskeyWebViewLoadEnd = useCallback(() => {
    appendPasskeyCaptureLog("webview load end");
    syncPasskeyWebCaptureConfig();
    if (!passkeyWebAutoTriggerExisting || webAuthnCaptureMode !== "passkey") {
      return;
    }
    setPasskeyWebAutoTriggerExisting(false);
    appendPasskeyCaptureLog("auto-trigger existing passkey (delayed)");
    setTimeout(() => {
      passkeyWebViewRef.current?.injectJavaScript(
        "try { window.__nuriRunExisting && window.__nuriRunExisting(); } catch (e) { window.ReactNativeWebView && window.ReactNativeWebView.postMessage('error:auto_existing:' + (e && e.message ? e.message : String(e))); } true;",
      );
    }, 320);
  }, [
    appendPasskeyCaptureLog,
    passkeyWebAutoTriggerExisting,
    syncPasskeyWebCaptureConfig,
    webAuthnCaptureMode,
  ]);

  useEffect(() => {
    if (Platform.OS === "android" || !isPasskeyCaptureVisible) return;
    const timer = setTimeout(() => {
      syncPasskeyWebCaptureConfig();
    }, 80);
    return () => clearTimeout(timer);
  }, [isPasskeyCaptureVisible, syncPasskeyWebCaptureConfig]);

  const handleNativeExistingPasskeyPress = useCallback(async () => {
    if (isPasskeyCaptureRunning) return;
    appendPasskeyCaptureLog("native existing passkey pressed");
    setIsPasskeyCaptureRunning(true);
    setPasskeyCaptureError("");
    setPasskeyCaptureHint("Opening existing wallet passkey...");
    try {
      const nativeExisting = await useExistingWalletPasskey(WALLET_RP_ID, WALLET_PASSKEY_PRF_SALT);
      const credId = asString(nativeExisting?.credIdB64u).trim();
      const responseCredPubkey = asString(nativeExisting?.credPubkeyB64u).trim();
      if (credId) {
        setWalletPasskeyCredIdB64u(credId);
      }
      if (passkeyCaptureIntent === "auth_only") {
        const authOnlyPubkey = normalizeAaPasskeyPublicKey(responseCredPubkey);
        if (authOnlyPubkey.ok) {
          setWalletPasskeyCredPubkeyB64u(authOnlyPubkey.normalized);
          setTempCredPubkeyForAaBootstrap(authOnlyPubkey.normalized);
        }
        if (!credId) {
          setPasskeyCaptureHint("Existing passkey returned no credential ID.");
          setPasskeyCaptureError("Existing passkey response missing credential ID.");
          setIsPasskeyCaptureRunning(false);
          return;
        }
        closePasskeyCapture({
          credId,
          credPubkey: authOnlyPubkey.ok ? authOnlyPubkey.normalized : "",
          source: "native_existing",
        });
        return;
      }
      if (!credId || !responseCredPubkey) {
        setPasskeyCaptureHint("Existing passkey did not return full metadata.");
        setPasskeyCaptureError("Missing passkey public key. Tap Create wallet passkey once.");
        setIsPasskeyCaptureRunning(false);
        return;
      }
      const normalizedPubkey = normalizeAaPasskeyPublicKey(responseCredPubkey);
      if (normalizedPubkey.ok) {
        setWalletPasskeyCredPubkeyB64u(normalizedPubkey.normalized);
        setTempCredPubkeyForAaBootstrap(normalizedPubkey.normalized);
      }
      if (!normalizedPubkey.ok) {
        setPasskeyCaptureHint("Stored passkey key format is invalid.");
        setPasskeyCaptureError(
          "Stored passkey public key is invalid for AA bootstrap. Tap Create wallet passkey once.",
        );
        appendPasskeyCaptureLog(
          `native existing passkey metadata invalid reason=${normalizedPubkey.error}`,
        );
        setWalletPasskeyCredPubkeyB64u("");
        setTempCredPubkeyForAaBootstrap("");
        setIsPasskeyCaptureRunning(false);
        return;
      }
      closePasskeyCapture({
        credId,
        credPubkey: normalizedPubkey.normalized,
        source: "native_existing",
      });
    } catch (error: unknown) {
      appendPasskeyCaptureLog("native existing passkey failed");
      setPasskeyCaptureHint("Existing wallet passkey failed.");
      setPasskeyCaptureError(errMsg(error, "Existing wallet passkey failed."));
      setIsPasskeyCaptureRunning(false);
    }
  }, [
    appendPasskeyCaptureLog,
    closePasskeyCapture,
    isPasskeyCaptureRunning,
    normalizeAaPasskeyPublicKey,
    passkeyCaptureIntent,
    tempCredPubkeyForAaBootstrap,
    walletPasskeyCredPubkeyB64u,
  ]);

  const handleNativeCreatePasskeyPress = useCallback(async () => {
    if (isPasskeyCaptureRunning) return;
    if (!passkeyCreateLabelConfig.ok) {
      setPasskeyCaptureHint("Passkey key name is required.");
      setPasskeyCaptureError(passkeyCreateLabelConfig.error);
      return;
    }
    appendPasskeyCaptureLog("native create passkey pressed");
    setIsPasskeyCaptureRunning(true);
    setPasskeyCaptureError("");
    setPasskeyCaptureHint(`Opening create wallet passkey (${passkeyCreateLabelConfig.label})...`);
    try {
      const nativeCreated = await createWalletPasskey(
        WALLET_RP_ID,
        WALLET_PASSKEY_PRF_SALT,
        passkeyCreateLabelConfig.label,
      );
      const credId = asString(nativeCreated?.credIdB64u).trim();
      const credPubkeyRaw = asString(nativeCreated?.credPubkeyB64u).trim();
      const normalizedPubkey = normalizeAaPasskeyPublicKey(credPubkeyRaw);
      if (credId) {
        setWalletPasskeyCredIdB64u(credId);
      }
      if (normalizedPubkey.ok) {
        setWalletPasskeyCredPubkeyB64u(normalizedPubkey.normalized);
        setTempCredPubkeyForAaBootstrap(normalizedPubkey.normalized);
      }
      if (!credId || !credPubkeyRaw) {
        setPasskeyCaptureHint("Created passkey did not return full metadata.");
        setPasskeyCaptureError("Created passkey metadata incomplete. Try again.");
        setIsPasskeyCaptureRunning(false);
        return;
      }
      if (!normalizedPubkey.ok) {
        setPasskeyCaptureHint("Created passkey key format is unsupported.");
        setPasskeyCaptureError(`unsupported_passkey_public_key_format: ${normalizedPubkey.error}`);
        appendPasskeyCaptureLog(
          `native create passkey returned unsupported pubkey format reason=${normalizedPubkey.error}`,
        );
        setIsPasskeyCaptureRunning(false);
        return;
      }
      closePasskeyCapture({
        credId,
        credPubkey: normalizedPubkey.normalized,
        keyLabel: passkeyCreateLabelConfig.label,
        source: "native_created",
      });
      void persistPasskeyKeyBase(passkeyCreateLabelConfig.base);
    } catch (error: unknown) {
      appendPasskeyCaptureLog("native create passkey failed");
      setPasskeyCaptureHint("Create wallet passkey failed.");
      setPasskeyCaptureError(errMsg(error, "Create wallet passkey failed."));
      setIsPasskeyCaptureRunning(false);
    }
  }, [
    appendPasskeyCaptureLog,
    closePasskeyCapture,
    isPasskeyCaptureRunning,
    normalizeAaPasskeyPublicKey,
    passkeyCreateLabelConfig,
    persistPasskeyKeyBase,
  ]);

  const handleNativePasskeyCancel = useCallback(() => {
    if (isPasskeyCaptureRunning) return;
    appendPasskeyCaptureLog("passkey capture canceled");
    setPasskeyCaptureHint("Passkey capture canceled.");
    setPasskeyCaptureError("Passkey capture canceled.");
    closePasskeyCapture(null);
  }, [appendPasskeyCaptureLog, closePasskeyCapture, isPasskeyCaptureRunning]);

  const handleOpenPasskeyDialog = useCallback(async () => {
    if (isPasskeyCaptureRunning) return;
    if (isPasskeyCaptureVisible) {
      appendPasskeyCaptureLog("passkey capture already open");
      return;
    }
    appendPasskeyCaptureLog("open passkey dialog requested");
    setLoadingStageText("Opening passkey dialog...");
    try {
      if (Platform.OS === "android") {
        openPasskeyCapturePanel({
          autoTriggerExisting: false,
          intent: "metadata",
          createKeyIndex: 1,
        });
        await handleNativeExistingPasskeyPress();
        return;
      }
      openPasskeyCapturePanel({
        autoTriggerExisting: false,
        intent: "metadata",
        createKeyIndex: 1,
      });
    } finally {
      setLoadingStageText("");
    }
  }, [
    appendPasskeyCaptureLog,
    handleNativeExistingPasskeyPress,
    isPasskeyCaptureVisible,
    isPasskeyCaptureRunning,
    openPasskeyCapturePanel,
  ]);

  const ensureWalletPasskeyMetadata = useCallback(async (): Promise<{
    credId: string;
    credPubkey: string;
    source: "native_existing" | "native_created" | "web_existing" | "web_created";
  } | null> => {
    const normalizeCandidate = (credPubkeyRaw: string, label: string): string | null => {
      const normalized = normalizeAaPasskeyPublicKey(credPubkeyRaw);
      if (!normalized.ok) {
        if (asString(credPubkeyRaw).trim()) {
          appendPasskeyCaptureLog(`${label} passkey pubkey invalid reason=${normalized.error}`);
        }
        return null;
      }
      return normalized.normalized;
    };

    setLoadingStageText("Wallet passkey metadata required.");
    appendPasskeyCaptureLog("no local metadata preload; opening capture");
    const selected = await requestPasskeyMetadataViaCapturePanel({
      // In metadata mode we need a pubkey at least once, so avoid
      // auto-triggering existing passkey on iOS WebView.
      autoTriggerExisting: false,
      intent: "metadata",
      createKeyIndex: 1,
    });
    if (selected) {
      const selectedPubkey = normalizeCandidate(selected.credPubkey, selected.source);
      if (selectedPubkey) {
        setTempCredPubkeyForAaBootstrap(selectedPubkey);
        setWalletPasskeyCredPubkeyB64u(selectedPubkey);
        return {
          ...selected,
          credPubkey: selectedPubkey,
        };
      }
      setPasskeyCaptureHint("Passkey public key must be created once.");
      setPasskeyCaptureError(
        "Unsupported passkey public key format. Tap Create Nuri Wallet Passkey once.",
      );
      appendPasskeyCaptureLog("capture result invalid; create wallet passkey required");
      return null;
    }
    appendPasskeyCaptureLog("capture ended without metadata");
    return null;
  }, [appendPasskeyCaptureLog, normalizeAaPasskeyPublicKey, requestPasskeyMetadataViaCapturePanel]);

  useEffect(() => {
    if (!copyStatus) return;
    const timer = setTimeout(() => setCopyStatus(""), 1500);
    return () => clearTimeout(timer);
  }, [copyStatus]);

  useEffect(() => {
    if (
      !(
        isLoading ||
        isPushLoading ||
        isPushRecipientLoading ||
        isPushMintLoading ||
        isPushFlowLoading
      ) ||
      !requestStartedAtMs
    ) {
      setRequestElapsedSec(0);
      return;
    }
    const tick = () => {
      setRequestElapsedSec(Math.max(0, Math.floor((Date.now() - requestStartedAtMs) / 1000)));
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [
    isLoading,
    isPushFlowLoading,
    isPushMintLoading,
    isPushLoading,
    isPushRecipientLoading,
    requestStartedAtMs,
  ]);

  useEffect(() => {
    if (!visible || !isLoading || !isHexAddress(normalizedWallet) || isPasskeyCaptureVisible) {
      liveProgressPollingRef.current = false;
      return;
    }
    const proxy = proxyBaseUrl.trim();
    if (!proxy) {
      return;
    }

    let cancelled = false;
    const poll = async () => {
      if (cancelled || liveProgressPollingRef.current) {
        return;
      }
      liveProgressPollingRef.current = true;
      try {
        const payload = await getWirexDebugOnboardingProgress({
          walletAddress: normalizedWallet,
          proxyBaseUrl: proxy,
        });
        if (cancelled) return;
        const payloadObj = asObject(payload);
        setLiveBackendProgress(payloadObj);
        setLiveBackendError("");
        const stage = formatBackendStage(asString(payloadObj?.stage, "idle"));
        const status = asString(payloadObj?.status, "unknown");
        if (stage && status === "running") {
          setLoadingStageText(`Backend: ${stage}`);
        }
      } catch (e: unknown) {
        if (cancelled) return;
        setLiveBackendError(errMsg(e));
      } finally {
        liveProgressPollingRef.current = false;
      }
    };

    void poll();
    const timer = setInterval(() => {
      void poll();
    }, LIVE_PROGRESS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      liveProgressPollingRef.current = false;
    };
  }, [isLoading, isPasskeyCaptureVisible, normalizedWallet, proxyBaseUrl, visible]);

  const handleCopyUseful = async () => {
    try {
      await Clipboard.setStringAsync(usefulCopyPayload);
      setCopyStatus("Copied");
    } catch {
      setCopyStatus("Copy failed");
    }
  };

  const handleCopyFull = async () => {
    try {
      await Clipboard.setStringAsync(copyPayload);
      setCopyStatus("Copied full");
    } catch {
      setCopyStatus("Copy failed");
    }
  };

  const applyOnboardingPayload = (payload: unknown) => {
    setResult(JSON.stringify(payload, null, 2));
    setOnboardingSummary(buildOnboardingSummary(payload));
    setProvisioningSummary(buildProvisioningSummary(payload));
    const payloadObj = asObject(payload);
    setOnboardingPayload(payloadObj);
    const payloadSummary = asObject(payloadObj?.summary);
    const verificationStatus = asString(payloadSummary?.verificationStatus, "unknown");
    const payloadKycUrl = asString(payloadSummary?.kycLink);
    const nextKycSdkToken = getKycSdkTokenFromPayload(payloadObj);
    setKycUrl(payloadKycUrl || null);
    if (verificationStatus !== "Approved" && (Boolean(payloadKycUrl) || Boolean(nextKycSdkToken))) {
      setIsKycModalVisible(true);
    }
    setKycSdkToken(nextKycSdkToken);
    if (verificationStatus === "Approved") {
      setIsKycModalVisible(false);
    }
    const snapshotValue = payloadObj?.snapshot;
    if (snapshotValue && typeof snapshotValue === "object") {
      setSnapshot(JSON.stringify(snapshotValue, null, 2));
    } else {
      setSnapshot("");
    }
  };

  const runProxyHealthCheck = async (): Promise<string | null> => {
    setIsCheckingProxy(true);
    setProxyHealthStatus("checking");
    try {
      const rawCandidates = Array.from(
        new Set(
          [proxyBaseUrl, HARDCODED_WIREX_PROXY_URL]
            .map((value) => value.trim().replace(/\/+$/, ""))
            .filter(Boolean),
        ),
      );
      const candidates = rawCandidates.filter((candidate) => {
        if (Platform.OS === "web") return true;
        return !isLocalProxyUrl(candidate);
      });
      if (!candidates.length) {
        setProxyBaseUrl(HARDCODED_WIREX_PROXY_URL);
        setProxyHealthStatus(`failed: local proxy is not reachable on ${Platform.OS}; use tunnel`);
        return null;
      }
      const failures: string[] = [];
      for (const candidate of candidates) {
        const health = await checkWirexProxyHealth(candidate);
        if (health.ok) {
          setProxyBaseUrl(candidate);
          setProxyHealthStatus(`ok: ${candidate}`);
          return candidate;
        }
        failures.push(`${candidate} (${health.detail || "unknown"})`);
      }
      setProxyHealthStatus(`failed: ${failures.join(" | ")}`);
      return null;
    } finally {
      setIsCheckingProxy(false);
    }
  };

  useEffect(() => {
    if (!visible) return;
    void runProxyHealthCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const resolveSharingTokenInput = async (): Promise<{
    token: string;
    source: "manual" | "none";
  }> => {
    const manualToken = sharingToken.trim();
    setSharingTokenFetchError("");

    if (manualToken) {
      setLastResolvedSharingToken(manualToken);
      setLastResolvedSharingTokenSource("manual");
      return { token: manualToken, source: "manual" };
    }

    setLastResolvedSharingToken("");
    setLastResolvedSharingTokenSource("none");
    return { token: "", source: "none" };
  };

  const runOnDeviceAaBootstrap = async (opts?: {
    allowPasskeyCapture?: boolean;
    passkeyCredIdOverride?: string;
    passkeyCredPubkeyOverride?: string;
    bootstrapMode?: "default" | "add_credential";
  }): Promise<Record<string, unknown>> => {
    const allowPasskeyCapture = opts?.allowPasskeyCapture !== false;
    const bootstrapMode = opts?.bootstrapMode === "add_credential" ? "add_credential" : "default";
    setLoadingStageText("Unlocking wallet key for on-device AA bootstrap...");
    let keyBytes: Uint8Array | null = null;
    let walletPrivateKeyHex = "";
    try {
      let passkeyCredId = asString(opts?.passkeyCredIdOverride || walletPasskeyCredIdB64u).trim();
      let passkeyCredPubkey = asString(
        opts?.passkeyCredPubkeyOverride ||
          tempCredPubkeyForAaBootstrap ||
          walletPasskeyCredPubkeyB64u,
      ).trim();
      if (!passkeyCredId || !passkeyCredPubkey) {
        try {
          await authStateManager.initialize();
          const walletKeys = authStateManager.getState().walletPublicKeys;
          const storedCredId = asString(walletKeys?.walletPasskeyCredIdB64u).trim();
          const storedCredPubkey = asString(walletKeys?.walletPasskeyCredPubkeyB64u).trim();
          if (storedCredId && !passkeyCredId) {
            passkeyCredId = storedCredId;
            setWalletPasskeyCredIdB64u((prev) => prev.trim() || storedCredId);
          }
          if (storedCredPubkey && !passkeyCredPubkey) {
            passkeyCredPubkey = storedCredPubkey;
            setWalletPasskeyCredPubkeyB64u((prev) => prev.trim() || storedCredPubkey);
            setTempCredPubkeyForAaBootstrap((prev) => prev.trim() || storedCredPubkey);
          }
        } catch {
          // Keep bootstrap resilient; discovery can still proceed with passkey auth fallback.
        }
      }
      appendPasskeyCaptureLog(
        passkeyCredId
          ? `aa bootstrap mode=${bootstrapMode}: onchain discovery with credId only credIdLen=${passkeyCredId.length}`
          : allowPasskeyCapture
            ? `aa bootstrap mode=${bootstrapMode}: start with onchain discovery only (no metadata preload)`
            : `discovery-only mode (${bootstrapMode}): no local passkey metadata preload`,
      );
      appendAaTraceLog(
        [
          "provider=selfhost",
          `aa_bootstrap_start mode=${bootstrapMode}`,
          `credIdLen=${passkeyCredId.length}`,
          `credPubLen=${passkeyCredPubkey.length}`,
          `paymaster=${truncateMiddle(aaPaymasterAddress.trim() || "missing", 24)}`,
        ].join(" "),
      );

      keyBytes = await getPrivateKey("ethereum");
      walletPrivateKeyHex = `0x${bytesToHex(keyBytes)}`;
      const signerAccount = privateKeyToAccount(walletPrivateKeyHex as `0x${string}`);
      const walletAddressFromKey = signerAccount.address;
      const walletAddressForWirexInit = isHexAddress(normalizedWallet)
        ? normalizedWallet
        : walletAddressFromKey;
      const publicRpcUrlOverride = aaPublicRpcUrl.trim();
      const bundlerRpcUrlOverride = aaBundlerRpcUrl.trim();
      const paymasterAddressOverride = aaPaymasterAddress.trim();
      const walletAddressSource = isHexAddress(normalizedWallet)
        ? "screen_state"
        : "derived_from_eoa_key";
      if (walletAddressSource !== "screen_state") {
        console.log(
          "[WirexDebug][aa] wallet address missing in UI state; using unlocked EOA for Wirex init",
          {
            wallet: shortAddress(walletAddressForWirexInit),
            source: walletAddressSource,
          },
        );
      }

      const runBootstrap = async (): Promise<Record<string, unknown>> => {
        if (!publicRpcUrlOverride) {
          throw new Error("missing_selfhost_public_rpc_url");
        }
        if (!bundlerRpcUrlOverride) {
          throw new Error("missing_selfhost_bundler_rpc_url");
        }
        if (!paymasterAddressOverride) {
          throw new Error("missing_selfhost_paymaster_address");
        }
        return (await bootstrapWirexAaOnDeviceSelfhost(
          {
            walletAddress: walletAddressForWirexInit,
            walletPrivateKey: walletPrivateKeyHex,
            walletPasskeyCredIdB64u: passkeyCredId || undefined,
            walletPasskeyCredPubkeyB64u: passkeyCredPubkey || undefined,
            walletPasskeyRpId: WALLET_RP_ID,
            bootstrapMode,
            chainId: CHAIN_ID,
            publicRpcUrl: publicRpcUrlOverride || undefined,
            bundlerRpcUrl: bundlerRpcUrlOverride || undefined,
            paymasterAddress: paymasterAddressOverride,
          },
          (progress) => {
            const details = asObject(progress.details);
            if (progress.stage === "waiting_for_user_operation_receipt") {
              const timeoutMs =
                typeof details?.timeoutMs === "number" ? details.timeoutMs : undefined;
              const createAttempt =
                typeof details?.attempt === "number" ? details.attempt : undefined;
              const createMaxAttempts =
                typeof details?.maxAttempts === "number" ? details.maxAttempts : undefined;
              setLoadingStageText(
                [
                  "AA bootstrap: waiting for onchain receipt",
                  typeof createAttempt === "number" && typeof createMaxAttempts === "number"
                    ? `try ${createAttempt}/${createMaxAttempts}`
                    : "",
                  typeof timeoutMs === "number" ? `timeout ${Math.ceil(timeoutMs / 1000)}s` : "",
                ]
                  .filter(Boolean)
                  .join(" | "),
              );
            } else {
              setLoadingStageText(aaBootstrapStageLabel(progress.stage));
            }
            const safeDetails = details
              ? {
                  aaProvider: asString(details.aaProvider),
                  sponsorshipMode: asString(details.sponsorshipMode),
                  kernel: asString(details.kernel),
                  kernelAddress: asString(details.kernelAddress),
                  permissionId: asString(details.permissionId),
                  activePermissionCount:
                    typeof details.activePermissionCount === "number"
                      ? details.activePermissionCount
                      : undefined,
                  activePermissionIds: Array.isArray(details.activePermissionIds)
                    ? details.activePermissionIds
                    : undefined,
                  deployedBefore:
                    typeof details.deployedBefore === "boolean"
                      ? details.deployedBefore
                      : undefined,
                  webAuthnPermissionInstalledBefore:
                    typeof details.webAuthnPermissionInstalledBefore === "boolean"
                      ? details.webAuthnPermissionInstalledBefore
                      : undefined,
                  webAuthnPermissionInstalledAfter:
                    typeof details.webAuthnPermissionInstalledAfter === "boolean"
                      ? details.webAuthnPermissionInstalledAfter
                      : undefined,
                  mode: asString(details.mode),
                  bootstrapMode: asString(details.bootstrapMode),
                  discoverySource: asString(details.discoverySource),
                  hash: asString(details.hash),
                  attempt: typeof details.attempt === "number" ? details.attempt : undefined,
                  maxAttempts:
                    typeof details.maxAttempts === "number" ? details.maxAttempts : undefined,
                  waitMs: typeof details.waitMs === "number" ? details.waitMs : undefined,
                  totalWaitMs:
                    typeof details.totalWaitMs === "number" ? details.totalWaitMs : undefined,
                  nextRetryAt: asString(details.nextRetryAt),
                  lastError: asString(details.lastError),
                  message: asString(details.message),
                  sourceFormat: asString(details.sourceFormat),
                  policyAddress: asString(details.policyAddress),
                  rootPolicyAddress: asString(details.rootPolicyAddress),
                  rootPermissionId: asString(details.rootPermissionId),
                  chainId: typeof details.chainId === "number" ? details.chainId : undefined,
                  paymasterAddressUsed: asString(details.paymasterAddressUsed),
                  kernelBalanceEth: asString(details.kernelBalanceEth),
                  minKernelBalanceEth: asString(details.minKernelBalanceEth),
                  publicRpcUrlUsed: asString(details.publicRpcUrlUsed),
                  bundlerRpcUrlUsed: asString(details.bundlerRpcUrlUsed),
                }
              : undefined;
            const aaAddressForLog =
              asString(safeDetails?.kernelAddress) || asString(safeDetails?.kernel);
            const nextRetryAt = asString(safeDetails?.nextRetryAt);
            const nextRetryAtShort =
              nextRetryAt && nextRetryAt.length >= 19
                ? `${nextRetryAt.slice(11, 19)}Z`
                : nextRetryAt;
            appendAaTraceLog(
              [
                "provider=selfhost",
                `stage=${progress.stage}`,
                asString(safeDetails?.kernelAddress)
                  ? `aa=${shortAddress(asString(safeDetails?.kernelAddress))}`
                  : "",
                asString(safeDetails?.permissionId)
                  ? `permissionId=${asString(safeDetails?.permissionId)}`
                  : "",
                asString(safeDetails?.rootPermissionId)
                  ? `rootPermissionId=${asString(safeDetails?.rootPermissionId)}`
                  : "",
                asString(safeDetails?.discoverySource)
                  ? `discovery=${asString(safeDetails?.discoverySource)}`
                  : "",
                asString(safeDetails?.mode) ? `mode=${asString(safeDetails?.mode)}` : "",
                asString(safeDetails?.sponsorshipMode)
                  ? `sponsorship=${asString(safeDetails?.sponsorshipMode)}`
                  : "",
                asString(safeDetails?.paymasterAddressUsed)
                  ? `paymaster=${shortAddress(asString(safeDetails?.paymasterAddressUsed))}`
                  : "",
                asString(safeDetails?.hash)
                  ? `hash=${truncateMiddle(asString(safeDetails?.hash), 18)}`
                  : "",
                typeof safeDetails?.attempt === "number"
                  ? `attempt=${String(safeDetails.attempt)}/${String(
                      safeDetails.maxAttempts || "?",
                    )}`
                  : "",
                typeof safeDetails?.waitMs === "number"
                  ? `waitMs=${String(safeDetails.waitMs)}`
                  : "",
                typeof safeDetails?.totalWaitMs === "number"
                  ? `totalWaitMs=${String(safeDetails.totalWaitMs)}`
                  : "",
                nextRetryAtShort ? `nextRetryAt=${nextRetryAtShort}` : "",
                asString(safeDetails?.kernelBalanceEth)
                  ? `kernelBalance=${asString(safeDetails?.kernelBalanceEth)}`
                  : "",
                asString(safeDetails?.minKernelBalanceEth)
                  ? `kernelMin=${asString(safeDetails?.minKernelBalanceEth)}`
                  : "",
                asString(safeDetails?.lastError)
                  ? `lastError=${truncateMiddle(
                      asString(safeDetails?.lastError).replace(/\s+/g, " "),
                      90,
                    )}`
                  : "",
                asString(safeDetails?.message)
                  ? `message=${truncateMiddle(
                      asString(safeDetails?.message).replace(/\s+/g, " "),
                      100,
                    )}`
                  : "",
                typeof safeDetails?.deployedBefore === "boolean"
                  ? `deployedBefore=${String(safeDetails?.deployedBefore)}`
                  : "",
                asString(safeDetails?.publicRpcUrlUsed)
                  ? `publicRpc=${truncateMiddle(asString(safeDetails?.publicRpcUrlUsed), 64)}`
                  : "",
                asString(safeDetails?.bundlerRpcUrlUsed)
                  ? `bundler=${truncateMiddle(asString(safeDetails?.bundlerRpcUrlUsed), 64)}`
                  : "",
              ]
                .filter(Boolean)
                .join(" "),
            );
            console.log("[WirexDebug][aa]", progress.stage, {
              aaProvider: "selfhost",
              wallet: shortAddress(walletAddressForWirexInit),
              walletAddress: walletAddressForWirexInit,
              aaAddress: aaAddressForLog,
              ...(safeDetails || {}),
            });
          },
        )) as unknown as Record<string, unknown>;
      };

      setLoadingStageText("Starting on-device AA bootstrap...");
      let aaBootstrap: Record<string, unknown>;
      try {
        aaBootstrap = await runBootstrap();
      } catch (bootstrapError: unknown) {
        const message = errMsg(bootstrapError);
        if (!message.includes("missing_wallet_passkey_metadata")) {
          appendAaTraceLog(
            `aa_bootstrap_error ${truncateMiddle(message.replace(/\s+/g, " "), 180)}`,
          );
          throw bootstrapError;
        }
        if (!allowPasskeyCapture) {
          throw new Error("missing_wallet_passkey_metadata_no_capture");
        }

        setLoadingStageText("Passkey metadata required. Opening passkey capture...");
        const passkeyMeta = await ensureWalletPasskeyMetadata();
        if (!passkeyMeta) {
          throw new Error(
            passkeyCaptureError ||
              "Missing wallet passkey metadata. Complete passkey capture and retry.",
          );
        }
        passkeyCredId = passkeyMeta.credId;
        passkeyCredPubkey = passkeyMeta.credPubkey;
        setLoadingStageText("Retrying AA bootstrap with captured passkey metadata...");
        appendAaTraceLog(
          `aa_bootstrap_retry_after_capture credIdLen=${passkeyCredId.length} credPubLen=${passkeyCredPubkey.length}`,
        );
        aaBootstrap = await runBootstrap();
      }

      setLastAaAddress(walletAddressForWirexInit);
      setLastKernelAddress(asString(aaBootstrap.kernelAddress));
      setLastPermissionId(asString(aaBootstrap.permissionId));

      return {
        ...aaBootstrap,
        eoaAddress: walletAddressForWirexInit,
        walletAddressSource,
        publicRpcUrlRequested: publicRpcUrlOverride || "",
        paymasterAddressRequested: paymasterAddressOverride || "",
      };
    } finally {
      if (keyBytes) {
        zeroize(keyBytes);
      }
      walletPrivateKeyHex = "";
      // Keep passkey metadata in-memory for this modal session so retries do not
      // force users to recreate/capture passkey metadata after transient failures.
    }
  };

  const requestPasskeyAuthForAaSignTest = useCallback(async () => {
    if (Platform.OS === "android") {
      appendPasskeyCaptureLog("aa sign test: native existing passkey auth");
      const nativeExisting = await useExistingWalletPasskey(WALLET_RP_ID, WALLET_PASSKEY_PRF_SALT);
      const credId = asString(nativeExisting?.credIdB64u).trim();
      const credPubkeyRaw = asString(nativeExisting?.credPubkeyB64u).trim();
      const normalizedPubkey = normalizeAaPasskeyPublicKey(credPubkeyRaw);
      if (!credId) {
        throw new Error("passkey_auth_missing_credential_id");
      }
      if (normalizedPubkey.ok) {
        setWalletPasskeyCredPubkeyB64u(normalizedPubkey.normalized);
        setTempCredPubkeyForAaBootstrap(normalizedPubkey.normalized);
      }
      setWalletPasskeyCredIdB64u(credId);
      return {
        credId,
        credPubkey: normalizedPubkey.ok ? normalizedPubkey.normalized : "",
        source: "native_existing",
      } as const;
    }

    const selected = await requestPasskeyMetadataViaCapturePanel({
      // iOS WebView auto-trigger often fails with "document is not focused".
      // Keep auth explicit to make the flow deterministic.
      autoTriggerExisting: false,
      intent: "auth_only",
      createKeyIndex: 1,
    });
    if (!selected || !asString(selected.credId).trim()) {
      throw new Error("passkey_auth_canceled_or_missing_credential_id");
    }
    setWalletPasskeyCredIdB64u(selected.credId);
    return selected;
  }, [appendPasskeyCaptureLog, normalizeAaPasskeyPublicKey, requestPasskeyMetadataViaCapturePanel]);

  const loadAaReadiness = useCallback(
    async (opts?: { eoaAddress?: string; kernelAddress?: string }) => {
      const eoaAddress = asString(opts?.eoaAddress || lastAaAddress || normalizedWallet).trim();
      const kernelAddress = asString(opts?.kernelAddress || lastKernelAddress).trim();
      const publicRpcUrl = aaPublicRpcUrl.trim();
      const paymasterAddress = aaPaymasterAddress.trim();

      if (!isHexAddress(eoaAddress)) {
        throw new Error("invalid_wallet_address");
      }
      if (!isHexAddress(kernelAddress)) {
        throw new Error("missing_kernel_address_for_aa_readiness");
      }
      if (!publicRpcUrl) {
        throw new Error("missing_selfhost_public_rpc_url");
      }
      if (!paymasterAddress) {
        throw new Error("missing_selfhost_paymaster_address");
      }

      const readiness = await inspectSelfhostWirexAaReadiness({
        walletAddress: eoaAddress,
        kernelAddress,
        publicRpcUrl,
        paymasterAddress,
      });
      const summary = [
        "AA readiness",
        `eoa: ${eoaAddress}`,
        `aa: ${kernelAddress}`,
        `sponsorshipMode: ${asString(readiness.sponsorshipMode, "missing")}`,
        `paymaster: ${asString(readiness.paymasterAddressUsed, "missing")}`,
        `kernelDeployed: ${readiness.kernelDeployed === true ? "yes" : "no"}`,
        `fundsManagementInstalled: ${readiness.fundsManagementInstalled === true ? "yes" : "no"}`,
        `weightedInitialized: ${readiness.weightedInitialized === true ? "yes" : "no"}`,
        `weightedSignerCount: ${String(readiness.weightedSignerCount ?? 0)}`,
        `weightedThreshold: ${String(readiness.weightedThreshold ?? 0)}`,
        `weightedDelay: ${String(readiness.weightedDelay ?? 0)}`,
        `kernelBalanceEth: ${asString(readiness.kernelBalanceEth, "0")}`,
      ].join("\n");
      setAaReadinessResult(JSON.stringify(readiness, null, 2));
      setAaReadinessSummary(summary);
      appendAaTraceLog(
        [
          "aa_readiness_done",
          `aa=${shortAddress(kernelAddress)}`,
          `sponsorship=${asString(readiness.sponsorshipMode, "missing")}`,
          `paymaster=${shortAddress(asString(readiness.paymasterAddressUsed, paymasterAddress))}`,
          `fundsManagement=${readiness.fundsManagementInstalled === true ? "yes" : "no"}`,
          `weighted=${readiness.weightedInitialized === true ? "yes" : "no"}`,
        ].join(" "),
      );
      return readiness;
    },
    [
      aaPaymasterAddress,
      aaPublicRpcUrl,
      appendAaTraceLog,
      lastAaAddress,
      lastKernelAddress,
      normalizedWallet,
    ],
  );

  const handleCheckAaReadiness = async () => {
    setIsAaReadinessLoading(true);
    setAaReadinessError("");
    setAaReadinessSummary("");
    setAaReadinessResult("");
    setShowRawAaReadiness(false);
    setLoadingStageText("Checking sponsored AA readiness...");
    appendAaTraceLog("aa_readiness_start");
    try {
      await loadAaReadiness();
    } catch (e: unknown) {
      const message = errMsg(e);
      setAaReadinessError(formatAaBootstrapError(message));
      console.warn("[WirexDebug] AA readiness check failed", {
        wallet: shortAddress(normalizedWallet),
        walletAddress: normalizedWallet,
        aaAddress: lastKernelAddress || "",
        error: message,
      });
      appendAaTraceLog(`aa_readiness_error ${truncateMiddle(message.replace(/\s+/g, " "), 180)}`);
    } finally {
      setLoadingStageText("");
      setIsAaReadinessLoading(false);
    }
  };

  const handleRunAaSponsoredSend = async () => {
    setIsAaSponsoredSendLoading(true);
    setAaSponsoredSendError("");
    setAaSponsoredSendSummary("");
    setAaSponsoredSendResult("");
    setShowRawAaSponsoredSend(false);
    setLoadingStageText("Preparing sponsored AA token send...");
    appendAaTraceLog("aa_sponsored_send_start");
    let keyBytes: Uint8Array | null = null;
    let walletPrivateKeyHex = "";
    try {
      const aaBootstrap = await runOnDeviceAaBootstrap();
      const eoaAddressUsed = asString(aaBootstrap.eoaAddress, normalizedWallet);
      const kernelAddress = asString(aaBootstrap.kernelAddress, "");
      const readiness = await loadAaReadiness({
        eoaAddress: eoaAddressUsed,
        kernelAddress,
      });

      setLoadingStageText("Unlocking wallet for sponsored AA token send...");
      keyBytes = await getPrivateKey("ethereum");
      walletPrivateKeyHex = `0x${bytesToHex(keyBytes)}`;

      const transferResult = await sendSponsoredAaTokenTransferSelfhost(
        {
          walletAddress: eoaAddressUsed,
          walletPrivateKey: walletPrivateKeyHex,
          publicRpcUrl: aaPublicRpcUrl.trim(),
          bundlerRpcUrl: aaBundlerRpcUrl.trim(),
          paymasterAddress: aaPaymasterAddress.trim(),
          recipientAddress: aaSponsoredSendRecipient.trim(),
          tokenAddress: aaSponsoredSendTokenAddress.trim(),
          amount: aaSponsoredSendAmount.trim(),
          chainId: CHAIN_ID,
        },
        (progress) => {
          const details = asObject(progress.details);
          setLoadingStageText(
            progress.stage === "initializing"
              ? "Sponsored AA send: initializing"
              : progress.stage === "readiness_checked"
                ? "Sponsored AA send: readiness checked"
                : progress.stage === "token_transfer_prepared"
                  ? "Sponsored AA send: token transfer prepared"
                  : progress.stage === "user_operation_sent"
                    ? "Sponsored AA send: waiting for onchain receipt"
                    : progress.stage === "completed"
                      ? "Sponsored AA send: completed"
                      : `Sponsored AA send: ${progress.stage.replace(/_/g, " ")}`,
          );
          appendAaTraceLog(
            [
              "aa_sponsored_send",
              `stage=${progress.stage}`,
              asString(details?.hash) ? `hash=${truncateMiddle(asString(details?.hash), 18)}` : "",
              asString(details?.kernelAddress)
                ? `aa=${shortAddress(asString(details?.kernelAddress))}`
                : "",
              asString(details?.paymasterAddressUsed)
                ? `paymaster=${shortAddress(asString(details?.paymasterAddressUsed))}`
                : "",
              asString(details?.tokenSymbol) ? `token=${asString(details?.tokenSymbol)}` : "",
              asString(details?.rawAmount) ? `rawAmount=${asString(details?.rawAmount)}` : "",
              typeof details?.fundsManagementInstalled === "boolean"
                ? `fundsManagement=${details.fundsManagementInstalled ? "yes" : "no"}`
                : "",
              typeof details?.weightedInitialized === "boolean"
                ? `weighted=${details.weightedInitialized ? "yes" : "no"}`
                : "",
            ]
              .filter(Boolean)
              .join(" "),
          );
        },
      );

      const payload = {
        ...transferResult,
        aaBootstrap,
        readiness,
      };
      setAaSponsoredSendResult(JSON.stringify(payload, null, 2));
      setAaSponsoredSendSummary(buildAaSponsoredSendSummary(payload));
      console.log("[WirexDebug] AA sponsored send finished", {
        wallet: shortAddress(eoaAddressUsed),
        walletAddress: eoaAddressUsed,
        aa: shortAddress(asString(transferResult.kernelAddress)),
        aaAddress: asString(transferResult.kernelAddress),
        recipientAddress: asString(transferResult.recipientAddress),
        tokenAddress: asString(transferResult.tokenAddress),
        tokenSymbol: asString(transferResult.tokenSymbol),
        amount: asString(transferResult.amount),
        userOperationHash: asString(transferResult.userOperationHash),
        transactionHash: asString(transferResult.transactionHash),
      });
      appendAaTraceLog(
        [
          "aa_sponsored_send_done",
          `aa=${shortAddress(asString(transferResult.kernelAddress))}`,
          `token=${asString(transferResult.tokenSymbol, "unknown")}`,
          `amount=${asString(transferResult.amount, "unknown")}`,
          `hash=${truncateMiddle(asString(transferResult.userOperationHash), 18)}`,
        ].join(" "),
      );
    } catch (e: unknown) {
      const message = errMsg(e);
      setAaSponsoredSendError(formatAaBootstrapError(message));
      setAaSponsoredSendSummary("");
      setAaSponsoredSendResult("");
      console.warn("[WirexDebug] AA sponsored send failed", {
        wallet: shortAddress(normalizedWallet),
        walletAddress: normalizedWallet,
        aaAddress: lastKernelAddress || "",
        error: message,
      });
      appendAaTraceLog(
        `aa_sponsored_send_error ${truncateMiddle(message.replace(/\s+/g, " "), 180)}`,
      );
    } finally {
      if (keyBytes) {
        zeroize(keyBytes);
      }
      walletPrivateKeyHex = "";
      setLoadingStageText("");
      setIsAaSponsoredSendLoading(false);
    }
  };

  const handleAddAaCredential = async () => {
    setIsAaAddCredentialLoading(true);
    setAaAddCredentialError("");
    setAaAddCredentialSummary("");
    setAaAddCredentialResult("");
    setShowRawAaAddCredential(false);
    appendAaTraceLog("add_credential_start");
    try {
      let selected: {
        credId: string;
        credPubkey: string;
        keyLabel?: string;
        source:
          | "native_existing"
          | "native_created"
          | "web_existing"
          | "web_created"
          | "pending_resume";
      } | null = null;
      if (
        pendingAaCredential &&
        asString(pendingAaCredential.credId).trim() &&
        asString(pendingAaCredential.credPubkey).trim()
      ) {
        const ageSec = Math.max(
          0,
          Math.floor((Date.now() - pendingAaCredential.capturedAtMs) / 1000),
        );
        appendAaTraceLog(
          `add_credential_resume_pending ageSec=${ageSec} credIdLen=${pendingAaCredential.credId.length}`,
        );
        appendPasskeyCaptureLog(
          `reusing pending credential metadata credIdLen=${pendingAaCredential.credId.length} ageSec=${ageSec}`,
        );
        setLoadingStageText("Retrying pending AA credential install...");
        selected = {
          credId: pendingAaCredential.credId,
          credPubkey: pendingAaCredential.credPubkey,
          source: "pending_resume",
        };
      } else {
        setLoadingStageText("Capture a new passkey credential to add...");
        appendPasskeyCaptureLog("add credential flow: choose Create passkey or hardware key");
        const captured = await requestPasskeyMetadataViaCapturePanel({
          autoTriggerExisting: false,
          intent: "metadata",
          createKeyIndex: 2,
        });
        if (!captured || !asString(captured.credId).trim()) {
          throw new Error("add_credential_capture_missing_credential_id");
        }
        selected = captured;
      }
      const primaryCredId = asString(walletPasskeyCredIdB64u).trim();
      if (selected.credId === primaryCredId) {
        throw new Error(
          "Selected credential matches the current primary key. Create or choose a different key for Key2.",
        );
      }
      const selectedCredPubkey = asString(selected.credPubkey).trim();
      if (!selectedCredPubkey) {
        throw new Error("add_credential_capture_missing_public_key");
      }
      setPendingAaCredential({
        credId: selected.credId,
        credPubkey: selectedCredPubkey,
        source: selected.source,
        capturedAtMs: Date.now(),
      });
      setLoadingStageText("Installing credential into AA account...");
      const runAddCredentialBootstrap = async () =>
        await runOnDeviceAaBootstrap({
          allowPasskeyCapture: false,
          passkeyCredIdOverride: selected.credId,
          passkeyCredPubkeyOverride: selectedCredPubkey,
          bootstrapMode: "add_credential",
        });
      let aaBootstrap: Record<string, unknown>;
      try {
        aaBootstrap = await runAddCredentialBootstrap();
      } catch (addError: unknown) {
        const message = errMsg(addError);
        if (!shouldAutoRetryAaBootstrapError(message)) {
          throw addError;
        }
        const retryDelayMs = getAaBootstrapRetryDelayMs(message);
        setLoadingStageText(
          `Add credential failed once. Retrying in ${Math.ceil(retryDelayMs / 1000)}s...`,
        );
        appendAaTraceLog(
          `add_credential_retry_after_error delayMs=${retryDelayMs} reason=${truncateMiddle(
            message.replace(/\s+/g, " "),
            140,
          )}`,
        );
        await waitMs(retryDelayMs);
        aaBootstrap = await runAddCredentialBootstrap();
      }
      const eoaAddressUsed = asString(aaBootstrap.eoaAddress, normalizedWallet);
      const kernelAddress = asString(aaBootstrap.kernelAddress, "unknown");
      const wasAlreadyInstalled =
        aaBootstrap.webAuthnPermissionInstalledBefore === true &&
        !asString(aaBootstrap.userOperationHash).trim();

      const payload = {
        ok: true,
        mode: "add_credential",
        eoaAddress: eoaAddressUsed,
        aaAddress: kernelAddress,
        credential: {
          source: selected.source,
          credId: selected.credId,
          credIdLen: selected.credId.length,
          keyLabel: asString(selected.keyLabel),
          hasPubkey: true,
        },
        aaBootstrapPath: wasAlreadyInstalled
          ? "credential_already_installed"
          : "credential_installed",
        aaBootstrap,
      };
      setAaAddCredentialResult(JSON.stringify(payload, null, 2));
      setAaAddCredentialSummary(
        [
          "AA add credential",
          `credentialSource: ${selected.source}`,
          `credentialIdLen: ${selected.credId.length}`,
          `credentialLabel: ${asString(selected.keyLabel, "none") || "none"}`,
          `eoa: ${eoaAddressUsed || "unknown"}`,
          `aa: ${kernelAddress}`,
          `status: ${wasAlreadyInstalled ? "already_installed" : "installed_now"}`,
          `permissionInstalledBefore: ${String(
            aaBootstrap.webAuthnPermissionInstalledBefore === true,
          )}`,
          `permissionInstalledAfter: ${String(
            aaBootstrap.webAuthnPermissionInstalledAfter === true,
          )}`,
          `userOperationHash: ${asString(aaBootstrap.userOperationHash, "none") || "none"}`,
          `permissionId: ${asString(aaBootstrap.permissionId, "missing")}`,
        ].join("\n"),
      );
      setPendingAaCredential(null);
      console.log("[WirexDebug] AA add credential finished", {
        wallet: shortAddress(eoaAddressUsed),
        walletAddress: eoaAddressUsed,
        aa: shortAddress(kernelAddress),
        aaAddress: kernelAddress,
        permissionId: asString(aaBootstrap.permissionId),
        credentialSource: selected.source,
        credentialIdLen: selected.credId.length,
        credentialLabel: asString(selected.keyLabel),
        bootstrapMode: "add_credential",
      });
      appendAaTraceLog(
        `add_credential_done permissionId=${asString(aaBootstrap.permissionId, "missing")}`,
      );
    } catch (e: unknown) {
      const message = errMsg(e);
      setAaAddCredentialError(message);
      setAaAddCredentialSummary("");
      setAaAddCredentialResult("");
      if (shouldKeepPendingAaCredentialAfterError(message)) {
        setAaAddCredentialSummary(
          "AA credential update is still pending or timed out. Retry add credential without creating a new passkey.",
        );
      } else {
        setPendingAaCredential(null);
      }
      console.warn("[WirexDebug] AA add credential failed", {
        wallet: shortAddress(normalizedWallet),
        walletAddress: normalizedWallet,
        aaAddress: lastKernelAddress || "",
        error: message,
      });
      appendAaTraceLog(`add_credential_error ${truncateMiddle(message.replace(/\s+/g, " "), 180)}`);
    } finally {
      setLoadingStageText("");
      setIsAaAddCredentialLoading(false);
    }
  };

  const handleRunAaPasskeySignTest = async () => {
    setIsAaPasskeySignTestLoading(true);
    setAaPasskeySignTestError("");
    setAaPasskeySignTestSummary("");
    setAaPasskeySignTestResult("");
    setShowRawAaPasskeySignTest(false);
    setLoadingStageText("Running passkey auth check...");
    appendAaTraceLog("aa_sign_test_start");
    try {
      const passkeyAuth = await requestPasskeyAuthForAaSignTest();
      setLoadingStageText("Initializing Wirex AA account...");
      const aaBootstrap = await runOnDeviceAaBootstrap({
        allowPasskeyCapture: false,
        passkeyCredIdOverride: passkeyAuth.credId,
      });
      const initPath = "wirex_init_discover_onchain";

      const initializedDuringTest = Boolean(
        asString(aaBootstrap.userOperationHash).trim() ||
          aaBootstrap.webAuthnPermissionInstalledBefore !== true,
      );
      const eoaAddressUsed = asString(aaBootstrap.eoaAddress, normalizedWallet);
      const kernelAddress = asString(aaBootstrap.kernelAddress, "unknown");

      const payload = {
        ok: true,
        eoaAddress: eoaAddressUsed,
        aaAddress: kernelAddress,
        passkeyAuth: {
          source: passkeyAuth.source,
          credId: passkeyAuth.credId,
          credIdLen: passkeyAuth.credId.length,
        },
        wirexInitPath: initPath,
        aaBootstrapPath: initializedDuringTest
          ? "auto_initialized_then_sign_test"
          : "already_ready_then_sign_test",
        aaBootstrap,
      };
      setAaPasskeySignTestResult(JSON.stringify(payload, null, 2));
      setAaPasskeySignTestSummary(
        [
          "AA passkey sign test",
          `passkeyAuth: ok (${passkeyAuth.source})`,
          `wirexInitPath: ${initPath}`,
          `eoa: ${eoaAddressUsed || "unknown"}`,
          `aa: ${kernelAddress}`,
          `aaBootstrapPath: ${
            initializedDuringTest
              ? "auto_initialized_then_sign_test"
              : "already_ready_then_sign_test"
          }`,
          `credentialId: ${
            passkeyAuth.credId.length > 14
              ? `${passkeyAuth.credId.slice(0, 8)}...${passkeyAuth.credId.slice(-6)}`
              : passkeyAuth.credId || "missing"
          }`,
          `credentialIdLen: ${passkeyAuth.credId.length}`,
          `kernel: ${kernelAddress}`,
          `permissionInstalledBefore: ${String(
            aaBootstrap.webAuthnPermissionInstalledBefore === true,
          )}`,
          `permissionInstalledAfter: ${String(
            aaBootstrap.webAuthnPermissionInstalledAfter === true,
          )}`,
          `userOperationHash: ${asString(aaBootstrap.userOperationHash, "none") || "none"}`,
        ].join("\n"),
      );
      console.log("[WirexDebug] AA passkey sign test finished", {
        wallet: shortAddress(eoaAddressUsed),
        walletAddress: eoaAddressUsed,
        aa: shortAddress(kernelAddress),
        aaAddress: kernelAddress,
        permissionId: asString(aaBootstrap.permissionId),
        source: passkeyAuth.source,
        wirexInitPath: initPath,
      });
      appendAaTraceLog(
        `aa_sign_test_done permissionId=${asString(aaBootstrap.permissionId, "missing")}`,
      );
    } catch (e: unknown) {
      const message = errMsg(e);
      if (message === "missing_wallet_passkey_metadata_no_capture") {
        setAaPasskeySignTestError(
          "Wirex init failed to rediscover the onchain WebAuthn permission.",
        );
      } else {
        setAaPasskeySignTestError(message);
      }
      setAaPasskeySignTestSummary("");
      setAaPasskeySignTestResult("");
      console.warn("[WirexDebug] AA passkey sign test failed", {
        wallet: shortAddress(normalizedWallet),
        walletAddress: normalizedWallet,
        aaAddress: lastKernelAddress || "",
        error: message,
      });
      appendAaTraceLog(`aa_sign_test_error ${truncateMiddle(message.replace(/\s+/g, " "), 180)}`);
    } finally {
      setLoadingStageText("");
      setIsAaPasskeySignTestLoading(false);
    }
  };

  const handleRunAaBootstrapOnly = async () => {
    setIsLoading(true);
    setRequestStartedAtMs(Date.now());
    setRequestElapsedSec(0);
    setLiveBackendProgress(null);
    setLiveBackendError("");
    setError("");
    setOnboardingErrorRaw("");
    setLoadingStageText("Preparing AA bootstrap...");
    try {
      const aaBootstrap = await runOnDeviceAaBootstrap();
      const eoaAddressUsed = asString(aaBootstrap.eoaAddress, normalizedWallet);
      const payload = {
        ok: true,
        walletAddress: eoaAddressUsed,
        aaBootstrap,
      };
      setResult(JSON.stringify(payload, null, 2));
      setSnapshot("");
      setOnboardingPayload(null);
      setKycUrl(null);
      setKycSdkToken(null);
      setOnboardingSummary(
        [
          "AA Bootstrap (on-device)",
          `kernel: ${asString(aaBootstrap.kernelAddress, "unknown")}`,
          `permissionInstalledAfter: ${String(
            aaBootstrap.webAuthnPermissionInstalledAfter === true,
          )}`,
          `userOperationHash: ${asString(aaBootstrap.userOperationHash, "none") || "none"}`,
        ].join("\n"),
      );
      setProvisioningSummary("");
      console.log("[WirexDebug] On-device AA bootstrap finished", {
        wallet: shortAddress(eoaAddressUsed),
        walletAddress: eoaAddressUsed,
        aa: shortAddress(asString(aaBootstrap.kernelAddress)),
        aaAddress: asString(aaBootstrap.kernelAddress),
        permissionId: asString(aaBootstrap.permissionId),
      });
    } catch (e: unknown) {
      const message = errMsg(e);
      setOnboardingErrorRaw(message);
      setError(formatAaBootstrapError(message));
      console.warn("[WirexDebug] On-device AA bootstrap failed", {
        wallet: shortAddress(normalizedWallet),
        walletAddress: normalizedWallet,
        aaAddress: lastKernelAddress || "",
        error: message,
      });
    } finally {
      setLoadingStageText("");
      setIsLoading(false);
      setRequestStartedAtMs(null);
      setRequestElapsedSec(0);
      liveProgressPollingRef.current = false;
    }
  };

  const handleCreate = async () => {
    if (!isHexAddress(normalizedWallet)) {
      setError("Missing valid EOA wallet address.");
      setOnboardingErrorRaw("Missing valid EOA wallet address.");
      return;
    }

    setIsLoading(true);
    setRequestStartedAtMs(Date.now());
    setRequestElapsedSec(0);
    setLiveBackendProgress(null);
    setLiveBackendError("");
    liveProgressPollingRef.current = false;
    setError("");
    setOnboardingErrorRaw("");
    setResult("");
    setSnapshot("");
    setOnboardingSummary("");
    setProvisioningSummary("");
    setOnboardingPayload(null);
    setShowRawOnboarding(false);
    setShowRawSnapshot(false);
    setKycUrl(null);
    setKycSdkToken(null);
    setIsKycModalVisible(false);
    appendAaTraceLog(
      `create_flow_start wallet=${shortAddress(normalizedWallet)} chainId=${CHAIN_ID}`,
    );
    setLoadingStageText("Checking Wirex service...");
    try {
      await executeOnboardingSync();
    } catch (e: unknown) {
      const message = errMsg(e);
      setOnboardingErrorRaw(message);
      setError(formatAaBootstrapError(message));
      setOnboardingSummary("");
      setProvisioningSummary("");
      setOnboardingPayload(null);
      setKycSdkToken(null);
      console.warn("[WirexDebug] Wirex sandbox flow failed", {
        wallet: shortAddress(normalizedWallet),
        error: message,
      });
      appendAaTraceLog(`create_flow_error ${truncateMiddle(message.replace(/\s+/g, " "), 180)}`);
    } finally {
      setLoadingStageText("");
      setIsLoading(false);
      setRequestStartedAtMs(null);
      setRequestElapsedSec(0);
      liveProgressPollingRef.current = false;
    }
  };

  const handleTryTokenSharing = async () => {
    if (!isHexAddress(normalizedWallet)) {
      setError("Missing valid EOA wallet address.");
      setOnboardingErrorRaw("Missing valid EOA wallet address.");
      return;
    }

    setIsLoading(true);
    setRequestStartedAtMs(Date.now());
    setRequestElapsedSec(0);
    setLiveBackendProgress(null);
    setLiveBackendError("");
    liveProgressPollingRef.current = false;
    setError("");
    setOnboardingErrorRaw("");
    setLoadingStageText("Checking Wirex service...");
    try {
      const resolvedProxyBaseUrl = await runProxyHealthCheck();
      if (!resolvedProxyBaseUrl) {
        const message = "Wirex service is unreachable. Check wirex.nuri.com DNS/TLS.";
        setError(message);
        setOnboardingErrorRaw(message);
        return;
      }

      const sharingResolved = await resolveSharingTokenInput();
      setSharingSource(sharingResolved.source);
      if (!sharingResolved.token) {
        const message =
          "Token sharing did not return a reusable token. Check the sharing token error details.";
        setError(message);
        setOnboardingErrorRaw(message);
        return;
      }

      setLoadingStageText("Running token sharing test...");
      const payload = await runWirexDebugOnboarding({
        walletAddress: normalizedWallet,
        email,
        country: COUNTRY,
        chainId: CHAIN_ID,
        bankAccountType: BANK_ACCOUNT_TYPE,
        proxyBaseUrl: resolvedProxyBaseUrl,
        sharingToken: sharingResolved.token,
        attemptAaBootstrap: false,
      });
      applyOnboardingPayload(payload);
    } catch (e: unknown) {
      const message = errMsg(e);
      setOnboardingErrorRaw(message);
      setError(message);
    } finally {
      setLoadingStageText("");
      setIsLoading(false);
      setRequestStartedAtMs(null);
      setRequestElapsedSec(0);
      liveProgressPollingRef.current = false;
    }
  };

  const applyPushSnapshotAndSelections = useCallback((payload: unknown) => {
    const payloadObj = asObject(payload);
    if (!payloadObj) return null;
    const selectedTokenAddress = asString(payloadObj?.selectedTokenAddress, "");
    if (selectedTokenAddress) {
      setPushTokenAddress(selectedTokenAddress);
    }
    const externalCardId = asString(payloadObj?.externalCardId, "");
    if (externalCardId) {
      setPushExternalCardId(externalCardId);
    }
    const snapshotValue = payloadObj?.snapshot;
    if (snapshotValue && typeof snapshotValue === "object") {
      setSnapshot(JSON.stringify(snapshotValue, null, 2));
    }
    return payloadObj;
  }, []);

  const applyPushFlowOperations = useCallback(
    (payloadObj: Record<string, unknown> | null) => {
      const operations = asObject(payloadObj?.operations);
      const recipientPayload = asObject(operations?.recipient);
      const mintPayload = asObject(operations?.mint);
      const pushPayloadValue = asObject(operations?.push);

      if (recipientPayload) {
        setPushRecipientPayload(recipientPayload);
        setPushRecipientResult(JSON.stringify(recipientPayload, null, 2));
        setPushRecipientSummary(buildPushRecipientSummary(recipientPayload));
        applyPushSnapshotAndSelections(recipientPayload);
      }
      if (mintPayload) {
        setPushMintPayload(mintPayload);
        setPushMintResult(JSON.stringify(mintPayload, null, 2));
        setPushMintSummary(buildPushMintSummary(mintPayload));
        applyPushSnapshotAndSelections(mintPayload);
      }
      if (pushPayloadValue) {
        setPushPayload(pushPayloadValue);
        setPushResult(JSON.stringify(pushPayloadValue, null, 2));
        setPushSummary(buildPushSummary(pushPayloadValue));
        applyPushSnapshotAndSelections(pushPayloadValue);
      }
    },
    [applyPushSnapshotAndSelections],
  );

  const ensureProxyBaseUrlOrThrow = useCallback(async (): Promise<string> => {
    const resolvedProxyBaseUrl = await runProxyHealthCheck();
    if (!resolvedProxyBaseUrl) {
      throw new Error("Wirex service is unreachable. Check wirex.nuri.com DNS/TLS.");
    }
    return resolvedProxyBaseUrl;
  }, [runProxyHealthCheck]);

  const executeOnboardingSync = useCallback(async (): Promise<Record<string, unknown> | null> => {
    const resolvedProxyBaseUrl = await ensureProxyBaseUrlOrThrow();
    const sharingResolved = await resolveSharingTokenInput();
    const effectiveSharingToken = sharingResolved.token;
    const sharingTokenSource = sharingResolved.source;
    setSharingSource(sharingTokenSource);

    setLoadingStageText("Running account creation and provisioning flow...");
    console.log("[WirexDebug] Starting Wirex sandbox flow", {
      wallet: shortAddress(normalizedWallet),
      country: COUNTRY,
      chainId: CHAIN_ID,
      bankAccountType: BANK_ACCOUNT_TYPE,
      proxy: resolvedProxyBaseUrl,
      hasSharingToken: Boolean(effectiveSharingToken),
      sharingTokenSource,
      wirexSumsubClientId: wirexSumsubClientId.trim() || "missing",
    });

    let onboardingAttempt = 0;
    const runRemoteOnboarding = async (): Promise<Record<string, unknown> | null> => {
      onboardingAttempt += 1;
      appendAaTraceLog(
        `backend_onboarding_attempt=${onboardingAttempt} hasSharingToken=${String(
          Boolean(effectiveSharingToken),
        )} source=${sharingTokenSource}`,
      );
      const payload = await runWirexDebugOnboarding({
        walletAddress: normalizedWallet,
        email,
        country: COUNTRY,
        chainId: CHAIN_ID,
        bankAccountType: BANK_ACCOUNT_TYPE,
        proxyBaseUrl: resolvedProxyBaseUrl,
        sharingToken: effectiveSharingToken || undefined,
        attemptAaBootstrap: false,
      });
      return asObject(payload);
    };

    let onboardingPayloadObj = await runRemoteOnboarding();
    let aaBootstrapSummary: Record<string, unknown> | null = null;
    const runBootstrapWithRetry = async () => {
      let attempt = 0;
      while (true) {
        try {
          return await runOnDeviceAaBootstrap();
        } catch (bootstrapError: unknown) {
          const message = errMsg(bootstrapError);
          const shouldRetry = shouldRetryAaBootstrapError(message);
          if (!shouldRetry || attempt >= AA_BOOTSTRAP_RETRY_MAX) {
            throw bootstrapError;
          }
          attempt += 1;
          const retryDelayMs = getAaBootstrapRetryDelayMs(message);
          appendAaTraceLog(
            `aa_bootstrap_retry_triggered attempt=${attempt}/${AA_BOOTSTRAP_RETRY_MAX} delayMs=${retryDelayMs} reason=${truncateMiddle(
              message.replace(/\s+/g, " "),
              140,
            )}`,
          );
          setLoadingStageText(
            `AA bootstrap retry ${attempt}/${AA_BOOTSTRAP_RETRY_MAX} in ${Math.ceil(
              retryDelayMs / 1000,
            )}s...`,
          );
          await waitMs(retryDelayMs);
        }
      }
    };

    let bootstrapPass = 0;
    while (
      needsOnDeviceAaBootstrap(onboardingPayloadObj) &&
      bootstrapPass < AA_CREATE_BOOTSTRAP_PASSES_MAX
    ) {
      bootstrapPass += 1;
      appendAaTraceLog(
        `backend_requires_on_device_aa_bootstrap pass=${bootstrapPass}/${AA_CREATE_BOOTSTRAP_PASSES_MAX}`,
      );

      aaBootstrapSummary = await runBootstrapWithRetry();

      let syncRetry = 0;
      do {
        setLoadingStageText(
          syncRetry === 0
            ? "AA bootstrap done. Retrying account sync..."
            : `Waiting for backend sync... (${syncRetry}/${AA_ONBOARDING_SYNC_RETRY_MAX})`,
        );
        if (syncRetry > 0) {
          await waitMs(AA_BOOTSTRAP_RETRY_DELAY_MS);
        }
        onboardingPayloadObj = await runRemoteOnboarding();
        syncRetry += 1;
      } while (
        needsOnDeviceAaBootstrap(onboardingPayloadObj) &&
        syncRetry <= AA_ONBOARDING_SYNC_RETRY_MAX
      );
    }

    const finalPayload = attachAaBootstrapSummary(onboardingPayloadObj, aaBootstrapSummary);
    applyOnboardingPayload(finalPayload);
    if (needsOnDeviceAaBootstrap(asObject(finalPayload))) {
      appendAaTraceLog("backend_still_requires_aa_bootstrap_after_retries");
      throw new Error("AA bootstrap is still required after automatic retries. Share useful logs.");
    }
    console.log("[WirexDebug] Wirex sandbox flow finished", {
      wallet: shortAddress(normalizedWallet),
    });
    appendAaTraceLog("create_flow_done");
    return asObject(finalPayload);
  }, [
    appendAaTraceLog,
    applyOnboardingPayload,
    email,
    ensureProxyBaseUrlOrThrow,
    normalizedWallet,
    resolveSharingTokenInput,
    runOnDeviceAaBootstrap,
    wirexSumsubClientId,
  ]);

  const validatePushExecutionInputs = useCallback(() => {
    if (!isHexAddress(normalizedWallet)) {
      throw new Error("Missing valid EOA wallet address.");
    }
    const amount = Number(pushAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("Push amount must be greater than zero.");
    }
    const normalizedCardNumber = String(pushCardNumber || "").replace(/[^\d]/g, "");
    return {
      amount,
      normalizedCardNumber,
      normalizedExternalCardId: pushExternalCardId.trim(),
      normalizedCurrency: pushCurrency.trim() || DEFAULT_PUSH_TO_CARD_CURRENCY,
      normalizedTokenAddress: pushTokenAddress.trim() || undefined,
      normalizedCardholderName: pushCardholderName.trim(),
      normalizedCardLabel: pushCardLabel.trim() || undefined,
    };
  }, [
    normalizedWallet,
    pushAmount,
    pushCardLabel,
    pushCardNumber,
    pushCardholderName,
    pushCurrency,
    pushExternalCardId,
    pushTokenAddress,
  ]);

  const executeCreatePushRecipientStep = useCallback(
    async (resolvedProxyBaseUrl?: string): Promise<Record<string, unknown> | null> => {
      const { normalizedCardNumber, normalizedCardholderName } = validatePushExecutionInputs();
      if (!/^\d{12,19}$/.test(normalizedCardNumber)) {
        throw new Error("Card number must be 12-19 digits.");
      }
      if (!normalizedCardholderName) {
        throw new Error("Cardholder name is required.");
      }
      const proxyBaseUrl = resolvedProxyBaseUrl || (await ensureProxyBaseUrlOrThrow());
      setLoadingStageText("Tokenizing card and creating recipient...");
      const payload = await runWirexDebugCreateCardRecipientFromCard({
        walletAddress: normalizedWallet,
        chainId: CHAIN_ID,
        proxyBaseUrl,
        cardNumber: normalizedCardNumber,
        cardholderName: normalizedCardholderName,
        cardLabel: pushCardLabel.trim() || undefined,
      });
      setPushRecipientResult(JSON.stringify(payload, null, 2));
      setPushRecipientSummary(buildPushRecipientSummary(payload));
      const payloadObj = applyPushSnapshotAndSelections(payload);
      setPushRecipientPayload(payloadObj);
      return payloadObj;
    },
    [
      applyPushSnapshotAndSelections,
      ensureProxyBaseUrlOrThrow,
      normalizedWallet,
      pushCardLabel,
      validatePushExecutionInputs,
    ],
  );

  const executeMintPushFundsStep = useCallback(
    async (resolvedProxyBaseUrl?: string): Promise<Record<string, unknown> | null> => {
      const { amount, normalizedCurrency, normalizedTokenAddress } = validatePushExecutionInputs();
      const proxyBaseUrl = resolvedProxyBaseUrl || (await ensureProxyBaseUrlOrThrow());
      setLoadingStageText("Minting sandbox wallet funds...");
      const payload = await runWirexDebugMintSandboxBalance({
        walletAddress: normalizedWallet,
        chainId: CHAIN_ID,
        proxyBaseUrl,
        amount,
        currency: normalizedCurrency,
        tokenAddress: normalizedTokenAddress,
      });
      setPushMintResult(JSON.stringify(payload, null, 2));
      setPushMintSummary(buildPushMintSummary(payload));
      const payloadObj = applyPushSnapshotAndSelections(payload);
      setPushMintPayload(payloadObj);
      return payloadObj;
    },
    [
      applyPushSnapshotAndSelections,
      ensureProxyBaseUrlOrThrow,
      normalizedWallet,
      validatePushExecutionInputs,
    ],
  );

  const executePushToCardStep = useCallback(
    async (resolvedProxyBaseUrl?: string): Promise<Record<string, unknown> | null> => {
      const { amount, normalizedCurrency, normalizedExternalCardId, normalizedTokenAddress } =
        validatePushExecutionInputs();
      const proxyBaseUrl = resolvedProxyBaseUrl || (await ensureProxyBaseUrlOrThrow());
      setLoadingStageText("Running push-to-card...");
      const payload = await runWirexDebugPushToCard({
        walletAddress: normalizedWallet,
        chainId: CHAIN_ID,
        proxyBaseUrl,
        externalCardId: normalizedExternalCardId || undefined,
        amount,
        currency: normalizedCurrency,
        tokenAddress: normalizedTokenAddress,
        execute: true,
      });
      setPushResult(JSON.stringify(payload, null, 2));
      setPushSummary(buildPushSummary(payload));
      const payloadObj = applyPushSnapshotAndSelections(payload);
      setPushPayload(payloadObj);
      return payloadObj;
    },
    [
      applyPushSnapshotAndSelections,
      ensureProxyBaseUrlOrThrow,
      normalizedWallet,
      validatePushExecutionInputs,
    ],
  );

  const handleRunFullPushDemo = async () => {
    if (!isHexAddress(normalizedWallet)) {
      setPushFlowError("Missing valid EOA wallet address.");
      return;
    }

    const amount = Number(pushAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setPushFlowError("Push amount must be greater than zero.");
      return;
    }

    const normalizedCardNumber = String(pushCardNumber || "").replace(/[^\d]/g, "");
    if (!pushExternalCardId.trim() && !/^\d{12,19}$/.test(normalizedCardNumber)) {
      setPushFlowError("Card number must be 12-19 digits when no external card id is set.");
      return;
    }
    if (!pushExternalCardId.trim() && !pushCardholderName.trim()) {
      setPushFlowError("Cardholder name is required when no external card id is set.");
      return;
    }

    setIsPushFlowLoading(true);
    setRequestStartedAtMs(Date.now());
    setRequestElapsedSec(0);
    setPushError("");
    setPushMintError("");
    setPushRecipientError("");
    setPushResult("");
    setPushMintResult("");
    setPushRecipientResult("");
    setPushSummary("");
    setPushMintSummary("");
    setPushRecipientSummary("");
    setPushFlowError("");
    setPushFlowResult("");
    setPushFlowSummary("");
    setPushPayload(null);
    setPushMintPayload(null);
    setPushRecipientPayload(null);
    setPushFlowPayload(null);
    setShowRawPushFlow(false);
    setLoadingStageText("Checking Wirex service...");
    try {
      const resolvedProxyBaseUrl = await runProxyHealthCheck();
      if (!resolvedProxyBaseUrl) {
        setPushFlowError("Wirex service is unreachable. Check wirex.nuri.com DNS/TLS.");
        return;
      }

      setLoadingStageText("Running full sandbox push demo...");
      const payload = await runWirexDebugPushToCardFlow({
        walletAddress: normalizedWallet,
        chainId: CHAIN_ID,
        proxyBaseUrl: resolvedProxyBaseUrl,
        externalCardId: pushExternalCardId.trim() || undefined,
        amount,
        currency: pushCurrency.trim() || DEFAULT_PUSH_TO_CARD_CURRENCY,
        tokenAddress: pushTokenAddress.trim() || undefined,
        execute: true,
        cardNumber: normalizedCardNumber || undefined,
        cardholderName: pushCardholderName.trim() || undefined,
        cardLabel: pushCardLabel.trim() || undefined,
      });
      const payloadObj = applyPushSnapshotAndSelections(payload);
      setPushFlowPayload(payloadObj);
      setPushFlowResult(JSON.stringify(payload, null, 2));
      setPushFlowSummary(buildPushFlowSummary(payload));
      applyPushFlowOperations(payloadObj);
      console.log("[WirexDebug] Full push demo finished", {
        wallet: shortAddress(normalizedWallet),
        ok: payloadObj?.ok === true,
      });
    } catch (e: unknown) {
      const message = errMsg(e);
      setPushFlowError(message);
      setPushFlowSummary("");
      console.warn("[WirexDebug] Full push demo failed", {
        wallet: shortAddress(normalizedWallet),
        error: message,
      });
    } finally {
      setLoadingStageText("");
      setIsPushFlowLoading(false);
      setRequestStartedAtMs(null);
      setRequestElapsedSec(0);
    }
  };

  const handlePushToCard = async () => {
    setIsPushLoading(true);
    setRequestStartedAtMs(Date.now());
    setRequestElapsedSec(0);
    setPushError("");
    setPushResult("");
    setPushSummary("");
    setPushPayload(null);
    setShowRawPush(false);
    setLoadingStageText("Checking Wirex service...");
    try {
      await executePushToCardStep();
      console.log("[WirexDebug] Push to card finished", {
        wallet: shortAddress(normalizedWallet),
      });
    } catch (e: unknown) {
      const message = errMsg(e);
      setPushError(message);
      setPushSummary("");
      console.warn("[WirexDebug] Push to card failed", {
        wallet: shortAddress(normalizedWallet),
        error: message,
      });
    } finally {
      setLoadingStageText("");
      setIsPushLoading(false);
      setRequestStartedAtMs(null);
      setRequestElapsedSec(0);
    }
  };

  const handleMintPushFunds = async () => {
    setIsPushMintLoading(true);
    setRequestStartedAtMs(Date.now());
    setRequestElapsedSec(0);
    setPushMintError("");
    setPushMintResult("");
    setPushMintSummary("");
    setPushMintPayload(null);
    setShowRawPushMint(false);
    setLoadingStageText("Checking Wirex service...");
    try {
      const payloadObj = await executeMintPushFundsStep();
      console.log("[WirexDebug] Minted sandbox wallet funds", {
        wallet: shortAddress(normalizedWallet),
        token: asString(payloadObj?.selectedTokenAddress, "") || "auto",
      });
    } catch (e: unknown) {
      const message = errMsg(e);
      setPushMintError(message);
      setPushMintSummary("");
      console.warn("[WirexDebug] Sandbox mint failed", {
        wallet: shortAddress(normalizedWallet),
        error: message,
      });
    } finally {
      setLoadingStageText("");
      setIsPushMintLoading(false);
      setRequestStartedAtMs(null);
      setRequestElapsedSec(0);
    }
  };

  const handleCreatePushRecipientFromCard = async () => {
    setIsPushRecipientLoading(true);
    setRequestStartedAtMs(Date.now());
    setRequestElapsedSec(0);
    setPushRecipientError("");
    setPushRecipientResult("");
    setPushRecipientSummary("");
    setPushRecipientPayload(null);
    setShowRawPushRecipient(false);
    setLoadingStageText("Checking Wirex service...");
    try {
      const payloadObj = await executeCreatePushRecipientStep();
      const externalCardId = asString(payloadObj?.externalCardId, "");
      console.log("[WirexDebug] Created push recipient from card", {
        wallet: shortAddress(normalizedWallet),
        externalCardId: externalCardId || "missing",
      });
    } catch (e: unknown) {
      const message = errMsg(e);
      setPushRecipientError(message);
      setPushRecipientSummary("");
      console.warn("[WirexDebug] Create push recipient from card failed", {
        wallet: shortAddress(normalizedWallet),
        error: message,
      });
    } finally {
      setLoadingStageText("");
      setIsPushRecipientLoading(false);
      setRequestStartedAtMs(null);
      setRequestElapsedSec(0);
    }
  };

  const handleRunWirexChronologicalFlow = async () => {
    if (!isHexAddress(normalizedWallet)) {
      setRunAllError("Missing valid EOA wallet address.");
      return;
    }

    setIsRunAllLoading(true);
    setRequestStartedAtMs(Date.now());
    setRequestElapsedSec(0);
    setRunAllError("");
    setRunAllSummary("");
    setRunAllResult("");
    setShowRawRunAll(false);
    setError("");
    setOnboardingErrorRaw("");
    setPushError("");
    setPushMintError("");
    setPushRecipientError("");
    setLoadingStageText("Preparing chronological Wirex run...");
    appendAaTraceLog("wirex_run_all_start");

    try {
      const stepResults = await runWirexDebugFlowSteps(
        [
          {
            key: "onboarding",
            title: "1. Sync account and bootstrap AA",
            run: async () => {
              const payloadObj = await executeOnboardingSync();
              const summary = asObject(payloadObj?.summary);
              const snapshotPayload = asObject(payloadObj?.snapshot);
              const payloadKycUrl = asString(summary?.kycLink, "");
              const bankAccounts = readArray(snapshotPayload, "bankAccounts")
                .map((value) => asObject(value))
                .filter(Boolean) as Record<string, unknown>[];
              const cards = readArray(snapshotPayload, "cards")
                .map((value) => asObject(value))
                .filter(Boolean) as Record<string, unknown>[];
              const approved = asString(summary?.verificationStatus, "unknown") === "Approved";
              const sepaReady = hasActiveSepa(bankAccounts);
              const cardReady = hasActiveCard(cards);
              if (!approved) {
                return {
                  status: "action_required" as const,
                  note: payloadKycUrl
                    ? "KYC is still required. Complete it, then rerun run-all."
                    : "KYC is not approved yet. Refresh the sync after Wirex updates.",
                };
              }
              if (!sepaReady || !cardReady) {
                return {
                  status: "action_required" as const,
                  note: "Wirex provisioning is still incomplete. Cash account or card is not active yet.",
                };
              }
              return {
                status: "ok" as const,
                note: `Provisioned with ${bankAccounts.length} cash account(s) and ${cards.length} card(s).`,
              };
            },
          },
          {
            key: "recipient",
            title: "2. Create or reuse recipient",
            run: async () => {
              const payloadObj = await executeCreatePushRecipientStep();
              const externalCardId = asString(payloadObj?.externalCardId, "");
              return externalCardId
                ? {
                    status: "ok" as const,
                    note: `Recipient ready: ${truncateMiddle(externalCardId, 24)}`,
                  }
                : {
                    status: "action_required" as const,
                    note: "Recipient step completed without an external card id.",
                  };
            },
          },
          {
            key: "mint",
            title: "3. Mint sandbox balance",
            run: async () => {
              const payloadObj = await executeMintPushFundsStep();
              const summary = asObject(payloadObj?.summary);
              return {
                status: "ok" as const,
                note: asString(summary?.reason, "sandbox balance request accepted"),
              };
            },
          },
          {
            key: "push",
            title: "4. Execute push-to-card",
            run: async () => {
              const payloadObj = await executePushToCardStep();
              const summary = asObject(payloadObj?.summary);
              const transferId = asString(summary?.transferId, "");
              return transferId
                ? {
                    status: "ok" as const,
                    note: `Transfer created: ${truncateMiddle(transferId, 24)}`,
                  }
                : {
                    status: "action_required" as const,
                    note: "Push executed but no transfer id was returned.",
                  };
            },
          },
        ],
        (result) => {
          appendAaTraceLog(
            `wirex_run_all_step ${result.key} status=${result.status} note=${truncateMiddle(
              result.note.replace(/\s+/g, " "),
              120,
            )}`,
          );
          setLoadingStageText(`${result.title}: ${result.status}`);
        },
      );

      setRunAllSummary(buildWirexRunAllSummary(stepResults));
      setRunAllResult(JSON.stringify({ ok: true, steps: stepResults }, null, 2));
      appendAaTraceLog("wirex_run_all_done");
    } catch (e: unknown) {
      const message = errMsg(e);
      setRunAllError(formatAaBootstrapError(message));
      setRunAllSummary("");
      setRunAllResult("");
      appendAaTraceLog(`wirex_run_all_error ${truncateMiddle(message.replace(/\s+/g, " "), 180)}`);
    } finally {
      setLoadingStageText("");
      setIsRunAllLoading(false);
      setRequestStartedAtMs(null);
      setRequestElapsedSec(0);
    }
  };

  const handleOpenKyc = async () => {
    if (!kycUrl) return;
    try {
      if (Platform.OS === "web") {
        await Linking.openURL(kycUrl);
        return;
      }
      const SNSMobileSDK = getSumsubSdk();
      const hasNativeSdk = Boolean(SNSMobileSDK && typeof SNSMobileSDK.init === "function");
      if (kycSdkToken && hasNativeSdk) {
        try {
          const sdkInstance = SNSMobileSDK.init(kycSdkToken, async () => kycSdkToken)
            .withLocale("en")
            .withDebug(false)
            .build();
          await sdkInstance.launch();
          await handleCreate();
          return;
        } catch (nativeErr: unknown) {
          const msg = errMsg(nativeErr);
          console.warn("[WirexDebug] Native Sumsub launch failed, fallback to web", {
            wallet: shortAddress(normalizedWallet),
            error: msg,
          });
        }
      }
      setIsKycModalVisible(true);
    } catch (e: unknown) {
      const msg = errMsg(e);
      console.warn("[WirexDebug] Open KYC failed", {
        wallet: shortAddress(normalizedWallet),
        error: msg,
      });
    }
  };

  const handleOpenKycBrowser = async () => {
    if (!kycUrl) return;
    try {
      await Linking.openURL(kycUrl);
    } catch (e: unknown) {
      const msg = errMsg(e);
      console.warn("[WirexDebug] Open KYC browser failed", {
        wallet: shortAddress(normalizedWallet),
        error: msg,
      });
    }
  };

  const handleCloseModal = () => {
    setIsKycModalVisible(false);
    onClose();
  };

  return (
    <>
      <DsSheetHost visible={visible} onClose={handleCloseModal} mode="full">
        <Header safeAreaTop chrome="canvas">
          <Topbar surface="transparent">
            <TopbarTrailing>
              <IconButton
                icon="cross"
                variant="soft"
                accessibilityLabel="Close"
                onPress={handleCloseModal}
              />
            </TopbarTrailing>
          </Topbar>
        </Header>
        <Scroll safeAreaBottom>
          <View direction="column" align="stretch" gap="lg" paddingX="lg" paddingBottom="lg">
            <Text size="lg" emphasis>
              Wirex Sandbox Sign-up
            </Text>
            <View direction="column" align="stretch" gap="sm">
              <Text size="sm" emphasis>
                EOA
              </Text>
              <Text size="sm" muted mono>
                {normalizedWallet || "missing"}
              </Text>
              <Text size="sm" emphasis>
                Country
              </Text>
              <Text size="sm" muted>
                {COUNTRY}
              </Text>
              <Text size="sm" emphasis>
                Chain ID
              </Text>
              <Text size="sm" muted>
                {CHAIN_ID}
              </Text>
              <Text size="sm" emphasis>
                AA Provider
              </Text>
              <Text size="sm" muted>
                Selfhost only
              </Text>
              <TextField
                value={aaBundlerRpcUrl}
                onChangeText={setAaBundlerRpcUrl}
                placeholder="http://192.168.1.10:3000"
                autoCapitalize="none"
              >
                <TextFieldLabel>AA selfhost bundler RPC</TextFieldLabel>
              </TextField>
              <Text size="sm" muted>
                Required in selfhost mode. ZeroDev hosts are rejected.
              </Text>
              <TextField
                value={aaPaymasterAddress}
                onChangeText={setAaPaymasterAddress}
                placeholder="0x..."
                autoCapitalize="none"
              >
                <TextFieldLabel>AA selfhost paymaster</TextFieldLabel>
              </TextField>
              <Text size="sm" muted>
                Required in selfhost mode. Fresh kernels stay zero-funded when sponsorship is
                active.
              </Text>
              <TextField
                value={aaPublicRpcUrl}
                onChangeText={setAaPublicRpcUrl}
                placeholder="https://base-sepolia.g.alchemy.com/v2/..."
                autoCapitalize="none"
              >
                <TextFieldLabel>AA public Base Sepolia RPC</TextFieldLabel>
              </TextField>
              <Text size="sm" muted>
                Required in selfhost mode for chain reads and kernel balance checks.
              </Text>
              <Text size="sm" emphasis>
                Bank Type
              </Text>
              <Text size="sm" muted>
                {BANK_ACCOUNT_TYPE}
              </Text>
              <TextField
                value={HARDCODED_WIREX_PROXY_URL}
                placeholder={HARDCODED_WIREX_PROXY_URL}
                autoCapitalize="none"
                disabled
              >
                <TextFieldLabel>Proxy</TextFieldLabel>
              </TextField>
              <Button
                size="lg"
                variant="soft"
                onPress={runProxyHealthCheck}
                disabled={isCheckingProxy}
              >
                <ButtonText>
                  {isCheckingProxy ? "Checking Wirex service..." : "Check Wirex service"}
                </ButtonText>
              </Button>
              <Text size="sm" muted>
                Proxy status: {proxyHealthStatus}
              </Text>
              <Button
                size="lg"
                variant="soft"
                onPress={handleDumpUserProfile}
                disabled={isDumpingProfile}
              >
                <ButtonText>
                  {isDumpingProfile ? "Loading user profile..." : "Dump user profile"}
                </ButtonText>
              </Button>
              {profileDump ? (
                <View
                  variant="outline"
                  radius="lg"
                  padding="md"
                  direction="column"
                  align="stretch"
                  gap="sm"
                >
                  <Button
                    size="sm"
                    variant="soft"
                    onPress={() => handleCopyValue("User profile", profileDump)}
                  >
                    <ButtonText>Copy profile JSON</ButtonText>
                  </Button>
                  <Text size="sm" mono>
                    {profileDump}
                  </Text>
                </View>
              ) : null}
              <Button
                size="lg"
                variant="soft"
                onPress={handleDumpStatusCards}
                disabled={isDumpingStatusCards}
              >
                <ButtonText>
                  {isDumpingStatusCards ? "Loading cards..." : "Dump /status cards"}
                </ButtonText>
              </Button>
              {statusCardsDump ? (
                <View
                  variant="outline"
                  radius="lg"
                  padding="md"
                  direction="column"
                  align="stretch"
                  gap="sm"
                >
                  <Button
                    size="sm"
                    variant="soft"
                    onPress={() => handleCopyValue("Status cards", statusCardsDump)}
                  >
                    <ButtonText>Copy cards JSON</ButtonText>
                  </Button>
                  <Text size="sm" mono>
                    {statusCardsDump}
                  </Text>
                </View>
              ) : null}
              <Button
                size="lg"
                variant="soft"
                onPress={handleIssueVirtualCard}
                disabled={isIssuingVirtualCard}
              >
                <ButtonText>
                  {isIssuingVirtualCard ? "Issuing virtual card..." : "Issue extra virtual card"}
                </ButtonText>
              </Button>
              {virtualCardDump ? (
                <View
                  variant="outline"
                  radius="lg"
                  padding="md"
                  direction="column"
                  align="stretch"
                  gap="sm"
                >
                  <Button
                    size="sm"
                    variant="soft"
                    onPress={() => handleCopyValue("Virtual card", virtualCardDump)}
                  >
                    <ButtonText>Copy virtual card JSON</ButtonText>
                  </Button>
                  <Text size="sm" mono>
                    {virtualCardDump}
                  </Text>
                </View>
              ) : null}
              <TextField
                value={closeCardId}
                onChangeText={(value) => {
                  setCloseCardId(value);
                  setCloseArmed(false); // a changed target disarms the confirm
                }}
                placeholder="card_id"
                autoCapitalize="none"
              >
                <TextFieldLabel>Close card (permanent)</TextFieldLabel>
              </TextField>
              <TextField
                value={closeCardLast4}
                onChangeText={(value) => {
                  setCloseCardLast4(value);
                  setCloseArmed(false);
                }}
                placeholder="last4 (from /status)"
                autoCapitalize="none"
              >
                <TextFieldLabel>last4</TextFieldLabel>
              </TextField>
              <Button
                size="lg"
                variant="soft"
                onPress={handleCloseCard}
                disabled={isClosingCard || !closeCardId.trim() || !closeCardLast4.trim()}
              >
                <ButtonText>
                  {isClosingCard
                    ? "Closing card..."
                    : closeArmed
                      ? "Tap again to close PERMANENTLY"
                      : "Close card permanently"}
                </ButtonText>
              </Button>
              {closeCardDump ? (
                <View
                  variant="outline"
                  radius="lg"
                  padding="md"
                  direction="column"
                  align="stretch"
                  gap="sm"
                >
                  <Text size="sm" mono>
                    {closeCardDump}
                  </Text>
                </View>
              ) : null}
              <Text size="sm" emphasis>
                Email
              </Text>
              <Text size="sm" muted>
                {email}
              </Text>
              <Text size="sm" emphasis>
                Wallet passkey metadata
              </Text>
              <Text size="sm" muted>
                credIdLen={walletPasskeyCredIdB64u.length} | pubLen=
                {walletPasskeyCredPubkeyB64u.length} | tempPubLen=
                {tempCredPubkeyForAaBootstrap.length} | rpId={WALLET_RP_ID}
              </Text>
              <Text size="sm" emphasis>
                Last AA discovery result
              </Text>
              <Text size="sm" muted>
                eoa={lastAaAddress || "none"} | aa={lastKernelAddress || "none"}
              </Text>
              <Text size="sm" muted>
                permissionId={lastPermissionId || "none"}
              </Text>
              <Button size="lg" variant="soft" onPress={handleOpenPasskeyDialog}>
                <ButtonText>Open passkey dialog</ButtonText>
              </Button>
              {isPasskeyCaptureVisible ? (
                <View
                  variant="outline"
                  radius="lg"
                  padding="md"
                  direction="column"
                  align="stretch"
                  gap="sm"
                >
                  <View direction="row" align="center" justify="between">
                    <Text size="md" emphasis>
                      Passkey Capture
                    </Text>
                    <Button size="sm" variant="soft" onPress={handleNativePasskeyCancel}>
                      <ButtonText>Hide</ButtonText>
                    </Button>
                  </View>
                  <View direction="column" align="stretch" gap="sm">
                    <Text size="sm" muted>
                      {passkeyCaptureHint}
                    </Text>
                    <TextField
                      value={passkeyKeyUserName}
                      onChangeText={setPasskeyKeyUserName}
                      placeholder="UserName"
                      autoCapitalize="none"
                      disabled={isPasskeyCaptureRunning}
                    >
                      <TextFieldLabel>Passkey UserName</TextFieldLabel>
                    </TextField>
                    <TextField
                      value={passkeyKeyBaseOverride}
                      onChangeText={setPasskeyKeyBaseOverride}
                      placeholder="YYMMDD-Nuri-UserName"
                      autoCapitalize="none"
                      disabled={isPasskeyCaptureRunning || isPasskeyBaseLockedForKey2}
                    >
                      <TextFieldLabel>
                        {isPasskeyBaseLockedForKey2
                          ? "Passkey Key Base (locked from Key1)"
                          : "Passkey Key Base (optional override)"}
                      </TextFieldLabel>
                    </TextField>
                    <Text size="sm" muted>
                      storedKeyBase: {normalizedStoredPasskeyKeyBase || "none"}
                    </Text>
                    {isPasskeyBaseLockedForKey2 ? (
                      <Text size="xs" muted>
                        Key2 is locked to the Key1 base. Only suffix changes to
                        {" -Key2"}.
                      </Text>
                    ) : null}
                    <Text size="sm" muted>
                      nextCreateLabel:{" "}
                      {passkeyCreateLabelConfig.label ||
                        `missing (Key${passkeyCaptureCreateKeyIndex})`}
                    </Text>
                    {!passkeyCreateLabelConfig.ok ? (
                      <Text size="xs" muted>
                        {passkeyCreateLabelConfig.error}
                      </Text>
                    ) : null}
                    {Platform.OS === "android" ? (
                      <Text size="xs" muted>
                        Use existing first. If public key is missing, create once.
                      </Text>
                    ) : (
                      <Text size="xs" muted>
                        If the dialog does not auto-open, tap inside the webview.
                      </Text>
                    )}
                    {passkeyCaptureError ? (
                      <Text size="md" muted>
                        {passkeyCaptureError}
                      </Text>
                    ) : null}
                    {Platform.OS === "android" ? (
                      <>
                        <Button
                          size="lg"
                          variant="solid"
                          accent="lilac"
                          onPress={handleNativeExistingPasskeyPress}
                          disabled={isPasskeyCaptureRunning}
                        >
                          <ButtonText>
                            {isPasskeyCaptureRunning
                              ? "Waiting for passkey..."
                              : "Use existing wallet passkey"}
                          </ButtonText>
                        </Button>
                        <Button
                          size="lg"
                          variant="solid"
                          accent="lilac"
                          onPress={handleNativeCreatePasskeyPress}
                          disabled={isPasskeyCaptureRunning || !passkeyCreateLabelConfig.ok}
                        >
                          <ButtonText>
                            {isPasskeyCaptureRunning
                              ? "Waiting for passkey..."
                              : `Create Key${passkeyCaptureCreateKeyIndex} wallet passkey`}
                          </ButtonText>
                        </Button>
                      </>
                    ) : (
                      <View direction="column" align="stretch" gap="sm">
                        <View direction="row" gap="sm" distribute="even">
                          <Button
                            size="sm"
                            variant={webAuthnCaptureMode === "passkey" ? "solid" : "soft"}
                            accent={webAuthnCaptureMode === "passkey" ? "neutral" : undefined}
                            onPress={() => handleSelectPasskeyWebMode("passkey")}
                          >
                            <ButtonText>Passkey mode</ButtonText>
                          </Button>
                          <Button
                            size="sm"
                            variant={webAuthnCaptureMode === "hardware" ? "solid" : "soft"}
                            accent={webAuthnCaptureMode === "hardware" ? "neutral" : undefined}
                            onPress={() => handleSelectPasskeyWebMode("hardware")}
                          >
                            <ButtonText>Hardware key mode</ButtonText>
                          </Button>
                        </View>
                        {passkeyWebauthnUnsupported ? (
                          <Text size="xs" muted>
                            WebAuthn is unavailable in this embedded view.
                          </Text>
                        ) : (
                          <WebView
                            ref={passkeyWebViewRef}
                            key={`wirex-passkey-web-${passkeyCaptureSessionKey}-${passkeyWebviewKey}`}
                            source={{
                              html:
                                webAuthnCaptureMode === "hardware"
                                  ? HARDWARE_KEY_CAPTURE_WEBVIEW_HTML
                                  : PASSKEY_METADATA_CAPTURE_WEBVIEW_HTML,
                              baseUrl: "https://nuri.com",
                            }}
                            originWhitelist={["*"]}
                            javaScriptEnabled
                            domStorageEnabled
                            onLoadStart={() => appendPasskeyCaptureLog("webview load start")}
                            onLoadEnd={handlePasskeyWebViewLoadEnd}
                            onError={(evt) =>
                              appendPasskeyCaptureLog(
                                `webview error: ${evt.nativeEvent.description || "unknown"}`,
                              )
                            }
                            onMessage={handlePasskeyWebViewMessage}
                            style={styles.passkeyWebview}
                            containerStyle={styles.passkeyWebviewContainer}
                          />
                        )}
                        <Button size="lg" variant="soft" onPress={handlePasskeyWebViewReload}>
                          <ButtonText>Reload web capture</ButtonText>
                        </Button>
                      </View>
                    )}
                    <Text size="xs" emphasis>
                      Capture logs
                    </Text>
                    <Text size="xs" muted mono>
                      {passkeyCaptureLog || "No passkey events yet."}
                    </Text>
                  </View>
                </View>
              ) : null}
              <Text size="sm" emphasis>
                Last resolved sharing token
              </Text>
              <Text size="sm" muted>
                source={lastResolvedSharingTokenSource} | len=
                {lastResolvedSharingToken.length}
              </Text>
              <Text size="sm" muted mono>
                {lastResolvedSharingToken || "none"}
              </Text>
              {sharingTokenFetchError ? (
                <Text size="md" muted>
                  Sharing token fetch error: {sharingTokenFetchError}
                </Text>
              ) : null}
              <TextField
                value={sharingToken}
                onChangeText={setSharingToken}
                placeholder="Paste sharing_token for /api/v1/user/sharing-token"
                autoCapitalize="none"
              >
                <TextFieldLabel>Wirex KYC sharing token (optional)</TextFieldLabel>
              </TextField>
              <TextField
                value={wirexSumsubClientId}
                onChangeText={setWirexSumsubClientId}
                placeholder="e.g. wirex..._xxxxx"
                autoCapitalize="none"
              >
                <TextFieldLabel>Wirex SumSub client id (optional override)</TextFieldLabel>
              </TextField>
              <Text size="sm" muted>
                If empty, tries detected id plus Noah/BRLA partner ids.
              </Text>
              <Text size="sm" muted>
                Detected client id: {extractSumsubClientIdFromKycUrl(kycUrl || "") || "none"}
              </Text>
              <Text size="sm" muted>
                AA signing is on-device only; no private key leaves the app.
              </Text>
              <Button size="lg" variant="soft" onPress={handleCreate} disabled={isLoading}>
                <ButtonText>
                  {isLoading ? "Running account sync..." : primaryActionLabel}
                </ButtonText>
              </Button>
              <Button size="lg" variant="soft" onPress={handleCopyUseful}>
                <ButtonText>{`Copy useful logs${copyStatus ? ` (${copyStatus})` : ""}`}</ButtonText>
              </Button>
              <Button size="lg" variant="soft" onPress={handleCopyFull}>
                <ButtonText>Copy full logs</ButtonText>
              </Button>
              <Button
                size="lg"
                variant="soft"
                onPress={handleRunAaBootstrapOnly}
                disabled={isLoading}
              >
                <ButtonText>
                  {isLoading ? "Running AA bootstrap..." : "Run AA bootstrap (device only)"}
                </ButtonText>
              </Button>
              {error ? (
                <Text size="md" muted>
                  {error}
                </Text>
              ) : null}
              {(isLoading ||
                isPushFlowLoading ||
                isPushLoading ||
                isPushRecipientLoading ||
                isPushMintLoading) &&
              loadingStageText ? (
                <View direction="column" align="stretch" gap="xs">
                  <Text size="sm" muted>
                    {loadingStageText}
                  </Text>
                  <Text size="sm" muted>
                    Elapsed: {requestElapsedSec}s
                  </Text>
                  <Text size="sm" muted>
                    Fresh wallets can take 2-4 minutes during AA bootstrap.
                  </Text>
                </View>
              ) : null}
              {isLoading ? (
                <View
                  variant="soft"
                  radius="lg"
                  padding="lg"
                  direction="column"
                  align="stretch"
                  gap="xs"
                >
                  <Text size="sm" emphasis>
                    Live backend progress
                  </Text>
                  <Text size="sm" muted>
                    Status: {liveProgressView.status} | Stage: {liveProgressView.stage}
                  </Text>
                  {liveBackendError ? (
                    <Text size="md" muted>
                      Progress poll error: {liveBackendError}
                    </Text>
                  ) : null}
                  {liveProgressView.steps.length ? (
                    liveProgressView.steps.slice(-8).map((step, index) => {
                      const name = asString(step.name, "unknown_step");
                      const note = asString(step.note);
                      const status = asNumber(step.status);
                      const ok = step.ok === true;
                      return (
                        // biome-ignore lint/suspicious/noArrayIndexKey: live debug step list, ordered by occurrence
                        <Text key={`live-step-${index}`} size="xs" muted>
                          {ok ? "ok" : "issue"}: {getFriendlyStepName(name)}
                          {status !== null ? ` (${status})` : ""}
                          {note ? ` - ${note}` : ""}
                        </Text>
                      );
                    })
                  ) : (
                    <Text size="xs" muted>
                      Waiting for first backend step...
                    </Text>
                  )}
                </View>
              ) : null}
            </View>

            <Text size="md" emphasis>
              1. Account and Provisioning
            </Text>
            <View
              variant="soft"
              radius="lg"
              padding="lg"
              direction="column"
              align="stretch"
              gap="md"
            >
              <Text size="md" emphasis>
                Create account, verify KYC, issue SEPA + card
              </Text>
              <Text size="sm" muted>
                This uses the same backend sequence as the successful CLI flow.
              </Text>
              <Text size="xs" muted>
                Sharing token source: {sharingSource}
              </Text>
              <View
                variant="soft"
                radius="lg"
                padding="md"
                direction="column"
                align="stretch"
                gap="xs"
                accent={currentFlowStage.success ? "lilac" : "orange"}
              >
                <Text size="sm" emphasis>
                  {currentFlowStage.title}
                </Text>
                <Text size="sm" muted>
                  {currentFlowStage.body}
                </Text>
              </View>
              <Button
                size="lg"
                variant="soft"
                onPress={handleRunWirexChronologicalFlow}
                disabled={
                  isRunAllLoading ||
                  isLoading ||
                  isPushFlowLoading ||
                  isPushLoading ||
                  isPushRecipientLoading ||
                  isPushMintLoading
                }
              >
                <ButtonText>
                  {isRunAllLoading
                    ? "Running chronological flow..."
                    : "Run chronological Wirex flow"}
                </ButtonText>
              </Button>
              <Text size="xs" muted>
                Runs account sync, recipient creation, sandbox mint, and push-to-card in order.
                Stops on KYC, provisioning, or push blockers.
              </Text>
              {runAllError ? (
                <Text size="md" muted>
                  {runAllError}
                </Text>
              ) : null}
              <Text size="sm" muted>
                {runAllSummary ||
                  "Use this as the one-button lab runner before drilling into the manual steps below."}
              </Text>
              <Button size="lg" variant="soft" onPress={() => setShowRawRunAll((prev) => !prev)}>
                <ButtonText>
                  {showRawRunAll ? "Hide raw run-all JSON" : "Show raw run-all JSON"}
                </ButtonText>
              </Button>
              {showRawRunAll ? (
                <Text size="xs" muted mono>
                  {visibleRunAllResult || "No run-all payload yet."}
                </Text>
              ) : null}

              <View
                variant="outline"
                radius="lg"
                padding="md"
                direction="column"
                align="stretch"
                gap="xs"
              >
                <Text size="sm" emphasis>
                  1. Account Creation
                </Text>
                <View direction="row">
                  <View variant="outline" radius="full" paddingX="md" paddingY="xs">
                    <Text size="xs" emphasis>
                      {getStageLabel(flowSummary.accountStage)}
                    </Text>
                  </View>
                </View>
                <Text size="sm" muted>
                  Wirex user status: {flowSummary.userStatus}
                </Text>
              </View>

              <View
                variant="outline"
                radius="lg"
                padding="md"
                direction="column"
                align="stretch"
                gap="xs"
              >
                <Text size="sm" emphasis>
                  2. Token Sharing Test
                </Text>
                <View direction="row">
                  <View variant="outline" radius="full" paddingX="md" paddingY="xs">
                    <Text size="xs" emphasis>
                      {getStageLabel(flowSummary.sharingStage)}
                    </Text>
                  </View>
                </View>
                <Text size="sm" muted>
                  {flowSummary.sharingStatusText}
                </Text>
                <View direction="column" align="stretch" gap="xs">
                  <Button
                    size="lg"
                    variant="soft"
                    onPress={handleTryTokenSharing}
                    disabled={isLoading}
                  >
                    <ButtonText>
                      {isLoading ? "Running token sharing..." : "Try token sharing now"}
                    </ButtonText>
                  </Button>
                </View>
              </View>

              <View
                variant="outline"
                radius="lg"
                padding="md"
                direction="column"
                align="stretch"
                gap="xs"
              >
                <Text size="sm" emphasis>
                  3. KYC Session
                </Text>
                <View direction="row">
                  <View variant="outline" radius="full" paddingX="md" paddingY="xs">
                    <Text size="xs" emphasis>
                      {getStageLabel(flowSummary.kycStartStage)}
                    </Text>
                  </View>
                </View>
                <Text size="sm" muted>
                  {kycUrl
                    ? "KYC link is ready. Start KYC and return to app."
                    : flowSummary.verificationStatus === "Approved"
                      ? "KYC already completed."
                      : "KYC link not available yet. Run sync again."}
                </Text>
                {kycUrl && flowSummary.verificationStatus !== "Approved" ? (
                  <View direction="column" align="stretch" gap="xs">
                    <Button size="lg" variant="solid" accent="lilac" onPress={handleOpenKyc}>
                      <ButtonText>
                        {Platform.OS === "web"
                          ? "Start KYC in browser"
                          : "Start KYC (native/webview)"}
                      </ButtonText>
                    </Button>
                    <Button size="lg" variant="soft" onPress={handleOpenKycBrowser}>
                      <ButtonText>Open KYC in browser</ButtonText>
                    </Button>
                  </View>
                ) : null}
              </View>

              <View
                variant="outline"
                radius="lg"
                padding="md"
                direction="column"
                align="stretch"
                gap="xs"
              >
                <Text size="sm" emphasis>
                  4. KYC Approved
                </Text>
                <View direction="row">
                  <View variant="outline" radius="full" paddingX="md" paddingY="xs">
                    <Text size="xs" emphasis>
                      {getStageLabel(flowSummary.kycApprovedStage)}
                    </Text>
                  </View>
                </View>
                <Text size="sm" muted>
                  Verification status: {flowSummary.verificationStatus}
                </Text>
              </View>

              <View
                variant="outline"
                radius="lg"
                padding="md"
                direction="column"
                align="stretch"
                gap="xs"
              >
                <Text size="sm" emphasis>
                  5. Fetch Card Data
                </Text>
                <View direction="row">
                  <View variant="outline" radius="full" paddingX="md" paddingY="xs">
                    <Text size="xs" emphasis>
                      {getStageLabel(flowSummary.cardDataStage)}
                    </Text>
                  </View>
                </View>
                <Text size="sm" muted>
                  {flowSummary.cardReady
                    ? `Active card data loaded (${flowSummary.cards.length})`
                    : "Card not ready yet. Run refresh after KYC."}
                </Text>
              </View>

              <View
                variant="outline"
                radius="lg"
                padding="md"
                direction="column"
                align="stretch"
                gap="xs"
              >
                <Text size="sm" emphasis>
                  6. Fetch Bank Data
                </Text>
                <View direction="row">
                  <View variant="outline" radius="full" paddingX="md" paddingY="xs">
                    <Text size="xs" emphasis>
                      {getStageLabel(flowSummary.bankDataStage)}
                    </Text>
                  </View>
                </View>
                <Text size="sm" muted>
                  {flowSummary.sepaReady
                    ? `SEPA account data loaded (${flowSummary.bankAccounts.length})`
                    : "Cash account not ready yet. Run refresh after KYC."}
                </Text>
              </View>

              {flowSummary.completed ? (
                <View
                  variant="soft"
                  radius="lg"
                  padding="md"
                  direction="column"
                  align="stretch"
                  gap="xs"
                  accent="lilac"
                >
                  <Text size="sm" emphasis>
                    Result: Fully ready
                  </Text>
                  <Text size="sm" muted>
                    User is verified and has an active sandbox SEPA account and virtual card.
                  </Text>
                </View>
              ) : (
                <View
                  variant="soft"
                  radius="lg"
                  padding="md"
                  direction="column"
                  align="stretch"
                  gap="xs"
                  accent="orange"
                >
                  <Text size="sm" emphasis>
                    Result: In progress
                  </Text>
                  <Text size="sm" muted>
                    Continue the stage actions above, then run refresh.
                  </Text>
                </View>
              )}
            </View>

            <Text size="md" emphasis>
              2. Provisioned Result
            </Text>
            <View
              variant="soft"
              radius="lg"
              padding="lg"
              direction="column"
              align="stretch"
              gap="xs"
            >
              <Text size="sm" emphasis>
                Cash Accounts
              </Text>
              {flowSummary.bankAccounts.length ? (
                flowSummary.bankAccounts.map((account, index) => {
                  const details = asObject(account.details);
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: bank account list from third-party API; no guaranteed stable id
                    <Text key={`bank-${index}`} size="sm" muted mono>
                      {asString(account.account_type, "Unknown")} |{" "}
                      {asString(account.status, "Unknown")} | {asString(details?.iban, "n/a")} |{" "}
                      {asString(details?.bic, "n/a")}
                    </Text>
                  );
                })
              ) : (
                <Text size="xs" muted>
                  No cash account yet.
                </Text>
              )}
              <Text size="sm" emphasis>
                Cards
              </Text>
              {flowSummary.cards.length ? (
                flowSummary.cards.map((card, index) => {
                  const cardData = asObject(card.card_data);
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: card list from third-party API; no guaranteed stable id
                    <Text key={`card-${index}`} size="sm" muted mono>
                      {asString(card.id, "unknown")} | {asString(card.status, "Unknown")} | ****
                      {asString(cardData?.card_number_last_4, "----")} |{" "}
                      {asString(cardData?.expiry_date, "n/a")}
                    </Text>
                  );
                })
              ) : (
                <Text size="xs" muted>
                  No virtual card yet.
                </Text>
              )}
            </View>

            <Text size="md" emphasis>
              3. Backend Activity
            </Text>
            <View
              variant="soft"
              radius="lg"
              padding="lg"
              direction="column"
              align="stretch"
              gap="xs"
            >
              {flowSummary.steps.length ? (
                flowSummary.steps.slice(-12).map((step, index) => {
                  const name = asString(step.name, "unknown");
                  const note = asString(step.note);
                  const status = asNumber(step.status);
                  const healthy = isStepHealthy(step);
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: Wirex activity log slice, ordered by occurrence
                    <View key={`activity-${index}`} direction="row" align="start" gap="sm">
                      <Text size="xs" emphasis>
                        {healthy ? "ok" : "issue"}
                      </Text>
                      <View fill="grow">
                        <Text size="sm" muted>
                          {getFriendlyStepName(name)}
                          {status !== null ? ` (${status})` : ""}
                          {note ? ` - ${note}` : ""}
                        </Text>
                      </View>
                    </View>
                  );
                })
              ) : (
                <Text size="xs" muted>
                  No backend activity yet.
                </Text>
              )}
            </View>

            <View direction="column" align="stretch" gap="sm">
              <Text size="md" emphasis>
                4. Push-to-Card Demo
              </Text>
              <Text size="sm" muted>
                Same sandbox PAN can be reused for demos. Each Wirex user still needs its own
                recipient id, so the one-tap flow creates or resolves that automatically.
              </Text>
              <View
                variant="soft"
                radius="lg"
                padding="lg"
                direction="column"
                align="stretch"
                gap="xs"
              >
                <Text size="sm" emphasis>
                  One-tap sandbox demo
                </Text>
                <Text size="sm" muted>
                  Creates a recipient when needed, mints sandbox funds, compares onchain vs Wirex
                  balance, and then executes push-to-card.
                </Text>
                <Button
                  size="lg"
                  variant="soft"
                  onPress={handleRunFullPushDemo}
                  disabled={
                    isPushFlowLoading ||
                    isPushLoading ||
                    isPushRecipientLoading ||
                    isPushMintLoading
                  }
                >
                  <ButtonText>
                    {isPushFlowLoading ? "Running push demo..." : "Run full sandbox push demo"}
                  </ButtonText>
                </Button>
                {pushFlowError ? (
                  <Text size="md" muted>
                    {pushFlowError}
                  </Text>
                ) : null}
                {latestPushOutcome ? (
                  <View
                    variant="soft"
                    radius="lg"
                    padding="md"
                    direction="column"
                    align="stretch"
                    gap="xs"
                    accent={latestPushOutcome.success ? "lilac" : "orange"}
                  >
                    <Text size="sm" emphasis>
                      {latestPushOutcome.title}
                    </Text>
                    <Text size="sm" muted>
                      {latestPushOutcome.body}
                    </Text>
                  </View>
                ) : null}
                <Text size="sm" muted>
                  {pushFlowSummary ||
                    "Run this first for a demo. It will fill the recipient, mint, and push sections below."}
                </Text>
                <Button
                  size="lg"
                  variant="soft"
                  onPress={() => setShowRawPushFlow((prev) => !prev)}
                >
                  <ButtonText>
                    {showRawPushFlow ? "Hide raw demo JSON" : "Show raw demo JSON"}
                  </ButtonText>
                </Button>
                {showRawPushFlow ? (
                  <Text size="xs" muted mono>
                    {visiblePushFlowResult || "No full push demo response yet."}
                  </Text>
                ) : null}
              </View>

              <View
                variant="soft"
                radius="lg"
                padding="lg"
                direction="column"
                align="stretch"
                gap="xs"
              >
                <Text size="sm" emphasis>
                  Current push state
                </Text>
                <Text size="sm" muted mono>
                  EOA: {normalizedWallet || "missing"}
                </Text>
                <Button
                  size="lg"
                  variant="soft"
                  onPress={() => handleCopyValue("EOA", normalizedWallet)}
                >
                  <ButtonText>Copy EOA</ButtonText>
                </Button>
                <Text size="sm" muted mono>
                  Wirex smart wallet: {latestWirexWalletAddress || "missing"}
                </Text>
                <Button
                  size="lg"
                  variant="soft"
                  onPress={() => handleCopyValue("smart wallet", latestWirexWalletAddress)}
                >
                  <ButtonText>Copy smart wallet</ButtonText>
                </Button>
                {latestExplorerUrl ? (
                  <Button size="lg" variant="soft" onPress={handleOpenLatestExplorer}>
                    <ButtonText>Open smart wallet on BaseScan</ButtonText>
                  </Button>
                ) : null}
                <Text size="sm" muted mono>
                  External card id: {latestExternalCardId || "missing"}
                </Text>
                <Button
                  size="lg"
                  variant="soft"
                  onPress={() => handleCopyValue("external card id", latestExternalCardId)}
                >
                  <ButtonText>Copy external card id</ButtonText>
                </Button>
                <Text size="sm" muted mono>
                  Selected token: {latestSelectedTokenAddress || "missing"}
                </Text>
                <Button
                  size="lg"
                  variant="soft"
                  onPress={() => handleCopyValue("selected token", latestSelectedTokenAddress)}
                >
                  <ButtonText>Copy selected token</ButtonText>
                </Button>
                <Text size="sm" emphasis>
                  Balance sync
                </Text>
                <Text size="sm" muted>
                  Onchain before mint:{" "}
                  {asString(latestOnchainBalanceBeforeMint?.balance, "unknown")}
                </Text>
                <Text size="sm" muted>
                  Onchain after mint: {asString(latestOnchainBalanceAfterMint?.balance, "unknown")}
                </Text>
                <Text size="sm" emphasis>
                  Wirex wallet balances
                </Text>
                {latestWalletBalances.length ? (
                  latestWalletBalances.map((balance, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: Wirex wallet balances; ordered list
                    <Text key={`push-balance-${index}`} size="sm" muted mono>
                      {asString(balance.token_symbol, "token")} | {String(balance.balance ?? "0")} |{" "}
                      {asString(balance.token_address, "missing")}
                    </Text>
                  ))
                ) : (
                  <Text size="xs" muted>
                    No Wirex wallet balances available yet.
                  </Text>
                )}
              </View>

              <Text size="md" emphasis>
                5. Manual Push Steps
              </Text>
              <Text size="sm" muted>
                Use this when you want to rerun only one part of the flow. The sandbox PAN below is
                the card we keep reusing for demos.
              </Text>
              <TextField
                value={pushCardNumber}
                onChangeText={setPushCardNumber}
                placeholder={DEFAULT_PUSH_CARD_NUMBER}
                inputMode="numeric"
                autoCapitalize="none"
              >
                <TextFieldLabel>Recipient Card Number</TextFieldLabel>
              </TextField>
              <Text size="sm" muted>
                Sandbox test PAN example: {DEFAULT_PUSH_CARD_NUMBER}
              </Text>
              <TextField
                value={pushCardholderName}
                onChangeText={setPushCardholderName}
                placeholder={DEFAULT_PUSH_CARDHOLDER_NAME}
                autoCapitalize="words"
              >
                <TextFieldLabel>Cardholder Name</TextFieldLabel>
              </TextField>
              <TextField
                value={pushCardLabel}
                onChangeText={setPushCardLabel}
                placeholder={DEFAULT_PUSH_CARD_LABEL}
                autoCapitalize="words"
              >
                <TextFieldLabel>Recipient Alias (optional)</TextFieldLabel>
              </TextField>
              <Button
                size="lg"
                variant="soft"
                onPress={handleCreatePushRecipientFromCard}
                disabled={isPushRecipientLoading || isPushFlowLoading}
              >
                <ButtonText>
                  {isPushRecipientLoading
                    ? "Creating recipient..."
                    : "Tokenize card + create recipient"}
                </ButtonText>
              </Button>
              {pushRecipientError ? (
                <Text size="md" muted>
                  {pushRecipientError}
                </Text>
              ) : null}
              <Text size="sm" muted>
                {pushRecipientSummary || "Create recipient first to auto-fill external card id."}
              </Text>
              <Button
                size="lg"
                variant="soft"
                onPress={() => setShowRawPushRecipient((prev) => !prev)}
              >
                <ButtonText>
                  {showRawPushRecipient ? "Hide raw recipient JSON" : "Show raw recipient JSON"}
                </ButtonText>
              </Button>
              {showRawPushRecipient ? (
                <Text size="xs" muted mono>
                  {visiblePushRecipientResult || "No recipient creation response yet."}
                </Text>
              ) : null}
              <TextField
                value={pushExternalCardId}
                onChangeText={setPushExternalCardId}
                placeholder="external_card_id (payment_details[].id)"
                autoCapitalize="none"
              >
                <TextFieldLabel>External Card ID (optional)</TextFieldLabel>
              </TextField>
              <TextField
                value={pushTokenAddress}
                onChangeText={setPushTokenAddress}
                placeholder="auto-detected from wallet"
                autoCapitalize="none"
              >
                <TextFieldLabel>Token Address (optional)</TextFieldLabel>
              </TextField>
              <TextField
                value={pushAmount}
                onChangeText={setPushAmount}
                placeholder={DEFAULT_PUSH_TO_CARD_AMOUNT}
                inputMode="decimal"
                autoCapitalize="none"
              >
                <TextFieldLabel>Amount</TextFieldLabel>
              </TextField>
              <TextField
                value={pushCurrency}
                onChangeText={setPushCurrency}
                placeholder={DEFAULT_PUSH_TO_CARD_CURRENCY}
                autoCapitalize="characters"
              >
                <TextFieldLabel>Currency</TextFieldLabel>
              </TextField>
              <Button
                size="lg"
                variant="soft"
                onPress={handleMintPushFunds}
                disabled={
                  isPushMintLoading || isPushLoading || isPushRecipientLoading || isPushFlowLoading
                }
              >
                <ButtonText>
                  {isPushMintLoading ? "Minting sandbox funds..." : "Mint sandbox funds"}
                </ButtonText>
              </Button>
              {pushMintError ? (
                <Text size="md" muted>
                  {pushMintError}
                </Text>
              ) : null}
              <Text size="sm" muted>
                {pushMintSummary ||
                  "Mint current amount/currency into the Wirex sandbox wallet before push."}
              </Text>
              <Button size="lg" variant="soft" onPress={() => setShowRawPushMint((prev) => !prev)}>
                <ButtonText>
                  {showRawPushMint ? "Hide raw mint JSON" : "Show raw mint JSON"}
                </ButtonText>
              </Button>
              {showRawPushMint ? (
                <Text size="xs" muted mono>
                  {visiblePushMintResult || "No sandbox mint response yet."}
                </Text>
              ) : null}
              <Button
                size="lg"
                variant="soft"
                onPress={handlePushToCard}
                disabled={
                  isPushLoading || isPushRecipientLoading || isPushMintLoading || isPushFlowLoading
                }
              >
                <ButtonText>{isPushLoading ? "Running push..." : "Run push to card"}</ButtonText>
              </Button>
              {pushError ? (
                <Text size="md" muted>
                  {pushError}
                </Text>
              ) : null}
              <Text size="md" emphasis>
                Push Summary
              </Text>
              <Text size="sm" muted>
                {pushSummary || "Run push-to-card to see what worked and what failed."}
              </Text>
              <Button size="lg" variant="soft" onPress={() => setShowRawPush((prev) => !prev)}>
                <ButtonText>{showRawPush ? "Hide raw push JSON" : "Show raw push JSON"}</ButtonText>
              </Button>
              {showRawPush ? (
                <Text size="xs" muted mono>
                  {visiblePushResult || "No push-to-card response yet."}
                </Text>
              ) : null}
            </View>

            <View direction="column" align="stretch" gap="sm">
              <Text size="md" emphasis>
                6. Sponsored AA Wallet Tools
              </Text>
              <Text size="sm" muted>
                Triggers passkey auth, then checks AA WebAuthn binding onchain.
              </Text>
              <Button
                size="lg"
                variant="soft"
                onPress={handleAddAaCredential}
                disabled={isAaAddCredentialLoading || isAaPasskeySignTestLoading || isLoading}
              >
                <ButtonText>
                  {isAaAddCredentialLoading
                    ? "Installing credential..."
                    : addAaCredentialButtonLabel}
                </ButtonText>
              </Button>
              <Text size="sm" muted>
                {pendingAaCredential
                  ? "Pending credential detected. Retry without creating a new passkey."
                  : "Capture a new passkey or hardware key and install it as an additional AA WebAuthn credential."}
              </Text>
              {aaAddCredentialError ? (
                <Text size="md" muted>
                  {aaAddCredentialError}
                </Text>
              ) : null}
              <Text size="sm" muted>
                {aaAddCredentialSummary ||
                  "Run add credential to install a second passkey/hardware key."}
              </Text>
              <Button
                size="lg"
                variant="soft"
                onPress={() => setShowRawAaAddCredential((prev) => !prev)}
              >
                <ButtonText>
                  {showRawAaAddCredential
                    ? "Hide raw add credential JSON"
                    : "Show raw add credential JSON"}
                </ButtonText>
              </Button>
              {showRawAaAddCredential ? (
                <Text size="xs" muted mono>
                  {visibleAaAddCredentialResult || "No add credential payload yet."}
                </Text>
              ) : null}
              <Button
                size="lg"
                variant="soft"
                onPress={handleRunAaPasskeySignTest}
                disabled={isAaAddCredentialLoading || isAaPasskeySignTestLoading || isLoading}
              >
                <ButtonText>
                  {isAaPasskeySignTestLoading ? "Running sign test..." : "Run AA passkey sign test"}
                </ButtonText>
              </Button>
              <Text size="sm" muted>
                This does not transfer funds; it validates passkey auth plus AA passkey binding
                readiness.
              </Text>
              {aaPasskeySignTestError ? (
                <Text size="md" muted>
                  {aaPasskeySignTestError}
                </Text>
              ) : null}
              <Text size="sm" muted>
                {aaPasskeySignTestSummary || "Run the test to verify passkey auth and AA binding."}
              </Text>
              <Button
                size="lg"
                variant="soft"
                onPress={() => setShowRawAaPasskeySignTest((prev) => !prev)}
              >
                <ButtonText>
                  {showRawAaPasskeySignTest
                    ? "Hide raw AA sign test JSON"
                    : "Show raw AA sign test JSON"}
                </ButtonText>
              </Button>
              {showRawAaPasskeySignTest ? (
                <Text size="xs" muted mono>
                  {visibleAaPasskeySignTestResult || "No AA sign test payload yet."}
                </Text>
              ) : null}
              <Button
                size="lg"
                variant="soft"
                onPress={handleCheckAaReadiness}
                disabled={
                  isAaReadinessLoading ||
                  isAaSponsoredSendLoading ||
                  isAaAddCredentialLoading ||
                  isAaPasskeySignTestLoading ||
                  isLoading
                }
              >
                <ButtonText>
                  {isAaReadinessLoading ? "Checking readiness..." : "Check sponsored AA readiness"}
                </ButtonText>
              </Button>
              <Text size="sm" muted>
                Confirms the hosted paymaster is configured and the onchain Wirex module set is
                present on the deployed AA.
              </Text>
              {aaReadinessError ? (
                <Text size="md" muted>
                  {aaReadinessError}
                </Text>
              ) : null}
              <Text size="sm" muted>
                {aaReadinessSummary ||
                  "Run readiness after bootstrap to confirm sponsorship, weighted validator, and FundsManagement installation."}
              </Text>
              <Button
                size="lg"
                variant="soft"
                onPress={() => setShowRawAaReadiness((prev) => !prev)}
              >
                <ButtonText>
                  {showRawAaReadiness ? "Hide raw AA readiness JSON" : "Show raw AA readiness JSON"}
                </ButtonText>
              </Button>
              {showRawAaReadiness ? (
                <Text size="xs" muted mono>
                  {visibleAaReadinessResult || "No AA readiness payload yet."}
                </Text>
              ) : null}
              <TextField
                value={aaSponsoredSendRecipient}
                onChangeText={setAaSponsoredSendRecipient}
                placeholder="0x recipient"
                autoCapitalize="none"
              >
                <TextFieldLabel>Sponsored AA send recipient</TextFieldLabel>
              </TextField>
              <TextField
                value={aaSponsoredSendTokenAddress}
                onChangeText={setAaSponsoredSendTokenAddress}
                placeholder="0x token"
                autoCapitalize="none"
              >
                <TextFieldLabel>Sponsored AA send token</TextFieldLabel>
              </TextField>
              <TextField
                value={aaSponsoredSendAmount}
                onChangeText={setAaSponsoredSendAmount}
                placeholder="0.1"
                inputMode="decimal"
              >
                <TextFieldLabel>Sponsored AA send amount</TextFieldLabel>
              </TextField>
              <Button
                size="lg"
                variant="soft"
                onPress={handleRunAaSponsoredSend}
                disabled={
                  isAaSponsoredSendLoading ||
                  isAaReadinessLoading ||
                  isAaAddCredentialLoading ||
                  isAaPasskeySignTestLoading ||
                  isLoading
                }
              >
                <ButtonText>
                  {isAaSponsoredSendLoading ? "Sending..." : "Run sponsored AA token send"}
                </ButtonText>
              </Button>
              <Text size="sm" muted>
                Sends an ERC-20 transfer from the AA wallet through the hosted selfhost bundler and
                paymaster. The AA wallet itself does not need ETH for this proof.
              </Text>
              {aaSponsoredSendError ? (
                <Text size="md" muted>
                  {aaSponsoredSendError}
                </Text>
              ) : null}
              <Text size="sm" muted>
                {aaSponsoredSendSummary ||
                  "Run the sponsored send after minting a token balance into the AA wallet."}
              </Text>
              <Button
                size="lg"
                variant="soft"
                onPress={() => setShowRawAaSponsoredSend((prev) => !prev)}
              >
                <ButtonText>
                  {showRawAaSponsoredSend
                    ? "Hide raw sponsored send JSON"
                    : "Show raw sponsored send JSON"}
                </ButtonText>
              </Button>
              {showRawAaSponsoredSend ? (
                <Text size="xs" muted mono>
                  {visibleAaSponsoredSendResult || "No sponsored send payload yet."}
                </Text>
              ) : null}
            </View>

            <Text size="md" emphasis>
              7. Developer Details
            </Text>
            <Text size="sm" muted>
              {onboardingSummary || "Run the flow to see compact technical summary details."}
            </Text>
            <Text size="sm" muted>
              {provisioningSummary || "Provisioning debug summary will appear here."}
            </Text>
            <Button size="lg" variant="soft" onPress={() => setShowRawOnboarding((prev) => !prev)}>
              <ButtonText>
                {showRawOnboarding ? "Hide raw onboarding JSON" : "Show raw onboarding JSON"}
              </ButtonText>
            </Button>
            {showRawOnboarding ? (
              <Text size="xs" muted mono>
                {visibleResult || "No onboarding payload yet."}
              </Text>
            ) : null}

            <Text size="md" emphasis>
              8. User Snapshot
            </Text>
            <Button size="lg" variant="soft" onPress={() => setShowRawSnapshot((prev) => !prev)}>
              <ButtonText>
                {showRawSnapshot ? "Hide raw snapshot JSON" : "Show raw snapshot JSON"}
              </ButtonText>
            </Button>
            {showRawSnapshot ? (
              <Text size="xs" muted mono>
                {visibleSnapshot || "No snapshot yet."}
              </Text>
            ) : null}
          </View>
        </Scroll>
      </DsSheetHost>
      <SumsubWebModal
        visible={isKycModalVisible}
        url={kycUrl}
        onClose={() => setIsKycModalVisible(false)}
      />
    </>
  );
};

export default DebugWirexSignUpModal;
