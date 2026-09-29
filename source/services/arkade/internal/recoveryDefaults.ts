// Recovery-default wallet machinery: builds the ArkadeClientRecoveryVtxoScript
// from the wallet's running CSV timelocks, installs it as the wallet's default
// contract, and patches notifyIncomingFunds so vtxo-spent / vtxo-received
// events use the recovery contract's annotation path.
import { ContractManager } from "@arkade-os/sdk";
import type { IncomingFunds } from "@arkade-os/sdk";
import { bytesToHex } from "../../../lib/bytes";
import { sha256 } from "../../../lib/crypto";
import { errMsg } from "../../../lib/errorMessage";
import { ArkadeRemoteIdentity } from "../ArkadeRemoteIdentity";
import {
  ARKADE_CLIENT_RECOVERY_CONTRACT_TYPE,
  ArkadeClientRecoveryVtxoScript,
  serializeArkadeClientRecoveryContractParams,
  type ArkadeClientRecoveryContractParams,
} from "../ArkadeClientRecoveryContract";
import { getArkadeContractDiagnosticsSummary, type ArkadeContractDiagnostic } from "./diagnostics";
import { emitTrace, logArkadeWalletErrorTrace, logArkadeWalletSignTrace } from "./logging";
import { getArkadeStorageAdapter, type ArkadeStorageAdapterBundle } from "./storageAdapter";
import { hexToBytesLocal, truncateForLog } from "./utils";

export type ArkadeRecoveryDefaultWallet = {
  identity: ArkadeRemoteIdentity;
  network: { hrp: string; bech32?: string };
  arkServerPublicKey: Uint8Array;
  onchainProvider?: unknown;
  indexerProvider?: unknown;
  offchainTapscript?: {
    options?: { csvTimelock?: ArkadeClientRecoveryContractParams["arkadeCsvTimelock"] };
  };
  boardingTapscript?: {
    options?: { csvTimelock?: ArkadeClientRecoveryContractParams["arkadeCsvTimelock"] };
  };
  watcherConfig?: unknown;
  getContractManager(): Promise<ContractManager>;
  getBoardingAddress(): Promise<string>;
  getWalletScripts?: () => Promise<string[]>;
  getScriptMap?: () => Promise<Map<string, ArkadeClientRecoveryVtxoScript>>;
  initializeContractManager?: () => Promise<ContractManager>;
  notifyIncomingFunds?: (cb: (funds: IncomingFunds) => void) => Promise<() => void>;
  _contractManager?: unknown;
  _contractManagerInitializing?: unknown;
};

type ArkadeRecoveryDefaultScripts = {
  offchainParams: ArkadeClientRecoveryContractParams;
  offchainScript: ArkadeClientRecoveryVtxoScript;
  offchainScriptHex: string;
  offchainAddress: string;
  boardingParams: ArkadeClientRecoveryContractParams;
  boardingScript: ArkadeClientRecoveryVtxoScript;
  boardingScriptHex: string;
  boardingArkAddress: string;
  boardingAddress: string;
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
  nuriServerCsv: { type: "blocks" | "seconds"; value: number } | null;
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

type ArkadeInvalidContractDeleteSummary = {
  status: "ok" | "deleted" | "blocked";
  scanned: number;
  invalid: number;
  deleted: number;
  blocked: number;
  logLine: string;
  updatedAtMs: number;
};

export function scriptHashForLog(scriptHex: string): string {
  const bytes = hexToBytesLocal(scriptHex);
  return bytes.length ? bytesToHex(sha256(bytes)).slice(0, 16) : "n/a";
}

export function formatRelativeTimelockForUi(timelock: unknown): string {
  const record =
    timelock && typeof timelock === "object" ? (timelock as Record<string, unknown>) : null;
  const type = String(record?.type || "unknown");
  const raw = record?.value;
  const value =
    typeof raw === "bigint"
      ? raw.toString()
      : Number.isFinite(Number(raw))
        ? String(Math.trunc(Number(raw)))
        : "n/a";
  return `${value}_${type}`;
}

export function buildRecoveryContractSummary(
  pubCtx: Awaited<ReturnType<ArkadeRemoteIdentity["getSigningPublicContext"]>>,
): ArkadeRecoveryContractSummary {
  const policy = pubCtx.recoveryPolicy || pubCtx.cosignerDerivation?.recovery_policy || null;
  const recovery = pubCtx.recovery || null;
  const nuriServerCsv = pubCtx.nuriServerCsv;
  const policyCsv = policy?.nuri_server_csv || null;
  const policyCsvInvalid =
    !policyCsv ||
    (policyCsv.type !== "blocks" && policyCsv.type !== "seconds") ||
    !Number.isInteger(Number(policyCsv.value)) ||
    Number(policyCsv.value) <= 0;
  const csvMismatch = Boolean(
    !policyCsvInvalid &&
      nuriServerCsv &&
      (policyCsv?.type !== nuriServerCsv.type ||
        Math.trunc(Number(policyCsv?.value)) !== nuriServerCsv.value),
  );
  const recoveryPath = String(policy?.recovery_path || "");
  const recoveryType = String(policy?.type || "");
  const passkeyPubkeyPresent = Boolean(recovery?.passkey_pubkey_present);
  const passkeyPubkeyPolicy = String(
    recovery?.passkey_pubkey_policy || pubCtx.passkeyPubkeyPolicy || "",
  )
    .trim()
    .toLowerCase();
  const passkeyPubkeyRequired = passkeyPubkeyPolicy === "hard";
  const status: ArkadeRecoveryContractSummary["status"] =
    !nuriServerCsv || policyCsvInvalid || csvMismatch
      ? "missing_csv"
      : !recoveryPath
        ? "missing_recovery_policy"
        : passkeyPubkeyRequired && !passkeyPubkeyPresent
          ? "missing_passkey_pubkey"
          : "ready";

  return {
    status,
    serverVersion: String(pubCtx.serverVersion || ""),
    tokenKeyFingerprint: String(pubCtx.tokenKeyFingerprint || ""),
    clientPk33: pubCtx.clientPk33,
    serverPk33: pubCtx.serverPk33,
    aggregatedPk33: pubCtx.aggregatedPk33,
    derivationVersion: String(pubCtx.cosignerDerivation?.derivation_version || ""),
    accountFingerprint: String(
      pubCtx.cosignerAccountFingerprint || pubCtx.cosignerDerivation?.account_fingerprint || "",
    ),
    nuriServerCsv,
    nuriServerCsvLabel: formatRelativeTimelockForUi(nuriServerCsv),
    recoveryType,
    cooperativePath: String(policy?.cooperative_path || ""),
    recoveryPath,
    serverKeyExpires: Boolean(policy?.server_key_expires),
    passkeyPubkeyPolicy,
    passkeyPubkeyPresent,
    passkeyPubkeyFingerprint: String(recovery?.passkey_pubkey_fingerprint || ""),
    registered: Boolean(recovery?.registered),
    identityId: String(recovery?.identity_id || ""),
    backupPresent: Boolean(recovery?.backup_present),
    backupCiphertextSize: Math.max(0, Math.trunc(Number(recovery?.backup_ciphertext_size || 0))),
    backupUpdatedAtMs: Math.max(0, Math.trunc(Number(recovery?.backup_updated_at_ms || 0))),
    recoveryBackupFormat: String(pubCtx.recoveryBackupFormat || ""),
  };
}

function assertArkadeRecoveryContractReady(
  summary: ArkadeRecoveryContractSummary,
  source: string,
): void {
  const passkeyPubkeyRequired = summary.passkeyPubkeyPolicy.trim().toLowerCase() === "hard";
  const ready =
    summary.status === "ready" &&
    summary.serverKeyExpires &&
    (!passkeyPubkeyRequired || summary.passkeyPubkeyPresent);
  if (ready) return;
  const detail =
    `status=${summary.status} registered=${summary.registered ? 1 : 0} ` +
    `serverKeyExpires=${summary.serverKeyExpires ? 1 : 0} policy=${summary.passkeyPubkeyPolicy || "n/a"} ` +
    `csv=${summary.nuriServerCsvLabel || "n/a"}`;
  logArkadeWalletErrorTrace("arkade_recovery_default_blocked", {
    source,
    detail,
    expected_next: "register_passkey_recovery_before_receive",
  });
  throw new Error(`arkade recovery default unavailable: ${detail}`);
}

export async function getArkadeClientRecoveryContractParamsForTimelock(
  wallet: ArkadeRecoveryDefaultWallet,
  arkadeCsvTimelock: ArkadeClientRecoveryContractParams["arkadeCsvTimelock"] | undefined,
): Promise<ArkadeClientRecoveryContractParams> {
  const identity = wallet.identity;
  const pubCtx = await identity.getSigningPublicContext();
  const recoverySummary = buildRecoveryContractSummary(pubCtx);
  assertArkadeRecoveryContractReady(recoverySummary, "contract_params");
  const policy = pubCtx.recoveryPolicy || pubCtx.cosignerDerivation?.recovery_policy || null;
  const recoveryPath = String(policy?.recovery_path || "");
  if (!policy || !recoveryPath) {
    throw new Error("arkade recovery policy unavailable for client recovery wallet");
  }
  const aggregatePubKey = await identity.xOnlyPublicKey();
  const clientPubKey = await identity.clientXOnlyPublicKey();
  const nuriServerPubKey = hexToBytesLocal(pubCtx.serverPk33.slice(2));
  if (!(nuriServerPubKey instanceof Uint8Array) || nuriServerPubKey.length !== 32) {
    throw new Error("nuri server pubkey unavailable for client recovery wallet");
  }
  const offchainOptions = wallet.offchainTapscript?.options as
    | { serverPubKey?: Uint8Array }
    | undefined;
  const arkadeServerPubKey = offchainOptions?.serverPubKey || wallet.arkServerPublicKey;
  if (!(arkadeServerPubKey instanceof Uint8Array) || arkadeServerPubKey.length !== 32) {
    throw new Error("arkade server pubkey unavailable for client recovery wallet");
  }
  if (
    !arkadeCsvTimelock ||
    (arkadeCsvTimelock.type !== "blocks" && arkadeCsvTimelock.type !== "seconds")
  ) {
    throw new Error("arkade user exit csv unavailable for client recovery wallet");
  }
  const nuriServerCsv = pubCtx.nuriServerCsv;
  if (
    !nuriServerCsv ||
    (nuriServerCsv.type !== "blocks" && nuriServerCsv.type !== "seconds") ||
    !Number.isInteger(nuriServerCsv.value) ||
    nuriServerCsv.value <= 0
  ) {
    throw new Error("arkade nuri server csv unavailable for client recovery wallet");
  }
  const policyCsv = policy.nuri_server_csv;
  if (
    !policyCsv ||
    policyCsv.type !== nuriServerCsv.type ||
    Math.trunc(Number(policyCsv.value)) !== nuriServerCsv.value
  ) {
    throw new Error(
      `arkade nuri server csv mismatch public=${formatRelativeTimelockForUi(nuriServerCsv)} policy=${formatRelativeTimelockForUi(policyCsv)}`,
    );
  }
  const nuriServerCsvTimelock = {
    value: BigInt(nuriServerCsv.value),
    type: nuriServerCsv.type,
  } as ArkadeClientRecoveryContractParams["nuriServerCsvTimelock"];
  return {
    aggregatePubKey,
    clientPubKey,
    nuriServerPubKey,
    arkadeServerPubKey,
    arkadeCsvTimelock,
    nuriServerCsvTimelock,
  };
}

export async function getArkadeClientRecoveryContractParams(
  wallet: ArkadeRecoveryDefaultWallet,
): Promise<ArkadeClientRecoveryContractParams> {
  return getArkadeClientRecoveryContractParamsForTimelock(
    wallet,
    wallet.offchainTapscript?.options?.csvTimelock,
  );
}

async function buildArkadeRecoveryDefaultScripts(
  wallet: ArkadeRecoveryDefaultWallet,
): Promise<ArkadeRecoveryDefaultScripts> {
  const offchainParams = await getArkadeClientRecoveryContractParamsForTimelock(
    wallet,
    wallet.offchainTapscript?.options?.csvTimelock,
  );
  const boardingParams = await getArkadeClientRecoveryContractParamsForTimelock(
    wallet,
    wallet.boardingTapscript?.options?.csvTimelock,
  );
  const offchainScript = new ArkadeClientRecoveryVtxoScript(offchainParams);
  const boardingScript = new ArkadeClientRecoveryVtxoScript(boardingParams);
  const offchainScriptHex = bytesToHex(offchainScript.pkScript).toLowerCase();
  const boardingScriptHex = bytesToHex(boardingScript.pkScript).toLowerCase();
  const offchainAddress = offchainScript
    .address(wallet.network.hrp, wallet.arkServerPublicKey)
    .encode();
  const boardingArkAddress = boardingScript
    .address(wallet.network.hrp, wallet.arkServerPublicKey)
    .encode();
  const boardingAddress = boardingScript.onchainAddress(
    wallet.network as unknown as Parameters<ArkadeClientRecoveryVtxoScript["onchainAddress"]>[0],
  );
  return {
    offchainParams,
    offchainScript,
    offchainScriptHex,
    offchainAddress,
    boardingParams,
    boardingScript,
    boardingScriptHex,
    boardingArkAddress,
    boardingAddress,
  };
}

async function deleteNonRecoveryWalletContracts(
  storage: ArkadeStorageAdapterBundle,
  currentScriptHex: string,
  reason: string,
): Promise<number> {
  const repo = storage?.contractRepository;
  if (!repo?.getContracts || !repo?.deleteContracts) return 0;
  const contracts = await repo.getContracts();
  const targetScripts = contracts
    .filter((contract) => {
      const type = String(contract?.type || "");
      if (type === "default" || type === "delegate") return true;
      return type === ARKADE_CLIENT_RECOVERY_CONTRACT_TYPE;
    })
    .map((contract) => String(contract?.script || ""))
    .filter(Boolean);
  const deleted = await repo.deleteContracts(targetScripts);
  if (deleted > 0) {
    logArkadeWalletSignTrace("recovery_default_contract_prune", {
      reason,
      deleted,
      current_script: scriptHashForLog(currentScriptHex),
      expected_next: "register_only_recovery_default_contract",
    });
  }
  return deleted;
}

type RecoveryContractRecord = {
  label: string;
  type: typeof ARKADE_CLIENT_RECOVERY_CONTRACT_TYPE;
  params: ReturnType<typeof serializeArkadeClientRecoveryContractParams>;
  script: string;
  address: string;
  state: "active";
  metadata: {
    role: "wallet_default" | "wallet_boarding";
    boardingScript: string;
    boardingAddress: string;
  };
};

function buildArkadeRecoveryContract(
  scripts: ArkadeRecoveryDefaultScripts,
  role: "wallet_default" | "wallet_boarding",
): RecoveryContractRecord {
  const isBoarding = role === "wallet_boarding";
  return {
    label: isBoarding ? "Nuri recovery wallet boarding" : "Nuri recovery wallet default",
    type: ARKADE_CLIENT_RECOVERY_CONTRACT_TYPE,
    params: serializeArkadeClientRecoveryContractParams(
      isBoarding ? scripts.boardingParams : scripts.offchainParams,
    ),
    script: isBoarding ? scripts.boardingScriptHex : scripts.offchainScriptHex,
    address: isBoarding ? scripts.boardingArkAddress : scripts.offchainAddress,
    state: "active",
    metadata: {
      role,
      boardingScript: scripts.boardingScriptHex,
      boardingAddress: scripts.boardingAddress,
    },
  };
}

function buildArkadeRecoveryDefaultContracts(
  scripts: ArkadeRecoveryDefaultScripts,
): RecoveryContractRecord[] {
  return [
    buildArkadeRecoveryContract(scripts, "wallet_default"),
    buildArkadeRecoveryContract(scripts, "wallet_boarding"),
  ];
}

async function registerArkadeRecoveryDefaultContract(
  manager: ContractManager,
  scripts: ArkadeRecoveryDefaultScripts,
  reason: string,
): Promise<void> {
  const contracts = buildArkadeRecoveryDefaultContracts(scripts);
  for (const contract of contracts) {
    const registered = await manager.createContract(
      contract as unknown as Parameters<ContractManager["createContract"]>[0],
    );
    if (registered?.state !== "active" || registered?.address !== contract.address) {
      await manager.updateContract?.(contract.script, {
        label: contract.label,
        params: contract.params,
        address: contract.address,
        state: "active",
        metadata: contract.metadata,
        type: contract.type,
      });
    }
  }
  logArkadeWalletSignTrace("recovery_default_contract_ready", {
    reason,
    type: ARKADE_CLIENT_RECOVERY_CONTRACT_TYPE,
    ark: truncateForLog(scripts.offchainAddress, 28),
    boarding: truncateForLog(scripts.boardingAddress, 28),
    script_hash: scriptHashForLog(scripts.offchainScriptHex),
    boarding_script_hash: scriptHashForLog(scripts.boardingScriptHex),
    expected_next: "receive_paths_use_recovery_default",
  });
}

interface RecoveryAnnotatedVtxoEvent {
  type: string;
  contract?: { type?: string };
  vtxos?: unknown[];
}

interface IncomingUtxoTx {
  txid: string;
  vout?: Array<{ scriptpubkey_address?: string; value?: number | string }>;
  status?: unknown;
}

function patchArkadeRecoveryNotifyIncomingFunds(
  wallet: ArkadeRecoveryDefaultWallet,
  scripts: ArkadeRecoveryDefaultScripts,
): void {
  wallet.notifyIncomingFunds = async (eventCallback: (funds: IncomingFunds) => void) => {
    const boardingAddress = await wallet.getBoardingAddress();
    let onchainStopFunc: (() => void) | undefined;
    let indexerStopFunc: (() => void) | undefined;

    const onchainProvider = wallet.onchainProvider as
      | {
          watchAddresses?: (
            addresses: string[],
            cb: (txs: IncomingUtxoTx[]) => void,
          ) => Promise<() => void>;
        }
      | undefined;
    if (onchainProvider?.watchAddresses && boardingAddress) {
      const findVoutOnTx = (tx: IncomingUtxoTx) =>
        Array.isArray(tx?.vout)
          ? tx.vout.findIndex((vout) => vout?.scriptpubkey_address === boardingAddress)
          : -1;
      onchainStopFunc = await onchainProvider.watchAddresses(
        [boardingAddress],
        (txs: IncomingUtxoTx[]) => {
          const coins = (Array.isArray(txs) ? txs : [])
            .filter((tx) => findVoutOnTx(tx) !== -1)
            .map((tx) => {
              const vout = findVoutOnTx(tx);
              const voutEntry = tx.vout?.[vout];
              return {
                txid: tx.txid,
                vout,
                value: Number(voutEntry?.value ?? 0),
                status: tx.status,
              };
            });
          eventCallback({ type: "utxo", coins } as unknown as IncomingFunds);
        },
      );
    }

    if (wallet.indexerProvider) {
      const manager = (await wallet.getContractManager()) as ContractManager & {
        onContractEvent: (cb: (event: RecoveryAnnotatedVtxoEvent) => void) => () => void;
        annotateVtxos: (vtxos: unknown[]) => Promise<unknown[]>;
      };
      let annotationQueue = Promise.resolve();
      indexerStopFunc = manager.onContractEvent((event: RecoveryAnnotatedVtxoEvent) => {
        if (event?.type !== "vtxo_received" && event?.type !== "vtxo_spent") return;
        if (event?.contract?.type !== ARKADE_CLIENT_RECOVERY_CONTRACT_TYPE) return;
        annotationQueue = annotationQueue.then(async () => {
          try {
            const annotated = await manager.annotateVtxos(event.vtxos || []);
            eventCallback({
              type: "vtxo",
              newVtxos: event.type === "vtxo_received" ? annotated : [],
              spentVtxos: event.type === "vtxo_spent" ? annotated : [],
            } as unknown as IncomingFunds);
          } catch (error: unknown) {
            logArkadeWalletErrorTrace("recovery_default_notify_annotate_failed", {
              script_hash: scriptHashForLog(scripts.offchainScriptHex),
              err: truncateForLog(errMsg(error, "unknown"), 160),
            });
          }
        });
      });
    }

    return () => {
      onchainStopFunc?.();
      indexerStopFunc?.();
    };
  };
}

export async function installArkadeRecoveryDefaultWallet(
  wallet: ArkadeRecoveryDefaultWallet,
  storage: ArkadeStorageAdapterBundle,
  reason: string,
): Promise<ArkadeRecoveryDefaultScripts> {
  const scripts = await buildArkadeRecoveryDefaultScripts(wallet);
  await deleteNonRecoveryWalletContracts(storage, scripts.offchainScriptHex, reason);

  // Reach-in mutations into SDK Wallet backing fields. In SDK 0.4.x the public
  // offchainTapscript/boardingTapscript properties became getter-only and the
  // sanctioned rotation setters are typed to SDK Default/Delegate scripts. Our
  // recovery default installs a custom VtxoScript shape, so keep this localized
  // and revisit when the SDK exposes a public custom-contract install hook.
  const mutableWallet = wallet as unknown as {
    _offchainTapscript: ArkadeClientRecoveryVtxoScript;
    _boardingTapscript: ArkadeClientRecoveryVtxoScript;
    getWalletScripts: () => Promise<string[]>;
    getScriptMap: () => Promise<Map<string, ArkadeClientRecoveryVtxoScript>>;
    initializeContractManager: () => Promise<ContractManager>;
    _contractManager?: unknown;
    _contractManagerInitializing?: unknown;
  };
  mutableWallet._offchainTapscript = scripts.offchainScript;
  mutableWallet._boardingTapscript = scripts.boardingScript;
  mutableWallet.getWalletScripts = async () => [
    scripts.offchainScriptHex,
    scripts.boardingScriptHex,
  ];
  mutableWallet.getScriptMap = async () =>
    new Map([
      [scripts.offchainScriptHex, scripts.offchainScript],
      [scripts.boardingScriptHex, scripts.boardingScript],
    ]);
  mutableWallet.initializeContractManager = async () => {
    const manager = await ContractManager.create({
      indexerProvider: wallet.indexerProvider as Parameters<
        typeof ContractManager.create
      >[0]["indexerProvider"],
      contractRepository: storage.contractRepository as unknown as Parameters<
        typeof ContractManager.create
      >[0]["contractRepository"],
      walletRepository: storage.walletRepository,
      watcherConfig: wallet.watcherConfig as Parameters<
        typeof ContractManager.create
      >[0]["watcherConfig"],
    });
    await registerArkadeRecoveryDefaultContract(manager, scripts, "contract_manager_init");
    return manager;
  };
  mutableWallet._contractManager = undefined;
  mutableWallet._contractManagerInitializing = undefined;
  patchArkadeRecoveryNotifyIncomingFunds(wallet, scripts);
  await wallet.getContractManager();
  logArkadeWalletSignTrace("recovery_default_wallet_installed", {
    reason,
    type: ARKADE_CLIENT_RECOVERY_CONTRACT_TYPE,
    ark: truncateForLog(scripts.offchainAddress, 28),
    boarding: truncateForLog(scripts.boardingAddress, 28),
    script_hash: scriptHashForLog(scripts.offchainScriptHex),
    boarding_script_hash: scriptHashForLog(scripts.boardingScriptHex),
    expected_next: "wallet_init_returns_recovery_default",
  });
  return scripts;
}

export function isArkadeRecoveryDefaultWallet(wallet: ArkadeRecoveryDefaultWallet): boolean {
  return (
    wallet?.offchainTapscript instanceof ArkadeClientRecoveryVtxoScript &&
    wallet?.boardingTapscript instanceof ArkadeClientRecoveryVtxoScript
  );
}

export async function ensureArkadeRecoveryDefaultWallet(
  wallet: ArkadeRecoveryDefaultWallet,
  storage: ArkadeStorageAdapterBundle,
  source: string,
): Promise<void> {
  if (isArkadeRecoveryDefaultWallet(wallet)) return;
  logArkadeWalletSignTrace("recovery_default_wallet_upgrade", {
    source,
    expected_next: "install_recovery_default_before_receive",
  });
  await installArkadeRecoveryDefaultWallet(wallet, storage, source);
}

export function assertArkadeRecoveryDefaultWallet(
  wallet: ArkadeRecoveryDefaultWallet,
  source: string,
): void {
  const offchainOk = wallet?.offchainTapscript instanceof ArkadeClientRecoveryVtxoScript;
  const boardingOk = wallet?.boardingTapscript instanceof ArkadeClientRecoveryVtxoScript;
  if (offchainOk && boardingOk) return;
  logArkadeWalletErrorTrace("recovery_default_wallet_missing", {
    source,
    offchain: offchainOk ? 1 : 0,
    boarding: boardingOk ? 1 : 0,
    expected_next: "block_receive_before_funds",
  });
  throw new Error("arkade recovery default wallet missing");
}

function isInvalidArkadeRecoveryContract(diagnostic: ArkadeContractDiagnostic): boolean {
  if (diagnostic.type !== ARKADE_CLIENT_RECOVERY_CONTRACT_TYPE) return false;
  if (diagnostic.status === "ok") return false;
  const params = new Set(diagnostic.paramsKeys);
  return params.has("cooperativePubKey") || params.has("serverPubKey") || params.has("csvTimelock");
}

export async function deleteInvalidArkadeRecoveryContracts(
  reason: string,
): Promise<ArkadeInvalidContractDeleteSummary> {
  const diagnostics = await getArkadeContractDiagnosticsSummary(reason);
  const targetScripts = diagnostics.diagnostics
    .filter(isInvalidArkadeRecoveryContract)
    .map((diagnostic) => diagnostic.script)
    .filter(Boolean);
  const blocked = Math.max(0, diagnostics.invalidCount - targetScripts.length);

  if (targetScripts.length === 0) {
    const status: ArkadeInvalidContractDeleteSummary["status"] =
      diagnostics.invalidCount > 0 ? "blocked" : "ok";
    const logLine =
      status === "ok"
        ? `no_invalid_recovery_contracts scanned=${diagnostics.total}`
        : `invalid_contracts_not_deleted invalid=${diagnostics.invalidCount} scanned=${diagnostics.total}`;
    logArkadeWalletSignTrace("contract_delete_invalid", {
      status,
      scanned: diagnostics.total,
      invalid: diagnostics.invalidCount,
      deleted: 0,
      blocked,
      detail: logLine,
    });
    emitTrace({
      atMs: Date.now(),
      op: "contract_delete_invalid",
      status,
      detail: logLine,
    });
    if (blocked > 0) {
      throw new Error(logLine);
    }
    return {
      status,
      scanned: diagnostics.total,
      invalid: diagnostics.invalidCount,
      deleted: 0,
      blocked,
      logLine,
      updatedAtMs: Date.now(),
    };
  }

  const storage = getArkadeStorageAdapter();
  const deleted = await storage.contractRepository.deleteContracts(targetScripts);

  const status: ArkadeInvalidContractDeleteSummary["status"] = deleted > 0 ? "deleted" : "blocked";
  const logLine = `deleted=${deleted} scanned=${diagnostics.total} invalid=${diagnostics.invalidCount} blocked=${blocked} scripts=${targetScripts
    .slice(0, 4)
    .map(scriptHashForLog)
    .join(",")}`;
  logArkadeWalletSignTrace("contract_delete_invalid", {
    status,
    scanned: diagnostics.total,
    invalid: diagnostics.invalidCount,
    deleted,
    blocked,
    detail: truncateForLog(logLine, 240),
  });
  emitTrace({
    atMs: Date.now(),
    op: "contract_delete_invalid",
    status,
    detail: truncateForLog(logLine, 240),
  });
  if (blocked > 0 || deleted !== targetScripts.length) {
    throw new Error(logLine);
  }

  return {
    status,
    scanned: diagnostics.total,
    invalid: diagnostics.invalidCount,
    deleted,
    blocked,
    logLine,
    updatedAtMs: Date.now(),
  };
}
