// Deprecated-signer migration. When the arkade node rotates its signer pubkey,
// funds minted under the old signer sit at recovery-contract scripts the active
// wallet no longer derives. The SDK VtxoManager can report and migrate them
// (`getDeprecatedSignerStatus` / `migrateDeprecatedSignerVtxos`); we drive it
// manually here because background settlement is disabled (settlementConfig:
// false). Signing for the migration runs through the same recoverable-approval
// scope as the recoverable-vtxo update — see internal/receiveAutoRecover.ts.
import { hasTerminalSpend } from "@arkade-os/sdk";

// SDK 0.5 removed `isSpendable`; its body was `!hasTerminalSpend(vtxo)`. Kept
// identical so this sweep still enrolls exactly the vtxos it did before.
const isSpendable = (vtxo: Parameters<typeof hasTerminalSpend>[0]): boolean =>
  !hasTerminalSpend(vtxo);
import type { ExtendedVirtualCoin } from "@arkade-os/sdk";
import { bytesToHex, hexToBytes } from "../../lib/bytes";
import { EventBus } from "../events/AppEventBusService";
import {
  ArkadeClientRecoveryContractHandler,
  ArkadeClientRecoveryVtxoScript,
} from "./ArkadeClientRecoveryContract";
import {
  deprecatedSignerHexes,
  isPastCutoff,
  parseDeprecatedSigners,
} from "./internal/deprecatedSignerCutoff";
import { arkadeServerConfigService } from "./ArkadeServerConfigService";
import { NURI_CONTRACT_TYPE } from "./ArkadeVersion";
import { ARKADE_RECOVERABLE_UNLOCK_MIN_SATS } from "./internal/constants";
import { emitTrace, logArkadeWalletSignTrace } from "./internal/logging";
import { fetchArkNodeInfoWithRetry } from "./internal/network";
import {
  getArkadeClientRecoveryContractParamsForTimelock,
  type ArkadeRecoveryDefaultWallet,
} from "./internal/recoveryDefaults";
import { truncateForLog } from "./internal/utils";
import { getOrCreateWallet } from "./internal/walletCache";
import { loadArkadeWalletSummary } from "./internal/walletSummary";
import type { ArkadeWallet } from "./internal/types";

// Mirrors the SDK's DeprecatedSignerReport (typed locally to avoid a hard
// dependency on the SDK's type re-exports; matches the receiveAutoRecover
// pattern of structurally typing the manager surface we use).
export type ArkadeDeprecatedSignerReport = {
  signerPubKey: string;
  status: string;
  cutoffDate?: bigint;
  secondsUntilCutoff?: number;
  vtxoCount: number;
  totalValue: number;
  boardingCount: number;
  boardingValue: number;
  recoverableCount?: number;
  recoverableValue?: number;
  awaitingSweepCount?: number;
  awaitingSweepValue?: number;
};

type DeprecatedSignerManager = {
  getDeprecatedSignerStatus: () => Promise<ArkadeDeprecatedSignerReport[]>;
};

type MigratableWallet = ArkadeWallet & {
  getVtxoManager?: () => Promise<DeprecatedSignerManager>;
};

async function getDeprecatedSignerManager(
  wallet: MigratableWallet,
): Promise<DeprecatedSignerManager> {
  const manager = await wallet.getVtxoManager?.();
  if (!manager || typeof manager.getDeprecatedSignerStatus !== "function") {
    throw new Error("arkade deprecated-signer manager unavailable");
  }
  return manager;
}

function summarizeReports(reports: ArkadeDeprecatedSignerReport[]): string {
  return reports
    .map(
      (r) =>
        `signer=${truncateForLog(r.signerPubKey, 16)} status=${r.status} vtxos=${r.vtxoCount}/${r.totalValue} boarding=${r.boardingCount}/${r.boardingValue} secsToCutoff=${r.secondsUntilCutoff ?? "n/a"}`,
    )
    .join(" | ");
}

/**
 * Read-only: report funds the wallet holds under deprecated arkade signers.
 * No signing/approval — safe to call any time to drive balance/visibility.
 */
export async function getArkadeDeprecatedSignerStatus(): Promise<ArkadeDeprecatedSignerReport[]> {
  const wallet = (await getOrCreateWallet()) as MigratableWallet;
  const manager = await getDeprecatedSignerManager(wallet);
  const reports = await manager.getDeprecatedSignerStatus();
  logArkadeWalletSignTrace("deprecated_signer_status", {
    count: reports.length,
    detail: summarizeReports(reports),
    expected_next: reports.some((r) => r.vtxoCount > 0 || r.boardingCount > 0)
      ? "migrate_deprecated_signer_vtxos"
      : "no_deprecated_funds",
  });
  emitTrace({
    atMs: Date.now(),
    op: "deprecated_signer_status",
    status: "ok",
    detail: `count=${reports.length} ${summarizeReports(reports)}`,
  });
  return reports;
}

export type ArkadeDeprecatedSignerBoardingInfo = {
  /** Deprecated arkade signer pubkey (compressed hex), or null if none advertised. */
  deprecatedSignerPubKey: string | null;
  /** Boarding address derived under the active signer (should match the live one). */
  currentBoardingAddress: string;
  /** Boarding address derived under the deprecated signer — check this on-chain. */
  deprecatedBoardingAddress: string | null;
};

// Drop a compressed (33-byte / 66-hex) pubkey prefix to its x-only (32-byte)
// form; pass-through when already x-only. Recovery-contract params hold x-only.
function toXOnlyBytes(pubkeyHex: string): Uint8Array {
  const normalized = pubkeyHex.replace(/^0x/i, "").trim().toLowerCase();
  return normalized.length === 66 ? hexToBytes(normalized.slice(2)) : hexToBytes(normalized);
}

/**
 * Re-derive the recovery-contract BOARDING address under the deprecated arkade
 * signer, using the live wallet's real contract params with only
 * `arkadeServerPubKey` swapped. Lets us locate funds the SDK's
 * deprecated-signer detection misses (it only classifies contracts already
 * enrolled in the wallet's repository). Read-only — no signing.
 */
export async function getArkadeDeprecatedSignerBoardingAddress(): Promise<ArkadeDeprecatedSignerBoardingInfo> {
  const wallet = (await getOrCreateWallet()) as unknown as ArkadeRecoveryDefaultWallet;
  const boardingParams = await getArkadeClientRecoveryContractParamsForTimelock(
    wallet,
    wallet.boardingTapscript?.options?.csvTimelock,
  );
  const network = wallet.network as unknown as Parameters<
    ArkadeClientRecoveryVtxoScript["onchainAddress"]
  >[0];
  const currentBoardingAddress = new ArkadeClientRecoveryVtxoScript(boardingParams).onchainAddress(
    network,
  );

  const info = await fetchArkNodeInfoWithRetry(arkadeServerConfigService.getArkadeNodeUrl());
  const deprecatedHex = deprecatedSignerHexes(info)[0] || "";

  let deprecatedBoardingAddress: string | null = null;
  if (deprecatedHex) {
    deprecatedBoardingAddress = new ArkadeClientRecoveryVtxoScript({
      ...boardingParams,
      arkadeServerPubKey: toXOnlyBytes(deprecatedHex),
    }).onchainAddress(network);
  }

  logArkadeWalletSignTrace("deprecated_signer_boarding_address", {
    current: currentBoardingAddress,
    deprecated_signer: deprecatedHex || "none",
    deprecated_boarding: deprecatedBoardingAddress || "none",
    expected_next: deprecatedBoardingAddress ? "check_onchain_for_funds" : "no_deprecated_signer",
  });
  emitTrace({
    atMs: Date.now(),
    op: "deprecated_signer_boarding_address",
    status: "ok",
    detail: `current=${currentBoardingAddress} deprecated_signer=${truncateForLog(deprecatedHex || "none", 16)} deprecated_boarding=${deprecatedBoardingAddress || "none"}`,
  });

  return {
    deprecatedSignerPubKey: deprecatedHex || null,
    currentBoardingAddress,
    deprecatedBoardingAddress,
  };
}

export type ArkadeDeprecatedSignerVtxoProbe = {
  deprecatedSignerPubKey: string | null;
  /** pkScript (taproot output) of the deprecated-signer offchain recovery script. */
  arkScriptHex: string | null;
  vtxoCount: number;
  totalValueSats: number;
  spendableCount: number;
  spendableValueSats: number;
  /**
   * Spendable value under signers that are NOT past their cutoff — i.e. funds
   * arkd will still cooperatively migrate. Post-cutoff (EXPIRED) funds are
   * excluded: cooperative migration is closed for them, so they must never arm
   * a cooperative sweep. This is the value the auto-recover gate acts on (#852).
   */
  migratableSpendableValueSats: number;
};

type IndexerVtxoRow = { value?: number; virtualStatus?: { state?: string } };
type IndexerProviderLike = {
  getVtxos: (opts: { scripts: string[]; spendableOnly?: boolean }) => Promise<{
    vtxos?: IndexerVtxoRow[];
  }>;
};

function vtxoSats(value: unknown): number {
  const sats = Number(value ?? 0);
  return Number.isFinite(sats) && sats > 0 ? Math.trunc(sats) : 0;
}

/**
 * Probe the indexer for vtxos sitting at the OFFCHAIN recovery script under the
 * deprecated arkade signer — i.e. funds already swept into arkade (not on the
 * boarding address). Queries by the script's pkScript (params-only, no
 * server-key ambiguity), the same basis as the verified boarding address.
 * Read-only.
 */
export async function getArkadeDeprecatedSignerVtxos(): Promise<ArkadeDeprecatedSignerVtxoProbe> {
  const wallet = (await getOrCreateWallet()) as unknown as ArkadeRecoveryDefaultWallet & {
    indexerProvider?: IndexerProviderLike;
  };
  const indexerProvider = wallet.indexerProvider;
  if (!indexerProvider || typeof indexerProvider.getVtxos !== "function") {
    throw new Error("arkade indexer provider unavailable");
  }
  // Cheap gate first: only do contract-param derivation + indexer work when the
  // node actually advertises a deprecated signer. No rotation => bail here.
  const info = await fetchArkNodeInfoWithRetry(arkadeServerConfigService.getArkadeNodeUrl());
  const entries = parseDeprecatedSigners(info);
  if (entries.length === 0) {
    return {
      deprecatedSignerPubKey: null,
      arkScriptHex: null,
      vtxoCount: 0,
      totalValueSats: 0,
      spendableCount: 0,
      spendableValueSats: 0,
      migratableSpendableValueSats: 0,
    };
  }

  const offchainParams = await getArkadeClientRecoveryContractParamsForTimelock(
    wallet,
    wallet.offchainTapscript?.options?.csvTimelock,
  );

  let vtxoCount = 0;
  let totalValueSats = 0;
  let spendableCount = 0;
  let spendableValueSats = 0;
  let migratableSpendableValueSats = 0;
  // Surface the first signer holding funds (else the first advertised) in the
  // summary fields used by the debug UI.
  let firstSignerHex: string | null = null;
  let firstScriptHex: string | null = null;
  let fundedSignerHex: string | null = null;
  let fundedScriptHex: string | null = null;

  for (const entry of entries) {
    const deprecatedHex = entry.pubkeyHex;
    const pastCutoff = isPastCutoff(entry);
    const script = new ArkadeClientRecoveryVtxoScript({
      ...offchainParams,
      arkadeServerPubKey: toXOnlyBytes(deprecatedHex),
    });
    const arkScriptHex = bytesToHex(script.pkScript);
    if (!firstSignerHex) {
      firstSignerHex = deprecatedHex;
      firstScriptHex = arkScriptHex;
    }

    const res = await indexerProvider.getVtxos({ scripts: [arkScriptHex] });
    const vtxos = Array.isArray(res?.vtxos) ? res.vtxos : [];
    const signerTotal = vtxos.reduce((sum, v) => sum + vtxoSats(v.value), 0);
    const signerSpendable = vtxos.filter((v) => (v.virtualStatus?.state ?? "") !== "spent");
    const signerSpendableSats = signerSpendable.reduce((sum, v) => sum + vtxoSats(v.value), 0);

    vtxoCount += vtxos.length;
    totalValueSats += signerTotal;
    spendableCount += signerSpendable.length;
    spendableValueSats += signerSpendableSats;
    // Post-cutoff (EXPIRED) funds are excluded from the migratable bucket: arkd
    // refuses to co-sign them, so they must never arm a cooperative sweep (#852).
    if (!pastCutoff) migratableSpendableValueSats += signerSpendableSats;
    if (!fundedSignerHex && vtxos.length > 0) {
      fundedSignerHex = deprecatedHex;
      fundedScriptHex = arkScriptHex;
    }

    logArkadeWalletSignTrace("deprecated_signer_vtxo_probe", {
      deprecated_signer: deprecatedHex,
      ark_script: truncateForLog(arkScriptHex, 20),
      vtxos: vtxos.length,
      total_sats: signerTotal,
      spendable: signerSpendable.length,
      spendable_sats: signerSpendableSats,
      past_cutoff: pastCutoff ? 1 : 0,
      cutoff_sec: entry.cutoffSec ?? "none",
      expected_next: pastCutoff
        ? "expired_await_sweep_then_recover"
        : signerTotal > 0
          ? "enroll_old_contract_and_migrate"
          : "no_deprecated_vtxos",
    });
  }

  emitTrace({
    atMs: Date.now(),
    op: "deprecated_signer_vtxo_probe",
    status: "ok",
    detail: `signers=${entries.length} vtxos=${vtxoCount} total=${totalValueSats} spendable=${spendableCount}/${spendableValueSats} migratable=${migratableSpendableValueSats}`,
  });

  return {
    deprecatedSignerPubKey: fundedSignerHex || firstSignerHex,
    arkScriptHex: fundedScriptHex || firstScriptHex,
    vtxoCount,
    totalValueSats,
    spendableCount,
    spendableValueSats,
    migratableSpendableValueSats,
  };
}

export type ArkadeDeprecatedSignerSweepResult = {
  enrolledScriptHex: string;
  enrolledVtxoCount: number;
  selectedCount: number;
  selectedValueSats: number;
  txid: string | null;
};

// Structural shape of the SDK's ContractWithVtxos — typed locally rather than
// imported so this file doesn't depend on an SDK type export that varies across
// pinned versions (we only read .contract.script + .vtxos).
type ContractWithVtxosLike = {
  contract: { script: string };
  vtxos: ExtendedVirtualCoin[];
};

type ContractManagerLike = {
  createContract: (params: {
    type: string;
    label?: string;
    params: Record<string, string>;
    script: string;
    address: string;
  }) => Promise<unknown>;
  getContractsWithVtxos: () => Promise<ContractWithVtxosLike[]>;
};

/**
 * Recover deprecated-signer funds the SDK migration API can't reach (its
 * boarding leg hammers mempool.space and 429s). Enrolls the old offchain
 * recovery contract so the wallet recognizes its vtxos, then sends the
 * spendable ones to our OWN active-signer wallet via the migration send-path
 * (`sendSelectedVtxosToSelf`) — arkd accepts deprecated-signer inputs only
 * through this path (a plain settle/send is rejected). No boarding leg, no
 * mempool. Signs, so the caller MUST hold a signing-capable context.
 */
export async function runArkadeDeprecatedSignerSweep(
  reason = "deprecated_signer_sweep",
): Promise<ArkadeDeprecatedSignerSweepResult> {
  const wallet = (await getOrCreateWallet()) as unknown as ArkadeRecoveryDefaultWallet & {
    getContractManager: () => Promise<ContractManagerLike>;
    sendSelectedVtxosToSelf?: (inputs: ExtendedVirtualCoin[]) => Promise<string>;
    identity?: {
      withRecoverableApproval?: <T>(reason: string, work: () => Promise<T>) => Promise<T>;
    };
  };
  if (typeof wallet.sendSelectedVtxosToSelf !== "function") {
    throw new Error("arkade sendSelectedVtxosToSelf unavailable");
  }
  const identity = wallet.identity;
  if (typeof identity?.withRecoverableApproval !== "function") {
    throw new Error("arkade migration approval identity unavailable");
  }

  const offchainParams = await getArkadeClientRecoveryContractParamsForTimelock(
    wallet,
    wallet.offchainTapscript?.options?.csvTimelock,
  );
  const info = await fetchArkNodeInfoWithRetry(arkadeServerConfigService.getArkadeNodeUrl());
  const entries = parseDeprecatedSigners(info);
  if (entries.length === 0) {
    throw new Error("no deprecated signer advertised");
  }

  const manager = await wallet.getContractManager();
  let enrolledVtxoCount = 0;
  let selectedCount = 0;
  let selectedValueSats = 0;
  let skippedExpiredCount = 0;
  let firstScriptHex = "";
  let firstTxid: string | null = null;

  // Recover funds under EVERY advertised deprecated signer (each gets its own
  // approval => one Face ID per signer that actually holds spendable funds).
  for (const entry of entries) {
    const deprecatedHex = entry.pubkeyHex;
    // Past-cutoff (EXPIRED) signers: arkd rejects cooperative spends
    // (INVALID_VTXO_SCRIPT), so sendSelectedVtxosToSelf would fail every time.
    // Skip them entirely — they follow the sweep→recover lifecycle, not a
    // cooperative self-send. Skipping also stops the 5-min retry loop (#852).
    if (isPastCutoff(entry)) {
      skippedExpiredCount += 1;
      logArkadeWalletSignTrace("deprecated_signer_sweep", {
        deprecated_signer: truncateForLog(deprecatedHex, 16),
        status: "skipped_expired",
        cutoff_sec: entry.cutoffSec ?? "none",
        expected_next: "await_arkade_sweep_then_recover",
      });
      continue;
    }
    const oldParams = { ...offchainParams, arkadeServerPubKey: toXOnlyBytes(deprecatedHex) };
    const oldScript = new ArkadeClientRecoveryVtxoScript(oldParams);
    const scriptHex = bytesToHex(oldScript.pkScript);
    if (!firstScriptHex) firstScriptHex = scriptHex;
    const arkAddress = oldScript.address(wallet.network.hrp, toXOnlyBytes(deprecatedHex)).encode();

    // Enroll so the wallet can select + sign this signer's vtxos.
    // createContract is idempotent on re-register.
    await manager.createContract({
      type: NURI_CONTRACT_TYPE,
      label: "deprecated_signer_recovery",
      params: ArkadeClientRecoveryContractHandler.serializeParams(oldParams),
      script: scriptHex,
      address: arkAddress,
    });

    const contracts = await manager.getContractsWithVtxos();
    const enrolled = contracts
      .filter((c) => c.contract.script === scriptHex)
      .flatMap((c) => c.vtxos);
    const spendable = enrolled.filter((v) => isSpendable(v));
    const signerSpendableSats = spendable.reduce(
      (sum, v) => sum + vtxoSats((v as { value?: number }).value),
      0,
    );
    enrolledVtxoCount += enrolled.length;

    logArkadeWalletSignTrace("deprecated_signer_sweep", {
      script: truncateForLog(scriptHex, 20),
      deprecated_signer: truncateForLog(deprecatedHex, 16),
      enrolled_vtxos: enrolled.length,
      spendable: spendable.length,
      spendable_sats: signerSpendableSats,
      expected_next:
        signerSpendableSats >= ARKADE_RECOVERABLE_UNLOCK_MIN_SATS
          ? "send_selected_vtxos_to_self"
          : "below_recoverable_floor",
    });

    // Skip sub-floor signers: arkd refuses to co-sign dust, so the send would
    // fail with "not cooperatively spendable". The aggregate gate in
    // maybeAutoRecoverDeprecatedSignerFunds covers the common single-signer
    // case; this guards a multi-signer wallet whose dust sums above the floor.
    if (signerSpendableSats < ARKADE_RECOVERABLE_UNLOCK_MIN_SATS) continue;

    const txid = await identity.withRecoverableApproval(
      `${reason}:${deprecatedHex.slice(0, 12)}`,
      () =>
        // biome-ignore lint/style/noNonNullAssertion: existence checked above
        wallet.sendSelectedVtxosToSelf!(spendable),
    );
    selectedCount += spendable.length;
    selectedValueSats += signerSpendableSats;
    if (!firstTxid && txid) firstTxid = txid;
  }

  if (selectedCount > 0) {
    const summary = await loadArkadeWalletSummary({
      scheduleAutoClaim: false,
      scheduleAutoRecover: false,
      scheduleAutoSettle: false,
      scheduleAutoBoardingSweep: false,
      forceFresh: true,
    });
    try {
      EventBus.emit("arkade:receiveUpdated", {
        reason,
        walletSummary: summary,
        availableSats: summary.balanceAvailableSats,
      });
      EventBus.emit("bitcoin:refresh");
      EventBus.emit("bitcoin:syncWallet");
      EventBus.emit("transactions:refresh");
    } catch {}
    emitTrace({
      atMs: Date.now(),
      op: "deprecated_signer_sweep",
      status: "ok",
      id: firstTxid || undefined,
      detail: `reason=${reason} signers=${entries.length} skippedExpired=${skippedExpiredCount} selected=${selectedCount} sats=${selectedValueSats} available=${summary.balanceAvailableSats}`,
    });
  }

  return {
    enrolledScriptHex: firstScriptHex,
    enrolledVtxoCount,
    selectedCount,
    selectedValueSats,
    txid: firstTxid,
  };
}

// Auto-recover guards (module-scoped; reset on app restart). The probe is
// read-only and runs at most once per PROBE_MIN_INTERVAL; an actual sweep
// (one Face ID) is rate-limited by SWEEP_COOLDOWN so a detection flap or a
// failed attempt can't spam prompts.
let autoRecoverInFlight = false;
let lastAutoRecoverProbeMs = 0;
let lastAutoRecoverSweepMs = 0;
const AUTO_RECOVER_PROBE_MIN_INTERVAL_MS = 60_000;
const AUTO_RECOVER_SWEEP_COOLDOWN_MS = 5 * 60_000;

/**
 * Background entry point: detect spendable deprecated-signer vtxos and sweep
 * them into the active wallet, with no debug UI. Safe to call from a poll
 * loop — internal guards throttle probing and rate-limit the (prompting)
 * sweep. Surfaces exactly one Face ID per sweep (session-token reuse covers
 * the checkpoints). Caller must already be in a signing-capable context
 * (arkade mode, app active).
 */
export async function maybeAutoRecoverDeprecatedSignerFunds(reason = "auto"): Promise<void> {
  if (autoRecoverInFlight) return;
  const now = Date.now();
  if (now - lastAutoRecoverProbeMs < AUTO_RECOVER_PROBE_MIN_INTERVAL_MS) return;
  if (lastAutoRecoverSweepMs && now - lastAutoRecoverSweepMs < AUTO_RECOVER_SWEEP_COOLDOWN_MS) {
    return;
  }
  autoRecoverInFlight = true;
  // Only the (prompting) sweep arms the 5-min cooldown — a failed read-only
  // probe must not block future probes/sweeps since nothing was attempted.
  let sweepStarted = false;
  try {
    lastAutoRecoverProbeMs = Date.now();
    const probe = await getArkadeDeprecatedSignerVtxos();
    // Gate on the MIGRATABLE (pre-cutoff) spendable value, not total spendable:
    // post-cutoff EXPIRED funds can't be cooperatively swept (arkd rejects them
    // with INVALID_VTXO_SCRIPT), so counting them here would arm a sweep that
    // fails every time and re-arms the 5-min cooldown forever — the retry loop
    // #852 fixes. Below the floor is dust the server won't co-sign either (#735).
    // EXPIRED funds are surfaced via balance/status and follow the sweep→recover
    // lifecycle, not this cooperative path.
    if (probe.migratableSpendableValueSats < ARKADE_RECOVERABLE_UNLOCK_MIN_SATS) return; // nothing cooperatively recoverable; no prompt, no cooldown
    sweepStarted = true;
    lastAutoRecoverSweepMs = Date.now(); // mark before sweep so failures also cool down
    logArkadeWalletSignTrace("deprecated_signer_auto_recover", {
      reason,
      spendable: probe.spendableCount,
      sats: probe.spendableValueSats,
      migratable_sats: probe.migratableSpendableValueSats,
      expected_next: "auto_sweep_one_prompt",
    });
    const result = await runArkadeDeprecatedSignerSweep(`auto_${reason}`);
    logArkadeWalletSignTrace("deprecated_signer_auto_recover", {
      reason,
      status: result.txid ? "ok" : "nothing_swept",
      selected: result.selectedCount,
      sats: result.selectedValueSats,
      txid: result.txid || "none",
      expected_next: "balance_refresh",
    });
  } catch (error: unknown) {
    if (sweepStarted) lastAutoRecoverSweepMs = Date.now();
    logArkadeWalletSignTrace("deprecated_signer_auto_recover", {
      reason,
      status: "failed",
      err: truncateForLog(error instanceof Error ? error.message : String(error || "unknown"), 160),
      expected_next: "retry_after_cooldown",
    });
  } finally {
    autoRecoverInFlight = false;
  }
}
