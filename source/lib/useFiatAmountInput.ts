import { useMemo, useState } from "react";
import { truncateDecimalString } from "./amounts";

/**
 * Shared hook for fiat amount text input handling. Normalizes comma→dot, caps at 2 decimals.
 * Reports exceedsBalance — the consumer must disable the CTA + show inline error when true.
 */
export function useFiatAmountInput(opts?: {
  maxAmount?: number | null;
  minAmount?: number;
}) {
  const [amount, setAmount] = useState<string>("");

  const availableDisplay = useMemo(() => {
    if (opts?.maxAmount == null || !Number.isFinite(opts.maxAmount)) return null;
    const truncated = truncateDecimalString(String(opts.maxAmount), 2);
    return Math.max(0, Number(truncated));
  }, [opts?.maxAmount]);

  const parsedAmount = useMemo(() => {
    const n = Number(amount || "0");
    return Number.isFinite(n) ? n : 0;
  }, [amount]);

  const exceedsBalance = useMemo(() => {
    if (availableDisplay == null) return false;
    return parsedAmount > (availableDisplay || 0);
  }, [parsedAmount, availableDisplay]);

  const minEurAmount = opts?.minAmount ?? 0.01;
  const isBelowMinimum = parsedAmount < minEurAmount;

  const handleChangeText = (text: string) => {
    const cleaned = text.replace(/,/g, ".");
    if (!cleaned) {
      setAmount("");
      return;
    }
    // Integer part may be empty so a leading "." is accepted (".5" => "0.5").
    const match = cleaned.match(/^(\d*)(?:\.(\d*))?/);
    if (!match || (!match[1] && match[2] == null)) {
      setAmount("");
      return;
    }
    // Strip leading zeros but keep a single "0" ("002" => "2", "0" => "0").
    const intPart = (match[1] || "0").replace(/^0+(?=\d)/, "");
    let decPart = (match[2] || "").replace(/[^0-9]/g, "");
    decPart = decPart.slice(0, 2);
    const trailingDot = cleaned.endsWith(".") && !cleaned.includes("..") && decPart.length === 0;
    const normalized =
      decPart.length > 0 ? `${intPart}.${decPart}` : trailingDot ? `${intPart}.` : intPart;
    const numeric = Number(normalized.endsWith(".") ? normalized.slice(0, -1) : normalized);
    if (!Number.isFinite(numeric)) {
      setAmount("");
      return;
    }
    setAmount(normalized);
  };

  return {
    amount,
    setAmount,
    handleChangeText,
    parsedAmount,
    exceedsBalance,
    isBelowMinimum,
    availableDisplay,
  };
}
