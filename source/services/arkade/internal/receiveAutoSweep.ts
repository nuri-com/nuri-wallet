// Boarding sweep machinery. Background auto-sweep stays disabled; user-driven
// unlock flows may run onboarding only inside a server-approved signing scope.
import { Ramps, type ExtendedCoin, type FeeInfo } from "@arkade-os/sdk";
import { AppState } from "react-native";
import { bytesToHex } from "../../../lib/bytes";
import {
  ArkadeRemoteIdentity,
  type ArkadeBoardingSweepApprovalContext,
} from "../ArkadeRemoteIdentity";
import type { ArkadeReceiveBoardingRow } from "../ArkadeApiService";
import { getCachedWalletSummary, loadArkadeWalletSummary } from "./walletSummary";
import { addArkadeWalletSummaryListener } from "./walletSummaryEvents";
import { getCurrentArkadeWalletCacheKey, getOrCreateWallet } from "./walletCache";
import { readBoardingUtxosShared } from "./boardingUtxoCache";
import { assertArkadeRecoveryCsvCompatible } from "./recovery";
import { scriptHashForLog } from "./recoveryDefaults";
import {
  clearBoardingOutpointsBlocked,
  markBoardingOutpointsBlocked,
  partitionBlockedBoardingCandidates,
  recordBlockedBoardingAttempt,
  recordBlockedBoardingTurn,
} from "./boardingSweepBlocked";
import { getCachedBoardingSweepFailure, setBoardingSweepFailure } from "./boardingSweepFailure";
import { retryExpiredSession } from "./sessionJoinRetry";
import {
  duplicatedIntentInputs,
  isDuplicatedIntentError,
  isOrphanedIntentRegistrationRefusal,
} from "./duplicatedIntent";
import { emitTrace, logArkadeWalletSignTrace } from "./logging";
import { emitArkadeWalletSummaryAfterAutoSweep } from "./receiveAutoClaim";
import type { ArkadeWalletSummary } from "../types/wallet";
import { isArkadeBoardingClaimable, primeArkadeBoardingMinimumSats } from "./boardingMinimum";
import { truncateForLog } from "./utils";

const ARKADE_BOARDING_AUTO_SWEEP_MIN_INTERVAL_MS = 30_000;

// Deliberately off: a boarding sweep needs a server-approved signing scope, so
// it only ever runs from a user tap. That makes the unlock modal the single path
// for these funds — which is why the arkade rail carries a persistent
// pending-sweep row (see ARKADE_OPEN_UNLOCK_WALLET_EVENT): a missed or dismissed
// modal must not be the difference between swept and stranded sats.
function isArkadeBoardingAutoSweepEnabled(): boolean {
  return false;
}

// Register a top-level listener so this module schedules boarding auto-sweep
// in response to wallet-summary loads, WITHOUT walletSummary.ts importing
// back into here. The orchestrator imports scheduleArkadeBoardingAutoSweepImpl
// at app startup, which side-effect-loads this file and installs the listener
// before any wallet_summary load can fire.
addArkadeWalletSummaryListener((summary, options) => {
  if (options?.scheduleAutoBoardingSweep === true) {
    scheduleArkadeBoardingAutoSweepImpl(summary, "wallet_summary");
  }
});

let boardingAutoSweepInFlight: Promise<void> | null = null;
let lastBoardingAutoSweepAtMs = 0;
let pendingBoardingAutoSweepActiveRetry: {
  summary: ArkadeWalletSummary;
  reason: string;
  force: boolean;
} | null = null;
let boardingActiveRetrySub: { remove?: () => void } | null = null;

// SDK reach-ins through the sweep preflight. ExtendedCoin comes from
// @arkade-os/sdk.
type BoardingUtxo = ExtendedCoin & { status?: { confirmed?: boolean } };
type BoardingSweepWallet = Awaited<ReturnType<typeof getOrCreateWallet>>;

type BoardingOwnershipProof = {
  wallet: BoardingSweepWallet;
  localScriptHex: string;
  offchainScriptHex: string;
  walletScriptHexes: string[];
  allLocalUtxos: BoardingUtxo[];
  localConfirmedUtxos: BoardingUtxo[];
  /**
   * Why the local boarding-UTXO read failed, null when it succeeded. With it
   * set, `allLocalUtxos` is empty because nothing could be read — not because
   * the wallet holds nothing — so no row may be judged "not ours".
   */
  localUtxoLookupError: string | null;
  serverReadyRows: ArkadeReceiveBoardingRow[];
  matchingRows: ArkadeReceiveBoardingRow[];
  /**
   * Coins from the CACHED confirmed read that matched a sweep_ready row. Safe
   * for reporting and copy, never for selecting inputs to sign — see
   * `sweepEligibleOutpoints`.
   */
  matchingUtxos: BoardingUtxo[];
  /**
   * Outpoints of every sweep_ready row whose script is not someone else's,
   * INCLUDING rows that were still unconfirmed at the cached read. This is the
   * allow-list for reconciling against a forced-fresh read: confirmation is the
   * fresh read's call to make, not this snapshot's.
   */
  sweepEligibleOutpoints: Set<string>;
  missingLocalRows: ArkadeReceiveBoardingRow[];
  scriptMismatchRows: ArkadeReceiveBoardingRow[];
  scriptUnavailableRows: ArkadeReceiveBoardingRow[];
};

let lastBoardingOwnershipCopyLogs: string[] = [];

export function getArkadeBoardingOwnershipCopyLogs(): string[] {
  return [...lastBoardingOwnershipCopyLogs];
}

export function resetArkadeBoardingOwnershipCopyLogs(reason = "reset"): void {
  setEmptyBoardingOwnershipCopyLogs(reason);
}

function setEmptyBoardingOwnershipCopyLogs(reason: string): void {
  lastBoardingOwnershipCopyLogs = [
    [
      "boarding_sweep_ownership:",
      `reason=${reason}`,
      "server_ready=0",
      "local_total=n/a",
      "local_confirmed=n/a",
      "matched=0",
      "missing_local=0",
      "script_mismatch=0",
      "script_unavailable=0",
      "local_script=n/a",
    ].join(" "),
    "boarding_sweep_ownership_rows: server=none local=n/a matched=none stale=none",
  ];
}

// The wallet could not be built, so ownership was never checked. The support
// bundle must still state what the server reported — writing the empty variant
// here would report zero server rows while the state says sats are sweep-ready.
function setWalletUnavailableBoardingOwnershipCopyLogs(
  reason: string,
  serverRows: ArkadeReceiveBoardingRow[],
  detail: string,
): void {
  const serverReadyRows = serverRows.filter(isServerBoardingSweepReady);
  const serverReadySats = serverReadyRows.reduce(
    (sum, row) => sum + Math.max(0, Number(row?.value_sats || 0)),
    0,
  );
  lastBoardingOwnershipCopyLogs = [
    [
      "boarding_sweep_ownership:",
      `reason=${reason}`,
      "wallet=unavailable",
      `server_ready=${serverReadyRows.length}`,
      `server_ready_sats=${serverReadySats}`,
      "local_total=n/a",
      "local_confirmed=n/a",
      "matched=n/a",
      "missing_local=n/a",
      "script_mismatch=n/a",
      "script_unavailable=n/a",
      "local_script=n/a",
      `err=${detail}`,
    ].join(" "),
    `boarding_sweep_ownership_rows: server=${boardingRowSample(serverReadyRows) || "none"} local=n/a matched=none stale=none`,
  ];
}

function getArkadeBoardingSweepIdentity(wallet: unknown): ArkadeRemoteIdentity {
  const identity =
    wallet && typeof wallet === "object" && "identity" in wallet
      ? (wallet as { identity?: unknown }).identity
      : null;
  if (identity instanceof ArkadeRemoteIdentity) {
    return identity;
  }
  throw new Error("arkade remote identity unavailable for boarding sweep");
}

function formatArkadeDelay(value: unknown): string {
  try {
    const raw = BigInt(value as string | number | bigint);
    if (raw < 512n) {
      return `blocks=${raw.toString()}`;
    }
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return `seconds=${raw.toString()}`;
    }
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `seconds=${raw.toString()} (~${hours}h${minutes}m${secs}s)`;
  } catch {
    return String(value ?? "n/a");
  }
}

function summarizeBoardingCoins(coins: BoardingUtxo[], max = 260): string {
  if (!Array.isArray(coins) || coins.length === 0) {
    return "count=0";
  }
  const confirmed = coins.filter((coin) => coin?.status?.confirmed).length;
  const total = coins.reduce((sum, coin) => sum + Math.max(0, Number(coin?.value || 0)), 0);
  const first = coins
    .slice(0, 4)
    .map((coin) => {
      const txid = String(coin?.txid || "");
      const vout = Number(coin?.vout ?? 0);
      const value = Math.max(0, Number(coin?.value || 0));
      const state = coin?.status?.confirmed ? "c" : "u";
      return `${txid.slice(0, 12)}:${vout}:${value}:${state}`;
    })
    .join(",");
  return truncateForLog(
    `count=${coins.length} confirmed=${confirmed} unconfirmed=${Math.max(0, coins.length - confirmed)} total=${total}${first ? ` first=${first}` : ""}`,
    max,
  );
}

function normalizeHexValue(value: unknown): string {
  if (value instanceof Uint8Array) return bytesToHex(value).toLowerCase();
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return bytesToHex(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)).toLowerCase();
  }
  if (Array.isArray(value) && value.every((item) => Number.isInteger(Number(item)))) {
    return bytesToHex(Uint8Array.from(value.map((item) => Number(item) & 0xff))).toLowerCase();
  }
  return String(value || "")
    .trim()
    .replace(/^0x/i, "")
    .toLowerCase();
}

function normalizeTxid(value: unknown): string {
  const txid = normalizeHexValue(value);
  return /^[a-f0-9]{64}$/.test(txid) ? txid : "";
}

function outpointKey(txid: unknown, vout: unknown): string | null {
  const normalizedTxid = normalizeTxid(txid);
  const normalizedVout = Math.trunc(Number(vout));
  if (!normalizedTxid || !Number.isInteger(normalizedVout) || normalizedVout < 0) return null;
  return `${normalizedTxid}:${normalizedVout}`;
}

function boardingRowOutpoint(row: ArkadeReceiveBoardingRow): string | null {
  return outpointKey(row.txid, row.vout);
}

function boardingUtxoOutpoint(utxo: BoardingUtxo): string | null {
  return outpointKey(utxo.txid, utxo.vout);
}

// ponytail: in-memory suppression of just-swept boarding outpoints. After a
// successful sweep the server sync still reports the outpoint as sweep_ready
// (it's in mempool, not yet absent from chain), which would re-present it as
// actionable and trigger a second onboard() on an already-spent UTXO -> false
// failure. Suppress it locally until the server stops returning it.
// Ceiling: in-memory only (lost on app restart); the durable fix is a
// server-side mark-swept-by-txid route (#615 proposed direction 1).
const RECENTLY_SWEPT_OUTPOINT_TTL_MS = 15 * 60 * 1000;
const recentlySweptOutpoints = new Map<string, number>();

function pruneRecentlySweptOutpoints(nowMs: number): void {
  for (const [key, expiryMs] of recentlySweptOutpoints) {
    if (expiryMs <= nowMs) recentlySweptOutpoints.delete(key);
  }
}

function recordRecentlySweptOutpoints(utxos: BoardingUtxo[]): void {
  const expiryMs = Date.now() + RECENTLY_SWEPT_OUTPOINT_TTL_MS;
  for (const utxo of utxos) {
    const key = boardingUtxoOutpoint(utxo);
    if (key) recentlySweptOutpoints.set(key, expiryMs);
  }
}

export function isBoardingOutpointRecentlySwept(txid: unknown, vout: unknown): boolean {
  const nowMs = Date.now();
  pruneRecentlySweptOutpoints(nowMs);
  const key = outpointKey(txid, vout);
  return key ? recentlySweptOutpoints.has(key) : false;
}

function readBoardingRowScript(row: ArkadeReceiveBoardingRow): string {
  const sweep = row.sweep && typeof row.sweep === "object" ? row.sweep : null;
  return normalizeHexValue(
    row.script_pubkey ||
      row.scriptPubKey ||
      (sweep as Record<string, unknown> | null)?.script_pubkey ||
      (sweep as Record<string, unknown> | null)?.scriptPubKey,
  );
}

function readBoardingUtxoScript(utxo: BoardingUtxo): string {
  const raw = utxo as unknown as Record<string, unknown>;
  const witnessUtxo =
    raw.witnessUtxo && typeof raw.witnessUtxo === "object"
      ? (raw.witnessUtxo as Record<string, unknown>)
      : null;
  return normalizeHexValue(
    raw.script_pubkey || raw.scriptPubKey || raw.pkScript || raw.script || witnessUtxo?.script,
  );
}

function readWalletBoardingScript(wallet: BoardingSweepWallet): string {
  const rawWallet = wallet as unknown as { boardingTapscript?: { pkScript?: unknown } };
  return normalizeHexValue(rawWallet.boardingTapscript?.pkScript);
}

function readWalletOffchainScript(wallet: BoardingSweepWallet): string {
  const rawWallet = wallet as unknown as {
    defaultContractScript?: unknown;
    offchainTapscript?: { pkScript?: unknown };
  };
  return normalizeHexValue(
    rawWallet.defaultContractScript || rawWallet.offchainTapscript?.pkScript,
  );
}

async function readWalletScriptHexes(
  wallet: BoardingSweepWallet,
  fallbackScriptHex: string,
): Promise<string[]> {
  const rawWallet = wallet as unknown as { getWalletScripts?: () => Promise<unknown[]> };
  const scripts = await rawWallet.getWalletScripts?.().catch((): unknown[] => []);
  const normalized = (Array.isArray(scripts) ? scripts : [])
    .map(normalizeHexValue)
    .filter((script) => script.length > 0);
  if (normalized.length > 0) return Array.from(new Set(normalized));
  return fallbackScriptHex ? [fallbackScriptHex] : [];
}

function isServerBoardingSweepReady(row: ArkadeReceiveBoardingRow): boolean {
  const sweep = row.sweep && typeof row.sweep === "object" ? row.sweep : null;
  const nestedStatus = String((sweep as Record<string, unknown> | null)?.status || "")
    .trim()
    .toLowerCase();
  const directStatus = String(row.status || "")
    .trim()
    .toLowerCase();
  return (nestedStatus || directStatus) === "sweep_ready";
}

function boardingRowSample(rows: ArkadeReceiveBoardingRow[], max = 6): string {
  return rows
    .slice(0, max)
    .map((row) => {
      const key = boardingRowOutpoint(row) || "n/a";
      const script = readBoardingRowScript(row);
      const sweep = row.sweep && typeof row.sweep === "object" ? row.sweep : null;
      const sats = Math.max(
        0,
        Math.trunc(
          Number(row.value_sats || (sweep as Record<string, unknown> | null)?.value_sats || 0),
        ),
      );
      return `${key}:${sats}:${scriptHashForLog(script)}`;
    })
    .join(",");
}

function boardingUtxoSample(rows: BoardingUtxo[], fallbackScriptHex = "", max = 6): string {
  return rows
    .slice(0, max)
    .map((utxo) => {
      const key = boardingUtxoOutpoint(utxo) || "n/a";
      const value = Math.max(0, Math.trunc(Number(utxo.value || 0)));
      const script = readBoardingUtxoScript(utxo) || fallbackScriptHex;
      return `${key}:${value}:${scriptHashForLog(script)}`;
    })
    .join(",");
}

function setBoardingOwnershipCopyLogs(proof: BoardingOwnershipProof, reason: string): void {
  const staleRows = [...proof.missingLocalRows, ...proof.scriptMismatchRows];
  const walletScriptHashes = proof.walletScriptHexes.map(scriptHashForLog).join(",") || "none";
  lastBoardingOwnershipCopyLogs = [
    [
      "boarding_sweep_ownership:",
      `reason=${reason}`,
      `server_ready=${proof.serverReadyRows.length}`,
      `local_total=${proof.allLocalUtxos.length}`,
      `local_confirmed=${proof.localConfirmedUtxos.length}`,
      `matched=${proof.matchingRows.length}`,
      `missing_local=${proof.missingLocalRows.length}`,
      `script_mismatch=${proof.scriptMismatchRows.length}`,
      `script_unavailable=${proof.scriptUnavailableRows.length}`,
      `local_script=${scriptHashForLog(proof.localScriptHex)}`,
      `boarding_script=${scriptHashForLog(proof.localScriptHex)}`,
      `offchain_script=${scriptHashForLog(proof.offchainScriptHex)}`,
      `wallet_scripts=${walletScriptHashes}`,
    ].join(" "),
    [
      "boarding_sweep_ownership_rows:",
      `server=${boardingRowSample(proof.serverReadyRows) || "none"}`,
      `local=${boardingUtxoSample(proof.localConfirmedUtxos, proof.localScriptHex) || "none"}`,
      `matched=${boardingRowSample(proof.matchingRows) || "none"}`,
      `stale=${boardingRowSample(staleRows) || "none"}`,
    ].join(" "),
  ];
}

function extractRejectedScriptHex(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "");
  const match = message.match(/\bscript\s+([0-9a-fA-F]{20,})\b/);
  return normalizeHexValue(match?.[1] || "");
}

function buildBoardingSweepErrorScriptCopyLog(
  error: unknown,
  proof: BoardingOwnershipProof | null,
): string {
  const rejectedScriptHex = extractRejectedScriptHex(error);
  const rejectedHash = scriptHashForLog(rejectedScriptHex);
  const boardingScriptHex = proof?.localScriptHex || "";
  const offchainScriptHex = proof?.offchainScriptHex || "";
  const walletScriptHexes = proof?.walletScriptHexes || [];
  const walletHasScript = rejectedScriptHex
    ? walletScriptHexes.some((script) => script === rejectedScriptHex)
    : false;
  return [
    "boarding_sweep_error_script:",
    `rejected_script=${rejectedHash}`,
    `matches_boarding=${rejectedScriptHex && rejectedScriptHex === boardingScriptHex ? 1 : 0}`,
    `matches_offchain=${rejectedScriptHex && rejectedScriptHex === offchainScriptHex ? 1 : 0}`,
    `wallet_has_script=${walletHasScript ? 1 : 0}`,
    `boarding_script=${scriptHashForLog(boardingScriptHex)}`,
    `offchain_script=${scriptHashForLog(offchainScriptHex)}`,
    `wallet_scripts=${walletScriptHexes.map(scriptHashForLog).join(",") || "none"}`,
  ].join(" ");
}

function buildBoardingSweepRegistrationCopyLog(proof: BoardingOwnershipProof): string {
  const walletHasBoarding = proof.walletScriptHexes.includes(proof.localScriptHex);
  return [
    "boarding_sweep_registration:",
    `boarding_script=${scriptHashForLog(proof.localScriptHex)}`,
    `offchain_script=${scriptHashForLog(proof.offchainScriptHex)}`,
    `wallet_scripts=${proof.walletScriptHexes.map(scriptHashForLog).join(",") || "none"}`,
    `wallet_has_boarding=${walletHasBoarding ? 1 : 0}`,
  ].join(" ");
}

async function buildBoardingOwnershipProof(
  serverRows: ArkadeReceiveBoardingRow[] | null | undefined,
  reason: string,
): Promise<BoardingOwnershipProof> {
  const wallet = await getOrCreateWallet();
  const walletExt = wallet as unknown as {
    getBoardingUtxos: () => Promise<BoardingUtxo[]>;
  };
  // A failed UTXO read is NOT an empty wallet. Collapsing the two is what let a
  // node/SDK timeout look like "this wallet owns none of the server's rows",
  // which drops every sweep_ready row and takes the modal down with it.
  let localUtxoLookupError: string | null = null;
  // Shared with the wallet summary that runs in the SAME monitor pass: this read
  // is 1 Esplora request per boarding address, and doing it twice per tick is
  // what pushed the app into mempool.space's per-IP rate limit.
  const allLocalUtxos = await readBoardingUtxosShared<BoardingUtxo>(
    walletExt,
    getCurrentArkadeWalletCacheKey(),
    { reason },
  ).catch((error: unknown): BoardingUtxo[] => {
    localUtxoLookupError = truncateForLog(
      error instanceof Error ? error.message : String(error || "unknown"),
      180,
    );
    return [];
  });
  const localConfirmedUtxos = allLocalUtxos.filter((utxo) => utxo?.status?.confirmed);
  const localScriptHex = readWalletBoardingScript(wallet);
  const offchainScriptHex = readWalletOffchainScript(wallet);
  const walletScriptHexes = await readWalletScriptHexes(wallet, offchainScriptHex);
  const serverReadyRows = (Array.isArray(serverRows) ? serverRows : []).filter(
    isServerBoardingSweepReady,
  );
  const matchingRows: ArkadeReceiveBoardingRow[] = [];
  const matchingUtxos: BoardingUtxo[] = [];
  const sweepEligibleOutpoints = new Set<string>();
  const missingLocalRows: ArkadeReceiveBoardingRow[] = [];
  const scriptMismatchRows: ArkadeReceiveBoardingRow[] = [];
  const scriptUnavailableRows: ArkadeReceiveBoardingRow[] = [];

  if (serverReadyRows.length > 0) {
    const localByOutpoint = new Map<string, BoardingUtxo>();
    for (const utxo of localConfirmedUtxos) {
      const key = boardingUtxoOutpoint(utxo);
      if (key && !localByOutpoint.has(key)) localByOutpoint.set(key, utxo);
    }

    const matchedKeys = new Set<string>();
    for (const row of serverReadyRows) {
      const key = boardingRowOutpoint(row);
      const local = key ? localByOutpoint.get(key) : null;
      const serverScript = readBoardingRowScript(row);
      // Judge the script BEFORE the missing-local branch: a row can be absent
      // from the cached confirmed set simply because it was still unconfirmed
      // when that read happened, and it must remain sweep-eligible if it has
      // since confirmed. Falling back to the wallet's own boarding script keeps
      // this decidable without a local coin.
      const localScript = (local ? readBoardingUtxoScript(local) : null) || localScriptHex;
      const scriptMismatch = Boolean(serverScript && localScript && serverScript !== localScript);
      if (key && !scriptMismatch) {
        // The allow-list the sweep reconciles its forced-fresh read against.
        // Membership means "the server says this outpoint is sweep_ready and its
        // script is not someone else's" — NOT "it was confirmed as of the cached
        // read". Ownership is still proven at selection time, because the fresh
        // read only ever returns this wallet's own boarding UTXOs.
        sweepEligibleOutpoints.add(key);
      }
      if (!key || !local) {
        missingLocalRows.push(row);
        continue;
      }

      if (scriptMismatch) {
        scriptMismatchRows.push(row);
        continue;
      }
      if (serverScript && !localScript) {
        scriptUnavailableRows.push(row);
      }
      if (!matchedKeys.has(key)) {
        matchedKeys.add(key);
        matchingRows.push(row);
        matchingUtxos.push(local);
      }
    }
  }

  const staleCount = missingLocalRows.length + scriptMismatchRows.length;
  logArkadeWalletSignTrace("arkade_boarding_sweep_ownership_proof", {
    status: staleCount > 0 ? "stale_server_rows" : "ok",
    reason,
    server_ready: serverReadyRows.length,
    local_confirmed: localConfirmedUtxos.length,
    matched: matchingRows.length,
    missing_local: missingLocalRows.length,
    script_mismatch: scriptMismatchRows.length,
    script_unavailable: scriptUnavailableRows.length,
    local_script: scriptHashForLog(localScriptHex),
    boarding_script: scriptHashForLog(localScriptHex),
    offchain_script: scriptHashForLog(offchainScriptHex),
    wallet_scripts: walletScriptHexes.map(scriptHashForLog).join(",") || "none",
    stale_rows: boardingRowSample([...missingLocalRows, ...scriptMismatchRows]),
    expected_next: matchingRows.length > 0 ? "sweep_local_matches_only" : "skip_not_wallet_script",
  });
  emitTrace({
    atMs: Date.now(),
    op: "arkade_boarding_sweep_ownership_proof",
    status: staleCount > 0 ? "stale_server_rows" : "ok",
    detail: truncateForLog(
      `reason=${reason} server_ready=${serverReadyRows.length} local_confirmed=${localConfirmedUtxos.length} matched=${matchingRows.length} missing_local=${missingLocalRows.length} script_mismatch=${scriptMismatchRows.length} script_unavailable=${scriptUnavailableRows.length} boarding_script=${scriptHashForLog(localScriptHex)} offchain_script=${scriptHashForLog(offchainScriptHex)} wallet_scripts=${walletScriptHexes.map(scriptHashForLog).join(",") || "none"} stale=${boardingRowSample([...missingLocalRows, ...scriptMismatchRows]) || "none"}`,
      320,
    ),
  });

  const proof = {
    wallet,
    localScriptHex,
    offchainScriptHex,
    walletScriptHexes,
    allLocalUtxos,
    localConfirmedUtxos,
    localUtxoLookupError: localUtxoLookupError as string | null,
    serverReadyRows,
    matchingRows,
    matchingUtxos,
    sweepEligibleOutpoints,
    missingLocalRows,
    scriptMismatchRows,
    scriptUnavailableRows,
  };
  setBoardingOwnershipCopyLogs(proof, reason);
  return proof;
}

/**
 * Boarding rows narrowed to the ones this wallet can actually sweep, plus
 * whether that narrowing could be performed at all. `walletUnavailable` means
 * the local wallet could not be built, so ownership was never checked and the
 * rows are the server's unverified view — the caller must keep them visible
 * (funds are waiting) instead of reading an empty list as "nothing to do".
 */
export type ArkadeBoardingRowFilterResult = {
  rows: ArkadeReceiveBoardingRow[];
  walletUnavailable: boolean;
  walletError: string | null;
};

export async function filterArkadeBoardingRowsForCurrentWallet(
  serverRows: ArkadeReceiveBoardingRow[],
  reason = "boarding_unlock_state",
): Promise<ArkadeBoardingRowFilterResult> {
  if (!Array.isArray(serverRows) || serverRows.length === 0) {
    setEmptyBoardingOwnershipCopyLogs(reason);
    return { rows: [], walletUnavailable: false, walletError: null };
  }
  let proof: BoardingOwnershipProof;
  try {
    proof = await buildBoardingOwnershipProof(serverRows, reason);
  } catch (error: unknown) {
    // The wallet could not be built (SDK construction, node timeout, missing
    // signer). The server's sweep_ready rows are the only record that funds are
    // waiting, and dropping them here is what strands them: the sweep is
    // client-only, so a row that never reaches the UI never gets a retry tap.
    const detail = truncateForLog(
      error instanceof Error ? error.message : String(error || "unknown"),
      180,
    );
    const serverReady = serverRows.filter(isServerBoardingSweepReady).length;
    logArkadeWalletSignTrace("arkade_boarding_sweep_ownership_proof", {
      status: "wallet_unavailable",
      reason,
      server_ready: serverReady,
      err: detail,
      expected_next: "keep_server_rows_actionable_for_retry",
    });
    emitTrace({
      atMs: Date.now(),
      op: "arkade_boarding_sweep_ownership_proof",
      status: "wallet_unavailable",
      detail: truncateForLog(
        `reason=${reason} server_ready=${serverReady} err=${detail} kept=${serverRows.length}`,
        260,
      ),
    });
    setWalletUnavailableBoardingOwnershipCopyLogs(
      `${reason}_wallet_unavailable`,
      serverRows,
      detail,
    );
    return {
      rows: serverRows.map((row) => ({ ...row })),
      walletUnavailable: true,
      walletError: detail,
    };
  }
  if (proof.localUtxoLookupError) {
    // The wallet was built, but its boarding UTXOs could not be read, so
    // `matchingRows` is empty for want of anything to match against. Filtering
    // on it would drop every sweep_ready row on a node timeout — the same
    // no-actionable-work state, reached by a different door.
    const serverReady = serverRows.filter(isServerBoardingSweepReady).length;
    logArkadeWalletSignTrace("arkade_boarding_sweep_ownership_proof", {
      status: "local_utxo_lookup_failed",
      reason,
      server_ready: serverReady,
      err: proof.localUtxoLookupError,
      expected_next: "keep_server_rows_actionable_for_retry",
    });
    emitTrace({
      atMs: Date.now(),
      op: "arkade_boarding_sweep_ownership_proof",
      status: "local_utxo_lookup_failed",
      detail: truncateForLog(
        `reason=${reason} server_ready=${serverReady} err=${proof.localUtxoLookupError} kept=${serverRows.length}`,
        260,
      ),
    });
    setWalletUnavailableBoardingOwnershipCopyLogs(
      `${reason}_local_utxo_lookup_failed`,
      serverRows,
      proof.localUtxoLookupError,
    );
    return {
      rows: serverRows.map((row) => ({ ...row })),
      walletUnavailable: true,
      walletError: proof.localUtxoLookupError,
    };
  }
  const matchedKeys = new Set(proof.matchingRows.map((row) => boardingRowOutpoint(row)));
  return {
    rows: serverRows.filter((row) => {
      if (!isServerBoardingSweepReady(row)) return true;
      return matchedKeys.has(boardingRowOutpoint(row));
    }),
    walletUnavailable: false,
    walletError: null,
  };
}

function getBoardingSelectionSnapshot(coins: BoardingUtxo[]): {
  count: number;
  confirmedCount: number;
  unconfirmedCount: number;
  totalSats: number;
  allConfirmed: boolean;
  outpointsText: string;
  txids: string[];
  txidsText: string;
  outpoints: string[];
} {
  if (!Array.isArray(coins) || coins.length === 0) {
    return {
      count: 0,
      confirmedCount: 0,
      unconfirmedCount: 0,
      totalSats: 0,
      allConfirmed: false,
      outpointsText: "n/a",
      outpoints: [],
      txids: [],
      txidsText: "n/a",
    };
  }
  const confirmedCount = coins.filter((coin) => coin?.status?.confirmed).length;
  const unconfirmedCount = Math.max(0, coins.length - confirmedCount);
  const totalSats = coins.reduce((sum, coin) => sum + Math.max(0, Number(coin?.value || 0)), 0);
  const txids = Array.from(
    new Set(
      coins
        .map((coin) =>
          String(coin?.txid || "")
            .trim()
            .toLowerCase(),
        )
        .filter((txid) => /^[a-f0-9]{64}$/i.test(txid)),
    ),
  );
  const outpoints = coins
    .map((coin) => {
      const txid = String(coin?.txid || "")
        .trim()
        .toLowerCase();
      const vout = Math.max(0, Math.trunc(Number(coin?.vout ?? 0)));
      const value = Math.max(0, Math.trunc(Number(coin?.value || 0)));
      return /^[a-f0-9]{64}$/i.test(txid) ? `${txid}:${vout}:${value}` : "";
    })
    .filter(Boolean)
    .sort();
  const outpointsText = outpoints.join(",");
  return {
    count: coins.length,
    confirmedCount,
    unconfirmedCount,
    totalSats,
    allConfirmed: coins.length > 0 && unconfirmedCount === 0,
    outpointsText: outpointsText || "n/a",
    outpoints,
    txids,
    txidsText: txids.length > 0 ? txids.slice(0, 6).join(",") : "n/a",
  };
}

function selectSingleBoardingUtxoForSweep(coins: BoardingUtxo[]): BoardingUtxo[] {
  const candidates = (Array.isArray(coins) ? coins : []).filter(
    (coin) => coin?.status?.confirmed && isArkadeBoardingClaimable(coin.value),
  );
  if (candidates.length === 0) return [];
  return [
    [...candidates].sort((a, b) => {
      const aKey = boardingUtxoOutpoint(a) || "";
      const bKey = boardingUtxoOutpoint(b) || "";
      if (aKey !== bKey) return aKey.localeCompare(bKey);
      return Number(a?.value || 0) - Number(b?.value || 0);
    })[0],
  ];
}

/**
 * The one boarding sweep allowed to be in flight, process-wide.
 *
 * Every caller funnels through `sweepArkadeBoardingToOffchain`, but they each
 * used to hold their OWN in-flight flag (auto-sweep, recovery lab, and the
 * unlock modal with none at all), so a summary-driven sweep and a user-driven
 * unlock could sign two different intents over the same boarding UTXO seconds
 * apart. The server registers the first and rejects the second with
 * `duplicated input … already registered by another intent`, and the loser
 * cannot clean up after itself because its deletion proof does not match the
 * registered intent — so the intent lingers and the sats stay stuck.
 */
let boardingSweepInFlight: Promise<string> | null = null;

export function sweepArkadeBoardingToOffchain(
  serverRows?: ArkadeReceiveBoardingRow[],
  options?: { appendLog?: (line: string) => void },
): Promise<string> {
  if (boardingSweepInFlight) {
    logArkadeWalletSignTrace("arkade_boarding_sweep_single_flight", {
      status: "join_existing",
      // Joining rather than rejecting: the caller asked for the sweep to
      // happen, and one is happening. Its result is theirs too.
      expected_next: "await_in_flight_sweep",
    });
    return boardingSweepInFlight;
  }
  const run = runArkadeBoardingSweep(serverRows, options).finally(() => {
    if (boardingSweepInFlight === run) boardingSweepInFlight = null;
  });
  boardingSweepInFlight = run;
  return run;
}

async function runArkadeBoardingSweep(
  serverRows?: ArkadeReceiveBoardingRow[],
  options?: { appendLog?: (line: string) => void },
): Promise<string> {
  const ownershipProof = Array.isArray(serverRows)
    ? await buildBoardingOwnershipProof(serverRows, "boarding_sweep")
    : null;
  if (ownershipProof && options?.appendLog) {
    for (const line of getArkadeBoardingOwnershipCopyLogs()) options.appendLog(line);
  }
  // Nothing could be read about this wallet's boarding UTXOs, so there is no
  // selection to make. Throwing keeps it a failure the caller reports and the
  // user can retry; carrying on would select nothing and return
  // "pending_unconfirmed", which reads as a successful no-op.
  if (ownershipProof?.localUtxoLookupError && ownershipProof.serverReadyRows.length > 0) {
    throw new Error(`boarding utxo lookup failed: ${ownershipProof.localUtxoLookupError}`);
  }
  const wallet = ownershipProof?.wallet || (await getOrCreateWallet());
  await assertArkadeRecoveryCsvCompatible(wallet, "arkade_boarding_sweep");
  let summarySource = "live";
  // Pre-sweep: caller has just decided to sweep and needs an accurate
  // confirmed-boarding count. Use the bare loader (bypasses the 30s
  // rate-limit backoff) because the user-driven sweep can't proceed without
  // a fresh number; on failure we fall back to the cached snapshot.
  const summary = await loadArkadeWalletSummary({
    scheduleAutoClaim: false,
    scheduleAutoBoardingSweep: false,
  }).catch(() => {
    summarySource = "cached";
    return getCachedWalletSummary();
  });
  const walletExt = wallet as unknown as {
    arkProvider?: {
      getInfo?: () => Promise<{
        fees?: FeeInfo;
        boardingExitDelay?: unknown;
        unilateralExitDelay?: unknown;
        /** The floor this node applies to a boarding UTXO. */
        utxoMinAmount?: number | string | bigint;
      } | null>;
    };
    getBoardingUtxos: () => Promise<BoardingUtxo[]>;
  };
  const providerInfo = await walletExt?.arkProvider?.getInfo?.().catch((): null => null);
  // Same response carries the floor this node applies to a boarding UTXO: cache
  // it before anything selects candidates, so the selection matches the node
  // being swept rather than a snapshot of mainnet.
  primeArkadeBoardingMinimumSats(providerInfo);
  const feeInfo = providerInfo?.fees;
  // forceFresh: this read feeds the transaction that is about to be SIGNED, so
  // it must never come from the shared cache. A stale row here would build a
  // sweep over an outpoint that has already moved.
  const allBoardingUtxos: BoardingUtxo[] = await readBoardingUtxosShared<BoardingUtxo>(
    walletExt,
    getCurrentArkadeWalletCacheKey(),
    { forceFresh: true, reason: "boarding_sweep" },
  ).catch((): BoardingUtxo[] => []);
  const allBoardingSelection = getBoardingSelectionSnapshot(allBoardingUtxos);
  // Candidates must come from the forced-fresh read, ALWAYS. The ownership proof
  // decides WHICH outpoints this wallet may sweep (its server-row matching is
  // the thing that cannot be re-derived here), but its `matchingUtxos` objects
  // may be up to BOARDING_UTXO_CACHE_TTL_MS old — so selecting them directly
  // could sign over an outpoint that has since been spent, or skip one that has
  // since confirmed. Intersect instead: the proof supplies the allow-list of
  // outpoints, the fresh read supplies the coins.
  const freshConfirmed = allBoardingUtxos.filter((utxo) => utxo?.status?.confirmed);
  let confirmedBoardingCandidates: BoardingUtxo[];
  if (ownershipProof) {
    // `sweepEligibleOutpoints`, NOT `matchingUtxos`: the latter is built from the
    // cached CONFIRMED set, so a row that was unconfirmed at that read and has
    // since confirmed would be missing from it and the fresh coin would be
    // filtered right back out — the sweep would report no candidate while the
    // funds sit there. The eligible set carries every sweep_ready outpoint whose
    // script is ours, and the fresh read decides confirmation.
    const ownedOutpoints = ownershipProof.sweepEligibleOutpoints;
    confirmedBoardingCandidates = freshConfirmed.filter((utxo) => {
      const key = boardingUtxoOutpoint(utxo);
      return Boolean(key) && ownedOutpoints.has(key as string);
    });
    logArkadeWalletSignTrace("arkade_boarding_sweep_candidate_reconcile", {
      proof_matched: ownershipProof.matchingUtxos.length,
      eligible_outpoints: ownedOutpoints.size,
      fresh_confirmed: freshConfirmed.length,
      candidates: confirmedBoardingCandidates.length,
      // An eligible outpoint the fresh read no longer returns was spent or
      // reorged out between the two reads; dropping it is the point of
      // reconciling.
      dropped_since_proof: ownedOutpoints.size - confirmedBoardingCandidates.length,
      // Confirmed in the fresh read but absent from the cached proof match: the
      // unconfirmed→confirmed transition this reconciliation exists to keep.
      newly_confirmed: Math.max(
        0,
        confirmedBoardingCandidates.length - ownershipProof.matchingUtxos.length,
      ),
      expected_next: "select_single_boarding_utxo",
    });
  } else {
    confirmedBoardingCandidates = freshConfirmed;
  }
  const candidateSelection = getBoardingSelectionSnapshot(confirmedBoardingCandidates);
  // Prefer candidates the ASP has not refused an intent over. See
  // boardingSweepBlocked.ts: without this the lowest outpoint is re-selected
  // forever, so one stuck coin hides every later deposit.
  // Only claimable coins count as candidates. Selection drops dust, so leaving
  // dust in this list would make it an "available" (unblocked) candidate, which
  // suppresses the all-blocked fallback and stops us retrying a claimable coin
  // the ASP has already released. Dust is not a sweep candidate either way.
  const claimableBoardingCandidates = confirmedBoardingCandidates.filter((utxo) =>
    isArkadeBoardingClaimable(utxo?.value),
  );
  const { candidates: sweepableBoardingUtxos, skipped: blockedSkippedOutpoints } =
    partitionBlockedBoardingCandidates(claimableBoardingCandidates, boardingUtxoOutpoint);
  if (blockedSkippedOutpoints.length > 0) {
    logArkadeWalletSignTrace("arkade_boarding_sweep_blocked_skip", {
      status: "skipped",
      candidate_count: candidateSelection.count,
      skipped_count: blockedSkippedOutpoints.length,
      skipped_outpoints: blockedSkippedOutpoints.join(","),
      remaining_count: sweepableBoardingUtxos.length,
      expected_next: "select_single_boarding_utxo",
    });
  }
  const selectedBoardingUtxos = selectSingleBoardingUtxoForSweep(sweepableBoardingUtxos);
  // The coin takes its turn here. A turn is consumed even when this attempt dies
  // in preflight, so the next attempt rotates onto another coin instead of
  // retrying this one forever. The ASP-attempt count is recorded separately, at
  // the settle call, because only that says anything about the registration.
  const selectedBoardingKey =
    selectedBoardingUtxos.map((utxo) => boardingUtxoOutpoint(utxo)).find((key) => Boolean(key)) ||
    null;
  recordBlockedBoardingTurn(selectedBoardingKey);
  const boardingSelection = getBoardingSelectionSnapshot(selectedBoardingUtxos);
  const previousFailure = getCachedBoardingSweepFailure();
  if (
    previousFailure &&
    boardingSelection.count > 0 &&
    previousFailure.selectedOutpointsText === boardingSelection.outpointsText &&
    previousFailure.selectedTotalSats === boardingSelection.totalSats
  ) {
    logArkadeWalletSignTrace("arkade_boarding_sweep_previous_failure", {
      status: "manual_retry_allowed",
      candidate_count: candidateSelection.count,
      candidate_total: candidateSelection.totalSats,
      selected_count: boardingSelection.count,
      selected_total: boardingSelection.totalSats,
      selected_txids: boardingSelection.txidsText,
      err: truncateForLog(previousFailure.detail, 140),
      expected_next: "user_tap_retries_with_server_approval",
    });
    emitTrace({
      atMs: Date.now(),
      op: "arkade_boarding_sweep",
      status: "retry",
      detail: truncateForLog(
        `arkade=1 reason=previous_failure_manual_retry mode=single_boarding_utxo_per_attempt candidate_count=${candidateSelection.count} candidate_total=${candidateSelection.totalSats} selected_count=${boardingSelection.count} selected_total=${boardingSelection.totalSats} selected_txids=${boardingSelection.txidsText} err=${previousFailure.detail}`,
        260,
      ),
    });
  }
  setBoardingSweepFailure(null, "boarding_sweep_attempt");
  emitTrace({
    atMs: Date.now(),
    op: "arkade_boarding_sweep",
    status: "attempt",
    detail: `arkade=1 summary=${summary ? summarySource : "none"} amount=${summary?.balanceBoardingTotalSats || "n/a"} recipient=${summary?.arkAddress || "n/a"} mode=single_boarding_utxo_per_attempt fee_info=${feeInfo ? 1 : 0}`,
  });
  logArkadeWalletSignTrace("arkade_boarding_sweep_preflight", {
    status: "ok",
    confirmation_gate: "single_confirmed_boarding_only",
    candidate_count: candidateSelection.count,
    candidate_confirmed: candidateSelection.confirmedCount,
    candidate_total: candidateSelection.totalSats,
    candidate_txids: candidateSelection.txidsText,
    selected_count: boardingSelection.count,
    selected_confirmed: boardingSelection.confirmedCount,
    selected_unconfirmed: boardingSelection.unconfirmedCount,
    selected_total: boardingSelection.totalSats,
    all_count: allBoardingSelection.count,
    all_confirmed: allBoardingSelection.confirmedCount,
    all_unconfirmed: allBoardingSelection.unconfirmedCount,
    selected_txids: boardingSelection.txidsText,
    all_txids: allBoardingSelection.txidsText,
    expected_next:
      boardingSelection.count > 0
        ? "sign_single_confirmed_boarding_onboard"
        : "wait_for_bitcoin_confirmation",
  });
  emitTrace({
    atMs: Date.now(),
    op: "arkade_boarding_sweep_preflight",
    status: "ok",
    detail: truncateForLog(
      `arkade=1 mode=single_boarding_utxo_per_attempt candidate_count=${candidateSelection.count} candidate_confirmed=${candidateSelection.confirmedCount} candidate_total=${candidateSelection.totalSats} candidate_txids=${candidateSelection.txidsText} selected_count=${boardingSelection.count} selected_confirmed=${boardingSelection.confirmedCount} selected_unconfirmed=${boardingSelection.unconfirmedCount} selected_all_confirmed=${boardingSelection.allConfirmed ? 1 : 0} selected_txids=${boardingSelection.txidsText} selected_total=${boardingSelection.totalSats} all_count=${allBoardingSelection.count} all_confirmed=${allBoardingSelection.confirmedCount} all_unconfirmed=${allBoardingSelection.unconfirmedCount} all_txids=${allBoardingSelection.txidsText} boarding=${summarizeBoardingCoins(allBoardingUtxos, 120)} boardingExitDelay=${formatArkadeDelay(providerInfo?.boardingExitDelay ?? "n/a")} unilateralExitDelay=${formatArkadeDelay(providerInfo?.unilateralExitDelay ?? "n/a")} ignoredVtxos=${summary?.debugVtxoCount ?? "n/a"} ignoredPreconfirmed=${summary?.balancePreconfirmedSats ?? "n/a"} ignoredRecoverable=${summary?.balanceRecoverableSats ?? "n/a"}`,
      340,
    ),
  });
  if (boardingSelection.count === 0) {
    const staleCount = ownershipProof
      ? ownershipProof.missingLocalRows.length + ownershipProof.scriptMismatchRows.length
      : 0;
    logArkadeWalletSignTrace("arkade_boarding_sweep_skip", {
      status: staleCount > 0 ? "not_wallet_script" : "pending_unconfirmed",
      server_ready: ownershipProof?.serverReadyRows.length ?? "n/a",
      stale_server_rows: staleCount,
      all_count: allBoardingSelection.count,
      all_confirmed: allBoardingSelection.confirmedCount,
      all_unconfirmed: allBoardingSelection.unconfirmedCount,
      all_txids: allBoardingSelection.txidsText,
      expected_next:
        staleCount > 0 ? "do_not_attempt_stale_boarding_sweep" : "wait_for_bitcoin_confirmation",
    });
    emitTrace({
      atMs: Date.now(),
      op: "arkade_boarding_sweep",
      status: "skip",
      detail: truncateForLog(
        staleCount > 0
          ? `arkade=1 reason=not_wallet_script server_ready=${ownershipProof?.serverReadyRows.length ?? 0} stale_server_rows=${staleCount} matched=0 stale=${boardingRowSample([...(ownershipProof?.missingLocalRows || []), ...(ownershipProof?.scriptMismatchRows || [])]) || "none"}`
          : `arkade=1 reason=no_confirmed_boarding_inputs all_count=${allBoardingSelection.count} all_confirmed=${allBoardingSelection.confirmedCount} all_unconfirmed=${allBoardingSelection.unconfirmedCount} all_txids=${allBoardingSelection.txidsText}`,
        260,
      ),
    });
    return staleCount > 0 ? "not_wallet_script" : "pending_unconfirmed";
  }
  if (!feeInfo) {
    logArkadeWalletSignTrace("arkade_boarding_sweep_signing_gate", {
      status: "blocked",
      confirmation_gate: "passed",
      candidate_count: candidateSelection.count,
      candidate_total: candidateSelection.totalSats,
      selected_count: boardingSelection.count,
      selected_confirmed: boardingSelection.confirmedCount,
      selected_unconfirmed: boardingSelection.unconfirmedCount,
      selected_total: boardingSelection.totalSats,
      expected_next: "retry_after_arkade_fee_info_available",
    });
    emitTrace({
      atMs: Date.now(),
      op: "arkade_boarding_sweep_signing_gate",
      status: "blocked",
      detail: `arkade=1 reason=fee_info_missing mode=single_boarding_utxo_per_attempt candidate_count=${candidateSelection.count} candidate_total=${candidateSelection.totalSats} selected_count=${boardingSelection.count} selected_total=${boardingSelection.totalSats}`,
    });
    throw new Error("arkade boarding sweep fee info unavailable");
  }
  if (
    ownershipProof?.localScriptHex &&
    !ownershipProof.walletScriptHexes.includes(ownershipProof.localScriptHex)
  ) {
    const detail = buildBoardingSweepRegistrationCopyLog(ownershipProof);
    options?.appendLog?.(detail);
    logArkadeWalletSignTrace("arkade_boarding_sweep_signing_gate", {
      status: "blocked",
      reason: "boarding_script_not_registered",
      boarding_script: scriptHashForLog(ownershipProof.localScriptHex),
      wallet_scripts: ownershipProof.walletScriptHexes.map(scriptHashForLog).join(",") || "none",
      expected_next: "install_boarding_recovery_script_before_onboard",
    });
    emitTrace({
      atMs: Date.now(),
      op: "arkade_boarding_sweep_signing_gate",
      status: "blocked",
      detail,
    });
    throw new Error("boarding recovery script is not registered in wallet scripts");
  }

  const approvalContext: ArkadeBoardingSweepApprovalContext = {
    selectedOutpoints: boardingSelection.outpoints,
    selectedTotalSats: boardingSelection.totalSats,
  };
  const identity = getArkadeBoardingSweepIdentity(wallet);
  logArkadeWalletSignTrace("arkade_boarding_sweep_signing_gate", {
    status: "approval_required",
    confirmation_gate: "passed",
    mode: "single_boarding_utxo_per_attempt",
    candidate_count: candidateSelection.count,
    candidate_total: candidateSelection.totalSats,
    selected_count: boardingSelection.count,
    selected_confirmed: boardingSelection.confirmedCount,
    selected_unconfirmed: boardingSelection.unconfirmedCount,
    selected_total: boardingSelection.totalSats,
    expected_next: "boarding_sweep_approve_start",
  });
  emitTrace({
    atMs: Date.now(),
    op: "arkade_boarding_sweep_signing_gate",
    status: "approval_required",
    detail: `arkade=1 summary=${summary ? summarySource : "none"} mode=single_boarding_utxo_per_attempt confirmation_gate=passed candidate_count=${candidateSelection.count} candidate_total=${candidateSelection.totalSats} selected_count=${boardingSelection.count} selected_confirmed=${boardingSelection.confirmedCount} selected_unconfirmed=${boardingSelection.unconfirmedCount} selected_total=${boardingSelection.totalSats} expected_next=boarding_sweep_approve_start`,
  });
  const startedAtMs = Date.now();
  try {
    recordBlockedBoardingAttempt(selectedBoardingKey);
    const txid = await identity.withBoardingSweepApproval(
      approvalContext,
      "unlock_wallet_boarding_sweep",
      async () => {
        const ramps = new Ramps(wallet);
        // The signing session can expire between this approval and our nonces, and
        // nothing about the request or the approval is wrong when it does: the
        // registration is simply aimed at a round that is over, so getting into a
        // valid one means registering once more. Exactly one re-registration, and
        // only for that failure: any other round failure and any refused
        // registration ends this unlock here.
        return retryExpiredSession(() => ramps.onboard(feeInfo, selectedBoardingUtxos), {
          onRetry: (attempt, error) => {
            logArkadeWalletSignTrace("arkade_boarding_sweep_session_refresh", {
              status: "retry",
              attempt,
              selected_outpoints: boardingSelection.outpointsText,
              err: truncateForLog(error instanceof Error ? error.message : String(error), 140),
              expected_next: "register_into_next_session",
            });
            emitTrace({
              atMs: Date.now(),
              op: "arkade_boarding_sweep_session_refresh",
              status: "retry",
              detail: `arkade=1 attempt=${attempt} selected_outpoints=${boardingSelection.outpointsText} expected_next=register_into_next_session`,
            });
          },
        });
      },
    );
    const id = String(txid || "").trim() || "n/a";
    recordRecentlySweptOutpoints(selectedBoardingUtxos);
    // The registration is gone from the ASP's point of view, so do not keep
    // skipping this coin on a later attempt.
    clearBoardingOutpointsBlocked(
      selectedBoardingUtxos
        .map((utxo) => boardingUtxoOutpoint(utxo))
        .filter((key): key is string => Boolean(key)),
    );
    setBoardingSweepFailure(null, "boarding_sweep_ok");
    logArkadeWalletSignTrace("arkade_boarding_sweep_complete", {
      status: "ok",
      mode: "single_boarding_utxo_per_attempt",
      candidate_count: candidateSelection.count,
      candidate_total: candidateSelection.totalSats,
      selected_count: boardingSelection.count,
      selected_total: boardingSelection.totalSats,
      txid: id,
      dur_ms: Date.now() - startedAtMs,
      expected_next: "refresh_wallet_summary",
    });
    emitTrace({
      atMs: Date.now(),
      op: "arkade_boarding_sweep",
      status: "ok",
      id,
      detail: `arkade=1 mode=single_boarding_utxo_per_attempt candidate_count=${candidateSelection.count} candidate_total=${candidateSelection.totalSats} selected_count=${boardingSelection.count} selected_total=${boardingSelection.totalSats} txid=${id} durMs=${Date.now() - startedAtMs}`,
    });
    return id;
  } catch (error: unknown) {
    const detail = truncateForLog(
      error instanceof Error ? error.message : String(error || "unknown"),
      180,
    );
    // The ASP holds a registration over an input of this intent, so the same
    // outpoint will be refused on every later attempt until that registration
    // clears server-side. Remember which outpoints it named so the next attempt
    // sweeps the user's other boarding UTXOs instead of re-selecting this one.
    //
    // Two shapes mean that (see duplicatedIntent.ts): the refusal itself, and the
    // SDK's own recovery delete coming back refused instead — which is how it
    // usually arrives, because that delete throws out of the SDK's catch and
    // replaces the register error. Matching only the first shape recorded nothing
    // and left the sweep retrying the same coin on every tick.
    const refusalInputs = duplicatedIntentInputs(error);
    if (isDuplicatedIntentError(error) || isOrphanedIntentRegistrationRefusal(error)) {
      // The delete refusal names no inputs, so it falls back to the coins this
      // attempt actually registered: those are the ones being held.
      const blockedRefs =
        refusalInputs.length > 0
          ? refusalInputs
          : selectedBoardingUtxos.map((utxo) => ({ txid: utxo.txid, vout: utxo.vout }));
      const blockedKeys = markBoardingOutpointsBlocked(blockedRefs, detail);
      logArkadeWalletSignTrace("arkade_boarding_sweep_blocked", {
        status: refusalInputs.length > 0 ? "duplicated_input" : "registration_held_delete_refused",
        blocked_count: blockedKeys.length,
        blocked_outpoints: blockedKeys.join(","),
        selected_outpoints: boardingSelection.outpointsText,
        candidate_count: candidateSelection.count,
        expected_next: "next_attempt_selects_another_candidate",
      });
    }
    options?.appendLog?.(buildBoardingSweepErrorScriptCopyLog(error, ownershipProof));
    setBoardingSweepFailure(
      {
        atMs: Date.now(),
        source: "server",
        detail,
        selectedCount: boardingSelection.count,
        selectedConfirmedCount: boardingSelection.confirmedCount,
        selectedUnconfirmedCount: boardingSelection.unconfirmedCount,
        selectedTotalSats: boardingSelection.totalSats,
        selectedAllConfirmed: boardingSelection.allConfirmed,
        selectedOutpointsText: boardingSelection.outpointsText,
        selectedTxidsText: boardingSelection.txidsText,
        failedTxid: "",
      },
      "boarding_sweep_failed",
    );
    emitTrace({
      atMs: Date.now(),
      op: "arkade_boarding_sweep",
      status: "failed",
      detail: `arkade=1 mode=single_boarding_utxo_per_attempt candidate_count=${candidateSelection.count} candidate_total=${candidateSelection.totalSats} selected_count=${boardingSelection.count} selected_total=${boardingSelection.totalSats} err=${detail}`,
    });
    throw error;
  }
}

function queueArkadeBoardingActiveRetry(
  summary: ArkadeWalletSummary,
  reason: string,
  force: boolean,
): void {
  pendingBoardingAutoSweepActiveRetry = { summary, reason, force };
  ensureArkadeBoardingActiveRetryObserver(reason);
  logArkadeWalletSignTrace("arkade_boarding_prompt_decision", {
    status: "queued",
    reason,
    confirmed: summary.balanceBoardingConfirmedSats,
    unconfirmed: summary.balanceBoardingUnconfirmedSats,
    app_state: AppState.currentState,
    expected_next: "prompt_when_app_active",
  });
}

function ensureArkadeBoardingActiveRetryObserver(reason: string): void {
  if (boardingActiveRetrySub) return;
  boardingActiveRetrySub = AppState.addEventListener("change", (nextState) => {
    if (nextState === "active") {
      triggerArkadeBoardingActiveRetry("app_state_active");
    }
  });
  logArkadeWalletSignTrace("arkade_boarding_active_retry_observer", {
    status: "installed",
    reason,
    expected_next: "retry_confirmed_boarding_when_active",
  });
}

function stopArkadeBoardingActiveRetryObserver(reason: string): void {
  const sub = boardingActiveRetrySub;
  boardingActiveRetrySub = null;
  if (!sub) return;
  try {
    sub.remove?.();
    logArkadeWalletSignTrace("arkade_boarding_active_retry_observer", {
      status: "stopped",
      reason,
      expected_next: "install_on_next_confirmed_boarding",
    });
  } catch (error: unknown) {
    logArkadeWalletSignTrace("arkade_boarding_active_retry_observer", {
      status: "stop_failed",
      reason,
      err: truncateForLog(error instanceof Error ? error.message : String(error || "unknown"), 140),
      expected_next: "install_on_next_confirmed_boarding",
    });
  }
}

function triggerArkadeBoardingActiveRetry(reason = "app_active"): void {
  if (AppState.currentState !== "active") return;
  stopArkadeBoardingActiveRetryObserver(reason);
  const pending = pendingBoardingAutoSweepActiveRetry;
  pendingBoardingAutoSweepActiveRetry = null;
  if (!pending) return;
  scheduleArkadeBoardingAutoSweepImpl(pending.summary, `${pending.reason}_${reason}`, true);
}

export function scheduleArkadeBoardingAutoSweepImpl(
  summary: ArkadeWalletSummary,
  reason: string,
  force = false,
): void {
  const confirmedSats = Math.max(0, Number(summary.balanceBoardingConfirmedSats || 0) || 0);
  const unconfirmedSats = Math.max(0, Number(summary.balanceBoardingUnconfirmedSats || 0) || 0);
  if (!isArkadeBoardingAutoSweepEnabled()) {
    pendingBoardingAutoSweepActiveRetry = null;
    stopArkadeBoardingActiveRetryObserver("disabled");
    logArkadeWalletSignTrace("arkade_boarding_auto_sweep", {
      status: "disabled",
      reason,
      confirmed: confirmedSats,
      unconfirmed: unconfirmedSats,
      force: force ? 1 : 0,
      expected_next: "server_approved_receive_flow_only",
    });
    emitTrace({
      atMs: Date.now(),
      op: "arkade_boarding_auto_sweep",
      status: "disabled",
      detail: `reason=${reason} confirmed=${confirmedSats} unconfirmed=${unconfirmedSats} force=${force ? 1 : 0} expected_next=server_approved_receive_flow_only`,
    });
    return;
  }
  if (confirmedSats <= 0) {
    const waitingForConfirmation = unconfirmedSats > 0;
    pendingBoardingAutoSweepActiveRetry = null;
    stopArkadeBoardingActiveRetryObserver("no_confirmed_boarding");
    logArkadeWalletSignTrace("arkade_boarding_prompt_decision", {
      status: waitingForConfirmation ? "waiting_confirmation" : "skip",
      reason,
      confirmed: confirmedSats,
      unconfirmed: unconfirmedSats,
      expected_next: unconfirmedSats > 0 ? "wait_for_bitcoin_confirmation" : "idle",
    });
    emitTrace({
      atMs: Date.now(),
      op: "arkade_boarding_auto_sweep",
      status: waitingForConfirmation ? "waiting_confirmation" : "skip",
      detail: `reason=${reason} confirmed=0 unconfirmed=${unconfirmedSats} expected_next=${waitingForConfirmation ? "wait_for_bitcoin_confirmation" : "idle"}`,
    });
    return;
  }
  if (AppState.currentState !== "active") {
    queueArkadeBoardingActiveRetry(summary, reason, force);
    emitTrace({
      atMs: Date.now(),
      op: "arkade_boarding_auto_sweep",
      status: "queued",
      detail: `reason=${reason} confirmed=${confirmedSats} why=app_not_active app_state=${AppState.currentState}`,
    });
    return;
  }
  pendingBoardingAutoSweepActiveRetry = null;
  stopArkadeBoardingActiveRetryObserver("active_boarding_attempt");
  if (boardingAutoSweepInFlight) {
    logArkadeWalletSignTrace("arkade_boarding_prompt_decision", {
      status: "skip",
      reason,
      confirmed: confirmedSats,
      unconfirmed: unconfirmedSats,
      why: "in_flight",
      expected_next: "existing_onboard_finishes",
    });
    emitTrace({
      atMs: Date.now(),
      op: "arkade_boarding_auto_sweep",
      status: "skip",
      detail: `reason=${reason} confirmed=${confirmedSats} why=in_flight`,
    });
    return;
  }
  const now = Date.now();
  if (!force && now - lastBoardingAutoSweepAtMs < ARKADE_BOARDING_AUTO_SWEEP_MIN_INTERVAL_MS) {
    logArkadeWalletSignTrace("arkade_boarding_prompt_decision", {
      status: "skip",
      reason,
      confirmed: confirmedSats,
      unconfirmed: unconfirmedSats,
      why: "throttled",
      throttle_ms: ARKADE_BOARDING_AUTO_SWEEP_MIN_INTERVAL_MS,
      expected_next: "retry_on_next_summary_refresh",
    });
    emitTrace({
      atMs: now,
      op: "arkade_boarding_auto_sweep",
      status: "skip",
      detail: `reason=${reason} confirmed=${confirmedSats} why=throttled throttleMs=${ARKADE_BOARDING_AUTO_SWEEP_MIN_INTERVAL_MS}`,
    });
    return;
  }

  const run = (async () => {
    lastBoardingAutoSweepAtMs = Date.now();
    logArkadeWalletSignTrace("arkade_boarding_prompt_decision", {
      status: "prompt_required",
      reason,
      confirmed: confirmedSats,
      unconfirmed: unconfirmedSats,
      expected_next: "sign_confirmed_boarding_onboard",
    });
    emitTrace({
      atMs: lastBoardingAutoSweepAtMs,
      op: "arkade_boarding_auto_sweep",
      status: "attempt",
      detail: `reason=${reason} confirmed=${confirmedSats}`,
    });
    const sweepId = await sweepArkadeBoardingToOffchain();
    emitTrace({
      atMs: Date.now(),
      op: "arkade_boarding_auto_sweep",
      status: "ok",
      detail: `reason=${reason} id=${sweepId || "n/a"}`,
    });
    // Post-sweep is user-visible completion state; bypass the wrapper so a
    // cached/rate-limited summary cannot leave the pending badge stale.
    await loadArkadeWalletSummary({
      scheduleAutoClaim: false,
      scheduleAutoSettle: false,
      scheduleAutoBoardingSweep: false,
    })
      .then((postSummary) => {
        emitTrace({
          atMs: Date.now(),
          op: "arkade_boarding_auto_sweep",
          status: "post_summary_ok",
          detail: `reason=${reason} available=${postSummary.balanceAvailableSats} boardingConfirmed=${postSummary.balanceBoardingConfirmedSats} boardingUnconfirmed=${postSummary.balanceBoardingUnconfirmedSats} preconfirmed=${postSummary.balancePreconfirmedSats} settled=${postSummary.balanceSettledSats}`,
        });
        emitArkadeWalletSummaryAfterAutoSweep("arkade_boarding_auto_sweep", postSummary);
      })
      .catch((error: unknown) => {
        emitTrace({
          atMs: Date.now(),
          op: "arkade_boarding_auto_sweep",
          status: "post_summary_failed",
          detail: `reason=${reason} err=${truncateForLog(error instanceof Error ? error.message : String(error || "unknown"), 170)}`,
        });
      });
  })().catch((error: unknown) => {
    emitTrace({
      atMs: Date.now(),
      op: "arkade_boarding_auto_sweep",
      status: "failed",
      detail: `reason=${reason} confirmed=${confirmedSats} err=${truncateForLog(error instanceof Error ? error.message : String(error || "unknown"), 170)}`,
    });
  });

  boardingAutoSweepInFlight = run;
  void run.finally(() => {
    if (boardingAutoSweepInFlight === run) {
      boardingAutoSweepInFlight = null;
    }
  });
}

export function resetArkadeBoardingAutoSweepState(): void {
  boardingAutoSweepInFlight = null;
  // `boardingSweepInFlight` is deliberately NOT cleared here. Clearing a lock
  // cannot cancel the run it tracks: `runArkadeBoardingSweep` would still be
  // awaiting approval and settlement, and the next caller would register a
  // SECOND intent over the same UTXO — recreating the duplicate-input orphan
  // this lock exists to prevent. It is released only by its own `finally`,
  // which is reached on failure as well as success. This reset is reachable
  // mid-sweep via `restoreArkadeDebugRecoveryBackup`.
  lastBoardingAutoSweepAtMs = 0;
  pendingBoardingAutoSweepActiveRetry = null;
  stopArkadeBoardingActiveRetryObserver("reset");
}
