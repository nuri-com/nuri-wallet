import { formatFiat, sumKnown } from "../../lib/currency/displayFiat";
import type { FiatCode } from "../../lib/tokens";

// The home shows three cards. Each is named by the rail key that already stood
// for it on the overview: Bitcoin (onchain + Lightning), Cash (euro + dollar)
// and Visa & Banking (card + bank account, one Wirex balance).
export const HOME_GROUP_KEYS = ["onchain", "wallet", "visa"] as const;
export type HomeGroupKey = (typeof HOME_GROUP_KEYS)[number];

/** The home card a rail belongs to; deep links and rows name rails. */
export function homeGroupOf(key: string | null | undefined): HomeGroupKey | null {
  switch (key) {
    case "onchain":
    case "arkade":
      return "onchain";
    case "wallet":
    case "dollar":
      return "wallet";
    case "visa":
    case "iban":
      return "visa";
    default:
      return null;
  }
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
