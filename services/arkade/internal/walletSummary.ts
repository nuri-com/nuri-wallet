// Wallet-summary loader + cache state + rate-limited public wrapper. Lives in
// internal/ so other internal modules (receiveAutoClaim, receiveAutoSweep,
// receiveAutoRecover) can
// call the loader/wrapper and read cached state without importing the
// prod-tier ArkadeWalletService (which would re-create a module cycle).
//
// The receive-flow auto schedulers (LNURL auto-load, auto-settle, boarding
// auto-sweep) used to be invoked directly from `loadArkadeWalletSummary`. That
// forced this file to import ./receiveAutoClaim and ./receiveAutoSweep — and
// those modules import back from here (`loadArkadeWalletSummary`,
// `getCachedWalletSummary`, `getArkadeWalletSummary`). Metro/CommonJS
// partial-init around app startup makes that fragile.
//
// Instead, this file fires `emitArkadeWalletSummaryLoaded` after a successful
// load. The receive modules each register a listener at module-load time and
// schedule what they care about. walletSummary stays acyclic.
import { hasTerminalSpend } from "@arkade-os/sdk";

// SDK 0.5 removed `isSpendable`. Its body was exactly `!hasTerminalSpend(vtxo)`
// (sdk 0.4.62, chunk-URT2RVGB.js:2376), and `hasTerminalSpend` is unchanged, so
// this is the same predicate under its own name — NOT the new
// `canSpendOffchain`, which additionally excludes swept/expired/unrolled vtxos
// and would silently drop coins this balance still counts.
const isSpendable = (vtxo: Parameters<typeof hasTerminalSpend>[0]): boolean =>
  !hasTerminalSpend(vtxo);
import * as btc from "@scure/btc-signer";
import { bytesToHex } from "../../../lib/bytes";
import { shortTime } from "../../../lib/logShared";
import {
  arkadeReceiveBoardingAddress,
  arkadeReceiveSync,
  ensureSettlementMinExpiryGapMs,
} from "../ArkadeApiService";
import { ARKADE_V4_STORAGE_PREFIX } from "../ArkadeRecoveryBackupService";
import { NURI_SERVER_API_VERSION } from "../ArkadeVersion";
import type { ArkadeWalletSummary, ArkadeWalletSummaryOptions } from "../types/wallet";
import { ARKADE_NODE_INFO_TIMEOUT_MS } from "./constants";
import { getArkadeContractDiagnosticsSummary } from "./diagnostics";
import { getArkadeLnurlAssertion, getArkadeReceiveOwner } from "./identity";
import { group, logger } from "../../../lib/log";
import { emitTrace, logArkadeWalletErrorTrace, logArkadeWalletSignTrace } from "./logging";
import { persistArkadeStableParams } from "./persistence";
import {
  type SettleabilityInput,
  getSettlementMinExpiryGapMs,
  isVtxoSettleable,
} from "./vtxoSettleability";
import { updateReceiveStageFromWalletSummary } from "./receiveStage";
import { inspectArkadeRecoveryCsvStatus } from "./recovery";
import type { ArkadeDebugBalance, ArkadeRecoveryCsvStatus } from "./types";
import { isZeroArkadeWalletSummary, truncateForLog, withTimeout } from "./utils";
import { formatVtxoDebugLine } from "./vtxoFormat";
import { dropUnconfirmedVtxos, type VtxoConfirmingIndexer } from "./vtxoReconciliation";
import { getCurrentArkadeWalletCacheKey, getOrCreateWallet } from "./walletCache";
import { readBoardingUtxosShared, resetBoardingUtxoCache } from "./boardingUtxoCache";
import { isTransientWalletSummaryErrorMessage } from "./walletSummaryErrors";
import { emitArkadeWalletSummaryLoaded } from "./walletSummaryEvents";

export const ARKADE_WALLET_SUMMARY_BALANCE_TIMEOUT_MS = 8_000;
export const ARKADE_WALLET_SUMMARY_RECOVERY_CSV_TIMEOUT_MS = 3_000;
export const ARKADE_WALLET_SUMMARY_WATCHDOG_MS = 10_000;

// Sentinel: the boarding (L1/mempool) read failed. Distinct from a fresh-but-
// empty [] so the balance builder never reports a real 0 for boarding — see the
// carry-forward where boardingUnavailable is handled.
const BOARDING_UNAVAILABLE = Symbol("boarding_unavailable");

// Hard cooldown for ALL wallet_summary calls (internal + external). The
// arkade SDK's auto-claim cycle calls wallet_summary several times per second
// when pending swaps exist, which slams mempool.space and floods the log even
// when individual calls succeed. Cooldown collapses the cascade — repeat
// callers within the window get the last known-good summary instead of a
// fresh round-trip.
export const WALLET_SUMMARY_MIN_INTERVAL_MS = 3_000;

// Rate-limit backoff state for getArkadeWalletSummary. The arkade SDK fetches
// boarding-address UTXOs from mempool.space inside wallet.getBalance(); when
// many callers (the balance driver, the display formula, the wallet loader, the
// LNURL auto-claim loop, etc.) overlap, mempool returns 429 and the failures
// cascade into hundreds of error logs per second. When we detect a rate-limit
// failure, we short-circuit subsequent calls for a backoff window and return
// the last known-good summary instead.
export const WALLET_SUMMARY_RATE_LIMIT_BACKOFF_MS = 30_000;

let cachedWalletSummary: ArkadeWalletSummary | null = null;
let lastGoodWalletSummary: ArkadeWalletSummary | null = null;
let lastWalletSummarySuccessAtMs = 0;
let lastWalletSummaryInflightAtMs = 0;
let lastWalletSummaryRateLimitAtMs = 0;
let latestWalletSummaryStage = "idle";
let latestWalletSummaryStageAtMs = 0;
let walletSummaryCacheKey: string | null = null;
let walletSummaryExportInFlight: Promise<ArkadeWalletSummary> | null = null;
let walletSummaryExportInFlightStartedAtMs = 0;

type ArkadeWalletWithPendingRecovery = {
  pendingRecoveryOutpoints?: () => Promise<Set<string>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// The full per-stage breadcrumb sequence (logWalletSummaryStep) is trace-tier;
// summaryLog emits the one EVENT line per refresh.
const summaryLog = logger("services/arkade/internal/walletSummary.ts");

export function logWalletSummaryStep(stage: string, fields: Record<string, unknown> = {}): void {
  latestWalletSummaryStage = stage;
  latestWalletSummaryStageAtMs = Date.now();
  logArkadeWalletSignTrace("wallet_summary_step", {
    stage,
    ...fields,
  });
}

export function isArkadeWalletValidationError(message: string): boolean {
  return /validation|missing|schema|hex string expected|invalid public key|invalid_public_key|wrong pubkey|public_key_point/i.test(
    message,
  );
}

// Re-exported from a leaf module so the rule is testable: this file reaches
// `@arkade-os/sdk`, which vitest cannot transform.
export {
  isRateLimitErrorMessage,
  isTransientWalletSummaryErrorMessage,
} from "./walletSummaryErrors";

function readVtxoValueSats(coin: unknown): number {
  if (!isRecord(coin)) return 0;
  const value = Number(coin.value ?? 0);
  return Number.isFinite(value) ? value : 0;
}

// SDK 0.5 dropped the `virtualStatus` envelope: a vtxo now carries
// `isSpent`/`isSwept`/`isPreconfirmed` at the top level and no `state` string at
// all. Reading `virtualStatus.state` therefore returned "" for every coin, so
// none matched the settled/preconfirmed/swept branches below and the wallet
// showed a zero balance while holding funds.
//
// 0.4.62 derived the same string from those same flags
// (chunk-URT2RVGB.js:2239):
//   state = isSpent ? "spent" : isSwept ? "swept"
//         : isPreconfirmed ? "preconfirmed" : "settled"
// so this keeps the vocabulary the callers below expect. The legacy envelope is
// still honoured first, because vtxos cached by an older build are read back
// through this same function.
function readVtxoState(coin: unknown): string {
  if (!isRecord(coin)) return "";
  const virtualStatus = coin.virtualStatus;
  if (isRecord(virtualStatus) && virtualStatus.state) {
    return String(virtualStatus.state).trim().toLowerCase();
  }
  if (coin.isSpent) return "spent";
  if (coin.isSwept) return "swept";
  if (coin.isPreconfirmed) return "preconfirmed";
  // Only claim "settled" for something that actually looks like a vtxo; an
  // arbitrary record must not fall through to a funded-looking state.
  if (typeof coin.txid === "string" && coin.txid) return "settled";
  return "";
}

function readOutpointKey(coin: unknown): string {
  if (!isRecord(coin)) return "";
  const txid = String(coin.txid || "").trim();
  const vout = Number(coin.vout);
  if (!txid || !Number.isFinite(vout)) return "";
  return `${txid}:${Math.trunc(vout)}`;
}

function readBoardingValueSats(coin: unknown): number {
  if (!isRecord(coin)) return 0;
  const value = Number(coin.value ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function isBoardingConfirmed(coin: unknown): boolean {
  if (!isRecord(coin)) return false;
  const status = isRecord(coin.status) ? coin.status : null;
  return Boolean(status?.confirmed);
}

async function readPendingRecoveryOutpoints(wallet: unknown): Promise<Set<string>> {
  const candidate = wallet as ArkadeWalletWithPendingRecovery;
  if (typeof candidate.pendingRecoveryOutpoints !== "function") return new Set<string>();
  return candidate.pendingRecoveryOutpoints();
}

// Diagnostic breadcrumbs derived in the same pass as the balance so the
// wallet-summary log never disagrees with the user-facing number (one swept
// rule, one pending-recovery bucketing — no second loop with a divergent
// definition).
type WalletRowsDiagnostics = {
  vtxoTooFreshCount?: number;
  vtxoSettledCount: number;
  vtxoPreconfirmedCount: number;
  vtxoRecoverableCount: number;
  vtxoTotalSats: number;
  vtxoAvailableSats: number;
  pendingVtxoTotalSats: number;
  pendingVtxos: unknown[];
  debugVtxoDetails: string[];
};

function buildBalanceFromWalletRows(
  vtxos: unknown[],
  boardingUtxos: unknown[],
  pendingRecoveryOutpoints: Set<string>,
): { balance: ArkadeDebugBalance; diagnostics: WalletRowsDiagnostics } {
  let boardingConfirmed = 0;
  let boardingUnconfirmed = 0;
  let settled = 0;
  let preconfirmed = 0;
  let recoverable = 0;
  let pendingRecovery = 0;
  let vtxoSettledCount = 0;
  let vtxoPreconfirmedCount = 0;
  let vtxoRecoverableCount = 0;
  let vtxoTotalSats = 0;
  const pendingVtxos: unknown[] = [];
  const settlementGapMs = getSettlementMinExpiryGapMs();
  const nowMs = Date.now();
  let tooFresh = 0;
  let vtxoTooFreshCount = 0;
  const debugVtxoDetails: string[] = [];

  for (const coin of boardingUtxos) {
    const value = readBoardingValueSats(coin);
    if (isBoardingConfirmed(coin)) {
      boardingConfirmed += value;
    } else {
      boardingUnconfirmed += value;
    }
  }

  for (const coin of vtxos) {
    const value = readVtxoValueSats(coin);
    const state = readVtxoState(coin);
    const outpoint = readOutpointKey(coin);
    vtxoTotalSats += value;
    debugVtxoDetails.push(formatVtxoDebugLine(coin));
    // A SPENT vtxo keeps its state ("settled"/"preconfirmed") — the spend lives
    // in the terminal-spend fields, not the state. Counting state alone put the
    // sats of every lightning/ark send back into the headline: the wallet showed
    // the pre-send total while the send gate (SDK available, which excludes
    // hasTerminalSpend) read the real spendable — two numbers for one wallet.
    // isSpendable is the same exclusion the spend path uses; only the swept
    // branch checked it before, so spent-settled coins counted forever.
    const unspent = isSpendable(coin as Parameters<typeof isSpendable>[0]);
    const isPendingRecovery = Boolean(outpoint && pendingRecoveryOutpoints.has(outpoint));
    if (isPendingRecovery) {
      pendingRecovery += value;
      continue;
    }
    if (state === "settled") {
      if (!unspent) continue;
      vtxoSettledCount += 1;
      // Settled is not the same as spendable: the server refuses a settlement
      // input whose batch expiry is further out than its min expiry gap, so a
      // freshly settled VTXO cannot be sent yet. It belongs in the pending row
      // with the finalizing ones, not in the headline the user can spend.
      if (isVtxoSettleable(coin as SettleabilityInput, settlementGapMs, nowMs)) {
        settled += value;
      } else {
        // Counted apart because it cannot be a SETTLEMENT input yet, not
        // because it cannot be spent: an offchain send takes it like any other
        // settled VTXO, and the balance says so. It is therefore NOT pending —
        // listing it there too showed the same sats twice, once as balance and
        // once as money on its way.
        tooFresh += value;
        vtxoTooFreshCount += 1;
      }
    } else if (state === "preconfirmed") {
      // Spendable offchain like any settled VTXO — it just is not in a batch
      // yet, so it cannot be a settlement input. It belongs in the balance, not
      // in the pending row that says money is on its way.
      if (!unspent) continue;
      preconfirmed += value;
      vtxoPreconfirmedCount += 1;
    } else if (state === "swept" && isSpendable(coin as Parameters<typeof isSpendable>[0])) {
      recoverable += value;
      vtxoRecoverableCount += 1;
    }
  }

  const boardingTotal = boardingConfirmed + boardingUnconfirmed;
  const available = settled + preconfirmed;
  return {
    balance: {
      boarding: {
        confirmed: boardingConfirmed,
        unconfirmed: boardingUnconfirmed,
        total: boardingTotal,
      },
      settled,
      preconfirmed,
      tooFresh,
      available,
      recoverable,
      total: boardingTotal + settled + preconfirmed + tooFresh + recoverable + pendingRecovery,
    },
    diagnostics: {
      vtxoSettledCount,
      vtxoPreconfirmedCount,
      vtxoRecoverableCount,
      vtxoTotalSats,
      vtxoAvailableSats: available,
      vtxoTooFreshCount,
      // Nothing offchain is "pending" any more: settled, too-fresh and
      // preconfirmed VTXOs all spend. What cannot be spent — recoverable,
      // awaiting recovery, unswept boarding — has rows of its own.
      pendingVtxoTotalSats: 0,
      pendingVtxos,
      debugVtxoDetails,
    },
  };
}

function clearWalletSummaryMemory(): void {
  cachedWalletSummary = null;
  lastGoodWalletSummary = null;
  lastWalletSummarySuccessAtMs = 0;
  lastWalletSummaryInflightAtMs = 0;
  lastWalletSummaryRateLimitAtMs = 0;
  latestWalletSummaryStage = "idle";
  latestWalletSummaryStageAtMs = 0;
  walletSummaryExportInFlight = null;
  walletSummaryExportInFlightStartedAtMs = 0;
  lastRegisteredBoardingAddress = null;
  // The boarding UTXO cache is keyed by wallet, but a wipe here means a reset or
  // an identity change, and a cached row from the previous wallet must not
  // survive it.
  resetBoardingUtxoCache("wallet_summary_memory_cleared");
}

function ensureWalletSummaryCacheKey(): string {
  const next = getCurrentArkadeWalletCacheKey();
  if (walletSummaryCacheKey && walletSummaryCacheKey !== next) {
    clearWalletSummaryMemory();
    logWalletSummaryStep("identity_changed", {
      expected_next: "fresh_wallet_summary_current_identity",
    });
  }
  walletSummaryCacheKey = next;
  return next;
}

function assertWalletSummaryCacheKey(loadCacheKey: string): void {
  const next = getCurrentArkadeWalletCacheKey();
  if (next === loadCacheKey) return;
  clearWalletSummaryMemory();
  walletSummaryCacheKey = next;
  logWalletSummaryStep("identity_changed_discard", {
    expected_next: "retry_wallet_summary_current_identity",
  });
  throw new Error("wallet_summary_identity_changed");
}

// Reads also evict on identity change: ensureWalletSummaryCacheKey() wipes
// module state when the active wallet identity differs, so this returns null
// rather than another account's summary.
export function getCachedWalletSummary(): ArkadeWalletSummary | null {
  ensureWalletSummaryCacheKey();
  return cachedWalletSummary ? { ...cachedWalletSummary } : null;
}

// Reads also evict on identity change (see getCachedWalletSummary).
export function getLastGoodWalletSummary(): ArkadeWalletSummary | null {
  ensureWalletSummaryCacheKey();
  return lastGoodWalletSummary ? { ...lastGoodWalletSummary } : null;
}

export function getLatestWalletSummaryStage(): string {
  return latestWalletSummaryStage;
}

export function getLatestWalletSummaryStageAtMs(): number {
  return latestWalletSummaryStageAtMs;
}

export function getLastWalletSummaryRateLimitAtMs(): number {
  return lastWalletSummaryRateLimitAtMs;
}

export function setLastWalletSummaryRateLimitAtMs(value: number): void {
  lastWalletSummaryRateLimitAtMs = value;
}

export function resetArkadeWalletSummaryCache(): void {
  clearWalletSummaryMemory();
  walletSummaryCacheKey = null;
}

function isRequestAuthTokenFormat(token: string): boolean {
  return String(token || "").includes(".");
}

// Registration is idempotent server-side, but every wallet-summary refresh
// goes through here — only re-send when the address actually changed or the
// last attempt failed.
let lastRegisteredBoardingAddress: string | null = null;
let boardingAddressRegistrationInFlight = false;

async function registerReceiveBoardingAddressNoPrompt(
  boardingAddress: string,
  reason: string,
): Promise<void> {
  const address = String(boardingAddress || "").trim();
  if (!address) return;
  if (boardingAddressRegistrationInFlight || lastRegisteredBoardingAddress === address) return;
  const assertion = await getArkadeLnurlAssertion("receive_boarding_address", false);
  if (!assertion) {
    logArkadeWalletSignTrace("receive_boarding_address", {
      status: "skipped",
      reason,
      prompt: 0,
      why: "no_cached_assertion",
      expected_next: "retry_after_next_passkey_assertion",
    });
    return;
  }
  if (!isRequestAuthTokenFormat(assertion.token)) {
    logArkadeWalletSignTrace("receive_boarding_address", {
      status: "skipped",
      reason,
      prompt: 0,
      why: "cached_token_not_request_auth",
      expected_next: "retry_after_next_request_auth_assertion",
    });
    return;
  }
  const startedAtMs = Date.now();
  boardingAddressRegistrationInFlight = true;
  try {
    const out = await arkadeReceiveBoardingAddress(assertion, {
      boarding_address: address,
      metadata: { source: reason },
    });
    lastRegisteredBoardingAddress = address;
    logArkadeWalletSignTrace("receive_boarding_address", {
      status: "ok",
      reason,
      prompt: 0,
      durMs: Date.now() - startedAtMs,
      address: truncateForLog(
        String(out?.boarding_address?.address_preview || out?.boarding_address?.address || address),
        24,
      ),
      expected_next: "server_receive_sync_can_monitor_boarding",
    });
  } catch (error: unknown) {
    logArkadeWalletSignTrace("receive_boarding_address", {
      status: "failed",
      reason,
      prompt: 0,
      durMs: Date.now() - startedAtMs,
      address: truncateForLog(address, 24),
      err: truncateForLog(error instanceof Error ? error.message : String(error || "unknown"), 160),
      expected_next: "retry_next_wallet_summary",
    });
  } finally {
    boardingAddressRegistrationInFlight = false;
  }
}

/**
 * This wallet's boarding output script, read straight off the constructed wallet
 * (no network). Present whenever the wallet object exists, which is the case
 * here: only the address read timed out.
 */
function readWalletBoardingScriptHex(wallet: unknown): string {
  const raw = wallet as { boardingTapscript?: { pkScript?: unknown } } | null;
  const script = raw?.boardingTapscript?.pkScript;
  if (typeof script === "string") return script.trim().toLowerCase();
  if (script instanceof Uint8Array) return bytesToHex(script).toLowerCase();
  return "";
}

function boardingAddressScriptHex(address: string): string {
  try {
    return bytesToHex(btc.OutScript.encode(btc.Address().decode(address))).toLowerCase();
  } catch {
    return "";
  }
}

/**
 * The boarding address this wallet registered with the server, read back from
 * `/receive/sync`. Registration was push-only, so a device whose local
 * derivation times out had no address at all to show even though the server had
 * been holding one for weeks.
 *
 * The sync is scoped to this owner, but "this owner's last registered address"
 * is not the same claim as "the address this wallet boards to today": a contract
 * change since that push (CSV/decay params, a signer migration) would make it an
 * address whose UTXOs `getBoardingUtxos()` never lists — money that arrives
 * there cannot be swept, which is the very failure this is meant to end. So it
 * is only accepted when it matches the wallet's own boarding script, which is
 * readable without the network.
 */
async function readRegisteredBoardingAddressFromServer(
  wallet: unknown,
  reason: string,
): Promise<string> {
  try {
    const owner = await getArkadeReceiveOwner();
    const out = await arkadeReceiveSync(owner);
    const address = String(out?.boarding_address?.address || "").trim();
    const localScript = readWalletBoardingScriptHex(wallet);
    const serverScript = address ? boardingAddressScriptHex(address) : "";
    const verified = Boolean(localScript) && localScript === serverScript;
    logArkadeWalletSignTrace("receive_boarding_address_hydrate", {
      status: !address ? "empty" : verified ? "ok" : "script_mismatch",
      reason,
      address: truncateForLog(address || "n/a", 24),
      local_script: localScript ? truncateForLog(localScript, 16) : "n/a",
      server_script: serverScript ? truncateForLog(serverScript, 16) : "n/a",
      expected_next: verified ? "use_server_boarding_address" : "propagate_local_failure",
    });
    return verified ? address : "";
  } catch (error: unknown) {
    logArkadeWalletSignTrace("receive_boarding_address_hydrate", {
      status: "failed",
      reason,
      err: truncateForLog(error instanceof Error ? error.message : String(error || "unknown"), 160),
      expected_next: "propagate_local_failure",
    });
    return "";
  }
}

export async function loadArkadeWalletSummary(
  options?: ArkadeWalletSummaryOptions,
): Promise<ArkadeWalletSummary> {
  const loadCacheKey = ensureWalletSummaryCacheKey();
  const summaryStartedAtMs = Date.now();
  // Cooldown: skip the network round-trip if either (a) a successful summary
  // landed within the window, or (b) another summary is in-flight that
  // started within the window. Return cached so callers see stable data.
  const sinceSuccessMs = summaryStartedAtMs - lastWalletSummarySuccessAtMs;
  const sinceInflightMs = summaryStartedAtMs - lastWalletSummaryInflightAtMs;
  if (
    !options?.forceFresh &&
    lastGoodWalletSummary &&
    ((lastWalletSummarySuccessAtMs > 0 && sinceSuccessMs < WALLET_SUMMARY_MIN_INTERVAL_MS) ||
      (lastWalletSummaryInflightAtMs > 0 && sinceInflightMs < WALLET_SUMMARY_MIN_INTERVAL_MS))
  ) {
    logWalletSummaryStep("cooldown_skip", {
      sinceSuccessMs,
      sinceInflightMs,
      cooldownMs: WALLET_SUMMARY_MIN_INTERVAL_MS,
    });
    return { ...lastGoodWalletSummary };
  }
  lastWalletSummaryInflightAtMs = summaryStartedAtMs;
  emitTrace({
    atMs: summaryStartedAtMs,
    op: "wallet_summary",
    status: "start",
    detail: "stage=get_or_create_wallet",
  });
  logWalletSummaryStep("get_or_create_wallet_start");
  const wallet = await getOrCreateWallet();
  emitTrace({
    atMs: Date.now(),
    op: "wallet_summary",
    status: "wallet_ready",
    detail: `stage=wallet_ready durMs=${Date.now() - summaryStartedAtMs}`,
  });
  logWalletSummaryStep("wallet_ready", {
    durMs: Date.now() - summaryStartedAtMs,
  });

  const addressesStartedAtMs = Date.now();
  emitTrace({
    atMs: addressesStartedAtMs,
    op: "wallet_summary",
    status: "addresses_start",
    detail: "stage=read_addresses",
  });
  logWalletSummaryStep("addresses_start", {
    limitMs: ARKADE_NODE_INFO_TIMEOUT_MS,
  });
  let boardingAddressSource = "local";
  const [arkAddress, boardingAddress] = await Promise.all([
    withTimeout<string>(
      "wallet_summary_ark_address",
      ARKADE_NODE_INFO_TIMEOUT_MS,
      wallet.getAddress(),
    ),
    withTimeout<string>(
      "wallet_summary_boarding_address",
      ARKADE_NODE_INFO_TIMEOUT_MS,
      wallet.getBoardingAddress(),
    ).catch(async (error: unknown) => {
      const hydrated = await readRegisteredBoardingAddressFromServer(
        wallet,
        "wallet_summary_boarding_address_failed",
      );
      if (!hydrated) throw error;
      boardingAddressSource = "server";
      return hydrated;
    }),
  ]);
  emitTrace({
    atMs: Date.now(),
    op: "wallet_summary",
    status: "addresses_ready",
    detail: `durMs=${Date.now() - addressesStartedAtMs} ark=${truncateForLog(String(arkAddress || "n/a"), 20)} boarding=${truncateForLog(String(boardingAddress || "n/a"), 20)}`,
  });
  logWalletSummaryStep("addresses_ready", {
    durMs: Date.now() - addressesStartedAtMs,
    ark: truncateForLog(String(arkAddress || "n/a"), 20),
    boarding: truncateForLog(String(boardingAddress || "n/a"), 20),
    boardingSource: boardingAddressSource,
  });
  await persistArkadeStableParams(wallet);
  // Never re-register an address that came FROM the server: registration exists
  // to teach the server this wallet's address, and echoing its own value back
  // would only spend an assertion.
  if (boardingAddressSource === "local") {
    void registerReceiveBoardingAddressNoPrompt(String(boardingAddress || ""), "wallet_summary");
  }

  const vtxosStartedAtMs = Date.now();
  emitTrace({
    atMs: vtxosStartedAtMs,
    op: "wallet_summary",
    status: "vtxos_start",
    detail: "stage=read_vtxos",
  });
  logWalletSummaryStep("vtxos_start", {
    limitMs: ARKADE_NODE_INFO_TIMEOUT_MS,
  });
  const vtxosPromise = withTimeout<unknown[]>(
    "wallet_summary_vtxos",
    ARKADE_NODE_INFO_TIMEOUT_MS,
    wallet.getVtxos(),
  )
    .then((value) => {
      emitTrace({
        atMs: Date.now(),
        op: "wallet_summary",
        status: "vtxos_ready",
        detail: `durMs=${Date.now() - vtxosStartedAtMs} vtxos=${Array.isArray(value) ? value.length : "n/a"}`,
      });
      logWalletSummaryStep("vtxos_ready", {
        durMs: Date.now() - vtxosStartedAtMs,
        vtxos: Array.isArray(value) ? value.length : "n/a",
      });
      return value;
    })
    .catch(async (error: unknown) => {
      const errorText = error instanceof Error ? error.message : String(error || "unknown");
      const validationFailure = isArkadeWalletValidationError(errorText);
      const transientFailure =
        !validationFailure && isTransientWalletSummaryErrorMessage(errorText);
      emitTrace({
        atMs: Date.now(),
        op: "wallet_summary",
        status: "vtxos_failed",
        detail:
          `durMs=${Date.now() - vtxosStartedAtMs} ` +
          `errorKind=${validationFailure ? "validation" : "runtime"} ` +
          `err=${truncateForLog(errorText, 180)}`,
      });
      const vtxosFailureFields = {
        elapsedMs: Date.now() - summaryStartedAtMs,
        errorKind: validationFailure ? "validation" : "runtime",
        err: truncateForLog(errorText, 220),
        expected_next: transientFailure ? "use_last_good_summary_or_retry" : "inspect_wallet_vtxos",
      };
      if (transientFailure) {
        logArkadeWalletSignTrace("wallet_summary_vtxos_failed", {
          status: "transient",
          ...vtxosFailureFields,
        });
      } else {
        logArkadeWalletErrorTrace("wallet_summary_vtxos_failed", vtxosFailureFields);
      }
      logWalletSummaryStep("vtxos_failed", {
        durMs: Date.now() - vtxosStartedAtMs,
        errorKind: validationFailure ? "validation" : "runtime",
        err: truncateForLog(errorText, 140),
      });
      const diagnostics = await getArkadeContractDiagnosticsSummary("wallet_summary_vtxos_failed");
      throw new Error(
        `wallet_vtxos_failed err=${truncateForLog(errorText, 180)} contractStatus=${diagnostics.status} invalidContracts=${diagnostics.invalidCount} detail=${truncateForLog(diagnostics.logLine, 220)}`,
      );
    });

  const boardingUtxosStartedAtMs = Date.now();
  emitTrace({
    atMs: boardingUtxosStartedAtMs,
    op: "wallet_summary",
    status: "boarding_utxos_start",
    detail: `stage=read_boarding_utxos timeoutMs=${ARKADE_WALLET_SUMMARY_BALANCE_TIMEOUT_MS}`,
  });
  logWalletSummaryStep("boarding_utxos_start", {
    limitMs: ARKADE_WALLET_SUMMARY_BALANCE_TIMEOUT_MS,
  });
  const boardingUtxosPromise = withTimeout<unknown[]>(
    "wallet_summary_boarding_utxos",
    ARKADE_WALLET_SUMMARY_BALANCE_TIMEOUT_MS,
    // Shared with the boarding ownership proof, which runs in the same unlock
    // monitor pass. Each read is one Esplora request per boarding address, and
    // duplicating it per tick is what drove the app into mempool's rate limit.
    readBoardingUtxosShared<unknown>(
      wallet as unknown as { getBoardingUtxos: () => Promise<unknown[]> },
      getCurrentArkadeWalletCacheKey(),
      { reason: "wallet_summary" },
    ),
  )
    .then((value) => {
      let confirmed = 0;
      let unconfirmed = 0;
      for (const coin of Array.isArray(value) ? value : []) {
        if (isBoardingConfirmed(coin)) {
          confirmed += readBoardingValueSats(coin);
        } else {
          unconfirmed += readBoardingValueSats(coin);
        }
      }
      emitTrace({
        atMs: Date.now(),
        op: "wallet_summary",
        status: "boarding_utxos_ready",
        detail: `durMs=${Date.now() - boardingUtxosStartedAtMs} utxos=${Array.isArray(value) ? value.length : "n/a"} confirmed=${confirmed} unconfirmed=${unconfirmed}`,
      });
      logWalletSummaryStep("boarding_utxos_ready", {
        durMs: Date.now() - boardingUtxosStartedAtMs,
        utxos: Array.isArray(value) ? value.length : "n/a",
        confirmed,
        unconfirmed,
      });
      return value;
    })
    .catch((error: unknown) => {
      const errorText = error instanceof Error ? error.message : String(error || "unknown");
      const transientFailure = isTransientWalletSummaryErrorMessage(errorText);
      emitTrace({
        atMs: Date.now(),
        op: "wallet_summary",
        status: "boarding_utxos_failed",
        detail: `durMs=${Date.now() - boardingUtxosStartedAtMs} err=${truncateForLog(errorText, 160)}`,
      });
      const boardingFailureFields = {
        elapsedMs: Date.now() - summaryStartedAtMs,
        err: truncateForLog(errorText, 220),
        expected_next: transientFailure
          ? "use_last_good_summary_or_retry"
          : "inspect_boarding_utxos",
      };
      if (transientFailure) {
        logArkadeWalletSignTrace("wallet_summary_boarding_utxos_failed", {
          status: "transient",
          ...boardingFailureFields,
        });
      } else {
        logArkadeWalletErrorTrace("wallet_summary_boarding_utxos_failed", boardingFailureFields);
      }
      logWalletSummaryStep("boarding_utxos_failed", {
        durMs: Date.now() - boardingUtxosStartedAtMs,
        err: truncateForLog(errorText, 120),
      });
      if (transientFailure) {
        lastWalletSummaryRateLimitAtMs = Date.now();
      }
      // Non-fatal: a boarding/L1 failure must NOT reject the whole summary and
      // wipe an otherwise-good VTXO balance. Surface a sentinel and let the
      // carry-forward below preserve the last-known boarding bucket.
      return BOARDING_UNAVAILABLE;
    });

  const [vtxosRaw, boardingRaw] = await Promise.all([vtxosPromise, boardingUtxosPromise]);
  const boardingUnavailable = boardingRaw === BOARDING_UNAVAILABLE;
  let vtxos: unknown[] = Array.isArray(vtxosRaw) ? vtxosRaw : [];
  const boardingUtxos = boardingUnavailable ? [] : (boardingRaw as unknown[]);

  // Force a live reconciliation of the terminal-spend flags before the balance
  // is derived. The repo is offline-first and merge-only (`saveVtxos` upserts
  // by outpoint, nothing clears a row), so a spend whose indexer update was
  // missed leaves the LOCAL row unspent forever — and the state-based balance
  // kept counting those sats (user-visible as a headline far above spendable
  // while the send gate read the truth). Refreshing the wallet's own outpoints
  // through refreshOutpoints asks the indexer for exactly those coins and
  // persists the result, so spent coins lose their spendability here and in
  // every later offline read. Best-effort: on failure the stale rows stand and
  // the balance may over-report as before — never under-report.
  try {
    const spendableCoins = (Array.isArray(vtxos) ? vtxos : []).filter((coin) =>
      isSpendable(coin as Parameters<typeof isSpendable>[0]),
    );
    const outpoints = spendableCoins
      .map((coin) => readOutpointKey(coin))
      .filter((key) => key.includes(":"));
    if (outpoints.length > 0) {
      const contractManager = await wallet.getContractManager();
      await withTimeout(
        "wallet_summary_vtxo_reconcile",
        ARKADE_WALLET_SUMMARY_BALANCE_TIMEOUT_MS,
        contractManager.refreshOutpoints(
          outpoints.map((key) => {
            const [txid, vout] = key.split(":");
            return { txid, vout: Number(vout) };
          }),
        ),
      );
      // Re-read after reconciliation so the derived balance reflects the
      // indexer's terminal-spend flags, not the pre-reconcile repo rows.
      vtxos = await withTimeout<unknown[]>(
        "wallet_summary_vtxos_reread",
        ARKADE_NODE_INFO_TIMEOUT_MS,
        wallet.getVtxos(),
      );
    }
  } catch (error: unknown) {
    logWalletSummaryStep("vtxo_reconcile_failed", {
      err: truncateForLog(error instanceof Error ? error.message : String(error || "unknown"), 160),
      expected_next: "derive_balance_from_stale_rows",
    });
  }

  // refreshOutpoints above can only correct rows the indexer still knows about.
  // A row it does not return at all comes back untouched — an LNURL receive
  // whose lockup was never funded stays cached forever, because the repository
  // merges on save and nothing ever evicts it. Such a row is flag-identical to
  // a funded coin, so only the operator can tell them apart: ask which
  // outpoints exist and drop the rest. Fail-open — see vtxoReconciliation.
  try {
    const reconciliation = await withTimeout(
      "wallet_summary_vtxo_confirm",
      ARKADE_WALLET_SUMMARY_BALANCE_TIMEOUT_MS,
      dropUnconfirmedVtxos(vtxos, wallet.indexerProvider as VtxoConfirmingIndexer | undefined),
    );
    if (reconciliation.droppedCount > 0) {
      logWalletSummaryStep("vtxo_unconfirmed_dropped", {
        droppedCount: reconciliation.droppedCount,
        droppedSats: reconciliation.droppedSats,
        kept: reconciliation.vtxos.length,
      });
    }
    vtxos = reconciliation.vtxos;
  } catch (error: unknown) {
    logWalletSummaryStep("vtxo_confirm_failed", {
      err: truncateForLog(error instanceof Error ? error.message : String(error || "unknown"), 160),
      expected_next: "derive_balance_from_unconfirmed_rows",
    });
  }

  const contractDiagnostics = await getArkadeContractDiagnosticsSummary("wallet_summary");
  if (contractDiagnostics.status !== "ok") {
    const errorText = `wallet_contracts_invalid invalid=${contractDiagnostics.invalidCount} detail=${truncateForLog(contractDiagnostics.logLine, 220)}`;
    logArkadeWalletErrorTrace("wallet_summary_contracts_invalid", {
      elapsedMs: Date.now() - summaryStartedAtMs,
      err: truncateForLog(errorText, 260),
    });
    throw new Error(errorText);
  }

  const balanceStartedAtMs = Date.now();
  emitTrace({
    atMs: balanceStartedAtMs,
    op: "wallet_summary",
    status: "balance_start",
    detail: "source=derived_from_vtxos_and_boarding_utxos",
  });
  logWalletSummaryStep("balance_start", {
    source: "derived_from_vtxos_and_boarding_utxos",
  });
  let pendingRecoveryOutpoints = new Set<string>();
  try {
    pendingRecoveryOutpoints = await readPendingRecoveryOutpoints(wallet);
  } catch (error: unknown) {
    logWalletSummaryStep("pending_recovery_outpoints_failed", {
      err: truncateForLog(error instanceof Error ? error.message : String(error || "unknown"), 120),
      expected_next: "derive_balance_without_pending_recovery_bucket",
    });
  }
  // Existing sessions may have neither persisted the gap nor called
  // `/arkade/info` since the server began publishing it. Read cache first, then
  // public health, before deciding which sats the headline may promise.
  await ensureSettlementMinExpiryGapMs();
  const { balance, diagnostics } = buildBalanceFromWalletRows(
    Array.isArray(vtxos) ? vtxos : [],
    Array.isArray(boardingUtxos) ? boardingUtxos : [],
    pendingRecoveryOutpoints,
  );
  // Boarding (L1) read failed — don't report a fresh 0 that erases known pending
  // deposits. Carry the last-known boarding bucket forward instead.
  // ponytail: stale carry-forward, self-heals on next good summary. Narrow
  // double-count window only if a sweep lands while L1 is down.
  if (boardingUnavailable) {
    const prevBoarding = getCachedWalletSummary();
    const carryTotal = Math.max(0, Number(prevBoarding?.balanceBoardingTotalSats || 0) || 0);
    if (carryTotal > 0) {
      balance.boarding = {
        confirmed: Math.max(0, Number(prevBoarding?.balanceBoardingConfirmedSats || 0) || 0),
        unconfirmed: Math.max(0, Number(prevBoarding?.balanceBoardingUnconfirmedSats || 0) || 0),
        total: carryTotal,
      };
      balance.total = (Number(balance.total) || 0) + carryTotal;
    }
  }
  const {
    vtxoSettledCount,
    vtxoPreconfirmedCount,
    vtxoRecoverableCount,
    vtxoTotalSats,
    vtxoAvailableSats,
    pendingVtxoTotalSats,
    pendingVtxos,
    debugVtxoDetails,
  } = diagnostics;
  emitTrace({
    atMs: Date.now(),
    op: "wallet_summary",
    status: "balance_ready",
    detail: `durMs=${Date.now() - balanceStartedAtMs} source=derived total=${String(balance.total ?? 0)} boardingConfirmed=${String(balance.boarding?.confirmed ?? 0)} boardingUnconfirmed=${String(balance.boarding?.unconfirmed ?? 0)} boardingTotal=${String(balance.boarding?.total ?? 0)}`,
  });
  logWalletSummaryStep("balance_ready", {
    durMs: Date.now() - balanceStartedAtMs,
    source: "derived",
    total: String(balance.total ?? 0),
    boardingConfirmed: String(balance.boarding?.confirmed ?? 0),
    boardingUnconfirmed: String(balance.boarding?.unconfirmed ?? 0),
    boardingTotal: String(balance.boarding?.total ?? 0),
  });
  const recoveryCsvStartedAtMs = Date.now();
  emitTrace({
    atMs: recoveryCsvStartedAtMs,
    op: "wallet_summary",
    status: "recovery_csv_start",
    detail: `timeoutMs=${ARKADE_WALLET_SUMMARY_RECOVERY_CSV_TIMEOUT_MS}`,
  });
  logWalletSummaryStep("recovery_csv_start", {
    limitMs: ARKADE_WALLET_SUMMARY_RECOVERY_CSV_TIMEOUT_MS,
  });
  const recoveryCsv = await withTimeout<ArkadeRecoveryCsvStatus>(
    "wallet_summary_recovery_csv",
    ARKADE_WALLET_SUMMARY_RECOVERY_CSV_TIMEOUT_MS,
    inspectArkadeRecoveryCsvStatus(wallet, "wallet_summary"),
  )
    .then((value) => {
      emitTrace({
        atMs: Date.now(),
        op: "wallet_summary",
        status: "recovery_csv_ready",
        detail:
          `durMs=${Date.now() - recoveryCsvStartedAtMs} ` + `status=${value.recoveryCsvStatus}`,
      });
      logWalletSummaryStep("recovery_csv_ready", {
        durMs: Date.now() - recoveryCsvStartedAtMs,
        status: value.recoveryCsvStatus,
      });
      return value;
    })
    .catch((error: unknown): ArkadeRecoveryCsvStatus => {
      // Non-fatal: recovery-CSV is an informational signal on the summary; the
      // hard safety gate is assertArkadeRecoveryCsvCompatible at every
      // spend/claim/sweep. Degrade to "unknown" and keep the balance.
      const errorText = error instanceof Error ? error.message : String(error || "unknown");
      const transientFailure = isTransientWalletSummaryErrorMessage(errorText);
      const recoveryCsvFailureFields = {
        elapsedMs: Date.now() - summaryStartedAtMs,
        err: truncateForLog(errorText, 220),
        expected_next: "surface_balance_with_unknown_recovery_csv",
      };
      if (transientFailure) {
        logArkadeWalletSignTrace("wallet_summary_recovery_csv_failed", {
          status: "transient",
          ...recoveryCsvFailureFields,
        });
      } else {
        logArkadeWalletErrorTrace("wallet_summary_recovery_csv_failed", recoveryCsvFailureFields);
      }
      logWalletSummaryStep("recovery_csv_failed", {
        durMs: Date.now() - recoveryCsvStartedAtMs,
        err: truncateForLog(errorText, 120),
      });
      return {
        recoveryCsvStatus: "unknown",
        recoveryCsvArkadeLabel: "n/a_unknown",
        recoveryCsvNuriServerLabel: "n/a_unknown",
        recoveryCsvDetail: `inspect_failed err=${truncateForLog(errorText, 160)}`,
      };
    });

  const out: ArkadeWalletSummary = {
    arkAddress: String(arkAddress || ""),
    boardingAddress: String(boardingAddress || ""),
    balanceTotalSats: String(balance?.total ?? 0),
    balanceBoardingConfirmedSats: String(balance?.boarding?.confirmed ?? 0),
    balanceBoardingUnconfirmedSats: String(balance?.boarding?.unconfirmed ?? 0),
    balanceBoardingTotalSats: String(balance?.boarding?.total ?? 0),
    balanceAvailableSats: String(balance?.available ?? 0),
    balanceSettledSats: String(balance?.settled ?? 0),
    balanceTooFreshSats: String(balance?.tooFresh ?? 0),
    balancePreconfirmedSats: String(balance?.preconfirmed ?? 0),
    balanceRecoverableSats: String(balance?.recoverable ?? 0),
    balanceAvailableLabel: "SDK available (settled + preconfirmed)",
    balanceSettledLabel: "Settled final",
    balancePreconfirmedLabel: "Preconfirmed finalizing",
    balanceNote: "Available is the Arkade SDK spendable balance.",
    recoveryCsvStatus: recoveryCsv.recoveryCsvStatus,
    recoveryCsvArkadeLabel: recoveryCsv.recoveryCsvArkadeLabel,
    recoveryCsvNuriServerLabel: recoveryCsv.recoveryCsvNuriServerLabel,
    recoveryCsvDetail: recoveryCsv.recoveryCsvDetail,
    debugVtxoCount: Array.isArray(vtxos) ? vtxos.length : 0,
    debugVtxoSettledCount: vtxoSettledCount,
    debugVtxoPreconfirmedCount: vtxoPreconfirmedCount,
    debugVtxoRecoverableCount: vtxoRecoverableCount,
    debugVtxoTotalSats: String(vtxoTotalSats),
    debugVtxoAvailableSats: String(vtxoAvailableSats),
    debugVtxoDetails: debugVtxoDetails.slice(0, 12),
    debugPendingVtxoCount: pendingVtxos.length,
    debugPendingVtxoTotalSats: String(pendingVtxoTotalSats),
    // Per-pending-vtxo commitment lookups are network-bound debug enrichment
    // (formatPendingVtxoDebugLine) — debug must not gate or slow the prod
    // summary. Debug surfaces that need the lines fetch them on demand.
    debugPendingVtxoDetails: [],
    contractDiagnosticsStatus: contractDiagnostics.status,
    contractDiagnosticsLine: contractDiagnostics.logLine,
  };
  assertWalletSummaryCacheKey(loadCacheKey);
  cachedWalletSummary = { ...out };
  if (!isZeroArkadeWalletSummary(out)) {
    lastGoodWalletSummary = { ...out };
  }
  lastWalletSummarySuccessAtMs = Date.now();
  updateReceiveStageFromWalletSummary(out);
  logArkadeWalletSignTrace("arkade_wallet_pending_vtxo_state", {
    status: pendingVtxos.length > 0 ? "wallet_pending" : "idle",
    arkade_wallet_pending_vtxo_count: pendingVtxos.length,
    arkade_wallet_pending_vtxo_sats: pendingVtxoTotalSats,
    expected_next: pendingVtxos.length > 0 ? "wallet_pending_no_auto_sign" : "idle",
  });

  console.log(
    `🔐 [${shortTime()} ArkadeWalletService.summary] nuri_server_api=${NURI_SERVER_API_VERSION} namespace=${ARKADE_V4_STORAGE_PREFIX} arkPresent=${out.arkAddress ? 1 : 0} boardingPresent=${out.boardingAddress ? 1 : 0} total=${out.balanceTotalSats} boardingTotal=${out.balanceBoardingTotalSats} boardingConfirmed=${out.balanceBoardingConfirmedSats} boardingUnconfirmed=${out.balanceBoardingUnconfirmedSats} available=${out.balanceAvailableSats} availableLabel=sdk_available_settled_plus_preconfirmed settled=${out.balanceSettledSats} settledLabel=settled_final preconfirmed=${out.balancePreconfirmedSats} preconfirmedLabel=preconfirmed_finalizing recoverable=${out.balanceRecoverableSats} recoveryCsv=${out.recoveryCsvStatus} arkadeCsv=${out.recoveryCsvArkadeLabel} nuriServerCsv=${out.recoveryCsvNuriServerLabel} contractDiag=${out.contractDiagnosticsStatus} contractDiagDetail=${truncateForLog(out.contractDiagnosticsLine, 220)} vtxos=${out.debugVtxoCount} vtxoSettled=${out.debugVtxoSettledCount} vtxoPreconfirmed=${out.debugVtxoPreconfirmedCount} vtxoRecoverable=${out.debugVtxoRecoverableCount} vtxoTotal=${out.debugVtxoTotalSats} vtxoAvailable=${out.debugVtxoAvailableSats} arkade_wallet_pending_vtxo_count=${out.debugPendingVtxoCount} arkade_wallet_pending_vtxo_sats=${out.debugPendingVtxoTotalSats}`,
  );
  emitTrace({
    atMs: Date.now(),
    op: "wallet_summary",
    status: "ok",
    detail: `arkPresent=${out.arkAddress ? 1 : 0} boardingPresent=${out.boardingAddress ? 1 : 0} total=${out.balanceTotalSats} boardingTotal=${out.balanceBoardingTotalSats} boardingConfirmed=${out.balanceBoardingConfirmedSats} boardingUnconfirmed=${out.balanceBoardingUnconfirmedSats} available=${out.balanceAvailableSats} settled=${out.balanceSettledSats} preconfirmed=${out.balancePreconfirmedSats} recoverable=${out.balanceRecoverableSats} arkade_wallet_pending_vtxo_count=${out.debugPendingVtxoCount} arkade_wallet_pending_vtxo_sats=${out.debugPendingVtxoTotalSats} recoveryCsv=${out.recoveryCsvStatus}`,
  });
  const autoClaimEnabled = options?.scheduleAutoClaim === true;
  const autoRecoverEnabled = options?.scheduleAutoRecover === true;
  const autoBoardingSweepEnabled = options?.scheduleAutoBoardingSweep === true;
  const boardingConfirmedSats = Math.max(0, Number(out.balanceBoardingConfirmedSats || 0) || 0);
  const boardingUnconfirmedSats = Math.max(0, Number(out.balanceBoardingUnconfirmedSats || 0) || 0);
  const recoverableSats = Math.max(0, Number(out.balanceRecoverableSats || 0) || 0);
  const autoPolicyExpectedNext =
    autoRecoverEnabled && recoverableSats > 0
      ? "arkade_recoverable_auto_claim"
      : autoBoardingSweepEnabled && boardingConfirmedSats > 0
        ? "arkade_boarding_auto_sweep"
        : autoBoardingSweepEnabled && boardingUnconfirmedSats > 0
          ? "wait_for_bitcoin_confirmation"
          : autoClaimEnabled
            ? "lnurl_pending_auto_load"
            : "skip_receive_maintenance";
  emitTrace({
    atMs: Date.now(),
    op: "wallet_summary_auto_policy",
    status: "ok",
    detail: `autoClaim=${autoClaimEnabled ? 1 : 0} autoRecover=${autoRecoverEnabled ? 1 : 0} autoBoardingSweep=${autoBoardingSweepEnabled ? 1 : 0} autoSettle=0 recoverable=${recoverableSats} boardingConfirmed=${boardingConfirmedSats} boardingUnconfirmed=${boardingUnconfirmedSats} expected_next=${autoPolicyExpectedNext}`,
  });
  logArkadeWalletSignTrace("wallet_summary_auto_policy", {
    status: "ok",
    auto_claim: autoClaimEnabled ? 1 : 0,
    auto_recover: autoRecoverEnabled ? 1 : 0,
    auto_boarding_sweep: autoBoardingSweepEnabled ? 1 : 0,
    auto_settle: 0,
    recoverable: recoverableSats,
    boarding_confirmed: boardingConfirmedSats,
    boarding_unconfirmed: boardingUnconfirmedSats,
    expected_next: autoPolicyExpectedNext,
  });
  // Notify listeners (receiveAutoClaim, receiveAutoSweep, receiveAutoRecover) that a fresh
  // summary is available. They decide whether/how to schedule auto-claim,
  // recoverable auto-claim, or boarding auto-sweep based on the same options
  // flags the caller passed in. Direct calls to the scheduler
  // impls would re-introduce the intra-internal cycle flagged on PR #546.
  emitArkadeWalletSummaryLoaded(out, options ?? {});

  return out;
}

async function runArkadeWalletSummaryExport(
  options?: ArkadeWalletSummaryOptions,
  startedAtMs = Date.now(),
): Promise<ArkadeWalletSummary> {
  logWalletSummaryStep("export_start", {
    watchdogMs: ARKADE_WALLET_SUMMARY_WATCHDOG_MS,
  });
  const watchdog = setInterval(() => {
    const nowMs = Date.now();
    const stageAtMs = latestWalletSummaryStageAtMs;
    logArkadeWalletSignTrace("wallet_summary_watchdog", {
      lastStage: latestWalletSummaryStage,
      lastStageAgeMs: stageAtMs > 0 ? nowMs - stageAtMs : "n/a",
      elapsedMs: nowMs - startedAtMs,
    });
  }, ARKADE_WALLET_SUMMARY_WATCHDOG_MS);

  try {
    const out = await loadArkadeWalletSummary({
      scheduleAutoClaim: false,
      scheduleAutoRecover: false,
      scheduleAutoBoardingSweep: false,
      scheduleAutoSettle: false,
      ...options,
    });
    logWalletSummaryStep("export_done", {
      elapsedMs: Date.now() - startedAtMs,
      vtxos: out.debugVtxoCount,
      total: out.balanceTotalSats,
    });
    summaryLog.event(
      `Wallet summary ready — ${group(Number(out.balanceTotalSats))} sats, ${out.debugVtxoCount} vtxos, ${Date.now() - startedAtMs}ms`,
    );
    return out;
  } catch (error: unknown) {
    const errorText = error instanceof Error ? error.message : String(error || "unknown");
    const validationFailure = isArkadeWalletValidationError(errorText);
    const transientFailure = !validationFailure && isTransientWalletSummaryErrorMessage(errorText);
    if (transientFailure) {
      lastWalletSummaryRateLimitAtMs = Date.now();
    }
    // Prefer the last non-zero summary; fall back to the last cached one (even
    // zero) — a stale-but-real snapshot beats failing the refresh outright.
    const staleFallbackSummary = lastGoodWalletSummary ?? cachedWalletSummary;
    if (transientFailure && staleFallbackSummary) {
      logWalletSummaryStep("export_transient_fallback", {
        elapsedMs: Date.now() - startedAtMs,
        lastStage: latestWalletSummaryStage,
        err: truncateForLog(errorText, 220),
        fallback: 1,
        stale: 1,
        backoffMs: WALLET_SUMMARY_RATE_LIMIT_BACKOFF_MS,
      });
      return { ...staleFallbackSummary };
    }
    const exportFailureFields = {
      elapsedMs: Date.now() - startedAtMs,
      lastStage: latestWalletSummaryStage,
      errorKind: validationFailure ? "validation" : "runtime",
      err: truncateForLog(errorText, 220),
      expected_next: transientFailure ? "retry_after_backoff" : "inspect_wallet_summary",
    };
    if (transientFailure) {
      logArkadeWalletSignTrace("wallet_summary_failed", {
        status: "transient",
        ...exportFailureFields,
      });
    } else {
      logArkadeWalletErrorTrace(
        validationFailure ? "wallet_summary_validation_failed" : "wallet_summary_failed",
        exportFailureFields,
      );
    }
    logWalletSummaryStep("export_failed", {
      elapsedMs: Date.now() - startedAtMs,
      lastStage: latestWalletSummaryStage,
      err: truncateForLog(errorText, 140),
    });
    throw error;
  } finally {
    clearInterval(watchdog);
  }
}

// Rate-limited public wrapper. Lives here (not in ArkadeWalletService) so
// internal receive-flow modules can call it without re-creating a
// prod→internal→prod cycle. The 30s rate-limit backoff defends mempool.space
// from cascading transient failures when many callers overlap.
export async function getArkadeWalletSummary(
  options?: ArkadeWalletSummaryOptions,
): Promise<ArkadeWalletSummary> {
  ensureWalletSummaryCacheKey();
  const startedAtMs = Date.now();
  // Backoff guard: if a recent call failed with a transient network/timeout
  // error, skip the network round-trip and return the last known-good summary.
  const lastRateLimitAtMs = lastWalletSummaryRateLimitAtMs;
  const sinceRateLimitMs = startedAtMs - lastRateLimitAtMs;
  const lastGood = lastGoodWalletSummary;
  if (
    lastRateLimitAtMs > 0 &&
    sinceRateLimitMs < WALLET_SUMMARY_RATE_LIMIT_BACKOFF_MS &&
    lastGood
  ) {
    logWalletSummaryStep("rate_limit_skip", {
      sinceRateLimitMs,
      backoffMs: WALLET_SUMMARY_RATE_LIMIT_BACKOFF_MS,
    });
    return { ...lastGood };
  }

  if (walletSummaryExportInFlight) {
    const inFlightAgeMs = startedAtMs - walletSummaryExportInFlightStartedAtMs;
    if (!options?.forceFresh && lastGood) {
      logWalletSummaryStep("export_inflight_skip", {
        inFlightAgeMs,
        fallback: 1,
        expected_next: "use_active_refresh_result_when_ready",
      });
      return { ...lastGood };
    }
    logWalletSummaryStep("export_inflight_join", {
      inFlightAgeMs,
      fallback: 0,
      expected_next: "share_active_wallet_summary",
    });
    return walletSummaryExportInFlight;
  }

  const run = runArkadeWalletSummaryExport(options, startedAtMs);
  walletSummaryExportInFlight = run;
  walletSummaryExportInFlightStartedAtMs = startedAtMs;
  try {
    return await run;
  } finally {
    if (walletSummaryExportInFlight === run) {
      walletSummaryExportInFlight = null;
      walletSummaryExportInFlightStartedAtMs = 0;
    }
  }
}
