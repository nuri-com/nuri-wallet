// Arkade debug helpers — extracted from DebugArkadeModal
import type { ArkadeReceiveStageSnapshot } from "../../services/arkade/types/receive";
import type { getArkadeWalletSummary } from "../../services/arkade/ArkadeWalletService";
import {
  ARKADE_MODAL_MAX_LOGS,
  ARKADE_MODAL_MAX_PINNED_LOGS,
  ARKADE_MODAL_ACTION_TIMEOUT_MS,
  ARKADE_MODAL_PAYMENT_TIMEOUT_MS,
  ARKADE_MODAL_SWEEP_TIMEOUT_MS,
} from "../../config/constants";

export function formatReceiveStageLabel(status: ArkadeReceiveStageSnapshot["status"]): string {
  switch (status) {
    case "pending":
      return "LN pending";
    case "claimable":
      return "LN claimable";
    case "claiming":
      return "Claiming";
    case "awaiting_settlement":
      return "Finalizing";
    case "settled":
      return "Settled";
    case "failed":
      return "Failed";
    default:
      return "Idle";
  }
}

export function formatArkadeActionLabel(label: string | null): string {
  const raw = String(label || "").trim();
  if (!raw) return "None";
  switch (raw) {
    case "wallet_summary":
      return "Load Wallet";
    case "health":
      return "Health Check";
    case "test_wallet":
      return "Wallet Test";
    case "send_ark":
      return "Send Ark";
    case "send_bitcoin_onchain":
      return "Send Bitcoin Onchain";
    case "send_payment":
      return "Send Payment";
    case "sweep_boarding":
      return "Sweep Boarding";
    case "auto_sweep_boarding":
      return "Auto Sweep Boarding";
    case "create_ln_invoice":
      return "Create LN Invoice";
    case "pay_ln_invoice":
      return "Pay LN Request";
    case "claim_incoming_ln":
      return "Claim Incoming LN";
    case "probe_network":
      return "Probe Network";
    case "ln_limits":
      return "Refresh LN Limits";
    case "lnurl_status":
      return "LNURL Status";
    case "lnurl_claim_username":
      return "Claim Username";
    case "lnurl_publish_invoice":
      return "Publish LNURL Invoice";
    case "auto_claim_on_open":
      return "Initial Arkade Sync";
    case "l1_csv_proof_address":
      return "Create Recovery Address";
    case "l1_csv_proof_scan":
      return "Scan Recovery Proof";
    case "l1_csv_recovery_audit":
      return "Recovery Audit";
    case "l1_csv_full_proof_diagnostic":
      return "Full Recovery Test";
    case "l1_csv_proof_build":
      return "Build Recovery Tx";
    case "l1_csv_proof_broadcast":
      return "Broadcast Recovery Tx";
    default:
      return raw
        .split("_")
        .map((part) => (part ? `${part.slice(0, 1).toUpperCase()}${part.slice(1)}` : part))
        .join(" ");
  }
}

export function extractTaggedDetailValue(detail: string, key: string): string | null {
  const raw = String(detail || "");
  if (!raw) return null;
  if (key === "sweep_err") {
    const marker = `${key}=`;
    const index = raw.indexOf(marker);
    if (index < 0) return null;
    return raw.slice(index + marker.length).trim() || null;
  }
  const match = raw.match(new RegExp(`(?:^|\\s)${key}=([^\\s]+)`));
  return match?.[1] ? String(match[1]).trim() : null;
}

export function compactUiText(value: string | null | undefined, max = 160): string {
  const raw = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return "n/a";
  if (raw.length <= max) return raw;
  return `${raw.slice(0, Math.max(1, max - 1))}...`;
}

export function formatStatusSourceLabel(source: string | null): string {
  if (source === "server") return "Server";
  if (source === "local") return "Local";
  return "Unknown";
}

export function formatClaimSummary(summary: {
  scanned: number;
  claimable: number;
  claimed: number;
  settled: number;
  final: number;
  failed: number;
}): string {
  return (
    `scanned=${summary.scanned} claimable=${summary.claimable} claimed=${summary.claimed} ` +
    `settled=${summary.settled} final=${summary.final} failed=${summary.failed}`
  );
}

export function isPinnedArkadeLogLine(line: string): boolean {
  const raw = String(line || "");
  return (
    raw.includes("op=ark_settle") ||
    raw.includes("flow=arkade.pay") ||
    raw.includes("flow=arkade.confirm") ||
    raw.includes("arkade_tx=") ||
    raw.includes("wallet_summary") ||
    raw.includes("source=wallet_summary") ||
    raw.includes("wallet ark=") ||
    raw.includes("op=send_bitcoin_onchain") ||
    raw.includes("op=ark_provider_register_intent") ||
    raw.includes("send_bitcoin_onchain_result") ||
    raw.includes("INVALID_PSBT_INPUT") ||
    raw.includes("op=ln_pay_request") ||
    raw.includes("op=browser_confirm") ||
    raw.includes("op=boarding_sweep") ||
    raw.includes("op=boarding_sweep_event") ||
    raw.includes("ARKADE_L1_RECOVERY") ||
    raw.includes("ARKADE_FULL_PROOF") ||
    raw.includes("ARKADE_RECOVERY_AUDIT") ||
    raw.includes("BOARDING_SETTLE") ||
    raw.includes("unlock_wallet") ||
    raw.includes("arkade_receive_unlock") ||
    raw.includes("arkade_boarding_sweep") ||
    raw.includes("arkade_recovery_") ||
    raw.includes("arkade_recovery_boarding_settle") ||
    raw.includes("op=recoverability_audit") ||
    raw.includes("ark_provider_register_intent") ||
    raw.includes("registerIntent") ||
    raw.includes("l1_csv_")
  );
}

export function extractLatestArkadeTxId(lines: string[]): string | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = String(lines[index] || "");
    const match = line.match(/arkade_tx=([a-z0-9._-]+)/i);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function trimArkadeLogs(lines: string[]): string[] {
  if (lines.length <= ARKADE_MODAL_MAX_LOGS) return lines;
  const pinnedIndexes = lines
    .map((line, index) => (isPinnedArkadeLogLine(line) ? index : -1))
    .filter((index) => index >= 0)
    .slice(-ARKADE_MODAL_MAX_PINNED_LOGS);
  const pinnedSet = new Set(pinnedIndexes);
  const otherIndexes = lines
    .map((_, index) => (!pinnedSet.has(index) ? index : -1))
    .filter((index) => index >= 0)
    .slice(-(ARKADE_MODAL_MAX_LOGS - pinnedIndexes.length));
  const keep = new Set([...pinnedIndexes, ...otherIndexes]);
  return lines.filter((_, index) => keep.has(index));
}

export function isUsefulArkadeLogLine(line: string, activeArkadeTxId: string | null): boolean {
  const raw = String(line || "");
  if (activeArkadeTxId && raw.includes(`arkade_tx=${activeArkadeTxId}`)) return true;
  if (isPinnedArkadeLogLine(raw)) return true;
  if (raw.includes("flow op=ark_settle")) return true;
  if (raw.includes("flow op=arkade_receive_unlock")) return true;
  if (raw.includes("flow op=arkade_receive_unlock_state")) return true;
  if (raw.includes("flow op=arkade_boarding_sweep")) return true;
  if (raw.includes("flow op=arkade_boarding_sweep_preflight")) return true;
  if (raw.includes("flow op=arkade_boarding_sweep_signing_gate")) return true;
  if (raw.includes("flow op=ln_pay_request")) return true;
  if (raw.includes("flow op=ln_pay_wallet_state")) return true;
  if (raw.includes("flow op=ln_swap")) return true;
  if (raw.includes("flow op=browser_confirm")) return true;
  if (raw.includes("flow op=send_bitcoin_onchain")) return true;
  if (raw.includes("flow op=ark_provider_register_intent")) return true;
  if (raw.includes("send_bitcoin_onchain_result")) return true;
  if (raw.includes("INVALID_PSBT_INPUT")) return true;
  if (
    raw.includes("flow op=ln_receive_manual_claim status=summary") ||
    raw.includes("flow op=ln_receive_manual_claim status=claim_start") ||
    raw.includes("flow op=ln_receive_manual_claim status=claimed") ||
    raw.includes("flow op=ln_receive_manual_claim status=claim_failed") ||
    raw.includes("flow op=ln_receive_manual_claim status=pending_fetch_failed")
  ) {
    return true;
  }
  if (
    raw.includes("flow op=ln_receive_stage") &&
    !raw.includes("status=idle") &&
    !raw.includes("detail=rows=0")
  ) {
    return true;
  }
  return (
    raw.includes("pay_ln_invoice failed") ||
    raw.includes("status=failed") ||
    raw.includes("resolve_failed") ||
    raw.includes(" copy logs failed") ||
    raw.includes(" error=") ||
    raw.includes(" err=")
  );
}

export function buildUsefulArkadeLogs(lines: string[]): string[] {
  const activeArkadeTxId = extractLatestArkadeTxId(lines);
  const filtered = lines.filter((line) => isUsefulArkadeLogLine(line, activeArkadeTxId));
  const out: string[] = [];
  let lastNormalized = "";
  for (const line of filtered) {
    const normalized = String(line || "").replace(
      /^🧪 \[\d{2}:\d{2}:\d{2}\.\d{3} DebugArkadeModal\] /,
      "",
    );
    if (normalized === lastNormalized) continue;
    out.push(line);
    lastNormalized = normalized;
  }
  return out;
}

export function isZeroWalletSummary(
  summary: Awaited<ReturnType<typeof getArkadeWalletSummary>>,
): boolean {
  const values = [
    summary.balanceTotalSats,
    summary.balanceBoardingConfirmedSats,
    summary.balanceBoardingUnconfirmedSats,
    summary.balanceBoardingTotalSats,
    summary.balanceAvailableSats,
    summary.balanceSettledSats,
    summary.balancePreconfirmedSats,
    summary.balanceRecoverableSats,
  ];
  return values.every((value) => Number(value || "0") === 0);
}

export function formatWalletSummaryLine(
  prefix: string,
  summary: Awaited<ReturnType<typeof getArkadeWalletSummary>> | null,
): string {
  if (!summary) return `${prefix}=n/a`;
  return (
    `${prefix} total=${summary.balanceTotalSats} available=${summary.balanceAvailableSats} ` +
    `settled=${summary.balanceSettledSats} preconfirmed=${summary.balancePreconfirmedSats} ` +
    `recoverable=${summary.balanceRecoverableSats}`
  );
}

export function formatWalletVtxoLine(
  prefix: string,
  summary: Awaited<ReturnType<typeof getArkadeWalletSummary>> | null,
): string {
  if (!summary) return `${prefix}=n/a`;
  return (
    `${prefix} count=${summary.debugVtxoCount} settled=${summary.debugVtxoSettledCount} ` +
    `preconfirmed=${summary.debugVtxoPreconfirmedCount} recoverable=${summary.debugVtxoRecoverableCount} ` +
    `totalSats=${summary.debugVtxoTotalSats} availableSats=${summary.debugVtxoAvailableSats}`
  );
}

export function actionTimeoutMs(label: string): number {
  if (label === "send_payment") {
    return ARKADE_MODAL_PAYMENT_TIMEOUT_MS;
  }
  if (
    label === "sweep_boarding" ||
    label === "auto_sweep_boarding" ||
    label === "l1_csv_full_proof_diagnostic"
  ) {
    return ARKADE_MODAL_SWEEP_TIMEOUT_MS;
  }
  if (label === "arkade_full_recovery_test") {
    return ARKADE_MODAL_SWEEP_TIMEOUT_MS * 5;
  }
  return ARKADE_MODAL_ACTION_TIMEOUT_MS;
}

export function withActionTimeout<T>(label: string, work: Promise<T>): Promise<T> {
  const timeoutMs = actionTimeoutMs(label);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    work
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}
