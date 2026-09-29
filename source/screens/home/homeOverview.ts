import { formatFiat, sumKnown } from "../../lib/currency/displayFiat";
import type { FiatCode } from "../../lib/tokens";

export const HOME_RAIL_ORDER = ["onchain", "arkade", "wallet", "dollar", "visa", "iban"] as const;

export function orderHomeRails<T extends { key: string }>(rails: readonly T[]): T[] {
  return HOME_RAIL_ORDER.flatMap((key) => rails.filter((rail) => rail.key === key));
}

/** An overview group's figure, in the display currency. Unknown → "—". */
export function overviewFigure(value: number | null, home: FiatCode): string {
  return formatFiat(value, home, { style: "glyph", grouped: false });
}

// Every input is already in the display currency. Only one Wirex input: VISA
// and IBAN spend the same account balance.
export function homeOverviewGroups(balances: {
  bitcoinHome: number | null;
  walletHome: number | null;
  dollarHome: number | null;
  wirexHome: number | null;
}) {
  return [
    { key: "bitcoin", rail: "onchain", amountHome: balances.bitcoinHome },
    {
      key: "cash",
      rail: "wallet",
      amountHome: sumKnown([balances.walletHome, balances.dollarHome]),
    },
    { key: "banking", rail: "visa", amountHome: balances.wirexHome },
  ] as const;
}
