import { ungroupedFiat } from "./homeCarousel";

export const HOME_RAIL_ORDER = ["onchain", "arkade", "wallet", "dollar", "visa", "iban"] as const;

export function orderHomeRails<T extends { key: string }>(rails: readonly T[]): T[] {
  return HOME_RAIL_ORDER.flatMap((key) => rails.filter((rail) => rail.key === key));
}

export function sumKnownEuro(values: readonly (number | null)[]): number | null {
  if (values.some((value) => value === null || !Number.isFinite(value))) return null;
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

export function overviewEuro(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "\u2014" : `€ ${ungroupedFiat(value)}`;
}

// Only one Wirex input: VISA and IBAN spend the same account balance.
export function homeOverviewGroups(balances: {
  bitcoinEur: number | null;
  walletEur: number | null;
  dollarEur: number | null;
  wirexEur: number | null;
}) {
  return [
    { key: "bitcoin", rail: "onchain", amountEur: balances.bitcoinEur },
    {
      key: "cash",
      rail: "wallet",
      amountEur: sumKnownEuro([balances.walletEur, balances.dollarEur]),
    },
    { key: "banking", rail: "visa", amountEur: balances.wirexEur },
  ] as const;
}
