// Wallet bootstrap + cache. Owns `cachedWallet`, `cachedIdentity`, the
// resolved/configured node URLs, and the single in-flight init promise.
// Bootstrap composes recoveryDefaults, walletPatches, storageAdapter,
// subscriptions, and the LNURL foreground monitor.
import { Wallet } from "@arkade-os/sdk";
import { errMsg } from "../../../lib/errorMessage";
import { shortTime } from "../../../lib/logShared";
import { NURI_SERVER_API_VERSION } from "../ArkadeVersion";
import { arkadeServerConfigService } from "../ArkadeServerConfigService";
import { ArkadeRemoteIdentity } from "../ArkadeRemoteIdentity";
import { authStateManager } from "../../auth/AuthStateService";
import {
  ARKADE_CLIENT_RECOVERY_CONTRACT_TYPE,
  registerArkadeClientRecoveryContractHandler,
} from "../ArkadeClientRecoveryContract";
import { emitArkadeWalletCacheEvent } from "./walletCacheEvents";
import { setArkadeContractRepositoryProvider } from "./diagnostics";
import { buildArkadeOnchainProvider, resolveArkadeEsploraUrl } from "./esploraFailover";
import { emitTrace, logArkadeWalletSignTrace } from "./logging";
import {
  buildWalletNodeCandidates,
  fetchArkNodeInfoWithRetry,
  getOnchainEsploraUrl,
  inferArkadeNetwork,
} from "./network";
import {
  assertArkadeRecoveryDefaultWallet,
  deleteInvalidArkadeRecoveryContracts,
  ensureArkadeRecoveryDefaultWallet,
  installArkadeRecoveryDefaultWallet,
  scriptHashForLog,
  type ArkadeRecoveryDefaultWallet,
} from "./recoveryDefaults";
import { ARKADE_V4_STORAGE_PREFIX } from "../ArkadeRecoveryBackupService";
import {
  ensureArkadeIncomingFundsSubscription,
  ensureArkadeSubscriptionRecoveryListener,
  registerArkadeIncomingFundsResubscribeProvider,
  stopArkadeIncomingFundsSubscription,
} from "./subscriptions";
import { ExpoIndexerProvider } from "@arkade-os/sdk/adapters/expo";
import { installVtxoPaginationFix } from "./vtxoPagination";
import {
  forceIntegerArkadeFeeRate,
  installArkadeBatchDebugPatch,
  installArkadeCheckpointOrderPatch,
  installArkadeProviderTracePatch,
  isLikelyTransientNetworkError,
  PrefetchedExpoArkProvider,
  type PatchableArkadeWallet,
} from "./walletPatches";
import { getArkadeStorageAdapter } from "./storageAdapter";
import { truncateForLog, withTimeout } from "./utils";
import type { ArkadeWallet } from "./types";

const ARKADE_INIT_RETRIES = 1;
const ARKADE_INIT_RETRY_DELAY_MS = 700;
const ARKADE_WALLET_CREATE_TIMEOUT_MS = 20_000;

let cachedWallet: ArkadeWallet | null = null;
let cachedIdentity: ArkadeRemoteIdentity | null = null;
let cachedNodeUrl: string | null = null;
let cachedResolvedNodeUrl: string | null = null;
let cachedWalletIdentityKey: string | null = null;
let walletInitInFlight: Promise<ArkadeWallet> | null = null;
let walletInitInFlightKey: string | null = null;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function getCurrentArkadeWalletIdentityKey(): string {
  const keys = authStateManager.getState().walletPublicKeys;
  const credId = String(keys?.walletPasskeyCredIdB64u || "").trim();
  const clientPk = String(keys?.userExternal || "")
    .trim()
    .toLowerCase();
  const signerUrl = arkadeServerConfigService.getSignerServerUrl().replace(/\/+$/, "");
  return `${credId || "missing_cred"}|${clientPk || "missing_client"}|${signerUrl}`;
}

export function getCurrentArkadeWalletCacheKey(configuredNodeUrl?: string): string {
  const nodeUrl = String(configuredNodeUrl ?? arkadeServerConfigService.getArkadeNodeUrl()).replace(
    /\/+$/,
    "",
  );
  return `${nodeUrl}|${getCurrentArkadeWalletIdentityKey()}`;
}

setArkadeContractRepositoryProvider(() => getArkadeStorageAdapter().contractRepository);

registerArkadeIncomingFundsResubscribeProvider(() => {
  const wallet = getCachedArkadeWallet();
  return {
    wallet: wallet as unknown as Parameters<typeof ensureArkadeIncomingFundsSubscription>[0] | null,
    subscriptionKey: wallet ? cachedResolvedNodeUrl : null,
  };
});
ensureArkadeSubscriptionRecoveryListener();

export function getCachedArkadeWallet(): ArkadeWallet | null {
  return cachedWalletIdentityKey === getCurrentArkadeWalletIdentityKey() ? cachedWallet : null;
}

export function getCachedArkadeNodeUrl(): string | null {
  return cachedNodeUrl;
}

export function getCachedArkadeResolvedNodeUrl(): string | null {
  return cachedResolvedNodeUrl;
}

export function getCachedArkadeIdentity(): ArkadeRemoteIdentity | null {
  return cachedWalletIdentityKey === getCurrentArkadeWalletIdentityKey() ? cachedIdentity : null;
}

export function getEffectiveWalletNodeUrl(configuredNodeUrl: string): string {
  const normalizedConfigured = String(configuredNodeUrl || "").replace(/\/+$/, "");
  if (
    cachedResolvedNodeUrl &&
    cachedWallet &&
    cachedNodeUrl &&
    cachedNodeUrl === normalizedConfigured &&
    cachedWalletIdentityKey === getCurrentArkadeWalletIdentityKey()
  ) {
    return cachedResolvedNodeUrl;
  }
  return normalizedConfigured;
}

export function resetArkadeWalletCacheState(): void {
  cachedWallet = null;
  cachedIdentity = null;
  cachedNodeUrl = null;
  cachedResolvedNodeUrl = null;
  cachedWalletIdentityKey = null;
  walletInitInFlight = null;
  walletInitInFlightKey = null;
}

export async function getOrCreateWallet(): Promise<ArkadeWallet> {
  await authStateManager.initialize();
  const configuredNodeUrl = arkadeServerConfigService.getArkadeNodeUrl().replace(/\/+$/, "");
  const walletIdentityKey = getCurrentArkadeWalletIdentityKey();
  const walletCacheKey = getCurrentArkadeWalletCacheKey(configuredNodeUrl);

  if (
    cachedWallet &&
    cachedNodeUrl === configuredNodeUrl &&
    cachedWalletIdentityKey === walletIdentityKey
  ) {
    const storage = getArkadeStorageAdapter();
    await ensureArkadeRecoveryDefaultWallet(
      cachedWallet as unknown as ArkadeRecoveryDefaultWallet,
      storage,
      "wallet_cache",
    );
    assertArkadeRecoveryDefaultWallet(
      cachedWallet as unknown as ArkadeRecoveryDefaultWallet,
      "wallet_cache",
    );
    await deleteInvalidArkadeRecoveryContracts("wallet_cache_cleanup");
    await ensureArkadeIncomingFundsSubscription(
      cachedWallet as unknown as Parameters<typeof ensureArkadeIncomingFundsSubscription>[0],
      cachedResolvedNodeUrl || configuredNodeUrl,
      "wallet_cache",
    );
    await emitArkadeWalletCacheEvent("ready", "wallet_cache");
    return cachedWallet;
  }
  if (cachedWallet && cachedWalletIdentityKey !== walletIdentityKey) {
    logArkadeWalletSignTrace("wallet_cache_identity_changed", {
      status: "recreate",
      expected_next: "wallet_init_current_identity",
    });
    stopArkadeIncomingFundsSubscription("wallet_identity_changed");
    cachedWallet = null;
    cachedIdentity = null;
    cachedNodeUrl = null;
    cachedResolvedNodeUrl = null;
    cachedWalletIdentityKey = null;
  }
  if (walletInitInFlight && walletInitInFlightKey === walletCacheKey) {
    return walletInitInFlight;
  }

  const initPromise = (async () => {
    // Lightning dispose runs via the wallet-cache event listener registered
    // in lightningCache. Awaited inside emit so the old swap manager is gone
    // before we start the new wallet init (preserves the lightning-before-
    // wallet teardown order without an inbound import from this module).
    await emitArkadeWalletCacheEvent("recreating", "wallet_recreate");
    stopArkadeIncomingFundsSubscription("wallet_recreate");
    cachedWallet = null;
    cachedIdentity = null;
    cachedNodeUrl = null;
    cachedResolvedNodeUrl = null;
    cachedWalletIdentityKey = null;

    let lastError: unknown = null;
    const nodeCandidates = buildWalletNodeCandidates(configuredNodeUrl);
    for (let nodeAttempt = 0; nodeAttempt < nodeCandidates.length; nodeAttempt += 1) {
      const nodeUrl = nodeCandidates[nodeAttempt];
      emitTrace({
        atMs: Date.now(),
        op: "wallet_node_target",
        status: "attempt",
        detail: `attempt=${nodeAttempt + 1}/${nodeCandidates.length} node=${nodeUrl}`,
      });

      try {
        const prefetchedNodeInfo = await fetchArkNodeInfoWithRetry(nodeUrl);
        const walletNetwork = inferArkadeNetwork(nodeUrl);
        // A single unreachable Esplora stalls every send, so the host is
        // chosen by whether it answers rather than by a constant.
        const onchainEsploraUrl = await resolveArkadeEsploraUrl(
          getOnchainEsploraUrl(walletNetwork),
        );
        const identity = new ArkadeRemoteIdentity();
        cachedIdentity = identity;
        const arkProvider = new PrefetchedExpoArkProvider(nodeUrl, prefetchedNodeInfo);
        const indexerProvider = installVtxoPaginationFix(new ExpoIndexerProvider(nodeUrl));
        const storage = getArkadeStorageAdapter();
        registerArkadeClientRecoveryContractHandler();
        logArkadeWalletSignTrace("contract_handler_ready", {
          type: ARKADE_CLIENT_RECOVERY_CONTRACT_TYPE,
          expected_next: "decode_existing_nuri_vtxos",
        });
        await deleteInvalidArkadeRecoveryContracts("wallet_init_cleanup");

        console.log(
          `🔐 [${shortTime()} ArkadeWalletBootstrap.init] nuri_server_api=${NURI_SERVER_API_VERSION} cfgNode=${configuredNodeUrl} node=${nodeUrl} onchain=${onchainEsploraUrl || "n/a"} storage=async_repository namespace=${ARKADE_V4_STORAGE_PREFIX}`,
        );

        for (let attempt = 1; attempt <= ARKADE_INIT_RETRIES; attempt += 1) {
          try {
            emitTrace({
              atMs: Date.now(),
              op: "wallet_init",
              status: "attempt",
              detail: `attempt=${attempt}/${ARKADE_INIT_RETRIES} timeoutMs=${ARKADE_WALLET_CREATE_TIMEOUT_MS} node=${nodeUrl}`,
            });
            // Build on a LOCAL instance, never on the module global. A second
            // init with a different cache key (other node URL or identity) is
            // not deduped by the in-flight check above — it nulls and reassigns
            // `cachedWallet` while this one is still awaiting install. Reading
            // the global afterwards then verified the OTHER attempt's wallet,
            // which still carries plain DefaultVtxo scripts: the
            // `recovery_default_wallet_missing offchain=0 boarding=0` failures.
            // The global is published only once this wallet passed its assert.
            const wallet = await withTimeout(
              "wallet_create",
              ARKADE_WALLET_CREATE_TIMEOUT_MS,
              Wallet.create({
                identity,
                arkProvider,
                indexerProvider,
                // SDK 0.5 replaced `esploraUrl` with an explicit provider.
                // Wrapped so a host that starts failing mid-session (mempool's
                // per-IP 429 bursts) falls over per-call instead of pinning the
                // wallet to a dead Esplora for its whole life.
                onchainProvider: buildArkadeOnchainProvider(onchainEsploraUrl),
                storage: storage as unknown as Parameters<typeof Wallet.create>[0]["storage"],
                settlementConfig: false,
              }),
            );
            const recoveryDefault = await installArkadeRecoveryDefaultWallet(
              wallet as unknown as ArkadeRecoveryDefaultWallet,
              storage,
              "wallet_init",
            );
            assertArkadeRecoveryDefaultWallet(
              wallet as unknown as ArkadeRecoveryDefaultWallet,
              "wallet_init",
            );
            cachedWallet = wallet;
            const patchable = wallet as unknown as PatchableArkadeWallet;
            forceIntegerArkadeFeeRate(patchable.onchainProvider, "wallet_onchain_provider");
            installArkadeProviderTracePatch(patchable);
            installArkadeBatchDebugPatch(patchable);
            installArkadeCheckpointOrderPatch(patchable);
            cachedNodeUrl = configuredNodeUrl;
            cachedResolvedNodeUrl = nodeUrl;
            cachedWalletIdentityKey = walletIdentityKey;
            await ensureArkadeIncomingFundsSubscription(
              wallet as unknown as Parameters<typeof ensureArkadeIncomingFundsSubscription>[0],
              nodeUrl,
              "wallet_init",
            );
            await emitArkadeWalletCacheEvent("ready", "wallet_init");
            logArkadeWalletSignTrace("recovery_wallet_contract_ready", {
              contract_mode: ARKADE_CLIENT_RECOVERY_CONTRACT_TYPE,
              ark: truncateForLog(recoveryDefault.offchainAddress, 28),
              boarding: truncateForLog(recoveryDefault.boardingAddress, 28),
              script_hash: scriptHashForLog(recoveryDefault.offchainScriptHex),
              expected_next: "recovery_arkade_send_receive_paths",
            });
            emitTrace({
              atMs: Date.now(),
              op: "wallet_init",
              status: "ok",
              detail: `attempt=${attempt}/${ARKADE_INIT_RETRIES} node=${nodeUrl}`,
            });
            return wallet;
          } catch (error: unknown) {
            lastError = error;
            const rawMessage = errMsg(error, "unknown").toLowerCase();
            const directNodeTransportFailure = rawMessage.includes("network request failed");
            const transient = isLikelyTransientNetworkError(error);
            emitTrace({
              atMs: Date.now(),
              op: "wallet_init_retry",
              status:
                !directNodeTransportFailure && transient && attempt < ARKADE_INIT_RETRIES
                  ? "retry"
                  : "failed",
              detail: `attempt=${attempt}/${ARKADE_INIT_RETRIES} transient=${transient ? 1 : 0} directNodeFail=${directNodeTransportFailure ? 1 : 0} node=${nodeUrl} err=${truncateForLog(errMsg(error, "unknown"), 170)}`,
            });
            if (directNodeTransportFailure || !transient || attempt >= ARKADE_INIT_RETRIES) {
              cachedIdentity = null;
              break;
            }
            await sleepMs(ARKADE_INIT_RETRY_DELAY_MS * attempt);
          }
        }
      } catch (error: unknown) {
        cachedIdentity = null;
        lastError = error;
        emitTrace({
          atMs: Date.now(),
          op: "wallet_node_target",
          status: "failed",
          detail: `attempt=${nodeAttempt + 1}/${nodeCandidates.length} node=${nodeUrl} err=${truncateForLog(errMsg(error, "unknown"), 170)}`,
        });
      }

      if (nodeAttempt + 1 < nodeCandidates.length) {
        emitTrace({
          atMs: Date.now(),
          op: "wallet_node_target",
          status: "blocked",
          detail: `unexpected_extra_node_candidate from=${nodeUrl} next=${nodeCandidates[nodeAttempt + 1]}`,
        });
      }
    }

    const root = errMsg(lastError, "wallet_create_failed");
    throw new Error(
      `wallet init failed root=${root} node=${configuredNodeUrl} candidates=${nodeCandidates.join(",")}`,
    );
  })();

  walletInitInFlight = initPromise;
  walletInitInFlightKey = walletCacheKey;
  try {
    return await initPromise;
  } finally {
    if (walletInitInFlight === initPromise) {
      walletInitInFlight = null;
      walletInitInFlightKey = null;
    }
  }
}
