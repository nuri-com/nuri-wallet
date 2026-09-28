import { Button, ButtonIcon, ButtonText, View } from "@ds";
import { t } from "../lib/i18n";

/**
 * AmountKeypad — the DS numeric keypad from the set-amount / send-amount sheet
 * layouts: 3-per-row soft buttons for the digits, then decimal · 0 · delete.
 * The decimal key renders disabled when `onDecimal` is absent (integer-only
 * entry, e.g. sats).
 */

const DIGIT_ROWS = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
] as const;

type Props = {
  onDigit: (digit: string) => void;
  onDecimal?: () => void;
  onDelete: () => void;
};

export default function AmountKeypad({ onDigit, onDecimal, onDelete }: Props) {
  return (
    <View direction="column" gap="sm">
      {DIGIT_ROWS.map((row) => (
        <View key={row[0]} direction="row" distribute="even" gap="sm">
          {row.map((digit) => (
            <Button key={digit} accessibilityLabel={digit} onPress={() => onDigit(digit)}>
              <ButtonText>{digit}</ButtonText>
            </Button>
          ))}
        </View>
      ))}
      <View direction="row" distribute="even" gap="sm">
        <Button accessibilityLabel="." disabled={!onDecimal} onPress={() => onDecimal?.()}>
          <ButtonText>.</ButtonText>
        </Button>
        <Button accessibilityLabel="0" onPress={() => onDigit("0")}>
          <ButtonText>0</ButtonText>
        </Button>
        <Button accessibilityLabel={t("common.delete")} onPress={onDelete}>
          <ButtonIcon name="chevron-left" />
        </Button>
      </View>
    </View>
  );
}
