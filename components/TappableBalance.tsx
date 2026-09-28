import type React from "react";
import type { ReactNode } from "react";
import { Pressable, Text } from "@ds";
import BalanceDigits from "./BalanceDigits";
import type { BalanceToken } from "../types/shared";

type Props = {
  /** Whether the balance is hidden (shows mask) */
  isHidden: boolean;
  /** Tokenized balance for visible state */
  tokens: BalanceToken[];
  /** Whether the balance is negative */
  isNegative: boolean;
  /** Currency code shown before the amount (e.g. "EUR", "BTC") */
  currencySymbol: string;
  /** Text to show when hidden. Defaults to "****" */
  hiddenMask?: string;
  /** Content to show when balance hasn't resolved yet (e.g. "€—") */
  unresolvedContent?: ReactNode;
  /** Called on tap */
  onPress?: () => void;
  /** Called on long press */
  onLongPress?: () => void;
};

const TappableBalance: React.FC<Props> = ({
  isHidden,
  tokens,
  isNegative,
  currencySymbol,
  hiddenMask = "****",
  unresolvedContent,
  onPress,
  onLongPress,
}) => (
  <Pressable
    direction="row"
    align="center"
    justify="center"
    onPress={onPress}
    onLongPress={onLongPress}
    accessibilityLabel={currencySymbol}
  >
    {isHidden ? (
      <Text size="3xl">{hiddenMask}</Text>
    ) : unresolvedContent ? (
      unresolvedContent
    ) : (
      <BalanceDigits tokens={tokens} isNegative={isNegative} currencySymbol={currencySymbol} />
    )}
  </Pressable>
);

export default TappableBalance;
