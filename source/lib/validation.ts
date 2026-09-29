// Centralized validation utilities — extracted from screen files
import { validateIBAN } from "eu-payment-qr";
import { isAddress as viemIsAddress } from "viem";
import { normalizeIbanInput } from "./ibanFormat";

/**
 * Validate an EVM address. Accepts all-lowercase and correct EIP-55 checksum.
 * Rejects mixed-case with wrong checksum (catches typos in pasted addresses).
 */
export function isValidEvmAddress(value: string): boolean {
  const trimmed = String(value || "").trim();
  if (!trimmed.startsWith("0x")) return false;
  return viemIsAddress(trimmed as `0x${string}`);
}

export const isEvmTxHash = (value?: string | null): boolean =>
  /^0x[a-f0-9]{64}$/i.test(String(value || "").trim());

export const isBtcTxid = (value?: string | null): boolean =>
  /^[0-9a-f]{64}$/i.test(String(value || "").trim());

export const isConnectivityError = (message: string | undefined | null): boolean => {
  const msg = (message || "").toLowerCase();
  if (!msg) return false;
  return (
    msg.includes("network request failed") ||
    msg.includes("failed to fetch") ||
    msg.includes("network error") ||
    msg.includes("internet connection") ||
    msg.includes("timeout") ||
    msg.includes("timed out")
  );
};

export function isNetworkErrorMessage(message?: string | null): boolean {
  if (!message) return false;
  return /network|transport|timeout|status|response|failed to fetch/i.test(message);
}

export const isValidEmail = (value: string): boolean => {
  const v = String(value || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
};

export function isValidIban(value: string): boolean {
  return validateIBAN(normalizeIbanInput(value)).valid;
}
