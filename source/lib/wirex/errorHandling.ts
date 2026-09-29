import { truncateMiddle, decodeRevertStringFromErrorData } from "./debugHelpers";
import { AA_BOOTSTRAP_RETRY_DELAY_MS } from "./debugConfig";

export const buildHttpErrorDigest = (messageRaw: string): string => {
  const message = String(messageRaw || "");
  if (!message.toLowerCase().includes("http request failed")) return "";

  const status = message.match(/Status:\s*([0-9]{3})/i)?.[1] || "";
  const url = message.match(/URL:\s*([^\n]+)/i)?.[1]?.trim() || "";
  const rpcMethod = message.match(/"method":"([^"]+)"/)?.[1] || "";
  const sender = message.match(/"sender":"(0x[a-fA-F0-9]{40})"/)?.[1] || "";
  const factory = message.match(/"factory":"(0x[a-fA-F0-9]{40})"/)?.[1] || "";
  const details =
    message.match(/Details:\s*"([^"]+)"/i)?.[1]?.trim() ||
    message.match(/Details:\s*([^\n]+)/i)?.[1]?.trim() ||
    "";
  const reasonHex =
    message.match(/0x08c379a0[0-9a-fA-F]+/)?.[0] ||
    message.match(/reason:\s*(0x[0-9a-fA-F]+)/i)?.[1] ||
    "";
  const decodedReason = reasonHex ? decodeRevertStringFromErrorData(reasonHex) : "";
  const simulationReasonRaw =
    message.match(/simulation with reason:\s*([^"\n]+)/i)?.[1]?.trim() || "";

  const lines: string[] = [];
  lines.push("AA sponsor simulation failed");
  if (status) lines.push(`status: ${status}`);
  if (rpcMethod) lines.push(`rpcMethod: ${rpcMethod}`);
  if (url) lines.push(`url: ${truncateMiddle(url, 160)}`);
  if (sender) lines.push(`sender: ${sender}`);
  if (factory) lines.push(`factory: ${factory}`);
  if (decodedReason) {
    lines.push(`revert: ${decodedReason}`);
  } else if (simulationReasonRaw) {
    lines.push(`revert: ${truncateMiddle(simulationReasonRaw, 180)}`);
  } else if (details) {
    lines.push(`details: ${truncateMiddle(details, 180)}`);
  }
  return lines.join("\n");
};

export const shouldRetryAaBootstrapError = (message: string): boolean => {
  const normalized = String(message || "").toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes("http request failed") ||
    normalized.includes("request timed out") ||
    normalized.includes("the request took too long to respond") ||
    normalized.includes("timed out while waiting for user operation") ||
    normalized.includes("receipt_timeout") ||
    normalized.includes("user operation with hash") ||
    normalized.includes("useroperation reverted during simulation")
  );
};

export const shouldAutoRetryAaBootstrapError = (message: string): boolean => {
  const normalized = String(message || "").toLowerCase();
  if (!normalized) return false;
  if (
    normalized.includes("missing_wallet_passkey_metadata") ||
    normalized.includes("weighted_signer_not_installed") ||
    normalized.includes("existing_account_not_weighted_validator_initialized")
  ) {
    return false;
  }
  return shouldRetryAaBootstrapError(message);
};

export const shouldKeepPendingAaCredentialAfterError = (message: string): boolean => {
  const normalized = String(message || "").toLowerCase();
  if (!normalized) return false;
  return (
    shouldRetryAaBootstrapError(message) || normalized.includes("weighted_signer_not_installed")
  );
};

export const getAaBootstrapRetryDelayMs = (message: string): number => {
  const normalized = String(message || "").toLowerCase();
  if (
    normalized.includes("timed out while waiting for user operation") ||
    normalized.includes("request timed out")
  ) {
    return 5_000;
  }
  return AA_BOOTSTRAP_RETRY_DELAY_MS;
};
