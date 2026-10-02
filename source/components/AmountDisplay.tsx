import { IconAvatar, IconButton, Text, View } from "@ds";
import type { ImageSourcePropType } from "react-native";
import { satsToFiat } from "../lib/bitcoin/convert";
import type { DisplayCurrency } from "../lib/currency/homeCurrencyStore";
import { groupCount } from "../lib/formatting";
import { t } from "../lib/i18n";

/**
 * AmountDisplay — the amount block of every amount-entry screen (Bitcoin send,
 * invoice, buy, stablecoin send, SEPA): the typed figure right-aligned with its
 * currency image, optionally the other unit's figure under it and the unit
 * toggle on the left. The images are the currency images the home cards use, so
 * no text code sits beside a number. One component, so the screens cannot drift.
 */

export const BTC_LOGO: ImageSourcePropType = require("../assets/rails/btc.png");
export const EUR_FLAG: ImageSourcePropType = require("../assets/flags/eur.png");
export const USD_FLAG: ImageSourcePropType = require("../assets/flags/usa.png");

/** How a screen reader names a sats figure. */
export const SATS_UNIT = "sats";

export function fiatImageFor(code: DisplayCurrency): ImageSourcePropType {
  return code === "USD" ? USD_FLAG : EUR_FLAG;
}

/**
 * The secondary figure for a sats/fiat entry: derived sats in fiat mode, the fiat
 * value in sats mode, and a dash while the price is unknown (a zero would read as
 * a free amount).
 */
export function bitcoinSecondaryAmount(
  isSatsMode: boolean,
  currentSats: number,
  fiatPerBtc: number | null | undefined,
): string {
  if (!isSatsMode) return groupCount(currentSats);
  if (!fiatPerBtc) return "\u2014";
  const fiat = satsToFiat(currentSats, fiatPerBtc);
  return fiat === null ? "\u2014" : fiat.toFixed(2);
}

type Props = {
  primaryAmount: string;
  primaryImage: ImageSourcePropType;
  /**
   * The figure's unit as a screen reader should say it ("sats", "EUR"). The
   * image alone names it visually; without this VoiceOver reads a bare number.
   */
  primaryUnit: string;
  /** The other unit's figure; omitted where the amount has only one unit. */
  secondary?: { amount: string; image: ImageSourcePropType; unit: string };
  /** Flips the units; omitted where there is nothing to flip to. */
  onToggle?: () => void;
  toggleDisabled?: boolean;
  /**
   * The line under the figures (an error, a limit, a hint). One line is reserved
   * even when empty, so a message coming and going never moves the keypad or
   * the button below it. A longer message wraps in full (an actionable error
   * must never be cut off); the block is centred in the free height above the
   * keypad, so the extra lines take that room instead of pushing the keypad.
   * `undefined` reserves nothing (a screen with no messages).
   */
  message?: AmountMessage | null;
  /**
   * Take the height the screen leaves (the entry screens, where the figure sits
   * centred between the recipient and the keypad). Off where the block is a
   * read-only summary under other content.
   */
  fill?: boolean;
};

export type AmountMessage = { text: string; tone: "alert" | "info" };

export default function AmountDisplay({
  primaryAmount,
  primaryImage,
  primaryUnit,
  secondary,
  onToggle,
  toggleDisabled,
  message,
  fill = true,
}: Props) {
  return (
    <View
      direction="column"
      align="stretch"
      justify="center"
      gap="sm"
      {...(fill ? { fill: "grow" as const } : {})}
    >
      <View direction="row" align="center" justify={onToggle ? "between" : "end"}>
        {onToggle ? (
          <IconButton
            icon="transfer-vertical"
            variant="soft"
            accessibilityLabel={t("common.swapCurrency")}
            disabled={toggleDisabled}
            onPress={onToggle}
          />
        ) : null}
        <View direction="row" align="center" justify="end" gap="sm">
          <IconAvatar size="sm" source={primaryImage} />
          <Text size="3xl" align="end" accessibilityLabel={`${primaryAmount} ${primaryUnit}`}>
            {primaryAmount}
          </Text>
        </View>
      </View>
      {secondary ? (
        <View direction="row" align="center" justify="end" gap="xs">
          <IconAvatar size="sm" source={secondary.image} />
          <Text size="md" align="end" accessibilityLabel={`${secondary.amount} ${secondary.unit}`}>
            {secondary.amount}
          </Text>
        </View>
      ) : null}
      {message !== undefined ? (
        <Text
          size="md"
          align="center"
          flow="wrap"
          {...(message?.tone === "alert" ? { emphasis: true } : { muted: true })}
        >
          {message?.text ?? "\u00a0"}
        </Text>
      ) : null}
    </View>
  );
}
