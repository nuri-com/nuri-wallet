import { NuriIcon, Pressable, Text, View } from "@ds";
import { t } from "../lib/i18n";

/**
 * AmountKeypad — the DS numeric keypad from the set-amount / send-amount sheet
 * layouts: 3-per-row soft keys for the digits, then decimal · 0 · delete.
 * The decimal key renders disabled when `onDecimal` is absent (integer-only
 * entry, e.g. sats).
 *
 * `compact` is for a screen too short for the full keypad (a small phone in a
 * browser tab): the keys drop from the DS `xl` control height to `lg`, still a
 * comfortable tap target, and the gaps tighten, so the screen fits instead of
 * scrolling. The screen decides when (lib/useKeypadFit).
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
  compact?: boolean;
};

type KeyProps = {
  accessibilityLabel: string;
  onPress: () => void;
  disabled?: boolean;
  compact: boolean;
  children: React.ReactNode;
};

// The soft DS button's look (variant, radius, press feedback), with the key
// height as the one thing that varies.
function Key({ accessibilityLabel, onPress, disabled, compact, children }: KeyProps) {
  return (
    <Pressable
      variant="soft"
      radius="full"
      direction="row"
      align="center"
      justify="center"
      paddingX="xl"
      minHeight={compact ? "lg" : "xl"}
      pressColor
      pressScale
      disabledOpacity
      disabled={disabled}
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
    >
      {children}
    </Pressable>
  );
}

function Digit({ children }: { children: string }) {
  return (
    <Text size="md" emphasis>
      {children}
    </Text>
  );
}

export default function AmountKeypad({ onDigit, onDecimal, onDelete, compact = false }: Props) {
  const gap = compact ? "xs" : "sm";
  return (
    <View direction="column" align="stretch" gap={gap}>
      {DIGIT_ROWS.map((row) => (
        <View key={row[0]} direction="row" distribute="even" gap={gap}>
          {row.map((digit) => (
            <Key
              key={digit}
              compact={compact}
              accessibilityLabel={digit}
              onPress={() => onDigit(digit)}
            >
              <Digit>{digit}</Digit>
            </Key>
          ))}
        </View>
      ))}
      <View direction="row" distribute="even" gap={gap}>
        <Key
          compact={compact}
          accessibilityLabel="."
          disabled={!onDecimal}
          onPress={() => onDecimal?.()}
        >
          <Digit>.</Digit>
        </Key>
        <Key compact={compact} accessibilityLabel="0" onPress={() => onDigit("0")}>
          <Digit>0</Digit>
        </Key>
        <Key compact={compact} accessibilityLabel={t("common.delete")} onPress={onDelete}>
          <NuriIcon name="chevron-left" />
        </Key>
      </View>
    </View>
  );
}
