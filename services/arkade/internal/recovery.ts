// Internal arkade recovery CSV status helpers shared by prod-tier and debug-tier code.
import { ArkadeRemoteIdentity } from "../ArkadeRemoteIdentity";
import { emitTrace, logArkadeWalletSignTrace } from "./logging";
import { normalizeArkadeRelativeTimelock } from "./timelocks";
import type { ArkadeRecoveryCsvStatus, ArkadeWallet } from "./types";
import { isRecord } from "./utils";

function formatRelativeTimelockForUi(timelock: unknown): string {
  const record = isRecord(timelock) ? timelock : null;
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

function buildRecoveryCsvStatus(
  status: ArkadeRecoveryCsvStatus["recoveryCsvStatus"],
  arkadeCsv: unknown,
  nuriServerCsv: unknown,
  detail: string,
): ArkadeRecoveryCsvStatus {
  return {
    recoveryCsvStatus: status,
    recoveryCsvArkadeLabel: formatRelativeTimelockForUi(arkadeCsv),
    recoveryCsvNuriServerLabel: formatRelativeTimelockForUi(nuriServerCsv),
    recoveryCsvDetail: detail,
  };
}

export async function inspectArkadeRecoveryCsvStatus(
  wallet: ArkadeWallet,
  source = "wallet_summary",
): Promise<ArkadeRecoveryCsvStatus> {
  const walletRecord = wallet as unknown as Record<string, unknown>;
  const offchainTapscript = isRecord(walletRecord.offchainTapscript)
    ? walletRecord.offchainTapscript
    : null;
  const offchainOptions = isRecord(offchainTapscript?.options) ? offchainTapscript.options : null;
  const arkadeCsv = normalizeArkadeRelativeTimelock(offchainOptions?.csvTimelock);
  const identity = walletRecord.identity as ArkadeRemoteIdentity;
  const pubCtx = await identity.getSigningPublicContext();
  const nuriServerCsv = normalizeArkadeRelativeTimelock(pubCtx.nuriServerCsv);
  const recoveryPolicy = isRecord(pubCtx.recoveryPolicy) ? pubCtx.recoveryPolicy : null;
  const cosignerDerivation = isRecord(pubCtx.cosignerDerivation) ? pubCtx.cosignerDerivation : null;
  const fallbackPolicy = isRecord(cosignerDerivation?.recovery_policy)
    ? cosignerDerivation.recovery_policy
    : null;
  const policyCsv = normalizeArkadeRelativeTimelock(
    recoveryPolicy?.nuri_server_csv ?? fallbackPolicy?.nuri_server_csv,
  );
  const policyDetail =
    policyCsv && nuriServerCsv
      ? `policy=${formatRelativeTimelockForUi(policyCsv)}`
      : "policy=missing";

  let out: ArkadeRecoveryCsvStatus;
  if (!arkadeCsv || !nuriServerCsv) {
    out = buildRecoveryCsvStatus(
      "missing",
      arkadeCsv,
      nuriServerCsv,
      `arkade=${formatRelativeTimelockForUi(arkadeCsv)} nuri=${formatRelativeTimelockForUi(nuriServerCsv)} ${policyDetail}`,
    );
  } else if (arkadeCsv.type !== nuriServerCsv.type) {
    out = buildRecoveryCsvStatus(
      "mismatch",
      arkadeCsv,
      nuriServerCsv,
      `arkade=${formatRelativeTimelockForUi(arkadeCsv)} nuri=${formatRelativeTimelockForUi(nuriServerCsv)} ${policyDetail}`,
    );
  } else {
    out = buildRecoveryCsvStatus(
      "matched",
      arkadeCsv,
      nuriServerCsv,
      `arkade=${formatRelativeTimelockForUi(arkadeCsv)} nuri=${formatRelativeTimelockForUi(nuriServerCsv)} ${policyDetail}`,
    );
  }

  logArkadeWalletSignTrace("arkade_recovery_csv_policy", {
    source,
    status: out.recoveryCsvStatus,
    arkade_csv: out.recoveryCsvArkadeLabel,
    nuri_server_csv: out.recoveryCsvNuriServerLabel,
    detail: out.recoveryCsvDetail,
    expected_next: out.recoveryCsvStatus === "matched" ? "allow_funding" : "block_funding",
  });
  return out;
}

export async function assertArkadeRecoveryCsvCompatible(
  wallet: ArkadeWallet,
  source: string,
): Promise<ArkadeRecoveryCsvStatus> {
  const out = await inspectArkadeRecoveryCsvStatus(wallet, source);
  if (out.recoveryCsvStatus !== "matched") {
    logArkadeWalletSignTrace("arkade_recovery_csv_blocked", {
      source,
      status: out.recoveryCsvStatus,
      arkade_csv: out.recoveryCsvArkadeLabel,
      nuri_server_csv: out.recoveryCsvNuriServerLabel,
      detail: out.recoveryCsvDetail,
      expected_next: "restart_app_after_seconds_server_config",
    });
    emitTrace({
      atMs: Date.now(),
      op: "recovery_csv",
      status: "failed",
      detail: `source=${source} status=${out.recoveryCsvStatus} ${out.recoveryCsvDetail}`,
    });
    throw new Error(`arkade recovery CSV unsafe: ${out.recoveryCsvDetail}`);
  }
  return out;
}
