// Internal outgoing-pay trace helpers (id gen, payment-hash lookup, snapshot emit, trace registry) shared by prod-tier and debug-tier arkade code.
import { decodeBolt11Facts } from "../../../lib/bitcoin/lightning";
import { bytesToHex } from "../../../lib/bytes";
import { sha256 } from "../../../lib/crypto";
import { shortTime } from "../../../lib/logShared";
import { errMsg } from "../../../lib/errorMessage";
import { emitTrace } from "./logging";
import type { ArkadeOutgoingPayTrace, ArkadeWallet } from "./types";
import { hexToBytesLocal, isRecord, truncateForLog } from "./utils";

const outgoingPayOpsByHash: Map<string, ArkadeOutgoingPayTrace> = new Map();
const outgoingPayOpsBySwapId: Map<string, ArkadeOutgoingPayTrace> = new Map();

export function createTraceOpId(prefix: string): string {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}.${time}.${rand}`;
}

export function safePaymentHashFromInvoice(invoice: string): string {
  try {
    return decodeBolt11Facts(invoice).paymentHash;
  } catch {
    return "";
  }
}

export function formatOutgoingPayTraceDetail(
  trace: ArkadeOutgoingPayTrace | null | undefined,
  extras: Array<string | null | undefined> = [],
): string {
  const parts: string[] = [];
  if (trace) {
    parts.push("flow=arkade.pay");
  }
  if (trace?.opId) parts.push(`arkade_tx=${trace.opId}`);
  if (trace?.paymentHash) parts.push(`payment_hash=${trace.paymentHash}`);
  if (trace?.swapId) parts.push(`swap_id=${trace.swapId}`);
  extras.forEach((extra) => {
    const value = String(extra || "").trim();
    if (value) parts.push(value);
  });
  return parts.join(" ");
}

export function registerOutgoingPayTrace(trace: ArkadeOutgoingPayTrace): void {
  if (trace.paymentHash) {
    outgoingPayOpsByHash.set(trace.paymentHash, trace);
  }
}

export function attachOutgoingPaySwap(trace: ArkadeOutgoingPayTrace, swapId: string): void {
  const normalized = String(swapId || "").trim();
  if (!normalized) return;
  trace.swapId = normalized;
  outgoingPayOpsBySwapId.set(normalized, trace);
}

export function matchOutgoingPayTraceForSwap(swap: unknown): ArkadeOutgoingPayTrace | null {
  const record = isRecord(swap) ? swap : null;
  const swapId = String(record?.id || "").trim();
  if (swapId) {
    const byId = outgoingPayOpsBySwapId.get(swapId);
    if (byId) return byId;
  }
  const paymentHash = getSwapPaymentHash(swap);
  if (!paymentHash) return null;
  const byHash = outgoingPayOpsByHash.get(paymentHash);
  if (!byHash) return null;
  if (swapId) {
    attachOutgoingPaySwap(byHash, swapId);
  }
  return byHash;
}

function getSwapPaymentHash(swap: unknown): string {
  const record = isRecord(swap) ? swap : null;
  const direct = String(record?.paymentHash || "")
    .trim()
    .toLowerCase();
  if (direct) return direct;
  const request = isRecord(record?.request) ? record.request : null;
  const requestInvoice = String(request?.invoice || "").trim();
  if (requestInvoice) {
    const fromRequest = safePaymentHashFromInvoice(requestInvoice);
    if (fromRequest) return fromRequest;
  }
  const response = isRecord(record?.response) ? record.response : null;
  const responseInvoice = String(response?.invoice || "").trim();
  if (responseInvoice) {
    const fromResponse = safePaymentHashFromInvoice(responseInvoice);
    if (fromResponse) return fromResponse;
  }
  return "";
}

export function preimageHashStatus(preimageHex: string, paymentHashHex: string): string {
  const preimage = String(preimageHex || "")
    .trim()
    .toLowerCase();
  const paymentHash = String(paymentHashHex || "")
    .trim()
    .toLowerCase();
  if (!preimage) return "missing";
  const preimageBytes = hexToBytesLocal(preimage);
  if (preimageBytes.length !== 32 || !/^[0-9a-f]{64}$/.test(paymentHash)) return "unknown";
  const hash = bytesToHex(sha256(preimageBytes)).toLowerCase();
  return hash === paymentHash ? "match" : "mismatch";
}

export function isDuplicateOffchainClaimError(error: unknown): boolean {
  const raw = errMsg(error).toLowerCase();
  const normalized = raw.replace(/[_-]+/g, " ");
  if (!raw && !normalized) return false;
  const hasInvalidArkPsbt =
    raw.includes("invalid_ark_psbt") || normalized.includes("invalid ark psbt");
  const hasDuplicateOffchainTx =
    raw.includes("duplicated_offchain_tx") || normalized.includes("duplicated offchain tx");
  const hasAlreadySpentVhtlc =
    normalized.includes("vhtlc is already spent") ||
    (normalized.includes("vhtlc") && normalized.includes("already spent"));
  return (hasInvalidArkPsbt && hasDuplicateOffchainTx) || hasAlreadySpentVhtlc;
}

type WalletBalanceShape = {
  total?: unknown;
  available?: unknown;
  settled?: unknown;
  preconfirmed?: unknown;
  recoverable?: unknown;
  boarding?: {
    total?: unknown;
    confirmed?: unknown;
    unconfirmed?: unknown;
  };
};

export async function emitOutgoingPayWalletSnapshot(
  wallet: ArkadeWallet,
  phase: "pre_send" | "post_success" | "post_failure",
  trace: ArkadeOutgoingPayTrace,
  extras: Array<string | null | undefined> = [],
): Promise<void> {
  try {
    const [balance, vtxos] = await Promise.all([wallet.getBalance(), wallet.getVtxos()]);
    let vtxoSettledCount = 0;
    let vtxoPreconfirmedCount = 0;
    let vtxoRecoverableCount = 0;
    let vtxoAvailableSats = 0;

    for (const coin of Array.isArray(vtxos) ? vtxos : []) {
      const coinRecord = isRecord(coin) ? coin : null;
      const value = Number(coinRecord?.value ?? 0);
      const virtualStatus = isRecord(coinRecord?.virtualStatus) ? coinRecord.virtualStatus : null;
      const state = String(virtualStatus?.state || "")
        .trim()
        .toLowerCase();
      if (state === "settled") {
        vtxoSettledCount += 1;
        vtxoAvailableSats += Number.isFinite(value) ? value : 0;
      } else if (state === "preconfirmed") {
        vtxoPreconfirmedCount += 1;
        vtxoAvailableSats += Number.isFinite(value) ? value : 0;
      } else if (state === "swept") {
        vtxoRecoverableCount += 1;
      }
    }

    const balanceShape = balance as WalletBalanceShape;
    const detail = formatOutgoingPayTraceDetail(trace, [
      `phase=${phase}`,
      ...extras,
      `total=${Number(balanceShape?.total ?? 0)}`,
      `available=${Number(balanceShape?.available ?? 0)}`,
      `boarding=${Number(balanceShape?.boarding?.total ?? 0)}`,
      `boardingConfirmed=${Number(balanceShape?.boarding?.confirmed ?? 0)}`,
      `boardingUnconfirmed=${Number(balanceShape?.boarding?.unconfirmed ?? 0)}`,
      `settled=${Number(balanceShape?.settled ?? 0)}`,
      `preconfirmed=${Number(balanceShape?.preconfirmed ?? 0)}`,
      `recoverable=${Number(balanceShape?.recoverable ?? 0)}`,
      `vtxos=${Array.isArray(vtxos) ? vtxos.length : 0}`,
      `vtxoAvailable=${vtxoAvailableSats}`,
      `vtxoSettled=${vtxoSettledCount}`,
      `vtxoPreconfirmed=${vtxoPreconfirmedCount}`,
      `vtxoRecoverable=${vtxoRecoverableCount}`,
    ]);
    emitTrace({
      atMs: Date.now(),
      op: "ln_pay_wallet_state",
      status: phase,
      id: trace.opId,
      detail,
    });
    console.log(`🔐 [${shortTime()} ArkadeLightningSendService.payWallet] ${detail}`);
  } catch (error: unknown) {
    emitTrace({
      atMs: Date.now(),
      op: "ln_pay_wallet_state",
      status: "snapshot_failed",
      id: trace.opId,
      detail: formatOutgoingPayTraceDetail(trace, [
        `phase=${phase}`,
        `err=${truncateForLog(errMsg(error, "unknown"), 170)}`,
      ]),
    });
  }
}
