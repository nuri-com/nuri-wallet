// The most a v2 EVM-source order may approve or spend: the deposit the user
// accepted, exactly as the server quoted it. The wallet adds no tolerance of
// its own — the server approves exactly the quoted input (lifi.mjs: "Approve
// exactly the integer input used by this quote, without arbitrary headroom";
// cow.mjs: approval = order.sellAmount).
//
// Kept dependency-free (viem only) so the resume path can import it without
// dragging a flow service's native/secure-storage imports into scope.
import { parseUnits } from "viem";

export function approvalCeiling(depositDecimal: number | string, decimals: number): bigint {
  const decimal =
    typeof depositDecimal === "string" ? depositDecimal.trim() : depositDecimal.toFixed(decimals);
  return parseUnits(decimal, decimals);
}
