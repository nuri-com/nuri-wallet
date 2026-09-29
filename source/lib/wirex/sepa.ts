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
