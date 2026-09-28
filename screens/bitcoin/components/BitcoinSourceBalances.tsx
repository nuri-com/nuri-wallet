// @component bitcoin.source-balances
// The per-wallet breakdown under the headline Bitcoin balance: one static row
// per rail (arkade, on-chain). Read-only on purpose — the headline balance owns
// the sats/fiat toggle, so these rows never rotate and are not tappable.
import type React from "react";
import { Text, View } from "@ds";
import { SATS_PER_BTC, satsToFiat } from "../../../lib/bitcoin/convert";
import { t } from "../../../lib/i18n";
import { groupCount } from "../../../lib/formatting";

type Props = {
  arkadeSats: number;
  onchainSats: number;
  fiatPerBtc: number | null;
  fiatSymbol: string;
  isHidden?: boolean;
  hiddenMask: string;
};

function formatSats(sats: number): string {
  return groupCount(sats);
}

function formatFiat(sats: number, fiatPerBtc: number | null, symbol: string): string | null {
  const fiat = satsToFiat(sats, fiatPerBtc);
  if (fiat === null) return null;
  return `${symbol} ${fiat.toFixed(2)}`;
}

const BitcoinSourceBalances: React.FC<Props> = ({
  arkadeSats,
  onchainSats,
  fiatPerBtc,
  fiatSymbol,
  isHidden = false,
  hiddenMask,
}) => {
  const rows = [
    { key: "arkade", label: t("screen.BitcoinScreen.sourceArkade"), sats: arkadeSats },
    { key: "onchain", label: t("screen.BitcoinScreen.sourceOnchain"), sats: onchainSats },
  ];

  return (
    <View direction="column" align="stretch" gap="xs" paddingX="lg">
      {rows.map(({ key, label, sats }) => {
        const fiat = formatFiat(sats, fiatPerBtc, fiatSymbol);
        return (
          <View key={key} direction="row" align="center" justify="between">
            <Text size="sm" muted>
              {label}
            </Text>
            <Text size="sm" mono>
              {isHidden ? hiddenMask : `${formatSats(sats)} sats`}
              {!isHidden && fiat ? ` (${fiat})` : ""}
            </Text>
          </View>
        );
      })}
    </View>
  );
};

export { SATS_PER_BTC };
export default BitcoinSourceBalances;
