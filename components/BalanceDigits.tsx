import type React from "react";
import { Text, View } from "@ds";
import type { BalanceToken } from "../types/shared";

// The main balance readout: DS display size (3xl), leading zeros muted so the
// eye lands on the significant digits, thin spacers between digit groups.
type Props = {
  tokens: BalanceToken[];
  isNegative: boolean;
  currencySymbol: string;
};

const BalanceDigits: React.FC<Props> = ({ tokens, isNegative, currencySymbol }) => (
  <View direction="row" align="end" gap="xs">
    <Text size="3xl">{currencySymbol}</Text>
    <View direction="row" align="end">
      {isNegative ? <Text size="3xl">-</Text> : null}
      {tokens.map((token) => {
        if (token.type === "spacer") {
          return <View key={token.key} paddingX="xs" />;
        }
        if (token.type === "dot") {
          return (
            <Text key={token.key} size="3xl">
              {token.char}
            </Text>
          );
        }
        return (
          <Text key={token.key} size="3xl" muted={token.leading || undefined}>
            {token.char}
          </Text>
        );
      })}
    </View>
  </View>
);

export default BalanceDigits;
