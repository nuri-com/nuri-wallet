import type { PayTarget } from "./payTarget";

/** Additive OS handoff, never an alternate payment target or an EVM swap path. */
export function payWalletUri(target: PayTarget): string | null {
  if (target.kind === "invoice" && target.asset === "BTC_LN") {
    return `lightning:${target.value}`;
  }
  if (target.kind === "address" && target.asset === "BTC") {
    return target.uri.startsWith("bitcoin:") ? target.uri : `bitcoin:${target.value}`;
  }
  return null;
}
