// Internal arkade contract-diagnostics summary helper shared by prod-tier and debug-tier code.
// Storage access is injected by source via setArkadeContractRepositoryProvider so this file
// stays decoupled from the V4 storage adapter that still lives in source.
import { contractHandlers } from "@arkade-os/sdk";
import { bytesToHex } from "../../../lib/bytes";
import { sha256 } from "../../../lib/crypto";
import { errMsg } from "../../../lib/errorMessage";
import { emitTrace, logArkadeWalletErrorTrace, logArkadeWalletSignTrace } from "./logging";
import { hexToBytesLocal, truncateForLog } from "./utils";

export type ArkadeContractDiagnostic = {
  type: string;
  status: "ok" | "missing_handler" | "invalid" | "script_mismatch";
  script: string;
  scriptHash: string;
  addressPreview: string;
  paramsKeys: string[];
  error: string;
};

export type ArkadeContractDiagnosticsSummary = {
  status: "ok" | "warning" | "not_checked";
  total: number;
  invalidCount: number;
  diagnostics: ArkadeContractDiagnostic[];
  logLine: string;
  updatedAtMs: number;
};

type StoredArkadeContractForDiagnostics = {
  type?: unknown;
  script?: unknown;
  address?: unknown;
  params?: unknown;
};

type ArkadeContractRepositoryLike = {
  getContracts(): Promise<StoredArkadeContractForDiagnostics[]>;
};

let contractRepositoryProvider: (() => ArkadeContractRepositoryLike) | null = null;

export function setArkadeContractRepositoryProvider(
  provider: () => ArkadeContractRepositoryLike,
): void {
  contractRepositoryProvider = provider;
}

function scriptHashForLog(scriptHex: string): string {
  const bytes = hexToBytesLocal(scriptHex);
  return bytes.length ? bytesToHex(sha256(bytes)).slice(0, 16) : "n/a";
}

function emptyContractDiagnosticsSummary(
  status: ArkadeContractDiagnosticsSummary["status"],
  detail: string,
): ArkadeContractDiagnosticsSummary {
  return {
    status,
    total: 0,
    invalidCount: status === "warning" ? 1 : 0,
    diagnostics: [],
    logLine: detail,
    updatedAtMs: Date.now(),
  };
}

export async function getArkadeContractDiagnosticsSummary(
  reason = "manual",
): Promise<ArkadeContractDiagnosticsSummary> {
  try {
    if (!contractRepositoryProvider) {
      throw new Error("contract repository provider not registered");
    }
    const repository = contractRepositoryProvider();
    const contracts = await repository.getContracts();
    const diagnostics: ArkadeContractDiagnostic[] = contracts.map((contract) => {
      const type = String(contract?.type || "unknown");
      const script = String(contract?.script || "");
      const params =
        contract?.params && typeof contract.params === "object" && !Array.isArray(contract.params)
          ? Object.fromEntries(
              Object.entries(contract.params as Record<string, unknown>).map(([key, value]) => [
                key,
                String(value ?? ""),
              ]),
            )
          : {};
      const handler = contractHandlers.get(type);
      const base = {
        type,
        script,
        scriptHash: scriptHashForLog(script),
        addressPreview: truncateForLog(String(contract?.address || "n/a"), 28),
        paramsKeys: Object.keys(params).sort(),
      };
      if (!handler) {
        return {
          ...base,
          status: "missing_handler" as const,
          error: `No handler for contract type '${type}'`,
        };
      }
      try {
        const vtxoScript = handler.createScript(params);
        const derivedScript = bytesToHex(vtxoScript.pkScript).toLowerCase();
        if (script && derivedScript !== script.toLowerCase()) {
          return {
            ...base,
            status: "script_mismatch" as const,
            error: `derived_script_hash=${scriptHashForLog(derivedScript)}`,
          };
        }
        return {
          ...base,
          status: "ok" as const,
          error: "",
        };
      } catch (error: unknown) {
        return {
          ...base,
          status: "invalid" as const,
          error: truncateForLog(errMsg(error, "unknown"), 180),
        };
      }
    });
    const invalid = diagnostics.filter((item) => item.status !== "ok");
    const logLine =
      invalid.length > 0
        ? invalid
            .slice(0, 4)
            .map(
              (item) =>
                `type=${item.type} status=${item.status} script=${item.scriptHash} address=${item.addressPreview} params=${item.paramsKeys.join(",") || "none"} err=${item.error || "n/a"}`,
            )
            .join(" | ")
        : `contracts_ok total=${contracts.length}`;
    const summary: ArkadeContractDiagnosticsSummary = {
      status: invalid.length > 0 ? "warning" : "ok",
      total: contracts.length,
      invalidCount: invalid.length,
      diagnostics,
      logLine,
      updatedAtMs: Date.now(),
    };
    logArkadeWalletSignTrace("contract_diagnostics", {
      reason,
      status: summary.status,
      total: summary.total,
      invalid: summary.invalidCount,
      detail: truncateForLog(summary.logLine, 300),
    });
    emitTrace({
      atMs: Date.now(),
      op: "contract_diagnostics",
      status: summary.status,
      detail: truncateForLog(summary.logLine, 300),
    });
    return summary;
  } catch (error: unknown) {
    const detail = `contract_diagnostics_failed err=${truncateForLog(errMsg(error, "unknown"), 180)}`;
    logArkadeWalletErrorTrace("contract_diagnostics_failed", {
      reason,
      err: detail,
    });
    return emptyContractDiagnosticsSummary("warning", detail);
  }
}
