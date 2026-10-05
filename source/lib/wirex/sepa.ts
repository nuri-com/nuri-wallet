// lib/wirex/sepa.ts
// Pure helper: choose which unified-balance token an outbound SEPA transfer
// debits. Wirex settles a SEPA payout from a SINGLE token (never a combination).
// SEPA is EUR rails, so prefer a EUR-pegged token to avoid an FX spread; fall
// back to the highest-balance token (Wirex converts to EUR with FX).
import type { WirexTokenBalance } from "../../services/wirex/WirexService";

export type SepaDebitToken = { tokenAddress: string; tokenSymbol: string; balance: number };

const EUR_TOKENS = new Set(["WEUR", "EURC", "EURE"]);

export function pickSepaDebitToken(balances: WirexTokenBalance[]): SepaDebitToken | null {
  const usable: SepaDebitToken[] = [];
  for (const b of balances) {
    const amt = Number(b.balance);
    if (!b.tokenAddress || !b.tokenSymbol || !Number.isFinite(amt) || amt <= 0) continue;
    usable.push({ tokenAddress: b.tokenAddress, tokenSymbol: b.tokenSymbol, balance: amt });
  }
  if (!usable.length) return null;
  const eur = usable
    .filter((t) => EUR_TOKENS.has(t.tokenSymbol.toUpperCase()))
    .sort((a, b) => b.balance - a.balance);
  if (eur.length) return eur[0];
  return usable.sort((a, b) => b.balance - a.balance)[0];
}

// What a SEPA estimate will take from the debit token, fee included. Wirex's
// `estimated_amounts[].amount` is the full token debit: a 0.10 EUR quote came
// back as 0.1005 WEUR with a 0.0005 fee. The amount the user typed is NOT the
// debit, so a send of the whole balance fails `insufficient_funds` (#1536).
// Null when the estimate names no usable figure for this token.
export function sepaEstimateDebit(raw: unknown, tokenAddress: string): number | null {
  const list = (raw as { estimated_amounts?: unknown } | null)?.estimated_amounts;
  if (!Array.isArray(list)) return null;
  const want = tokenAddress.toLowerCase();
  const entry = list.find(
    (item) => typeof item?.token_address === "string" && item.token_address.toLowerCase() === want,
  ) as { amount?: unknown } | undefined;
  const debit = Number(entry?.amount);
  return Number.isFinite(debit) && debit > 0 ? debit : null;
}
